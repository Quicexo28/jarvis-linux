import { json } from './lib/http.js'
import { existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { handleHealth } from './handlers/health.js'
import { handleModules } from './handlers/modules.js'
import { handleDeviceAction, handleJarvisTurn, handleJarvisWake, handleJarvisTts, handleFillerWav, handleAgentHealth } from './handlers/jarvis.js'
import { handleTelemetry } from './handlers/telemetry.js'
import { handleSttTranscribe } from './handlers/stt.js'
import { handleProcessSpeech, handleConverse } from './handlers/speech.js'
import {
  handleSpeakerIdList,
  handleSpeakerIdUpload,
  handleSpeakerIdDelete,
  handleSpeakerIdReload,
  handleSpeakerIdStatus,
  handleSpeakerIdThreshold,
  handleSpeakersList,
  handleSpeakersCreate,
  handleSpeakersDelete,
} from './handlers/speakerId.js'
import {
  handleMobileToken,
  handleMobileAuth,
  handleMobileStatus,
  handleMobileRefresh,
  handleMobileSendQr,
} from './handlers/mobile.js'
import { handleObsidianStatus } from './handlers/obsidian.js'
import { handleSystemConfig } from './handlers/config.js'
import { handleWakeDetected, handleWakeCalibrate, handleWakeStatus } from './handlers/wakeWord.js'
import { handleUiState, handleGestureToggle } from './handlers/uiState.js'
import {
  handleTimerStart, handleTimerPause, handleTimerResume, handleTimerAdd,
  handleTimerCancel, handleTimerReset, handleTimerList,
  handleChronoStart, handleChronoPause, handleChronoResume, handleChronoReset,
  handleChronoLap, handleChronoCancel, handleChronoList,
  handleReminderCreate, handleReminderList, handleNotifyNow, handleTimeNow,
  handleViewOpen, handleViewClose, handleViewCurrent, handleRingRotate,
  handleOverlayOpen, handleOverlayClose, handleSystemSleep,
  handleVoiceToggle, handleClapToggle,
  handleObsidianTaskCreate, handleObsidianNoteCreate, handleObsidianTaskList,
  handleObsidianNoteSearch, handleObsidianPersonalize,
  handleDisplayShow, handleDisplayHide, handlePickFile,
  handleModel3dShow, handleModel3dAdd, handleModel3dHide,
  handleCloudSave, handleCloudList,
  handleRunCommand, handleCodeCheckpoint, handleCodeRollback, handleRestartBackend,
} from './handlers/skillTools.js'
import {
  handlePcWindows, handlePcActiveWindow, handlePcReadUi, handlePcLaunch,
  handlePcFocus, handlePcProcesses, handlePcKill, handlePcType,
  handlePcKeys, handlePcClick, handlePcMouseMove,
} from './handlers/pcControl.js'
import { handleSecurityStatus, handleSecurityUnlock } from './handlers/security.js'

export const routes = [
  { method: 'GET',  path: '/health',                   handler: handleHealth },
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
  { method: 'POST', path: '/api/jarvis/tts',           handler: handleJarvisTts },
  { method: 'GET',  path: '/api/jarvis/filler',         handler: handleFillerWav },
  { method: 'POST', path: '/api/jarvis/stt',           handler: handleSttTranscribe },
  { method: 'POST', path: '/api/jarvis/process-speech', handler: handleProcessSpeech },
  { method: 'POST', path: '/api/jarvis/converse',       handler: handleConverse },
  { method: 'GET',  path: '/api/speaker-id/samples',   handler: handleSpeakerIdList },
  { method: 'POST', path: '/api/speaker-id/samples',   handler: handleSpeakerIdUpload },
  { method: 'DELETE', path: '/api/speaker-id/samples',  handler: handleSpeakerIdDelete },
  { method: 'POST', path: '/api/speaker-id/reload',    handler: handleSpeakerIdReload },
  { method: 'GET',  path: '/api/speaker-id/status',    handler: handleSpeakerIdStatus },
  { method: 'PUT',  path: '/api/speaker-id/threshold', handler: handleSpeakerIdThreshold },
  { method: 'GET',  path: '/api/speaker-id/speakers',  handler: handleSpeakersList },
  { method: 'POST', path: '/api/speaker-id/speakers',  handler: handleSpeakersCreate },
  { method: 'DELETE', path: '/api/speaker-id/speakers', handler: handleSpeakersDelete },
  { method: 'GET',  path: '/api/jarvis/agent/health',  handler: handleAgentHealth },
  { method: 'GET',  path: '/api/mobile/token',         handler: handleMobileToken },
  { method: 'POST', path: '/api/mobile/auth',          handler: handleMobileAuth },
  { method: 'GET',  path: '/api/mobile/status',        handler: handleMobileStatus },
  { method: 'POST', path: '/api/mobile/token/refresh', handler: handleMobileRefresh },
  { method: 'POST', path: '/api/mobile/qr-notify',     handler: handleMobileSendQr },
  { method: 'GET',  path: '/api/obsidian/status',      handler: handleObsidianStatus },

  // Security / portable-vault unlock (encrypted secrets + owner voiceprint).
  { method: 'GET',  path: '/api/security/status',       handler: handleSecurityStatus },
  { method: 'POST', path: '/api/security/unlock',       handler: handleSecurityUnlock },

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

  // Navigation skill tools — view/ring/overlay/system/voice/clap.
  { method: 'POST', path: '/api/skills/view/open',      handler: handleViewOpen },
  { method: 'POST', path: '/api/skills/view/close',     handler: handleViewClose },
  { method: 'GET',  path: '/api/skills/view/current',   handler: handleViewCurrent },
  { method: 'POST', path: '/api/skills/ring/rotate',    handler: handleRingRotate },
  { method: 'POST', path: '/api/skills/overlay/open',   handler: handleOverlayOpen },
  { method: 'POST', path: '/api/skills/overlay/close',  handler: handleOverlayClose },
  { method: 'POST', path: '/api/skills/system/sleep',   handler: handleSystemSleep },
  { method: 'POST', path: '/api/skills/voice/toggle',   handler: handleVoiceToggle },
  { method: 'POST', path: '/api/skills/clap/toggle',    handler: handleClapToggle },

  // Obsidian skill tools
  { method: 'POST', path: '/api/skills/obsidian/task',        handler: handleObsidianTaskCreate },
  { method: 'POST', path: '/api/skills/obsidian/note',        handler: handleObsidianNoteCreate },
  { method: 'GET',  path: '/api/skills/obsidian/tasks',       handler: handleObsidianTaskList },
  { method: 'POST', path: '/api/skills/obsidian/search',      handler: handleObsidianNoteSearch },
  { method: 'POST', path: '/api/skills/obsidian/personalize', handler: handleObsidianPersonalize },

  // Display / picker skill tools
  { method: 'POST', path: '/api/skills/display/show',  handler: handleDisplayShow },
  { method: 'POST', path: '/api/skills/display/hide',  handler: handleDisplayHide },
  { method: 'POST', path: '/api/skills/file/pick',     handler: handlePickFile },

  // 3D model viewer skill tools
  { method: 'POST', path: '/api/skills/model3d/show',  handler: handleModel3dShow },
  { method: 'POST', path: '/api/skills/model3d/add',   handler: handleModel3dAdd },
  { method: 'POST', path: '/api/skills/model3d/hide',  handler: handleModel3dHide },

  // Cloud skill tools
  { method: 'POST', path: '/api/skills/cloud/save',           handler: handleCloudSave },
  { method: 'GET',  path: '/api/skills/cloud/list',           handler: handleCloudList },

  // Self-code skill tools (autodesarrollo: run/checkpoint/rollback/restart).
  // OWNER-only + code-password gated inside the handlers.
  { method: 'POST', path: '/api/skills/code/run',        handler: handleRunCommand },
  { method: 'POST', path: '/api/skills/code/checkpoint', handler: handleCodeCheckpoint },
  { method: 'POST', path: '/api/skills/code/rollback',   handler: handleCodeRollback },
  { method: 'POST', path: '/api/skills/code/restart',    handler: handleRestartBackend },

  // PC control proxy (Linux: ydotool/xdotool + window manager via port 8792).
  { method: 'GET',  path: '/api/pc/windows',        handler: handlePcWindows },
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

  const pathname = req.url.split('?')[0]
  const match = routes.find((r) => r.method === req.method && r.path === pathname)
  if (!match) {
    return json(res, 404, { ok: false, error: 'not_found' })
  }

  return match.handler(req, res)
}
