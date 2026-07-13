#!/usr/bin/env python3
"""Enroll Jarvis's own Edge-TTS voice as a NEGATIVE speaker ("jarvis_tts").

Why: the speaker-ID owner voiceprint can be fooled by Jarvis's own voice played
back through the mic (echo) — especially when tones are similar. By enrolling the
exact TTS voice as a decoy speaker, identification lands on "jarvis_tts" instead
of the owner, and stt_service forces its confidence to 0 → the loop can't feed on
itself. Run once (and again if you change EDGE_TTS_VOICE).

    backend/voice/python/.venv/bin/python scripts/enroll-jarvis-voice.py

Then reload:  curl -X POST http://localhost:8790/speaker-id/reload
"""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import edge_tts

VOICE = os.environ.get("EDGE_TTS_VOICE", "en-US-AndrewMultilingualNeural")
RATE = os.environ.get("EDGE_TTS_RATE", "-8%")
PITCH = os.environ.get("EDGE_TTS_PITCH", "-2Hz")

HERE = Path(__file__).resolve().parent.parent
OUT_DIR = HERE / "backend" / "voice" / "samples" / "speaker" / "jarvis_tts"

# Varied phrases (the languages Jarvis actually speaks) so the embedding captures
# the voice across phonetic contexts, not one sentence.
PHRASES = [
    "Hola, soy Jarvis. Estoy listo para ayudarte con lo que necesites.",
    "He revisado el sistema y todo funciona correctamente en este momento.",
    "Voy a programar un recordatorio para ti dentro de quince minutos.",
    "La temperatura exterior es agradable y el cielo está despejado hoy.",
    "Claro, puedo abrir la vista del plano y mostrarte la habitación principal.",
    "He guardado tus cambios y sincronizado la información con la nube.",
    "Permíteme un momento mientras proceso tu solicitud por completo.",
    "Entendido, detengo la reproducción y quedo a la espera de tu próxima orden.",
    "The current operation finished without any errors at all.",
    "Let me know if you want me to continue with the next step now.",
]


async def synth(text: str, dst_mp3: Path) -> None:
    comm = edge_tts.Communicate(text, voice=VOICE, rate=RATE, pitch=PITCH)
    await comm.save(str(dst_mp3))


def to_wav(src_mp3: Path, dst_wav: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-loglevel", "quiet", "-y", "-i", str(src_mp3),
         "-ar", "16000", "-ac", "1", str(dst_wav)],
        check=True,
    )


async def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[enroll] voice={VOICE} -> {OUT_DIR}")
    for i, text in enumerate(PHRASES):
        mp3 = OUT_DIR / f"_tmp-{i}.mp3"
        wav = OUT_DIR / f"jarvis-{i:02d}.wav"
        try:
            await synth(text, mp3)
            to_wav(mp3, wav)
            print(f"[enroll] {wav.name}  ({text[:40]}...)")
        finally:
            mp3.unlink(missing_ok=True)
    print(f"[enroll] done: {len(PHRASES)} samples in {OUT_DIR}")
    print("[enroll] reload STT:  curl -X POST http://localhost:8790/speaker-id/reload")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
