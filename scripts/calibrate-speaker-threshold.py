#!/usr/bin/env python3
"""Calibrate a speaker's identification threshold from real audio.

Scores genuine clips (the target speaker) and impostor clips (anyone else:
family, TV, YouTube voices) against the enrolled references, sweeps the
threshold, and reports the EER (equal error rate) point — the threshold where
false accepts and false rejects balance.

IMPORTANT: genuine clips must be FRESH recordings, not the same WAVs already
enrolled under samples/speaker/<name>/ — scoring a clip against itself inflates
genuine scores and pushes the threshold too high.

Usage:
    backend/voice/python/.venv/bin/python scripts/calibrate-speaker-threshold.py \
        --speaker santiago \
        --genuine ~/voz/genuinas/ \
        --impostor ~/voz/otros/ [--impostor ~/voz/tv/] \
        [--apply]        # PUT the recommended threshold to the running service

Impostor clips from the other enrolled speaker dirs are included automatically.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYDIR = HERE.parent / "backend" / "voice" / "python"
SAMPLES_ROOT = HERE.parent / "backend" / "voice" / "samples" / "speaker"
sys.path.insert(0, str(PYDIR))

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}


def collect(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        p = p.expanduser()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
            out.append(p)
        elif p.is_dir():
            out.extend(f for f in sorted(p.iterdir()) if f.suffix.lower() in AUDIO_EXTS)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--speaker", required=True, help="enrolled speaker to calibrate")
    ap.add_argument("--genuine", action="append", required=True, type=Path,
                    help="dir/file with FRESH clips of the target speaker")
    ap.add_argument("--impostor", action="append", default=[], type=Path,
                    help="dir/file with clips of OTHER voices (repeatable)")
    ap.add_argument("--samples-root", type=Path, default=SAMPLES_ROOT)
    ap.add_argument("--apply", action="store_true",
                    help="PUT the recommended threshold to http://localhost:8790")
    args = ap.parse_args()

    import numpy as np
    from speaker_id import SpeakerIdentifier, MATCH_TOPK

    si = SpeakerIdentifier(args.samples_root)
    if args.speaker not in si.speakers:
        print(f"Speaker '{args.speaker}' not enrolled under {args.samples_root}")
        return 1
    refs = si.speakers[args.speaker]["embeddings"]
    print(f"Speaker '{args.speaker}': {len(refs)} reference embeddings "
          f"(encoder={si.encoder.name}, current threshold="
          f"{si.speakers[args.speaker]['threshold']:.2f})")

    def score(path: Path) -> float | None:
        """Top-K mean cosine similarity vs the target's references (raw,
        pre-threshold — mirrors SpeakerIdentifier._match scoring)."""
        try:
            wav = si._preprocess_wav(path)
            emb = si._embedding_for_wav(wav)
        except Exception as e:
            print(f"  skip {path.name}: {e}")
            return None
        if emb is None:
            print(f"  skip {path.name}: too short (<1s voiced)")
            return None
        sims = sorted((float(np.dot(emb, r)) for r in refs), reverse=True)
        k = min(MATCH_TOPK, len(sims))
        return sum(sims[:k]) / k

    genuine_files = collect(args.genuine)
    impostor_paths = list(args.impostor)
    # Other enrolled speakers are free impostors.
    for other in si.speakers:
        if other != args.speaker:
            impostor_paths.append(args.samples_root / other)
    impostor_files = collect(impostor_paths)

    enrolled_dir = (args.samples_root / args.speaker).resolve()
    overlap = [f for f in genuine_files if f.resolve().parent == enrolled_dir]
    if overlap:
        print(f"WARNING: {len(overlap)} genuine clip(s) are the enrolled samples "
              "themselves — scores will be inflated. Use fresh recordings.")

    print(f"\nScoring {len(genuine_files)} genuine clips...")
    gen = [s for s in (score(f) for f in genuine_files) if s is not None]
    print(f"Scoring {len(impostor_files)} impostor clips...")
    imp = [s for s in (score(f) for f in impostor_files) if s is not None]

    if len(gen) < 3 or len(imp) < 3:
        print(f"\nNot enough scores (genuine={len(gen)}, impostor={len(imp)}; "
              "need >=3 each)")
        return 1

    gmin, gmean, gmax = min(gen), sum(gen) / len(gen), max(gen)
    imin, imean, imax = min(imp), sum(imp) / len(imp), max(imp)
    print(f"\nGenuine : n={len(gen)}  min={gmin:.3f}  mean={gmean:.3f}  max={gmax:.3f}")
    print(f"Impostor: n={len(imp)}  min={imin:.3f}  mean={imean:.3f}  max={imax:.3f}")

    # Threshold sweep: FAR = impostors accepted, FRR = genuines rejected.
    best_thr, best_gap = None, 1e9
    print("\n  thr    FAR     FRR")
    for i in range(20, 96):
        thr = i / 100.0
        far = sum(1 for s in imp if s >= thr) / len(imp)
        frr = sum(1 for s in gen if s < thr) / len(gen)
        gap = abs(far - frr)
        marker = ""
        if gap < best_gap:
            best_thr, best_gap = thr, gap
            marker = "  <- EER so far"
        if i % 5 == 0 or marker:
            print(f"  {thr:.2f}  {far:5.1%}  {frr:5.1%}{marker}")

    # Recommend slightly above EER: for a voice assistant a false accept
    # (stranger commands Jarvis) costs more than a false reject (repeat it).
    rec = round(min(best_thr + 0.02, 0.95), 2)
    print(f"\nEER threshold ≈ {best_thr:.2f}")
    print(f"Recommended  = {rec:.2f}  (EER + 0.02 margin, favors rejecting strangers)")

    if imax >= gmin:
        print(f"NOTE: score overlap (impostor max {imax:.3f} >= genuine min {gmin:.3f}) — "
              "no threshold is perfect. More/better enrollment samples help.")

    if args.apply:
        body = json.dumps({"name": args.speaker, "threshold": rec}).encode()
        req = urllib.request.Request(
            "http://localhost:8790/speaker-id/threshold", data=body,
            headers={"Content-Type": "application/json"}, method="PUT",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                print(f"\nApplied: {r.read().decode()}")
        except Exception as e:
            print(f"\nFailed to apply (service running?): {e}")
            return 1
    else:
        print(f"\nApply with:  --apply   (or curl -X PUT http://localhost:8790/speaker-id/threshold "
              f"-H 'Content-Type: application/json' -d '{{\"name\":\"{args.speaker}\",\"threshold\":{rec}}}')")
    return 0


if __name__ == "__main__":
    sys.exit(main())
