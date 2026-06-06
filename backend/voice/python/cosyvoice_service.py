"""
CosyVoice 2 voice-cloning service for Jarvis.

Mirrors the WS API exposed by xtts_service.py so the Node proxy + frontend
client are engine-agnostic. CosyVoice 2 generates much faster than XTTS
(~150 ms first chunk, RTF < 0.3 on consumer GPU), which is what makes
streaming feel continuous instead of stuttering between chunks.

Endpoints (same as xtts_service.py):
  GET  /health             -> { ok, engine, device, reference, sr, rtf_estimate }
  POST /synthesize         -> audio/wav (buffered)
  WS   /synthesize/ws      -> JSON params + binary Float32LE PCM stream

The reference voice is `backend/voice/samples/jarvis-01.mp3`. CosyVoice 2
needs both reference audio AND a transcription of it (`prompt_text`). We
read the transcription from `samples/jarvis-01.prompt.txt`; if absent the
service starts with a placeholder so it can still boot (clone quality
degrades but the system remains functional).
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import time
from pathlib import Path
from typing import Iterator

# Windows: Python 3.8+ stopped honoring PATH for native DLL discovery, so
# onnxruntime-gpu can't find cudart/cudnn/cublas at LoadLibrary time even
# when CUDA_PATH and PATH are correct. Explicitly add the CUDA bin dir to
# the DLL search path before anything triggers onnxruntime initialization.
if os.name == 'nt':
    _cuda_candidates = [
        os.environ.get('CUDA_PATH'),
        os.environ.get('CUDA_PATH_V12_1'),
        r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.1',
    ]
    for _cand in _cuda_candidates:
        if not _cand:
            continue
        _bin = os.path.join(_cand, 'bin')
        if os.path.isdir(_bin):
            try:
                os.add_dll_directory(_bin)
                print(f'[cosy] added CUDA DLL dir: {_bin}', flush=True)
                break
            except Exception as e:
                print(f'[cosy] add_dll_directory({_bin}) failed: {e}', flush=True)

import numpy as np
import soundfile as sf
import torch

# CosyVoice repo lives under backend/voice/python/CosyVoice/ — vendored
# rather than pip-installed because the v2 model is shipped with the repo
# and the package on PyPI is older (v1 only). The submodule path is also
# required so the third-party Matcha-TTS import works.
HERE = Path(__file__).resolve().parent
COSYVOICE_DIR = HERE / 'CosyVoice'
sys.path.insert(0, str(COSYVOICE_DIR))
sys.path.insert(0, str(COSYVOICE_DIR / 'third_party' / 'Matcha-TTS'))

from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402

SAMPLES_DIR = HERE.parent / 'samples'
MODEL_DIR = COSYVOICE_DIR / 'pretrained_models' / 'CosyVoice2-0.5B'
REFERENCE_WAV = SAMPLES_DIR / 'jarvis-01.mp3'
PROMPT_TEXT_FILE = SAMPLES_DIR / 'jarvis-01.prompt.txt'


def _load_prompt_text() -> str:
    if PROMPT_TEXT_FILE.exists():
        txt = PROMPT_TEXT_FILE.read_text(encoding='utf-8').strip()
        if txt:
            return txt
    # Fallback: a plausible Spanish utterance matching the recorded reference
    # in tone. Clone quality will be reduced versus an accurate transcript.
    return 'Hola, soy Jarvis, tu asistente personal.'


PROMPT_TEXT = _load_prompt_text()
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

print(f'[cosy] device={DEVICE} model_dir={MODEL_DIR}', flush=True)
if not MODEL_DIR.exists():
    raise RuntimeError(
        f'CosyVoice2 model not found at {MODEL_DIR}. Run install_cosyvoice.py to download.'
    )

cosyvoice = AutoModel(model_dir=str(MODEL_DIR))
SAMPLE_RATE = int(cosyvoice.sample_rate)
print(f'[cosy] loaded sr={SAMPLE_RATE} prompt_text={PROMPT_TEXT[:80]!r}', flush=True)

JARVIS_SPK_ID = 'jarvis'
USE_SPK_ID = False
try:
    cosyvoice.add_zero_shot_spk(PROMPT_TEXT, str(REFERENCE_WAV), JARVIS_SPK_ID)
    USE_SPK_ID = True
    print(f'[cosy] registered speaker id={JARVIS_SPK_ID}', flush=True)
except Exception as e:
    print(f'[cosy] add_zero_shot_spk failed (will pass prompt per-request): {e}', flush=True)


def _synth_stream(text: str) -> Iterator[np.ndarray]:
    if USE_SPK_ID:
        gen = cosyvoice.inference_zero_shot(
            text, '', '', zero_shot_spk_id=JARVIS_SPK_ID, stream=True,
        )
    else:
        gen = cosyvoice.inference_zero_shot(
            text, PROMPT_TEXT, str(REFERENCE_WAV), stream=True,
        )
    for chunk in gen:
        wav = chunk.get('tts_speech') if isinstance(chunk, dict) else chunk
        if wav is None:
            continue
        if isinstance(wav, torch.Tensor):
            arr = wav.detach().cpu().numpy().reshape(-1).astype(np.float32)
        else:
            arr = np.asarray(wav, dtype=np.float32).reshape(-1)
        if arr.size == 0:
            continue
        yield arr


RTF_ESTIMATE: float | None = None


def _warmup() -> None:
    global RTF_ESTIMATE
    try:
        print('[cosy] warmup short...', flush=True)
        for _ in _synth_stream('Hola.'):
            pass
        print('[cosy] warmup long (measuring RTF)...', flush=True)
        t0 = time.time()
        total = 0
        for arr in _synth_stream(
            'Hola, soy Jarvis. Esta es una prueba de mi voz clonada para medir el rendimiento del sistema en condiciones reales.'
        ):
            total += arr.size
        gen_s = time.time() - t0
        audio_s = total / SAMPLE_RATE
        if audio_s > 0:
            RTF_ESTIMATE = gen_s / audio_s
        print(f'[cosy] warmup complete gen={gen_s:.2f}s audio={audio_s:.2f}s rtf={RTF_ESTIMATE:.3f}', flush=True)
    except Exception as e:
        print(f'[cosy] warmup failed: {e}', flush=True)


_warmup()


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.get('/health')
def health():
    return {
        'ok': True,
        'engine': 'cosyvoice',
        'device': DEVICE,
        'reference': REFERENCE_WAV.name,
        'sr': SAMPLE_RATE,
        'prompt_text_len': len(PROMPT_TEXT),
        'rtf_estimate': RTF_ESTIMATE,
    }


@app.post('/synthesize')
async def synthesize(req: dict):
    text = str((req or {}).get('text', '')).strip()
    if not text:
        raise HTTPException(status_code=400, detail='empty text')
    pieces = [arr for arr in _synth_stream(text)]
    audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format='WAV')
    return Response(content=buf.getvalue(), media_type='audio/wav')


@app.websocket('/synthesize/ws')
async def synthesize_ws(ws: WebSocket):
    await ws.accept()
    try:
        params = await ws.receive_json()
    except Exception:
        return

    text = str(params.get('text', '')).strip()
    if not text:
        try:
            await ws.send_json({'type': 'error', 'error': 'empty_text'})
            await ws.close()
        except Exception:
            pass
        return

    abort = asyncio.Event()

    async def control_loop():
        try:
            while True:
                msg = await ws.receive_json()
                if isinstance(msg, dict) and msg.get('type') == 'abort':
                    abort.set()
                    return
        except Exception:
            abort.set()

    control_task = asyncio.create_task(control_loop())
    loop = asyncio.get_running_loop()
    iterator = _synth_stream(text)

    try:
        await ws.send_json({
            'type': 'start',
            'sr': SAMPLE_RATE,
            'channels': 1,
            'encoding': 'float32-le',
        })
        while not abort.is_set():
            arr = await loop.run_in_executor(None, lambda: next(iterator, None))
            if arr is None:
                break
            await ws.send_bytes(arr.tobytes())
        if not abort.is_set():
            try:
                await ws.send_json({'type': 'end'})
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({'type': 'error', 'error': str(e)})
        except Exception:
            pass
    finally:
        control_task.cancel()
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('XTTS_PORT', '8789'))
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='info')
