import { readFileSync } from 'node:fs'

/** Lee un JSON de disco. Si falta o está roto devuelve `fallback`. */
export function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return fallback }
}
