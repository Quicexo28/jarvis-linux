//! Shared wire protocol between the Jarvis hub (laptop) and remote agents.
//!
//! Design rules that keep hub and agent in lockstep:
//!   * Every message is one `Message` enum variant, internally tagged by
//!     `"kind"` so JSON stays self-describing and forward-compatible.
//!   * `PROTOCOL_VERSION` is bumped on any breaking change and checked in the
//!     handshake, so an outdated agent is detected (and, from v1.5, told to
//!     self-update) instead of silently misbehaving.
//!   * Requests carry a correlation `id`; responses and stream chunks echo it,
//!     so many operations multiplex over the single WebSocket concurrently.
//!   * Paths are NEVER split on a separator here — `RemotePath` keeps the raw
//!     string plus the origin OS, so Windows/Linux differences are explicit.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Bumped on any breaking wire change. Checked in the handshake.
pub const PROTOCOL_VERSION: u32 = 1;

/// Top-level frame. Internally tagged so unknown future variants can be skipped
/// by tolerant parsers rather than breaking the stream.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    /// agent -> hub, first frame after connect.
    Hello(Hello),
    /// hub -> agent, accepts (or rejects) the handshake.
    Welcome(Welcome),
    /// hub -> agent, an operation to run. Correlated by `id`.
    Request(Request),
    /// agent -> hub, a chunk of streamed output for a long-running op.
    Stream(StreamChunk),
    /// agent -> hub, terminal result correlated to a `Request.id`.
    Response(Response),
    /// agent -> hub, proactive event with no preceding request (watchers).
    Event(Event),
    /// Heartbeat, either direction. Keeps the Tailscale path warm and detects
    /// half-open sockets after the laptop suspends/resumes.
    Ping,
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub enum OsKind {
    Windows,
    Linux,
    MacOs,
}

/// A filesystem path as seen on the agent's OS. Kept opaque on purpose.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RemotePath {
    pub raw: String,
    pub os: OsKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Hello {
    pub protocol_version: u32,
    /// Logical machine name the brain addresses, e.g. "main".
    pub agent_name: String,
    /// Per-agent secret (revocable from the hub). NOT a global token.
    pub token: String,
    pub os: OsKind,
    /// All NIC MACs, so the hub can Wake-on-LAN this machine later.
    pub mac_addresses: Vec<String>,
    /// Running binary version — drives the v1.5 auto-update decision.
    pub agent_version: String,
    /// Capabilities the agent's local allowlist currently permits. The brain
    /// only offers tools the target actually accepts (e.g. exec may be off).
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Search,
    Exec,
    ReadFile,
    WriteFile,
    SysInfo,
    Processes,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Welcome {
    pub protocol_version: u32,
    pub accepted: bool,
    /// Set when rejected (bad token, version too old with no update path…).
    pub reject_reason: Option<String>,
    /// Version the hub expects this agent to run. When it differs, v1.5 agents
    /// pull the new binary from the hub, verify its hash/signature, swap and
    /// restart. v1 just logs the mismatch.
    pub expected_agent_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Request {
    pub id: String,
    pub op: Op,
}

/// One operation the hub can ask an agent to perform. Adjacently tagged so the
/// op name and its params are clearly separated on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", content = "params", rename_all = "snake_case")]
pub enum Op {
    Search(SearchParams),
    Exec(ExecParams),
    ReadFile(ReadFileParams),
    WriteFile(WriteFileParams),
    SysInfo,
    ListProcesses,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SearchParams {
    pub query: String,
    /// Optional root to scope the walkdir fallback; ignored by Everything.
    pub root: Option<RemotePath>,
    pub max_results: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExecParams {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<RemotePath>,
    pub timeout_ms: Option<u64>,
    /// When true, stdout/stderr arrive as `Stream` frames before the final
    /// `Response`; otherwise they are buffered into the response.
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadFileParams {
    pub path: RemotePath,
    /// Byte offset for chunked reads of large files.
    pub offset: Option<u64>,
    pub length: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WriteFileParams {
    pub path: RemotePath,
    /// Base64 so binary content survives JSON transport intact.
    pub data_base64: String,
    /// Append vs truncate; enables streamed writes of large files.
    pub append: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Response {
    pub id: String,
    pub result: OpResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpResult {
    Search { hits: Vec<SearchHit> },
    Exec { exit_code: Option<i32>, stdout: String, stderr: String, timed_out: bool },
    ReadFile { data_base64: String, eof: bool },
    WriteFile { bytes_written: u64 },
    SysInfo(SysInfo),
    Processes { processes: Vec<ProcessInfo> },
    /// Any op can fail; `denied` marks an allowlist refusal specifically.
    Error { message: String, denied: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SearchHit {
    pub path: RemotePath,
    pub size_bytes: Option<u64>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SysInfo {
    pub cpu_percent: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub disk_used_gb: u64,
    pub disk_total_gb: u64,
    pub uptime_secs: u64,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub mem_mb: u64,
}

/// A chunk of streamed output for a running op, echoing the `Request.id`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StreamChunk {
    pub id: String,
    pub stream: StreamKind,
    /// Always UTF-8. Agents on Windows transcode CP850/UTF-16 before sending.
    pub data: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Stdout,
    Stderr,
}

/// Proactive notification pushed by an agent watcher (no request preceded it).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Event {
    pub agent_name: String,
    /// Renamed on the wire to "event": the `Message` enum is internally tagged
    /// by "kind", so a field also named "kind" would collide into duplicate
    /// JSON keys and break parsing of agent-pushed events.
    #[serde(rename = "event")]
    pub kind: EventKind,
    /// Human-readable, Spanish, ready to forward to the user via Telegram.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    DiskHigh { mount: String, used_percent: f32 },
    ProcessExited { name: String, exit_code: Option<i32> },
    Booted,
    ShuttingDown,
    /// Escape hatch for user-defined watchers without a protocol bump.
    Custom { name: String },
}

impl Message {
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
    pub fn from_json(s: &str) -> serde_json::Result<Self> {
        serde_json::from_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An Event frame must survive a round-trip. Regression for the "kind" key
    /// collision (Message tag vs Event.kind) that produced duplicate JSON keys
    /// and made the hub fail to parse agent-pushed events.
    #[test]
    fn event_frame_round_trips() {
        let msg = Message::Event(Event {
            agent_name: "main".into(),
            kind: EventKind::DiskHigh { mount: "C:".into(), used_percent: 93.5 },
            message: "disco lleno".into(),
        });
        let json = msg.to_json().unwrap();
        // Exactly one top-level "kind" (the enum tag), never two.
        assert_eq!(json.matches("\"kind\"").count(), 1, "duplicate kind key: {json}");
        assert!(json.contains("\"event\""), "renamed field missing: {json}");
        match Message::from_json(&json).unwrap() {
            Message::Event(e) => {
                assert_eq!(e.agent_name, "main");
                assert!(matches!(e.kind, EventKind::DiskHigh { .. }));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn booted_event_parses() {
        let json = Message::Event(Event {
            agent_name: "main".into(),
            kind: EventKind::Booted,
            message: "arrancó".into(),
        })
        .to_json()
        .unwrap();
        assert!(matches!(
            Message::from_json(&json).unwrap(),
            Message::Event(Event { kind: EventKind::Booted, .. })
        ));
    }
}
