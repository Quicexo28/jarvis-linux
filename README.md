# Jarvis (Linux)

Asistente personal tipo **Jarvis** que corre como **servicio de red en la LAN**:
un portátil/PC con Arch Linux es el servidor (voz, STT/TTS, Claude + herramientas),
y cualquier dispositivo en la WiFi lo usa desde el navegador en
`http://<ip-del-servidor>:8788`. Voz manos libres (doble palmada o palabra de
activación), gestos con la cámara, visor 3D, control de PC, recordatorios y
bots de Telegram. UI en español (Colombia).

> El backend escucha en `0.0.0.0:8788`. La UI local corre en Chromium en modo
> kiosko (no usa Electron); cualquier navegador de la LAN también sirve.

---

## Instalación rápida (Arch Linux)

```bash
git clone https://github.com/Quicexo28/jarvis-linux.git ~/jarvis-linux
cd ~/jarvis-linux
bash scripts/linux/install.sh
```

Eso deja **todo listo**: paquetes del sistema, dependencias de Node y Python,
build del frontend, y los servicios `systemd` habilitados para arrancar solos al
iniciar sesión. Para arrancar ya mismo sin reiniciar:

```bash
systemctl --user start jarvis-backend jarvis-stt jarvis-tts jarvis-ui
```

Logs en vivo: `journalctl --user -u jarvis-backend -f`

**¿Solo CPU (sin GPU NVIDIA)?** Instala con el índice de PyTorch para CPU:

```bash
JARVIS_TORCH_INDEX=https://download.pytorch.org/whl/cpu bash scripts/linux/install.sh
```

---

## Dependencias (qué instala y por qué)

`install.sh` instala todo esto automáticamente. Si prefieres hacerlo a mano, o
quieres saber qué se baja, aquí está el desglose.

### 1. Paquetes del sistema (`pacman`)

```bash
sudo pacman -S --needed nodejs npm python python-pip chromium git portaudio \
  ydotool xdotool wmctrl xdg-utils
```

| Paquete | Para qué |
|---|---|
| `nodejs` `npm` | Backend (API/WS) y build del frontend |
| `python` `python-pip` | Stack de voz (STT/TTS/speaker-ID/wake) |
| `chromium` | UI en modo kiosko (`jarvis-ui.service`) |
| `portaudio` | Captura de micrófono para el wake word |
| `ydotool` | Inyección de teclado/ratón en **Wayland** (control de PC) |
| `xdotool` `wmctrl` | Teclado/ratón y ventanas en **X11** (control de PC) |
| `xdg-utils` | Lanzar apps (`xdg-open` / `.desktop`) |

Opcional: **`cloudflared`** (repos o AUR: `yay -S cloudflared`) para exponer la UI
con una URL pública HTTPS y que el QR del móvil funcione fuera de la LAN. Si no
está, el QR usa la IP de la LAN o de Tailscale.

### 2. Dependencias de Node

```bash
cd backend  && npm install      # ws, qrcode
cd frontend && npm install && npm run build
```

### 3. Stack de Python (en un venv)

```bash
cd backend/voice/python
python -m venv .venv
.venv/bin/pip install --upgrade pip
# PyTorch PRIMERO, desde las ruedas CUDA 11.8 (RTX 3050 / Ampere):
.venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
.venv/bin/pip install -r requirements.txt
# Wake word opcional ("Jarvis"); sin esto, palmada/atajo siguen funcionando:
.venv/bin/pip install "openWakeWord>=0.6.0" pyaudio aiohttp
```

Incluye faster-whisper + Silero VAD (STT), Edge TTS (voz por defecto, sin GPU),
resemblyzer (identificación de hablante), `cryptography` (cifra la huella de voz
del dueño y los secretos), y `psutil` (control de PC). El detalle y la nota de
GPU están en `backend/voice/python/requirements.txt`.

### GPU (NVIDIA, opcional pero recomendado para STT rápido)

```bash
sudo pacman -S nvidia nvidia-utils cuda cudnn
# verifica:
backend/voice/python/.venv/bin/python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Usa el índice **cu118** (Ampere/RTX 3050). **No** uses cu128 (eso es RTX 50-series).

---

## Configuración

### Secretos / tokens

Crea `backend/data/secrets.local.json` (la carpeta `backend/data/` está en
`.gitignore` — nunca se sube). En el **primer arranque** Jarvis lo cifra en
`secrets.local.enc` con una clave por máquina en `~/.config/jarvis/machine.key`
(modo 0600) y borra el plano. Variables útiles:

```json
{
  "TELEGRAM_BOT_TOKEN": "...",
  "TELEGRAM_BOT_TOKEN_JARVIS": "...",
  "TELEGRAM_CHAT_ID_JARVIS": "...",
  "JARVIS_OBSIDIAN_VAULT": "/home/tu-usuario/Obsidian/Vault",
  "JARVIS_CODE_DIR": "/home/tu-usuario/jarvis-linux"
}
```

> Para **editar** los secretos más tarde: borra `backend/data/secrets.local.enc`,
> vuelve a crear `secrets.local.json` con los valores nuevos y reinicia el
> backend (se re-cifra en el arranque).

> Migrando desde Windows: en el PC viejo corre `node backend/scripts/unlock.js`
> para ver los valores en claro, y cópialos aquí. (También existe la bóveda
> portable: `npm run make-portable` en Windows genera `jarvis-portable.enc`;
> cópialo a `backend/data/` y desbloquéalo con `npm run unlock` o desde la UI.)

### Identidad del dueño (voz)

El dueño se reconoce por su **huella de voz** (lo más seguro). Tras enrolar tus
muestras (el asistente de primer arranque lo hace, o `SpeakerConfigPanel`):

```bash
cd backend/voice/python && .venv/bin/python make_owner_voiceprint.py
```

Mientras no exista la huella, hay un **fallback por nombre**: pon
`JARVIS_OWNER_SPEAKER=tu-nombre-de-perfil` (ya viene en `jarvis-backend.service`).

### Contraseña de autodesarrollo

Para que Jarvis pueda modificar su propio código por voz (gated por contraseña):

```bash
cd backend && npm run set-code-password
```

---

## Servicios `systemd`

| Servicio | Qué hace | Notas |
|---|---|---|
| `jarvis-backend` | API + WS + frontend (`:8788`) | siempre |
| `jarvis-stt` | STT (faster-whisper) | siempre |
| `jarvis-tts` | TTS (Edge por defecto) | siempre |
| `jarvis-wake` | Wake word "Jarvis" | opcional |
| `jarvis-ui` | UI Chromium kiosko | requiere sesión gráfica |
| `jarvis-jarvisbot` | Bot Telegram (QR, recordatorios, silenciar) | arranca solo si hay token; si no, sale limpio |
| `jarvis-cloudbot` | Bot Telegram de archivos en la nube | igual |
| `jarvis-pccontrol` | Control de PC (ventanas, teclado, ratón) | degrada con gracia si faltan herramientas |

`install.sh` los habilita todos. Para gestionar uno:
`systemctl --user {start,stop,status,disable} <servicio>`.

**Control de PC en Wayland (Hyprland):** la inyección de teclado/ratón usa
`ydotool`, que necesita el daemon `ydotoold` y acceso a `/dev/uinput`:

```bash
sudo systemctl enable --now ydotool   # o ydotoold, según el paquete
# y dale acceso a uinput (grupo input o regla udev)
```

En X11 se usa `xdotool`/`wmctrl` y no hace falta daemon. La lectura del árbol de
UI (`read_ui`) no tiene equivalente universal en Linux y devuelve la lista de
ventanas como degradación.

**Servidor 24/7 (tapa cerrada):** en `/etc/systemd/logind.conf` pon
`HandleLidSwitch=ignore` y reinicia `systemd-logind`. Reserva la IP por DHCP en
el router para una URL estable en la LAN.

### Hyprland

Para que la ventana de Jarvis no tenga bordes y quede fijada, añade a
`~/.config/hypr/hyprland.conf`:

```
source = ~/jarvis-linux/scripts/linux/hyprland-jarvis.conf
```

---

## Desarrollo

Servicios independientes — terminales separadas:

```bash
cd backend  && npm run dev     # API en http://0.0.0.0:8788   ·  npm test
cd frontend && npm run dev     # Vite en :5173                ·  npm test
cd backend/voice/python && .venv/bin/python stt_service.py    # STT :8790
cd backend/voice/python && .venv/bin/python edge_tts_service.py
```

`JARVIS_FAKE_CLAUDE=1` evita invocar el CLI real de Claude en los tests.

---

## Arquitectura (resumen)

- **Frontend** (`frontend/`): React + TypeScript + Vite, React Three Fiber.
  Capas: Core (voz/texto), Casa (habitaciones), Plano 2D, Espacio 3D, Inmersivo,
  visor 3D paramétrico/polítopo/implícito. Gestos con MediaPipe. Detección de
  palmada por DSP puro.
- **Backend** (`backend/src/`): `server.js` (HTTP + WS) → `routes.js` →
  `handlers/`. La voz pasa por STT → gates de atención/intención/hablante →
  sesión persistente de Claude con herramientas MCP → TTS. Bóveda cifrada,
  recordatorios (Telegram), nube (Syncthing+Telegram), control de PC.
- **Python** (`backend/voice/python/`): STT (faster-whisper+VAD), TTS (Edge/XTTS),
  speaker-ID (resemblyzer) con huella del dueño cifrada, wake word, control de PC.

Persistencia del frontend en `localStorage` (planos 2D/3D, dataset de gestos) e
IndexedDB (modelo de gestos entrenado). El backend no usa base de datos:
`attentionState` y `conversationMemory` viven en memoria (ventana de 8 turnos).
