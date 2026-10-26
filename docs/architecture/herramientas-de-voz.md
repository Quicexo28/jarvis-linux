# Superficie de herramientas de la voz

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

### Superficie de herramientas de la voz (`lib/voiceTools.js`)

Un solo sitio decide qué NO puede tocar la sesión de voz, con el motivo escrito al lado de cada entrada, y un **test de deriva** que lo mantiene coherente con el prompt: la lista y el prompt viven en ficheros distintos, así que sin ese test divergen en silencio y el modelo acaba con instrucciones de usar una tool que ya no existe — e improvisa. El test además comprueba que cada nombre MCP denegado existe de verdad en `jarvis-mcp.js` (una errata deniega NADA, sin avisar).

- **Built-ins fuera**: `Bash,Write,Edit,NotebookEdit,Task,KillShell,BashOutput`. Los tres primeros esquivan el gate de riesgo; `Task` es un multiplicador de coste sin techo en un turno de voz. **Se quedan** WebSearch/WebFetch y el MCP de ficheros (acotado a vault+código y sí gateado).
- **Tools MCP fuera**: `remote_exec`, `remote_write_file`, `remote_read_file` (ejecución y escritura arbitrarias en OTRA máquina; a la voz le bastan `remote_machines/sysinfo/search/wake`), `code_restart` (reiniciar el backend a mitad de turno mata el propio turno) y `code_checkpoint` (mantenimiento, no conversación).
- **Se quedan a propósito** `run_terminal`, `system_power`, `system_process`, `launch_app`, `code_task`, `code_run` y `code_rollback`: el prompt los documenta, el dueño los eligió, y `toolRisk` los clasifica destructivos, así que exigen voz reconocida reciente.
- Override completo con `JARVIS_VOICE_DISALLOWED_TOOLS`.

**Timer y chrono son UNA tool cada uno con `action`** (2026-10-02; antes 7 + 7 — ver «Autodiagnóstico, agenda y memoria semántica»). El ahorro de COSTE de recortar tools es despreciable: los esquemas van en el prefijo cacheado (`cache_read`), lo caro medido son WebSearch (~18 s, $0.11) y visión (~11 s).

