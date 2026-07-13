//! Proactive watchers (Phase 5). One background task per session samples the
//! machine and pushes `Event` frames the hub forwards to the user (Telegram):
//!   * Booted — once, on the first session after the process starts.
//!   * DiskHigh — a filesystem crossed the configured fullness threshold.
//!   * ProcessExited — a watched process that was running has disappeared.
//!
//! Events go out on the same `out` channel as op responses, so they multiplex
//! over the one WebSocket. The task is aborted when the session drops; a fresh
//! one is spawned on reconnect (seeded so it never false-fires on the first
//! tick). ShuttingDown is intentionally deferred — Windows preshutdown timing
//! is unreliable and Booted+recovery covers the "is it up?" question.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use protocol::{Event, EventKind, Message};
use sysinfo::{Disks, ProcessesToUpdate, System};
use tokio::sync::mpsc::UnboundedSender;

use crate::config::Config;

/// Spawn the watcher task for one session. `boot_pending` is shared across
/// reconnects so the Booted event fires exactly once per process lifetime,
/// regardless of which session first reaches a hub.
pub fn spawn(
    cfg: &Config,
    out: UnboundedSender<Message>,
    boot_pending: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let agent = cfg.agent_name.clone();
    let w = cfg.watchers.clone();
    tokio::spawn(async move {
        if !w.enabled {
            return;
        }
        // Claim the boot notice atomically; only the winner emits it.
        if boot_pending.swap(false, Ordering::SeqCst) {
            let _ = out.send(event(
                &agent,
                EventKind::Booted,
                format!("🟢 {agent} arrancó y está en línea"),
            ));
        }

        let watched: Vec<String> = w.processes.iter().map(|p| p.to_lowercase()).collect();
        let mut disk_alerted: HashSet<String> = HashSet::new();
        // Seed the running set so the first comparison never reports a spurious
        // exit for a process that was already down.
        let mut running: HashSet<String> = scan_processes(&watched).await;

        let mut ticker = tokio::time::interval(Duration::from_secs(w.poll_secs.max(10)));
        ticker.tick().await; // the first tick completes immediately; skip it.
        loop {
            ticker.tick().await;

            for (mount, pct) in scan_disks().await {
                if pct >= w.disk_percent as f32 {
                    // Edge-triggered: alert once per crossing, re-arm on recovery.
                    if disk_alerted.insert(mount.clone()) {
                        let _ = out.send(event(
                            &agent,
                            EventKind::DiskHigh { mount: mount.clone(), used_percent: pct },
                            format!(
                                "⚠️ {agent}: disco {mount} al {pct:.0}% (umbral {}%)",
                                w.disk_percent
                            ),
                        ));
                    }
                } else {
                    disk_alerted.remove(&mount);
                }
            }

            if !watched.is_empty() {
                let now = scan_processes(&watched).await;
                for name in running.difference(&now) {
                    let _ = out.send(event(
                        &agent,
                        EventKind::ProcessExited { name: name.clone(), exit_code: None },
                        format!("⚠️ {agent}: el proceso '{name}' dejó de ejecutarse"),
                    ));
                }
                running = now;
            }
        }
    })
}

fn event(agent: &str, kind: EventKind, message: String) -> Message {
    Message::Event(Event { agent_name: agent.to_string(), kind, message })
}

/// (mount, percent_used) for every mounted filesystem. sysinfo is sync, so run
/// it off the async runtime.
async fn scan_disks() -> Vec<(String, f32)> {
    tokio::task::spawn_blocking(|| {
        Disks::new_with_refreshed_list()
            .iter()
            .filter_map(|d| {
                let total = d.total_space();
                if total == 0 {
                    return None;
                }
                let used = total.saturating_sub(d.available_space());
                let pct = used as f32 / total as f32 * 100.0;
                Some((d.mount_point().to_string_lossy().into_owned(), pct))
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// The subset of `watched` names currently running (lowercased).
async fn scan_processes(watched: &[String]) -> HashSet<String> {
    if watched.is_empty() {
        return HashSet::new();
    }
    let watched = watched.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let mut present = HashSet::new();
        for p in sys.processes().values() {
            let name = p.name().to_string_lossy().to_lowercase();
            if watched.iter().any(|w| *w == name) {
                present.insert(name);
            }
        }
        present
    })
    .await
    .unwrap_or_default()
}
