import { useCallback, useEffect, useRef } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { getApiBase, apiFetch } from '../api/client'
import { streamTtsAndPlay, streamTtsSession, setTtsDucking, type TtsSession } from '../audio/streamingTts'
import { registerSpeaker } from '../skills/speakBridge'
import { streamConverse } from '../audio/converse'
import { ttsBusThinking } from '../audio/ttsLevelBus'
import { useClapDetection } from './useClapDetection'
import { useLocalStt } from './useLocalStt'
import { useAudioLevel } from './useAudioLevel'
import { getWakeConfirmation } from '../utils/wakeReply'
import { hasWakePhrase, stripWakePhrase } from '../lib/wakePhrase'
import { isStopOnly } from '../lib/bargeIn'
import { normalizeForEcho, hasRealSpeech } from '../lib/echoGuard'

const WAKE_WINDOW_MS = 15000
// Ctrl+C grace: mientras Jarvis PIENSA (turno aceptado, aún sin hablar) un final
// nuevo normalmente interrumpe y reemplaza el turno. Dentro de esta ventana, un
// final que DUPLICA la frase en curso es un fragmento tardío del STT
// (re-finalización al reconectar / segmento tardío) y se ignora, para que la
// misma frase no reinicie su propio turno.
const INTERRUPT_GRACE_MS = 1200
// Nombre del dueño para el texto escrito; debe coincidir con JARVIS_OWNER_SPEAKER (jarvis-backend.service).
const TYPED_OWNER_NAME = 'santiago'

/**
 * Turno de voz completo: STT local → filtros (confianza, eco, wake word, barge-in)
 * → `converse` en streaming → TTS. También el aplauso de wake y el bus de wake.
 */
export function useVoiceTurn() {
  const mode               = useJarvisStore(s => s.mode)
  const voiceMode          = useJarvisStore(s => s.voiceMode)
  const voiceEnabled       = useJarvisStore(s => s.voiceEnabled)
  const wakeListening      = useJarvisStore(s => s.wakeListening)
  const setWakeListening   = useJarvisStore(s => s.setWakeListening)
  const clapWakeEnabled    = useJarvisStore(s => s.clapWakeEnabled)
  const setCoreInput       = useJarvisStore(s => s.setCoreInput)
  const setCoreReply       = useJarvisStore(s => s.setCoreReply)
  const focusedEntity      = useJarvisStore(s => s.focusedEntity)
  const speakerName        = useJarvisStore(s => s.speakerName)
  const pttActive          = useJarvisStore(s => s.pttActive)

  const speakAbortRef = useRef<AbortController | null>(null)
  // Normalized text Jarvis is currently / was just speaking, used to detect
  // self-echo by content (the only reliable signal when the TTS voice is cloned
  // from the owner, so speaker-confidence can't tell echo from real owner).
  const spokenTextRef = useRef('')
  // True only while TTS audio is actually playing. Gates barge-in: a new owner
  // utterance may cut Jarvis off only while he's speaking.
  const speakingRef = useRef(false)
  // Timestamp (ms) when the last TTS finished. Used for post-speech echo cooldown.
  const postSpeakTimeRef = useRef(0)
  // Timer that auto-restores TTS gain if the user starts speaking but doesn't
  // produce a final transcript (background noise, too short for Whisper, etc.).
  const duckRestoreRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback((text: string): Promise<void> => {
    if (!voiceEnabled || !text) { console.log(`[tts] skip (voiceEnabled=${voiceEnabled}, textLen=${text?.length ?? 0})`); return Promise.resolve() }
    console.log(`[tts] speak start "${text.slice(0, 40)}"`)
    speakAbortRef.current?.abort()
    const ctrl = new AbortController()
    speakAbortRef.current = ctrl
    speakingRef.current = true
    // Remember what we're saying so the STT gate can recognize its own echo by
    // content, independent of speaker confidence.
    spokenTextRef.current = normalizeForEcho(text)
    return streamTtsAndPlay({
      url: `${getApiBase()}/api/jarvis/tts/ws`,
      text,
      lang: 'es',
      fx: true,
      signal: ctrl.signal,
    }).then(() => { console.log('[tts] speak done') })
      .catch((e) => {
        if ((e as any)?.name !== 'AbortError') console.warn('[tts] failed:', (e as Error)?.message)
        else console.log('[tts] aborted (newer reply or stop)')
      })
      .finally(() => { if (speakAbortRef.current === ctrl) speakingRef.current = false })
  }, [voiceEnabled])

  // Expose the REAL speak() to the skill bus, so backend-initiated speech goes
  // through the same abort + echo-gate bookkeeping as a normal reply.
  useEffect(() => registerSpeaker(speak), [speak])

  // Duck TTS volume while the user is speaking. Called on every interim
  // transcript so the fade starts as soon as Whisper detects speech. An
  // auto-restore timer fires 2.5s later in case no final transcript arrives
  // (e.g. the noise was too short). The final-transcript handler always
  // cancels this timer and restores immediately.
  const duckTts = useCallback(() => {
    if (!speakingRef.current) return
    if (duckRestoreRef.current) clearTimeout(duckRestoreRef.current)
    setTtsDucking(true)
    duckRestoreRef.current = setTimeout(() => {
      setTtsDucking(false)
      duckRestoreRef.current = null
    }, 2500)
  }, [])

  // One turn at a time. True from the moment a final is accepted until its
  // reply finishes playing — so new finals (including Jarvis's own voice through
  // the mic) are ignored mid-turn instead of spawning a second, overlapping
  // reply. Safety-timed so a hung turn can't deafen the app forever.
  const turnBusyRef = useRef(false)
  // Per-turn sequence. Each turn captures its own id; its release only clears
  // turnBusyRef if it's still the current turn. Without this, an aborted turn's
  // release (firing when its speak() promise resolves) would clear the busy flag
  // of the new barge-in turn.
  const turnSeqRef = useRef(0)
  // Start time + normalized text of the in-flight turn — used by the Ctrl+C
  // interrupt guard to tell a real new command from a trailing STT fragment of
  // the utterance already being processed.
  const turnStartRef = useRef(0)
  const turnTextRef = useRef('')

  // wake_word listening window. Opened by hearing "jarvis" (on-device) or by the
  // wake-bus. While open we respond to every utterance; each turn re-arms the
  // timer so a conversation keeps going. Closes after inactivity.
  const wakeWindowRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openWakeWindow = useCallback(() => {
    setWakeListening(true)
    if (wakeWindowRef.current) clearTimeout(wakeWindowRef.current)
    wakeWindowRef.current = setTimeout(() => setWakeListening(false), WAKE_WINDOW_MS)
  }, [setWakeListening])


  // Local STT (faster-whisper) — always-on when voice enabled.
  // Each final transcript is sent to the backend for intent classification + response.
  const handleSttFinal = useCallback((text: string, speakerConfidence: number, sttSpeakerName?: string, meta?: { speakerConfidenceRaw?: number; avgLogprob?: number; confidence?: number; typed?: boolean }) => {
    if (!text.trim()) return
    // Texto escrito en el cuadro: no hay micrófono, así que no aplican la
    // confianza de voz, el filtro de eco ni la palabra de activación.
    const typed = !!meta?.typed

    // Minimum confidence required even outside of barge-in. TTS echo through
    // the mic returns conf ≈ 0 (speaker is Jarvis, not owner). Real owner
    // utterances should be >= 0.55 after lowering the voiceprint threshold.
    if (!typed && speakerConfidence < 0.55) {
      console.log(`[turn] ignored (low conf ${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      return
    }

    // Self-echo filter (novel-word based). Active while Jarvis speaks and for a
    // short tail after (the mic still carries residual echo). We drop the final
    // ONLY if it has no real speech — i.e. it's just Jarvis's own words coming
    // back. If the user talks over Jarvis, the transcript is a mix but still
    // carries novel words / a command word, so a genuine interruption (or
    // talking before the STT window closes) is NOT blocked.
    const msSinceSpoke = Date.now() - postSpeakTimeRef.current
    const echoActive = speakingRef.current || msSinceSpoke < 1200
    // La orden de parar se evalúa antes del eco y del wake gate: "para" es palabra
    // común (el filtro de eco la descartaría si Jarvis la dijo) y la ventana de
    // wake_word puede haber cerrado mientras habla.
    const stopOrder = (speakingRef.current || turnBusyRef.current) && isStopOnly(text)
    if (!typed && echoActive && !stopOrder && !hasRealSpeech(text, spokenTextRef.current)) {
      console.log(`[turn] ignored (self-echo, no novel words): "${text}"`)
      return
    }

    // wake_word gate. Mic is always open in this mode; we only act when the
    // window is open. Hearing "jarvis" opens it (and this same utterance is
    // handled, with the wake word stripped). Each accepted turn re-arms the
    // window so a back-and-forth keeps going without repeating "jarvis".
    if (voiceMode === 'wake_word' && !typed) {
      const heard = hasWakePhrase(text)
      if (!wakeListening && !heard && !stopOrder) {
        console.log(`[wake] gated (no wake word): "${text}"`)
        return
      }
      openWakeWindow()
      if (heard) {
        const stripped = stripWakePhrase(text)
        if (stripped) text = stripped
      }
    }

    // Always restore TTS gain when a final arrives — whether we barge in or not.
    // fast=true so the new reply (if any) plays at full volume immediately.
    if (duckRestoreRef.current) { clearTimeout(duckRestoreRef.current); duckRestoreRef.current = null }
    setTtsDucking(false, true)

    // Barge-in / Ctrl+C. A new real final (it already passed the novel-word echo
    // filter above, so it's genuine speech) interrupts the in-flight turn —
    // whether Jarvis is SPEAKING or still THINKING — and starts fresh, instead
    // of being dropped or waiting for the reply. This is the "Ctrl+C in the CLI"
    // behavior: aborting the turn's controller cancels the NDJSON stream AND any
    // TTS playback. (Echo never reaches here.)
    // A bare stop order ("para", "cállate") cuts Jarvis off and ENDS there. Sent
    // on as a new turn, the brain would answer it and Jarvis would start talking
    // again right after being told to stop. The aborted turn's own release()
    // clears the busy flag (its stream rejects → .finally).
    if (stopOrder) {
      console.log(`[turn] stop (barge-in, sin turno nuevo): "${text}"`)
      speakAbortRef.current?.abort()
      setCoreInput(text)
      return
    }
    if (speakingRef.current) {
      console.log(`[turn] barge-in (speaking, conf=${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      speakAbortRef.current?.abort()
      // fall through: this final becomes a fresh turn
    } else if (turnBusyRef.current) {
      // Thinking (Claude working, not yet speaking). Guard against the SAME
      // utterance's trailing STT fragment (a reconnect re-finalize or a late
      // segment) restarting the turn: within the grace window, ignore a final
      // that duplicates / is contained in the one already in flight.
      const sinceStart = Date.now() - turnStartRef.current
      const norm = normalizeForEcho(text)
      const prior = turnTextRef.current
      const dup = !!prior && (norm === prior || prior.includes(norm) || norm.includes(prior))
      if (sinceStart < INTERRUPT_GRACE_MS && dup) {
        console.log(`[turn] ignored (dup tail within grace ${sinceStart}ms): "${text}"`)
        return
      }
      console.log(`[turn] interrupt (thinking → Ctrl+C, conf=${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      speakAbortRef.current?.abort()
      // fall through: this final replaces the in-flight turn
    }
    setCoreInput(text)
    // Prefer the human-readable name from the store; fall back to the STT-detected
    // speaker ID (e.g. "owner") so turns are always attributed when the voiceprint
    // matches, even before the user has configured a display name.
    // Lo escrito en el cuadro lo teclea el señor: sin voz no hay speaker del STT,
    // así que se atribuye al dueño (si no, el backend lo trata como LOW_CONF).
    const resolvedName = speakerName || (speakerConfidence >= 0.65 ? sttSpeakerName : undefined) || (typed ? TYPED_OWNER_NAME : undefined)
    const nameForTurn = resolvedName || null

    const myTurn = ++turnSeqRef.current
    turnBusyRef.current = true
    turnStartRef.current = Date.now()
    turnTextRef.current = normalizeForEcho(text)
    // Longer safety than the buffered path: a streamed multi-sentence reply can
    // legitimately take a while across sentences.
    const safety = setTimeout(() => { if (turnSeqRef.current === myTurn) turnBusyRef.current = false }, 30000)
    const release = () => {
      clearTimeout(safety)
      ttsBusThinking(false) // turn over (spoken, silent, or failed) — back to idle
      if (turnSeqRef.current === myTurn) {
        turnBusyRef.current = false
        speakingRef.current = false
        postSpeakTimeRef.current = Date.now()
        // Don't close the wake window here — the inactivity timer (re-armed each
        // turn in the gate above) owns closing it, so follow-up turns within the
        // window don't need the wake word repeated.
      }
    }

    const payload = { text, speakerConfidence, speakerConfidenceRaw: meta?.speakerConfidenceRaw ?? (typed ? 1 : undefined), speakerName: nameForTurn, alwaysOn: true, context: { mode }, avgLogprob: meta?.avgLogprob, confidence: meta?.confidence }
    console.log(`[speech] -> converse text="${text}" conf=${speakerConfidence?.toFixed?.(2) ?? speakerConfidence} name=${nameForTurn}`)

    // One AbortController for the whole turn: aborting it (barge-in / newer turn)
    // cancels the NDJSON stream AND the in-flight sentence playback.
    const ctrl = new AbortController()
    speakAbortRef.current?.abort()
    speakAbortRef.current = ctrl

    const ttsUrl = `${getApiBase()}/api/jarvis/tts/ws`
    let spoke = false
    let shown = ''
    ctrl.signal.addEventListener('abort', () => { speakingRef.current = false }, { once: true })

    // One persistent TTS session for the whole reply. Sentences pipe into a
    // single server-side paplay back-to-back: gapless, no overlap, no respawn
    // dead-air. The session is created lazily on the first sentence.
    let session: TtsSession | null = null
    const speakSentence = (t: string) => {
      // Un sentence tardío de un turno abortado no debe dejar speakingRef en true.
      if (ctrl.signal.aborted) return
      spoke = true
      speakingRef.current = true
      ttsBusThinking(false) // reply started — hologram switches to speak-inflate
      if (!session) session = streamTtsSession({ url: ttsUrl, lang: 'es', fx: true, signal: ctrl.signal })
      session.speak(t)
    }

    ttsBusThinking(true) // turn in flight — hologram grows while the brain works
    ctrl.signal.addEventListener('abort', () => ttsBusThinking(false), { once: true })
    streamConverse(`${getApiBase()}/api/jarvis/converse`, payload, {
      signal: ctrl.signal,
      onSentence: (t) => {
        if (!t) return
        console.log(`[speech] <- sentence "${t.slice(0, 40)}"`)
        shown = shown ? `${shown} ${t}` : t
        setCoreReply(shown)
        if (voiceEnabled) speakSentence(t)
      },
      onDone: (result) => {
        console.log(`[speech] <- done action=${result.action} reason=${result.reason ?? '-'} state=${result.state ?? '-'}`)
        if (result?.reply) setCoreReply(result.reply)
      },
    })
      .then(() => { session?.end(); return session?.done }) // flush + wait for full reply to finish
      .catch(async (e) => {
        if ((e as any)?.name === 'AbortError' || ctrl.signal.aborted) return
        console.warn('[speech] converse failed, falling back to process-speech:', (e as Error)?.message)
        if (spoke) return
        try {
          const data = await apiFetch(`/api/jarvis/process-speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(r => r.json())
          if (data.action === 'respond' && data.reply) { setCoreReply(data.reply); await speak(data.reply) }
        } catch (e2) { console.warn('[speech] fallback failed', e2) }
      })
      .finally(release)
  }, [mode, setCoreInput, setCoreReply, voiceEnabled, voiceMode, wakeListening, openWakeWindow, speakerName, speak])

  // wake_word keeps the mic OPEN continuously (so the wake word can ever be
  // heard). The response is gated on the word "jarvis" in handleSttFinal, not on
  // the mic being closed.
  const sttEnabled =
    voiceMode === 'continuous' ||
    voiceMode === 'wake_word' ||
    (voiceMode === 'ptt' && pttActive)
  const { listening: sttListening } = useLocalStt({
    enabled: sttEnabled,
    onFinalTranscript: handleSttFinal,
    onInterimTranscript: (text) => {
      setCoreInput(text)
      duckTts()  // fade Jarvis down as soon as speech detected mid-reply
    },
  })

  const handleWakeDetected = useCallback(() => {
    if (turnBusyRef.current) return
    const myTurn = ++turnSeqRef.current
    turnBusyRef.current = true
    const safety = setTimeout(() => { if (turnSeqRef.current === myTurn) turnBusyRef.current = false }, 12000)
    speak(getWakeConfirmation(focusedEntity?.label)).finally(() => { clearTimeout(safety); if (turnSeqRef.current === myTurn) turnBusyRef.current = false })
  }, [focusedEntity, speak])

  useClapDetection({ enabled: clapWakeEnabled && voiceMode !== 'off', onDoubleClap: handleWakeDetected })

  // In wake_word mode, an external trigger (openWakeWord via wake-bus) can also
  // open the listening window, in addition to the on-device "jarvis" gate below.
  useEffect(() => {
    if (voiceMode !== 'wake_word') return
    let ws: WebSocket | null = null
    let stopped = false

    function connect() {
      if (stopped) return
      ws = new WebSocket(`${getApiBase().replace(/^http/, 'ws')}/api/jarvis/wake-bus`)
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string)
          if (msg.type === 'wake') openWakeWindow()
        } catch {}
      }
      ws.onclose = () => { if (!stopped) setTimeout(connect, 3000) }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      stopped = true
      ws?.close()
      setWakeListening(false)
    }
  }, [voiceMode, openWakeWindow, setWakeListening])

  const isVoiceActive = sttListening || wakeListening
  // Para las ETIQUETAS del modo de voz, no `sttListening`: en continuo y en
  // wake_word el micro está abierto siempre, así que «Escuchando…» tapaba el
  // nombre del modo y los dos se veían idénticos (parecía que wake no existía).
  // Solo cuenta como escucha la ventana de wake abierta o el PTT sostenido.
  const voiceHeard = wakeListening || (voiceMode === 'ptt' && sttListening)
  const audioLevel = useAudioLevel({ enabled: isVoiceActive })

  // Early duck: as soon as mic level rises (before any transcript), fade Jarvis
  // down. duckTts() is a no-op when TTS isn't playing, so no guard needed here.
  useEffect(() => {
    if (audioLevel > 0.12) duckTts()
  }, [audioLevel, duckTts])

  return { handleSttFinal, isVoiceActive, voiceHeard }
}
