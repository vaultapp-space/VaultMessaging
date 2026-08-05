import { describe, test, expect } from 'vitest';

import { matchPath, paths } from '../src/lib/router.js';

describe('route matching', () => {
  test('matches the landing page', () => {
    expect(matchPath('/').name).toBe('landing');
  });

  test('matches static routes', () => {
    expect(matchPath('/login').name).toBe('login');
    expect(matchPath('/register').name).toBe('register');
    expect(matchPath('/a').name).toBe('chatList');
    expect(matchPath('/a/settings').name).toBe('settings');
    expect(matchPath('/a/wallet').name).toBe('wallet');
  });

  test('extracts a chat id', () => {
    const r = matchPath('/a/c/abc-123');
    expect(r.name).toBe('chat');
    expect(r.params.chatId).toBe('abc-123');
  });

  test('extracts a chat id and message sequence', () => {
    // This is the deep link that makes reply-jumping and notification taps
    // work; the four-value activeView store could not express it at all.
    const r = matchPath('/a/c/abc-123/42');
    expect(r.name).toBe('message');
    expect(r.params).toEqual({ chatId: 'abc-123', seq: '42' });
  });

  test('extracts a settings section', () => {
    const r = matchPath('/a/settings/privacy');
    expect(r.name).toBe('settingsSection');
    expect(r.params.section).toBe('privacy');
  });

  test('matches a group invite link', () => {
    const r = matchPath('/join/xyz789');
    expect(r.name).toBe('joinGroup');
    expect(r.params.inviteHash).toBe('xyz789');
  });

  test('matches a bare username as a profile', () => {
    const r = matchPath('/alice');
    expect(r.name).toBe('profile');
    expect(r.params.username).toBe('alice');
  });

  test('a known static route wins over the username catch-all', () => {
    // Ordering matters: /login must never be read as the profile of a user
    // called "login".
    expect(matchPath('/login').name).toBe('login');
    expect(matchPath('/a').name).toBe('chatList');
  });

  test('tolerates a trailing slash', () => {
    expect(matchPath('/a/c/abc-123/').name).toBe('chat');
    expect(matchPath('/login/').name).toBe('login');
  });

  test('decodes percent-encoded parameters', () => {
    expect(matchPath('/a/c/id%20with%20spaces').params.chatId).toBe('id with spaces');
  });

  test('returns notFound for an unmatched deep path', () => {
    expect(matchPath('/a/c/one/two/three/four').name).toBe('notFound');
  });

  test('an empty path is the landing page', () => {
    expect(matchPath('').name).toBe('landing');
  });
});

describe('path builders', () => {
  test('round-trip with the matcher', () => {
    expect(matchPath(paths.chat('c1')).params.chatId).toBe('c1');
    expect(matchPath(paths.message('c1', 9)).params).toEqual({ chatId: 'c1', seq: '9' });
    expect(matchPath(paths.profile('bob')).params.username).toBe('bob');
    expect(matchPath(paths.joinGroup('k1')).params.inviteHash).toBe('k1');
    expect(matchPath(paths.settings('appearance')).params.section).toBe('appearance');
  });

  test('encode values that would otherwise break the path', () => {
    const built = paths.chat('a/b');
    expect(built).toBe('/a/c/a%2Fb');
    expect(matchPath(built).params.chatId).toBe('a/b');
  });

  test('settings without a section returns the base path', () => {
    expect(paths.settings()).toBe('/a/settings');
    expect(matchPath(paths.settings()).name).toBe('settings');
  });
});
