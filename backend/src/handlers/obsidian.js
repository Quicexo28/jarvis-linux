import { json } from '../lib/http.js'
import { getStatus, ensureSkeleton } from '../lib/obsidian.js'

export async function handleObsidianStatus(_req, res) {
  try {
    ensureSkeleton()
    const status = await getStatus()
    return json(res, 200, { ok: true, ...status })
  } catch (error) {
    return json(res, 500, { ok: false, error: 'obsidian_status_error', detail: String(error) })
  }
}
