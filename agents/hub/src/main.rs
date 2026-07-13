//! Jarvis agent hub — the "cerebro"-side sidecar.
//!
//! Two listeners:
//!   * WS server (`HUB_WS_ADDR`, default 0.0.0.0:8794) — agents connect INBOUND
//!     over Tailscale, so no agent ever exposes a port. Per-agent tokens gate
//!     the handshake; the protocol version is checked so stale agents are known.
//!   * Control API (`HUB_CONTROL_ADDR`, default 127.0.0.1:8795) — the Node
//!     backend calls this to list machines and run typed ops. Localhost only.
//!
//! Proactive agent events and connect/disconnect transitions are POSTed to the
//! Node backend (`HUB_NOTIFY_URL`), which forwards them to the user via the
//! existing Telegram `notifyJarvis` path.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{extract::State, routing::get, routing::post, Json, Router};
use futures_util::{SinkExt, StreamExt};
use protocol::{Message, Op, Request, Response, Welcome, PROTOCOL_VERSION};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

/// One connected agent: outbound channel + metadata + in-flight requests.
struct AgentConn {
    meta: AgentMeta,
    tx: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>,
}

#[derive(Clone, serde::Serialize)]
struct AgentMeta {
    name: String,
    os: String,
    agent_version: String,
    mac_addresses: Vec<String>,
    capabilities: Vec<String>,
    connected_at: u64,
}

#[derive(Clone)]
struct Hub {
    agents: Arc<Mutex<HashMap<String, AgentConn>>>,
    tokens: Arc<HashMap<String, String>>, // agent_name -> token
    notify_url: String,
    rpc_timeout_ms: u64,
    http: reqwest::Client,
    /// Persisted `{agent_name: [mac,…]}` so an OFFLINE machine can still be
    /// woken (its live connection is gone precisely when we need to wake it).
    macs_file: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load per-agent tokens from JARVIS_AGENT_TOKENS_FILE (JSON: {name: token}).
/// Missing file => no agent can authenticate (fail closed).
fn load_tokens() -> HashMap<String, String> {
    let path = std::env::var("JARVIS_AGENT_TOKENS_FILE")
        .unwrap_or_else(|_| "agent-tokens.json".into());
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            warn!("agent tokens file parse error ({e}); no agents can auth");
            HashMap::new()
        }),
        Err(_) => {
            warn!("agent tokens file '{path}' not found; no agents can auth");
            HashMap::new()
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let hub = Hub {
        agents: Arc::new(Mutex::new(HashMap::new())),
        tokens: Arc::new(load_tokens()),
        notify_url: std::env::var("HUB_NOTIFY_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8788/api/agents/event".into()),
        rpc_timeout_ms: std::env::var("HUB_RPC_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30_000),
        http: reqwest::Client::new(),
        macs_file: std::env::var("JARVIS_AGENT_MACS_FILE")
            .unwrap_or_else(|_| "agent-macs.json".into()),
    };

    let ws_addr = std::env::var("HUB_WS_ADDR").unwrap_or_else(|_| "0.0.0.0:8794".into());
    let control_addr =
        std::env::var("HUB_CONTROL_ADDR").unwrap_or_else(|_| "127.0.0.1:8795".into());

    // Control API for the Node backend.
    let app = Router::new()
        .route("/machines", get(list_machines))
        .route("/rpc", post(rpc))
        .route("/wake", post(wake))
        .with_state(hub.clone());
    let control_listener = TcpListener::bind(&control_addr).await?;
    info!("control API on http://{control_addr}");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(control_listener, app).await {
            warn!("control API stopped: {e}");
        }
    });

    // WS server for agents — accept forever, one task per connection.
    let ws_listener = TcpListener::bind(&ws_addr).await?;
    info!("agent WS on ws://{ws_addr} (protocol v{PROTOCOL_VERSION})");
    loop {
        let (stream, peer) = match ws_listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                warn!("accept: {e}");
                continue;
            }
        };
        let hub = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_agent(hub, stream, peer.to_string()).await {
                warn!("agent {peer} ended: {e}");
            }
        });
    }
}

async fn handle_agent(hub: Hub, stream: TcpStream, peer: String) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut src) = ws.split();

    // First frame must be Hello.
    let hello = match src.next().await {
        Some(Ok(WsMessage::Text(t))) => match Message::from_json(&t) {
            Ok(Message::Hello(h)) => h,
            _ => {
                let _ = sink.send(reject("expected hello")).await;
                return Ok(());
            }
        },
        _ => return Ok(()),
    };

    // Version + token gate.
    if hello.protocol_version != PROTOCOL_VERSION {
        let _ = sink
            .send(reject(&format!(
                "protocol mismatch: agent v{}, hub v{PROTOCOL_VERSION}",
                hello.protocol_version
            )))
            .await;
        return Ok(());
    }
    match hub.tokens.get(&hello.agent_name) {
        Some(expected) if expected == &hello.token => {}
        _ => {
            let _ = sink.send(reject("bad token")).await;
            warn!("agent '{}' from {peer} rejected: bad token", hello.agent_name);
            return Ok(());
        }
    }

    // Accept.
    let welcome = Message::Welcome(Welcome {
        protocol_version: PROTOCOL_VERSION,
        accepted: true,
        reject_reason: None,
        expected_agent_version: None, // v1.5 auto-update fills this
    });
    sink.send(WsMessage::Text(welcome.to_json()?)).await?;

    let name = hello.agent_name.clone();
    let meta = AgentMeta {
        name: name.clone(),
        os: format!("{:?}", hello.os),
        agent_version: hello.agent_version.clone(),
        mac_addresses: hello.mac_addresses.clone(),
        capabilities: hello.capabilities.iter().map(|c| format!("{c:?}")).collect(),
        connected_at: now_secs(),
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    {
        let mut agents = hub.agents.lock().await;
        agents.insert(
            name.clone(),
            AgentConn { meta, tx: tx.clone(), pending: pending.clone() },
        );
    }
    // Cache MACs to disk so this machine is wakeable while offline.
    hub.remember_macs(&name, &hello.mac_addresses);
    info!("agent '{name}' online (v{})", hello.agent_version);
    hub.notify(json!({
        "type": "connected", "machine": name,
        "message": format!("{name} está en línea")
    }))
    .await;

    // Writer: drain outbound channel to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(WsMessage::Text(msg.to_json().unwrap_or_default())).await.is_err() {
                break;
            }
        }
    });

    // Heartbeat: ping so a suspended-laptop half-open socket is detected.
    let hb_tx = tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(20));
        loop {
            tick.tick().await;
            if hb_tx.send(Message::Ping).is_err() {
                break;
            }
        }
    });

    // Reader loop.
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
            Message::Response(resp) => {
                if let Some(slot) = pending.lock().await.remove(&resp.id) {
                    let _ = slot.send(resp);
                }
            }
            Message::Stream(chunk) => {
                // Phase 3 wires live streaming to the GUI; log until then.
                info!("stream[{}] {:?}: {}B", chunk.id, chunk.stream, chunk.data.len());
            }
            Message::Event(ev) => {
                hub.notify(json!({
                    "type": "watcher", "machine": ev.agent_name,
                    "kind": ev.kind, "message": ev.message
                }))
                .await;
            }
            Message::Ping => {
                let _ = tx.send(Message::Pong);
            }
            Message::Pong => {}
            _ => {}
        }
    }

    // Teardown.
    heartbeat.abort();
    writer.abort();
    hub.agents.lock().await.remove(&name);
    info!("agent '{name}' offline");
    hub.notify(json!({
        "type": "disconnected", "machine": name,
        "message": format!("{name} se desconectó")
    }))
    .await;
    Ok(())
}

fn reject(reason: &str) -> WsMessage {
    let m = Message::Welcome(Welcome {
        protocol_version: PROTOCOL_VERSION,
        accepted: false,
        reject_reason: Some(reason.to_string()),
        expected_agent_version: None,
    });
    WsMessage::Text(m.to_json().unwrap_or_default())
}

impl Hub {
    /// Fire-and-forget POST of an event to the Node backend. Never blocks the
    /// agent loop; a down backend just drops the notification.
    async fn notify(&self, body: serde_json::Value) {
        let url = self.notify_url.clone();
        let http = self.http.clone();
        tokio::spawn(async move {
            let _ = http.post(&url).json(&body).send().await;
        });
    }

    /// Merge this agent's MACs into the on-disk cache (used for WoL of an
    /// offline machine). Best-effort; a write failure just means no WoL later.
    fn remember_macs(&self, name: &str, macs: &[String]) {
        let mut all: HashMap<String, Vec<String>> = std::fs::read_to_string(&self.macs_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        all.insert(name.to_string(), macs.to_vec());
        if let Ok(s) = serde_json::to_string_pretty(&all) {
            let _ = std::fs::write(&self.macs_file, s);
        }
    }

    /// MACs for a machine: prefer the live connection, fall back to the cache.
    async fn macs_for(&self, name: &str) -> Vec<String> {
        if let Some(agent) = self.agents.lock().await.get(name) {
            if !agent.meta.mac_addresses.is_empty() {
                return agent.meta.mac_addresses.clone();
            }
        }
        std::fs::read_to_string(&self.macs_file)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, Vec<String>>>(&s).ok())
            .and_then(|m| m.get(name).cloned())
            .unwrap_or_default()
    }
}

/// Parse "AA:BB:CC:DD:EE:FF" (or dash-separated) into 6 bytes.
fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = s.split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut mac = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        mac[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(mac)
}

/// A Wake-on-LAN magic packet: 6×0xFF then the MAC repeated 16×.
fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut pkt = [0u8; 102];
    for b in pkt.iter_mut().take(6) {
        *b = 0xFF;
    }
    for i in 0..16 {
        pkt[6 + i * 6..6 + i * 6 + 6].copy_from_slice(&mac);
    }
    pkt
}

/// Broadcast the magic packet on the usual WoL ports. Note: L2 broadcast does
/// NOT route over Tailscale — this only wakes a machine on the hub's own LAN.
fn send_wol(mac: [u8; 6]) -> std::io::Result<()> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0")?;
    sock.set_broadcast(true)?;
    let pkt = magic_packet(mac);
    for port in [9u16, 7] {
        let _ = sock.send_to(&pkt, ("255.255.255.255", port));
    }
    Ok(())
}

// ---- Control API handlers ----

async fn list_machines(State(hub): State<Hub>) -> Json<serde_json::Value> {
    let agents = hub.agents.lock().await;
    let list: Vec<&AgentMeta> = agents.values().map(|a| &a.meta).collect();
    Json(json!({ "machines": list }))
}

#[derive(serde::Deserialize)]
struct RpcBody {
    machine: String,
    op: Op,
}

async fn rpc(State(hub): State<Hub>, Json(body): Json<RpcBody>) -> Json<serde_json::Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let (slot_tx, slot_rx) = oneshot::channel::<Response>();

    // Register the pending correlation and send the request.
    {
        let agents = hub.agents.lock().await;
        let Some(agent) = agents.get(&body.machine) else {
            return Json(json!({ "ok": false, "error": "machine_offline" }));
        };
        agent.pending.lock().await.insert(id.clone(), slot_tx);
        let req = Message::Request(Request { id: id.clone(), op: body.op });
        if agent.tx.send(req).is_err() {
            agent.pending.lock().await.remove(&id);
            return Json(json!({ "ok": false, "error": "send_failed" }));
        }
    }

    match tokio::time::timeout(Duration::from_millis(hub.rpc_timeout_ms), slot_rx).await {
        Ok(Ok(resp)) => Json(json!({ "ok": true, "result": resp.result })),
        _ => {
            // Clean up the dangling pending entry on timeout.
            if let Some(agent) = hub.agents.lock().await.get(&body.machine) {
                agent.pending.lock().await.remove(&id);
            }
            Json(json!({ "ok": false, "error": "timeout" }))
        }
    }
}

#[derive(serde::Deserialize)]
struct WakeBody {
    machine: String,
}

/// Send a Wake-on-LAN magic packet to a machine's cached MACs. Only effective
/// on the hub's own LAN (magic packets don't route over Tailscale).
async fn wake(State(hub): State<Hub>, Json(body): Json<WakeBody>) -> Json<serde_json::Value> {
    let macs = hub.macs_for(&body.machine).await;
    if macs.is_empty() {
        return Json(json!({ "ok": false, "error": "no_macs_known" }));
    }
    let mut sent = 0;
    for m in &macs {
        if let Some(mac) = parse_mac(m) {
            if send_wol(mac).is_ok() {
                sent += 1;
            }
        }
    }
    Json(json!({ "ok": sent > 0, "sent": sent, "macs": macs }))
}
