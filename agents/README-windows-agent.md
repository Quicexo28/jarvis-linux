# Handoff — desplegar el agente Jarvis en el PC Windows

Instrucciones para el **Claude que corre en el PC Windows "main"**. Objetivo:
compilar el binario del agente nativo, instalarlo como servicio de Windows, y
dejarlo conectado al cerebro (portátil Linux) por Tailscale.

El cerebro ya está configurado del lado Linux:
- Hub escuchando en `main-jarvis.tail361fcb.ts.net:8794` (WebSocket, vía Tailscale).
- Token por-agente para `main` ya generado y registrado en el hub.

## Contexto que el Claude de Windows necesita

- El código del agente vive en el repo `jarvis-linux`, carpeta `agents/`
  (workspace Cargo: crates `protocol`, `hub`, `agent`). Solo se compila el crate
  `agent`. Copia esa carpeta al PC Windows (o clona el repo).
- El agente conecta OUTBOUND al hub — el PC Windows no abre ningún puerto.

## Pasos

### 1. Toolchain
```powershell
# Rust (si no está)
winget install Rustlang.Rustup
rustup default stable
```

### 2. Everything CLI (búsqueda rápida de archivos — capacidad v1)
```powershell
winget install voidtools.Everything
# El agente usa la CLI `es.exe`. Descárgala de https://www.voidtools.com/downloads/
# (sección "Command-line Interface") y déjala en el PATH o junto al binario.
# Sin es.exe el agente cae a un walkdir propio — funciona igual, más lento.
```
El servicio "Everything" debe estar corriendo (lo instala winget) para que `es.exe`
responda.

### 3. Compilar el agente (nativo en Windows)
```powershell
cd <ruta>\agents
cargo build --release -p jarvis-agent --features winservice
# Binario: agents\target\release\jarvis-agent.exe
```

### 4. Config local del agente
Crea `agent.toml` junto al `.exe` (o apunta `JARVIS_AGENT_CONFIG` a él).
Parte de `agents\agent\agent.toml.example`:

```toml
hub_url    = "ws://main-jarvis.tail361fcb.ts.net:8794"
agent_name = "main"
token      = "552959f1b929a43b365cb2f1cc6cbba900718ae1b6fba41a"
audit_log  = "C:\\ProgramData\\Jarvis\\agent-audit.log"

[allowlist]
search     = true
exec       = false   # <-- déjalo en false hasta que el dueño lo active a propósito
read_file  = true
write_file = false
sys_info   = true
processes  = true
```

> **Seguridad:** el token es un secreto. No lo subas a git. `exec` y `write_file`
> arrancan deshabilitados a propósito — actívalos solo cuando el dueño lo pida.

### 5. Probar en primer plano antes de instalar el servicio
```powershell
$env:JARVIS_AGENT_CONFIG = "<ruta>\agent.toml"
$env:RUST_LOG = "info"
.\target\release\jarvis-agent.exe
# Esperado: "handshake accepted by hub". En el portátil, Jarvis notifica
# "main está en línea" por Telegram.
```
Verifica desde el portátil (o pídele al dueño):
`curl http://127.0.0.1:8795/machines` debe listar `main`.

### 6. Instalar como servicio de Windows
El binario incluye el host de servicio bajo `--features winservice`. Regístralo con
`sc.exe` para que sobreviva reinicios y logoff (sin sesión de usuario):

```powershell
# Ejecuta PowerShell como Administrador.
New-Item -ItemType Directory -Force "C:\Program Files\Jarvis" | Out-Null
Copy-Item .\target\release\jarvis-agent.exe "C:\Program Files\Jarvis\"
Copy-Item .\agent.toml "C:\Program Files\Jarvis\"

sc.exe create JarvisAgent binPath= "\"C:\Program Files\Jarvis\jarvis-agent.exe\"" start= auto
sc.exe description JarvisAgent "Jarvis remote agent (conecta al cerebro por Tailscale)"
# El servicio necesita ver la config; apúntala por variable de entorno de máquina:
[Environment]::SetEnvironmentVariable("JARVIS_AGENT_CONFIG", "C:\Program Files\Jarvis\agent.toml", "Machine")
sc.exe start JarvisAgent
```

> **NOTA para el Claude de Windows:** el arranque como Windows Service (el
> `service_dispatcher` de la crate `windows-service`) es la parte que NO se puede
> probar desde Linux. Si el binario corre bien en primer plano (paso 5) pero el
> servicio no arranca, revisa el Visor de Eventos → Registros de Windows →
> Aplicación, y confirma que `main.rs` entra por la rama `winservice`. La
> integración del `service_dispatcher` es el único código pendiente de validar
> nativo — el resto (WS, handshake, reconexión, ops) ya está probado en Linux.

### 7. Verificar Wake-on-LAN (lo dispara el cerebro; el agente solo registra su MAC)
El agente envía todas sus MACs en el handshake. Para que el cerebro pueda
despertar el PC:
- BIOS/UEFI: habilita "Wake on LAN" / "Power on by PCI-E".
- Windows: Administrador de dispositivos → adaptador de red → Administración de
  energía → "Permitir que este dispositivo reactive el equipo" + "Solo con
  paquete mágico".

## Criterio de éxito
- El portátil notifica "main está en línea" al arrancar el servicio.
- `remote_sysinfo(machine="main")` desde el chat de Jarvis devuelve CPU/RAM/disco reales.
- Apagar y encender el PC → el agente reconecta solo (backoff) y Jarvis re-notifica.
