import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readJsonFile } from './jsonFile.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '../../data')
const STATE_FILE = join(DATA_DIR, 'skills-state.json')

function loadState() {
  return readJsonFile(STATE_FILE, {})
}

function saveState(state) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function activateSkill(name) {
  const s = loadState()
  s[name] = true
  saveState(s)
}
