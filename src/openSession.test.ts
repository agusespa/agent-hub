import { describe, expect, it } from 'vitest';
import { sessionUrl } from './openSession.js';

describe('sessionUrl', () => {
  it('links Codex threads', () => {
    expect(sessionUrl({ source: 'codex', openId: 't1' })).toBe('codex://threads/t1');
  });

  it('encodes the id', () => {
    expect(sessionUrl({ source: 'codex', openId: 'a/b?c' })).toBe('codex://threads/a%2Fb%3Fc');
  });

  it('has no Claude link', () => {
    expect(sessionUrl({ source: 'claude', openId: 'abc-123' })).toBeUndefined();
  });

  it('has no link without an id', () => {
    expect(sessionUrl({ source: 'codex' })).toBeUndefined();
  });
});
