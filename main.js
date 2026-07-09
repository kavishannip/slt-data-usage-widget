const { app, BrowserWindow, ipcMain, screen, Notification, Tray, Menu, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');

const store = new Store();

let mainWindow;
let tokenWindow;
let tray = null;
let config;
let authExpired = false;
let refreshInterval;

// Alert state memory
let alertState = {
  standard: { notifiedWarn: false, notifiedCritical: false, lastTotal: 0 },
  bonus: { notifiedWarn: false, notifiedCritical: false, lastTotal: 0 },
  vas: { notifiedWarn: false, notifiedCritical: false, lastTotal: 0 }
};

const sltAutoLauncher = new AutoLaunch({
  name: 'SLT Usage Widget',
  path: app.getPath('exe'),
});

function loadConfig() {
  config = {
    subscriberID: store.get('subscriberID', ''),
    headers: store.get('headers', { Authorization: '', 'X-IBM-Client-Id': 'b7402e9d66808f762ccedbe42c20668e' }),
    refreshMinutes: store.get('refreshMinutes', 5),
    warnThresholdPercent: store.get('warnThresholdPercent', 20),
    criticalThresholdPercent: store.get('criticalThresholdPercent', 10),
    autoLaunch: store.get('autoLaunch', true)
  };
}

function updateAutoLaunch() {
  if (config.autoLaunch) {
    sltAutoLauncher.enable().catch(() => {});
  } else {
    sltAutoLauncher.disable().catch(() => {});
  }
}

function checkAlerts(category, usageData) {
  if (!usageData || usageData.total === 0) return;
  
  const { used, total } = usageData;
  const remaining = total - used;
  const percent = (remaining / total) * 100;
  
  let state = alertState[category];
  
  // Reset if total limits changed (new cycle)
  if (total !== state.lastTotal) {
    state.notifiedWarn = false;
    state.notifiedCritical = false;
    state.lastTotal = total;
  }

  const catName = category.charAt(0).toUpperCase() + category.slice(1);

  if (percent <= config.criticalThresholdPercent && !state.notifiedCritical) {
    new Notification({
      title: 'SLT Usage Critical',
      body: `${catName} data is below ${config.criticalThresholdPercent}%. Only ${remaining.toFixed(1)}GB left.`,
      urgency: 'critical'
    }).show();
    state.notifiedCritical = true;
    state.notifiedWarn = true; // Avoid sending warning if we jump straight to critical
  } else if (percent <= config.warnThresholdPercent && !state.notifiedWarn) {
    new Notification({
      title: 'SLT Usage Warning',
      body: `${catName} data is below ${config.warnThresholdPercent}%. ${remaining.toFixed(1)}GB remaining.`,
      urgency: 'normal'
    }).show();
    state.notifiedWarn = true;
  }
}

async function fetchUsage() {
  if (!config.subscriberID || !config.headers.Authorization) {
    authExpired = true;
    if (mainWindow) mainWindow.webContents.send('auth-expired');
    return;
  }
  
  try {
    const url = `https://omniscapp.slt.lk/slt/ext/api/BBVAS/UsageSummary?subscriberID=${config.subscriberID}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: config.headers
    });

    if (response.status === 401) {
      authExpired = true;
      if (mainWindow) mainWindow.webContents.send('auth-expired');
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    authExpired = false;
    
    if (data && data.dataBundle) {
      const bundle = data.dataBundle;
      const parseUsage = (summary) => summary ? { used: parseFloat(summary.used), total: parseFloat(summary.limit) } : null;

      checkAlerts('standard', parseUsage(bundle.my_package_summary));
      checkAlerts('bonus', parseUsage(bundle.bonus_data_summary));
      checkAlerts('vas', parseUsage(bundle.vas_data_summary));
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('usage-data', data);
    }
  } catch (error) {
    console.error('Fetch error:', error);
  }
}

function startPolling() {
  if (refreshInterval) clearInterval(refreshInterval);
  const ms = (config.refreshMinutes || 5) * 60 * 1000;
  refreshInterval = setInterval(fetchUsage, ms);
  fetchUsage(); // Initial fetch
}

function createTray() {
  const { nativeImage } = require('electron');
  const icon = nativeImage.createEmpty();
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show/Hide Widget', click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      }
    },
    { label: 'Refresh Now', click: () => fetchUsage() },
    { label: 'Re-enter Token', click: () => openTokenWindow() },
    { label: 'Open MySLT', click: () => shell.openExternal('https://myslt.slt.lk') },
    { type: 'separator' },
    { label: 'Launch on Startup', type: 'checkbox', checked: config.autoLaunch, click: (item) => {
        store.set('autoLaunch', item.checked);
        config.autoLaunch = item.checked;
        updateAutoLaunch();
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('SLT Usage Widget');
  tray.setContextMenu(contextMenu);
  
  try {
    const realIcon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
    if (!realIcon.isEmpty()) {
      tray.setImage(realIcon);
    }
  } catch (e) {}
}

function createWindow() {
  loadConfig();
  updateAutoLaunch();

  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = 320;
  const windowHeight = 420;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: screenWidth - windowWidth - 30,
    y: 30,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.loadFile('index.html');
  
  startPolling();
}

function openTokenWindow() {
  if (tokenWindow) {
    tokenWindow.focus();
    return;
  }
  
  tokenWindow = new BrowserWindow({
    width: 450,
    height: 520,
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    title: "SLT Auth",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  tokenWindow.loadFile('token.html');
  
  tokenWindow.on('closed', () => {
    tokenWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Don't quit, keep tray alive
});

ipcMain.on('request-refresh', () => {
  fetchUsage();
});

ipcMain.on('open-token-entry', () => {
  openTokenWindow();
});

ipcMain.on('save-token', (event, { subscriberID, token }) => {
  store.set('subscriberID', subscriberID);
  
  const headers = store.get('headers', { 'X-IBM-Client-Id': 'b7402e9d66808f762ccedbe42c20668e' });
  headers.Authorization = token;
  store.set('headers', headers);
  
  loadConfig();
  
  if (tokenWindow) tokenWindow.close();
  
  fetchUsage();
});
