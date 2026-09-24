/**
 * Bridge to the Android companion shell.
 *
 * The APK is a WebView around this same page, so everything the browser can do
 * stays browser code; only what a WebView cannot do (background reporting,
 * on-device speech recognition, app settings) is exposed by the native side as
 * `window.JarvisNative`. In a plain browser the bridge is absent and every
 * helper degrades to a web equivalent or a no-op.
 */

export type NativeBridge = {
  /** App versionName, e.g. "2.0". */
  version(): string
  /** True while the foreground reporter service is running. */
  reporterRunning(): boolean
  /** Start Android SpeechRecognizer; result comes back on window.__jarvisVoiceResult. */
  startVoice(): void
  /** Open the app's setup screen (URL/token/interval, permissions). */
  openSettings(): void
  /** Battery as JSON: {"level":87,"charging":true}; "" when unavailable. */
  battery(): string
  /** Bring the Moonlight app to the front. "launched" | "store" | "error". */
  openMoonlight?(): string
}

declare global {
  interface Window {
    JarvisNative?: NativeBridge
    __jarvisVoiceResult?: (text: string) => void
    __jarvisVoiceError?: (reason: string) => void
  }
}

export function nativeBridge(): NativeBridge | null {
  return typeof window !== 'undefined' && window.JarvisNative ? window.JarvisNative : null
}

export function isNativeApp(): boolean {
  return nativeBridge() != null
}

export function nativeVersion(): string | null {
  try { return nativeBridge()?.version() ?? null } catch { return null }
}

export function nativeReporterRunning(): boolean {
  try { return nativeBridge()?.reporterRunning() ?? false } catch { return false }
}

export function openNativeSettings(): void {
  try { nativeBridge()?.openSettings() } catch {}
}

export function nativeBattery(): { level: number; charging: boolean } | null {
  try {
    const raw = nativeBridge()?.battery()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return { level: Number(parsed.level), charging: !!parsed.charging }
  } catch {
    return null
  }
}

/**
 * Jump to the Moonlight app.
 *
 * Moonlight has no "connect to host X" URI scheme, so this only fronts the app
 * and the caller is expected to have copied the host address first. Returns
 * `null` in a plain browser (and in an APK older than this bridge), which the
 * caller shows as "install Moonlight" instead of a broken button.
 */
export function openMoonlight(): 'launched' | 'store' | 'error' | null {
  try {
    const bridge = nativeBridge()
    if (!bridge?.openMoonlight) return null
    return bridge.openMoonlight() as 'launched' | 'store' | 'error'
  } catch {
    return null
  }
}

/**
 * One-shot dictation. Uses the native recognizer inside the APK (Android
 * WebView has no SpeechRecognition API at all) and the Chrome web API in a
 * browser. `onError` fires with a Spanish reason when neither is available.
 */
export function startDictation(onText: (text: string) => void, onError: (reason: string) => void): void {
  const bridge = nativeBridge()
  if (bridge) {
    window.__jarvisVoiceResult = (text: string) => { if (text?.trim()) onText(text.trim()) }
    window.__jarvisVoiceError = (reason: string) => onError(reason || 'Micrófono no disponible.')
    try { bridge.startVoice() } catch { onError('Micrófono no disponible.') }
    return
  }
  const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition
  if (!SR) { onError('Dictado no disponible en este navegador.'); return }
  const rec = new SR()
  rec.lang = 'es-CO'
  rec.onresult = (e: any) => onText(e.results[0][0].transcript)
  rec.onerror = () => onError('No se escuchó nada.')
  rec.start()
}
