//! Operation dispatch. Every op is gated by the local allowlist first, then
//! recorded to the audit log, then executed. All ops run inside a
//! `spawn_blocking` task on the agent, so blocking fs/process calls here are
//! fine and never stall the WebSocket reader.

use std::io::{Read, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine;
use protocol::{
    Capability, ExecParams, Op, OpResult, OsKind, ProcessInfo, ReadFileParams, RemotePath,
    SearchHit, SearchParams, SysInfo, WriteFileParams,
};
use sysinfo::{Disks, System};
use wait_timeout::ChildExt;

use crate::config::Config;

/// Upper bound on any single buffered payload (exec output, file chunk) so one
/// op can never balloon the JSON frame. 4 MiB is generous for text results.
const MAX_PAYLOAD: usize = 4 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_SEARCH_MAX: u32 = 100;
const SEARCH_MAX_CAP: u32 = 5000;

/// Capabilities this agent currently permits, derived from the allowlist. Sent
/// in the handshake so the brain only offers tools the machine will accept.
pub fn enabled_capabilities(cfg: &Config) -> Vec<Capability> {
    let a = &cfg.allowlist;
    let mut caps = Vec::new();
    if a.search {
        caps.push(Capability::Search);
    }
    if a.exec {
        caps.push(Capability::Exec);
    }
    if a.read_file {
        caps.push(Capability::ReadFile);
    }
    if a.write_file {
        caps.push(Capability::WriteFile);
    }
    if a.sys_info {
        caps.push(Capability::SysInfo);
    }
    if a.processes {
        caps.push(Capability::Processes);
    }
    caps
}

fn allowed(cfg: &Config, op: &Op) -> bool {
    let a = &cfg.allowlist;
    match op {
        Op::Search(_) => a.search,
        Op::Exec(_) => a.exec,
        Op::ReadFile(_) => a.read_file,
        Op::WriteFile(_) => a.write_file,
        Op::SysInfo => a.sys_info,
        Op::ListProcesses => a.processes,
    }
}

fn op_name(op: &Op) -> &'static str {
    match op {
        Op::Search(_) => "search",
        Op::Exec(_) => "exec",
        Op::ReadFile(_) => "read_file",
        Op::WriteFile(_) => "write_file",
        Op::SysInfo => "sys_info",
        Op::ListProcesses => "list_processes",
    }
}

/// Local audit trail: every op, timestamped, whether allowed or denied.
fn audit(cfg: &Config, op: &Op, allowed: bool, detail: &str) {
    let line = format!(
        "{}\t{}\t{}\t{}\t{}\n",
        chrono_now(),
        cfg.agent_name,
        op_name(op),
        if allowed { "ALLOW" } else { "DENY" },
        detail,
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cfg.audit_log)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

// Minimal RFC3339-ish timestamp without pulling a date crate.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
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

/// A path on THIS agent's OS, tagged so the brain never splits it wrong.
fn here(raw: impl Into<String>) -> RemotePath {
    RemotePath { raw: raw.into(), os: os_kind() }
}

/// Short human detail for the audit line (query, command, path…).
fn op_detail(op: &Op) -> String {
    match op {
        Op::Search(p) => format!("q={}", p.query),
        Op::Exec(p) => format!("{} {}", p.command, p.args.join(" ")),
        Op::ReadFile(p) => p.path.raw.clone(),
        Op::WriteFile(p) => p.path.raw.clone(),
        _ => String::new(),
    }
}

/// Run one op, returning the typed result. Never panics: any failure becomes an
/// `OpResult::Error`. `denied=true` distinguishes an allowlist refusal.
pub fn dispatch(cfg: &Config, op: Op) -> OpResult {
    let ok = allowed(cfg, &op);
    audit(cfg, &op, ok, &op_detail(&op));
    if !ok {
        return OpResult::Error {
            message: format!("operación '{}' no permitida por la allowlist local", op_name(&op)),
            denied: true,
        };
    }
    match op {
        Op::SysInfo => sysinfo_result(),
        Op::Search(p) => search(p),
        Op::Exec(p) => exec(p),
        Op::ReadFile(p) => read_file(p),
        Op::WriteFile(p) => write_file(p),
        Op::ListProcesses => list_processes(),
    }
}

fn err(message: impl Into<String>) -> OpResult {
    OpResult::Error { message: message.into(), denied: false }
}

fn sysinfo_result() -> OpResult {
    let mut sys = System::new_all();
    sys.refresh_all();
    let disks = Disks::new_with_refreshed_list();
    let (disk_total, disk_avail) = disks
        .iter()
        .next()
        .map(|d| (d.total_space(), d.available_space()))
        .unwrap_or((0, 0));
    OpResult::SysInfo(SysInfo {
        cpu_percent: sys.global_cpu_usage(),
        mem_used_mb: (sys.used_memory() / 1_048_576),
        mem_total_mb: (sys.total_memory() / 1_048_576),
        disk_used_gb: (disk_total.saturating_sub(disk_avail)) / 1_073_741_824,
        disk_total_gb: disk_total / 1_073_741_824,
        uptime_secs: System::uptime(),
        hostname: System::host_name().unwrap_or_else(|| "unknown".into()),
    })
}

// ---------------------------------------------------------------------------
// Search — Everything CLI (`es.exe`) when present, else a bounded walkdir.
// ---------------------------------------------------------------------------

fn search(p: SearchParams) -> OpResult {
    let max = p.max_results.unwrap_or(DEFAULT_SEARCH_MAX).min(SEARCH_MAX_CAP);
    match search_everything(&p, max) {
        Some(hits) => OpResult::Search { hits },
        None => OpResult::Search { hits: search_walkdir(&p, max) },
    }
}

/// Run `es.exe` (Everything CLI). Returns None if es.exe is unavailable or
/// errors, so the caller falls back to walkdir. Everything is Windows-only.
fn search_everything(p: &SearchParams, max: u32) -> Option<Vec<SearchHit>> {
    if !cfg!(windows) {
        return None;
    }
    let out = Command::new("es.exe")
        .arg("-n")
        .arg(max.to_string())
        .arg(&p.query)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let hits = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(max as usize)
        .map(|line| {
            let meta = std::fs::metadata(line).ok();
            SearchHit {
                path: here(line.to_string()),
                size_bytes: meta.as_ref().map(|m| m.len()),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            }
        })
        .collect();
    Some(hits)
}

/// Fallback: walk `root` (or the filesystem root) matching the query as a
/// case-insensitive substring of the file name. Bounded by `max`.
fn search_walkdir(p: &SearchParams, max: u32) -> Vec<SearchHit> {
    let root = p
        .root
        .as_ref()
        .map(|r| r.raw.clone())
        .unwrap_or_else(|| if cfg!(windows) { "C:\\".into() } else { "/".into() });
    let needle = p.query.to_lowercase();
    let mut hits = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if hits.len() >= max as usize {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if needle.is_empty() || name.contains(&needle) {
            let meta = entry.metadata().ok();
            hits.push(SearchHit {
                path: here(entry.path().to_string_lossy().into_owned()),
                size_bytes: meta.as_ref().map(|m| m.len()),
                is_dir: entry.file_type().is_dir(),
            });
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// Exec — buffered run with a hard timeout. Pipes are drained on threads so a
// chatty child can't deadlock against a full pipe while we wait.
// ---------------------------------------------------------------------------

fn exec(p: ExecParams) -> OpResult {
    let timeout = p
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_EXEC_TIMEOUT);

    let mut cmd = Command::new(&p.command);
    cmd.args(&p.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &p.cwd {
        cmd.current_dir(&cwd.raw);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return err(format!("no se pudo lanzar '{}': {e}", p.command)),
    };

    // Drain both pipes concurrently; reads run to EOF, which arrives when the
    // child exits (or when we kill it on timeout, closing the pipes).
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_join = stdout.map(|mut h| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = h.read_to_end(&mut buf);
            buf
        })
    });
    let err_join = stderr.map(|mut h| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = h.read_to_end(&mut buf);
            buf
        })
    });

    let (status, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(s)) => (Some(s), false),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(e) => return err(format!("error esperando el proceso: {e}")),
    };

    let stdout = out_join.and_then(|j| j.join().ok()).unwrap_or_default();
    let stderr = err_join.and_then(|j| j.join().ok()).unwrap_or_default();

    OpResult::Exec {
        // ExitStatus::code() is None when killed by signal/timeout.
        exit_code: status.and_then(|s| s.code()),
        stdout: transcode(&stdout),
        stderr: transcode(&stderr),
        timed_out,
    }
}

/// Console output is not guaranteed UTF-8 (Windows consoles emit CP850/OEM).
/// Lossy decode keeps the frame valid UTF-8; truncate to the payload cap.
fn transcode(bytes: &[u8]) -> String {
    let slice = if bytes.len() > MAX_PAYLOAD { &bytes[..MAX_PAYLOAD] } else { bytes };
    String::from_utf8_lossy(slice).into_owned()
}

// ---------------------------------------------------------------------------
// File read/write — chunked via offset/length, base64 for binary safety.
// ---------------------------------------------------------------------------

fn read_file(p: ReadFileParams) -> OpResult {
    let mut f = match std::fs::File::open(&p.path.raw) {
        Ok(f) => f,
        Err(e) => return err(format!("no se pudo abrir '{}': {e}", p.path.raw)),
    };
    let offset = p.offset.unwrap_or(0);
    if offset > 0 {
        if let Err(e) = f.seek(SeekFrom::Start(offset)) {
            return err(format!("seek falló: {e}"));
        }
    }
    let want = p.length.map(|l| l as usize).unwrap_or(MAX_PAYLOAD).min(MAX_PAYLOAD);
    let mut buf = vec![0u8; want];
    let mut filled = 0;
    while filled < want {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return err(format!("lectura falló: {e}")),
        }
    }
    buf.truncate(filled);
    // eof unless we filled the whole requested window (caller pages further).
    let eof = filled < want;
    OpResult::ReadFile {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&buf),
        eof,
    }
}

fn write_file(p: WriteFileParams) -> OpResult {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(p.data_base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => return err(format!("base64 inválido: {e}")),
    };
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if p.append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut f = match opts.open(&p.path.raw) {
        Ok(f) => f,
        Err(e) => return err(format!("no se pudo abrir '{}' para escritura: {e}", p.path.raw)),
    };
    match f.write_all(&bytes) {
        Ok(_) => OpResult::WriteFile { bytes_written: bytes.len() as u64 },
        Err(e) => err(format!("escritura falló: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Processes — top consumers by memory. CPU needs two samples spaced by the
// refresh interval, so we refresh, wait, and refresh again.
// ---------------------------------------------------------------------------

fn list_processes() -> OpResult {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut procs: Vec<ProcessInfo> = sys
        .processes()
        .values()
        .map(|p| ProcessInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu_percent: p.cpu_usage(),
            mem_mb: p.memory() / 1_048_576,
        })
        .collect();
    procs.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
    procs.truncate(50);
    OpResult::Processes { processes: procs }
}
