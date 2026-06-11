import { useEffect, useRef } from 'react'
import { useJarvisStore } from '../state/jarvisStore'

/**
 * In-app push-to-talk key handling. While `pttEnabled`, holding the `pttKey`
 * combo (e.g. 'Ctrl+Alt+KeyV' — modifiers + KeyboardEvent.code) sets
 * `pttActive`; releasing it clears it after a short grace period so the STT
 * VAD (~960 ms of silence) can finalize the last segment before the mic
 * closes. A combo (not a bare key) is required: PTT is meant to mirror the
 * system-wide Hyprland bind, and a single key would fire while typing.
 * The global bind takes the other path: POST /api/jarvis/ptt/start|stop →
 * skill bus `ptt_set` → same store.
 */

const RELEASE_GRACE_MS = 1500

interface Combo {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  code: string
}

function parseCombo(spec: string): Combo {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean)
  const combo: Combo = { ctrl: false, alt: false, shift: false, meta: false, code: '' }
  for (const p of parts) {
    const low = p.toLowerCase()
    if (low === 'ctrl' || low === 'control') combo.ctrl = true
    else if (low === 'alt') combo.alt = true
    else if (low === 'shift') combo.shift = true
    else if (low === 'meta' || low === 'super') combo.meta = true
    else combo.code = p
  }
  return combo
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
    || (t instanceof HTMLElement && t.isContentEditable)
}

export function usePushToTalk() {
  const pttEnabled = useJarvisStore((s) => s.pttEnabled)
  const pttKey = useJarvisStore((s) => s.pttKey)
  const setPttActive = useJarvisStore((s) => s.setPttActive)
  const releaseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pttEnabled) return
    const combo = parseCombo(pttKey)
    if (!combo.code) return

    const clearReleaseTimer = () => {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = null
      }
    }

    const scheduleRelease = () => {
      clearReleaseTimer()
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null
        setPttActive(false)
      }, RELEASE_GRACE_MS)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== combo.code || e.repeat || isTypingTarget(e.target)) return
      if (e.ctrlKey !== combo.ctrl || e.altKey !== combo.alt
        || e.shiftKey !== combo.shift || e.metaKey !== combo.meta) return
      e.preventDefault()
      clearReleaseTimer()
      setPttActive(true)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (!useJarvisStore.getState().pttActive) return
      // Releasing the main key OR any required modifier ends the hold.
      const releasedModifier =
        (combo.ctrl && (e.key === 'Control' || !e.ctrlKey))
        || (combo.alt && (e.key === 'Alt' || !e.altKey))
        || (combo.shift && (e.key === 'Shift' || !e.shiftKey))
        || (combo.meta && (e.key === 'Meta' || !e.metaKey))
      if (e.code === combo.code || releasedModifier) scheduleRelease()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      clearReleaseTimer()
      setPttActive(false)
    }
  }, [pttEnabled, pttKey, setPttActive])
}
