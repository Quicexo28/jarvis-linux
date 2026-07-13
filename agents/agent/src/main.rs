//! Jarvis remote agent — a small headless binary that connects OUTBOUND to the
//! hub over Tailscale, so the agent never exposes a port. It runs as a system
//! service (Windows Service via the `winservice` feature; systemd on Linux is
//! the same binary launched by a unit). Reconnects forever with capped backoff
//! and never blocks the socket: each op runs on a blocking task and its result
//! is multiplexed back over the one connection by correlation id.

mod config;
mod ops;
mod watch;
#[cfg(all(windows, feature = "winservice"))]
mod winservice;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use protocol::{Hello, Message, OsKind, Response, PROTOCOL_VERSION};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use config::Config;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    // Windows service mode (SCM launches the binary with `--service`). The
    // service host builds its own runtime and drives run_agent_loop with a stop
    // signal from the SCM control handler. Foreground/dev and Linux use the
    // plain path below.
    #[cfg(all(windows, feature = "winservice"))]
    if std::env::args().any(|a| a == "--service") {
        return winservice::run();
    }

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(run_agent_loop(Config::load()?, std::future::pending::<()>()))
}

/// The reconnect-forever loop, shared by foreground and service entry points.
/// `shutdown` resolves to request a clean exit (Ctrl-C in foreground is handled
/// by the OS; the Windows service resolves it from its stop handler).
pub async fn run_agent_loop(cfg: Config, shutdown: impl std::future::Future<Output = ()>) -> Result<()> {
    info!(
        "jarvis-agent '{}' v{AGENT_VERSION} → {}",
        cfg.agent_name, cfg.hub_url
    );
    tokio::pin!(shutdown);

    // Fires the Booted event exactly once, on whichever session first connects.
    let boot_pending = Arc::new(AtomicBool::new(true));

    // Capped exponential backoff. The laptop (hub) suspends often; a failed
    // connect must not spin the CPU.
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                info!("shutdown requested; exiting agent loop");
                return Ok(());
            }
            outcome = run_session(&cfg, &boot_pending) => match outcome {
                Ok(_) => {
                    info!("session ended cleanly; reconnecting");
                    backoff = Duration::from_secs(1);
                }
                Err(e) => {
                    warn!("session error: {e}; retrying in {:?}", backoff);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(max_backoff);
                }
            }
        }
    }
}

fn os_kind() -> OsKind {
    if cfg!(windows) {
        OsKind::Windows
    } else if cfg!(target_os = "macos") {
        OsKind::MacOs
    } else {
        OsKind::Linux
    }
}

fn mac_addresses() -> Vec<String> {
    mac_address::MacAddressIterator::new()
        .map(|it| {
            it.filter(|m| m.bytes() != [0u8; 6])
                .map(|m| m.to_string())
                .collect()
        })
        .unwrap_or_default()
}

async fn run_session(cfg: &Config, boot_pending: &Arc<AtomicBool>) -> Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(&cfg.hub_url).await?;
    let (mut sink, mut src) = ws.split();

    // Handshake.
    let hello = Message::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        agent_name: cfg.agent_name.clone(),
        token: cfg.token.clone(),
        os: os_kind(),
        mac_addresses: mac_addresses(),
        agent_version: AGENT_VERSION.to_string(),
        capabilities: ops::enabled_capabilities(cfg),
    });
    sink.send(WsMessage::Text(hello.to_json()?)).await?;

    match src.next().await {
        Some(Ok(WsMessage::Text(t))) => match Message::from_json(&t)? {
            Message::Welcome(w) if w.accepted => {
                info!("handshake accepted by hub (protocol v{})", w.protocol_version);
                if let Some(exp) = w.expected_agent_version {
                    if exp != AGENT_VERSION {
                        // v1.5 pulls + verifies + swaps the binary here.
                        warn!("hub expects agent v{exp}, running v{AGENT_VERSION} (auto-update is v1.5)");
                    }
                }
            }
            Message::Welcome(w) => {
                anyhow::bail!("handshake rejected: {}", w.reject_reason.unwrap_or_default());
            }
            _ => anyhow::bail!("expected welcome"),
        },
        _ => anyhow::bail!("no welcome frame"),
    }

    // Channel to serialize all outbound frames (op results, pongs) onto the one
    // socket without the op handlers touching the sink directly.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(WsMessage::Text(msg.to_json().unwrap_or_default())).await.is_err() {
                break;
            }
        }
    });

    // Proactive watchers push Events on the same channel; abort with the session.
    let watcher = watch::spawn(cfg, out_tx.clone(), boot_pending.clone());

    // Reader: dispatch requests concurrently so a long op never blocks the pipe.
    let cfg = cfg.clone();
    let result = async {
        while let Some(frame) = src.next().await {
            let text = match frame {
                Ok(WsMessage::Text(t)) => t,
                Ok(WsMessage::Close(_)) | Err(_) => break,
                _ => continue,
            };
            let msg = match Message::from_json(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            match msg {
                Message::Request(req) => {
                    let cfg = cfg.clone();
                    let out_tx = out_tx.clone();
                    // Ops may block (fs/exec); run off the async reader.
                    tokio::task::spawn_blocking(move || {
                        let result = ops::dispatch(&cfg, req.op);
                        let _ = out_tx.send(Message::Response(Response { id: req.id, result }));
                    });
                }
                Message::Ping => {
                    let _ = out_tx.send(Message::Pong);
                }
                Message::Pong => {}
                _ => {}
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    watcher.abort();
    writer.abort();
    result
}
