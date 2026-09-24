#!/usr/bin/env node
/**
 * Voice behaviour eval — the missing feedback loop.
 *
 * Every threshold in the voice stack (endpointing, speaker gates, intent
 * scoring, prompt rules) was tuned by speaking at the machine and reading
 * journald. That is unrepeatable, so a change that fixed one phrase and broke
 * three others looked like a success.
 *
 * This replays a fixture of real utterances through the LIVE backend and asserts
 * what actually happened — not just the words that came back, but which MCP
 * tools ran, whether any of them errored, and how long the first spoken chunk
 * took. Those come from the turn row that `turnStore` now writes, which is why
 * this could not exist before.
 *
 *   node scripts/eval-voice.mjs                    # full fixture
 *   node scripts/eval-voice.mjs --grep timer       # subset
 *   node scripts/eval-voice.mjs --file mis.json    # another fixture
 *
 * NOTE: this spends real API tokens and drives the real assistant (it will start
 * timers, open views...). Point it at a scratch backend when that matters.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recentTurns } from '../src/lib/turnStore.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.JARVIS_EVAL_URL || 'http://127.0.0.1:8788'
const OWNER = {
  speakerName: process.env.JARVIS_OWNER_SPEAKER || 'santiago',
  speakerConfidence: 0.95,
  speakerConfidenceRaw: 0.8,
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const fixturePath = resolve(arg('--file', join(__dir, '..', 'tests', 'fixtures', 'voice-cases.json')))
const grep = arg('--grep')

/** Run one utterance and pair the HTTP result with its stored turn row. */
async function runCase(c) {
  const before = recentTurns(1)[0]?.id ?? 0
  const started = Date.now()
  const res = await fetch(`${BASE}/api/jarvis/process-speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: c.text, ...OWNER, ...(c.speaker ?? {}) }),
  })
  const body = await res.json()

  // The turn row is written after the reply resolves; give the write a moment.
  let row = null
  for (let i = 0; i < 20 && !row; i++) {
    const latest = recentTurns(1)[0]
    if (latest && latest.id > before) row = latest
    else await new Promise((r) => setTimeout(r, 150))
  }
  // The verdict lands later still — verification runs after the reply is spoken
  // and may probe the renderer. Wait briefly so assertions can see it.
  for (let i = 0; i < 25 && row && !row.verdict; i++) {
    await new Promise((r) => setTimeout(r, 200))
    row = recentTurns(1)[0]?.id === row.id ? recentTurns(1)[0] : row
  }
  return { body, row, wallMs: Date.now() - started }
}

/** Check one case's expectations, returning the list of failures. */
function check(c, { body, row }) {
  const e = c.expect ?? {}
  const fails = []
  const tools = row?.tools ? JSON.parse(row.tools) : []

  if (e.action && body.action !== e.action) {
    fails.push(`action=${body.action} (esperado ${e.action})`)
  }
  if (e.intent && body.intentTag !== e.intent) {
    fails.push(`intent=${body.intentTag} (esperado ${e.intent})`)
  }
  for (const t of e.toolsInclude ?? []) {
    if (!tools.some((name) => name === t || name.endsWith(`__${t}`))) {
      fails.push(`no llamó ${t} (llamó: ${tools.join(',') || 'nada'})`)
    }
  }
  if (e.replyMatches && !new RegExp(e.replyMatches, 'i').test(body.reply ?? '')) {
    fails.push(`respuesta no casa /${e.replyMatches}/`)
  }
  if (e.replyNotMatches && new RegExp(e.replyNotMatches).test(body.reply ?? '')) {
    fails.push(`respuesta contiene lo prohibido /${e.replyNotMatches}/`)
  }
  if (e.maxFirstMs && row && row.ms_first > e.maxFirstMs) {
    fails.push(`primera frase ${row.ms_first}ms > ${e.maxFirstMs}ms`)
  }
  // Never expected, never declared: a tool that errored is always a failure.
  if (row?.error) fails.push(`error en el turno: ${String(row.error).slice(0, 120)}`)
  if (e.verdict && row?.verdict !== e.verdict) {
    fails.push(`veredicto=${row?.verdict ?? 'ninguno'} (esperado ${e.verdict})`)
  }
  // Saying one thing and doing another is a failure in EVERY case, declared or
  // not — that is the whole point of the verifier.
  if (['false_success', 'unbacked_claim'].includes(row?.verdict)) {
    fails.push(`el turno afirmó algo que no ocurrió (${row.verdict})`)
  }
  return fails
}

const cases = JSON.parse(readFileSync(fixturePath, 'utf-8'))
  .filter((c) => !grep || c.name.includes(grep) || c.text.includes(grep))

console.log(`eval-voice → ${BASE}  (${cases.length} casos)\n`)

let passed = 0
const failures = []
for (const c of cases) {
  process.stdout.write(`· ${c.name} … `)
  try {
    const out = await runCase(c)
    const fails = check(c, out)
    const ms = out.row?.ms_first ?? out.wallMs
    const verdict = out.row?.verdict ? ` [${out.row.verdict}]` : ''
    if (fails.length) {
      console.log(`FALLA (${ms}ms)${verdict}`)
      for (const f of fails) console.log(`    ${f}`)
      failures.push({ name: c.name, fails })
    } else {
      console.log(`ok (${ms}ms)${verdict}`)
      passed++
    }
  } catch (err) {
    console.log('ERROR')
    console.log(`    ${err?.message}`)
    failures.push({ name: c.name, fails: [String(err?.message)] })
  }
}

const rows = recentTurns(cases.length)
const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
console.log(`\n${passed}/${cases.length} pasaron · coste de esta corrida ≈ $${cost.toFixed(4)}`)
process.exit(failures.length ? 1 : 0)
