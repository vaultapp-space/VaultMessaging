import { describe, test, expect } from 'vitest';

import { swipeOffset } from '../src/lib/chat/swipeToReply.js';

// The action itself needs a browser; this covers the part with a correctness
// question in it, matching how draggable.js splits out nextPosition().
describe('swipe-to-reply offset', () => {
  const TRIGGER = 56;

  test('a drag the wrong way does not move the bubble', () => {
    // Would otherwise let an outgoing bubble slide off its own edge.
    expect(swipeOffset(-40, 1, TRIGGER)).toBe(0);
    expect(swipeOffset(40, -1, TRIGGER)).toBe(0);
  });

  test('tracks the finger one-to-one before the trigger', () => {
    expect(swipeOffset(30, 1, TRIGGER)).toBe(30);
    expect(swipeOffset(-30, -1, TRIGGER)).toBe(-30);
  });

  test('rubber-bands past the trigger instead of tracking', () => {
    // 56 + (150-56)/3 ≈ 87.3 — still moving, visibly resisting.
    const offset = swipeOffset(150, 1, TRIGGER);
    expect(offset).toBeGreaterThan(TRIGGER);
    expect(offset).toBeLessThan(150);
    expect(offset).toBeCloseTo(TRIGGER + (150 - TRIGGER) / 3, 5);
  });

  test('keeps the sign of the allowed direction', () => {
    // direction -1 permits a *leftward* drag, so the allowed gesture is a
    // negative dx and the resulting offset is negative too.
    expect(swipeOffset(-200, -1, TRIGGER)).toBeLessThan(0);
    expect(swipeOffset(200, 1, TRIGGER)).toBeGreaterThan(0);
    // ...and the opposite drag is refused in both configurations.
    expect(swipeOffset(200, -1, TRIGGER)).toBe(0);
    expect(swipeOffset(-200, 1, TRIGGER)).toBe(0);
  });

  test('the trigger point itself is not yet rubber-banded', () => {
    expect(swipeOffset(TRIGGER, 1, TRIGGER)).toBe(TRIGGER);
  });
});
