import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron';
import { startBoardServer } from '../boardServer.js';
import type { UsageAlert } from '../usageAlerts.js';
import { DATA_DIR, PROJECT_ROOT } from '../app.js';
import { ViewStore } from '../view.js';
import { createAlert, conflictAlert } from './notifications.js';
import { testNotification } from './notificationTest.js';
import { saveBeforeClose } from './saveBeforeClose.js';

let quitting = false;

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
 * matching --bg in base.css keeps it from flashing white.
 */
const backgroundColor = () => (nativeTheme.shouldUseDarkColors ? '#0a0c0f' : '#f6f7f5');

const openWindow = (boardUrl: string) => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    title: 'Agent Hub',
    backgroundColor: backgroundColor(),
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 20 },
    } as const : {}),
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      session: session.fromPartition('agent-hub-ui', { cache: false }),
    },
  });
  window.once('ready-to-show', () => window.show());
  saveBeforeClose(window, () => quitting ? app.quit() : window.close(), () => { quitting = false; });
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

/** Brings the board to the front, opening a window if it was closed. */
const showBoard = (boardUrl: string) => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  } else {
    openWindow(boardUrl);
  }
};

/** Clicking a desktop alert brings the board to the front. */
const notifyAlert = (alert: Pick<UsageAlert, 'title' | 'body'>, boardUrl: string) => {
  createAlert(alert, () => showBoard(boardUrl))?.show();
};

const start = async () => {
  // The packaged app takes its icon from the bundle; `npm run app` would otherwise show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(path.join(PROJECT_ROOT, 'build', 'icon.png'));
  // Before the window opens, so its background and controls start in the chosen theme.
  nativeTheme.themeSource = (await new ViewStore(path.join(DATA_DIR, 'view.json')).read()).theme;
  const board = await startBoardServer({
    dataDir: DATA_DIR,
    port: 0,
    onUsageAlert: (alert) => notifyAlert(alert, board.url),
    onConflictAlert: (conflict, cards) => notifyAlert(conflictAlert(conflict, cards), board.url),
    onThemeChange: (theme) => { nativeTheme.themeSource = theme; },
    notifications: {
      test: () => {
        const alert = createAlert({ title: 'Agent Hub notifications work', body: 'Usage and file-overlap alerts will show like this.' }, () => showBoard(board.url));
        if (!alert) throw new Error('This Mac does not support notifications');
        alert.show();
      },
      // Where macOS lists each app's notification permission and style.
      openSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'),
    },
  });
  openWindow(board.url);

  app.on('second-instance', () => showBoard(board.url));
  // macOS convention: closing the window keeps the app in the Dock; clicking it reopens the board.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(board.url);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => board.close());
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(backgroundColor());
  });
};

// Electron's caches go in a subfolder so placements.json and tickets.json stay easy to find.
app.setPath('userData', path.join(DATA_DIR, 'Electron'));

// No top-level await: Electron does not fire `ready` until the ESM entry module has finished evaluating.
if (process.argv.includes('--test-notification')) {
  app.whenReady().then(testNotification).then(() => app.exit(0)).catch((error: Error) => {
    console.error(`Notification test failed: ${error.message}`);
    app.exit(1);
  });
} else if (!app.requestSingleInstanceLock()) {
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
