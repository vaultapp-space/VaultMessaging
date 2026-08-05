import { describe, test, expect } from 'vitest';

import { canEdit } from '../src/lib/chat/edit.js';

const ME = 'user-me';
const OTHER = 'user-other';

describe('canEdit', () => {
  const base = { seq: 3, senderId: ME, text: 'hello' };

  test('allows the author to edit their own text message', () => {
    expect(canEdit(base, ME)).toBe(true);
  });

  test('refuses a message written by someone else', () => {
    // An edit marker only means anything if it means the *author* changed
    // their own words.
    expect(canEdit({ ...base, senderId: OTHER }, ME)).toBe(false);
  });

  test('refuses a message with no seq', () => {
    // Unaddressable — there is nothing to reference in an edit.
    expect(canEdit({ ...base, seq: null }, ME)).toBe(false);
  });

  test('refuses media for now', () => {
    expect(canEdit({ ...base, media: { id: 'f1' } }, ME)).toBe(false);
  });

  test('refuses a deleted message', () => {
    expect(canEdit({ ...base, deletedAt: '2026-01-01T00:00:00Z' }, ME)).toBe(false);
  });

  test('refuses when there is no current user', () => {
    expect(canEdit(base, null)).toBe(false);
    expect(canEdit(base, undefined)).toBe(false);
  });

  test('tolerates a missing message', () => {
    expect(canEdit(null, ME)).toBe(false);
    expect(canEdit(undefined, ME)).toBe(false);
  });
});
