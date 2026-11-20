// Corte del player de TTS (sh -c 'ffmpeg | paplay').
// player.kill() manda SIGTERM solo a `sh`: ffmpeg y paplay siguen vivos y suenan
// ~5,7 s (medido: 5719 ms) encima de la voz nueva. Con el player en grupo propio
// (spawn detached) y SIGKILL al grupo entero mueren en ~20 ms.
export function killProcessGroup(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH: el grupo ya terminó; es lo normal si el corte llega tarde.
  }
}
