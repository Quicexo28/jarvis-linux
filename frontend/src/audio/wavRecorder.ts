/**
 * Minimal 16 kHz mono WAV recorder, shared by the enrollment wizard and any
 * future voice-sample UI. Same capture/encoding pipeline as
 * SpeakerConfigWindow (ScriptProcessor PCM → 16-bit WAV) so samples are
 * uniform for the resemblyzer embeddings.
 */

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export interface WavRecording {
  /** Stop capture and get the encoded WAV. */
  stop: () => Blob
  /** Stop capture and discard everything. */
  cancel: () => void
}

const SAMPLE_RATE = 16000

export async function startWavRecording(): Promise<WavRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: false },
  })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)

  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(ctx.destination)

  const teardown = () => {
    try { processor.disconnect() } catch { /* already gone */ }
    try { source.disconnect() } catch { /* already gone */ }
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
  }

  return {
    stop: () => {
      teardown()
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const pcm = new Float32Array(total)
      let off = 0
      for (const c of chunks) { pcm.set(c, off); off += c.length }
      return encodeWav(pcm, SAMPLE_RATE)
    },
    cancel: teardown,
  }
}
