"""
Pre-render bridge filler WAVs using the running TTS sidecar (XTTS or
CosyVoice — same WS protocol). Output goes to
`backend/voice/cache/fillers/<name>.wav`.

Run once after install, and again whenever the voice reference changes
(so the filler timbre matches the cloned voice).

Usage:
    .venv\\Scripts\\python.exe render_fillers.py [--url ws://127.0.0.1:8789/synthesize/ws]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import wave
from pathlib import Path

import numpy as np

try:
    import websockets
except ImportError:
    print('[render] websockets package missing — pip install websockets', file=sys.stderr, flush=True)
    sys.exit(1)


HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / 'cache' / 'fillers'

FILLERS = {
    'filler-think': 'Permíteme pensar un momento.',
    'filler-search': 'Estoy buscando eso.',
    'filler-second': 'Dame un segundo.',
    'filler-noted': 'Listo, anotado.',
}


async def synth_one(url: str, name: str, text: str, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    samples: list[bytes] = []
    sample_rate = 24000
    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({'text': text, 'lang': 'es', 'fx': True}))
        while True:
            try:
                msg = await ws.recv()
            except websockets.ConnectionClosed:
                break
            if isinstance(msg, bytes):
                samples.append(msg)
                continue
            try:
                obj = json.loads(msg)
            except Exception:
                continue
            if obj.get('type') == 'start':
                sample_rate = int(obj.get('sr', sample_rate))
            elif obj.get('type') == 'end':
                break
            elif obj.get('type') == 'error':
                raise RuntimeError(f'tts error for {name}: {obj.get("error")}')

    if not samples:
        raise RuntimeError(f'no audio received for {name}')
    pcm = np.frombuffer(b''.join(samples), dtype=np.float32)
    pcm = np.clip(pcm, -1.0, 1.0)
    pcm_i16 = (pcm * 32767.0).astype(np.int16)

    out_path = out_dir / f'{name}.wav'
    with wave.open(str(out_path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_i16.tobytes())
    duration = len(pcm) / sample_rate
    print(f'[render] {name} ({duration:.2f}s) -> {out_path}', flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=os.environ.get('TTS_WS_URL', 'ws://127.0.0.1:8789/synthesize/ws'))
    ap.add_argument('--out-dir', default=str(OUT_DIR))
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    print(f'[render] target dir: {out_dir}', flush=True)
    print(f'[render] sidecar: {args.url}', flush=True)

    for name, text in FILLERS.items():
        try:
            await synth_one(args.url, name, text, out_dir)
        except Exception as e:
            print(f'[render] FAILED {name}: {e}', file=sys.stderr, flush=True)


if __name__ == '__main__':
    asyncio.run(main())
