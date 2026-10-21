import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { startBoardServer } from '../boardServer.js';
import { DATA_DIR, PROJECT_ROOT } from '../app.js';

/**
 * Apps opened from Finder get a bare PATH without ~/.local/bin or Homebrew, so
 * `claude` would not be found. Take the PATH a login shell sets up instead.
 */
const useLoginShellPath = () => {
  try {
    const output = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "<<%s>>" "$PATH"'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const shellPath = output.match(/<<(.*)>>/)?.[1];
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Keep the inherited PATH; the board shows which source failed.
  }
};

/**
 * The window's native background shows before the board paints and while it closes;
 * matching --bg in style.css keeps it from flashing white.
 */
const backgroundColor = () => (nativeTheme.shouldUseDarkColors ? '#171716' : '#f4f4f1');

const openWindow = (boardUrl: string) => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    title: 'Agent Hub',
    backgroundColor: backgroundColor(),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  // Any link opens in the default browser; the window only ever shows the board.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(boardUrl).origin) event.preventDefault();
  });
  void window.loadURL(boardUrl);
};

const start = async () => {
  // The packaged app takes its icon from the bundle; `npm run app` would otherwise show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(path.join(PROJECT_ROOT, 'build', 'icon.png'));
  const board = await startBoardServer({ dataDir: DATA_DIR, port: 0 });
  openWindow(board.url);

  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    } else {
      openWindow(board.url);
    }
  });
  // macOS convention: closing the window keeps the app in the Dock; clicking it reopens the board.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(board.url);
  });
  app.on('before-quit', () => board.close());
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(backgroundColor());
  });
};

// Electron's caches go in a subfolder so placements.json and tickets.json stay easy to find.
app.setPath('userData', path.join(DATA_DIR, 'Electron'));

// No top-level await: Electron does not fire `ready` until the ESM entry module has finished evaluating.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  useLoginShellPath();
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // A failed start lands here; without the dialog the app would sit in the Dock with no window.
  app
    .whenReady()
    .then(start)
    .catch((error: Error) => {
      console.error('Agent Hub failed to start:', error);
      dialog.showErrorBox('Agent Hub could not start', error.message);
      app.quit();
    });
}
