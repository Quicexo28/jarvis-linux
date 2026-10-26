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
 *   node scripts/eval-voice.mjs                    # fixture, minus `mutates` cases
 *   node scripts/eval-voice.mjs --all              # also the cases that write
 *                                                  #   (vault tasks, reminders, habits, apps)
 *   node scripts/eval-voice.mjs --grep timer       # subset by name/text
 *   node scripts/eval-voice.mjs --tag safety       # subset by tag
 *   node scripts/eval-voice.mjs --file mis.json    # another fixture
 *
 * Expectations per case: action | actionAnyOf, intent, toolsInclude (all),
 * toolsAnyOf (at least one), toolsExclude (none), replyMatches,
 * replyNotMatches, maxFirstMs, verdict | verdictAnyOf. Tool names match the
 * bare MCP name; the consolidated tools carry their action ("timer.start").
 *
 * NOTE: this spends real API tokens and drives the real assistant (it will start
 * timers, open views...). It wakes the UI first (renderer tools fail on a
 * DORMANT UI) and cancels timers/chronos at the end. Cases marked `mutates`
 * leave real traces (vault, reminders) and only run with --all.
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
const tag = arg('--tag')
const includeMutating = process.argv.includes('--all')

/** Direct (non-model) call to a backend route — setup and cleanup only. */
async function backend(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch {
    return false
  }
}

const toolMatches = (tools, t) => tools.some((name) => name === t || name.endsWith(`__${t}`))

/** Run one utterance and pair the HTTP result with its stored turn row. */
async function runCase(c) {
  const before = recentTurns(1)[0]?.id ?? 0
  const started = Date.now()
  const res = await fetch(`${BASE}/api/jarvis/process-speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // eval:true → recorded as source 'eval', no memory learning, no router learning.
    body: JSON.stringify({ text: c.text, eval: true, ...OWNER, ...(c.speaker ?? {}) }),
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
  if (e.actionAnyOf && !e.actionAnyOf.includes(body.action)) {
    fails.push(`action=${body.action} (esperado uno de ${e.actionAnyOf.join(',')})`)
  }
  if (e.intent && body.intentTag !== e.intent) {
    fails.push(`intent=${body.intentTag} (esperado ${e.intent})`)
  }
  for (const t of e.toolsInclude ?? []) {
    if (!toolMatches(tools, t)) fails.push(`no llamó ${t} (llamó: ${tools.join(',') || 'nada'})`)
  }
  if (e.toolsAnyOf && !e.toolsAnyOf.some((t) => toolMatches(tools, t))) {
    fails.push(`no llamó ninguna de ${e.toolsAnyOf.join(',')} (llamó: ${tools.join(',') || 'nada'})`)
  }
  for (const t of e.toolsExclude ?? []) {
    if (toolMatches(tools, t)) fails.push(`llamó ${t}, que estaba prohibido en este caso`)
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
  // Never expected, never declared: a tool that errored is always a failure —
  // unless the case declares that reporting the error honestly is acceptable
  // (e.g. calendar/mail not configured on this machine).
  const honestError = ['tool_error_reported', 'tool_error_recovered'].includes(row?.verdict) && (e.verdictAnyOf ?? []).includes(row.verdict)
  if (row?.error && !honestError) fails.push(`error en el turno: ${String(row.error).slice(0, 120)}`)
  if (e.verdict && row?.verdict !== e.verdict) {
    fails.push(`veredicto=${row?.verdict ?? 'ninguno'} (esperado ${e.verdict})`)
  }
  if (e.verdictAnyOf && row?.verdict && !e.verdictAnyOf.includes(row.verdict)) {
    fails.push(`veredicto=${row.verdict} (esperado uno de ${e.verdictAnyOf.join(',')})`)
  }
  // Saying one thing and doing another is a failure in EVERY case, declared or
  // not — that is the whole point of the verifier.
  if (['false_success', 'unbacked_claim'].includes(row?.verdict)) {
    fails.push(`el turno afirmó algo que no ocurrió (${row.verdict})`)
  }
  return fails
}

const all = JSON.parse(readFileSync(fixturePath, 'utf-8'))
const cases = all
  .filter((c) => !grep || c.name.includes(grep) || c.text.includes(grep))
  .filter((c) => !tag || (c.tags ?? []).includes(tag))
  // `needsConfig`: calendar/mail cases only mean something once the owner has
  // set JARVIS_CALENDAR_ICS / JARVIS_IMAP_*; until then the model (rightly)
  // remembers they are not configured and stops calling the tool.
  .filter((c) => includeMutating || !(c.mutates || c.needsConfig))
const skipped = all.length - cases.length

console.log(`eval-voice → ${BASE}  (${cases.length} casos${skipped ? `, ${skipped} omitidos` : ''})\n`)

// Renderer tools fail with renderer_not_connected on a DORMANT UI, and a backend
// restart leaves it dormant — measure the assistant, not the sleep state.
if (!process.argv.includes('--no-wake')) {
  await backend('POST', '/api/skills/system/wake', {})
  await new Promise((r) => setTimeout(r, 3000))
}

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

// Leave the desk as we found it: whatever timers/chronos the cases started.
await backend('POST', '/api/skills/timer/cancel', { all: true })
await backend('POST', '/api/skills/chrono/cancel', { all: true })

const rows = recentTurns(cases.length)
const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
console.log(`\n${passed}/${cases.length} pasaron · coste de esta corrida ≈ $${cost.toFixed(4)}`)
process.exit(failures.length ? 1 : 0)
