import type { BrowserWindow } from 'electron';

/** Finish local data and preference writes before the renderer or server goes away. */
export const saveBeforeClose = (window: BrowserWindow, close: () => void, cancel: () => void = () => {}) => {
  let saved = false;
  let saving = false;
  window.on('close', (event) => {
    if (saved || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (saving) return;
    saving = true;
    void window.webContents.executeJavaScript('window.agentHub?.flushPendingChanges?.() ?? true')
      .then((result: boolean) => {
        if (result) {
          saved = true;
          close();
        } else {
          cancel();
          window.focus();
        }
      })
      .catch((error: Error) => {
        console.warn(`Could not save changes before closing: ${error.message}`);
        cancel();
        window.focus();
      })
      .finally(() => { saving = false; });
  });
};
