"""
Bake the owner's voiceprint into the app.

Reads the owner's reference WAV samples, computes resemblyzer embeddings, and
writes owner_voiceprint.json next to this file. That file becomes the SINGLE
source of truth for "is this the owner" — independent of the samples dir,
profile names, or any env var. Re-run this only to re-enroll the owner.

Usage:
    .venv/bin/python make_owner_voiceprint.py [SAMPLES_DIR]

Default SAMPLES_DIR: ./samples/speaker/Santiago (relative to backend/voice).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav

import dpapi_util

HERE = Path(__file__).resolve().parent
# Encrypted at rest (DPAPI, current Windows user). No plaintext embedding ships.
OUT_PATH = HERE / "owner_voiceprint.enc"
LEGACY_PLAIN = HERE / "owner_voiceprint.json"
DEFAULT_SAMPLES = HERE.parent / "samples" / "speaker" / "Santiago"

# Floor for the accept threshold, so a few similar-sounding samples can't drive
# the gate down to something easily spoofed.
THRESHOLD_FLOOR = 0.72
# How far below the worst genuine self-match we set the accept threshold.
THRESHOLD_MARGIN = 0.03


def main() -> int:
    samples_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SAMPLES
    if not samples_dir.is_dir():
        print(f"ERROR: samples dir not found: {samples_dir}")
        return 1

    wavs = sorted(p for p in samples_dir.iterdir() if p.suffix.lower() == ".wav")
    if not wavs:
        print(f"ERROR: no .wav samples in {samples_dir}")
        return 1

    print(f"Loading {len(wavs)} sample(s) from {samples_dir}")
    encoder = VoiceEncoder()
    embeddings: list[np.ndarray] = []
    for w in wavs:
        wav = preprocess_wav(w)
        emb = encoder.embed_utterance(wav)
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        embeddings.append(emb)
        print(f"  + {w.name}")

    embs = np.vstack(embeddings)

    # Self-similarity: for each sample, its best cosine against the OTHER samples.
    # The minimum of these is the worst genuine match we must still accept.
    worst_self = 1.0
    if len(embeddings) > 1:
        sims = embs @ embs.T
        np.fill_diagonal(sims, -1.0)
        per_sample_best = sims.max(axis=1)
        worst_self = float(per_sample_best.min())
        print(f"Self-similarity: min={worst_self:.3f} mean={float(per_sample_best.mean()):.3f}")

    threshold = max(THRESHOLD_FLOOR, round(worst_self - THRESHOLD_MARGIN, 3))
    print(f"Accept threshold = {threshold:.3f}")

    payload = {
        "version": 1,
        "created": datetime.now(timezone.utc).isoformat(),
        "dim": int(embs.shape[1]),
        "threshold": threshold,
        "sample_count": len(embeddings),
        "embeddings": [e.astype(float).tolist() for e in embeddings],
    }
    blob = dpapi_util.encrypt(json.dumps(payload).encode("utf-8"))
    OUT_PATH.write_bytes(blob)
    # Never leave a plaintext copy behind.
    if LEGACY_PLAIN.exists():
        LEGACY_PLAIN.unlink()
        print("Removed legacy plaintext owner_voiceprint.json")
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes, DPAPI-encrypted)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
