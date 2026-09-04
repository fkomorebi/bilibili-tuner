const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', {
  chooseAudio: () => ipcRenderer.invoke('audio:choose'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  checkEngine: () => ipcRenderer.invoke('engine:check'),
  startJob: options => ipcRenderer.invoke('job:start', options),
  cancelJob: jobId => ipcRenderer.invoke('job:cancel', jobId),
  openPath: targetPath => ipcRenderer.invoke('path:open', targetPath),
  onJobEvent: handler => ipcRenderer.on('job:event', (_event, payload) => handler(payload)),
  onJobFinished: handler => ipcRenderer.on('job:finished', (_event, payload) => handler(payload))
});
