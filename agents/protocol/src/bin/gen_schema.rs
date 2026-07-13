//! Emits the JSON Schema + protocol version for the Node "cerebro" to validate
//! against, so the Node side never drifts from the Rust source of truth.
//! Run: `cargo run -p jarvis-agent-protocol --bin gen-schema -- <out_dir>`

use std::error::Error;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&out_dir)?;

    let schema = schemars::schema_for!(protocol::Message);
    let schema_path = out_dir.join("protocol.schema.json");
    std::fs::write(&schema_path, serde_json::to_string_pretty(&schema)?)?;

    let version_path = out_dir.join("protocol.version.json");
    std::fs::write(
        &version_path,
        serde_json::to_string_pretty(&serde_json::json!({
            "protocol_version": protocol::PROTOCOL_VERSION
        }))?,
    )?;

    println!("wrote {} and {}", schema_path.display(), version_path.display());
    Ok(())
}
