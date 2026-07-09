const { app, BrowserWindow, session } = require('electron');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const filter = {
    urls: ['*://omniscapp.slt.lk/*']
  };

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    console.log('--- Intercepted Request to omniscapp.slt.lk ---');
    console.log('URL:', details.url);
    
    if (details.requestHeaders['Authorization']) {
      console.log('Found Authorization:', details.requestHeaders['Authorization'].substring(0, 30) + '...');
    }
    if (details.requestHeaders['X-IBM-Client-Id']) {
      console.log('Found X-IBM-Client-Id:', details.requestHeaders['X-IBM-Client-Id']);
    }
    
    console.log('-----------------------------------------------');
    callback({ requestHeaders: details.requestHeaders });
  });

  mainWindow.loadURL('https://myslt.slt.lk/');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
