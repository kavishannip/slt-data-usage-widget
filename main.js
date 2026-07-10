const { app, BrowserWindow, ipcMain, screen, Notification, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');

const store = new Store();
const si = require('systeminformation');

// ─── Debug Logger ───────────────────────────────────────────────
const DEBUG = false; // Set to false for production builds
let logFilePath = null;

function initLogger() {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'debug.log');
    // Rotate: truncate if > 2MB
    try {
      const stat = fs.statSync(logFilePath);
      if (stat.size > 2 * 1024 * 1024) fs.writeFileSync(logFilePath, '');
    } catch (_) {}
    debugLog('=== SLTDU Widget started ===');
    debugLog(`Platform: ${os.platform()} ${os.release()} | Arch: ${os.arch()}`);
    debugLog(`App version: 1.1.1 | Electron: ${process.versions.electron}`);
    debugLog(`Log file: ${logFilePath}`);
  } catch (e) {
    console.error('Failed to init logger:', e);
  }
}

function debugLog(...args) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : a)).join(' ')}`;
  console.log(msg);
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, msg + '\n'); } catch (_) {}
  }
}

let mainWindow;
let tokenWindow;
let settingsWindow = null;
let tray = null;
let config;
let authExpired = false;
let refreshInterval;
let isRefreshing = false;

function attemptHiddenRefresh() {
  if (isRefreshing) return;
  isRefreshing = true;

  const { session } = require('electron');
  const hiddenWin = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const filter = { urls: ['*://omniscapp.slt.lk/*'] };
  let success = false;
  
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (details.requestHeaders['Authorization']) {
      const auth = details.requestHeaders['Authorization'];
      const headers = store.get('headers', { 'X-IBM-Client-Id': 'b7402e9d66808f762ccedbe42c20668e' });
      headers.Authorization = auth;
      store.set('headers', headers);
      
      loadConfig();
      success = true;
      
      session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
      if (!hiddenWin.isDestroyed()) hiddenWin.close();
      isRefreshing = false;
      fetchUsage();
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  hiddenWin.loadURL('https://myslt.slt.lk/');
  
  setTimeout(() => {
    if (!success) {
      session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
      if (!hiddenWin.isDestroyed()) hiddenWin.close();
      isRefreshing = false;
    }
  }, 15000);
}

// Alert state memory
let alertState = {};

const sltAutoLauncher = new AutoLaunch({
  name: 'SLTDU Widget',
  path: app.getPath('exe'),
});

function loadConfig() {
  config = {
    subscriberID: store.get('subscriberID', ''),
    headers: store.get('headers', { Authorization: '', 'X-IBM-Client-Id': 'b7402e9d66808f762ccedbe42c20668e' }),
    refreshMinutes: store.get('refreshMinutes', 1),
    warnThresholdPercent: store.get('warnThresholdPercent', 20),
    criticalThresholdPercent: store.get('criticalThresholdPercent', 10),
    autoLaunch: store.get('autoLaunch', true),
    notifyOnLowData: store.get('notifyOnLowData', true),
    lowDataThresholdPercent: store.get('lowDataThresholdPercent', 20),
    dailyResetTime: store.get('dailyResetTime', '00:00'),
    dailyRxBytes: store.get('dailyRxBytes', 0),
    dailyTxBytes: store.get('dailyTxBytes', 0),
    lastResetTime: store.get('lastResetTime', Date.now())
  };
}

function updateAutoLaunch() {
  if (config.autoLaunch) {
    sltAutoLauncher.enable().catch((e) => { debugLog('AutoLaunch enable error:', e.message); });
  } else {
    sltAutoLauncher.disable().catch((e) => { debugLog('AutoLaunch disable error:', e.message); });
  }
}

let networkInterval;
let cumulativeRx = 0;
let cumulativeTx = 0;
let prevRxBytes = null;
let prevTxBytes = null;

// Known virtual adapter keywords to exclude
const VIRTUAL_ADAPTER_PATTERNS = [
  'hyper-v', 'virtualbox', 'vmware', 'vmnet', 'docker',
  'vethernet', 'veth', 'wsl', 'loopback', 'bluetooth',
  'pan network', 'vpn', 'tunnel', 'teredo', 'isatap',
  'pseudo', 'microsoft wi-fi direct'
];

function isVirtualAdapter(iface) {
  const name = ((iface.iface || '') + ' ' + (iface.ifaceName || '')).toLowerCase();
  const type = (iface.type || '').toLowerCase();
  if (iface.virtual) return true;
  if (type === 'virtual') return true;
  return VIRTUAL_ADAPTER_PATTERNS.some(p => name.includes(p));
}

function findBestInterface(ifaces) {
  // Filter to physical, non-internal, non-virtual adapters
  const physical = ifaces.filter(i => !i.internal && !isVirtualAdapter(i));

  // Priority 1: operstate 'up' AND has an IPv4 address (best case)
  const upWithIp = physical.find(i => i.operstate === 'up' && i.ip4 && i.ip4 !== '');
  if (upWithIp) return upWithIp;

  // Priority 2: has IPv4 address regardless of operstate (handles WiFi 'unknown' quirk)
  const withIp = physical.find(i => i.ip4 && i.ip4 !== '' && i.ip4 !== '0.0.0.0');
  if (withIp) return withIp;

  // Priority 3: operstate 'up' even without ip4 (interface is active but maybe DHCP pending)
  const up = physical.find(i => i.operstate === 'up');
  if (up) return up;

  // Priority 4: any physical non-internal adapter at all
  if (physical.length > 0) return physical[0];

  return null;
}

async function dumpInterfacesOnce() {
  try {
    const ifaces = await si.networkInterfaces();
    debugLog('=== Network Interfaces Dump ===');
    ifaces.forEach((iface, idx) => {
      debugLog(`  [${idx}] iface=${iface.iface} ifaceName=${iface.ifaceName || 'N/A'} ` +
        `internal=${iface.internal} virtual=${iface.virtual || false} ` +
        `type=${iface.type || 'N/A'} operstate=${iface.operstate} ` +
        `ip4=${iface.ip4 || 'none'} mac=${iface.mac || 'N/A'} ` +
        `isVirtual=${isVirtualAdapter(iface)}`);
    });
    const best = findBestInterface(ifaces);
    debugLog(`  → Selected interface: ${best ? best.iface : 'NONE (will use *)'} ` +
      `(operstate=${best ? best.operstate : 'N/A'})`);
    debugLog('=== End Interfaces Dump ===');
  } catch (e) {
    debugLog('Interface dump error:', e.message);
  }
}

function startNetworkPolling() {
  if (networkInterval) clearInterval(networkInterval);
  let lastIface = null;
  let pollCount = 0;

  let dailyRx = config.dailyRxBytes || 0;
  let dailyTx = config.dailyTxBytes || 0;
  let lastReset = config.lastResetTime || Date.now();

  function checkDailyReset() {
    const now = new Date();
    const resetTimeStr = config.dailyResetTime || '00:00';
    const [resetHour, resetMinute] = resetTimeStr.split(':').map(Number);
    
    // Find the most recent reset boundary
    const lastBoundary = new Date(now);
    lastBoundary.setHours(resetHour, resetMinute, 0, 0);
    
    if (now < lastBoundary) {
      lastBoundary.setDate(lastBoundary.getDate() - 1);
    }
    
    if (lastBoundary.getTime() > lastReset) {
      dailyRx = 0;
      dailyTx = 0;
      lastReset = now.getTime();
      store.set('dailyRxBytes', 0);
      store.set('dailyTxBytes', 0);
      store.set('lastResetTime', lastReset);
      debugLog('[Network] Daily counter reset applied.');
    }
  }

  networkInterval = setInterval(async () => {
    try {
      const ifaces = await si.networkInterfaces();
      const best = findBestInterface(ifaces);
      const currentIface = best ? best.iface : null;

      // Log interface changes and periodic status
      if (currentIface !== lastIface) {
        debugLog(`[Network] Interface changed: ${lastIface} → ${currentIface}` +
          (best ? ` (operstate=${best.operstate}, ip4=${best.ip4})` : ' (no suitable interface)'));
        // Reset byte tracking on interface change to avoid wrong deltas
        prevRxBytes = null;
        prevTxBytes = null;
        lastIface = currentIface;
      }

      // Log every 60 seconds for debugging
      pollCount++;
      if (pollCount % 60 === 0) {
        debugLog(`[Network] Poll #${pollCount}: iface=${currentIface}, ` +
          `cumulativeRx=${(cumulativeRx / (1024*1024)).toFixed(2)}MB, ` +
          `cumulativeTx=${(cumulativeTx / (1024*1024)).toFixed(2)}MB`);
      }

      if (!currentIface) {
        // No physical interface found — send zeros so the UI stays alive
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('network-stats', {
            download: 0, upload: 0,
            total_rx: cumulativeRx, total_tx: cumulativeTx,
            daily_rx: dailyRx, daily_tx: dailyTx
          });
        }
        return;
      }

      const stats = await si.networkStats(currentIface);
      if (stats && stats.length > 0) {
        const stat = stats[0];
        const rxBytes = stat.rx_bytes || 0;
        const txBytes = stat.tx_bytes || 0;

        let deltaRx = 0;
        let deltaTx = 0;

        if (prevRxBytes !== null) {
          // Accumulate deltas; handle OS counter resets gracefully
          deltaRx = rxBytes >= prevRxBytes ? rxBytes - prevRxBytes : rxBytes;
          deltaTx = txBytes >= prevTxBytes ? txBytes - prevTxBytes : txBytes;
          // Sanity: ignore unreasonably large deltas (> 100MB in 1s = likely counter reset)
          if (deltaRx < 100 * 1024 * 1024) {
            cumulativeRx += deltaRx;
            dailyRx += deltaRx;
          }
          if (deltaTx < 100 * 1024 * 1024) {
            cumulativeTx += deltaTx;
            dailyTx += deltaTx;
          }
        }
        prevRxBytes = rxBytes;
        prevTxBytes = txBytes;

        checkDailyReset();

        // Save daily usage to store every 10 polls (~10 seconds)
        if (pollCount % 10 === 0) {
          store.set('dailyRxBytes', dailyRx);
          store.set('dailyTxBytes', dailyTx);
          store.set('lastResetTime', lastReset);
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('network-stats', {
            download: Math.max(0, stat.rx_sec || 0),
            upload: Math.max(0, stat.tx_sec || 0),
            total_rx: cumulativeRx,
            total_tx: cumulativeTx,
            daily_rx: dailyRx,
            daily_tx: dailyTx
          });
        }
      } else {
        debugLog(`[Network] si.networkStats('${currentIface}') returned empty`);
      }
    } catch (e) {
      debugLog('[Network] Polling error:', e.message);
    }
  }, 1000);
}

function checkAlerts(category, usageData) {
  if (!usageData || usageData.total === 0 || !config.notifyOnLowData) return;
  
  const { remaining, total, percent } = usageData;
  
  if (!alertState[category]) {
    alertState[category] = { notifiedWarn: false, notifiedCritical: false, lastTotal: 0 };
  }
  let state = alertState[category];
  
  // Reset if total limits changed (new cycle)
  if (total !== state.lastTotal) {
    state.notifiedWarn = false;
    state.notifiedCritical = false;
    state.lastTotal = total;
  }

  if (percent <= config.criticalThresholdPercent && !state.notifiedCritical) {
    new Notification({
      title: 'SLTDU — Usage Critical',
      body: `${category} data is below ${config.criticalThresholdPercent}%. Only ${remaining.toFixed(1)}GB left.`,
      urgency: 'critical'
    }).show();
    state.notifiedCritical = true;
    state.notifiedWarn = true; // Avoid sending warning if we jump straight to critical
  } else if (percent <= config.lowDataThresholdPercent && !state.notifiedWarn) {
    new Notification({
      title: 'SLTDU — Usage Warning',
      body: `${category} data is below ${config.lowDataThresholdPercent}%. ${remaining.toFixed(1)}GB remaining.`,
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
    const url = `https://omniscapp.slt.lk/slt/ext/api/BBVAS/UsageSummary?subscriberID=${config.subscriberID}&_t=${Date.now()}`;
    
    const fetchHeaders = {
      ...config.headers,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };

    const response = await fetch(url, {
      method: 'GET',
      headers: fetchHeaders,
      cache: 'no-store'
    });

    if (response.status === 401 || response.status === 403) {
      authExpired = true;
      if (mainWindow) mainWindow.webContents.send('auth-expired');
      attemptHiddenRefresh();
      return;
    }

    if (!response.ok) {
      if (mainWindow) mainWindow.webContents.send('fetch-error', { type: 'server', status: response.status });
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    authExpired = false;
    
    if (data && data.dataBundle) {
      const bundle = data.dataBundle;
      
      if (bundle.my_package_info && bundle.my_package_info.usageDetails) {
        bundle.my_package_info.usageDetails.forEach((detail) => {
          let detailName = detail.name;
          if (detailName === 'Total (Standard + Free)') {
            detailName = 'Total';
          }
          checkAlerts(detailName, {
            remaining: parseFloat(detail.remaining || 0),
            total: parseFloat(detail.limit || 0),
            percent: parseFloat(detail.percentage || 0)
          });
        });
      }

      const summaryKeys = ['bonus_data_summary', 'free_data_summary', 'vas_data_summary', 'extra_gb_data_summary'];
      summaryKeys.forEach(key => {
        const summary = bundle[key];
        if (summary && summary.limit !== undefined && summary.used !== undefined) {
          const name = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).replace(' Summary', '');
          const limit = parseFloat(summary.limit || 0);
          const used = parseFloat(summary.used || 0);
          let remaining = limit - used;
          let percent = limit > 0 ? (remaining / limit) * 100 : 0;
          
          if (remaining < 0) {
            remaining = 0;
            percent = 0;
          }
          
          checkAlerts(name, {
            remaining,
            total: limit,
            percent
          });
        }
      });
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('usage-data', data);
    }
  } catch (error) {
    console.error('Fetch error:', error);
    // Distinguish network errors (no internet) from other errors
    const isNetworkError = error.message && (
      error.message.includes('ENOTFOUND') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('fetch failed') ||
      error.message.includes('ERR_INTERNET_DISCONNECTED') ||
      error.message.includes('ERR_NAME_NOT_RESOLVED') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED'
    );
    if (mainWindow) {
      mainWindow.webContents.send('fetch-error', {
        type: isNetworkError ? 'offline' : 'server',
        message: error.message
      });
    }
  }
}

function startPolling() {
  if (refreshInterval) clearInterval(refreshInterval);
  const ms = (config.refreshMinutes || 1) * 60 * 1000;
  refreshInterval = setInterval(fetchUsage, ms);
  fetchUsage(); // Initial fetch
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  tray = new Tray(iconPath);
  
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
  
  tray.setToolTip('SLTDU Widget');
  tray.setContextMenu(contextMenu);
}

function createWindow() {
  loadConfig();
  updateAutoLaunch();

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = store.get('windowWidth', 320);
  const windowHeight = store.get('windowHeight', 420);
  const windowX = store.get('windowX', screenWidth - windowWidth - 30);
  const windowY = store.get('windowY', 30);
  const isAlwaysOnTop = store.get('alwaysOnTop', true);
  const theme = store.get('theme', 'dark');

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    frame: false,
    transparent: true,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: true,
    resizable: true,
    minWidth: 320,
    minHeight: 180,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.loadFile('index.html');

  // ── Temporarily enable DevTools for debugging (remove for production) ──
  if (DEBUG) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  }
  
  mainWindow.on('resize', () => {
    if (!isProgrammaticResize) {
      const [width, height] = mainWindow.getSize();
      store.set('windowWidth', width);
      store.set('windowHeight', height);
      store.set('autoResize', false);
      mainWindow.webContents.send('setting-updated', { key: 'autoResize', value: false });
    }
  });

  mainWindow.on('moved', () => {
    const [x, y] = mainWindow.getPosition();
    store.set('windowX', x);
    store.set('windowY', y);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  startPolling();
}

function openTokenWindow() {
  if (tokenWindow) {
    tokenWindow.focus();
    return;
  }
  
  const { session } = require('electron');
  
  tokenWindow = new BrowserWindow({
    width: 600,
    height: 800,
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    title: "SLT Login",
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const filter = { urls: ['*://omniscapp.slt.lk/*'] };

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (details.requestHeaders['Authorization']) {
      const auth = details.requestHeaders['Authorization'];
      
      let subscriberID = store.get('subscriberID', '');
      try {
        const urlObj = new URL(details.url);
        if (urlObj.searchParams.has('subscriberID')) {
          subscriberID = urlObj.searchParams.get('subscriberID');
        }
      } catch (e) { debugLog('Token URL parse error:', e.message); }

      if (subscriberID) {
        store.set('subscriberID', subscriberID);
        const headers = store.get('headers', { 'X-IBM-Client-Id': 'b7402e9d66808f762ccedbe42c20668e' });
        headers.Authorization = auth;
        store.set('headers', headers);
        
        loadConfig();
        
        session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
        
        if (tokenWindow && !tokenWindow.isDestroyed()) {
          tokenWindow.close();
        }
        
        fetchUsage();
      }
    }
    
    callback({ requestHeaders: details.requestHeaders });
  });

  tokenWindow.loadURL('https://myslt.slt.lk/');
  
  tokenWindow.on('closed', () => {
    tokenWindow = null;
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
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
    initLogger();
    debugLog('App ready. Creating window...');
    createWindow();
    createTray();
    dumpInterfacesOnce(); // Dump all interfaces to log for debugging
    startNetworkPolling();

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

ipcMain.on('logout', async () => {
  store.delete('subscriberID');
  store.delete('headers');
  loadConfig();
  
  const { session } = require('electron');
  await session.defaultSession.clearStorageData();
  
  authExpired = true;
  if (mainWindow) {
    mainWindow.webContents.send('auth-expired');
  }
});

ipcMain.handle('get-config', () => {
  return {
    refreshMinutes: store.get('refreshMinutes', 1),
    alwaysOnTop: store.get('alwaysOnTop', true),
    theme: store.get('theme', 'dark'),
    chartMode: store.get('chartMode', 'bar'),
    chartColorMode: store.get('chartColorMode', 'dynamic'),
    chartOrder: store.get('chartOrder', []),
    hiddenCharts: store.get('hiddenCharts', []),
    autoResize: store.get('autoResize', true),
    dailyResetTime: store.get('dailyResetTime', '00:00')
  };
});

let isProgrammaticResize = false;

ipcMain.on('open-settings', () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  
  const theme = store.get('theme', 'dark');
  
  settingsWindow = new BrowserWindow({
    width: 320,
    height: 550,
    frame: false,
    transparent: true,
    alwaysOnTop: store.get('alwaysOnTop', true),
    resizable: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  settingsWindow.loadFile('settings.html');
  
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
});

ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

ipcMain.on('open-external', (e, url) => {
  require('electron').shell.openExternal(url);
});

ipcMain.on('close-app', () => {
  app.quit();
});

ipcMain.on('show-notification', (e, { title, body }) => {
  new Notification({ title, body }).show();
});

ipcMain.on('resize-window', (event, { width, height }) => {
  if (mainWindow) {
    const { screen } = require('electron');
    const { height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    let finalHeight = Math.min(height, screenHeight - 60);
    
    // Preserve the user's customized width instead of snapping back to 320
    const [currentWidth, currentHeight] = mainWindow.getSize();
    // Only resize if height is different to prevent flickering
    if (currentHeight !== finalHeight) {
      isProgrammaticResize = true;
      mainWindow.setSize(currentWidth, finalHeight, false);
      setTimeout(() => { isProgrammaticResize = false; }, 200);
    }
  }
});

ipcMain.on('update-setting', (event, { key, value }) => {
  store.set(key, value);
  loadConfig();
  
  if (key === 'alwaysOnTop') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(value);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setAlwaysOnTop(value);
    }
  }
  if (key === 'refreshMinutes') {
    startPolling();
  }
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('setting-updated', { key, value });
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('setting-updated', { key, value });
  }
});
