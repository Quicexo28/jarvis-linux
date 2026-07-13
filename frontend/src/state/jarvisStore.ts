import { create } from 'zustand'
import type { Mode, SceneEntity, SavedPlan, Viewpoint } from '../types'

export type RingLevel = 'main' | 'house-sub' | 'utils-sub'
export type VoiceMode = 'off' | 'continuous' | 'wake_word' | 'ptt'

const VOICE_MODE_KEY = 'jarvis.voiceMode.v1'
function loadVoiceMode(): VoiceMode {
  try {
    const v = localStorage.getItem(VOICE_MODE_KEY)
    if (v === 'off' || v === 'continuous' || v === 'wake_word' || v === 'ptt') return v
  } catch {}
  return 'continuous'
}

const MAIN_RING: Mode[] = ['home', 'house', 'system', 'cloud', 'utils']
const SUB_RING: Mode[] = ['plan3d', 'space', 'plan2d']
const SUB_RING_UTILS: Mode[] = ['timer', 'chrono']

const SPEAKER_NAME_KEY = 'jarvis.speaker.name.v1'

// Decoy/non-owner speaker names that must never be used as the active user.
// 'jarvis_tts' was an anti-echo decoy that the speaker list could auto-select.
const INVALID_SPEAKER_NAMES = new Set(['default', 'jarvis_tts'])

function loadSpeakerName(): string {
  try {
    const v = localStorage.getItem(SPEAKER_NAME_KEY) || ''
    // Drop legacy/decoy names so a stale value never attributes turns wrongly.
    if (INVALID_SPEAKER_NAMES.has(v)) {
      try { localStorage.removeItem(SPEAKER_NAME_KEY) } catch {}
      return ''
    }
    return v
  } catch {
    return ''
  }
}

interface JarvisState {
  mode: Mode
  zoomedMode: Mode | null
  voiceMode: VoiceMode
  voiceEnabled: boolean
  wakeListening: boolean
  wakePhrase: string
  clapWakeEnabled: boolean
  coreInput: string
  coreReply: string
  focusedEntity: SceneEntity | null
  housePlans: SavedPlan[]
  entitiesByPlan: Record<string, SceneEntity[]>
  viewpointByPlan: Record<string, Viewpoint>
  // Plan key (room::name) the agent asked the 3D viewer to load, if any.
  requestedPlanKey: string | null

  pinchZoomProgress: number

  speakerName: string

  /** True while the PTT key (F9) is held — activates STT when window is out of focus. */
  pttActive: boolean

  ringLevel: RingLevel
  activeRingMode: Mode
  /** Continuous ring angle in slot units. Integer = at a slot. Updated while dragging. */
  ringAngle: number
  setRingAngle: (angle: number) => void

  setMode: (mode: Mode) => void
  setZoomedMode: (mode: Mode | null) => void
  setVoiceMode: (mode: VoiceMode) => void
  setVoiceEnabled: (enabled: boolean) => void
  setWakeListening: (listening: boolean) => void
  setWakePhrase: (phrase: string) => void
  setClapWakeEnabled: (enabled: boolean) => void
  setCoreInput: (input: string) => void
  setCoreReply: (reply: string) => void
  setFocusedEntity: (entity: SceneEntity | null) => void
  setHousePlans: (plans: SavedPlan[]) => void
  setEntitiesByPlan: (record: Record<string, SceneEntity[]>) => void
  setViewpointByPlan: (record: Record<string, Viewpoint>) => void
  setRequestedPlanKey: (key: string | null) => void

  setPinchZoomProgress: (p: number) => void

  setSpeakerName: (name: string) => void

  setPttActive: (active: boolean) => void

  setRingLevel: (level: RingLevel) => void
  rotateRing: (direction: -1 | 1) => void
  setActiveRingMode: (mode: Mode) => void
}

export const useJarvisStore = create<JarvisState>((set, get) => ({
  mode: 'home',
  zoomedMode: null,
  voiceMode: loadVoiceMode(),
  voiceEnabled: true,
  wakeListening: false,
  wakePhrase: 'jarvis',
  clapWakeEnabled: false,
  coreInput: '',
  coreReply: '',
  focusedEntity: null,
  housePlans: [],
  entitiesByPlan: {},
  viewpointByPlan: {},
  requestedPlanKey: null,

  pinchZoomProgress: 0,

  speakerName: loadSpeakerName(),

  pttActive: false,

  ringLevel: 'main',
  activeRingMode: 'home',
  ringAngle: 0,

  setMode: (mode) => set({ mode }),
  setZoomedMode: (zoomedMode) => set({ zoomedMode, ...(zoomedMode ? { mode: zoomedMode } : {}) }),
  setVoiceMode: (voiceMode) => {
    try { localStorage.setItem(VOICE_MODE_KEY, voiceMode) } catch {}
    set({ voiceMode, voiceEnabled: voiceMode !== 'off' })
  },
  setVoiceEnabled: (voiceEnabled) => set({ voiceEnabled }),
  setWakeListening: (wakeListening) => set({ wakeListening }),
  setWakePhrase: (wakePhrase) => set({ wakePhrase }),
  setClapWakeEnabled: (clapWakeEnabled) => set({ clapWakeEnabled }),
  setCoreInput: (coreInput) => set({ coreInput }),
  setCoreReply: (coreReply) => set({ coreReply }),
  setFocusedEntity: (focusedEntity) => set({ focusedEntity }),
  setHousePlans: (housePlans) => set({ housePlans }),
  setEntitiesByPlan: (entitiesByPlan) => set({ entitiesByPlan }),
  setViewpointByPlan: (viewpointByPlan) => set({ viewpointByPlan }),
  setRequestedPlanKey: (requestedPlanKey) => set({ requestedPlanKey }),

  setPinchZoomProgress: (pinchZoomProgress) => set({ pinchZoomProgress }),

  setPttActive: (pttActive) => set({ pttActive }),

  setSpeakerName: (speakerName) => {
    // Never adopt a decoy/legacy name as the active user.
    if (INVALID_SPEAKER_NAMES.has(speakerName)) speakerName = ''
    try { localStorage.setItem(SPEAKER_NAME_KEY, speakerName) } catch {}
    set({ speakerName })
  },

  setRingLevel: (level) =>
    set({
      ringLevel: level,
      // Reset focus to the entry-point of the new level so users land in a known slot.
      activeRingMode:
        level === 'house-sub' ? 'plan3d'
        : level === 'utils-sub' ? 'timer'
        : 'house',
    }),

  rotateRing: (direction) => {
    const { ringLevel, activeRingMode } = get()
    const list =
      ringLevel === 'house-sub' ? SUB_RING
      : ringLevel === 'utils-sub' ? SUB_RING_UTILS
      : MAIN_RING
    const idx = list.indexOf(activeRingMode)
    const next = ((idx === -1 ? 0 : idx) + direction + list.length) % list.length
    set({ activeRingMode: list[next], ringAngle: next })
  },

  setRingAngle: (ringAngle) => set({ ringAngle }),

  setActiveRingMode: (activeRingMode) => set({ activeRingMode }),
}))
