const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 400,
    frame: false,
    transparent: true,
    backgroundMaterial: 'acrylic',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  win.loadURL('data:text/html,<html><body style="background: rgba(255,255,255,0.1); color: white;"><h1>Acrylic Test</h1></body></html>');

  setTimeout(() => {
    win.setBackgroundMaterial('none');
    setTimeout(() => {
      win.setBackgroundMaterial('acrylic');
      setTimeout(() => app.quit(), 2000);
    }, 2000);
  }, 2000);
});
