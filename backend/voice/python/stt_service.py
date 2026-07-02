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
import json
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

# Segment-drop thresholds (anti-hallucination). Loosened from the strict
# 0.6 / -1.0 so quiet / distant / accented real speech isn't discarded with the
# noise. large-v3-turbo's logprobs run higher than small's, so the looser floor
# rarely lets hallucinations through. Tighten via env if junk reappears.
NO_SPEECH_THRESHOLD = float(os.environ.get("STT_NO_SPEECH", "0.7"))
AVG_LOGPROB_MIN = float(os.environ.get("STT_LOGPROB_MIN", "-1.2"))

# Decoding bias: comma-separated terms Whisper should prefer. Names/commands
# that get castellanized otherwise. Override/extend with STT_HOTWORDS.
STT_HOTWORDS = os.environ.get(
    "STT_HOTWORDS",
    "Jarvis, Santiago, señor, Brave, Obsidian, Hyprland, Firefox, Spotify, "
    "Telegram, Kitty, temporizador, cronómetro, recordatorio, plano, casa, "
    "nube, sistema, Bluetooth, volumen, navega, abre, cierra",
)

# Stylistic priming so Whisper decodes in Colombian Spanish register with the
# domain vocabulary. initial_prompt biases ORTHOGRAPHY/STYLE (not a hard
# constraint like hotwords) — a natural sentence works better than a word list.
# Override with STT_INITIAL_PROMPT; set empty to disable.
STT_INITIAL_PROMPT = os.environ.get(
    "STT_INITIAL_PROMPT",
    "Conversación en español con Jarvis, el asistente personal de Santiago. "
    "Comandos por voz: abre el plano, pon un temporizador, navega a la casa, "
    "sube el volumen, muéstrame el sistema.",
)

# Noise suppression mode (STT_DENOISE_MODE):
#   highpass  (default) — gentle 90 Hz high-pass only. Kills rumble/HVAC without
#               distorting speech. SAFEST for ASR: the old aggressive
#               noisereduce non-stationary gate introduced spectral artifacts
#               that made Whisper mishear near-field speech.
#   deepfilter — DeepFilterNet neural denoiser (best quality, ASR-tuned). Needs
#               `pip install deepfilternet`. Falls back to highpass if missing.
#   spectral   — legacy noisereduce non-stationary (kept for A/B testing only).
#   off        — no denoise at all (trust PipeWire AEC + the RMS gate).
# Legacy STT_DENOISE=0 still forces off.
_DENOISE_OFF = os.environ.get("STT_DENOISE", "1") == "0"
DENOISE_MODE = "off" if _DENOISE_OFF else os.environ.get("STT_DENOISE_MODE", "highpass")
# Reject segments quieter than this RMS (full-scale float [-1,1]) — room noise,
# fans, distant TV with no real near-field speech. Lowered 0.012 -> 0.008 so soft
# or slightly-distant real speech isn't dropped wholesale; the no_speech / logprob
# gates still catch true silence. Tune up if junk reappears (env STT_MIN_RMS).
MIN_RMS = float(os.environ.get("STT_MIN_RMS", "0.008"))

# VAD endpointing with hysteresis (#9): enter speech at a higher prob, stay in
# speech until it drops below a LOWER prob. A single fixed 0.5 gate clipped soft
# trailing syllables (prob dips mid-word -> premature silence count). Separate
# on/off thresholds keep a started utterance alive through brief dips. Override
# with STT_VAD_ON / STT_VAD_OFF.
VAD_ON = float(os.environ.get("STT_VAD_ON", "0.5"))
VAD_OFF = float(os.environ.get("STT_VAD_OFF", "0.35"))

# Within-utterance priming (#10): condition later internal segments of the SAME
# finalized utterance on its earlier text for coherence. Safe because each
# transcribe() call is one endpointed turn — faster-whisper resets priming
# between separate calls, so cross-turn "Gracias" hallucination can't return.
CONDITION_PREV = os.environ.get("STT_CONDITION_PREV", "1") != "0"

_df_state = None  # lazily-initialized DeepFilterNet (model, df_state) tuple


def _highpass(audio: np.ndarray) -> np.ndarray:
    """90 Hz high-pass: kills rumble/HVAC, leaves speech untouched. No model."""
    try:
        from scipy.signal import butter, sosfilt
        sos = butter(4, 90.0, btype="highpass", fs=SAMPLE_RATE, output="sos")
        return sosfilt(sos, audio).astype(np.float32, copy=False)
    except Exception:
        return audio


def _df_torchaudio_shim() -> None:
    """deepfilternet 0.5.x imports AudioMetaData from torchaudio.backend.common,
    a module removed in torchaudio >= 2.2. Recreate it as an alias so df loads."""
    import sys, types
    if "torchaudio.backend.common" in sys.modules:
        return
    import torchaudio
    meta = getattr(torchaudio, "AudioMetaData", None)
    if meta is None:
        class meta:  # noqa: N801 — df only uses this as a type annotation
            pass
    backend = sys.modules.get("torchaudio.backend") or types.ModuleType("torchaudio.backend")
    common = types.ModuleType("torchaudio.backend.common")
    common.AudioMetaData = meta
    backend.common = common
    sys.modules["torchaudio.backend"] = backend
    sys.modules["torchaudio.backend.common"] = common


def _deepfilter(audio: np.ndarray) -> np.ndarray:
    """DeepFilterNet neural denoise. Lazy-loads the model once; falls back to a
    high-pass if deepfilternet isn't installed or any step fails."""
    global _df_state
    try:
        if _df_state is None:
            _df_torchaudio_shim()
            from df.enhance import init_df  # type: ignore
            model, df_state, _ = init_df(log_level="warning")
            _df_state = (model, df_state)
        from df.enhance import enhance  # type: ignore
        import torch as _torch
        import torchaudio.functional as _AF
        model, df_state = _df_state
        df_sr = df_state.sr()
        x = _torch.from_numpy(audio).unsqueeze(0)
        if df_sr != SAMPLE_RATE:
            x = _AF.resample(x, SAMPLE_RATE, df_sr)
        out = enhance(model, df_state, x)
        if df_sr != SAMPLE_RATE:
            out = _AF.resample(out, df_sr, SAMPLE_RATE)
        return out.squeeze(0).cpu().numpy().astype(np.float32, copy=False)
    except Exception as e:
        print(f"[stt] deepfilter unavailable ({e}); using high-pass", flush=True)
        return _highpass(audio)


def _denoise(audio: np.ndarray) -> np.ndarray:
    """Denoise a float32 segment per DENOISE_MODE. Never raises — returns input
    (or a high-pass of it) on any failure."""
    if DENOISE_MODE == "off" or audio is None or len(audio) == 0:
        return audio
    if DENOISE_MODE == "deepfilter":
        return _deepfilter(audio)
    if DENOISE_MODE == "spectral":
        try:
            import noisereduce as nr
            out = nr.reduce_noise(y=audio, sr=SAMPLE_RATE, stationary=False)
            return out.astype(np.float32, copy=False)
        except Exception:
            return _highpass(audio)
    # default: highpass
    return _highpass(audio)


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
# large-v3 (full, NOT turbo) on GPU: best multilingual/Spanish accuracy — turbo
# is distilled and castellanizes/mishears Spanish more. ~3 GB VRAM float16,
# which fits the 4 GB RTX 3050 now that TTS is on the cloud and speaker-id runs
# on CPU (SPEAKER_ID_DEVICE=cpu). Slower per decode than turbo, but the
# speculative-transcription path hides most of it. Fall back to turbo on OOM,
# then CPU/small as a last resort. Override the default with WHISPER_MODEL.
_DEFAULT_MODEL = "large-v3" if WHISPER_DEVICE == "cuda" else "small"
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", _DEFAULT_MODEL)

# --- Model Loading -----------------------------------------------------------

print(f"[stt] loading faster-whisper model={WHISPER_MODEL} device={WHISPER_DEVICE} compute={WHISPER_COMPUTE}", flush=True)

from faster_whisper import WhisperModel  # noqa: E402


def _load_whisper(model: str, device: str, compute: str) -> "WhisperModel":
    return WhisperModel(model, device=device, compute_type=compute)


try:
    whisper_model = _load_whisper(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
except Exception as e:
    # large-v3 didn't fit (OOM) or failed to load. If we're on GPU and the user
    # didn't pin a model, step down to turbo (~1.6 GB) before abandoning the GPU.
    if WHISPER_DEVICE == "cuda" and "WHISPER_MODEL" not in os.environ and WHISPER_MODEL != "large-v3-turbo":
        print(f"[stt] large-v3 load failed ({e}); retrying with large-v3-turbo", flush=True)
        try:
            WHISPER_MODEL = "large-v3-turbo"
            whisper_model = _load_whisper(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
        except Exception as e2:
            print(f"[stt] turbo load failed ({e2}); falling back to CPU/int8 small", flush=True)
            WHISPER_DEVICE, WHISPER_COMPUTE, WHISPER_MODEL = "cpu", "int8", "small"
            whisper_model = _load_whisper(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
    else:
        # GPU load failed (driver/VRAM) — fall back to CPU so STT still works.
        print(f"[stt] GPU load failed ({e}); falling back to CPU/int8 small", flush=True)
        WHISPER_DEVICE, WHISPER_COMPUTE = "cpu", "int8"
        WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
        whisper_model = _load_whisper(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
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

OWNER_VOICEPRINT_ENC = HERE / "owner_voiceprint.enc"
OWNER_SPEAKER_NAME = os.environ.get("JARVIS_OWNER_SPEAKER", "owner")

# Anti-speaker-ID: speakers enrolled purely so Jarvis's own TTS voice is
# recognized and rejected (never treated as the owner). When identification
# lands on one of these, confidence is forced to 0 so the frontend drops it.
NEGATIVE_SPEAKERS = {
    s.strip() for s in os.environ.get("JARVIS_NEGATIVE_SPEAKERS", "").split(",") if s.strip()
}
# Online owner-voice learning: append accepted high-confidence owner utterances
# as new references so recognition adapts. Disable with JARVIS_VOICE_LEARNING=0.
# The confidence bar is encoder-scaled (cosine scores differ per encoder):
# resemblyzer ~0.82, ECAPA ~0.65. Resolved after speaker-id init; env overrides.
VOICE_LEARNING = os.environ.get("JARVIS_VOICE_LEARNING", "1") != "0"
_LEARN_THRESHOLD_BY_ENCODER = {"resemblyzer": 0.82, "ecapa": 0.65}
LEARN_THRESHOLD = float(os.environ.get("JARVIS_LEARN_THRESHOLD", "0.82"))

speaker_id: Optional[object] = None


def _get_machine_key() -> bytes:
    """Get the Linux machine key from Secret Service or fallback file."""
    import subprocess as _sp
    try:
        r = _sp.run(
            ["secret-tool", "lookup", "service", "jarvis-linux", "account", "machine-key"],
            capture_output=True, text=True, timeout=5,
        )
        hex_key = r.stdout.strip()
        if len(hex_key) == 64:
            return bytes.fromhex(hex_key)
    except Exception:
        pass
    fallback = Path.home() / ".config" / "jarvis" / "machine.key"
    if fallback.exists():
        hex_key = fallback.read_text().strip()
        if len(hex_key) == 64:
            return bytes.fromhex(hex_key)
    raise RuntimeError("Machine key not found (secret-tool and fallback file both unavailable)")


def _load_owner_voiceprint(si) -> bool:
    """Decrypt owner_voiceprint.enc and inject embeddings into SpeakerIdentifier."""
    if not OWNER_VOICEPRINT_ENC.exists():
        return False
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
        key = _get_machine_key()
        blob = OWNER_VOICEPRINT_ENC.read_bytes()
        iv, tag, ct = blob[:12], blob[-16:], blob[12:-16]
        cipher = Cipher(algorithms.AES(key), modes.GCM(iv, tag), backend=default_backend())
        d = cipher.decryptor()
        pt = d.update(ct) + d.finalize()
        data = json.loads(pt)
        embeddings = data.get("embeddings", [])
        threshold = data.get("threshold")
        threshold = float(threshold) if threshold is not None else None
        if not embeddings:
            return False
        vp_encoder = data.get("encoder", "resemblyzer")
        if vp_encoder != si.encoder.name:
            print(
                f"[stt] owner voiceprint was generated with '{vp_encoder}' but the "
                f"active encoder is '{si.encoder.name}' — regenerate it with "
                "scripts/create-voiceprint.sh (falling back to WAV samples)",
                flush=True,
            )
            return False
        si.inject_speaker(OWNER_SPEAKER_NAME, embeddings, threshold)
        print(
            f"[stt] owner voiceprint loaded: {len(embeddings)} embeddings "
            f"for '{OWNER_SPEAKER_NAME}' (threshold={threshold})",
            flush=True,
        )
        return True
    except Exception as e:
        print(f"[stt] failed to load owner voiceprint: {e}", flush=True)
        return False


def _init_speaker_id():
    global speaker_id
    from speaker_id import SpeakerIdentifier
    si = SpeakerIdentifier(SPEAKER_SAMPLES_DIR)
    # Always inject the encrypted owner voiceprint (merges with WAV samples if any).
    _load_owner_voiceprint(si)
    if not si.speakers:
        raise FileNotFoundError(
            f"No speaker samples found under {SPEAKER_SAMPLES_DIR} "
            "and no owner_voiceprint.enc available"
        )
    speaker_id = si


try:
    _init_speaker_id()
    if "JARVIS_LEARN_THRESHOLD" not in os.environ:
        LEARN_THRESHOLD = _LEARN_THRESHOLD_BY_ENCODER.get(
            speaker_id.encoder.name, LEARN_THRESHOLD
        )
    print(
        f"[stt] speaker ID ready (encoder={speaker_id.encoder.name} "
        f"speakers={list(speaker_id.speakers.keys())} learn_thr={LEARN_THRESHOLD})",
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
        "speaker_encoder": getattr(getattr(speaker_id, "encoder", None), "name", None),
        "denoise_mode": DENOISE_MODE,
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
    # ECAPA cosine scores run lower than resemblyzer's, so the floor is 0.30.
    if req.threshold < 0.30 or req.threshold > 0.95:
        raise HTTPException(status_code=400, detail="threshold must be 0.30-0.95")
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
            beam_size=int(os.environ.get("STT_BEAM_SIZE", "5")),
            temperature=(
                [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
                if os.environ.get("STT_TEMP_FALLBACK", "1") != "0"
                else 0.0
            ),
            hotwords=STT_HOTWORDS or None,
            initial_prompt=STT_INITIAL_PROMPT or None,
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
        # Same-turn speaker context (#7): tail of the previous finalized segment,
        # pooled with the next short segment so its speaker embedding stabilizes.
        self.spk_prev_audio: Optional[np.ndarray] = None
        self.spk_prev_time = 0.0
        self.spk_context_max_s = 5.0
        self.spk_context_ttl_s = float(os.environ.get("STT_SPK_CONTEXT_TTL", "12"))

    def spk_context(self) -> Optional[np.ndarray]:
        """Previous same-turn audio, or None if it's gone stale."""
        if self.spk_prev_audio is None:
            return None
        if time.time() - self.spk_prev_time > self.spk_context_ttl_s:
            self.spk_prev_audio = None
            return None
        return self.spk_prev_audio

    def remember_spk_audio(self, audio: np.ndarray) -> None:
        tail = audio[-int(self.spk_context_max_s * SAMPLE_RATE):]
        self.spk_prev_audio = np.array(tail, dtype=np.float32)
        self.spk_prev_time = time.time()

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

            # Hysteresis: once speaking, require the prob to fall below VAD_OFF
            # (not just VAD_ON) to count as silence — keeps soft trailing
            # syllables from being clipped by a brief mid-word dip.
            gate = VAD_OFF if self.is_speaking else VAD_ON
            if speech_prob > gate:
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

    def flush(self) -> Optional[np.ndarray]:
        """Force-finalize whatever is buffered, ignoring the silence gate.

        Called on PTT release: the user stopped holding the key, so the mic
        stops sending audio and the silence-tail finalize would never fire.
        Returns the buffered audio (or None if empty) and resets state.
        """
        if not self.audio_buffer:
            return None
        audio = np.frombuffer(bytes(self.audio_buffer), dtype=np.float32)
        self.audio_buffer.clear()
        self.vad_buffer = np.array([], dtype=np.float32)
        self.is_speaking = False
        self.silence_frames = 0
        self.spec_fired = False
        return audio


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

    async def _finalize(audio: np.ndarray, *, reuse_spec: bool):
        """Transcribe a finalized segment and send the result to the client."""
        nonlocal spec_task
        result = None
        # Reuse the speculative result iff it's still valid (no speech resumed
        # after the snapshot — tracked by state.spec_fired). Flush never reuses.
        if reuse_spec and spec_task is not None and state.spec_fired:
            try:
                result = await spec_task
            except Exception:
                result = None
        else:
            _abandon(spec_task)
        spec_task = None

        if result is None:
            try:
                result = await asyncio.to_thread(
                    _transcribe_segment, audio, state.spk_context()
                )
            except Exception as e:
                # One bad segment (transcription / speaker-id error) must not
                # tear down the whole stream — log and keep listening.
                print(f"[stt] transcribe error (skipping segment): {e}", flush=True)
                return

        # Remember this segment's raw tail for pooling with the next short
        # segment of the same turn (only if it produced real speech).
        if result["text"].strip():
            state.remember_spk_audio(audio)

        transcript = result["text"]
        spk_conf = result["spk_conf"]
        spk_name = result["spk_name"]
        avg_logprob = result.get("avg_logprob", 0.0)
        word_conf = result.get("word_conf", 0.0)
        if transcript.strip():
            print(
                f"[stt] transcript: '{transcript.strip()}' speaker={spk_name} "
                f"conf={spk_conf:.3f} logprob={avg_logprob:.2f} wconf={word_conf:.2f}",
                flush=True,
            )
            await ws.send_json({
                "text": transcript.strip(),
                "isFinal": True,
                "speakerName": spk_name,
                "speakerConfidence": spk_conf,
                "avgLogprob": avg_logprob,
                "confidence": word_conf,
            })

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is not None:
                event, audio = state.add_audio(data)

                if event == "spec":
                    if audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                        # Kick off transcription during the silence tail so it's
                        # likely done by the time we finalize.
                        _abandon(spec_task)
                        spec_task = asyncio.create_task(
                            asyncio.to_thread(_transcribe_segment, audio, state.spk_context())
                        )
                    continue

                if event == "final" and audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                    await _finalize(audio, reuse_spec=True)
                elif event == "final":
                    # Segment too short to transcribe — drop any pending snapshot.
                    _abandon(spec_task)
                    spec_task = None
                continue

            text = message.get("text")
            if text is not None:
                # Control frame. PTT release sends {"type":"flush"} so the
                # buffered utterance is transcribed immediately instead of being
                # dropped when the client closes the socket.
                try:
                    ctrl = json.loads(text)
                except Exception:
                    continue
                if ctrl.get("type") == "flush":
                    audio = state.flush()
                    if audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                        await _finalize(audio, reuse_spec=False)
                    else:
                        _abandon(spec_task)
                        spec_task = None

    except WebSocketDisconnect:
        pass
    except Exception as e:
        import traceback
        print(f"[stt] stream error: {e}\n{traceback.format_exc()}", flush=True)
        try:
            await ws.send_json({"error": str(e)})
        except Exception:
            pass
    finally:
        _abandon(spec_task)


def _identify_speaker(audio: np.ndarray, spk_context: Optional[np.ndarray]) -> tuple:
    """Speaker-id on the RAW segment, optionally re-tried on the concatenation
    with the previous same-turn audio (#7): short utterances ("sí", "apaga la
    luz") give noisy embeddings on their own — pooling with the turn's earlier
    audio stabilizes them. The higher-confidence result wins, so a bad context
    can never make things worse than the solo identification.
    """
    spk_name, spk_conf = speaker_id.identify_audio(audio, SAMPLE_RATE)
    if spk_context is not None and len(spk_context) > 0:
        try:
            pooled = np.concatenate([spk_context, audio])
            ctx_name, ctx_conf = speaker_id.identify_audio(pooled, SAMPLE_RATE)
            if ctx_name is not None and ctx_conf > spk_conf:
                return ctx_name, ctx_conf
        except Exception:
            pass
    return spk_name, spk_conf


def _transcribe_segment(audio: np.ndarray, spk_context: Optional[np.ndarray] = None) -> dict:
    """Transcribe a numpy audio segment.

    Returns a dict: { text, spk_conf, spk_name, avg_logprob, word_conf }.
    avg_logprob/word_conf are the doubt signals consumed by the backend LLM
    correction layer (#11).
    """
    import soundfile as sf

    # Bifurcated audio paths: whisper gets the denoised signal (ASR likes clean
    # audio), speaker-id gets the RAW signal — neural denoising reshapes the
    # spectrum enough to shift voice embeddings, and enrollment was done on raw
    # audio, so denoise-before-embed degrades identification.
    audio_raw = audio
    audio = _denoise(audio)

    # Energy gate: a segment quieter than MIN_RMS is room noise, not speech.
    # Drop it outright — never transcribe, never run speaker-id (which would
    # otherwise hand back a spurious high confidence on pure noise). Gate on the
    # raw signal so an aggressive denoiser can't shrink real speech below it.
    rms = float(np.sqrt(np.mean(np.square(audio_raw)))) if len(audio_raw) else 0.0
    if rms < MIN_RMS:
        print(f"[stt] dropped low-energy segment (rms={rms:.4f} < {MIN_RMS})", flush=True)
        return {"text": "", "spk_conf": 0.0, "spk_name": None, "avg_logprob": 0.0, "word_conf": 0.0}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, audio, SAMPLE_RATE, format="WAV")
        tmp_path = tmp.name

    try:
        segments_iter, info = whisper_model.transcribe(
            tmp_path,
            language=STT_LANG,
            # beam=5/best_of=5 matches the /transcribe path: the voice (stream)
            # path was the LOWEST-quality decode at beam=3. More accuracy, tiny
            # GPU cost. Override with STT_BEAM_SIZE.
            beam_size=int(os.environ.get("STT_BEAM_SIZE", "5")),
            best_of=int(os.environ.get("STT_BEAM_SIZE", "5")),
            # Word-level timestamps (#12) so we can derive a per-word confidence
            # for the doubt signal that gates the LLM correction layer (#11).
            word_timestamps=True,
            # Within-utterance priming (#10): coherence across this turn's
            # internal segments. Per-turn only — see CONDITION_PREV comment.
            condition_on_previous_text=CONDITION_PREV,
            # Temperature fallback: when a greedy/beam decode fails the quality
            # gates (avg_logprob / compression_ratio), Whisper retries hotter
            # instead of keeping the bad result. The gates below still drop true
            # junk, so this recovers garbled real speech without re-opening
            # hallucination. Disable by setting STT_TEMP_FALLBACK=0.
            temperature=(
                [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
                if os.environ.get("STT_TEMP_FALLBACK", "1") != "0"
                else 0.0
            ),
            no_speech_threshold=NO_SPEECH_THRESHOLD,
            compression_ratio_threshold=2.4,
            log_prob_threshold=AVG_LOGPROB_MIN,
            vad_filter=True,
            # Bias decoding toward Jarvis-specific vocabulary so names/commands
            # (Jarvis, Brave, etc.) aren't castellanized or misheard.
            hotwords=STT_HOTWORDS or None,
            # Colombian-Spanish + domain priming for orthography/style.
            initial_prompt=STT_INITIAL_PROMPT or None,
        )
        kept = []
        logprobs = []
        word_probs = []
        for seg in segments_iter:
            if getattr(seg, "no_speech_prob", 0.0) > NO_SPEECH_THRESHOLD:
                continue
            if getattr(seg, "avg_logprob", 0.0) < AVG_LOGPROB_MIN:
                continue
            kept.append(seg.text.strip())
            logprobs.append(float(getattr(seg, "avg_logprob", 0.0)))
            for w in (getattr(seg, "words", None) or []):
                p = getattr(w, "probability", None)
                if p is not None:
                    word_probs.append(float(p))
        text = " ".join(t for t in kept if t)

        # Doubt signal (#8/#12): mean segment avg_logprob + mean word probability.
        # Low values => Whisper was unsure => candidate for LLM correction (#11).
        avg_logprob = (sum(logprobs) / len(logprobs)) if logprobs else 0.0
        word_conf = (sum(word_probs) / len(word_probs)) if word_probs else 0.0

        spk_name = None
        spk_conf = 0.0
        if speaker_id is not None:
            try:
                spk_name, spk_conf = _identify_speaker(audio_raw, spk_context)
            except Exception:
                pass

            # Anti-speaker-ID: Jarvis's own voice matched a decoy speaker. Reject
            # it outright so the conversation loop can never feed on its own TTS.
            if spk_name in NEGATIVE_SPEAKERS:
                print(f"[stt] rejected self-voice (matched {spk_name})", flush=True)
                return {"text": text, "spk_conf": 0.0, "spk_name": None,
                        "avg_logprob": avg_logprob, "word_conf": word_conf}

            # Online adaptation: a confident owner utterance — learn from it so
            # the voiceprint keeps improving. Skipped if it's too short to be a
            # reliable reference. Echo can't reach here: it's caught above.
            # Learn from the RAW audio: references must live in the same domain
            # as identification input (raw), not the denoised ASR path.
            if (
                VOICE_LEARNING
                and spk_name == OWNER_SPEAKER_NAME
                and spk_conf >= LEARN_THRESHOLD
                and len(text.strip()) >= 4
                and len(audio_raw) >= SAMPLE_RATE * 1.0
            ):
                try:
                    if speaker_id.learn_sample(spk_name, audio_raw, SAMPLE_RATE):
                        print(f"[stt] learned owner sample (conf={spk_conf:.3f})", flush=True)
                except Exception as e:
                    print(f"[stt] learn_sample failed: {e}", flush=True)

        return {"text": text, "spk_conf": spk_conf, "spk_name": spk_name,
                "avg_logprob": avg_logprob, "word_conf": word_conf}
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STT_PORT", "8790"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
