"""
Multi-speaker identification for Jarvis.

Structure on disk:
    <root>/
        _config.json          # per-speaker thresholds (underscore = ignored by scanners)
        <speaker_name>/
            <sample>.wav
            <sample>.wav
        <speaker_name>/
            ...

Each speaker keeps the per-sample embeddings of all their reference recordings.
Identification scores the incoming utterance against every stored sample and
picks the speaker with the highest cosine similarity. A match is accepted only
when the best score clears that speaker's own threshold AND beats the runner-up
speaker by a margin, so two similar profiles don't steal each other's turns.

There is no "default" speaker: profiles are explicit, loose files at the root
are ignored, and nothing is auto-migrated.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import wave as _wave
from pathlib import Path
from typing import Optional

import numpy as np

AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm"}
NATIVE_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}

SAMPLE_CAP = 50
SAMPLE_MAX_SECONDS = 5.0

# Online owner-voice adaptation (learn_sample).
LEARN_MAX_EMB = 40          # max live embeddings per learned speaker (seed + recent)
LEARN_MIN_INTERVAL_S = 6.0  # min gap between learned samples (anti-flood)

CONFIG_FILENAME = "_config.json"
COHORT_DIRNAME = "_cohort"
REJECTED_DIRNAME = "_rejected"
# Text-dependent wake voiceprint: short recordings of the owner saying ONLY the
# wake word ("Jarvis"). Fixed phonetic content needs far less audio for a
# stable match, so this set identifies utterances too short for the regular
# text-independent path. Loaded separately (like the cohort), never listed.
WAKE_DIRNAME = "_wake"
WAKE_MIN_SAMPLES = 5600      # ~0.35 s — wake word trimmed by VAD is short
WAKE_THRESHOLD = float(os.environ.get("SPEAKER_WAKE_THRESHOLD", "0.60"))
# Score a speaker by the MEAN of its top-K most similar reference embeddings,
# not the single MAX. Max inflates with embedding count: with ~40 learned
# refs, a noise/other-voice clip almost always grazes one of them and scores
# high. Averaging the top few demands consistent similarity, so noise drops.
MATCH_TOPK = 3
# Minimum decoded length (samples @16kHz) for an utterance to be identified.
IDENT_MIN_SAMPLES = 16000  # ~1.0 s
# Minimum decoded length for an enrollment sample to count.
ENROLL_MIN_SAMPLES = 8000  # ~0.5 s

SAMPLE_RATE = 16000
# Sliding-window identification: utterances at least MULTI_MIN_S long are also
# scored per-window with majority vote, so a speaker change mid-utterance (or
# two people talking over each other) is detected instead of producing one
# blended, meaningless embedding.
MULTI_MIN_S = 3.0
WINDOW_S = 1.5
HOP_S = 0.75

# Cohort gate (AS-norm-lite): if a `_cohort/` dir with generic voices exists
# under the samples root, the best speaker score must beat the cohort's score
# by this margin. Noise / unknown voices that graze the owner's references also
# graze the cohort, so they get rejected without touching per-speaker thresholds.
COHORT_MARGIN = float(os.environ.get("SPEAKER_COHORT_MARGIN", "0.05"))

# Duration-adaptive threshold: embeddings from short utterances are noisier
# (fewer phonemes to average), so a fixed threshold rejects the true owner on
# brief commands. Short clips get a small threshold discount — paired with a
# STRICTER cohort margin so noise can't ride the discount in.
SHORT_UTTERANCE_S = 1.5
MID_UTTERANCE_S = 3.0
SHORT_THR_OFFSET = float(os.environ.get("SPEAKER_SHORT_THR_OFFSET", "-0.08"))
MID_THR_OFFSET = float(os.environ.get("SPEAKER_MID_THR_OFFSET", "-0.04"))
SHORT_COHORT_EXTRA = 0.02

# Enrollment augmentation: each on-disk reference WAV is also embedded in
# synthetic acoustic variants (reverb ≈ far/echoey room, lowpass+attenuation ≈
# distance, added noise ≈ noisy room), widening condition coverage without new
# recordings. Applies to speaker dirs and the wake set, never the cohort.
AUGMENT_ENABLED = os.environ.get("SPEAKER_AUGMENT", "1") != "0"
AUGMENT_MAX_BASE = int(os.environ.get("SPEAKER_AUGMENT_MAX", "12"))

# Log the reason (threshold / margin / cohort) whenever a match candidate is
# rejected — one line per failed identify. Set SPEAKER_DEBUG=0 to silence.
DEBUG_REJECT = os.environ.get("SPEAKER_DEBUG", "1") != "0"


# --- Encoder backends ---------------------------------------------------------
#
# resemblyzer (GE2E d-vector, 2019) and ECAPA-TDNN (SpeechBrain) produce
# embeddings on different scales, so threshold/margin defaults are per-encoder.
# ECAPA separates voices far better (EER ~0.8% vs ~5-8%); it is the default and
# resemblyzer stays as fallback. Select with SPEAKER_ENCODER=ecapa|resemblyzer.

class _ResemblyzerEncoder:
    name = "resemblyzer"
    dim = 256
    default_threshold = 0.70
    default_margin = 0.06
    # Reference-consistency floor: an enrolled embedding whose mean similarity
    # to the speaker's other references falls below this is junk (echo, noise,
    # another voice that slipped past online learning) and gets excluded.
    ref_floor = 0.55

    def __init__(self, device: str):
        from resemblyzer import VoiceEncoder
        self._enc = VoiceEncoder(device=device)

    def embed(self, wav: np.ndarray) -> np.ndarray:
        return np.asarray(self._enc.embed_utterance(wav), dtype=np.float32)


class _EcapaEncoder:
    name = "ecapa"
    dim = 192
    default_threshold = 0.55
    default_margin = 0.10
    ref_floor = 0.30

    def __init__(self, device: str):
        import torch
        from speechbrain.inference.speaker import EncoderClassifier
        self._torch = torch
        self._enc = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(Path.home() / ".cache" / "jarvis" / "spkrec-ecapa-voxceleb"),
            run_opts={"device": device},
        )

    def embed(self, wav: np.ndarray) -> np.ndarray:
        with self._torch.no_grad():
            t = self._torch.from_numpy(np.ascontiguousarray(wav, dtype=np.float32)).unsqueeze(0)
            emb = self._enc.encode_batch(t).squeeze()
        return emb.cpu().numpy().astype(np.float32)


def filter_consistent(
    embeddings: list[np.ndarray], floor: float, labels: Optional[list[str]] = None,
    tag: str = "", return_dropped: bool = False,
):
    """Drop reference embeddings inconsistent with the rest of the set.

    A speaker's real references agree with each other; a junk reference (echo,
    noise, another voice that slipped past online learning) sits far from the
    cluster AND — critically — junk matches junk, so a couple of bad references
    let noise clips score high. Mean-similarity-to-others below `floor` = out.
    Needs >=4 references to judge; never drops below 3 survivors.
    """
    n = len(embeddings)
    if n < 4:
        return (embeddings, []) if return_dropped else embeddings
    M = np.array(embeddings) @ np.array(embeddings).T
    keep, dropped = [], []
    order = []
    for i in range(n):
        others_mean = float((M[i].sum() - M[i, i]) / (n - 1))
        order.append((others_mean, i))
    # Keep the most consistent first so we can guarantee >=3 survivors.
    order.sort(reverse=True)
    for rank, (mean_sim, i) in enumerate(order):
        if mean_sim >= floor or rank < 3:
            keep.append(i)
        else:
            dropped.append(i)
    if dropped:
        names = ", ".join(
            (labels[i] if labels else f"#{i}") for i in sorted(dropped)
        )
        print(
            f"[speaker_id] {tag}excluded {len(dropped)} inconsistent reference(s) "
            f"(mean-sim < {floor:.2f}): {names}",
            flush=True,
        )
    keep.sort()
    kept = [embeddings[i] for i in keep]
    return (kept, sorted(dropped)) if return_dropped else kept


def make_encoder(device: str):
    """Build the configured speaker encoder; fall back gracefully."""
    requested = os.environ.get("SPEAKER_ENCODER", "ecapa").strip().lower()
    order = ["ecapa", "resemblyzer"] if requested != "resemblyzer" else ["resemblyzer", "ecapa"]
    last_err: Optional[Exception] = None
    for kind in order:
        cls = _EcapaEncoder if kind == "ecapa" else _ResemblyzerEncoder
        try:
            enc = cls(device)
            print(f"[speaker_id] encoder={enc.name} dim={enc.dim} device={device}", flush=True)
            return enc
        except Exception as e:
            last_err = e
            print(f"[speaker_id] encoder '{kind}' unavailable ({e}); trying next", flush=True)
    raise RuntimeError(f"No speaker encoder available: {last_err}")


def augment_variants(wav: np.ndarray, sr: int = SAMPLE_RATE) -> list[np.ndarray]:
    """Synthetic acoustic variants of a reference sample (see AUGMENT_ENABLED).

    Deterministic (seeded from the signal) so reloads produce identical
    embeddings. Each variant simulates one real-world condition shift:
      reverb   — far speaker in an echoey room (exponential-decay IR)
      distance — high-frequency rolloff + attenuation
      noise    — moderate background noise (~15 dB SNR)
    """
    if len(wav) < ENROLL_MIN_SAMPLES:
        return []
    rng = np.random.default_rng(int(abs(float(np.sum(wav))) * 1e6) % (2**32))
    out: list[np.ndarray] = []
    try:
        from scipy import signal as _sig

        # 1. Reverb: 0.25s noise burst with exponential decay as impulse response.
        ir_len = int(0.25 * sr)
        ir = rng.standard_normal(ir_len) * np.exp(-np.linspace(0, 8, ir_len))
        ir[0] = 1.0  # direct path
        ir /= (np.sqrt(np.sum(ir ** 2)) + 1e-9)
        rev = _sig.fftconvolve(wav, ir)[: len(wav)].astype(np.float32)
        rev *= (np.max(np.abs(wav)) + 1e-9) / (np.max(np.abs(rev)) + 1e-9)
        out.append(rev)

        # 2. Distance: 4th-order lowpass at 3.4kHz + -6dB.
        sos = _sig.butter(4, 3400, btype="low", fs=sr, output="sos")
        far = (_sig.sosfilt(sos, wav) * 0.5).astype(np.float32)
        out.append(far)
    except Exception:
        pass  # scipy missing/failed — noise variant below still applies

    # 3. Noise at ~15 dB SNR.
    rms = float(np.sqrt(np.mean(np.square(wav)))) + 1e-9
    noise = rng.standard_normal(len(wav)).astype(np.float32) * (rms / (10 ** (15 / 20)))
    out.append((wav + noise).astype(np.float32))
    return out


def _safe_name(name: str) -> str:
    """Sanitize speaker name for use as a directory name. Empty if invalid."""
    cleaned = "".join(c for c in (name or "").strip() if c.isalnum() or c in "-_ ").strip()
    return cleaned


def _convert_to_wav(src: Path) -> Path:
    """Convert non-native audio to WAV via ffmpeg, fallback to soundfile."""
    import soundfile as sf

    tmp = Path(tempfile.mktemp(suffix=".wav"))
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-ar", "16000", "-ac", "1", tmp.name],
            capture_output=True, timeout=30,
        )
        if tmp.exists() and tmp.stat().st_size > 44:
            return tmp
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    try:
        data, sr = sf.read(str(src))
        sf.write(str(tmp), data, sr, format="WAV")
        if tmp.exists():
            return tmp
    except Exception:
        pass

    tmp.unlink(missing_ok=True)
    raise RuntimeError(f"Cannot decode {src.name} — install ffmpeg for webm support")


def _enforce_cap(speaker_dir: Path, max_samples: int = SAMPLE_CAP) -> None:
    """Delete oldest audio files in speaker_dir when count exceeds max_samples.
    Only counts files whose extension is in AUDIO_EXTENSIONS.
    Non-audio files (e.g. _config.json) are ignored and never deleted.
    """
    audio_files = sorted(
        [f for f in speaker_dir.iterdir() if f.suffix.lower() in AUDIO_EXTENSIONS],
        key=lambda f: f.stat().st_mtime,
    )
    excess = len(audio_files) - max_samples
    for old_file in audio_files[:excess]:
        try:
            old_file.unlink()
        except OSError:
            pass


def _trim_audio_to_seconds(path: Path, max_seconds: float = SAMPLE_MAX_SECONDS) -> None:
    """Trim a WAV file to max_seconds in place. No-op for non-WAV or short files.
    Uses stdlib wave module — no external deps needed.
    """
    if path.suffix.lower() != ".wav":
        return
    try:
        with _wave.open(str(path), "r") as wf:
            sr = wf.getframerate()
            total_frames = wf.getnframes()
            max_frames = int(sr * max_seconds)
            if total_frames <= max_frames:
                return
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            wf.rewind()
            data = wf.readframes(max_frames)
        with _wave.open(str(path), "w") as wf:
            wf.setnchannels(n_channels)
            wf.setsampwidth(sampwidth)
            wf.setframerate(sr)
            wf.writeframes(data)
    except Exception:
        pass


class SpeakerIdentifier:
    """Identifies which registered speaker (if any) is talking."""

    def __init__(self, root_dir: Path):
        from resemblyzer import preprocess_wav

        self.root_dir = Path(root_dir)
        # Speaker-id runs on CPU by default: the embeddings are short clips and
        # cheap, and keeping it off the GPU frees ~0.5 GB VRAM for the larger
        # Whisper model (large-v3) on the 4 GB RTX 3050. Override with
        # SPEAKER_ID_DEVICE=cuda if VRAM is plentiful.
        device = os.environ.get("SPEAKER_ID_DEVICE", "cpu")
        self.encoder = make_encoder(device)
        self.default_threshold = float(
            os.environ.get("SPEAKER_DEFAULT_THRESHOLD", str(self.encoder.default_threshold))
        )
        self.match_margin = float(
            os.environ.get("SPEAKER_MATCH_MARGIN", str(self.encoder.default_margin))
        )
        # resemblyzer's preprocess_wav does loading + VAD trim + loudness norm;
        # reused for both encoders so embeddings only see voiced audio.
        self._preprocess_wav = preprocess_wav
        # name -> { "embeddings": [np.ndarray, ...], "threshold": float }
        self.speakers: dict[str, dict] = {}
        # persisted per-speaker thresholds: { name: threshold }
        self._thresholds: dict[str, float] = {}
        # background voices for the cohort gate (loaded from _cohort/, optional)
        self.cohort: list[np.ndarray] = []
        # text-dependent wake-word templates (loaded from _wake/, optional)
        self.wake_templates: list[np.ndarray] = []

        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._load_config()
        self._load_all()

    # ----------------------------------------------------------------- config --

    @property
    def config_path(self) -> Path:
        return self.root_dir / CONFIG_FILENAME

    def _load_config(self) -> None:
        self._thresholds = {}
        if not self.config_path.exists():
            return
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            for name, cfg in (raw.get("speakers") or {}).items():
                thr = cfg.get("threshold") if isinstance(cfg, dict) else None
                if isinstance(thr, (int, float)):
                    self._thresholds[name] = float(thr)
        except Exception as e:
            print(f"[speaker_id] failed to read {CONFIG_FILENAME}: {e}", flush=True)

    def _save_config(self) -> None:
        payload = {"speakers": {n: {"threshold": t} for n, t in self._thresholds.items()}}
        try:
            self.config_path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except Exception as e:
            print(f"[speaker_id] failed to write {CONFIG_FILENAME}: {e}", flush=True)

    def set_threshold(self, name: str, value: float) -> bool:
        """Persist a per-speaker threshold. Returns True if the speaker exists."""
        safe = _safe_name(name)
        if not safe:
            return False
        self._thresholds[safe] = float(value)
        if safe in self.speakers:
            self.speakers[safe]["threshold"] = float(value)
        self._save_config()
        return safe in self.speakers

    def _threshold_for(self, name: str) -> float:
        return self._thresholds.get(name, self.default_threshold)

    # ------------------------------------------------------------------- load --

    def _load_all(self) -> None:
        self.speakers.clear()
        if not self.root_dir.exists():
            return
        for subdir in sorted(self.root_dir.iterdir()):
            if not subdir.is_dir() or subdir.name.startswith("_"):
                continue
            embeddings = self._embeddings_for_dir(subdir)
            if embeddings:
                self.speakers[subdir.name] = {
                    "embeddings": embeddings,
                    "threshold": self._threshold_for(subdir.name),
                }
        cohort_dir = self.root_dir / COHORT_DIRNAME
        self.cohort = self._embeddings_for_dir(cohort_dir) if cohort_dir.is_dir() else []
        if self.cohort:
            print(f"[speaker_id] cohort gate active ({len(self.cohort)} voices)", flush=True)
        self.reload_wake()

    def reload_wake(self) -> int:
        """(Re)load the text-dependent wake-word templates from _wake/."""
        wake_dir = self.root_dir / WAKE_DIRNAME
        self.wake_templates = self._embeddings_for_dir(wake_dir) if wake_dir.is_dir() else []
        if self.wake_templates:
            print(
                f"[speaker_id] wake voiceprint active ({len(self.wake_templates)} templates, "
                f"threshold={WAKE_THRESHOLD})",
                flush=True,
            )
        return len(self.wake_templates)

    def _embeddings_for_dir(self, speaker_dir: Path) -> list[np.ndarray]:
        samples = [
            p for p in speaker_dir.iterdir()
            if p.is_file()
            and p.suffix.lower() in AUDIO_EXTENSIONS
            and not p.name.startswith("_")
        ]
        if not samples:
            return []

        embeddings: list[np.ndarray] = []
        labels: list[str] = []
        wavs_for_augment: list[np.ndarray] = []
        for sample_path in samples:
            try:
                if sample_path.suffix.lower() in NATIVE_EXTENSIONS:
                    wav = self._preprocess_wav(sample_path)
                else:
                    converted = _convert_to_wav(sample_path)
                    wav = self._preprocess_wav(converted)
                    converted.unlink(missing_ok=True)
            except Exception as e:
                print(f"[speaker_id] skipping {sample_path.name}: {e}", flush=True)
                continue
            if len(wav) < ENROLL_MIN_SAMPLES:
                continue
            emb = self.encoder.embed(wav)
            emb = emb / (np.linalg.norm(emb) + 1e-9)
            embeddings.append(emb)
            labels.append(sample_path.name)
            wavs_for_augment.append(wav)

        # The cohort is intentionally heterogeneous (many voices), so the
        # consistency filter only applies to per-speaker reference sets.
        dropped: list[int] = []
        if embeddings and speaker_dir.name != COHORT_DIRNAME:
            embeddings, dropped = filter_consistent(
                embeddings, self.encoder.ref_floor, labels,
                tag=f"'{speaker_dir.name}': ", return_dropped=True,
            )
            # Quarantine the dropped WAVs so the config UI can review/restore
            # them; otherwise they'd be re-scored (and re-dropped) every load.
            if dropped:
                rejected_dir = speaker_dir / REJECTED_DIRNAME
                rejected_dir.mkdir(exist_ok=True)
                for i in dropped:
                    src = speaker_dir / labels[i]
                    try:
                        if src.is_file():
                            src.rename(rejected_dir / src.name)
                    except Exception as e:
                        print(f"[speaker_id] quarantine failed for {src.name}: {e}", flush=True)

        # Augment surviving references with synthetic condition variants so the
        # set covers distance/reverb/noise shifts it was never recorded in.
        # Only the consistency-filter SURVIVORS are augmented (a junk ref's
        # variants would multiply the junk). Cohort stays raw.
        n_aug = 0
        if (AUGMENT_ENABLED and embeddings
                and speaker_dir.name != COHORT_DIRNAME):
            dropped_set = set(dropped)
            survivors = [w for i, w in enumerate(wavs_for_augment) if i not in dropped_set]
            for wav in survivors[:AUGMENT_MAX_BASE]:
                for var in augment_variants(wav):
                    try:
                        emb = self.encoder.embed(var)
                        embeddings.append(emb / (np.linalg.norm(emb) + 1e-9))
                        n_aug += 1
                    except Exception:
                        continue

        if embeddings:
            aug_note = f" +{n_aug} augmented" if n_aug else ""
            print(
                f"[speaker_id] '{speaker_dir.name}' loaded {len(embeddings) - n_aug} sample(s)"
                f"{aug_note} (threshold={self._threshold_for(speaker_dir.name):.2f})",
                flush=True,
            )
        return embeddings

    # ------------------------------------------------------------- management --

    def inject_speaker(self, name: str, embeddings: list, threshold: Optional[float] = None, merge: bool = True,
                       hidden: bool = False) -> None:
        """Inject pre-computed embeddings for a speaker (bypasses WAV loading).

        When merge=True (default) and the speaker already has WAV-loaded embeddings,
        the injected embeddings are prepended so the encrypted voiceprint always
        contributes to identification.

        hidden=True marks the speaker as management-invisible: identification
        still returns its name, but list_speakers() omits it so the owner's
        encrypted voiceprint never shows up in the config UI.

        Embeddings whose dimension doesn't match the active encoder are skipped:
        a voiceprint generated with a different encoder is useless (and would
        crash the dot products), so identification falls back to the WAV samples
        until the voiceprint is regenerated.
        """
        safe = _safe_name(name)
        if not safe or not embeddings:
            return
        if threshold is None:
            threshold = self.default_threshold
        new_embs = []
        skipped = 0
        for e in embeddings:
            arr = np.array(e, dtype=np.float32)
            if arr.shape[-1] != self.encoder.dim:
                skipped += 1
                continue
            new_embs.append(arr / (np.linalg.norm(arr) + 1e-9))
        if skipped:
            print(
                f"[speaker_id] '{safe}': skipped {skipped} injected embedding(s) with "
                f"dim mismatch (encoder={self.encoder.name} expects {self.encoder.dim}) — "
                "regenerate the voiceprint with scripts/create-voiceprint.sh",
                flush=True,
            )
        if not new_embs:
            return
        if merge and safe in self.speakers:
            existing = self.speakers[safe]["embeddings"]
            new_embs = new_embs + existing
        self.speakers[safe] = {
            "embeddings": new_embs,
            "threshold": self._thresholds.get(safe, threshold),
            "hidden": hidden,
        }

    def reload(self) -> int:
        self._load_config()
        self._load_all()
        return len(self.speakers)

    def save_sample(self, name: str, audio_bytes: bytes, ext: str = ".wav") -> Path:
        """Write audio_bytes as a new sample for speaker ``name``.

        Applies trim (WAV only) and FIFO cap after the write so the speaker
        directory stays within SAMPLE_CAP files and each sample is at most
        SAMPLE_MAX_SECONDS long.

        Returns the Path of the saved file.
        """
        safe = _safe_name(name)
        if not safe:
            raise ValueError(f"Invalid speaker name: {name!r}")
        speaker_dir = self.root_dir / safe
        speaker_dir.mkdir(parents=True, exist_ok=True)

        import time as _time
        timestamp = int(_time.time() * 1000)
        ext_clean = ext if ext.startswith(".") else f".{ext}"
        saved_path = speaker_dir / f"speaker-{timestamp}{ext_clean}"
        saved_path.write_bytes(audio_bytes)

        _trim_audio_to_seconds(saved_path)
        _enforce_cap(saved_path.parent)

        return saved_path

    def learn_sample(self, name: str, audio: np.ndarray, sr: int) -> bool:
        """Online adaptation: persist an accepted utterance as a new reference
        for ``name`` and update the live embedding set so recognition keeps
        improving as the owner talks. The seed embedding (index 0, the encrypted
        voiceprint) is always kept; older learned embeddings are evicted FIFO
        beyond LEARN_MAX_EMB. Rate-limited so a single monologue can't flood the
        cap. Returns True if a sample was added.
        """
        import time as _time
        safe = _safe_name(name)
        if not safe or safe not in self.speakers:
            return False
        now = _time.time()
        last = getattr(self, "_last_learn", {})
        if now - last.get(safe, 0.0) < LEARN_MIN_INTERVAL_S:
            return False

        # Embed with the SAME preprocessing path as identification.
        wav = self._preprocess_audio(audio, sr)
        emb = self._embedding_for_wav(wav)
        if emb is None:
            return False

        # Consistency gate: a learned sample must agree with the existing
        # references. Blocks the junk-feedback loop where one bad learned
        # sample (echo, TV) drags the reference set toward noise.
        refs = self.speakers[safe]["embeddings"]
        if refs:
            mean_sim = float(np.mean([np.dot(emb, r) for r in refs]))
            if mean_sim < self.encoder.ref_floor:
                print(
                    f"[speaker_id] learn rejected: inconsistent with references "
                    f"(mean-sim {mean_sim:.2f} < {self.encoder.ref_floor:.2f})",
                    flush=True,
                )
                return False

        # Persist to disk (survives restart, FIFO-capped by save_sample).
        try:
            import io, soundfile as sf
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV")
            self.save_sample(safe, buf.getvalue(), ".wav")
        except Exception as e:
            print(f"[speaker_id] learn persist failed: {e}", flush=True)

        # Update live embeddings: keep seed at index 0 + most recent learned.
        # Build-and-swap (not in-place append): learning now runs on a background
        # thread while identification iterates this list — an atomic ref swap
        # keeps concurrent readers on a consistent snapshot.
        embs = list(self.speakers[safe]["embeddings"])
        embs.append(emb)
        if len(embs) > LEARN_MAX_EMB:
            # drop the oldest LEARNED embedding (index 1), preserve the seed.
            del embs[1]
        self.speakers[safe]["embeddings"] = embs
        last[safe] = now
        self._last_learn = last
        return True

    def enroll_speaker(self, name: str) -> bool:
        """Recompute embeddings for a single speaker. Returns True if loaded."""
        safe = _safe_name(name)
        if not safe:
            return False
        speaker_dir = self.root_dir / safe
        if not speaker_dir.exists() or not speaker_dir.is_dir():
            self.speakers.pop(safe, None)
            return False
        embeddings = self._embeddings_for_dir(speaker_dir)
        if not embeddings:
            self.speakers.pop(safe, None)
            return False
        self.speakers[safe] = {
            "embeddings": embeddings,
            "threshold": self._threshold_for(safe),
        }
        return True

    def remove_speaker(self, name: str) -> bool:
        safe = _safe_name(name)
        if not safe:
            return False
        data = self.speakers.get(safe)
        if data and data.get("hidden"):
            # The injected owner voiceprint is not a user-manageable profile;
            # stale UI state must not be able to evict it from memory.
            print(f"[speaker_id] refusing to remove hidden speaker '{safe}'", flush=True)
            return False
        speaker_dir = self.root_dir / safe
        if speaker_dir.exists():
            try:
                shutil.rmtree(speaker_dir)
            except Exception as e:
                print(f"[speaker_id] failed to remove {safe}: {e}", flush=True)
                return False
        existed = self.speakers.pop(safe, None) is not None
        if safe in self._thresholds:
            self._thresholds.pop(safe, None)
            self._save_config()
        return existed

    def list_speakers(self) -> list[dict]:
        out = []
        # Hidden speakers (the injected owner voiceprint) are excluded entirely:
        # they identify normally but never appear in management/UI listings.
        hidden = {n for n, d in self.speakers.items() if d.get("hidden")}
        # Union of loaded speakers and on-disk profile dirs, so freshly created
        # (still empty) profiles show up in the UI instead of vanishing.
        names = [n for n in self.speakers.keys() if n not in hidden]
        if self.root_dir.exists():
            for d in sorted(self.root_dir.iterdir()):
                if (d.is_dir() and not d.name.startswith("_")
                        and d.name not in names and d.name not in hidden):
                    names.append(d.name)
        for name in names:
            data = self.speakers.get(name)
            speaker_dir = self.root_dir / name
            count = 0
            rejected = 0
            if speaker_dir.exists():
                count = sum(
                    1 for p in speaker_dir.iterdir()
                    if p.is_file()
                    and p.suffix.lower() in AUDIO_EXTENSIONS
                    and not p.name.startswith("_")
                )
                rejected_dir = speaker_dir / REJECTED_DIRNAME
                if rejected_dir.is_dir():
                    rejected = sum(
                        1 for p in rejected_dir.iterdir()
                        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
                    )
            out.append({
                "name": name,
                "samples": count,
                "threshold": data["threshold"] if data else self._threshold_for(name),
                # WAV files + voiceprint seed can diverge from disk count;
                # active_refs = what actually matches audio right now.
                "active_refs": len(data["embeddings"]) if data else 0,
                "rejected": rejected,
            })
        return out

    # ---------------------------------------------------------- identification --

    def _embedding_for_wav(self, wav: np.ndarray) -> Optional[np.ndarray]:
        if len(wav) < IDENT_MIN_SAMPLES:
            return None
        emb = self.encoder.embed(wav)
        return emb / (np.linalg.norm(emb) + 1e-9)

    def identify_file(self, audio_path: str) -> tuple[Optional[str], float]:
        wav = self._preprocess_wav(Path(audio_path))
        return self._identify_wav(wav)

    def _preprocess_audio(self, audio: np.ndarray, sr: int) -> np.ndarray:
        """In-memory preprocess (VAD trim + loudness norm) — same pipeline as the
        file path, minus the tempfile round-trip that used to cost disk IO on
        every identification."""
        return self._preprocess_wav(
            np.asarray(audio, dtype=np.float32), source_sr=sr
        )

    def identify_audio(self, audio: np.ndarray, sr: int,
                       thr_offset: float = 0.0) -> tuple[Optional[str], float]:
        wav = self._preprocess_audio(audio, sr)
        return self._identify_wav(wav, thr_offset=thr_offset)

    def match_wake(self, audio: np.ndarray, sr: int) -> tuple[Optional[str], float]:
        """Text-dependent match against the owner's wake-word templates.

        For utterances too short for the text-independent path (< ~1s): the
        phonetic content is fixed ("jarvis"), so the embedding is comparable
        even from ~0.4s of speech. Cohort gate still applies. Returns
        (owner_marker, score) — the caller maps the marker to the owner name.
        """
        if not self.wake_templates:
            return None, 0.0
        wav = self._preprocess_audio(audio, sr)
        if len(wav) < WAKE_MIN_SAMPLES:
            return None, 0.0
        emb = self.encoder.embed(wav)
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        sims = sorted((float(np.dot(emb, t)) for t in self.wake_templates), reverse=True)
        k = min(MATCH_TOPK, len(sims))
        score = sum(sims[:k]) / k
        if score < WAKE_THRESHOLD:
            return None, score
        # Cohort gate — same anti-noise protection as the regular path.
        if self.cohort:
            cohort_sims = sorted((float(np.dot(emb, c)) for c in self.cohort), reverse=True)
            ck = min(MATCH_TOPK, len(cohort_sims))
            if (score - sum(cohort_sims[:ck]) / ck) < COHORT_MARGIN:
                return None, score
        return "__wake__", score

    def _identify_wav(self, wav: np.ndarray, thr_offset: float = 0.0) -> tuple[Optional[str], float]:
        """Full-utterance match, refined by per-window majority vote on long clips.

        One embedding over a long utterance blends everything in it: if two
        people spoke, the blend matches nobody (or worse, the wrong person).
        Windowed voting catches that — a majority of windows voting for a
        DIFFERENT speaker than the full-clip match means mixed audio, reject.
        A failed full-clip match can also be rescued when the windows agree.
        """
        # Duration-adaptive threshold: short utterances yield noisier embeddings,
        # so they get a discount on the acceptance threshold, compensated by a
        # stricter cohort margin (noise can't ride the discount in). External
        # thr_offset (trust continuity) stacks on top.
        dur_s = len(wav) / SAMPLE_RATE
        cohort_extra = 0.0
        if dur_s < SHORT_UTTERANCE_S:
            thr_offset += SHORT_THR_OFFSET
            cohort_extra = SHORT_COHORT_EXTRA
        elif dur_s < MID_UTTERANCE_S:
            thr_offset += MID_THR_OFFSET
            cohort_extra = SHORT_COHORT_EXTRA

        emb = self._embedding_for_wav(wav)
        name, score = self._match(emb, thr_offset=thr_offset, cohort_extra=cohort_extra)

        if len(wav) < MULTI_MIN_S * SAMPLE_RATE:
            return name, score

        window = int(WINDOW_S * SAMPLE_RATE)
        hop = int(HOP_S * SAMPLE_RATE)
        votes: dict[Optional[str], list[float]] = {}
        n_windows = 0
        for start in range(0, len(wav) - window + 1, hop):
            chunk = wav[start:start + window]
            wemb = self.encoder.embed(chunk)
            wemb = wemb / (np.linalg.norm(wemb) + 1e-9)
            # A window is a 1.5s clip — score it like one: same duration
            # discount + stricter cohort margin a 1.5s utterance would get
            # (matching at the full threshold made every window of a slightly
            # degraded clip fail, vetoing valid full-clip matches).
            wname, wscore = self._match(
                wemb,
                thr_offset=thr_offset + MID_THR_OFFSET,
                cohort_extra=max(cohort_extra, SHORT_COHORT_EXTRA),
            )
            votes.setdefault(wname, []).append(wscore)
            n_windows += 1
        if not n_windows:
            return name, score

        top_name, top_scores = max(
            votes.items(), key=lambda kv: (len(kv[1]), sum(kv[1]) / len(kv[1]))
        )
        majority = len(top_scores) * 2 > n_windows

        if majority and top_name is not None:
            vote_score = sum(top_scores) / len(top_scores)
            if name is None:
                # Full-clip embedding failed but the windows consistently agree.
                return top_name, vote_score
            if top_name == name:
                return name, max(score, vote_score)
            # Windows majority-vote a different speaker than the blend — mixed
            # audio or a speaker change mid-utterance. Don't guess.
            return None, score
        if majority and top_name is None and name is not None:
            # Most windows matched nobody. A true mixed-audio blend shows
            # windows voting a DIFFERENT speaker; uniformly weak windows with
            # ZERO other-speaker votes is what far-field/quiet speech looks
            # like — and the full-clip match already passed threshold, margin
            # and cohort on the complete utterance (more audio, more reliable
            # embedding). Only veto when some window voted for someone else.
            if any(n is not None and n != name for n in votes):
                return None, score
            return name, score
        return name, score

    def _match(self, emb: Optional[np.ndarray], thr_offset: float = 0.0,
               cohort_extra: float = 0.0) -> tuple[Optional[str], float]:
        """Match one embedding against all speakers. When a candidate is
        rejected, SPEAKER_DEBUG=1 (default) logs WHICH gate fired and by how
        much — without this, a silent None is undebuggable in production."""
        if emb is None or not self.speakers:
            return None, 0.0

        # Score each speaker by the MEAN of its top-K cosine similarities, so a
        # noise clip that grazes a single reference can't fake a high score.
        scored: list[tuple[str, float, float]] = []
        for name, data in self.speakers.items():
            sims = sorted(
                (float(np.dot(emb, owner_emb)) for owner_emb in data["embeddings"]),
                reverse=True,
            )
            if not sims:
                continue
            k = min(MATCH_TOPK, len(sims))
            best = sum(sims[:k]) / k
            scored.append((name, best, data["threshold"]))
        if not scored:
            return None, 0.0

        scored.sort(key=lambda x: x[1], reverse=True)
        best_name, best_score, best_thr = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else 0.0

        # Reject if below this speaker's own threshold (offset-adjusted; the
        # floor keeps trust/duration discounts from stacking into absurdity).
        eff_thr = max(0.35, best_thr + thr_offset)
        if best_score < eff_thr:
            if DEBUG_REJECT:
                print(
                    f"[speaker_id] reject thr: {best_name} {best_score:.3f} < {eff_thr:.3f}",
                    flush=True,
                )
            return None, best_score
        # Reject ambiguous matches: top two speakers too close together.
        if (best_score - second_score) < self.match_margin:
            if DEBUG_REJECT:
                print(
                    f"[speaker_id] reject margin: {best_name} {best_score:.3f} "
                    f"vs 2nd {second_score:.3f} (margin {self.match_margin:.2f})",
                    flush=True,
                )
            return None, best_score
        # Cohort gate: an utterance that scores nearly as high against generic
        # background voices as against the matched speaker is not a real match.
        if self.cohort:
            cohort_sims = sorted(
                (float(np.dot(emb, c)) for c in self.cohort), reverse=True
            )
            k = min(MATCH_TOPK, len(cohort_sims))
            cohort_score = sum(cohort_sims[:k]) / k
            if (best_score - cohort_score) < (COHORT_MARGIN + cohort_extra):
                if DEBUG_REJECT:
                    print(
                        f"[speaker_id] reject cohort: {best_name} {best_score:.3f} "
                        f"- cohort {cohort_score:.3f} < {COHORT_MARGIN + cohort_extra:.3f}",
                        flush=True,
                    )
                return None, best_score

        return best_name, best_score
