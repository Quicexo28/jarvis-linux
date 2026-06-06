import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '../../data')
const STATE_FILE = join(DATA_DIR, 'skills-state.json')

function loadState() {
  if (!existsSync(STATE_FILE)) return {}
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function saveState(state) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function isSkillActive(name) {
  return loadState()[name] === true
}

export function activateSkill(name) {
  const s = loadState()
  s[name] = true
  saveState(s)
}

export function deactivateSkill(name) {
  const s = loadState()
  s[name] = false
  saveState(s)
}

export function listActiveSkills() {
  return Object.entries(loadState()).filter(([, v]) => v).map(([k]) => k)
}
