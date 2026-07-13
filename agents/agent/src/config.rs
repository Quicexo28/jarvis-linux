//! Agent configuration, loaded from a local TOML file. The allowlist is the
//! agent's own veto: even if the hub asks, an op runs only when enabled here.
//! Exec defaults OFF — the machine owner must opt in explicitly.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Hub WebSocket URL, reached over Tailscale, e.g. "ws://laptop:8791".
    pub hub_url: String,
    /// Logical name the brain addresses this machine by, e.g. "main".
    pub agent_name: String,
    /// Per-agent secret matching the hub's tokens file.
    pub token: String,
    #[serde(default)]
    pub allowlist: Allowlist,
    /// Where the local audit log is written (every op recorded).
    #[serde(default = "default_audit_path")]
    pub audit_log: String,
    /// Proactive watchers (disk / process / boot). Off-machine reporting.
    #[serde(default)]
    pub watchers: Watchers,
}

/// Background monitors that push `Event`s to the hub without being asked.
#[derive(Debug, Clone, Deserialize)]
pub struct Watchers {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Alert when any filesystem is at or above this percent full.
    #[serde(default = "default_disk_percent")]
    pub disk_percent: u8,
    /// Sampling interval for disk and process checks.
    #[serde(default = "default_poll_secs")]
    pub poll_secs: u64,
    /// Process names (case-insensitive) to alert on when they disappear.
    #[serde(default)]
    pub processes: Vec<String>,
}

impl Default for Watchers {
    fn default() -> Self {
        Watchers {
            enabled: true,
            disk_percent: default_disk_percent(),
            poll_secs: default_poll_secs(),
            processes: Vec::new(),
        }
    }
}

fn default_disk_percent() -> u8 {
    90
}
fn default_poll_secs() -> u64 {
    300
}

#[derive(Debug, Clone, Deserialize)]
pub struct Allowlist {
    #[serde(default = "yes")]
    pub search: bool,
    #[serde(default)] // false — opt-in
    pub exec: bool,
    #[serde(default = "yes")]
    pub read_file: bool,
    #[serde(default)] // false — opt-in
    pub write_file: bool,
    #[serde(default = "yes")]
    pub sys_info: bool,
    #[serde(default = "yes")]
    pub processes: bool,
}

fn yes() -> bool {
    true
}
fn default_audit_path() -> String {
    "jarvis-agent-audit.log".into()
}

impl Default for Allowlist {
    fn default() -> Self {
        Allowlist {
            search: true,
            exec: false,
            read_file: true,
            write_file: false,
            sys_info: true,
            processes: true,
        }
    }
}

impl Config {
    /// Load from the path in JARVIS_AGENT_CONFIG, or ./agent.toml.
    pub fn load() -> anyhow::Result<Config> {
        let path =
            std::env::var("JARVIS_AGENT_CONFIG").unwrap_or_else(|_| "agent.toml".into());
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("config '{path}' not readable: {e}"))?;
        Ok(toml::from_str(&raw)?)
    }
}
