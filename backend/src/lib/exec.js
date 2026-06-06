import { exec as execCb } from 'child_process'

export function execCmd(command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execCb(
      command,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return resolve('')
        resolve(String(stdout || stderr || '').trim())
      },
    )
  })
}
