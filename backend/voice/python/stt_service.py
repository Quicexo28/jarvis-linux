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
import re
import struct
import threading
import urllib.request
import tempfile
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

import numpy as np
import torch

# Cap torch's CPU thread pool: DeepFilter (denoise) and ECAPA (speaker-id) now
# run CONCURRENTLY on CPU — both defaulting to all cores oversubscribes and
# showed up as multi-second den_ms/spk_ms spikes. Half the cores each is the
# sweet spot; whisper is ctranslate2 (own pool, unaffected).
torch.set_num_threads(
    int(os.environ.get("STT_TORCH_THREADS", str(max(2, (os.cpu_count() or 8) // 2))))
)

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
    # NEVER put example COMMANDS (imperatives) here. Whisper regurgitates the
    # initial_prompt VERBATIM on silence/noise — the decoder is primed with these
    # tokens, so the echo passes the no_speech/logprob gates as "confident" text.
    # With command examples ("Abre el plano, pon un temporizador, navega a la
    # casa…") the echo came back as a VALID command at high confidence: with nobody
    # speaking the pipeline was effectively INJECTING its own example commands. That
    # echo can't be blocklisted either — it's indistinguishable from the user really
    # saying "abre el plano". The only correct fix is to not feed the model anything
    # actionable to echo: a neutral, NON-imperative register hint biases Colombian-
    # Spanish orthography/style with no sentence to regurgitate. Domain vocabulary is
    # primed via STT_HOTWORDS (token-level bias, not a context sentence to echo).
    # La segunda cláusula es DECLARATIVA (no imperativa) y existe para sesgar la
    # ORTOGRAFÍA del nombre: sin ella Whisper lo escribía "Yardis", "Yardish",
    # "Jackie", "Ya lo viste"… y el gate de wake se quedaba sin turno. Tiene >=3
    # palabras, así que _prompt_clauses la convierte sola en ancla de eco: si el
    # decoder la regurgita en silencio, el guardia descarta la transcripción.
    "Transcripción en español de Colombia. El asistente se llama Jarvis.",
)


def _strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


# Prompt-echo guard. During silence/noise Whisper hallucinates a paraphrase of the
# initial_prompt (e.g. "Comandos en español con Jarvis, el asistente personal de
# Santiago") — high avg_logprob / low no_speech_prob, so the anti-hallucination
# gates let it through as confident text. These anchors are narrative fragments a
# real command NEVER contains, so dropping any transcript that holds one removes the
# hallucination outright (empty text => never emitted) with zero risk to real speech.
# Override/extend via STT_ECHO_ANCHORS (comma-separated).
_ECHO_ANCHORS = tuple(
    _strip_accents(a).strip().lower()
    for a in os.environ.get(
        "STT_ECHO_ANCHORS",
        "en espanol con jarvis,asistente personal de,comandos por voz,"
        "conversacion en espanol,comandos en espanol",
    ).split(",")
    if a.strip()
)


# Belt-and-suspenders: treat every clause of the ACTIVE initial_prompt as an echo
# anchor too. Whatever primes the decoder can be regurgitated verbatim on silence,
# so deriving anchors from the prompt itself means the guard auto-covers any future
# prompt edit — a dangerous example can never come back as an executable command.
# Only clauses with >=3 words: a real utterance won't collide with a 3+ word prompt
# fragment, whereas a 1-2 word fragment ("plano") could match real speech.
def _prompt_clauses(prompt: str):
    for clause in re.split(r"[.,;:]", _strip_accents(prompt or "").lower()):
        words = clause.split()
        if len(words) >= 3:
            yield " ".join(words)


_ECHO_ANCHORS = tuple(dict.fromkeys((*_ECHO_ANCHORS, *_prompt_clauses(STT_INITIAL_PROMPT))))


def _is_prompt_echo(text: str) -> bool:
    if not text:
        return False
    norm = _strip_accents(text).lower()
    return any(a in norm for a in _ECHO_ANCHORS)


# Known Whisper training-data hallucinations. Whisper was trained on massive
# YouTube-caption corpora, so on silence / room noise / TTS echo that slips past
# VAD it emits FLUENT phantom captions ("Gracias por ver el video", "¡Suscríbete!",
# "Subtítulos por la comunidad de Amara.org") plus generic sign-offs ("adiós").
# These pass every existing gate — they are confident (high avg_logprob, low
# no_speech_prob) because they are real, fluent phrases; the RMS/logprob gates only
# catch true silence, and _is_prompt_echo only catches paraphrases of OUR prompt.
# Fix = a whole-transcript blocklist: drop only when the ENTIRE utterance (accents
# stripped, punctuation dropped, whitespace collapsed) IS one of these phrases, or
# is that phrase looped back-to-back. Whole-transcript match keeps real commands
# safe — "adiós Jarvis, apaga las luces" is not a bare "adios" so it survives.
# Extend with STT_HALLUCINATION_PHRASES (comma-separated, accents optional).
def _norm_phrase(text: str) -> str:
    s = _strip_accents(text or "").lower()
    s = re.sub(r"[^\w\s]", " ", s)     # drop punctuation (video. == video)
    s = re.sub(r"\s+", " ", s).strip()
    return s


_HALLUCINATION_PHRASES = tuple(
    dict.fromkeys(  # dedupe, keep order
        _norm_phrase(p)
        for p in (
            "gracias por ver el video",
            "gracias por ver",
            "gracias por ver el vídeo",
            "gracias por su atención",
            "gracias por vernos",
            "muchas gracias por ver el video",
            "gracias",
            "muchas gracias",
            "adiós",
            "hasta la próxima",
            "hasta luego",
            "nos vemos",
            "nos vemos en el próximo video",
            "suscríbete",
            "suscríbete al canal",
            "no olvides suscribirte",
            "dale like y suscríbete",
            "subtítulos realizados por la comunidad de amara.org",
            "subtítulos por la comunidad de amara.org",
            "subtitulado por la comunidad de amara.org",
            "más información en",
            *os.environ.get("STT_HALLUCINATION_PHRASES", "").split(","),
        )
        if _norm_phrase(p)
    )
)


def _only_repeats_of(norm: str, phrase: str) -> bool:
    """True if `norm` is exactly `phrase`, or `phrase` looped back-to-back
    (Whisper loops the caption: 'gracias por ver el video gracias por ver...')."""
    if not phrase:
        return False
    words, pw = norm.split(), phrase.split()
    if not pw or len(words) % len(pw) != 0:
        return False
    return all(words[i:i + len(pw)] == pw for i in range(0, len(words), len(pw)))


def _is_degenerate(norm: str) -> bool:
    """Whisper repetition-loop failure: a single token spammed ('no no no no')
    or a 2-token loop over a long span. Real commands don't degenerate this way."""
    words = norm.split()
    if len(words) < 3:
        return False
    unique = set(words)
    if len(unique) == 1:
        return True                    # "no no no no"
    return len(words) >= 6 and len(unique) <= 2


def _hallucination_reason(text: str):
    """Return WHY a transcript is a hallucination (for the log), or None if it is
    real speech. Covers prompt-echo, known caption hallucinations, and repetition
    loops. Whole-utterance match only — never drops a phrase inside a real command."""
    if not text or not text.strip():
        return None
    if _is_prompt_echo(text):
        return "prompt-echo"
    norm = _norm_phrase(text)
    if not norm:
        return None
    if _is_degenerate(norm):
        return "degenerate-repetition"
    if any(_only_repeats_of(norm, p) for p in _HALLUCINATION_PHRASES):
        return "known-hallucination"
    return None

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


@contextmanager
def _torch_cpu_only():
    """Hide CUDA from torch for the duration of a df call. DeepFilterNet picks
    cuda:0 whenever torch sees it, but the GPU is fully budgeted for whisper
    (4 GB card) — df on CUDA just OOMs and knocks denoise down to high-pass.
    CPU df is real-time anyway. Scoped so speaker-id/VAD device choices are
    unaffected."""
    import torch as _torch
    orig = _torch.cuda.is_available
    _torch.cuda.is_available = lambda: False
    try:
        yield
    finally:
        _torch.cuda.is_available = orig


def _deepfilter(audio: np.ndarray) -> np.ndarray:
    """DeepFilterNet neural denoise. Lazy-loads the model once; falls back to a
    high-pass if deepfilternet isn't installed or any step fails."""
    global _df_state
    try:
        if _df_state is None:
            _df_torchaudio_shim()
            from df.enhance import init_df  # type: ignore
            with _torch_cpu_only():
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
        with _torch_cpu_only():
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
        # hidden=True: the owner identifies normally but never appears in the
        # management UI — the encrypted voiceprint is not a user-editable profile.
        si.inject_speaker(OWNER_SPEAKER_NAME, embeddings, threshold, hidden=True)
        print(
            f"[stt] owner voiceprint loaded: {len(embeddings)} embeddings "
            f"for '{OWNER_SPEAKER_NAME}' (threshold={threshold})",
            flush=True,
        )
        return True
    except Exception as e:
        print(f"[stt] failed to load owner voiceprint: {e}", flush=True)
        return False


def _resolve_learn_threshold():
    """Scale the online-learning gate to the active encoder (unless pinned)."""
    global LEARN_THRESHOLD
    if "JARVIS_LEARN_THRESHOLD" not in os.environ and speaker_id is not None:
        LEARN_THRESHOLD = _LEARN_THRESHOLD_BY_ENCODER.get(
            speaker_id.encoder.name, LEARN_THRESHOLD
        )


def _load_owner_voiceprint_with_retry(si) -> None:
    """Load the encrypted owner voiceprint, retrying in the background if the
    machine key isn't available yet.

    On a `--user` systemd boot the Secret Service (gnome-keyring) is frequently
    not unlocked when this service starts, so the first decrypt fails with
    "Machine key not found" and the owner would run with ONLY the on-disk WAV
    samples — a weaker profile that lets other speakers in the room and short
    stray phrases slip through the gate as if they were the owner. Rather than
    lose owner discrimination until the next manual restart, keep retrying until
    the keyring answers, then inject the embeddings live (the SpeakerIdentifier
    object is already the live one, so a later inject is picked up).

    El reintento NO se rinde. La versión anterior paraba a los ~4 min y dejaba el
    servicio degradado para siempre: tras un reboot en el que el keyring se
    desbloquea tarde (login diferido, sin auto-unlock por PAM) el dueño se queda
    solo con los WAV y el coseno se hunde (~0.05 observado en journald el 07-ago,
    `speaker=None conf=0.047`) hasta un restart MANUAL. Un hilo dormido cada 60 s
    no cuesta nada; perder la identificación del dueño durante horas, sí."""
    if _load_owner_voiceprint(si):
        return
    if not OWNER_VOICEPRINT_ENC.exists():
        return  # nothing to retry — no encrypted voiceprint on disk

    def _retry():
        # Rápido al principio (el keyring suele llegar en el primer minuto tras
        # el login), luego lento e indefinido. Se avisa al pasar a fase lenta y
        # cada ~10 min, para que el journal muestre la degradación sin inundarlo.
        attempt = 0
        while True:
            attempt += 1
            delay = 5 if attempt <= 48 else 60
            time.sleep(delay)
            try:
                if _load_owner_voiceprint(si):
                    print(
                        f"[stt] owner voiceprint loaded on retry #{attempt} "
                        "(keyring became available)",
                        flush=True,
                    )
                    _resolve_learn_threshold()
                    return
            except Exception:
                pass
            if attempt == 48 or (attempt > 48 and (attempt - 48) % 10 == 0):
                print(
                    "[stt] owner voiceprint STILL unavailable "
                    f"(attempt {attempt}) — running with WAV samples only "
                    "(owner discrimination degraded); retrying every 60s",
                    flush=True,
                )

    threading.Thread(target=_retry, name="voiceprint-retry", daemon=True).start()
    print(
        "[stt] owner voiceprint not available yet (keyring not ready?) — "
        "retrying in background",
        flush=True,
    )


def _init_speaker_id():
    global speaker_id
    from speaker_id import SpeakerIdentifier
    si = SpeakerIdentifier(SPEAKER_SAMPLES_DIR)
    # Always inject the encrypted owner voiceprint (merges with WAV samples if
    # any). Retries in the background if the machine key isn't ready at boot.
    _load_owner_voiceprint_with_retry(si)
    # An empty speaker set is valid (e.g. right after a from-scratch re-enroll):
    # identification just returns None until samples are recorded, while the
    # management endpoints stay alive so the UI can enroll without a restart.
    if not si.speakers:
        print(
            f"[stt] speaker ID has no enrolled voices yet "
            f"(record samples under {SPEAKER_SAMPLES_DIR})",
            flush=True,
        )
    speaker_id = si
    _resolve_learn_threshold()


try:
    _init_speaker_id()
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
        # Owner voiceprint is hidden from the speakers list; this flag tells the
        # UI that identification works without exposing the owner profile.
        "owner_ready": any(
            d.get("hidden") and d.get("embeddings")
            for d in speaker_id.speakers.values()
        ),
        # System view: everything the config UI needs to show the new pipeline.
        "encoder": speaker_id.encoder.name,
        "default_threshold": speaker_id.default_threshold,
        "match_margin": speaker_id.match_margin,
        "cohort_size": len(speaker_id.cohort),
        "wake_templates": len(speaker_id.wake_templates),
        "trust_active": _trust_offset() < 0.0,
        "voice_learning": VOICE_LEARNING,
        "learn_threshold": LEARN_THRESHOLD,
        "denoise_mode": DENOISE_MODE,
        "whisper_model": WHISPER_MODEL,
        "whisper_device": WHISPER_DEVICE,
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
        data = speaker_id.speakers.get(safe)
        if data is not None and data.get("hidden"):
            raise HTTPException(status_code=403, detail="owner voiceprint is protected")
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
    from speaker_id import _safe_name, WAKE_DIRNAME
    safe = _safe_name(name)
    if safe == WAKE_DIRNAME:
        # The wake template set is not a speaker profile — reload it directly
        # (full reload would re-embed every reference, needlessly expensive).
        count = speaker_id.reload_wake()
        return {"ok": True, "loaded": count > 0, "wake_templates": count}
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

        # Hallucination guard (see _hallucination_reason): prompt-echo, known
        # caption phrases, or a repetition loop — drop entirely so a
        # silence/noise upload returns empty instead of phantom text.
        reason = _hallucination_reason(full_text)
        if reason:
            print(f"[stt] dropped {reason}: '{full_text.strip()}'", flush=True)
            full_text = ""
            segments = []

        # Speaker identification — same rescue layers (wake voiceprint, trust
        # continuity) as the streaming path, so short "Jarvis" uploads match.
        spk_name = None
        spk_confidence = 0.0
        spk_confidence_raw = 0.0
        if speaker_id is not None:
            try:
                import soundfile as _sf
                a, sr_in = _sf.read(tmp_path, dtype="float32")
                if a.ndim > 1:
                    a = a.mean(axis=1)
                if sr_in == SAMPLE_RATE:
                    spk_name, spk_confidence = _identify_speaker(a, None, full_text.strip())
                else:
                    spk_name, spk_confidence = speaker_id.identify_file(tmp_path)
            except Exception:
                try:
                    spk_name, spk_confidence = speaker_id.identify_file(tmp_path)
                except Exception:
                    pass
            # Same calibrated emission as the streaming path (see
            # VERIFIED_CONF_FLOOR): gate-surviving matches report ≥ the floor.
            # Keep the RAW cosine too — the backend authorizes command execution
            # on raw, not on the floored value (see the WS /stream comment).
            spk_confidence_raw = spk_confidence
            spk_confidence = _calibrate_conf(spk_name, spk_confidence)

        return {
            "text": full_text.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "segments": segments,
            "speaker_name": spk_name,
            "speaker_confidence": spk_confidence,
            "speaker_confidence_raw": spk_confidence_raw,
        }
    finally:
        os.unlink(tmp_path)


# Speculative prefix warm (#2): as soon as a speculative transcript is ready,
# hand it to the Node backend so it can pre-run the stateless turn prefix
# (LLM transcript correction) during the remaining silence tail. The final turn
# then hits a cache instead of paying that LLM call. Fire-and-forget.
BACKEND_URL = os.environ.get("JARVIS_BACKEND_URL", "http://127.0.0.1:8788")
SPEC_NOTIFY = os.environ.get("STT_SPEC_NOTIFY", "1") != "0"

_TERMINAL_PUNCT_RE = re.compile(r"[.!?…]\s*$")

# High-precision "mid-thought" cues: a transcript ending in a comma/colon, an
# ellipsis, or a Spanish conjunction/preposition/article almost never is a
# finished sentence. Everything NOT matching this is treated as complete-enough,
# because whisper frequently omits terminal punctuation in Spanish — requiring
# a '.' to finalize early (the old logic) made most turns wait the full window.
_CONTINUATION_RE = re.compile(
    r"(?:[,;:]|\.\.\."
    r"|\b(?:y|e|o|u|ni|que|de|del|al|a|en|con|sin|para|por|porque|pero|aunque"
    r"|como|cuando|donde|mientras|si|el|la|los|las|un|una|unos|unas"
    r"|mi|tu|su|mis|tus|sus|and|or|but|the|to|of|with|for)"
    r")\s*$",
    re.IGNORECASE,
)


def _notify_speculative(result: dict) -> None:
    try:
        payload = json.dumps({
            "text": result.get("text", ""),
            "avgLogprob": result.get("avg_logprob", 0.0),
            "confidence": result.get("word_conf", 0.0),
        }).encode()
        req = urllib.request.Request(
            f"{BACKEND_URL}/api/jarvis/speculative",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass  # backend down / endpoint missing — speculation is best-effort


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
        # 38 -> ~1.22s HARD CAP: even a transcript that looks mid-thought
        # (continuation cue) finalizes here. The adaptive tiers below finalize
        # most turns earlier (~0.7-0.9s). Raised from 31 to give a pause-grace
        # window: brief mid-sentence pauses no longer clip the turn. Override
        # with STT_SILENCE_CHUNKS (lower = snappier, higher = more grace).
        self.max_silence_chunks = int(os.environ.get("STT_SILENCE_CHUNKS", "38"))
        # Resume debounce: during the silence tail, require this many
        # CONSECUTIVE speech chunks before resetting the silence counter. A
        # single 32ms noise blip (fan, chair, click) used to reset the whole
        # tail and restart the wait. Real resumed speech clears 2 chunks (64ms)
        # trivially; buffered audio is unaffected either way.
        self.resume_chunks = int(os.environ.get("STT_RESUME_CHUNKS", "2"))
        self.pending_resume = 0
        # Speculative transcription: fire a snapshot transcription this many
        # chunks BEFORE the final threshold, during the silence tail, so its
        # ~0.3-0.5s cost overlaps the wait instead of adding to it. By default
        # the snapshot fires at ~22 chunks (the old final point), turning the
        # +0.5s we added into "free" time. Disable with STT_SPECULATIVE=0.
        self.speculative_enabled = os.environ.get("STT_SPECULATIVE", "1") != "0"
        # Fire the snapshot EARLY in the silence tail (~0.6s) so by the time the
        # adaptive endpoint (below) can fire, the transcription is already done.
        # STT_SPEC_AT wins if set; otherwise fall back to the legacy lead-based
        # placement relative to the final threshold.
        lead = int(os.environ.get("STT_SPECULATIVE_LEAD", "16"))
        spec_at_env = os.environ.get("STT_SPEC_AT")
        if spec_at_env is not None:
            self.speculative_threshold = max(1, int(spec_at_env))
        else:
            self.speculative_threshold = max(1, min(19, self.max_silence_chunks - lead))
        # Adaptive endpointing, INVERTED default (was: require terminal
        # punctuation to finalize early — whisper omits it so often in Spanish
        # that most finished turns waited the full window). Now, once the
        # speculative transcript is ready:
        #   terminal punct (.!?)        -> finalize at ef_complete (~0.70s)
        #   no continuation cue         -> finalize at ef_neutral  (~0.86s)
        #   continuation cue (,/y/que…) -> wait max_silence_chunks (~1.22s cap)
        # Grace bumped (was 16/22): a period whisper GUESSES mid-pause no longer
        # cuts the señor off "al instante" — he gets ~0.7s before an early final.
        # Disable with STT_EARLY_FINAL=0. STT_EARLY_FINAL_CHUNKS (legacy name)
        # overrides the neutral tier.
        self.early_final_enabled = os.environ.get("STT_EARLY_FINAL", "1") != "0"
        legacy_ef = os.environ.get("STT_EARLY_FINAL_CHUNKS")
        self.ef_neutral_chunks = int(os.environ.get("STT_EF_NEUTRAL_CHUNKS", legacy_ef or "27"))
        self.ef_complete_chunks = int(os.environ.get("STT_EF_COMPLETE_CHUNKS", "22"))
        if self.ef_complete_chunks > self.ef_neutral_chunks:
            self.ef_complete_chunks = self.ef_neutral_chunks
        if self.ef_neutral_chunks >= self.max_silence_chunks:
            self.early_final_enabled = False
        # spec_fired stays True only while the latest snapshot is still valid
        # (no speech resumed after it). Speech resuming flips it back off so the
        # final won't reuse a stale snapshot.
        self.spec_fired = False
        # One speculative backend notification per snapshot (LLM prefix warm).
        self.spec_notified = False
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
                elif self.silence_frames > 0:
                    # In the silence tail: debounce. Only resume_chunks
                    # CONSECUTIVE speech chunks reset the counter, so a lone
                    # noise blip can't restart the whole wait.
                    self.pending_resume += 1
                    if self.pending_resume >= self.resume_chunks:
                        self.pending_resume = 0
                        self.silence_frames = 0
                        # Speech resumed after a speculative snapshot -> snapshot
                        # is stale; allow a fresh one on the next silence tail.
                        if self.spec_fired:
                            self.spec_fired = False
                            self.spec_notified = False
            elif self.is_speaking:
                self.pending_resume = 0
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
        self.pending_resume = 0
        self.spec_fired = False
        self.spec_notified = False
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
    spec_cancel: Optional[CancelToken] = None

    def _abandon():
        # Drop a stale speculative task: signal its CancelToken so the worker
        # thread bails at its next stage boundary instead of burning a full
        # denoise + decode + speaker-id pass whose result nobody will read, and
        # swallow the resulting exception so asyncio doesn't log "exception
        # never retrieved".
        nonlocal spec_task, spec_cancel
        if spec_cancel is not None:
            spec_cancel.cancel()
        spec_cancel = None
        if spec_task is not None:
            spec_task.add_done_callback(
                lambda t: t.exception() if not t.cancelled() else None
            )
        spec_task = None

    async def _finalize(audio: np.ndarray, *, reuse_spec: bool, precomputed: Optional[dict] = None,
                        path: str = "final"):
        """Transcribe a finalized segment and send the result to the client."""
        nonlocal spec_task, spec_cancel
        t_final = time.time()
        result = precomputed
        if result is not None:
            _abandon()
        # Reuse the speculative result iff it's still valid (no speech resumed
        # after the snapshot — tracked by state.spec_fired). Flush never reuses.
        elif reuse_spec and spec_task is not None and state.spec_fired:
            try:
                result = await spec_task
                path = "spec-reuse"
            except Exception:
                result = None
            spec_task = None
            spec_cancel = None
        else:
            # Not reusing: cancel first, THEN await the doomed task so its
            # thread has released _SEG_LOCK before the real transcription asks
            # for it. Without the await the finalize would simply block on the
            # lock instead — same result, but this way the log order stays sane.
            doomed = spec_task
            _abandon()
            if doomed is not None:
                try:
                    await doomed
                except Exception:
                    pass

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
            wait_ms = int((time.time() - t_final) * 1000)
            print(
                f"[stt] transcript: '{transcript.strip()}' speaker={spk_name} "
                f"conf={spk_conf:.3f} (raw={result.get('spk_conf_raw', spk_conf):.3f}) "
                f"logprob={avg_logprob:.2f} wconf={word_conf:.2f} "
                f"path={path} seg_ms={result.get('ms', -1)} "
                f"(den={result.get('den_ms', -1)} wh={result.get('wh_ms', -1)} "
                f"spk={result.get('spk_ms', -1)}) finalize_wait_ms={wait_ms}",
                flush=True,
            )
            try:
                await ws.send_json({
                    "text": transcript.strip(),
                    "isFinal": True,
                    "speakerName": spk_name,
                    "speakerConfidence": spk_conf,
                    # RAW cosine (pre-calibration). The backend authorizes command
                    # EXECUTION on this, not on speakerConfidence: the latter is
                    # floored to VERIFIED_CONF_FLOOR (0.80) on any gate-surviving
                    # match, which masks a marginal match (e.g. a hallucination on
                    # noise that grazed the speaker gate) as full-confidence owner.
                    "speakerConfidenceRaw": result.get("spk_conf_raw", spk_conf),
                    "avgLogprob": avg_logprob,
                    "confidence": word_conf,
                })
            except Exception as e:
                # Client vanished mid-reconnect: a failed send must NOT tear down
                # the whole stream loop. Next receive() will surface the real
                # disconnect and break cleanly.
                print(f"[stt] final send failed (client gone?): {e}", flush=True)

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                # Log the initiator/code so the reconnect churn can be pinned:
                # this is the CLEAN close path (no traceback) the logs were hitting.
                print(f"[stt] /stream disconnect (code={message.get('code')})", flush=True)
                break

            data = message.get("bytes")
            if data is not None:
                event, audio = state.add_audio(data)

                if event == "spec":
                    if audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                        # Kick off transcription during the silence tail so it's
                        # likely done by the time we finalize.
                        _abandon()
                        spec_cancel = CancelToken()
                        spec_task = asyncio.create_task(
                            asyncio.to_thread(
                                _transcribe_segment, audio, state.spk_context(),
                                spec_cancel,
                            )
                        )
                    continue

                if event == "final" and audio is not None and len(audio) > SAMPLE_RATE * 0.3:
                    await _finalize(audio, reuse_spec=True)
                elif event == "final":
                    # Segment too short to transcribe — drop any pending snapshot.
                    _abandon()

                # Silence tail housekeeping: once the speculative transcription
                # is done we can (a) warm the backend's LLM prefix and (b) fire
                # the adaptive early endpoint if the sentence looks complete.
                if (event is None and state.is_speaking and state.spec_fired
                        and spec_task is not None and spec_task.done()):
                    try:
                        spec_result = spec_task.result()
                    except Exception:
                        spec_result = None
                    if spec_result is not None and spec_result["text"].strip():
                        if SPEC_NOTIFY and not state.spec_notified:
                            state.spec_notified = True
                            asyncio.create_task(
                                asyncio.to_thread(_notify_speculative, spec_result)
                            )
                        spec_text = spec_result["text"].strip()
                        if _CONTINUATION_RE.search(spec_text):
                            # Clearly mid-thought (comma / trailing conjunction)
                            # → no early final; the ~1s hard cap still applies.
                            required = None
                        elif _TERMINAL_PUNCT_RE.search(spec_text):
                            required = state.ef_complete_chunks
                        else:
                            # No punctuation ≠ unfinished: whisper drops terminal
                            # punctuation constantly in Spanish. Neutral tier.
                            required = state.ef_neutral_chunks
                        if (state.early_final_enabled and required is not None
                                and state.silence_frames >= required):
                            # Transcription already in hand → finalize now
                            # instead of waiting the full silence window (same
                            # transcript the final would have reused anyway).
                            audio_full = np.frombuffer(
                                bytes(state.audio_buffer), dtype=np.float32
                            )
                            state.audio_buffer.clear()
                            state.is_speaking = False
                            state.silence_frames = 0
                            state.pending_resume = 0
                            state.spec_fired = False
                            state.spec_notified = False
                            await _finalize(
                                audio_full, reuse_spec=False,
                                precomputed=spec_result, path="early-final",
                            )
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
                        _abandon()

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
        _abandon()


# ── Trust continuity (owner-presence prior) ────────────────────────────────
# After a confident owner identification, keep a decaying "the owner is here"
# window. Segments inside it that *almost* passed the threshold (the candidate
# WAS the owner, just short/off-condition) are retried with a threshold
# discount that decays to zero over TRUST_TTL. The cohort gate always applies,
# so noise can't exploit the discount; only near-miss owner matches can.
TRUST_TTL_S = float(os.environ.get("JARVIS_TRUST_TTL", "60"))
TRUST_MAX_OFFSET = float(os.environ.get("JARVIS_TRUST_OFFSET", "0.10"))
TRUST_SET_MIN = float(os.environ.get("JARVIS_TRUST_SET_MIN", "0.72"))
_owner_trust_time = 0.0


def _touch_trust() -> None:
    global _owner_trust_time
    _owner_trust_time = time.time()


def _trust_offset() -> float:
    """Current threshold discount granted by owner-presence trust (≤ 0)."""
    age = time.time() - _owner_trust_time
    if age >= TRUST_TTL_S:
        return 0.0
    return -TRUST_MAX_OFFSET * (1.0 - age / TRUST_TTL_S)


# Wake-word-ish transcripts ("jarvis" and its common mistranscriptions, alone
# or with 1-2 filler words) qualify for the text-dependent wake voiceprint.
# Same shape-based family as JARVIS_STRONG_RE/JARVIS_HEAD_RE in
# backend/src/lib/intentClassifier.js (consonante + a/e + r + oclusiva + cola,
# plus "javier"/"jared"/"jackie"/"ya (lo) ves|veis|viste|oíste"): Whisper swaps
# the initial consonant, the fricative and the tail, so enumerating variants
# lagged reality ("Garbis", "Ya lo veis", "Yardis", "Yardish", "Hola Yardist",
# "Ya lo viste", "Jackie" all observed in journald).
_WAKE_CONS = r"(?:[jygh]|ch|ll)"
_WAKE_CORE = rf"{_WAKE_CONS}[ae]r(?:[vbd](?:i(?:s|z|sh|st)?|es|s|e)?|i(?:s|z|sh|st)|es)"
_WAKE_AMBIG = r"ya ?(?:lo )?(?:ve(?:is|s|z)|viste|oiste)|y ahora ve(?:is|s)|ja ?vier|jared|jackie"
# Sin anclaje a cabeza (a diferencia del JS): _wake_eligible ya exige <=3 palabras
# y <=2.5 s, así que el enunciado ES el nombre y no hay medio de frase que proteger.
# Se matchea sobre la forma sin tildes (igual que el JS): \b no considera "í" un
# carácter de palabra, así que "jardín" tenía frontera tras "jard" y entraba.
_WAKE_TEXT_RE = re.compile(
    rf"\b(?:{_WAKE_CORE}|javis|arvis)\b|\b(?:{_WAKE_AMBIG})\b",
    re.IGNORECASE,
)


def _wake_eligible(audio: np.ndarray, text: Optional[str]) -> bool:
    if len(audio) > SAMPLE_RATE * 2.5:
        return False
    if text is None:
        return True
    t = text.strip()
    return bool(_WAKE_TEXT_RE.search(_strip_accents(t))) and len(t.split()) <= 3


# Calibrated emitted confidence: a match that survived the FULL gate stack
# (per-speaker threshold + margin + cohort gate + duration adaptation + rescue
# layers) is a high-probability identification even when the raw cosine is
# modest (short clips physically score lower). Downstream consumers
# (speech.js owner gate 0.65, intentClassifier 0.65, KNOWN 0.60) read the
# emitted value; the RAW score stays internal for trust/learning decisions so
# a calibrated floor can never inflate the voiceprint or the trust window.
VERIFIED_CONF_FLOOR = float(os.environ.get("SPEAKER_VERIFIED_CONF_FLOOR", "0.80"))

# Speaker-id runs on CPU while Whisper decodes on GPU — a small executor lets
# _transcribe_segment overlap the two instead of paying them serially.
_SPK_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="spkid")


# Only ONE segment transcription may run at a time, and an abandoned one bails
# at the next stage boundary.
#
# The speculative snapshot (fired ~0.38s into the silence tail) and the real
# finalize (~1.0s) are BOTH dispatched with asyncio.to_thread. When speech
# resumed after the snapshot the speculative result is unusable, so _finalize
# used to just drop the reference and start a second _transcribe_segment — but
# `asyncio.to_thread` work cannot be interrupted, so the discarded thread kept
# running a full denoise + whisper decode + speaker-id gate stack alongside the
# real one. Measured cost: every `path=final` turn showed den_ms 3.2-9.9s
# against an intrinsic DeepFilter cost of ~0.16s for the same clip, while the
# one `path=spec-reuse` turn (no overlap) was the fastest of the batch. It
# bought nothing either: ctranslate2 runs with num_workers=1, so the two decodes
# serialized inside the model anyway.
#
# Two mechanisms, both needed:
#   * CancelToken — checked at each stage boundary, so an abandoned snapshot
#     stops before the next expensive stage instead of running to completion.
#     The stage it is already inside still finishes (whisper/DeepFilter are
#     opaque C++ calls), which is why the lock below is not redundant.
#   * _SEG_LOCK — serializes whatever survives, so the survivor never contends
#     for the shared torch OpenMP pool / GIL with a doomed thread.
_SEG_LOCK = threading.Semaphore(1)


class _Cancelled(Exception):
    """Raised inside a transcription thread whose result is no longer wanted."""


class CancelToken:
    """One-shot cancel flag handed to a speculative transcription."""

    __slots__ = ("_cancelled",)

    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def check(self) -> None:
        if self._cancelled:
            raise _Cancelled()


def _calibrate_conf(spk_name: Optional[str], raw_conf: float) -> float:
    if spk_name is None:
        return raw_conf
    return max(raw_conf, VERIFIED_CONF_FLOOR)


def _identify_speaker_base(audio: np.ndarray,
                           spk_context: Optional[np.ndarray]) -> tuple:
    """Text-independent stage (no transcript needed): full-utterance match +
    same-turn pooling (#7). Runs on CPU, so it can execute CONCURRENTLY with
    Whisper's GPU decode — see _transcribe_segment."""
    spk_name, spk_conf = speaker_id.identify_audio(audio, SAMPLE_RATE)
    if spk_context is not None and len(spk_context) > 0:
        try:
            pooled = np.concatenate([spk_context, audio])
            ctx_name, ctx_conf = speaker_id.identify_audio(pooled, SAMPLE_RATE)
            if ctx_name is not None and ctx_conf > spk_conf:
                spk_name, spk_conf = ctx_name, ctx_conf
        except Exception:
            pass
    return spk_name, spk_conf


def _identify_speaker_rescue(audio: np.ndarray, spk_name: Optional[str],
                             spk_conf: float, text: Optional[str],
                             audio_dn: Optional[np.ndarray] = None) -> tuple:
    """Rescue stage, applied after the transcript exists. Returns
    (name, conf, domain) where domain is "raw" or "denoised":

    1. Wake voiceprint: utterances ≤2.5s whose transcript is (only) the wake
       word are matched against the _wake/ template set (works from ~0.4s).
    2. Denoised-domain retry: far-field / quiet speech drowns in room noise in
       the RAW domain (embedding drifts toward the cohort's noise direction and
       gets gated) while Whisper still hears it fine — because Whisper reads
       the DeepFilter output. That denoised signal is already computed, so
       re-embed it and run the FULL gate stack. Only fires when the raw domain
       failed; the returned domain tag keeps online learning raw-only (a raw
       segment that raw-matching rejected must never become a reference).
    3. Trust continuity: shortly after a confident owner match, near-miss
       owner scores are re-tried with a decaying threshold discount.
    Every layer keeps the cohort gate.
    """
    if spk_name is None and _wake_eligible(audio, text):
        try:
            marker, wscore = speaker_id.match_wake(audio, SAMPLE_RATE)
            if marker is not None:
                print(f"[stt] wake voiceprint match (score={wscore:.3f})", flush=True)
                return OWNER_SPEAKER_NAME, wscore, "raw"
        except Exception:
            pass

    if spk_name is None and audio_dn is not None and len(audio_dn) > 0:
        try:
            d_name, d_conf = speaker_id.identify_audio(audio_dn, SAMPLE_RATE)
            if d_name is not None:
                print(f"[stt] denoised-domain rescue (conf={d_conf:.3f})", flush=True)
                return d_name, d_conf, "denoised"
        except Exception:
            pass

    if spk_name is None:
        offset = _trust_offset()
        if offset < 0.0:
            try:
                t_name, t_conf = speaker_id.identify_audio(
                    audio, SAMPLE_RATE, thr_offset=offset
                )
                if t_name == OWNER_SPEAKER_NAME:
                    print(
                        f"[stt] trust-continuity accept (conf={t_conf:.3f} "
                        f"offset={offset:.3f})",
                        flush=True,
                    )
                    return t_name, t_conf, "raw"
            except Exception:
                pass

    return spk_name, spk_conf, "raw"


def _identify_speaker(audio: np.ndarray, spk_context: Optional[np.ndarray],
                      text: Optional[str] = None) -> tuple:
    """Full pipeline (base + rescue) for callers that already have the text.
    Keeps the legacy (name, conf) shape — no denoised audio on this path."""
    spk_name, spk_conf = _identify_speaker_base(audio, spk_context)
    spk_name, spk_conf, _ = _identify_speaker_rescue(audio, spk_name, spk_conf, text)
    return spk_name, spk_conf


def _transcribe_segment(audio: np.ndarray, spk_context: Optional[np.ndarray] = None,
                        cancel: Optional[CancelToken] = None) -> dict:
    """Transcribe a numpy audio segment, one at a time (see _SEG_LOCK).

    Waits for any in-flight segment to finish or bail before doing real work, so
    an abandoned speculative snapshot can never contend with the finalize that
    replaced it. Raises _Cancelled if `cancel` fires; the caller discards the
    task, so nothing downstream sees the exception.

    Returns a dict: { text, spk_conf, spk_name, avg_logprob, word_conf, ms }.
    avg_logprob/word_conf are the doubt signals consumed by the backend LLM
    correction layer (#11). ms = wall time of the WORK (lock wait excluded, so
    den_ms/wh_ms/spk_ms stay comparable across turns); the caller's
    finalize_wait_ms still covers the full user-visible latency.
    """
    if cancel is not None:
        cancel.check()
    with _SEG_LOCK:
        if cancel is not None:
            cancel.check()
        return _transcribe_segment_locked(audio, spk_context, cancel)


def _transcribe_segment_locked(audio: np.ndarray,
                               spk_context: Optional[np.ndarray],
                               cancel: Optional[CancelToken]) -> dict:
    def _checkpoint() -> None:
        if cancel is not None:
            cancel.check()

    t_start = time.time()

    # Bifurcated audio paths: whisper gets the denoised signal (ASR likes clean
    # audio), speaker-id gets the RAW signal — neural denoising reshapes the
    # spectrum enough to shift voice embeddings, and enrollment was done on raw
    # audio, so denoise-before-embed degrades identification.
    # Private, writable copies: the caller's array may be a read-only
    # np.frombuffer view, and the speaker-id thread reads audio_raw WHILE the
    # denoise/whisper path works on audio — they must not share memory.
    audio = np.array(audio, dtype=np.float32, copy=True)
    audio_raw = audio.copy()

    # Energy gate: a segment quieter than MIN_RMS is room noise, not speech.
    # Drop it outright — never transcribe, never run speaker-id (which would
    # otherwise hand back a spurious high confidence on pure noise). Gate on the
    # raw signal so an aggressive denoiser can't shrink real speech below it.
    rms = float(np.sqrt(np.mean(np.square(audio_raw)))) if len(audio_raw) else 0.0
    if rms < MIN_RMS:
        print(f"[stt] dropped low-energy segment (rms={rms:.4f} < {MIN_RMS})", flush=True)
        return {"text": "", "spk_conf": 0.0, "spk_name": None, "avg_logprob": 0.0,
                "word_conf": 0.0, "ms": int((time.time() - t_start) * 1000)}

    # Speaker-id (CPU) launched BEFORE the GPU decode so both run concurrently:
    # the text-independent stage needs no transcript, and the text-dependent
    # rescue layers run after Whisper only if this base stage failed.
    spk_future = None
    if speaker_id is not None:
        spk_future = _SPK_EXECUTOR.submit(
            _identify_speaker_base, audio_raw, spk_context
        )

    audio = _denoise(audio)
    den_ms = int((time.time() - t_start) * 1000)

    # Bail before the GPU decode — the single most expensive stage — if this
    # snapshot was superseded while denoise ran.
    try:
        _checkpoint()
    except _Cancelled:
        if spk_future is not None:
            spk_future.cancel()
        raise

    t_wh = time.time()
    # faster-whisper takes the float32 16k mono array directly — the old
    # tempfile round-trip (write WAV + re-decode) was pure latency.
    segments_iter, info = whisper_model.transcribe(
        audio,
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
        # faster-whisper's own hallucination filter: with word timestamps it
        # detects words emitted across a silent gap longer than this (seconds)
        # and drops them. Complements the whole-transcript blocklist that runs
        # over the decoded text below. STT_HALLUC_SILENCE=0 disables.
        hallucination_silence_threshold=(
            float(os.environ.get("STT_HALLUC_SILENCE", "2.0")) or None
        ),
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

    # Hallucination guard: prompt-echo, known YouTube-caption phrases, or a
    # repetition loop. Whisper emits these with high confidence during
    # silence/noise/TTS-echo; the logprob/no_speech gates can't catch a fluent
    # phantom phrase, so a whole-transcript blocklist drops it before the client.
    reason = _hallucination_reason(text)
    if reason:
        print(f"[stt] dropped {reason}: '{text}'", flush=True)
        text = ""
        kept = []
        logprobs = []
        word_probs = []

    # Doubt signal (#8/#12): mean segment avg_logprob + mean word probability.
    # Low values => Whisper was unsure => candidate for LLM correction (#11).
    avg_logprob = (sum(logprobs) / len(logprobs)) if logprobs else 0.0
    word_conf = (sum(word_probs) / len(word_probs)) if word_probs else 0.0
    wh_ms = int((time.time() - t_wh) * 1000)

    # Bail before the speaker-id gate stack (windowed voting + wake templates +
    # denoised-domain retry — measured up to 9.3s on a bad turn).
    try:
        _checkpoint()
    except _Cancelled:
        if spk_future is not None:
            spk_future.cancel()
        raise

    t_spk = time.time()
    spk_name = None
    spk_conf = 0.0
    if spk_future is not None:
        try:
            spk_name, spk_conf = spk_future.result(timeout=10)
        except Exception:
            pass
        spk_domain = "raw"
        try:
            # Rescue layers (wake voiceprint, denoised-domain retry, trust
            # continuity) — only meaningful now that the transcript exists.
            # `audio` is the DeepFilter output whisper just consumed.
            spk_name, spk_conf, spk_domain = _identify_speaker_rescue(
                audio_raw, spk_name, spk_conf, text, audio_dn=audio
            )
        except Exception:
            pass

        # Confident owner match (RAW score — calibration never feeds trust)
        # → refresh the trust-continuity window.
        if spk_name == OWNER_SPEAKER_NAME and spk_conf >= TRUST_SET_MIN:
            _touch_trust()

        # Anti-speaker-ID: Jarvis's own voice matched a decoy speaker. Reject
        # it outright so the conversation loop can never feed on its own TTS.
        if spk_name in NEGATIVE_SPEAKERS:
            print(f"[stt] rejected self-voice (matched {spk_name})", flush=True)
            return {"text": text, "spk_conf": 0.0, "spk_name": None,
                    "avg_logprob": avg_logprob, "word_conf": word_conf,
                    "ms": int((time.time() - t_start) * 1000)}

        # Online adaptation: a confident owner utterance — learn from it so
        # the voiceprint keeps improving. Gated on the RAW score; runs on a
        # background thread (file write + embed + consistency check were
        # ~100-300ms of reply latency for zero user-visible benefit).
        # Learn from the RAW audio: references must live in the same domain
        # as identification input (raw), not the denoised ASR path.
        if (
            VOICE_LEARNING
            and spk_name == OWNER_SPEAKER_NAME
            and spk_domain == "raw"
            and spk_conf >= LEARN_THRESHOLD
            and len(text.strip()) >= 4
            and len(audio_raw) >= SAMPLE_RATE * 1.0
        ):
            _learn_async(spk_name, audio_raw.copy(), spk_conf)
    spk_ms = int((time.time() - t_spk) * 1000)

    return {"text": text, "spk_conf": _calibrate_conf(spk_name, spk_conf),
            "spk_conf_raw": spk_conf, "spk_name": spk_name,
            "avg_logprob": avg_logprob, "word_conf": word_conf,
            "ms": int((time.time() - t_start) * 1000),
            "den_ms": den_ms, "wh_ms": wh_ms, "spk_ms": spk_ms}


def _learn_async(name: str, audio_raw: np.ndarray, raw_conf: float) -> None:
    """Fire-and-forget online learning — off the reply's critical path."""
    def _run():
        try:
            if speaker_id.learn_sample(name, audio_raw, SAMPLE_RATE):
                print(f"[stt] learned owner sample (conf={raw_conf:.3f})", flush=True)
        except Exception as e:
            print(f"[stt] learn_sample failed: {e}", flush=True)
    threading.Thread(target=_run, daemon=True).start()


# Boot warmup: the FIRST whisper decode after service start pays CUDA/cuDNN
# init + kernel autotune (measured: 44s on the RTX 3050 with large-v3) — an
# unacceptable first-turn latency if it lands on a real utterance. Decode one
# second of throwaway audio now, on a background thread, so the cost is paid
# during boot. Also warms DeepFilter (CPU) and the ECAPA encoder.
def _warmup_models() -> None:
    try:
        t0 = time.time()
        dummy = (np.random.default_rng(0).standard_normal(SAMPLE_RATE) * 0.003
                 ).astype(np.float32)
        # vad_filter=False forces a real decode even on non-speech audio.
        segs, _ = whisper_model.transcribe(
            dummy, language=STT_LANG,
            beam_size=int(os.environ.get("STT_BEAM_SIZE", "5")),
            vad_filter=False, condition_on_previous_text=False,
        )
        for _ in segs:
            pass
        _denoise(dummy)
        if speaker_id is not None:
            try:
                speaker_id.encoder.embed(dummy)
            except Exception:
                pass
        print(f"[stt] model warmup done in {time.time() - t0:.1f}s", flush=True)
    except Exception as e:
        print(f"[stt] warmup failed (non-fatal): {e}", flush=True)


threading.Thread(target=_warmup_models, daemon=True, name="warmup").start()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STT_PORT", "8790"))
    # Lenient WS keepalive: the streaming loop runs synchronous Silero VAD on the
    # event loop, so a brief CPU-contention stall must NOT trip the default 20s
    # ping timeout and kill an active mic socket. 30s interval / 90s timeout.
    uvicorn.run(
        app, host="127.0.0.1", port=port, log_level="info",
        ws_ping_interval=float(os.environ.get("STT_WS_PING_INTERVAL", "30")),
        ws_ping_timeout=float(os.environ.get("STT_WS_PING_TIMEOUT", "90")),
    )
