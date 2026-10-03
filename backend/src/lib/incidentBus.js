/**
 * Incident bus — the one place any module reports "something broke".
 *
 * It exists so low-level modules (claudeCli, the session pipeline, the process
 * error handlers) can report a failure WITHOUT importing the watchdog: selfHeal
 * pulls in devAgent, which pulls in claudeCli, and a direct import back would be
 * a cycle. This file imports nothing, so anyone can depend on it.
 *
 * Reports made before the watchdog subscribes (during boot) are buffered and
 * replayed, so a failure in the first second of life is not lost.
 */

const listeners = new Set()
const early = []
const EARLY_MAX = 50

/**
 * @typedef {object} IssueReport
 * @property {string} code     stable error code, e.g. "JRV-BRAIN-001"
 * @property {string} source   subsystem that saw it ("claude-session", "speech", …)
 * @property {string} message  one line, human readable
 * @property {string} [detail] stack trace / stderr tail / command output
 * @property {string} [key]    dedup key; defaults to code (same key ⇒ same incident)
 * @property {object} [ctx]    anything a remediator needs (service name, tool name…)
 */

/** @param {IssueReport} issue */
export function reportIssue(issue) {
  const rec = { ts: Date.now(), ...issue }
  if (!listeners.size) {
    if (early.length < EARLY_MAX) early.push(rec)
    return
  }
  for (const fn of listeners) {
    try { fn(rec) } catch (e) { console.warn('[incident] listener failed —', e?.message) }
  }
}

/** Subscribe. Replays whatever was reported before anyone listened. */
export function onIssue(fn) {
  listeners.add(fn)
  while (early.length) {
    const rec = early.shift()
    try { fn(rec) } catch {}
  }
  return () => listeners.delete(fn)
}
