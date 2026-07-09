const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onData: (callback) => ipcRenderer.on('usage-data', (_event, data) => callback(data)),
  onAuthExpired: (callback) => ipcRenderer.on('auth-expired', () => callback()),
  requestRefresh: () => ipcRenderer.send('request-refresh'),
  openTokenEntry: () => ipcRenderer.send('open-token-entry'),
  saveToken: (subscriberID, token) => ipcRenderer.send('save-token', { subscriberID, token }),
  logout: () => ipcRenderer.send('logout'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateSetting: (key, value) => ipcRenderer.send('update-setting', { key, value }),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
  onSettingUpdated: (callback) => ipcRenderer.on('setting-updated', (_event, data) => callback(data)),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
