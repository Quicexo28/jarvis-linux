# Servicios de voz (Python)

Cada servicio es una unit de usuario (`scripts/linux/jarvis-*.service`) y corre con `.venv/bin/python`.

| Servicio | Archivo | Puerto | Qué hace |
|---|---|---|---|
| `jarvis-stt` | `stt_service.py` | 8790 | Voz a texto (faster-whisper), VAD, speaker-id |
| `jarvis-tts` | `edge_tts_service.py` | 8789 | Texto a voz (edge-tts) con efecto Jarvis. Habla el protocolo WS que antes usaba XTTS |
| `jarvis-wake` | `wake_service.py` | 8791 | Palabra de activación |
| `jarvis-embed` | `embed_service.py` | — | Embeddings para el recall |

`speaker_id.py` lo importa `stt_service.py`. Los tests están en `tests/`.

Instalar dependencias: `.venv/bin/pip install -r requirements.txt`, y reiniciar el servicio tocado.

**Clonar la voz (no activo).** `../samples/jarvis-01.mp3` es el audio de referencia. El motor XTTS-v2 que lo usaba se borró en la limpieza de nov 2026; está en el historial de git (`git log --diff-filter=D -- backend/voice/python/xtts_service.py`).
