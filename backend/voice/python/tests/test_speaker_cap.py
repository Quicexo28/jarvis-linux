"""
Tests for speaker_id.py FIFO cap and audio trim helpers.
Run from jarvis-linux root: python -m pytest backend/voice/python/tests/ -v
"""

import sys
import time
import struct
import wave
from pathlib import Path

import pytest

# Make speaker_id importable
sys.path.insert(0, str(Path(__file__).parent.parent))

from speaker_id import _enforce_cap, _trim_audio_to_seconds


def _make_wav(path: Path, duration_seconds: float, sample_rate: int = 16000) -> Path:
    n_samples = int(sample_rate * duration_seconds)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
    return path


def test_enforce_cap_does_nothing_when_under_limit(tmp_path):
    for i in range(10):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 10


def test_enforce_cap_deletes_oldest_when_over_limit(tmp_path):
    for i in range(51):
        p = tmp_path / f"sample_{i:03d}.wav"
        _make_wav(p, 1.0)
        p.touch()
        time.sleep(0.01)
    _enforce_cap(tmp_path, max_samples=50)
    remaining = sorted(tmp_path.glob("*.wav"))
    assert len(remaining) == 50
    assert not (tmp_path / "sample_000.wav").exists()
    assert (tmp_path / "sample_050.wav").exists()


def test_enforce_cap_exactly_at_limit(tmp_path):
    for i in range(50):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 50


def test_enforce_cap_skips_non_audio_files(tmp_path):
    (tmp_path / "_config.json").write_text("{}")
    for i in range(50):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 50
    assert (tmp_path / "_config.json").exists()


def test_trim_audio_short_file_unchanged(tmp_path):
    p = _make_wav(tmp_path / "short.wav", 2.0)
    original_size = p.stat().st_size
    _trim_audio_to_seconds(p, max_seconds=5.0)
    assert p.stat().st_size == original_size


def test_trim_audio_long_file_trimmed(tmp_path):
    import soundfile as sf
    p = _make_wav(tmp_path / "long.wav", 8.0)
    _trim_audio_to_seconds(p, max_seconds=5.0)
    data, sr = sf.read(str(p))
    duration = len(data) / sr
    assert duration <= 5.1


def test_trim_audio_exactly_at_limit_unchanged(tmp_path):
    p = _make_wav(tmp_path / "exact.wav", 5.0)
    original_size = p.stat().st_size
    _trim_audio_to_seconds(p, max_seconds=5.0)
    assert p.stat().st_size == original_size
