import { app, BrowserWindow } from 'electron';

// ============================================================
// GD4 Assistant — fenêtre de l'application de bureau
// ------------------------------------------------------------
// En DEV        → http://localhost:4321 (npm run dev / astro dev)
// En PRODUCTION → l'URL du site en ligne (à REMPLIR ci-dessous
//                 une fois le site déployé, ex. https://gd4.netlify.app)
// ============================================================
const PROD_URL = 'https://REMPLACE-MOI-APRES-DEPLOIEMENT.example'; // ← à remplacer

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "GD4 Assistant",
    webPreferences: {
      nodeIntegration: true
    }
  });

  const url = app.isPackaged ? PROD_URL : 'http://localhost:4321';
  win.loadURL(url);
}

app.whenReady().then(createWindow);

// Comportement standard : quitter quand toutes les fenêtres sont fermées
// (Windows/Linux). Sur macOS l'app reste vivante dans le dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});