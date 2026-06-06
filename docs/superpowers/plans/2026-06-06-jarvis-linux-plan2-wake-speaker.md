# Jarvis Linux — Plan 2: Wake Word Daemon + Speaker Identity System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-on wake word daemon (openWakeWord) and a four-mode speaker identity system (OWNER/KNOWN/UNKNOWN/LOW_CONF) that gates intents and triggers UNKNOWN first-contact dialogue.

**Architecture:** `wake_service.py` (Python FastAPI on port 8791) listens on mic 24/7, POSTs to `/api/jarvis/wake-detected` on detection. A new `speakerContext.js` lib tracks current speaker mode (derived from `speakerConfidence` + `speakerName` already returned by the STT service). `speech.js` gates intents by mode: OWNER gets full access, KNOWN gets limited intents, UNKNOWN gets a random Iron Man opener and auto-enrollment flow, LOW_CONF gathers more audio. `speaker_id.py` gains a 50-sample FIFO cap (trim to 5s, delete oldest when over limit).

**Tech Stack:** Node.js ESM, Vitest, Python 3, openWakeWord (ONNX), resemblyzer, soundfile, PyAudio, pytest.

**Working directory:** All paths relative to `jarvis-linux/` root.

---

### Task 1: `speakerContext.js` — speaker mode state lib

Pure in-memory ESM module. Holds the current speaker mode between turns. Exported functions are the only way to read/write state — no global mutation from outside.

**Files:**
- Create: `backend/src/lib/speakerContext.js`
- Create: `backend/tests/speakerContext.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/speakerContext.unit.test.js`:

```js
import { test, expect, beforeEach } from 'vitest'
import {
  getSpeakerMode,
  getSpeakerName,
  setSpeakerMode,
  resetSession,
  filterIntentsByMode,
  incrementTurnCount,
  getTurnCount,
} from '../src/lib/speakerContext.js'

beforeEach(() => resetSession())

// ── Mode transitions ──────────────────────────────────────────────────────────

test('default mode after resetSession is UNKNOWN', () => {
  expect(getSpeakerMode()).toBe('UNKNOWN')
})

test('setSpeakerMode OWNER sets mode and name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  expect(getSpeakerMode()).toBe('OWNER')
  expect(getSpeakerName()).toBe('Santiago')
})

test('setSpeakerMode KNOWN sets mode and name', () => {
  setSpeakerMode('KNOWN', 'María')
  expect(getSpeakerMode()).toBe('KNOWN')
  expect(getSpeakerName()).toBe('María')
})

test('setSpeakerMode LOW_CONF clears name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  setSpeakerMode('LOW_CONF', null)
  expect(getSpeakerMode()).toBe('LOW_CONF')
  expect(getSpeakerName()).toBeNull()
})

test('resetSession resets mode to UNKNOWN and clears name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  resetSession()
  expect(getSpeakerMode()).toBe('UNKNOWN')
  expect(getSpeakerName()).toBeNull()
})

// ── Intent filtering ──────────────────────────────────────────────────────────

test('OWNER: all intents allowed', () => {
  expect(filterIntentsByMode('self_build', 'OWNER')).toBe(true)
  expect(filterIntentsByMode('chat', 'OWNER')).toBe(true)
  expect(filterIntentsByMode('file_delicate', 'OWNER')).toBe(true)
})

test('KNOWN: only limited intents allowed', () => {
  expect(filterIntentsByMode('chat', 'KNOWN')).toBe(true)
  expect(filterIntentsByMode('complex_task', 'KNOWN')).toBe(true)
  expect(filterIntentsByMode('self_build', 'KNOWN')).toBe(false)
  expect(filterIntentsByMode('file_delicate', 'KNOWN')).toBe(false)
})

test('UNKNOWN: same limited set as KNOWN', () => {
  expect(filterIntentsByMode('chat', 'UNKNOWN')).toBe(true)
  expect(filterIntentsByMode('self_build', 'UNKNOWN')).toBe(false)
})

test('LOW_CONF: no intents allowed', () => {
  expect(filterIntentsByMode('chat', 'LOW_CONF')).toBe(false)
  expect(filterIntentsByMode('self_build', 'LOW_CONF')).toBe(false)
})

// ── Turn counter (reinforcement scheduling) ───────────────────────────────────

test('incrementTurnCount returns incremented count', () => {
  expect(incrementTurnCount('Santiago')).toBe(1)
  expect(incrementTurnCount('Santiago')).toBe(2)
  expect(incrementTurnCount('María')).toBe(1) // separate counter per speaker
})

test('getTurnCount returns 0 for unknown speaker', () => {
  expect(getTurnCount('Desconocido')).toBe(0)
})

test('resetSession clears turn counts', () => {
  incrementTurnCount('Santiago')
  incrementTurnCount('Santiago')
  resetSession()
  expect(getTurnCount('Santiago')).toBe(0)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test -- speakerContext.unit
```

Expected: `Cannot find module '../src/lib/speakerContext.js'`.

- [ ] **Step 3: Create `backend/src/lib/speakerContext.js`**

```js
/**
 * Speaker context — in-memory singleton tracking the current speaker's
 * identity mode across turns within a session.
 *
 * Modes:
 *   OWNER      – registered owner, full intent access
 *   KNOWN      – registered non-owner, limited intents
 *   UNKNOWN    – unrecognized voice, limited + first-contact flow
 *   LOW_CONF   – embedding confidence too low, gather more audio
 */

// Intents allowed for non-owner speakers (KNOWN / UNKNOWN).
// OWNER bypasses this list entirely.
// LOW_CONF blocks everything.
const LIMITED_INTENTS = new Set([
  'chat',
  'complex_task',
  'show_3d',
  'render_formula',
  'show_display',
  'navigate',
  'activate_skill',
])

let _mode = 'UNKNOWN'
let _name = null
const _turnCounts = new Map() // speakerName → turn count

export function getSpeakerMode() { return _mode }
export function getSpeakerName() { return _name }

export function setSpeakerMode(mode, name) {
  _mode = mode
  _name = name ?? null
}

export function resetSession() {
  _mode = 'UNKNOWN'
  _name = null
  _turnCounts.clear()
}

/**
 * Returns true when the given intent is allowed for the given mode.
 * Use getSpeakerMode() to get the current mode, or pass explicitly for testing.
 */
export function filterIntentsByMode(intent, mode) {
  if (mode === 'OWNER') return true
  if (mode === 'LOW_CONF') return false
  // KNOWN and UNKNOWN get the same limited set
  return LIMITED_INTENTS.has(intent)
}

/**
 * Increment turn count for a named speaker and return the new count.
 * Used to schedule reinforcement enrollment (every 5th turn ≥ 2s).
 */
export function incrementTurnCount(speakerName) {
  const count = (_turnCounts.get(speakerName) ?? 0) + 1
  _turnCounts.set(speakerName, count)
  return count
}

export function getTurnCount(speakerName) {
  return _turnCounts.get(speakerName) ?? 0
}
```

- [ ] **Step 4: Run tests — all 13 must pass**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test -- speakerContext.unit
```

Expected: `13 passed`.

- [ ] **Step 5: Run full backend suite — no regressions**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test
```

Expected: all tests pass (≥57 from Plan 1).

- [ ] **Step 6: Commit**

```bash
cd /c/proyecto/jarvis-linux
git add backend/src/lib/speakerContext.js backend/tests/speakerContext.unit.test.js
git commit -m "feat(linux): add speakerContext lib — OWNER/KNOWN/UNKNOWN/LOW_CONF mode gate"
```

---

### Task 2: FIFO cap + audio trim in `speaker_id.py`

Add two helper methods to `SpeakerIdentifier` and call them on every new sample save. Also create a Python test directory with pytest tests for the pure cap logic.

**Files:**
- Modify: `backend/voice/python/speaker_id.py`
- Create: `backend/voice/python/tests/__init__.py`
- Create: `backend/voice/python/tests/test_speaker_cap.py`

- [ ] **Step 1: Write the failing pytest tests**

Create `backend/voice/python/tests/__init__.py` (empty):
```python
```

Create `backend/voice/python/tests/test_speaker_cap.py`:

```python
"""
Tests for speaker_id.py FIFO cap and audio trim helpers.
Run from jarvis-linux root: python -m pytest backend/voice/python/tests/ -v
"""

import time
import tempfile
import struct
import wave
from pathlib import Path

import pytest

# Import the helpers directly — no FastAPI startup needed.
from speaker_id import _enforce_cap, _trim_audio_to_seconds


def _make_wav(path: Path, duration_seconds: float, sample_rate: int = 16000) -> Path:
    """Write a minimal valid WAV file of the given duration."""
    n_samples = int(sample_rate * duration_seconds)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
    return path


# ── FIFO cap tests ────────────────────────────────────────────────────────────

def test_enforce_cap_does_nothing_when_under_limit(tmp_path):
    """No files deleted when count ≤ max_samples."""
    for i in range(10):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 10


def test_enforce_cap_deletes_oldest_when_over_limit(tmp_path):
    """When cap exceeded, oldest files (by mtime) are deleted first."""
    # Create 51 files with staggered mtimes
    for i in range(51):
        p = tmp_path / f"sample_{i:03d}.wav"
        _make_wav(p, 1.0)
        # Spread mtimes so ordering is deterministic
        p.touch()
        time.sleep(0.01)

    _enforce_cap(tmp_path, max_samples=50)

    remaining = sorted(tmp_path.glob("*.wav"))
    assert len(remaining) == 50
    # Oldest file (sample_000) must be gone
    assert not (tmp_path / "sample_000.wav").exists()
    # Newest file must survive
    assert (tmp_path / "sample_050.wav").exists()


def test_enforce_cap_exactly_at_limit(tmp_path):
    """Exactly max_samples files → nothing deleted."""
    for i in range(50):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 50


def test_enforce_cap_skips_non_audio_files(tmp_path):
    """Non-audio files (e.g. _config.json) are ignored by cap count."""
    (tmp_path / "_config.json").write_text("{}")
    for i in range(50):
        _make_wav(tmp_path / f"sample_{i:03d}.wav", 1.0)
    # 50 WAV + 1 JSON = 51 files, but cap counts only WAV
    _enforce_cap(tmp_path, max_samples=50)
    assert len(list(tmp_path.glob("*.wav"))) == 50
    assert (tmp_path / "_config.json").exists()  # JSON untouched


# ── Audio trim tests ──────────────────────────────────────────────────────────

def test_trim_audio_short_file_unchanged(tmp_path):
    """File shorter than max_seconds is NOT rewritten."""
    p = _make_wav(tmp_path / "short.wav", 2.0)
    original_size = p.stat().st_size
    _trim_audio_to_seconds(p, max_seconds=5.0)
    assert p.stat().st_size == original_size  # untouched


def test_trim_audio_long_file_trimmed(tmp_path):
    """File longer than max_seconds is trimmed in place."""
    import soundfile as sf
    p = _make_wav(tmp_path / "long.wav", 8.0)
    _trim_audio_to_seconds(p, max_seconds=5.0)
    data, sr = sf.read(str(p))
    duration = len(data) / sr
    assert duration <= 5.1  # allow tiny rounding margin


def test_trim_audio_exactly_at_limit_unchanged(tmp_path):
    """File at exactly max_seconds is not rewritten."""
    import soundfile as sf
    p = _make_wav(tmp_path / "exact.wav", 5.0)
    original_size = p.stat().st_size
    _trim_audio_to_seconds(p, max_seconds=5.0)
    assert p.stat().st_size == original_size
```

- [ ] **Step 2: Add `_enforce_cap` and `_trim_audio_to_seconds` to `speaker_id.py`**

Near the top of `speaker_id.py` (after the existing imports), add:

```python
import wave as _wave

SAMPLE_CAP = 50       # max stored samples per speaker
SAMPLE_MAX_SECONDS = 5.0  # trim enrollment audio to this length
```

Add these two standalone functions (NOT methods on SpeakerIdentifier — so pytest can import them without instantiation):

```python
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

    Uses the stdlib `wave` module — no external deps needed for the trim itself.
    Only trims; never pads.
    """
    if path.suffix.lower() != ".wav":
        return
    try:
        with _wave.open(str(path), "r") as wf:
            sr = wf.getframerate()
            total_frames = wf.getnframes()
            max_frames = int(sr * max_seconds)
            if total_frames <= max_frames:
                return  # already short enough
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            wf.rewind()
            data = wf.readframes(max_frames)

        # Overwrite in place with the trimmed data
        with _wave.open(str(path), "w") as wf:
            wf.setnchannels(n_channels)
            wf.setsampwidth(sampwidth)
            wf.setframerate(sr)
            wf.writeframes(data)
    except Exception:
        pass  # leave file untouched on any error
```

- [ ] **Step 3: Call both helpers in the save path**

In `speaker_id.py`, find the `SpeakerIdentifier` method that saves a new enrollment sample (look for the file-write path — it ends with saving a `.wav` or audio file). After the file is saved, add:

```python
_trim_audio_to_seconds(saved_path)
_enforce_cap(saved_path.parent)
```

Where `saved_path` is the `Path` to the newly written audio file.

- [ ] **Step 4: Run pytest**

```bash
cd /c/proyecto/jarvis-linux/backend/voice/python
python -m pytest tests/ -v
```

Expected: `7 passed` (4 cap tests + 3 trim tests). The `test_trim_audio_long_file_trimmed` test requires `soundfile` — it's already in `requirements.txt`.

If `soundfile` or `pytest` is not installed in the current environment, install them:
```bash
pip install soundfile pytest
```

- [ ] **Step 5: Run full backend Node.js suite — no regressions**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test
```

Expected: all tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /c/proyecto/jarvis-linux
git add backend/voice/python/speaker_id.py backend/voice/python/tests/
git commit -m "feat(linux): add 50-sample FIFO cap + 5s trim to speaker_id.py"
```

---

### Task 3: `wakeWord.js` handler + route wiring

New handler for the wake word daemon to POST detections to, and for the first-boot calibration wizard.

**Files:**
- Create: `backend/src/handlers/wakeWord.js`
- Modify: `backend/src/routes.js`
- Create: `backend/tests/wakeWord.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/wakeWord.unit.test.js`:

```js
import { test, expect, vi, beforeEach } from 'vitest'

// Minimal stubs so we can import the handler without real deps
vi.mock('../src/lib/attentionState.js', () => ({
  markInteraction: vi.fn(),
  getAttentionState: vi.fn(() => 'ENGAGED'),
}))
vi.mock('../src/lib/speakerContext.js', () => ({
  resetSession: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
}))

import { handleWakeDetected, handleWakeCalibrate } from '../src/handlers/wakeWord.js'
import { markInteraction, getAttentionState } from '../src/lib/attentionState.js'

function makeReqRes(body = {}) {
  let statusCode = 200
  let responseBody = null
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end(data) { responseBody = data ? JSON.parse(data) : null },
    get body() { return responseBody },
    get status() { return statusCode },
  }
  const req = {
    method: 'POST',
    url: '/api/jarvis/wake-detected',
    headers: { 'content-type': 'application/json' },
    // Simulate readBody by exposing body directly
    _body: body,
  }
  return { req, res }
}

// Patch readBody to return req._body directly
vi.mock('../src/lib/http.js', () => ({
  json: vi.fn((res, status, data) => {
    res.statusCode = status
    res.end(JSON.stringify(data))
  }),
  readBody: vi.fn(async (req) => req._body),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

test('handleWakeDetected calls markInteraction', async () => {
  const { req, res } = makeReqRes({ confidence: 0.85, ts: 1000 })
  await handleWakeDetected(req, res)
  expect(markInteraction).toHaveBeenCalledOnce()
})

test('handleWakeDetected returns ok:true with attention state', async () => {
  const { req, res } = makeReqRes({ confidence: 0.85, ts: 1000 })
  await handleWakeDetected(req, res)
  expect(res.body.ok).toBe(true)
  expect(res.body.state).toBe('ENGAGED')
})

test('handleWakeCalibrate writes profile file', async () => {
  const { writeFile } = await import('node:fs/promises')
  const { req, res } = makeReqRes({ samples: ['base64abc', 'base64def'] })
  req.url = '/api/jarvis/wake-calibrate'
  await handleWakeCalibrate(req, res)
  expect(writeFile).toHaveBeenCalledOnce()
  expect(res.body.ok).toBe(true)
})

test('handleWakeCalibrate rejects missing samples', async () => {
  const { req, res } = makeReqRes({ samples: [] })
  await handleWakeCalibrate(req, res)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toBe('samples_required')
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test -- wakeWord.unit
```

Expected: `Cannot find module '../src/handlers/wakeWord.js'`.

- [ ] **Step 3: Create `backend/src/handlers/wakeWord.js`**

```js
/**
 * Wake word detection + calibration endpoints.
 *
 * POST /api/jarvis/wake-detected
 *   Called by wake_service.py (openWakeWord daemon) each time the wake phrase
 *   is detected. Marks an interaction so the attention state transitions to
 *   ENGAGED, and resets the speaker context so the next utterance re-identifies.
 *
 * POST /api/jarvis/wake-calibrate
 *   Called by the first-boot setup wizard. Saves the voice embeddings from the
 *   4 recorded samples to ~/.config/jarvis/wake-model-profile.json.
 *   No model training — just stores sample metadata for resemblyzer scoring.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json, readBody } from '../lib/http.js'
import { markInteraction, getAttentionState } from '../lib/attentionState.js'
import { resetSession } from '../lib/speakerContext.js'

const CONFIG_DIR = join(homedir(), '.config', 'jarvis')
const WAKE_PROFILE_PATH = join(CONFIG_DIR, 'wake-model-profile.json')

export async function handleWakeDetected(req, res) {
  try {
    const body = await readBody(req)
    const confidence = Number(body.confidence ?? 0)
    const ts = body.ts ?? Date.now()

    // Mark interaction → attention state → ENGAGED (15s window)
    markInteraction()

    // Reset speaker context so the incoming utterance re-identifies fresh.
    // This clears any stale LOW_CONF state from the previous session.
    resetSession()

    const state = getAttentionState()
    console.log(`[wake] detected confidence=${confidence.toFixed(3)} ts=${ts} → state=${state}`)

    return json(res, 200, { ok: true, confidence, state })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) })
  }
}

export async function handleWakeCalibrate(req, res) {
  try {
    const body = await readBody(req)
    const samples = body.samples ?? []

    if (!Array.isArray(samples) || samples.length === 0) {
      return json(res, 400, { ok: false, error: 'samples_required' })
    }

    await mkdir(CONFIG_DIR, { recursive: true })

    const profile = {
      version: 1,
      createdAt: new Date().toISOString(),
      sampleCount: samples.length,
      // Store sample metadata (not raw audio) — resemblyzer reads samples
      // from disk; the wizard records to backend/voice/samples/owner/ separately.
    }

    await writeFile(WAKE_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf8')
    console.log(`[wake] calibration profile saved (${samples.length} samples)`)

    return json(res, 200, { ok: true, sampleCount: samples.length })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) })
  }
}
```

- [ ] **Step 4: Run tests — all 4 must pass**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test -- wakeWord.unit
```

Expected: `4 passed`.

- [ ] **Step 5: Wire routes into `backend/src/routes.js`**

Add this import near the top (after the other handler imports):

```js
import { handleWakeDetected, handleWakeCalibrate } from './handlers/wakeWord.js'
```

Add these two routes to the `routes` array (after the existing `/api/jarvis/wake` entry):

```js
{ method: 'POST', path: '/api/jarvis/wake-detected',  handler: handleWakeDetected },
{ method: 'POST', path: '/api/jarvis/wake-calibrate', handler: handleWakeCalibrate },
```

- [ ] **Step 6: Run full backend suite — no regressions**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test
```

Expected: all tests pass (≥70 — 57 prior + 13 speakerContext + 4 wakeWord).

- [ ] **Step 7: Commit**

```bash
cd /c/proyecto/jarvis-linux
git add backend/src/handlers/wakeWord.js backend/src/routes.js backend/tests/wakeWord.unit.test.js
git commit -m "feat(linux): add wake-detected + wake-calibrate endpoints"
```

---

### Task 4: `wake_service.py` — openWakeWord daemon

New Python FastAPI service that keeps the mic open 24/7 and fires POSTs on wake word detection. Runs as `jarvis-wake.service`. Cannot be unit-tested without hardware; validate syntax only.

**Files:**
- Create: `backend/voice/python/wake_service.py`

- [ ] **Step 1: Create `backend/voice/python/wake_service.py`**

```python
#!/usr/bin/env python3
"""
Jarvis Wake Word Daemon — jarvis-wake.service

Opens a 16kHz mono PyAudio stream, runs openWakeWord ONNX model in a loop.
On detection (confidence ≥ THRESHOLD), POSTs to the Jarvis backend.

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

# openWakeWord expects 80ms frames at 16kHz = 1280 samples
SAMPLE_RATE = 16000
CHUNK = 1280

# Cooldown between detections — prevents multi-fire on a single utterance
COOLDOWN_S = 2.0

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="Jarvis Wake Service")
_oww_model: Optional[Model] = None


@app.get("/health")
async def health():
    return {"ok": True, "model": MODEL_NAME, "threshold": THRESHOLD, "loaded": _oww_model is not None}


# ── Mic loop (background task) ────────────────────────────────────────────────

async def _post_wake(session: aiohttp.ClientSession, confidence: float) -> None:
    """Fire-and-forget POST to the backend wake endpoint."""
    try:
        payload = {"confidence": float(confidence), "ts": time.time()}
        async with session.post(WAKE_ENDPOINT, json=payload, timeout=aiohttp.ClientTimeout(total=3)) as resp:
            status = resp.status
            log.info("wake → backend  confidence=%.3f  http=%d", confidence, status)
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
            # Read one chunk (80ms); exception_on_overflow=False drops frames
            # gracefully if processing falls behind.
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

            # Yield control so FastAPI can serve /health while looping.
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
```

- [ ] **Step 2: Validate syntax**

```bash
python -c "import ast; ast.parse(open('/c/proyecto/jarvis-linux/backend/voice/python/wake_service.py').read()); print('syntax OK')"
```

Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
cd /c/proyecto/jarvis-linux
git add backend/voice/python/wake_service.py
git commit -m "feat(linux): add wake_service.py openWakeWord daemon (port 8791)"
```

---

### Task 5: Speaker mode gate in `speech.js`

Wire `speakerContext` into the existing `runSpeechTurn` function. Determine mode from `speakerConfidence` + `speakerName` each turn, gate intents, and handle UNKNOWN first-contact dialogue. Add reinforcement scheduling (every 5th turn).

**Files:**
- Modify: `backend/src/handlers/speech.js`

Env var controlling owner speaker name (add to docs/README — no code needed):
```
JARVIS_OWNER_SPEAKER=Santiago   # must match the name returned by STT/resemblyzer
```

- [ ] **Step 1: Read the current `runSpeechTurn` function**

The function signature is:
```js
async function runSpeechTurn(body, { onSentence = () => {} } = {})
```

The first ~20 lines of the function body extract these from `body`:
```js
const text = body.text ?? ''
const isFinal = body.isFinal ?? true
const alwaysOn = body.alwaysOn ?? false
const speakerConfidence = Number(body.speakerConfidence ?? 0)
// ...
const speakerName = body.speakerName ?? null
```

- [ ] **Step 2: Add imports at the top of `speech.js`**

After the existing imports block, add:

```js
import {
  getSpeakerMode,
  setSpeakerMode,
  filterIntentsByMode,
  incrementTurnCount,
} from '../lib/speakerContext.js'
```

- [ ] **Step 3: Add `_resolveSpeakerMode` helper before `runSpeechTurn`**

```js
const OWNER_SPEAKER = process.env.JARVIS_OWNER_SPEAKER ?? null
const OWNER_CONFIDENCE_THRESHOLD = 0.85
const KNOWN_CONFIDENCE_THRESHOLD = 0.65

/**
 * Determine and persist the speaker mode for this turn.
 * Called once per turn before intent classification.
 */
function _resolveSpeakerMode(speakerName, speakerConfidence) {
  if (!speakerName || speakerConfidence < KNOWN_CONFIDENCE_THRESHOLD) {
    setSpeakerMode('LOW_CONF', null)
    return 'LOW_CONF'
  }
  if (OWNER_SPEAKER && speakerName === OWNER_SPEAKER && speakerConfidence >= OWNER_CONFIDENCE_THRESHOLD) {
    setSpeakerMode('OWNER', speakerName)
    return 'OWNER'
  }
  // Known speaker (not owner, or no owner configured — treat all as KNOWN)
  setSpeakerMode('KNOWN', speakerName)
  return 'KNOWN'
}
```

- [ ] **Step 4: Add UNKNOWN opener constants before `runSpeechTurn`**

```js
const UNKNOWN_OPENERS = [
  'Usuario no reconocido. Sistema limitado activado.',
  'Sistema comprometido. Autodestrucción en 3... 2... 1... — es broma. Hola desconocido, ¿quién sos?',
  'Alerta de intruso. Iniciando protocolo... — es broma. ¿Con quién tengo el gusto?',
]
```

- [ ] **Step 5: Modify `runSpeechTurn` — insert mode gate**

Inside `runSpeechTurn`, immediately after the existing lines that extract `speakerConfidence` and `speakerName` (around line 155 where `speakerName` is set), add:

```js
  // ── Speaker mode gate ────────────────────────────────────────────────────
  // Resolve mode from STT-returned confidence. UNKNOWN is the initial default
  // (set by wakeWord handler on each wake detection); here we upgrade it based
  // on the full-utterance confidence from resemblyzer.
  const currentMode = _resolveSpeakerMode(speakerName, speakerConfidence)

  // LOW_CONF: not enough audio yet — ask a clarifying question to gather more.
  if (currentMode === 'LOW_CONF') {
    const reply = 'No pude identificar quién habla. ¿Puede repetir, por favor?'
    onSentence(reply)
    return { action: 'low_conf', reply, state }
  }

  // UNKNOWN: new voice — play theatrical opener and start enrollment flow.
  if (currentMode === 'UNKNOWN') {
    const opener = UNKNOWN_OPENERS[Math.floor(Math.random() * UNKNOWN_OPENERS.length)]
    onSentence(opener)
    return { action: 'unknown_greeting', reply: opener, state }
  }

  // Reinforcement: every 5th turn for a known speaker, log for background update.
  // (Actual embedding update via speaker_id.py is handled by the STT service.)
  const turnCount = incrementTurnCount(speakerName ?? 'unknown')
  if (turnCount % 5 === 0 && currentMode !== 'OWNER') {
    console.log(`[speaker] reinforcement turn ${turnCount} for ${speakerName}`)
  }
  // ── End speaker mode gate ────────────────────────────────────────────────
```

- [ ] **Step 6: Apply intent filter after `classifyIntent`**

Find the existing `classifyIntent` call (around line 138):
```js
const classification = classifyIntent(text, { state, speakerConfidence, alwaysOn })
```

Immediately after the `if (!classification.shouldRespond)` early-return block, add:

```js
  // Gate intent by speaker mode: KNOWN/UNKNOWN get limited intent set only.
  const intentTag = detectIntentTagFromClassification(classification)
  if (!filterIntentsByMode(intentTag, currentMode)) {
    const reply = 'Lo siento, esa función no está disponible para este usuario.'
    onSentence(reply)
    return { action: 'intent_blocked', reply, intentTag, mode: currentMode, state }
  }
```

**Note:** `detectIntentTagFromClassification` doesn't exist yet — the intent tag is computed later in the function. Instead, extract the intent tag earlier. Find the existing `const intentTag = detectIntentTag(text)` line (or wherever the intent is computed) and move it BEFORE the filter. If `detectIntentTag` is called in a different location, adjust accordingly. The key change is: after resolving the intent, call `filterIntentsByMode(intentTag, currentMode)` before proceeding to Claude.

- [ ] **Step 7: Run the full backend test suite**

```bash
cd /c/proyecto/jarvis-linux/backend && npm test
```

Expected: all tests pass. If any contract test fails due to the new mode gate (e.g., test sends a turn with no `speakerName`), check that `LOW_CONF` path returns correctly.

- [ ] **Step 8: Commit**

```bash
cd /c/proyecto/jarvis-linux
git add backend/src/handlers/speech.js
git commit -m "feat(linux): wire speaker mode gate into speech pipeline (OWNER/KNOWN/UNKNOWN/LOW_CONF)"
```

---

## Plan complete — check

After all tasks:

```bash
# Node.js tests
cd /c/proyecto/jarvis-linux/backend && npm test
# Expected: all pass (includes speakerContext + wakeWord tests)

# Python tests
cd /c/proyecto/jarvis-linux/backend/voice/python && python -m pytest tests/ -v
# Expected: 7 passed

# No missing files
ls /c/proyecto/jarvis-linux/backend/src/lib/speakerContext.js
ls /c/proyecto/jarvis-linux/backend/src/handlers/wakeWord.js
ls /c/proyecto/jarvis-linux/backend/voice/python/wake_service.py
ls /c/proyecto/jarvis-linux/backend/voice/python/tests/test_speaker_cap.py

# Wake routes registered
grep "wake-detected" /c/proyecto/jarvis-linux/backend/src/routes.js
```

---

## What comes next

- **Plan 3:** UI states (PIP drag mode, VOICE_MUTED) + two-track response latency (ACK_MAP instant response + async function fire) + OrbitControls / gesture toggle via voice in Model3DViewer
