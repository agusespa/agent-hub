import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Notification } from 'electron';
import { ConflictAlerts, sessionConflicts } from '../conflicts.js';
import type { SessionRecord } from '../types.js';
import { conflictAlert, createAlert } from './notifications.js';

/** Exercise real Git detection and the production notification path without changing the user's board. */
export const testNotification = async (): Promise<void> => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agent-hub-notification-'));
  try {
    await promisify(execFile)('git', ['init', '--initial-branch=notification-test'], { cwd });
    const sessions: SessionRecord[] = [
      { id: 'claude:notification-test', source: 'claude', title: 'Simulated Claude session', cwd, liveStatus: 'working' },
      { id: 'codex:notification-test', source: 'codex', title: 'Simulated Codex session', cwd, liveStatus: 'working' },
    ];
    const alerts = new ConflictAlerts();
    const shared = await sessionConflicts(sessions);
    if (shared.length !== 1 || alerts.take(shared).length) throw new Error('Workspace sharing detection failed or alerted without file overlap');
    const overlaps = await sessionConflicts(sessions, undefined, new Map(sessions.map((session) => [session.id, [path.join(cwd, 'shared.ts')]])));
    const [conflict] = alerts.take(overlaps);
    if (!conflict || alerts.take(overlaps).length) throw new Error('File overlap detection or alert deduplication failed');
    console.log('Notification test: shared workspace stayed silent; file overlap alerted once; repeat alerts suppressed.');
    const alert = conflictAlert(conflict, sessions);
    const notification = createAlert({ ...alert, title: `[Test] ${alert.title}` });
    if (!notification) throw new Error('Desktop notifications are not supported');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No notification result within 15 seconds; check macOS notification permission')), 15_000);
      notification.once('failed', (_event, error) => {
        clearTimeout(timeout);
        reject(new Error(error));
      });
      notification.once('show', () => {
        console.log('Notification test: macOS emitted the show event.');
        setTimeout(() => {
          Notification.getHistory().then((history) => {
            clearTimeout(timeout);
            const delivered = history.some((entry) => entry.id === notification.id);
            console.log(`Notification test: found in Notification Center = ${delivered}.`);
            if (delivered) {
              console.log('Notification test: delivery confirmed; banner visibility still needs visual confirmation. Keeping the app alive for 30 seconds.');
              // Quitting immediately after delivery makes the visual test too brief.
              setTimeout(resolve, 30_000);
            } else reject(new Error('Notification was not found in Notification Center'));
          }).catch((error) => { clearTimeout(timeout); reject(error); });
        }, 1000);
      });
      notification.show();
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
