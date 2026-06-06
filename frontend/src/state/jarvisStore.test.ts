import { test, expect, beforeEach } from 'vitest'
import { useJarvisStore } from './jarvisStore'

beforeEach(() => {
  useJarvisStore.setState({
    mode: 'house',
    voiceEnabled: true,
    wakeListening: false,
    wakePhrase: 'jarvis',
    coreInput: '',
    coreReply: '',
    focusedEntity: null,
    housePlans: [],
    entitiesByPlan: {},
    viewpointByPlan: {},
    ringLevel: 'main',
    activeRingMode: 'home',
  })
})

test('setMode updates mode', () => {
  useJarvisStore.getState().setMode('home')
  expect(useJarvisStore.getState().mode).toBe('home')
})

test('setVoiceEnabled toggles voiceEnabled', () => {
  useJarvisStore.getState().setVoiceEnabled(false)
  expect(useJarvisStore.getState().voiceEnabled).toBe(false)
})

test('setCoreInput and setCoreReply update conversation state', () => {
  useJarvisStore.getState().setCoreInput('hola jarvis')
  useJarvisStore.getState().setCoreReply('Hola, ¿en qué puedo ayudarte?')
  const state = useJarvisStore.getState()
  expect(state.coreInput).toBe('hola jarvis')
  expect(state.coreReply).toBe('Hola, ¿en qué puedo ayudarte?')
})

test('setWakePhrase updates wakePhrase', () => {
  useJarvisStore.getState().setWakePhrase('hey jarvis')
  expect(useJarvisStore.getState().wakePhrase).toBe('hey jarvis')
})

test('rotateRing(+1) cycles home -> house -> system -> cloud -> utils -> home', () => {
  const s = useJarvisStore.getState
  s().setActiveRingMode('home')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('house')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('system')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('cloud')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('utils')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('home')
})

test('rotateRing(-1) from home wraps to utils', () => {
  const s = useJarvisStore.getState
  s().setActiveRingMode('home')
  s().rotateRing(-1)
  expect(s().activeRingMode).toBe('utils')
})

test("setRingLevel('utils-sub') resets activeRingMode to timer", () => {
  useJarvisStore.getState().setActiveRingMode('home')
  useJarvisStore.getState().setRingLevel('utils-sub')
  const state = useJarvisStore.getState()
  expect(state.ringLevel).toBe('utils-sub')
  expect(state.activeRingMode).toBe('timer')
})

test('rotateRing in utils-sub cycles timer -> chrono -> timer', () => {
  useJarvisStore.getState().setRingLevel('utils-sub')
  const s = useJarvisStore.getState
  expect(s().activeRingMode).toBe('timer')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('chrono')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('timer')
})

test("setRingLevel('house-sub') resets activeRingMode to plan3d", () => {
  useJarvisStore.getState().setActiveRingMode('cloud')
  useJarvisStore.getState().setRingLevel('house-sub')
  const state = useJarvisStore.getState()
  expect(state.ringLevel).toBe('house-sub')
  expect(state.activeRingMode).toBe('plan3d')
})

test("setRingLevel('main') resets activeRingMode to house", () => {
  useJarvisStore.setState({ ringLevel: 'house-sub', activeRingMode: 'plan2d' })
  useJarvisStore.getState().setRingLevel('main')
  const state = useJarvisStore.getState()
  expect(state.ringLevel).toBe('main')
  expect(state.activeRingMode).toBe('house')
})

test('rotateRing in house-sub cycles plan3d -> space -> plan2d -> plan3d', () => {
  useJarvisStore.getState().setRingLevel('house-sub')
  const s = useJarvisStore.getState
  expect(s().activeRingMode).toBe('plan3d')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('space')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('plan2d')
  s().rotateRing(1)
  expect(s().activeRingMode).toBe('plan3d')
})
