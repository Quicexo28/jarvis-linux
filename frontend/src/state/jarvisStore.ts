import { create } from 'zustand'
import type { Mode, SceneEntity, SavedPlan, Viewpoint } from '../types'

export type RingLevel = 'main' | 'house-sub' | 'utils-sub'

const MAIN_RING: Mode[] = ['home', 'house', 'system', 'cloud', 'utils']
const SUB_RING: Mode[] = ['plan3d', 'space', 'plan2d']
const SUB_RING_UTILS: Mode[] = ['timer', 'chrono']

const SPEAKER_NAME_KEY = 'jarvis.speaker.name.v1'
const PTT_ENABLED_KEY = 'jarvis.ptt.enabled.v1'
const PTT_KEY_KEY = 'jarvis.ptt.key.v1'

function loadSpeakerName(): string {
  try {
    const v = localStorage.getItem(SPEAKER_NAME_KEY) || ''
    // Legacy: 'default' is no longer a real speaker — treat as unset.
    return v === 'default' ? '' : v
  } catch {
    return ''
  }
}

function loadPttEnabled(): boolean {
  try { return localStorage.getItem(PTT_ENABLED_KEY) === '1' } catch { return false }
}

// Combo format: 'Ctrl+Alt+KeyV' (modifiers + KeyboardEvent.code). Matches the
// global Hyprland bind so PTT feels identical with or without app focus.
const DEFAULT_PTT_KEY = 'Ctrl+Alt+KeyV'

function loadPttKey(): string {
  try {
    const v = localStorage.getItem(PTT_KEY_KEY) || ''
    // Legacy single-key values (e.g. 'Space') are too easy to hit by accident
    // for a function meant to work system-wide — migrate to the combo default.
    return v.includes('+') ? v : DEFAULT_PTT_KEY
  } catch {
    return DEFAULT_PTT_KEY
  }
}

interface JarvisState {
  mode: Mode
  zoomedMode: Mode | null
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

  /** Push-to-talk: when enabled, the mic only streams while the key is held. */
  pttEnabled: boolean
  /** PTT combo: modifiers + KeyboardEvent.code, e.g. 'Ctrl+Alt+KeyV'. */
  pttKey: string
  /** True while the PTT key is held (in-app key or global Hyprland bind). */
  pttActive: boolean

  ringLevel: RingLevel
  activeRingMode: Mode
  /** Continuous ring angle in slot units. Integer = at a slot. Updated while dragging. */
  ringAngle: number
  setRingAngle: (angle: number) => void

  setMode: (mode: Mode) => void
  setZoomedMode: (mode: Mode | null) => void
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

  setPttEnabled: (enabled: boolean) => void
  setPttKey: (key: string) => void
  setPttActive: (active: boolean) => void

  setRingLevel: (level: RingLevel) => void
  rotateRing: (direction: -1 | 1) => void
  setActiveRingMode: (mode: Mode) => void
}

export const useJarvisStore = create<JarvisState>((set, get) => ({
  mode: 'home',
  zoomedMode: null,
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

  pttEnabled: loadPttEnabled(),
  pttKey: loadPttKey(),
  pttActive: false,

  ringLevel: 'main',
  activeRingMode: 'home',
  ringAngle: 0,

  setMode: (mode) => set({ mode }),
  setZoomedMode: (zoomedMode) => set({ zoomedMode, ...(zoomedMode ? { mode: zoomedMode } : {}) }),
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

  setSpeakerName: (speakerName) => {
    try { localStorage.setItem(SPEAKER_NAME_KEY, speakerName) } catch {}
    set({ speakerName })
  },

  setPttEnabled: (pttEnabled) => {
    try { localStorage.setItem(PTT_ENABLED_KEY, pttEnabled ? '1' : '0') } catch {}
    set({ pttEnabled, ...(pttEnabled ? {} : { pttActive: false }) })
  },
  setPttKey: (pttKey) => {
    try { localStorage.setItem(PTT_KEY_KEY, pttKey) } catch {}
    set({ pttKey })
  },
  setPttActive: (pttActive) => set({ pttActive }),

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
