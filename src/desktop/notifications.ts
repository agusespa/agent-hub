import { Notification } from 'electron';
import type { SessionConflict } from '../conflicts.js';
import type { SessionRecord } from '../types.js';

const notifications = new Set<Notification>();

export const conflictAlert = (conflict: SessionConflict, sessions: SessionRecord[]) => ({
  title: conflict.kind === 'worktree' ? 'Two sessions working in the same worktree' : 'Two sessions working on the same branch',
  body: `${conflict.sessionIds.map((id) => sessions.find((session) => session.id === id)?.title ?? id).join(' · ')}\n${conflict.kind === 'worktree' ? conflict.location : conflict.branch}`,
});

/** Keep notifications alive so their click handlers work; callers attach test listeners before showing. */
export const createAlert = (alert: { title: string; body: string }, onClick?: () => void): Notification | undefined => {
  if (!Notification.isSupported()) return;
  const notification = new Notification(alert);
  notifications.add(notification);
  notification.on('click', () => {
    notifications.delete(notification);
    onClick?.();
  });
  notification.on('close', () => notifications.delete(notification));
  notification.on('failed', (_event, error) => {
    notifications.delete(notification);
    console.warn(`Notification failed: ${error}`);
  });
  return notification;
};
