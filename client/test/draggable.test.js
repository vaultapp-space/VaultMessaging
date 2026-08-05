import { describe, test, expect } from 'vitest';

import { nextPosition } from '../src/lib/chat/draggable.js';

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
