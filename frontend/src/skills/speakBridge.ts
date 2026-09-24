/**
 * Bridge that lets a skill-bus primitive use the renderer's real TTS path.
 *
 * Speaking is NOT just "play this audio": `AwakeApp`'s speak() aborts whatever
 * was being said, and records the text in the echo gate so the STT can recognise
 * Jarvis's own voice coming back through the microphone. A second, independent
 * speech path would bypass that and Jarvis would start answering itself.
 *
 * So AwakeApp registers its speak() here on mount, and the `speak_text`
 * primitive calls whatever is registered. When the UI is dormant or no renderer
 * is mounted, nothing is registered and the primitive fails loudly — the backend
 * needs to know its words went nowhere.
 */

type Speaker = (text: string) => Promise<void>

let speaker: Speaker | null = null

/** Called by AwakeApp while it is mounted. Returns an unregister function. */
export function registerSpeaker(fn: Speaker): () => void {
  speaker = fn
  return () => { if (speaker === fn) speaker = null }
}

export function hasSpeaker(): boolean {
  return speaker !== null
}

/** Speak through the renderer's own TTS path. Throws when nothing can speak. */
export async function speakThroughRenderer(text: string): Promise<void> {
  if (!speaker) throw new Error('no_speaker')
  await speaker(text)
}
