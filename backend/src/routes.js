import { json } from './lib/http.js'
import { authorize } from './lib/webAuth.js'
import { checkToolRisk } from './lib/toolRisk.js'
import { existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { handleHealth } from './handlers/health.js'
import { handleModules } from './handlers/modules.js'
import { handleDeviceAction, handleJarvisTurn, handleJarvisWake, handleJarvisTts, handleFillerWav, handleAgentHealth } from './handlers/jarvis.js'
import { handleTelemetry } from './handlers/telemetry.js'
import { handleSttTranscribe } from './handlers/stt.js'
import { handleVisionScreen, handleVisionCamera } from './handlers/vision.js'
import { handleProcessSpeech, handleConverse, handleSpeculative, handleTurnStats, handleMemoryList, handleMemoryForget, handleProactiveRun, handleProactiveStatus } from './handlers/speech.js'
import {
  handleSpeakerIdList,
  handleSpeakerIdUpload,
  handleSpeakerIdDelete,
  handleSpeakerIdReset,
  handleSpeakerIdReload,
  handleSpeakerIdStatus,
  handleSpeakerIdThreshold,
  handleSpeakersList,
  handleSpeakersCreate,
  handleSpeakersDelete,
  handleRejectedList,
  handleRejectedRestore,
  handleRejectedDelete,
  handleWakeReload,
} from './handlers/speakerId.js'
import {
  handleMobileToken,
  handleMobileAuth,
  handleMobileStatus,
  handleMobileRefresh,
  handleMobileSendQr,
} from './handlers/mobile.js'
import {
  handleCtxLocation, handleCtxPlace, handleCtxBattery, handleCtxFocus,
  handleCtxSleep, handleCtxPresence, handleCtxCurrent, handleCtxSummary,
} from './handlers/mobileContext.js'
import { handleObsidianStatus } from './handlers/obsidian.js'
import { handleVaultGraph } from './handlers/knowledge.js'
import { handleVaultIngest } from './handlers/vaultIngest.js'
import { handleSystemConfig } from './handlers/config.js'
import { handleWakeDetected, handleWakeCalibrate, handleWakeStatus } from './handlers/wakeWord.js'
import { handleUiState, handleGestureToggle, handleGestureStatus } from './handlers/uiState.js'
import {
  handleTimerStart, handleTimerPause, handleTimerResume, handleTimerAdd,
  handleTimerCancel, handleTimerReset, handleTimerList,
  handleChronoStart, handleChronoPause, handleChronoResume, handleChronoReset,
  handleChronoLap, handleChronoCancel, handleChronoList,
  handleReminderCreate, handleReminderList, handleNotifyNow, handleTimeNow,
  handleMobileWhere, handleMobileRoutine,
  handleViewOpen, handleViewClose, handleViewCurrent, handleRingRotate,
  handleOverlayOpen, handleOverlayClose, handleSystemSleep, handleSystemWake,
  handleVoiceToggle, handleClapToggle, handlePttStart, handlePttStop,
  handleObsidianTaskCreate, handleObsidianNoteCreate, handleObsidianTaskList,
  handleObsidianNoteSearch, handleObsidianPersonalize,
  handleVaultFocus,
  handleDisplayShow, handleDisplayHide,
  handleSpeechSay, handlePickFile,
  handleModel3dShow, handleModel3dHide, handleModel3dSim,
  handleCloudSave, handleCloudList,
  handleModel3dAdd,
  handleRgbSet, handleRgbPreset, handleRgbPresets, handleRgbState,
  handleRunCommand, handleCodeCheckpoint, handleCodeRollback, handleRestartBackend,
  handleCodeTask, handleCodeTaskStatus, handleCodeTaskCancel,
} from './handlers/skillTools.js'
import {
  handlePcWindows, handlePcActiveWindow, handlePcReadUi, handlePcLaunch,
  handlePcFocus, handlePcProcesses, handlePcKill, handlePcType,
  handlePcKeys, handlePcClick, handlePcMouseMove,
} from './handlers/pcControl.js'
import { handleAppLaunch, handleRunTerminal } from './handlers/systemExec.js'
import { handleSystemPower, handleSystemVolume, handleSystemBluetooth, handleSystemProcess } from './handlers/systemControl.js'
import { handleClipboard, handleMedia, handleWindow, handleDnd } from './handlers/desktopControl.js'
import { handleStudySession, handleStudyCards, handleHabit, handleDayBrief, handleMorningBriefing, handleTaskDone } from './handlers/productivity.js'
import { handleSecurityStatus, handleSecurityUnlock } from './handlers/security.js'
import { handleAgentsList, handleAgentRpc, handleAgentsControl, handleAgentEvent, handleAgentWake } from './handlers/agents.js'
import { handleRemoteDesktop, handleDesktopPair } from './handlers/remoteDesktop.js'
import { handleProjectorStatus, handleProjectorOn, handleProjectorOff } from './handlers/projector.js'

export const routes = [
  { method: 'GET',  path: '/health',                   handler: handleHealth },
  { method: 'GET',  path: '/api/security/status',       handler: handleSecurityStatus },
  { method: 'POST', path: '/api/security/unlock',       handler: handleSecurityUnlock },
  { method: 'GET',  path: '/modules',                  handler: handleModules },
  { method: 'GET',  path: '/api/system/telemetry',     handler: handleTelemetry },
  { method: 'GET',  path: '/api/system/config',        handler: handleSystemConfig },
  { method: 'POST', path: '/api/jarvis/device-action', handler: handleDeviceAction },
  { method: 'POST', path: '/api/jarvis/turn',          handler: handleJarvisTurn },
  { method: 'POST', path: '/api/jarvis/wake',          handler: handleJarvisWake },
  { method: 'GET',  path: '/api/jarvis/wake-status',    handler: handleWakeStatus },
  { method: 'POST', path: '/api/jarvis/wake-detected',  handler: handleWakeDetected },
  { method: 'POST', path: '/api/jarvis/wake-calibrate', handler: handleWakeCalibrate },
  { method: 'POST', path: '/api/jarvis/ui-state',        handler: handleUiState },
  { method: 'POST', path: '/api/skills/gestures/toggle', handler: handleGestureToggle },
  { method: 'GET', path: '/api/skills/gestures/status', handler: handleGestureStatus },
  { method: 'POST', path: '/api/jarvis/tts',           handler: handleJarvisTts },
  { method: 'GET',  path: '/api/jarvis/filler',         handler: handleFillerWav },
  { method: 'POST', path: '/api/jarvis/stt',           handler: handleSttTranscribe },
  { method: 'POST', path: '/api/jarvis/process-speech', handler: handleProcessSpeech },
  { method: 'POST', path: '/api/jarvis/converse',       handler: handleConverse },
  { method: 'GET',  path: '/api/jarvis/stats',          handler: handleTurnStats },
  { method: 'GET',  path: '/api/jarvis/memory',         handler: handleMemoryList },
  { method: 'POST', path: '/api/jarvis/memory/forget',  handler: handleMemoryForget },
  { method: 'GET',  path: '/api/jarvis/proactive',      handler: handleProactiveStatus },
  { method: 'POST', path: '/api/jarvis/proactive/run',  handler: handleProactiveRun },
  { method: 'POST', path: '/api/jarvis/speculative',    handler: handleSpeculative },
  { method: 'GET',  path: '/api/speaker-id/samples',   handler: handleSpeakerIdList },
  { method: 'POST', path: '/api/speaker-id/samples',   handler: handleSpeakerIdUpload },
  { method: 'DELETE', path: '/api/speaker-id/samples',  handler: handleSpeakerIdDelete },
  { method: 'POST', path: '/api/speaker-id/reset',     handler: handleSpeakerIdReset },
  { method: 'POST', path: '/api/speaker-id/reload',    handler: handleSpeakerIdReload },
  { method: 'GET',  path: '/api/speaker-id/status',    handler: handleSpeakerIdStatus },
  { method: 'PUT',  path: '/api/speaker-id/threshold', handler: handleSpeakerIdThreshold },
  { method: 'GET',  path: '/api/speaker-id/speakers',  handler: handleSpeakersList },
  { method: 'POST', path: '/api/speaker-id/speakers',  handler: handleSpeakersCreate },
  { method: 'DELETE', path: '/api/speaker-id/speakers', handler: handleSpeakersDelete },
  { method: 'GET',    path: '/api/speaker-id/rejected', handler: handleRejectedList },
  { method: 'POST',   path: '/api/speaker-id/rejected/restore', handler: handleRejectedRestore },
  { method: 'DELETE', path: '/api/speaker-id/rejected', handler: handleRejectedDelete },
  { method: 'POST',   path: '/api/speaker-id/wake/reload', handler: handleWakeReload },
  { method: 'GET',  path: '/api/jarvis/agent/health',  handler: handleAgentHealth },
  { method: 'GET',  path: '/api/mobile/token',         handler: handleMobileToken },
  { method: 'POST', path: '/api/mobile/auth',          handler: handleMobileAuth },
  { method: 'GET',  path: '/api/mobile/status',        handler: handleMobileStatus },
  { method: 'POST', path: '/api/mobile/token/refresh', handler: handleMobileRefresh },
  { method: 'POST', path: '/api/mobile/qr-notify',     handler: handleMobileSendQr },

  // Mobile routine context — ingestion from iPhone (web foreground + Apple Shortcuts).
  { method: 'POST', path: '/api/mobile/ctx/location',  handler: handleCtxLocation },
  { method: 'POST', path: '/api/mobile/ctx/place',     handler: handleCtxPlace },
  { method: 'POST', path: '/api/mobile/ctx/battery',   handler: handleCtxBattery },
  { method: 'POST', path: '/api/mobile/ctx/focus',     handler: handleCtxFocus },
  { method: 'POST', path: '/api/mobile/ctx/sleep',     handler: handleCtxSleep },
  { method: 'POST', path: '/api/mobile/ctx/presence',  handler: handleCtxPresence },
  { method: 'GET',  path: '/api/mobile/ctx/current',   handler: handleCtxCurrent },
  { method: 'GET',  path: '/api/mobile/ctx/summary',   handler: handleCtxSummary },

  { method: 'GET',  path: '/api/obsidian/status',      handler: handleObsidianStatus },

  // "Compartir → Jarvis" desde el móvil. Escribe en Clippings/ y deja que
  // pdfWatcher haga la conversión a markdown (OCR incluido).
  { method: 'POST', path: '/api/vault/ingest',         handler: handleVaultIngest },

  // Skill tools — HTTP bridge for the MCP server. Each route maps to a
  // skillBus verb (renderer state) or a backend service (reminders/notify).
  { method: 'POST', path: '/api/skills/timer/start',    handler: handleTimerStart },
  { method: 'POST', path: '/api/skills/timer/pause',    handler: handleTimerPause },
  { method: 'POST', path: '/api/skills/timer/resume',   handler: handleTimerResume },
  { method: 'POST', path: '/api/skills/timer/add',      handler: handleTimerAdd },
  { method: 'POST', path: '/api/skills/timer/cancel',   handler: handleTimerCancel },
  { method: 'POST', path: '/api/skills/timer/reset',    handler: handleTimerReset },
  { method: 'GET',  path: '/api/skills/timer/list',     handler: handleTimerList },
  { method: 'POST', path: '/api/skills/chrono/start',   handler: handleChronoStart },
  { method: 'POST', path: '/api/skills/chrono/pause',   handler: handleChronoPause },
  { method: 'POST', path: '/api/skills/chrono/resume',  handler: handleChronoResume },
  { method: 'POST', path: '/api/skills/chrono/reset',   handler: handleChronoReset },
  { method: 'POST', path: '/api/skills/chrono/lap',     handler: handleChronoLap },
  { method: 'POST', path: '/api/skills/chrono/cancel',  handler: handleChronoCancel },
  { method: 'GET',  path: '/api/skills/chrono/list',    handler: handleChronoList },
  { method: 'POST', path: '/api/skills/reminder/create', handler: handleReminderCreate },
  { method: 'GET',  path: '/api/skills/reminder/list',  handler: handleReminderList },
  { method: 'POST', path: '/api/skills/notify/now',     handler: handleNotifyNow },
  { method: 'GET',  path: '/api/skills/time/now',       handler: handleTimeNow },
  { method: 'GET',  path: '/api/skills/mobile/where',   handler: handleMobileWhere },
  { method: 'GET',  path: '/api/skills/mobile/routine', handler: handleMobileRoutine },

  // Navigation skill tools — view/ring/overlay/system/voice/clap.
  { method: 'POST', path: '/api/skills/view/open',      handler: handleViewOpen },
  { method: 'POST', path: '/api/skills/view/close',     handler: handleViewClose },
  { method: 'GET',  path: '/api/skills/view/current',   handler: handleViewCurrent },
  { method: 'POST', path: '/api/skills/ring/rotate',    handler: handleRingRotate },
  { method: 'POST', path: '/api/skills/overlay/open',   handler: handleOverlayOpen },
  { method: 'POST', path: '/api/skills/overlay/close',  handler: handleOverlayClose },
  { method: 'POST', path: '/api/skills/system/sleep',   handler: handleSystemSleep },
  { method: 'POST', path: '/api/skills/system/wake',    handler: handleSystemWake },
  { method: 'POST', path: '/api/skills/system/launch',  handler: handleAppLaunch },
  { method: 'POST', path: '/api/skills/system/terminal', handler: handleRunTerminal },
  { method: 'POST', path: '/api/skills/system/power',     handler: handleSystemPower },
  { method: 'POST', path: '/api/skills/system/volume',    handler: handleSystemVolume },
  { method: 'POST', path: '/api/skills/system/bluetooth', handler: handleSystemBluetooth },
  { method: 'POST', path: '/api/skills/system/process',   handler: handleSystemProcess },
  { method: 'POST', path: '/api/skills/system/clipboard', handler: handleClipboard },
  { method: 'POST', path: '/api/skills/system/media',     handler: handleMedia },
  { method: 'POST', path: '/api/skills/system/window',    handler: handleWindow },
  { method: 'POST', path: '/api/skills/system/dnd',       handler: handleDnd },
  { method: 'POST', path: '/api/skills/study/session',    handler: handleStudySession },
  { method: 'POST', path: '/api/skills/study/cards',      handler: handleStudyCards },
  { method: 'POST', path: '/api/skills/habit',            handler: handleHabit },
  { method: 'GET',  path: '/api/skills/day/brief',        handler: handleDayBrief },
  { method: 'POST', path: '/api/skills/day/briefing',     handler: handleMorningBriefing },
  { method: 'POST', path: '/api/skills/obsidian/task/done', handler: handleTaskDone },
  { method: 'POST', path: '/api/skills/voice/toggle',   handler: handleVoiceToggle },
  { method: 'POST', path: '/api/skills/voice/ptt-start', handler: handlePttStart },
  { method: 'POST', path: '/api/skills/voice/ptt-stop',  handler: handlePttStop },
  { method: 'POST', path: '/api/skills/clap/toggle',    handler: handleClapToggle },

  // Obsidian skill tools
  { method: 'POST', path: '/api/skills/obsidian/task',        handler: handleObsidianTaskCreate },
  { method: 'POST', path: '/api/skills/obsidian/note',        handler: handleObsidianNoteCreate },
  { method: 'GET',  path: '/api/skills/obsidian/tasks',       handler: handleObsidianTaskList },
  { method: 'POST', path: '/api/skills/obsidian/search',      handler: handleObsidianNoteSearch },
  { method: 'POST', path: '/api/skills/obsidian/personalize', handler: handleObsidianPersonalize },

  // Grafo de conocimiento (bóveda + memoria SQLite + conversaciones) para el
  // modo `vault` del visor 3D. `graph` solo lee; `focus` mueve la cámara del
  // renderer, así que pasa por el skill bus (y por eso vive en skillTools.js).
  { method: 'GET',  path: '/api/skills/vault/graph',          handler: handleVaultGraph },
  { method: 'POST', path: '/api/skills/vault/focus',          handler: handleVaultFocus },

  // Display / picker skill tools
  { method: 'POST', path: '/api/skills/display/show',  handler: handleDisplayShow },
  { method: 'POST', path: '/api/skills/display/hide',  handler: handleDisplayHide },
  { method: 'POST', path: '/api/skills/speech/say',    handler: handleSpeechSay },
  { method: 'POST', path: '/api/skills/vision/screen',  handler: handleVisionScreen },
  { method: 'POST', path: '/api/skills/vision/camera',  handler: handleVisionCamera },
  { method: 'POST', path: '/api/skills/file/pick',     handler: handlePickFile },

  // 3D model viewer skill tools
  { method: 'POST', path: '/api/skills/model3d/show',  handler: handleModel3dShow },
  { method: 'POST', path: '/api/skills/model3d/add',   handler: handleModel3dAdd },
  { method: 'POST', path: '/api/skills/model3d/hide',  handler: handleModel3dHide },
  { method: 'POST', path: '/api/skills/model3d/sim',   handler: handleModel3dSim },


  // Cloud skill tools
  { method: 'POST', path: '/api/skills/cloud/save',           handler: handleCloudSave },
  { method: 'GET',  path: '/api/skills/cloud/list',           handler: handleCloudList },

  // RGB skill tools — exec de rgb_ctl.py en el PC remoto vía hub de agentes.
  { method: 'POST', path: '/api/skills/rgb/set',              handler: handleRgbSet },
  { method: 'POST', path: '/api/skills/rgb/preset',           handler: handleRgbPreset },
  { method: 'GET',  path: '/api/skills/rgb/presets',          handler: handleRgbPresets },
  { method: 'GET',  path: '/api/skills/rgb/state',            handler: handleRgbState },

  // Escritorio remoto — enlace a pc-remote y a Sunshine/Moonlight, que corren
  // fuera de Jarvis. Solo lectura: devuelve URL y estado, no controla nada.
  { method: 'GET',  path: '/api/skills/desktop/remote',        handler: handleRemoteDesktop },
  // Emparejar Moonlight: la app manda el PIN y el backend lo teclea en la UI
  // web de Sunshine de la maquina que emite (host validado contra la lista).
  { method: 'POST', path: '/api/skills/desktop/pair',          handler: handleDesktopPair },

  // Proyector como PANTALLA: enciende (comando externo), espera el arranque y
  // deja Moonlight proyectando el escritorio de este portatil. No es local-only
  // a proposito — controlar una lampara desde la tablet no abre ninguna puerta.
  { method: 'GET',  path: '/api/skills/projector/status',      handler: handleProjectorStatus },
  { method: 'POST', path: '/api/skills/projector/on',          handler: handleProjectorOn },
  { method: 'POST', path: '/api/skills/projector/off',         handler: handleProjectorOff },

  // Self-code skill tools (autodesarrollo: run/checkpoint/rollback/restart)
  { method: 'POST', path: '/api/skills/code/run',             handler: handleRunCommand },
  { method: 'POST', path: '/api/skills/code/checkpoint',      handler: handleCodeCheckpoint },
  { method: 'POST', path: '/api/skills/code/rollback',        handler: handleCodeRollback },
  { method: 'POST', path: '/api/skills/code/restart',         handler: handleRestartBackend },
  { method: 'POST', path: '/api/skills/code/task',            handler: handleCodeTask },
  { method: 'POST', path: '/api/skills/code/task/status',     handler: handleCodeTaskStatus },
  { method: 'POST', path: '/api/skills/code/task/cancel',     handler: handleCodeTaskCancel },

  // Distributed agents — bridge to the Rust hub sidecar (control API :8795).
  // remote_* MCP tools call these; the hub pushes proactive events to /event.
  { method: 'GET',  path: '/api/agents/list',   handler: handleAgentsList },
  { method: 'POST', path: '/api/agents/rpc',    handler: handleAgentRpc },
  // Remote-safe subset (phone app): read-only ops + wake, token-gated.
  { method: 'POST', path: '/api/agents/control', handler: handleAgentsControl },
  { method: 'POST', path: '/api/agents/wake',   handler: handleAgentWake },
  { method: 'POST', path: '/api/agents/event',  handler: handleAgentEvent },

  // PC control — bridge to pc_control_service.py sidecar (port 8792)
  { method: 'GET',  path: '/api/pc/windows',       handler: handlePcWindows },
  { method: 'GET',  path: '/api/pc/active_window',  handler: handlePcActiveWindow },
  { method: 'POST', path: '/api/pc/read_ui',        handler: handlePcReadUi },
  { method: 'POST', path: '/api/pc/launch',         handler: handlePcLaunch },
  { method: 'POST', path: '/api/pc/focus',          handler: handlePcFocus },
  { method: 'GET',  path: '/api/pc/processes',      handler: handlePcProcesses },
  { method: 'POST', path: '/api/pc/kill',           handler: handlePcKill },
  { method: 'POST', path: '/api/pc/type',           handler: handlePcType },
  { method: 'POST', path: '/api/pc/keys',           handler: handlePcKeys },
  { method: 'POST', path: '/api/pc/click',          handler: handlePcClick },
  { method: 'POST', path: '/api/pc/mouse_move',     handler: handlePcMouseMove },
]

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function loadDynamicRoutes() {
  const dynamicDir = join(__dirname, 'handlers/dynamic')
  if (!existsSync(dynamicDir)) return
  const files = readdirSync(dynamicDir).filter(f => f.endsWith('.js'))
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(dynamicDir, file)).href)
      if (mod.route) routes.push(mod.route)
    } catch (e) {
      console.warn(`[skills] failed to load ${file}:`, e.message)
    }
  }
}

export async function dispatch(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true })
  }

  // Token gate: local clients bypass, remote (Tailscale/LAN) need a token.
  const auth = authorize(req)
  if (!auth.ok) {
    return json(res, auth.code, { ok: false, error: auth.error })
  }

  // Risk gate: WHO is asking. webAuth above answered WHERE the request came
  // from; this answers whether the speaker the model is acting for is allowed to
  // run something this dangerous. Only tagged model tool calls are affected —
  // GUI and companion traffic passes through untouched.
  const risk = checkToolRisk(req)
  if (!risk.allowed) {
    const tool = req.headers['x-jarvis-tool'] || '-'
    console.warn(`[risk] BLOCKED ${tool} (${risk.risk}) for mode=${risk.mode}: ${risk.reason}`)
    return json(res, 403, {
      ok: false,
      error: 'risk_denied',
      reason: risk.reason,
      risk: risk.risk,
      detail: risk.spoken,
    })
  }

  const pathname = req.url.split('?')[0]
  const match = routes.find((r) => r.method === req.method && r.path === pathname)
  if (!match) {
    return json(res, 404, { ok: false, error: 'not_found' })
  }

  return match.handler(req, res)
}
