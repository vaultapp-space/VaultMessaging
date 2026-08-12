import { describe, test, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

// The module starts a client-side reaper interval and subscribes for the
// encrypted-backup writer on import. Neither matters here and both would keep
// the test process alive.
vi.mock('../src/lib/db.js', () => ({
  saveEncryptedBackup: vi.fn(async () => {}),
  loadEncryptedBackup: vi.fn(async () => null),
  clearEncryptedBackup: vi.fn(async () => {}),
}));

const { messagesByPeer, addMessages, forgetPeerMessages, clearMessages } =
  await import('../src/lib/stores/messages.js');

// clearMessages rather than messagesByPeer.set(new Map()): the dedupe set is
// module-level, and resetting only the map leaves it holding ids whose
// messages are gone, so the next addMessages of the same id is swallowed as a
// duplicate. Worth knowing outside the test too — anything that empties the
// map without going through clearMessages or forgetPeerMessages will hit it.
beforeEach(() => {
  clearMessages();
});

const msg = (id, text) => ({
  id, senderId: 'them', text, sentAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

describe('forgetPeerMessages', () => {
  test('drops one peer and leaves the others alone', () => {
    addMessages('peer-a', [msg('a1', 'hello'), msg('a2', 'again')]);
    addMessages('peer-b', [msg('b1', 'unrelated')]);

    forgetPeerMessages('peer-a');

    expect(get(messagesByPeer).has('peer-a')).toBe(false);
    expect(get(messagesByPeer).get('peer-b')).toHaveLength(1);
  });

  test('a message can be re-added after being forgotten', () => {
    // The dedupe set is what makes this worth asserting: it is module-level
    // and survives the map entry being deleted, so a forget that did not prune
    // it would make the same message unrenderable forever — the chat would
    // come back empty and stay empty.
    addMessages('peer-a', [msg('a1', 'hello')]);
    forgetPeerMessages('peer-a');

    addMessages('peer-a', [msg('a1', 'hello')]);

    expect(get(messagesByPeer).get('peer-a')).toHaveLength(1);
  });

  test('forgetting an unknown peer is harmless', () => {
    addMessages('peer-a', [msg('a1', 'hello')]);
    forgetPeerMessages('nobody');
    expect(get(messagesByPeer).get('peer-a')).toHaveLength(1);
  });
});
