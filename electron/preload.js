const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronBridge', {
  platform: process.platform,
  setBootState: (state) => ipcRenderer.invoke('boot:setState', state),
  onBootState: (cb) => {
    ipcRenderer.on('boot:state', (_, s) => cb(s))
    return () => ipcRenderer.removeAllListeners('boot:state')
  },
  openVault: (vaultPath) => ipcRenderer.invoke('vault:open', vaultPath),
  onProcLog: (cb) => {
    ipcRenderer.on('proc:log', (_, d) => cb(d))
    return () => ipcRenderer.removeAllListeners('proc:log')
  },
  onClaudeStream: (cb) => {
    ipcRenderer.on('proc:claudeStream', (_, d) => cb(d))
    return () => ipcRenderer.removeAllListeners('proc:claudeStream')
  },
  getServices: () => ipcRenderer.invoke('proc:getServices'),
  execClaude: (prompt) => ipcRenderer.invoke('proc:claudeExec', { prompt }),
  moveMouse: (x, y) => ipcRenderer.invoke('mouse:move', { x, y }),
  clickMouse: (x, y) => ipcRenderer.invoke('mouse:click', { x, y }),
  // Native OS file/folder picker — returns { canceled, paths }.
  pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts),
  // Reveal a path in the OS file explorer.
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
})
