"""
XTTS-v2 voice cloning service for Jarvis (streaming).

Streams Float32 PCM @ 24 kHz as XTTS-v2 generates it. Two transports:

  POST /synthesize/stream  -> audio/pcm-f32le @ 24 kHz mono, chunked HTTP
  WS   /synthesize/ws      -> JSON first frame {text,lang,fx,speed} then
                              binary Float32LE frames, ends with text
                              {"type":"end"}. Client may send
                              {"type":"abort"} to stop generation early.

Optional Jarvis FX (mild low-pass + 10 ms doubling delay + short plate
reverb) is applied stateful per-stream when fx=true. Default off — the
test widget asked for the raw cloned voice.

Performance notes:
  - stream_chunk_size raised to 80 (upstream default 150; we trade some
    first-byte latency for fewer per-chunk overheads and smoother playback).
  - Warmup at startup runs both a short and a long synth so GPT-2 KV-cache
    and CUDA kernels are JIT-compiled before the first real request. The
    long warmup also produces an `rtf_estimate` exposed in /health.
  - torch.compile is gated behind XTTS_TORCH_COMPILE=1 (off by default —
    Windows often lacks triton).
"""

from __future__ import annotations

import asyncio
import io
import os
import time
from pathlib import Path
from typing import Iterator

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from scipy.signal import butter, sosfilt, sosfilt_zi

try:
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
    from TTS.config.shared_configs import BaseDatasetConfig
    torch.serialization.add_safe_globals([XttsConfig, XttsAudioConfig, XttsArgs, BaseDatasetConfig])
except Exception:
    pass

from TTS.api import TTS  # noqa: E402

HERE = Path(__file__).resolve().parent
SAMPLES_DIR = HERE.parent / 'samples'
SAMPLE_RATE = 24000
STREAM_CHUNK_SIZE = 40
DEFAULT_SPEED = 1.15


def pick_references(max_samples: int = 5) -> list[Path]:
    candidates = sorted(
        [p for p in SAMPLES_DIR.iterdir() if p.suffix.lower() in ('.wav', '.mp3', '.m4a', '.flac', '.ogg') and not p.name.startswith('_')],
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f'No audio reference found in {SAMPLES_DIR}')
    return candidates[:max_samples]


REFERENCES = pick_references()
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
os.environ.setdefault('COQUI_TOS_AGREED', '1')
print(f'[xtts] device={DEVICE} references={[r.name for r in REFERENCES]}', flush=True)

tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2', gpu=(DEVICE == 'cuda'))
xtts_model = tts.synthesizer.tts_model

if os.environ.get('XTTS_TORCH_COMPILE') == '1':
    try:
        xtts_model.gpt = torch.compile(xtts_model.gpt, mode='reduce-overhead')
        print('[xtts] torch.compile enabled for gpt module', flush=True)
    except Exception as e:
        print(f'[xtts] torch.compile failed (non-fatal): {e}', flush=True)


def compute_latents(refs: list[Path]):
    print(f'[xtts] computing speaker conditioning latents from {len(refs)} sample(s)...', flush=True)
    gpt_cond, spk_emb = xtts_model.get_conditioning_latents(
        audio_path=[str(p) for p in refs],
    )
    print('[xtts] ready', flush=True)
    return gpt_cond, spk_emb


GPT_COND_LATENT, SPEAKER_EMBEDDING = compute_latents(REFERENCES)


def _drain_inference(text: str) -> tuple[float, float]:
    """Drain a synth and return (generation_seconds, audio_seconds)."""
    t0 = time.time()
    total_samples = 0
    chunks = xtts_model.inference_stream(
        text=text,
        language='es',
        gpt_cond_latent=GPT_COND_LATENT,
        speaker_embedding=SPEAKER_EMBEDDING,
        stream_chunk_size=STREAM_CHUNK_SIZE,
        overlap_wav_len=1024,
        temperature=0.55,
        repetition_penalty=4.0,
        length_penalty=1.0,
        top_k=45,
        top_p=0.85,
        speed=DEFAULT_SPEED,
        enable_text_splitting=False,
    )
    for ch in chunks:
        arr = ch.detach().cpu().numpy() if isinstance(ch, torch.Tensor) else np.asarray(ch)
        total_samples += arr.reshape(-1).size
    return time.time() - t0, total_samples / SAMPLE_RATE


RTF_ESTIMATE: float | None = None


def _warmup() -> None:
    """Two-pass warmup: short for kernel JIT, long for sustained-generation
    profile + RTF measurement."""
    global RTF_ESTIMATE
    try:
        print('[xtts] warmup short (kernel JIT)...', flush=True)
        _drain_inference('Hola.')
        print('[xtts] warmup long (measuring RTF)...', flush=True)
        gen_s, audio_s = _drain_inference(
            'Hola, soy Jarvis. Esta es una prueba de mi voz clonada para medir el rendimiento del sistema en condiciones reales.'
        )
        if audio_s > 0:
            RTF_ESTIMATE = gen_s / audio_s
        print(f'[xtts] warmup complete: gen={gen_s:.2f}s audio={audio_s:.2f}s rtf={RTF_ESTIMATE:.3f}', flush=True)
    except Exception as e:
        print(f'[xtts] warmup failed (non-fatal): {e}', flush=True)


_warmup()


# --- Stateful Jarvis FX ----------------------------------------------------

def _make_reverb_ir(sr: int, length_s: float = 0.18, decay: float = 6.5, seed: int = 7) -> np.ndarray:
    n = int(length_s * sr)
    rng = np.random.RandomState(seed)
    env = np.exp(-np.linspace(0.0, decay, n)).astype(np.float32)
    ir = (rng.randn(n).astype(np.float32) * env)
    ir[0] = 1.0
    ir /= float(np.max(np.abs(ir)) + 1e-9)
    return ir


REVERB_IR = _make_reverb_ir(SAMPLE_RATE)
SOFTEN_SOS = butter(2, 6500, 'lowpass', fs=SAMPLE_RATE, output='sos')


class JarvisStreamFX:
    # Soft noise gate: when local RMS sits below GATE_OPEN_RMS, attenuate
    # output gain toward GATE_FLOOR. Attack/release smooth the gain envelope
    # so transients aren't clicked. Targets the constant hiss XTTS-v2 emits
    # during pauses between words without clipping low-amplitude phonemes.
    GATE_OPEN_RMS = 0.020   # ~-34 dBFS
    GATE_CLOSE_RMS = 0.005  # ~-46 dBFS
    GATE_FLOOR = 0.08       # closed gate attenuation (~-22 dB residual)
    GATE_ATTACK = 0.95      # near-instant open so first phoneme isn't faded in
    GATE_RELEASE = 0.0008   # per-sample smoothing toward target (close)

    def __init__(self) -> None:
        self.lp_zi = (sosfilt_zi(SOFTEN_SOS) * 0.0).astype(np.float64)
        self.delay_n = int(0.010 * SAMPLE_RATE)
        self.delay_buf = np.zeros(self.delay_n, dtype=np.float32)
        self.reverb_tail = np.zeros(len(REVERB_IR) - 1, dtype=np.float32)
        self.gate_gain = 1.0
        self.gate_rms = 0.0

    def _apply_gate(self, x: np.ndarray) -> np.ndarray:
        # Compute a running RMS estimator over the chunk in coarse blocks
        # (32 samples ~ 1.3 ms @ 24 kHz) and run a smoothed gain envelope.
        n = x.size
        block = 32
        out = np.empty_like(x)
        rms_est = self.gate_rms
        gain = self.gate_gain
        for start in range(0, n, block):
            end = min(start + block, n)
            seg = x[start:end]
            inst_rms = float(np.sqrt(np.mean(seg * seg) + 1e-12))
            rms_est = rms_est * 0.85 + inst_rms * 0.15
            if rms_est > self.GATE_OPEN_RMS:
                target = 1.0
                a = self.GATE_ATTACK
            elif rms_est < self.GATE_CLOSE_RMS:
                target = self.GATE_FLOOR
                a = self.GATE_RELEASE
            else:
                # Hysteresis band: hold current target direction
                target = gain
                a = self.GATE_RELEASE
            gain = gain + (target - gain) * a
            out[start:end] = seg * gain
        self.gate_rms = rms_est
        self.gate_gain = gain
        return out

    def process(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=np.float32)
        if x.size == 0:
            return x
        x = self._apply_gate(x)
        soft, self.lp_zi = sosfilt(SOFTEN_SOS, x, zi=self.lp_zi)
        soft = soft.astype(np.float32)
        n = len(soft)
        if n >= self.delay_n:
            delayed = np.concatenate([self.delay_buf, soft[: n - self.delay_n]])
            self.delay_buf = soft[-self.delay_n:].copy()
        else:
            delayed = self.delay_buf[:n].copy()
            self.delay_buf = np.concatenate([self.delay_buf[n:], soft])
        full = np.convolve(delayed, REVERB_IR, mode='full').astype(np.float32)
        wet = full[:n].copy()
        ov = min(len(self.reverb_tail), n)
        wet[:ov] += self.reverb_tail[:ov]
        new_tail_full = full[n:]
        carry_len = len(REVERB_IR) - 1
        if len(new_tail_full) >= carry_len:
            self.reverb_tail = new_tail_full[:carry_len].copy()
        else:
            self.reverb_tail = np.concatenate(
                [new_tail_full, np.zeros(carry_len - len(new_tail_full), dtype=np.float32)]
            )
        out = 0.85 * soft + 0.22 * delayed + 0.18 * wet
        peak = float(np.max(np.abs(out))) if out.size else 0.0
        if peak > 0.97:
            out = out * (0.97 / peak)
        return out.astype(np.float32)


# --- API -------------------------------------------------------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


class SynthRequest(BaseModel):
    text: str
    lang: str = 'es'
    fx: bool = True
    speed: float | None = None


@app.get('/health')
def health():
    return {
        'ok': True,
        'device': DEVICE,
        'references': [r.name for r in REFERENCES],
        'sr': SAMPLE_RATE,
        'stream_chunk_size': STREAM_CHUNK_SIZE,
        'rtf_estimate': RTF_ESTIMATE,
    }


def _stream_iter(text: str, lang: str, fx_enabled: bool, speed: float) -> Iterator[bytes]:
    fx = JarvisStreamFX() if fx_enabled else None
    chunks = xtts_model.inference_stream(
        text=text,
        language=lang,
        gpt_cond_latent=GPT_COND_LATENT,
        speaker_embedding=SPEAKER_EMBEDDING,
        stream_chunk_size=STREAM_CHUNK_SIZE,
        overlap_wav_len=1024,
        temperature=0.55,
        repetition_penalty=4.0,
        length_penalty=1.0,
        top_k=45,
        top_p=0.85,
        speed=speed,
        enable_text_splitting=False,
    )
    for ch in chunks:
        if isinstance(ch, torch.Tensor):
            arr = ch.detach().cpu().numpy().astype(np.float32).reshape(-1)
        else:
            arr = np.asarray(ch, dtype=np.float32).reshape(-1)
        if arr.size == 0:
            continue
        if fx is not None:
            arr = fx.process(arr)
        yield arr.tobytes()


@app.post('/synthesize/stream')
def synthesize_stream(req: SynthRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail='empty text')
    return StreamingResponse(
        _stream_iter(text, req.lang, req.fx, req.speed if req.speed is not None else DEFAULT_SPEED),
        media_type='audio/pcm-f32le',
        headers={
            'X-Sample-Rate': str(SAMPLE_RATE),
            'X-Channels': '1',
            'X-Encoding': 'float32-le',
            'Cache-Control': 'no-store',
        },
    )


@app.post('/synthesize')
def synthesize(req: SynthRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail='empty text')
    pieces: list[np.ndarray] = []
    fx = JarvisStreamFX() if req.fx else None
    for ch in xtts_model.inference_stream(
        text=text,
        language=req.lang,
        gpt_cond_latent=GPT_COND_LATENT,
        speaker_embedding=SPEAKER_EMBEDDING,
        stream_chunk_size=STREAM_CHUNK_SIZE,
        overlap_wav_len=1024,
        temperature=0.55,
        repetition_penalty=4.0,
        length_penalty=1.0,
        top_k=45,
        top_p=0.85,
        speed=req.speed if req.speed is not None else DEFAULT_SPEED,
        enable_text_splitting=False,
    ):
        arr = (ch.detach().cpu().numpy() if isinstance(ch, torch.Tensor) else np.asarray(ch)).astype(np.float32).reshape(-1)
        if arr.size == 0:
            continue
        if fx is not None:
            arr = fx.process(arr)
        pieces.append(arr)
    audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format='WAV')
    return Response(content=buf.getvalue(), media_type='audio/wav')


@app.websocket('/synthesize/ws')
async def synthesize_ws(ws: WebSocket):
    await ws.accept()
    try:
        params = await ws.receive_json()
    except (WebSocketDisconnect, Exception):
        return

    text = str(params.get('text', '')).strip()
    if not text:
        try:
            await ws.send_json({'type': 'error', 'error': 'empty_text'})
            await ws.close()
        except Exception:
            pass
        return

    lang = str(params.get('lang', 'es'))
    fx_enabled = bool(params.get('fx', False))
    speed_raw = params.get('speed')
    speed = float(speed_raw) if speed_raw is not None else DEFAULT_SPEED

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
    iterator = _stream_iter(text, lang, fx_enabled, speed)

    try:
        await ws.send_json({
            'type': 'start',
            'sr': SAMPLE_RATE,
            'channels': 1,
            'encoding': 'float32-le',
        })
        while not abort.is_set():
            chunk = await loop.run_in_executor(None, lambda: next(iterator, None))
            if chunk is None:
                break
            await ws.send_bytes(chunk)
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


@app.post('/reload-voice')
def reload_voice():
    global REFERENCES, GPT_COND_LATENT, SPEAKER_EMBEDDING
    REFERENCES = pick_references()
    if not REFERENCES:
        raise HTTPException(status_code=404, detail='no samples found')
    GPT_COND_LATENT, SPEAKER_EMBEDDING = compute_latents(REFERENCES)
    return {'ok': True, 'references': [r.name for r in REFERENCES]}


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('XTTS_PORT', '8789'))
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='info')
