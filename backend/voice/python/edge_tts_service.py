"""
Edge-TTS voice service for Jarvis.

Uses Microsoft Edge "Read Aloud" neural voices via the free unauthenticated
edge-tts package. Default voice: `en-US-RyanMultilingualNeural`, which
auto-detects per-utterance language, so the same voice speaks Spanish
naturally when the input text is Spanish.

Same WebSocket protocol as xtts_service.py / cosyvoice_service.py so the
Node proxy and frontend client are engine-agnostic:

  GET  /health             -> { ok, engine, voice, sr, rtf_estimate, ... }
  POST /synthesize         -> audio/wav (buffered)
  WS   /synthesize/ws      -> JSON params + binary Float32LE PCM stream
                              accepts {type:"abort"} mid-stream

Pipeline:
  edge-tts (MP3 24 kHz mono) -> ffmpeg subprocess (s16le PCM)
                             -> int16 -> float32 -> JarvisStreamFX
                             -> client

FX is ON by default. Override per-request via the `fx` field.

Self-reference handling: every occurrence of the word "Jarvis" (any case)
is substituted by JARVIS_NAME_SUBSTITUTE (default "Yarvis") before
synthesis so the multilingual voice produces a Spanish phonetic rendering
closer to the English pronunciation. Set JARVIS_NAME_SUBSTITUTE=Jarvis to
disable.
"""

from __future__ import annotations

import asyncio
import io
import os
import re
import time
from pathlib import Path
from typing import AsyncIterator

import edge_tts
import imageio_ffmpeg
import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from scipy.signal import butter, sosfilt, sosfilt_zi

HERE = Path(__file__).resolve().parent

SAMPLE_RATE = 24000
# Free Edge "Read Aloud" endpoint doesn't support mstts:express-as styles
# (paid Azure Speech only). To approximate the `empathetic` Azure preset we
# nudge the prosody — slightly slower, slightly deeper, slightly louder —
# which lands a warmer, more deliberate delivery.
DEFAULT_VOICE = os.environ.get('EDGE_TTS_VOICE', 'en-US-AndrewMultilingualNeural')
DEFAULT_RATE = os.environ.get('EDGE_TTS_RATE', '-8%')
DEFAULT_PITCH = os.environ.get('EDGE_TTS_PITCH', '-2Hz')
DEFAULT_VOLUME = os.environ.get('EDGE_TTS_VOLUME', '+5%')
JARVIS_NAME_SUB = os.environ.get('JARVIS_NAME_SUBSTITUTE', 'Yarvis').strip()
FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()

JARVIS_NAME_RE = re.compile(r'\b[Jj][Aa][Rr][Vv][Ii][Ss]\b')


def preprocess_text(text: str) -> str:
    if JARVIS_NAME_SUB and JARVIS_NAME_SUB.lower() != 'jarvis':
        return JARVIS_NAME_RE.sub(JARVIS_NAME_SUB, text)
    return text


# --- Jarvis FX (mirrors xtts_service.py — both engines share timbre) --------

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
    GATE_OPEN_RMS = 0.020
    GATE_CLOSE_RMS = 0.005
    GATE_FLOOR = 0.08
    GATE_ATTACK = 0.95
    GATE_RELEASE = 0.0008

    def __init__(self) -> None:
        self.lp_zi = (sosfilt_zi(SOFTEN_SOS) * 0.0).astype(np.float64)
        self.delay_n = int(0.010 * SAMPLE_RATE)
        self.delay_buf = np.zeros(self.delay_n, dtype=np.float32)
        self.reverb_tail = np.zeros(len(REVERB_IR) - 1, dtype=np.float32)
        self.gate_gain = 1.0
        self.gate_rms = 0.0

    def _apply_gate(self, x: np.ndarray) -> np.ndarray:
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
        # Dropped the 0.22*delayed term: a 10 ms doubling reads as "the words
        # overlap" on full conversational replies. Keep mostly-dry voice + a
        # touch of reverb for the Jarvis space.
        out = 0.92 * soft + 0.12 * wet
        peak = float(np.max(np.abs(out))) if out.size else 0.0
        if peak > 0.97:
            out = out * (0.97 / peak)
        return out.astype(np.float32)


# --- Synth core --------------------------------------------------------------

PCM_READ_BYTES = 4096  # 4096 bytes int16 = 2048 samples = ~85 ms @ 24 kHz
# Silent preroll prepended to each utterance. Masks the AudioContext startup
# latency on the browser side — without this the first ~10–30 ms of audio is
# eaten while the audio graph is still warming up, which clipped the "H" of
# "Hola" in user testing.
PREROLL_SILENCE_MS = 80
_PREROLL_BYTES = b'\x00' * (int(SAMPLE_RATE * PREROLL_SILENCE_MS / 1000) * 2)


async def _edge_to_pcm_stream(
    text: str, voice: str, rate: str, pitch: str, volume: str = DEFAULT_VOLUME
) -> AsyncIterator[bytes]:
    """Async generator yielding raw int16 PCM bytes @ 24 kHz mono.

    Pipes edge-tts MP3 frames into an ffmpeg subprocess and reads decoded
    PCM from its stdout. Feeder and reader run concurrently so first PCM
    bytes come out as soon as ffmpeg has decoded the first MP3 frame.
    """
    proc = await asyncio.create_subprocess_exec(
        FFMPEG_EXE,
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', 'pipe:0',
        '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1',
        'pipe:1',
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    feeder_error: list[BaseException] = []

    async def feed_mp3() -> None:
        try:
            communicate = edge_tts.Communicate(
                text, voice=voice, rate=rate, pitch=pitch, volume=volume,
            )
            async for chunk in communicate.stream():
                if chunk.get('type') == 'audio':
                    data = chunk.get('data')
                    if not data:
                        continue
                    try:
                        proc.stdin.write(data)
                        await proc.stdin.drain()
                    except (ConnectionResetError, BrokenPipeError):
                        return
        except Exception as e:  # noqa: BLE001
            feeder_error.append(e)
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = asyncio.create_task(feed_mp3())

    try:
        if _PREROLL_BYTES:
            yield _PREROLL_BYTES
        while True:
            chunk = await proc.stdout.read(PCM_READ_BYTES)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            await feeder
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        try:
            await proc.wait()
        except Exception:
            pass
        if feeder_error:
            raise feeder_error[0]


def _int16_bytes_to_float32(buf: bytes) -> np.ndarray:
    if not buf:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0


# --- Warmup ------------------------------------------------------------------

RTF_ESTIMATE: float | None = None
WARMUP_OK = False
WARMUP_ERROR: str | None = None


async def _warmup_async() -> None:
    global RTF_ESTIMATE, WARMUP_OK, WARMUP_ERROR
    try:
        print('[edge-tts] warmup short...', flush=True)
        async for _ in _edge_to_pcm_stream('Hola.', DEFAULT_VOICE, DEFAULT_RATE, DEFAULT_PITCH):
            pass
        print('[edge-tts] warmup long (measuring RTF)...', flush=True)
        t0 = time.time()
        total_bytes = 0
        async for chunk in _edge_to_pcm_stream(
            'Hola, soy Yarvis. Esta es una prueba de mi voz para medir el rendimiento del sistema.',
            DEFAULT_VOICE, DEFAULT_RATE, DEFAULT_PITCH,
        ):
            total_bytes += len(chunk)
        gen_s = time.time() - t0
        audio_s = (total_bytes / 2) / SAMPLE_RATE
        if audio_s > 0:
            RTF_ESTIMATE = gen_s / audio_s
        WARMUP_OK = True
        print(
            f'[edge-tts] warmup ok gen={gen_s:.2f}s audio={audio_s:.2f}s rtf={RTF_ESTIMATE:.3f}',
            flush=True,
        )
    except Exception as e:  # noqa: BLE001
        WARMUP_ERROR = repr(e)
        print(f'[edge-tts] warmup failed: {e}', flush=True)


try:
    asyncio.run(_warmup_async())
except RuntimeError:
    pass


# --- API ---------------------------------------------------------------------

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
        'engine': 'edge-tts',
        'voice': DEFAULT_VOICE,
        'rate': DEFAULT_RATE,
        'pitch': DEFAULT_PITCH,
        'volume': DEFAULT_VOLUME,
        'sr': SAMPLE_RATE,
        'jarvis_name_sub': JARVIS_NAME_SUB,
        'rtf_estimate': RTF_ESTIMATE,
        'warmup_ok': WARMUP_OK,
        'warmup_error': WARMUP_ERROR,
        'ffmpeg': FFMPEG_EXE,
    }


def _rate_from_speed(speed: float | None) -> str:
    if speed is None or speed == 1.0:
        return DEFAULT_RATE
    pct = int(round((speed - 1.0) * 100))
    return f'{pct:+d}%'


@app.post('/synthesize')
async def synthesize(req: SynthRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail='empty text')
    text = preprocess_text(text)
    rate = _rate_from_speed(req.speed)
    fx = JarvisStreamFX() if req.fx else None
    chunks: list[np.ndarray] = []
    async for raw in _edge_to_pcm_stream(text, DEFAULT_VOICE, rate, DEFAULT_PITCH):
        arr = _int16_bytes_to_float32(raw)
        if arr.size == 0:
            continue
        if fx is not None:
            arr = fx.process(arr)
        chunks.append(arr)
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
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

    text = preprocess_text(text)
    fx_enabled = bool(params.get('fx', True))
    speed_raw = params.get('speed')
    speed = float(speed_raw) if speed_raw is not None else None
    rate = _rate_from_speed(speed)

    abort = asyncio.Event()

    async def control_loop():
        try:
            while not abort.is_set():
                msg = await ws.receive_json()
                if isinstance(msg, dict) and msg.get('type') == 'abort':
                    abort.set()
                    return
        except Exception:
            abort.set()

    control_task = asyncio.create_task(control_loop())
    fx = JarvisStreamFX() if fx_enabled else None

    # edge-tts hits the MS cloud and occasionally stalls forever. Bound each
    # chunk wait so a hung synthesis fails fast instead of leaving the client
    # WS open and blocking the next turn.
    gen = _edge_to_pcm_stream(text, DEFAULT_VOICE, rate, DEFAULT_PITCH)
    try:
        await ws.send_json({
            'type': 'start',
            'sr': SAMPLE_RATE,
            'channels': 1,
            'encoding': 'float32-le',
        })
        while not abort.is_set():
            try:
                raw = await asyncio.wait_for(gen.__anext__(), timeout=10.0)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                raise RuntimeError('edge_tts_timeout')
            arr = _int16_bytes_to_float32(raw)
            if arr.size == 0:
                continue
            if fx is not None:
                arr = fx.process(arr)
            await ws.send_bytes(arr.astype(np.float32).tobytes())
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
        try:
            await gen.aclose()
        except Exception:
            pass
        control_task.cancel()
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('XTTS_PORT', '8789'))
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='info')
