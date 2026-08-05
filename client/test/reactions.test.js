import { describe, test, expect } from 'vitest';

import { applySummary, hasReacted } from '../src/lib/chat/reactions.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';

describe('hasReacted', () => {
  const reactions = [{ emoji: '🔥', count: 1, users: [ALICE] }];

  test('is true for a user in the list', () => {
    expect(hasReacted(reactions, '🔥', ALICE)).toBe(true);
  });

  test('is false for a user who has not reacted', () => {
    expect(hasReacted(reactions, '🔥', BOB)).toBe(false);
  });

  test('is false for an emoji nobody used', () => {
    expect(hasReacted(reactions, '🎉', ALICE)).toBe(false);
  });

  test('tolerates an empty or missing summary', () => {
    expect(hasReacted([], '🔥', ALICE)).toBe(false);
    expect(hasReacted(undefined, '🔥', ALICE)).toBe(false);
  });
});

describe('applySummary', () => {
  test('adds a new emoji', () => {
    const next = applySummary([], { emoji: '🔥', userId: ALICE, add: true });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ emoji: '🔥', count: 1, users: [ALICE] });
  });

  test('adds a second user to an existing emoji', () => {
    const start = [{ emoji: '🔥', count: 1, users: [ALICE] }];
    const next = applySummary(start, { emoji: '🔥', userId: BOB, add: true });

    expect(next[0].count).toBe(2);
    expect(next[0].users).toEqual([ALICE, BOB]);
  });

  test('adding twice is idempotent', () => {
    // A double-tap must not double-count.
    const start = [{ emoji: '🔥', count: 1, users: [ALICE] }];
    const next = applySummary(start, { emoji: '🔥', userId: ALICE, add: true });

    expect(next[0].count).toBe(1);
    expect(next[0].users).toEqual([ALICE]);
  });

  test('removing leaves other users intact', () => {
    const start = [{ emoji: '🔥', count: 2, users: [ALICE, BOB] }];
    const next = applySummary(start, { emoji: '🔥', userId: BOB, add: false });

    expect(next[0].count).toBe(1);
    expect(next[0].users).toEqual([ALICE]);
  });

  test('an emoji nobody uses disappears rather than sitting at zero', () => {
    const start = [{ emoji: '🔥', count: 1, users: [ALICE] }];
    const next = applySummary(start, { emoji: '🔥', userId: ALICE, add: false });

    expect(next).toEqual([]);
  });

  test('removing one that was never added changes nothing', () => {
    const start = [{ emoji: '🔥', count: 1, users: [ALICE] }];
    const next = applySummary(start, { emoji: '🎉', userId: BOB, add: false });

    expect(next).toEqual(start);
  });

  test('does not mutate the input', () => {
    // The store holds these arrays; mutating in place would skip Svelte's
    // change detection and the reaction would not render until something else
    // triggered an update.
    const start = [{ emoji: '🔥', count: 1, users: [ALICE] }];
    const snapshot = JSON.parse(JSON.stringify(start));

    applySummary(start, { emoji: '🔥', userId: BOB, add: true });

    expect(start).toEqual(snapshot);
  });

  test('output is ordered deterministically', () => {
    // Otherwise reactions visibly reshuffle whenever anyone reacts.
    const built = ['🔥', '👍', '❤️'].reduce(
      (acc, emoji) => applySummary(acc, { emoji, userId: ALICE, add: true }),
      []
    );
    const reversed = ['❤️', '👍', '🔥'].reduce(
      (acc, emoji) => applySummary(acc, { emoji, userId: ALICE, add: true }),
      []
    );

    expect(built.map((r) => r.emoji)).toEqual(reversed.map((r) => r.emoji));
  });

  test('several emoji from one user coexist', () => {
    let summary = applySummary([], { emoji: '🔥', userId: ALICE, add: true });
    summary = applySummary(summary, { emoji: '🎉', userId: ALICE, add: true });

    expect(summary).toHaveLength(2);
    expect(summary.every((r) => r.count === 1)).toBe(true);
  });

  test('a full add/remove cycle returns to empty', () => {
    let summary = applySummary([], { emoji: '👍', userId: ALICE, add: true });
    summary = applySummary(summary, { emoji: '👍', userId: BOB, add: true });
    summary = applySummary(summary, { emoji: '👍', userId: ALICE, add: false });
    summary = applySummary(summary, { emoji: '👍', userId: BOB, add: false });

    expect(summary).toEqual([]);
  });
});
