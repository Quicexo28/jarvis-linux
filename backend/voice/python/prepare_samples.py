"""
Voice sample validation and preprocessing utility.

Usage:
  python prepare_samples.py [--dir ../samples]

Validates reference audio files for XTTS-v2 voice cloning:
- Checks duration (ideal: 6-15s)
- Checks sample rate (minimum: 16kHz)
- Trims leading/trailing silence
- Peak-normalizes to -1dB
- Reports quality metrics per file
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

AUDIO_EXTENSIONS = {'.wav', '.mp3', '.m4a', '.flac', '.ogg'}
MIN_DURATION_S = 3.0
IDEAL_MIN_S = 6.0
IDEAL_MAX_S = 15.0
MAX_DURATION_S = 30.0
MIN_SAMPLE_RATE = 16000
SILENCE_THRESHOLD_DB = -40.0
TARGET_PEAK_DB = -1.0


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """Load audio file, convert to mono float32."""
    audio, sr = sf.read(str(path), dtype='float32', always_2d=True)
    # Mix to mono if stereo
    if audio.shape[1] > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio[:, 0]
    return audio, sr


def trim_silence(audio: np.ndarray, sr: int, threshold_db: float = SILENCE_THRESHOLD_DB) -> np.ndarray:
    """Trim leading and trailing silence."""
    threshold_linear = 10 ** (threshold_db / 20.0)
    abs_audio = np.abs(audio)

    # Find first sample above threshold
    above = np.where(abs_audio > threshold_linear)[0]
    if len(above) == 0:
        return audio

    start = max(0, above[0] - int(0.05 * sr))  # 50ms padding
    end = min(len(audio), above[-1] + int(0.05 * sr))
    return audio[start:end]


def peak_normalize(audio: np.ndarray, target_db: float = TARGET_PEAK_DB) -> np.ndarray:
    """Normalize audio to target peak level."""
    peak = np.max(np.abs(audio))
    if peak < 1e-8:
        return audio
    target_linear = 10 ** (target_db / 20.0)
    return audio * (target_linear / peak)


def compute_snr(audio: np.ndarray, sr: int) -> float:
    """Estimate SNR by comparing RMS of loudest vs quietest 10% frames."""
    frame_len = int(0.025 * sr)  # 25ms frames
    hop = int(0.010 * sr)  # 10ms hop
    n_frames = max(1, (len(audio) - frame_len) // hop)

    rms_frames = []
    for i in range(n_frames):
        frame = audio[i * hop: i * hop + frame_len]
        rms = np.sqrt(np.mean(frame ** 2) + 1e-10)
        rms_frames.append(rms)

    rms_sorted = sorted(rms_frames)
    n10 = max(1, len(rms_sorted) // 10)
    noise_rms = np.mean(rms_sorted[:n10])
    signal_rms = np.mean(rms_sorted[-n10:])

    if noise_rms < 1e-10:
        return 60.0  # effectively infinite SNR
    return 20 * np.log10(signal_rms / noise_rms)


def validate_sample(path: Path) -> dict:
    """Validate a single audio sample and return metrics."""
    result = {
        'file': path.name,
        'valid': True,
        'warnings': [],
        'errors': [],
    }

    try:
        audio, sr = load_audio(path)
    except Exception as e:
        result['valid'] = False
        result['errors'].append(f'Cannot read file: {e}')
        return result

    duration = len(audio) / sr
    result['duration_s'] = round(duration, 2)
    result['sample_rate'] = sr

    # Duration checks
    if duration < MIN_DURATION_S:
        result['valid'] = False
        result['errors'].append(f'Too short ({duration:.1f}s < {MIN_DURATION_S}s minimum)')
    elif duration < IDEAL_MIN_S:
        result['warnings'].append(f'Short ({duration:.1f}s, ideal >= {IDEAL_MIN_S}s)')
    elif duration > MAX_DURATION_S:
        result['warnings'].append(f'Very long ({duration:.1f}s), will be truncated internally')
    elif duration > IDEAL_MAX_S:
        result['warnings'].append(f'Long ({duration:.1f}s, ideal <= {IDEAL_MAX_S}s)')

    # Sample rate check
    if sr < MIN_SAMPLE_RATE:
        result['warnings'].append(f'Low sample rate ({sr}Hz, minimum {MIN_SAMPLE_RATE}Hz)')

    # SNR estimation
    snr = compute_snr(audio, sr)
    result['snr_db'] = round(snr, 1)
    if snr < 15:
        result['warnings'].append(f'Low SNR ({snr:.1f}dB) — likely noisy')
    elif snr < 25:
        result['warnings'].append(f'Moderate SNR ({snr:.1f}dB) — some background noise')

    # Peak level
    peak_db = 20 * np.log10(np.max(np.abs(audio)) + 1e-10)
    result['peak_db'] = round(peak_db, 1)
    if peak_db < -20:
        result['warnings'].append(f'Very quiet (peak {peak_db:.1f}dB)')

    # Trim and normalize
    trimmed = trim_silence(audio, sr)
    trimmed_duration = len(trimmed) / sr
    silence_removed = duration - trimmed_duration
    result['trimmed_duration_s'] = round(trimmed_duration, 2)
    if silence_removed > 1.0:
        result['warnings'].append(f'{silence_removed:.1f}s of silence trimmed')

    normalized = peak_normalize(trimmed)
    result['processed_audio'] = normalized
    result['processed_sr'] = sr

    return result


def main():
    parser = argparse.ArgumentParser(description='Validate and preprocess XTTS voice samples')
    parser.add_argument('--dir', type=str, default=str(Path(__file__).parent.parent / 'samples'),
                        help='Directory containing audio samples')
    parser.add_argument('--output', type=str, default=None,
                        help='Output directory for processed files (optional)')
    args = parser.parse_args()

    samples_dir = Path(args.dir)
    if not samples_dir.exists():
        print(f'ERROR: Directory not found: {samples_dir}')
        sys.exit(1)

    files = [
        p for p in samples_dir.iterdir()
        if p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith('_')
    ]

    if not files:
        print(f'No audio files found in {samples_dir}')
        sys.exit(1)

    print(f'\n=== Voice Sample Validation Report ===')
    print(f'Directory: {samples_dir}')
    print(f'Files found: {len(files)}\n')

    all_valid = True
    for f in sorted(files):
        result = validate_sample(f)
        status = 'OK' if result['valid'] else 'FAIL'
        icon = '+' if result['valid'] else 'X'

        print(f'[{icon}] {result["file"]}')
        if 'duration_s' in result:
            print(f'    Duration: {result["duration_s"]}s | SR: {result.get("sample_rate", "?")}Hz | Peak: {result.get("peak_db", "?")}dB | SNR: {result.get("snr_db", "?")}dB')
        for w in result['warnings']:
            print(f'    WARNING: {w}')
        for e in result['errors']:
            print(f'    ERROR: {e}')
        print()

        if not result['valid']:
            all_valid = False

        # Write processed output if requested
        if args.output and result['valid'] and 'processed_audio' in result:
            out_dir = Path(args.output)
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f.with_suffix('.wav').name
            sf.write(str(out_path), result['processed_audio'], result['processed_sr'], format='WAV')
            print(f'    -> Saved processed: {out_path.name}')

    print('=' * 40)
    if all_valid:
        print('All samples valid. Ready for XTTS voice cloning.')
    else:
        print('Some samples have issues. Fix errors before using with XTTS.')

    sys.exit(0 if all_valid else 1)


if __name__ == '__main__':
    main()
