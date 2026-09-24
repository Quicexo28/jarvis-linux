import { test, describe, it, expect, beforeEach } from 'vitest'
import { useJarvisStore } from './jarvisStore'
import { MAIN_RING } from '../constants'

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

// Se DERIVA de MAIN_RING en vez de enumerar los modos a mano: la versión
// anterior fijaba el orden de los cinco slots de entonces, así que añadir
// 'vault' la rompió sin que nada estuviera mal. Lo que de verdad hay que
// proteger es la propiedad —avanza un slot y da la vuelta—, no la lista.
test('rotateRing(+1) recorre el anillo principal y da la vuelta', () => {
  const s = useJarvisStore.getState
  s().setActiveRingMode(MAIN_RING[0])
  for (let i = 1; i <= MAIN_RING.length; i++) {
    s().rotateRing(1)
    expect(s().activeRingMode).toBe(MAIN_RING[i % MAIN_RING.length])
  }
})

test('el anillo principal incluye el grafo de conocimiento', () => {
  expect(MAIN_RING).toContain('vault')
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

describe('ringAngle ↔ activeRingMode (invariante del carrusel)', () => {
  it('elegir un modo mueve también el ángulo: el anillo lo SIGUE', () => {
    // Antes el renderer seguía el modo y `ringAngle` era un valor fantasma que
    // solo escribía el arrastre; ahora la fuente es el ángulo, así que tocar un
    // holograma tiene que actualizarlo o el carrusel se queda quieto.
    const { setRingLevel, setActiveRingMode } = useJarvisStore.getState()
    setRingLevel('main')
    setActiveRingMode(MAIN_RING[2])
    expect(useJarvisStore.getState().ringAngle).toBe(2)
    expect(useJarvisStore.getState().activeRingMode).toBe(MAIN_RING[2])
  })

  it('mientras se ARRASTRA, resaltar un slot no pisa el ángulo continuo', () => {
    const st = useJarvisStore.getState()
    st.setRingLevel('main')
    st.setRingDragging(true)
    st.setRingAngle(1.4)
    st.setActiveRingMode(MAIN_RING[1])
    expect(useJarvisStore.getState().ringAngle).toBe(1.4)
    st.setRingDragging(false)
  })

  it('volver al anillo principal deja el ángulo en su slot de entrada', () => {
    const st = useJarvisStore.getState()
    st.setRingAngle(4.7)
    st.setRingLevel('main')
    expect(useJarvisStore.getState().ringAngle).toBe(MAIN_RING.indexOf('house'))
  })
})
