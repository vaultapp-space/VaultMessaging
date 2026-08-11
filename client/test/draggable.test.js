import { describe, test, expect } from 'vitest';

import { nextPosition, clampToViewport } from '../src/lib/chat/draggable.js';

describe('drag translation', () => {
  test('applies the pointer delta to the starting position', () => {
    const result = nextPosition({ x: 100, y: 50 }, { x: 10, y: 10 }, { x: 30, y: 40 });
    expect(result).toEqual({ x: 120, y: 80 });
  });

  test('is relative to where the drag began, not the current position', () => {
    // The bug this guards: applying the delta to the *current* position each
    // frame compounds it, and the window shoots off under the cursor.
    const initial = { x: 0, y: 0 };
    const start = { x: 100, y: 100 };

    const first = nextPosition(initial, start, { x: 110, y: 100 });
    const second = nextPosition(initial, start, { x: 120, y: 100 });

    expect(first.x).toBe(10);
    expect(second.x).toBe(20, 'total offset from the drag origin, not cumulative');
  });

  test('handles dragging up and left', () => {
    expect(nextPosition({ x: 50, y: 50 }, { x: 100, y: 100 }, { x: 60, y: 70 }))
      .toEqual({ x: 10, y: 20 });
  });

  test('a zero-distance drag leaves the position unchanged', () => {
    const initial = { x: 42, y: 7 };
    expect(nextPosition(initial, { x: 5, y: 5 }, { x: 5, y: 5 })).toEqual(initial);
  });

  test('permits negative coordinates', () => {
    // The window can legitimately be dragged above or left of its origin.
    expect(nextPosition({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 40, y: 30 }))
      .toEqual({ x: -60, y: -70 });
  });
});

describe('clampToViewport', () => {
  // The call window is anchored top-4 right-4 and moved by a transform, so an
  // offset of {0,0} means "sitting in the top-right corner".
  const size = { width: 200, height: 150 };
  const viewport = { width: 400, height: 800 };

  test('leaves an in-bounds position untouched', () => {
    expect(clampToViewport({ x: -50, y: 100 }, size, viewport)).toEqual({ x: -50, y: 100 });
  });

  test('stops the window being dragged off the right edge', () => {
    // Far right: at most width-MIN_VISIBLE may hang off, so a sliver stays.
    const out = clampToViewport({ x: 5000, y: 0 }, size, viewport);
    const left = viewport.width - 16 - size.width + out.x;
    expect(left).toBeLessThanOrEqual(viewport.width - 56);
    expect(left + size.width).toBeGreaterThan(viewport.width - 56);
  });

  test('stops the window being dragged off the left edge', () => {
    const out = clampToViewport({ x: -5000, y: 0 }, size, viewport);
    const left = viewport.width - 16 - size.width + out.x;
    expect(left + size.width).toBeGreaterThanOrEqual(56);
  });

  test('stops the window being dragged above the top', () => {
    // This is the one that stranded a call: dragged up past the top there was
    // no way to reach the end-call button again.
    const out = clampToViewport({ x: 0, y: -5000 }, size, viewport);
    expect(16 + out.y).toBeGreaterThanOrEqual(0);
  });

  test('stops the window being dragged below the bottom', () => {
    const out = clampToViewport({ x: 0, y: 5000 }, size, viewport);
    expect(16 + out.y).toBeLessThanOrEqual(viewport.height - 56);
  });

  test('a window larger than the viewport is still reachable', () => {
    // A 'large' call window on a narrow phone: clamping must not produce a
    // position that puts its controls permanently out of reach.
    const big = { width: 308, height: 400 };
    const narrow = { width: 320, height: 640 };
    const out = clampToViewport({ x: -5000, y: -5000 }, big, narrow);
    const left = narrow.width - 16 - big.width + out.x;
    expect(left + big.width).toBeGreaterThanOrEqual(56);
    expect(16 + out.y).toBeGreaterThanOrEqual(0);
  });
});
