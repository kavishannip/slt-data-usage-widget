const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onData: (callback) => ipcRenderer.on('usage-data', (_event, data) => callback(data)),
  onAuthExpired: (callback) => ipcRenderer.on('auth-expired', () => callback()),
  requestRefresh: () => ipcRenderer.send('request-refresh'),
  openTokenEntry: () => ipcRenderer.send('open-token-entry'),
  saveToken: (subscriberID, token) => ipcRenderer.send('save-token', { subscriberID, token })
});
