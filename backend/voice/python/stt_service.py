"""
Local STT service for Jarvis (faster-whisper + Silero VAD + Speaker ID).

Replaces browser Web Speech API with offline speech recognition.
Runs on GPU (CUDA) by default — TTS moved to the cloud edge-tts engine, so the
GPU VRAM is free for whisper. Falls back to CPU/int8 automatically if CUDA is
unavailable. Override with WHISPER_MODEL / WHISPER_DEVICE / WHISPER_COMPUTE.

Endpoints:
  GET  /health              -> { ok, device, model, vad }
  POST /transcribe          -> { text, language, segments[], speaker_confidence }
  WS   /stream              -> real-time PCM streaming with partial transcripts
"""

from __future__ import annotations

import asyncio
import io
import os
import struct
import tempfile
import time
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
SAMPLES_DIR = HERE.parent / "samples"

STT_LANG = os.environ.get("STT_LANG", "es")
SAMPLE_RATE = 16000

# Whisper's internal language model "corrects" rare/technical words into more
# common phrases ("teseracto" -> "tercer acto", "polítopo" -> "político", ...).
# We bias the beam search back toward our domain vocabulary by feeding these as
# hotwords. Add terms (comma- or space-separated) via STT_HOTWORDS; set it empty
# to disable the bias entirely.
_DEFAULT_HOTWORDS = (
    "teseracto, polítopo, politopo, hipercubo, Fermi, superficie de Fermi, "
    "paramétrica, implícita, Jarvis, Obsidian, Tailscale, Syncthing"
)
STT_HOTWORDS = os.environ.get("STT_HOTWORDS", _DEFAULT_HOTWORDS).strip() or None


def _pick_device() -> tuple[str, str]:
    """Prefer CUDA GPU (TTS no longer uses it); fall back to CPU/int8."""
    env_device = os.environ.get("WHISPER_DEVICE")
    env_compute = os.environ.get("WHISPER_COMPUTE")
    if env_device:
        return env_device, (env_compute or ("float16" if env_device == "cuda" else "int8"))
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", (env_compute or "float16")
    except Exception:
        pass
    return "cpu", (env_compute or "int8")


WHISPER_DEVICE, WHISPER_COMPUTE = _pick_device()
# large-v3-turbo on GPU: distilled (~6x faster than large-v3), high accuracy,
# ~1.6 GB VRAM (fits the 4 GB RTX 3050). On CPU fallback, drop to "small".
_DEFAULT_MODEL = "large-v3-turbo" if WHISPER_DEVICE == "cuda" else "small"
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", _DEFAULT_MODEL)

# --- Model Loading -----------------------------------------------------------

print(f"[stt] loading faster-whisper model={WHISPER_MODEL} device={WHISPER_DEVICE} compute={WHISPER_COMPUTE}", flush=True)

from faster_whisper import WhisperModel  # noqa: E402

try:
    whisper_model = WhisperModel(
        WHISPER_MODEL,
        device=WHISPER_DEVICE,
        compute_type=WHISPER_COMPUTE,
    )
except Exception as e:
    # GPU load failed (driver/VRAM) — fall back to CPU so STT still works.
    print(f"[stt] GPU load failed ({e}); falling back to CPU/int8 small", flush=True)
    WHISPER_DEVICE, WHISPER_COMPUTE = "cpu", "int8"
    WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
    whisper_model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
print(f"[stt] whisper model loaded (device={WHISPER_DEVICE} compute={WHISPER_COMPUTE} model={WHISPER_MODEL})", flush=True)

# --- Silero VAD ---------------------------------------------------------------

print("[stt] loading Silero VAD...", flush=True)
vad_model, vad_utils = torch.hub.load(
    repo_or_dir="snakers4/silero-vad",
    model="silero_vad",
    force_reload=False,
    onnx=True,
    trust_repo=True,
)
(get_speech_timestamps, _, read_audio, _, _) = vad_utils
print("[stt] VAD ready", flush=True)

# --- Speaker ID ---------------------------------------------------------------

SPEAKER_SAMPLES_DIR = Path(os.environ.get("SPEAKER_SAMPLES_DIR", str(SAMPLES_DIR / "speaker")))
SPEAKER_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
print(f"[stt] speaker samples dir: {SPEAKER_SAMPLES_DIR}", flush=True)

speaker_id: Optional[object] = None


def _init_speaker_id():
    global speaker_id
    from speaker_id import SpeakerIdentifier
    speaker_id = SpeakerIdentifier(SPEAKER_SAMPLES_DIR)


try:
    _init_speaker_id()
    print(
        f"[stt] speaker ID ready (speakers={list(speaker_id.speakers.keys())})",
        flush=True,
    )
except Exception as e:
    speaker_id = None
    print(f"[stt] speaker ID unavailable: {e}", flush=True)

# --- API ----------------------------------------------------------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "ok": True,
        "device": WHISPER_DEVICE,
        "model": WHISPER_MODEL,
        "compute": WHISPER_COMPUTE,
        "vad": True,
        "speaker_id": speaker_id is not None,
        "sample_rate": SAMPLE_RATE,
    }


# --- Speaker ID Management Endpoints -----------------------------------------


@app.get("/speaker-id/status")
def speaker_id_status():
    if speaker_id is None:
        return {"ready": False, "speakers": [], "samples_dir": str(SPEAKER_SAMPLES_DIR)}
    return {
        "ready": True,
        "speakers": speaker_id.list_speakers(),
        "samples_dir": str(SPEAKER_SAMPLES_DIR),
    }


@app.post("/speaker-id/reload")
def speaker_id_reload():
    global speaker_id
    try:
        _init_speaker_id()
        return {
            "ok": True,
            "speakers": speaker_id.list_speakers(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


class ThresholdRequest(BaseModel):
    name: str
    threshold: float


@app.put("/speaker-id/threshold")
def speaker_id_set_threshold(req: ThresholdRequest):
    if speaker_id is None:
        raise HTTPException(status_code=503, detail="speaker_id not initialized")
    if req.threshold < 0.50 or req.threshold > 0.95:
        raise HTTPException(status_code=400, detail="threshold must be 0.50-0.95")
    from speaker_id import _safe_name
    name = _safe_name(req.name)
    if not name:
        raise HTTPException(status_code=400, detail="invalid name")
    exists = speaker_id.set_threshold(name, req.threshold)
    return {"ok": True, "name": name, "threshold": req.threshold, "exists": exists}


# --- Multi-speaker management -----------------------------------------------


class SpeakerCreateRequest(BaseModel):
    name: str


@app.get("/speaker-id/speakers")
def speaker_list():
    if speaker_id is None:
        return {"speakers": []}
    return {"speakers": speaker_id.list_speakers()}


@app.post("/speaker-id/speakers")
def speaker_create(req: SpeakerCreateRequest):
    from speaker_id import _safe_name
    name = _safe_name(req.name)
    if not name:
        raise HTTPException(status_code=400, detail="invalid name")
    target = SPEAKER_SAMPLES_DIR / name
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "name": name}


@app.delete("/speaker-id/speakers/{name}")
def speaker_delete(name: str):
    from speaker_id import _safe_name
    safe = _safe_name(name)
    if not safe:
        raise HTTPException(status_code=400, detail="invalid name")
    if speaker_id is not None:
        speaker_id.remove_speaker(safe)
    else:
        target = SPEAKER_SAMPLES_DIR / safe
        if target.exists():
            import shutil as _sh
            try:
                _sh.rmtree(target)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "name": safe}


@app.post("/speaker-id/speakers/{name}/reload")
def speaker_reload_single(name: str):
    if speaker_id is None:
        raise HTTPException(status_code=503, detail="speaker_id not initialized")
    from speaker_id import _safe_name
    safe = _safe_name(name)
    loaded = speaker_id.enroll_speaker(safe)
    return {"ok": True, "loaded": loaded, "speakers": speaker_id.list_speakers()}


# --- Transcription Endpoints -------------------------------------------------


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = STT_LANG,
):
    """Transcribe an uploaded audio file (WAV/WebM/raw PCM 16kHz mono)."""
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio")

    # Write to temp file for faster-whisper (expects file path)
    suffix = ".wav" if audio.content_type and "wav" in audio.content_type else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        segments_iter, info = whisper_model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            hotwords=STT_HOTWORDS,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
            ),
        )
        segments = []
        full_text = ""
        for seg in segments_iter:
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
            })
            full_text += seg.text

        # Speaker identification
        spk_name = None
        spk_confidence = 0.0
        if speaker_id is not None:
            try:
                spk_name, spk_confidence = speaker_id.identify_file(tmp_path)
            except Exception:
                pass

        return {
            "text": full_text.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "segments": segments,
            "speaker_name": spk_name,
            "speaker_confidence": spk_confidence,
        }
    finally:
        os.unlink(tmp_path)


# --- WebSocket Streaming STT --------------------------------------------------

class StreamState:
    """Manages state for a single WebSocket streaming session."""

    def __init__(self):
        self.audio_buffer = bytearray()
        self.vad_buffer = np.array([], dtype=np.float32)
        self.is_speaking = False
        self.speech_start_time = 0.0
        self.silence_frames = 0
        self.last_transcript = ""
        # 480 samples = 30ms at 16kHz (Silero VAD window)
        self.vad_chunk_size = 512
        # After this many silent VAD chunks, finalize (chunk=512smp@16k=32ms).
        # 38 -> ~1216ms: wide enough that a slightly longer mid-thought pause
        # doesn't cut the user off when they resume. Was 22 (~704ms); the +0.5s
        # trades a touch of latency for not clipping. Override with
        # STT_SILENCE_CHUNKS. Barge-in (frontend) lets the user cut a reply
        # short, which compensates for the wider window.
        self.max_silence_chunks = int(os.environ.get("STT_SILENCE_CHUNKS", "38"))
        # Speculative transcription: fire a snapshot transcription this many
        # chunks BEFORE the final threshold, during the silence tail, so its
        # ~0.3-0.5s cost overlaps the wait instead of adding to it. By default
        # the snapshot fires at ~22 chunks (the old final point), turning the
        # +0.5s we added into "free" time. Disable with STT_SPECULATIVE=0.
        self.speculative_enabled = os.environ.get("STT_SPECULATIVE", "1") != "0"
        lead = int(os.environ.get("STT_SPECULATIVE_LEAD", "16"))
        self.speculative_threshold = max(1, self.max_silence_chunks - lead)
        # spec_fired stays True only while the latest snapshot is still valid
        # (no speech resumed after it). Speech resuming flips it back off so the
        # final won't reuse a stale snapshot.
        self.spec_fired = False

    def add_audio(self, pcm_bytes: bytes):
        """Add PCM bytes. Returns (event, audio):
          ('spec', snapshot)  -> at speculative_threshold; buffer NOT cleared.
          ('final', segment)  -> at max_silence_chunks; buffer cleared. Reuse the
                                 speculative result iff self.spec_fired is True.
          (None, None)        -> nothing to do.
        """
        self.audio_buffer.extend(pcm_bytes)

        # Convert new bytes to float32 for VAD
        new_samples = np.frombuffer(pcm_bytes, dtype=np.float32)
        self.vad_buffer = np.concatenate([self.vad_buffer, new_samples])

        # Process VAD in chunks
        while len(self.vad_buffer) >= self.vad_chunk_size:
            chunk = self.vad_buffer[: self.vad_chunk_size]
            self.vad_buffer = self.vad_buffer[self.vad_chunk_size:]

            chunk_tensor = torch.from_numpy(chunk.copy())
            speech_prob = vad_model(chunk_tensor, SAMPLE_RATE).item()

            if speech_prob > 0.5:
                if not self.is_speaking:
                    self.is_speaking = True
                    self.speech_start_time = time.time()
                self.silence_frames = 0
                # Speech resumed after a speculative snapshot -> snapshot is now
                # stale; allow a fresh one to fire on the next silence tail.
                if self.spec_fired:
                    self.spec_fired = False
            elif self.is_speaking:
                self.silence_frames += 1
                if (self.speculative_enabled and not self.spec_fired
                        and self.silence_frames >= self.speculative_threshold
                        and self.silence_frames < self.max_silence_chunks):
                    # Snapshot the speech so far without clearing or ending the
                    # turn; if the user stays silent we reuse this at final.
                    self.spec_fired = True
                    snapshot = np.frombuffer(bytes(self.audio_buffer), dtype=np.float32)
                    return ("spec", snapshot)
                if self.silence_frames >= self.max_silence_chunks:
                    finalized_audio = np.frombuffer(
                        bytes(self.audio_buffer), dtype=np.float32
                    )
                    self.audio_buffer.clear()
                    self.is_speaking = False
                    self.silence_frames = 0
                    return ("final", finalized_audio)

        return (None, None)


@app.websocket("/stream")
async def stream_stt(ws: WebSocket):
    """
    Real-time streaming STT over WebSocket.

    Client sends: binary frames of Float32 PCM @ 16kHz mono
    Server sends: JSON messages { text, isFinal, speakerConfidence }
    """
    await ws.accept()
    state = StreamState()
    spec_task: Optional[asyncio.Task] = None

    def _abandon(task: Optional[asyncio.Task]):
        # Drop a stale speculative task without raising "exception never
        # retrieved". The underlying thread can't be interrupted, but its result
        # is simply ignored.
        if task is None:
            return
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    try:
        while True:
            data = await ws.receive_bytes()

            event, audio = state.add_audio(data)

            if event == "spec":
                if audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                    # Kick off transcription during the silence tail so it's
                    # likely done by the time we finalize.
                    _abandon(spec_task)
                    spec_task = asyncio.create_task(
                        asyncio.to_thread(_transcribe_segment, audio)
                    )
                continue

            if event == "final" and audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                result = None
                # Reuse the speculative result iff it's still valid (no speech
                # resumed after the snapshot — tracked by state.spec_fired).
                if spec_task is not None and state.spec_fired:
                    try:
                        result = await spec_task
                    except Exception:
                        result = None
                else:
                    _abandon(spec_task)
                spec_task = None

                if result is None:
                    result = await asyncio.to_thread(_transcribe_segment, audio)

                transcript, spk_conf, spk_name = result
                if transcript.strip():
                    await ws.send_json({
                        "text": transcript.strip(),
                        "isFinal": True,
                        "speakerName": spk_name,
                        "speakerConfidence": spk_conf,
                    })
            elif event == "final":
                # Segment too short to transcribe — drop any pending snapshot.
                _abandon(spec_task)
                spec_task = None

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"error": str(e)})
        except Exception:
            pass
    finally:
        _abandon(spec_task)


def _transcribe_segment(audio: np.ndarray) -> tuple[str, float, Optional[str]]:
    """Transcribe a numpy audio segment. Returns (text, speaker_confidence, speaker_name)."""
    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, audio, SAMPLE_RATE, format="WAV")
        tmp_path = tmp.name

    try:
        segments_iter, info = whisper_model.transcribe(
            tmp_path,
            language=STT_LANG,
            beam_size=3,
            best_of=1,
            hotwords=STT_HOTWORDS,
            without_timestamps=True,
            # Anti-hallucination: Whisper invents "Gracias" / "Gracias por ver
            # el video" on silence/noise. Disable cross-segment priming, force
            # greedy, and drop low-confidence / high-no-speech segments.
            condition_on_previous_text=False,
            temperature=0.0,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
            vad_filter=True,
        )
        kept = []
        for seg in segments_iter:
            if getattr(seg, "no_speech_prob", 0.0) > 0.6:
                continue
            if getattr(seg, "avg_logprob", 0.0) < -1.0:
                continue
            kept.append(seg.text.strip())
        text = " ".join(t for t in kept if t)

        spk_name = None
        spk_conf = 0.0
        if speaker_id is not None:
            try:
                spk_name, spk_conf = speaker_id.identify_audio(audio, SAMPLE_RATE)
            except Exception:
                pass

        return text, spk_conf, spk_name
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STT_PORT", "8790"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
