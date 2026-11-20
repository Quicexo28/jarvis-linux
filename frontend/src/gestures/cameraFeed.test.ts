// Apertura única de cámara: concurrencia, off→on rápido y timeouts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Track = { stop: ReturnType<typeof vi.fn> }
function fakeStream(): { stream: MediaStream; track: Track } {
  const track: Track = { stop: vi.fn() }
  const stream = { active: true, getTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}

let cam: typeof import('./cameraFeed')
let gum: ReturnType<typeof vi.fn>
let playSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  gum = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum }, configurable: true })
  playSpy = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.play = playSpy as unknown as () => Promise<void>
  cam = await import('./cameraFeed')
})

afterEach(() => {
  vi.useRealTimers()
  document.querySelectorAll('video').forEach(v => v.remove())
})

describe('cameraFeed', () => {
  it('dos openCamera concurrentes llaman getUserMedia una vez', async () => {
    const { stream } = fakeStream()
    gum.mockResolvedValue(stream)
    const [a, b] = await Promise.all([cam.openCamera(), cam.openCamera()])
    expect(gum).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('closeCamera con apertura en vuelo y openCamera reutiliza la apertura', async () => {
    const { stream, track } = fakeStream()
    gum.mockResolvedValue(stream)
    const first = cam.openCamera()
    cam.closeCamera()
    const second = cam.openCamera()
    await expect(Promise.all([first, second])).resolves.toBeTruthy()
    expect(gum).toHaveBeenCalledTimes(1)
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('closeCamera sin reabrir para los tracks del stream tardío y rechaza', async () => {
    const { stream, track } = fakeStream()
    let resolveGum!: (s: MediaStream) => void
    gum.mockReturnValue(new Promise<MediaStream>(r => { resolveGum = r }))
    const p = cam.openCamera()
    cam.closeCamera()
    resolveGum(stream)
    await expect(p).rejects.toThrow('cámara cancelada')
    expect(track.stop).toHaveBeenCalled()
    expect(cam.getGestureVideo()).toBeNull()
  })

  it('play() que nunca resuelve rechaza a los 12 s y para tracks', async () => {
    vi.useFakeTimers()
    const { stream, track } = fakeStream()
    gum.mockResolvedValue(stream)
    playSpy.mockReturnValue(new Promise(() => {}))
    const p = cam.openCamera()
    const assertion = expect(p).rejects.toThrow('video.play()')
    await vi.advanceTimersByTimeAsync(12000)
    await assertion
    expect(track.stop).toHaveBeenCalled()
  })
})
