import os from 'os'
import { json } from '../lib/http.js'
import { execCmd } from '../lib/exec.js'

let lastCpuSnapshot = null
let lastNetSnapshot = null

function takeCpuSnapshot() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }
  return { idle, total, ts: Date.now() }
}

async function getGpuTelemetry() {
  const raw = await execCmd('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits')
  if (!raw) return { available: false }
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const parsed = rows.map((line) => {
    const [gpu, memUsed, memTotal, temp] = line.split(',').map((x) => Number(String(x).trim()))
    return {
      utilizationPct: Number.isFinite(gpu) ? gpu : 0,
      memoryUsedMB: Number.isFinite(memUsed) ? memUsed : 0,
      memoryTotalMB: Number.isFinite(memTotal) ? memTotal : 0,
      temperatureC: Number.isFinite(temp) ? temp : null,
    }
  })
  const avgUtil = parsed.length ? parsed.reduce((a, b) => a + b.utilizationPct, 0) / parsed.length : 0
  return { available: true, gpus: parsed, avgUtilizationPct: avgUtil }
}

async function getNetworkTelemetry() {
  const raw = await execCmd('powershell -NoProfile -Command "Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress"')
  if (!raw) return { rxMbps: 0, txMbps: 0 }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const totalRx = list.reduce((acc, item) => acc + Number(item?.ReceivedBytes || 0), 0)
    const totalTx = list.reduce((acc, item) => acc + Number(item?.SentBytes || 0), 0)
    const now = Date.now()

    if (!lastNetSnapshot) {
      lastNetSnapshot = { totalRx, totalTx, ts: now }
      return { rxMbps: 0, txMbps: 0 }
    }

    const dt = Math.max(1, now - lastNetSnapshot.ts)
    const rxMbps = ((totalRx - lastNetSnapshot.totalRx) * 8) / dt / 1000
    const txMbps = ((totalTx - lastNetSnapshot.totalTx) * 8) / dt / 1000
    lastNetSnapshot = { totalRx, totalTx, ts: now }
    return { rxMbps: Math.max(0, rxMbps), txMbps: Math.max(0, txMbps) }
  } catch {
    return { rxMbps: 0, txMbps: 0 }
  }
}

function getCpuTelemetry() {
  const nowSnap = takeCpuSnapshot()
  if (!lastCpuSnapshot) {
    lastCpuSnapshot = nowSnap
    return { usagePct: 0 }
  }
  const idleDiff = nowSnap.idle - lastCpuSnapshot.idle
  const totalDiff = nowSnap.total - lastCpuSnapshot.total
  lastCpuSnapshot = nowSnap
  const usagePct = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0
  return { usagePct: Math.max(0, Math.min(100, usagePct)) }
}

async function getOpenClawTelemetry() {
  const statusText = await execCmd('openclaw status', 5000)
  const tokenMatch = statusText.match(/(codex|tokens?).*?(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i)
  const used = tokenMatch ? Number(tokenMatch[2].replace(/,/g, '')) : null
  const total = tokenMatch ? Number(tokenMatch[3].replace(/,/g, '')) : null
  return {
    statusText: statusText || 'openclaw status no disponible',
    codexTokensUsed: Number.isFinite(used) ? used : null,
    codexTokensTotal: Number.isFinite(total) ? total : null,
  }
}

export async function handleTelemetry(_req, res) {
  const cpu = getCpuTelemetry()
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const memUsed = memTotal - memFree
  const memory = { usedGB: +(memUsed / 1024 ** 3).toFixed(2), totalGB: +(memTotal / 1024 ** 3).toFixed(2), usagePct: +(memUsed / memTotal * 100).toFixed(1) }
  const [gpu, network, openclaw] = await Promise.all([getGpuTelemetry(), getNetworkTelemetry(), getOpenClawTelemetry()])

  return json(res, 200, {
    ok: true,
    host: {
      cpu,
      memory,
      gpu,
      network,
      timestamp: new Date().toISOString(),
    },
    openclaw,
  })
}
