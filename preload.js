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
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onNetworkStats: (callback) => ipcRenderer.on('network-stats', (_event, data) => callback(data)),
  closeApp: () => ipcRenderer.send('close-app'),
  showNotification: (options) => ipcRenderer.send('show-notification', options),
  onFetchError: (callback) => ipcRenderer.on('fetch-error', (_event, data) => callback(data)),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  downloadUpdate: () => ipcRenderer.send('download-and-install-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_event, info) => callback(info)),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', (_event, info) => callback(info)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_event, info) => callback(info)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_event, err) => callback(err)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, prog) => callback(prog))
});
