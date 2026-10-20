import { describe, expect, it } from 'vitest';
import { branchName } from './git.js';

describe('branchName', () => {
  it('keeps named branches', () => {
    expect(branchName('feature/PROJ-7-thing')).toBe('feature/PROJ-7-thing');
  });

  it('has none for HEAD or an empty branch', () => {
    expect(branchName('HEAD')).toBeUndefined();
    expect(branchName('')).toBeUndefined();
    expect(branchName(null)).toBeUndefined();
  });
});
