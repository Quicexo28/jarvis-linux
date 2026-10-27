import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Environment for a contract test's throwaway `src/server.js`.
 *
 * Its own port (each test file a different one: vitest runs files in parallel)
 * — on 8788 the child died with EADDRINUSE whenever the production backend was
 * up, and the tests silently ran against PRODUCTION. And, now that the child
 * really boots: a fake brain, a scratch DB, and none of the background loops
 * that would act on the señor's real state (proactive notices, reminders,
 * watchers, briefing, watchdog).
 * @param {number} port
 */
export function isolatedServerEnv(port, base = process.env) {
  return {
    ...base,
    PORT: String(port),
    JARVIS_FAKE_CLAUDE: '1',
    JARVIS_DB_PATH: join(mkdtempSync(join(tmpdir(), 'jarvis-contract-')), 'test.db'),
    JARVIS_SELFHEAL: '0',
    JARVIS_PROACTIVE: '0',
    JARVIS_BRIEFING: '0',
    JARVIS_REMINDERS: '0',
    JARVIS_WATCHERS: '0',
  }
}
