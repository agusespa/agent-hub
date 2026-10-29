import { Notification } from 'electron';
import type { SessionConflict } from '../conflicts.js';
import type { SessionRecord } from '../types.js';

const notifications = new Set<Notification>();

/** Names the shared files once both sessions edited them, or else where they are working together. */
export const conflictAlert = (conflict: SessionConflict, sessions: SessionRecord[]) => {
  const names = conflict.sessionIds.map((id) => sessions.find((session) => session.id === id)?.title ?? id).join(' · ');
  if (!conflict.files.length) {
    return {
      title: conflict.kind === 'worktree' ? 'Two sessions are working in one worktree' : `Two sessions are working on ${conflict.branch ?? 'one branch'}`,
      body: `${names}\nPossible concurrent work; no edits to the same files so far.`,
    };
  }
  return {
    title: conflict.kind === 'worktree' ? 'Two sessions edited the same files' : 'Two sessions on one branch edited the same files',
    body: `${names}\n${conflict.files.slice(0, 3).join(', ')}${conflict.files.length > 3 ? ` (+${conflict.files.length - 3} more)` : ''}`,
  };
};

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
