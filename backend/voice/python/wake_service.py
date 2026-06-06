#!/usr/bin/env python3
"""
Jarvis Wake Word Daemon — jarvis-wake.service

Opens a 16kHz mono PyAudio stream, runs openWakeWord ONNX model in a loop.
On detection (confidence >= THRESHOLD), POSTs to the Jarvis backend.

Environment variables:
  JARVIS_BACKEND_URL   Backend base URL (default: http://127.0.0.1:8788)
  WAKE_THRESHOLD       Minimum confidence to fire (default: 0.5)
  WAKE_MODEL           openWakeWord model name (default: hey_jarvis_v0.1)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

import aiohttp
import numpy as np
import pyaudio
import uvicorn
from fastapi import FastAPI
from openwakeword.model import Model

logging.basicConfig(level=logging.INFO, format="[wake] %(levelname)s %(message)s")
log = logging.getLogger("wake_service")

# ── Config ────────────────────────────────────────────────────────────────────
BACKEND_URL = os.getenv("JARVIS_BACKEND_URL", "http://127.0.0.1:8788")
WAKE_ENDPOINT = f"{BACKEND_URL}/api/jarvis/wake-detected"
THRESHOLD = float(os.getenv("WAKE_THRESHOLD", "0.5"))
MODEL_NAME = os.getenv("WAKE_MODEL", "hey_jarvis_v0.1")

SAMPLE_RATE = 16000
CHUNK = 1280  # 80ms at 16kHz — openWakeWord expects 80ms frames
COOLDOWN_S = 2.0  # minimum seconds between consecutive detections

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="Jarvis Wake Service")
_oww_model: Optional[Model] = None


@app.get("/health")
async def health():
    return {"ok": True, "model": MODEL_NAME, "threshold": THRESHOLD, "loaded": _oww_model is not None}


# ── Mic loop ──────────────────────────────────────────────────────────────────

async def _post_wake(session: aiohttp.ClientSession, confidence: float) -> None:
    """Fire-and-forget POST to the backend wake endpoint."""
    try:
        payload = {"confidence": float(confidence), "ts": time.time()}
        async with session.post(
            WAKE_ENDPOINT, json=payload, timeout=aiohttp.ClientTimeout(total=3)
        ) as resp:
            log.info("wake -> backend  confidence=%.3f  http=%d", confidence, resp.status)
    except Exception as exc:
        log.warning("wake POST failed: %s", exc)


async def _mic_loop() -> None:
    """Open PyAudio mic, feed chunks to openWakeWord, fire on detection."""
    log.info("opening mic  rate=%d  chunk=%d  model=%s", SAMPLE_RATE, CHUNK, MODEL_NAME)
    pa = pyaudio.PyAudio()
    stream = pa.open(
        rate=SAMPLE_RATE,
        channels=1,
        format=pyaudio.paInt16,
        input=True,
        frames_per_buffer=CHUNK,
    )

    last_fire = 0.0

    async with aiohttp.ClientSession() as session:
        log.info("mic loop started — listening for '%s'", MODEL_NAME)
        while True:
            raw = stream.read(CHUNK, exception_on_overflow=False)
            chunk = np.frombuffer(raw, dtype=np.int16)

            preds = _oww_model.predict(chunk)
            for ww_name, confidence in preds.items():
                if confidence >= THRESHOLD:
                    now = time.time()
                    if now - last_fire >= COOLDOWN_S:
                        last_fire = now
                        asyncio.create_task(_post_wake(session, confidence))
                    break

            await asyncio.sleep(0)


@app.on_event("startup")
async def startup() -> None:
    global _oww_model
    log.info("loading openWakeWord model: %s", MODEL_NAME)
    _oww_model = Model(wakeword_models=[MODEL_NAME], inference_framework="onnx")
    log.info("model loaded — starting mic loop")
    asyncio.create_task(_mic_loop())


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8791, log_level="info")
