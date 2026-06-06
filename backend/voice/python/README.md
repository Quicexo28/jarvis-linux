# XTTS-v2 voice cloning service

Local Coqui XTTS-v2 server that clones the speaker in `../samples/` and exposes
an HTTP endpoint for the Node backend to synthesize Jarvis's voice.

## Setup

Already done. The venv is at `.venv/` (Python 3.11.15, PyTorch 2.5.1+cu121,
coqui-tts, fastapi, uvicorn). To recreate it from scratch:

```powershell
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu121
uv pip install --python .venv/Scripts/python.exe coqui-tts "transformers>=4.50,<5.0" fastapi "uvicorn[standard]" soundfile
```

## Run

```powershell
.\start.cmd
```

Or:

```powershell
$env:COQUI_TOS_AGREED = "1"
.\.venv\Scripts\python.exe xtts_service.py
```

Listens on `http://127.0.0.1:8789`. Override port with `$env:XTTS_PORT = "9000"`.

The first run downloads the XTTS-v2 model (~2 GB) into the user-cache dir.
Subsequent runs start in ~5-10 s (model load).

## API

- `GET  /health`      — returns `{ ok, device, reference }`.
- `POST /synthesize`  — body `{ "text": "...", "lang": "es" }`, returns `audio/wav`.

## How the Node backend uses it

`backend/src/handlers/jarvis.js::handleJarvisTts` proxies
`POST /api/jarvis/tts` → `POST http://127.0.0.1:8789/synthesize` and pipes the
WAV back. The frontend (`ListeningLayer.triggerWake`) plays the WAV via the
HTML `<audio>` element. If this service is down, the frontend silently falls
back to the browser's `speechSynthesis`.
