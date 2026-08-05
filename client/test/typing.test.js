import { describe, test, expect } from 'vitest';
import { get } from 'svelte/store';

import { setTyping, addMessage, typingUsers } from '../src/lib/stores/messages.js';

const BOB = 'user-bob';

describe('typing indicator', () => {
  test('an arriving message clears the sender\'s typing indicator immediately', () => {
    setTyping(BOB);
    expect(get(typingUsers).has(BOB)).toBe(true);

    // The indicator otherwise only clears on its own 3-second timer, so a
    // message that lands sooner than that would render next to a "typing…"
    // for something that has already arrived — looking stuck rather than
    // live.
    addMessage(BOB, {
      id: `msg-${Math.random()}`,
      senderId: BOB,
      text: 'hi',
      sentAt: new Date().toISOString(),
      encrypted: false,
    });

    expect(get(typingUsers).has(BOB)).toBe(false);
  });

  test('does not touch typing state for an unrelated sender', () => {
    setTyping(BOB);
    const OTHER = 'user-carol';

    addMessage(OTHER, {
      id: `msg-${Math.random()}`,
      senderId: OTHER,
      text: 'hi',
      sentAt: new Date().toISOString(),
      encrypted: false,
    });

    expect(get(typingUsers).has(BOB)).toBe(true);
  });
});
