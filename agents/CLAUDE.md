# agents/

Workspace Cargo separado del backend: `protocol` (tipos serde + `PROTOCOL_VERSION`), `hub` (sidecar en el portátil, 8794 WS / 8795 control local), `agent` (binario headless en cada máquina).

- Cambiaste `protocol`: regenera el schema para Node con `cargo run -p jarvis-agent-protocol --bin gen-schema -- backend/data/agents`.
- El agente veta `exec`/`write` por allowlist local aunque el hub lo pida; no lo debilites.
- `winservice.rs` no se puede validar en Linux.
- Cambiaste `hub`: `systemctl --user restart jarvis-agenthub`.

Detalle, receta de despliegue en Windows y Wake-on-LAN: `../docs/architecture/agentes-distribuidos.md`.
