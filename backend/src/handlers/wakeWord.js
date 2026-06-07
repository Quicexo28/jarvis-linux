import { mkdir, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json, readBody } from '../lib/http.js'
import { markInteraction, getAttentionState, setVoiceMuted } from '../lib/attentionState.js'
import { resetSession } from '../lib/speakerContext.js'

const CONFIG_DIR = join(homedir(), '.config', 'jarvis')
const WAKE_PROFILE_PATH = join(CONFIG_DIR, 'wake-model-profile.json')

export async function handleWakeDetected(req, res) {
  try {
    const body = await readBody(req)
    const confidence = Number(body.confidence ?? 0)
    const ts = body.ts ?? Date.now()
    markInteraction()
    setVoiceMuted(false)
    resetSession()
    const state = getAttentionState()
    console.log(`[wake] detected confidence=${confidence.toFixed(3)} ts=${ts} → state=${state}`)
    return json(res, 200, { ok: true, confidence, state })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) })
  }
}

export async function handleWakeStatus(_req, res) {
  try {
    await access(WAKE_PROFILE_PATH)
    return json(res, 200, { calibrated: true })
  } catch {
    return json(res, 200, { calibrated: false })
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
    }
    await writeFile(WAKE_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf8')
    console.log(`[wake] calibration profile saved (${samples.length} samples)`)
    return json(res, 200, { ok: true, sampleCount: samples.length })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err) })
  }
}
