// Simple WebAudio alarm — three rising beeps. No asset needed.

let ctx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  return ctx
}

function beep(start: number, freq: number, durSec: number) {
  const ac = getCtx()
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(0.35, start + 0.02)
  gain.gain.linearRampToValueAtTime(0, start + durSec)
  osc.connect(gain).connect(ac.destination)
  osc.start(start)
  osc.stop(start + durSec + 0.05)
}

export function playTimerAlarm() {
  const ac = getCtx()
  if (ac.state === 'suspended') { try { ac.resume() } catch {} }
  const t0 = ac.currentTime
  beep(t0,       880, 0.22)
  beep(t0 + 0.3, 988, 0.22)
  beep(t0 + 0.6, 1175, 0.32)
}
