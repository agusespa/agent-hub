import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { saveBeforeClose } from './saveBeforeClose.js';

const fakeWindow = (flush: () => Promise<boolean>) => Object.assign(new EventEmitter(), {
  webContents: { isDestroyed: () => false, executeJavaScript: vi.fn(flush) },
  focus: vi.fn(),
});

describe('saving notes before closing Electron', () => {
  it('waits for pending writes and handles repeated close attempts without duplicate saves', async () => {
    let finish!: (saved: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const window = fakeWindow(() => pending);
    const close = vi.fn();
    saveBeforeClose(window as unknown as BrowserWindow, close);
    const event = { preventDefault: vi.fn() };
    window.emit('close', event);
    window.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    const retry = { preventDefault: vi.fn() };
    window.emit('close', retry);
    expect(retry.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves failed edits open, cancels quit and allows a retry', async () => {
    const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const window = fakeWindow(flush);
    const close = vi.fn();
    const cancel = vi.fn();
    saveBeforeClose(window as unknown as BrowserWindow, close, cancel);
    window.emit('close', { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    window.emit('close', { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
