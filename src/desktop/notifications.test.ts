import { describe, expect, it, vi } from 'vitest';
import type { SessionConflict } from '../conflicts.js';
import { conflictAlert } from './notifications.js';

vi.mock('electron', () => ({ Notification: vi.fn() }));

const conflict: SessionConflict = {
  key: 'pair', kind: 'worktree', location: '/repo', branch: 'main', sessionIds: ['claude:a', 'codex:b'], files: [],
};

describe('conflictAlert', () => {
  it('names the shared files, by worktree or branch', () => {
    expect(conflictAlert({ ...conflict, files: ['a.ts'] }, [])).toEqual({
      title: 'Two sessions edited the same files', body: 'claude:a · codex:b\na.ts',
    });
    expect(conflictAlert({ ...conflict, kind: 'branch', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }, [])).toEqual({
      title: 'Two sessions on one branch edited the same files', body: 'claude:a · codex:b\na.ts, b.ts, c.ts (+1 more)',
    });
  });
});
