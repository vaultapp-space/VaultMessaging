// ============================================================
// Vault — Router
// ============================================================
// A ~150 line hand-rolled router, deliberately not SvelteKit.
//
// Why one is needed: app state lived in `activeView`, a store holding one of
// four strings. That cannot express `/c/<chatId>/<seq>` (jump to a message),
// `/<username>` (the t.me-style public profile link), or `/join/<hash>` —
// all of which are load-bearing for the features being built, and none of
// which can be bolted onto a four-value enum.
//
// Why not SvelteKit: adopting it means restructuring the app around its
// routing and build conventions. That is a rewrite, and it buys nothing this
// app needs beyond what the 150 lines below provide.
//
// Design notes:
//  - The URL is the single source of truth; `route` is derived from it.
//  - Fragments are never used for routing. The QR device-sync flow puts a key
//    in the fragment precisely because browsers never transmit it, and that
//    property must not be disturbed.

import { readable, derived, get } from 'svelte/store';

// Ordered most-specific first; the first match wins.
const ROUTES = [
  { name: 'landing',   pattern: '/' },
  { name: 'login',     pattern: '/login' },
  { name: 'register',  pattern: '/register' },
  { name: 'chatList',  pattern: '/a' },
  { name: 'chat',      pattern: '/a/c/:chatId' },
  { name: 'message',   pattern: '/a/c/:chatId/:seq' },
  { name: 'settings',  pattern: '/a/settings' },
  { name: 'settingsSection', pattern: '/a/settings/:section' },
  { name: 'wallet',    pattern: '/a/wallet' },
  { name: 'joinGroup', pattern: '/join/:inviteHash' },
  { name: 'stickers',  pattern: '/addstickers/:setName' },
  // Must stay last: a bare segment is only a username once nothing else matches.
  { name: 'profile',   pattern: '/:username' },
];

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

const COMPILED = ROUTES.map((r) => ({ ...r, ...compile(r.pattern) }));

export function matchPath(pathname) {
  for (const route of COMPILED) {
    const match = route.regex.exec(pathname || '/');
    if (!match) continue;
    const params = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(match[i + 1]);
    });
    return { name: route.name, params, pattern: route.pattern };
  }
  return { name: 'notFound', params: {}, pattern: null };
}

function snapshot() {
  if (typeof window === 'undefined') {
    return { name: 'landing', params: {}, query: {}, hash: '', path: '/' };
  }
  const { pathname, search, hash } = window.location;
  const matched = matchPath(pathname);
  return {
    ...matched,
    path: pathname,
    query: Object.fromEntries(new URLSearchParams(search)),
    // Exposed for the QR sync flow only; never used for routing.
    hash: hash.startsWith('#') ? hash.slice(1) : hash,
  };
}

export const route = readable(snapshot(), (set) => {
  if (typeof window === 'undefined') return;
  const update = () => set(snapshot());
  window.addEventListener('popstate', update);
  window.addEventListener('vault:navigate', update);
  return () => {
    window.removeEventListener('popstate', update);
    window.removeEventListener('vault:navigate', update);
  };
});

export const routeName = derived(route, ($r) => $r.name);
export const routeParams = derived(route, ($r) => $r.params);

/** Navigates without a page load. `replace` avoids a history entry. */
export function navigate(path, { replace = false, state = {} } = {}) {
  if (typeof window === 'undefined') return;
  if (window.location.pathname + window.location.search === path) return;

  if (replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);

  window.dispatchEvent(new Event('vault:navigate'));
}

export function currentRoute() {
  return get(route);
}

// ─── Path builders ──────────────────────────────────────────
// Used instead of string literals so a future change to the URL shape is one
// edit rather than a search across every component.

export const paths = {
  landing: () => '/',
  login: () => '/login',
  register: () => '/register',
  chatList: () => '/a',
  chat: (chatId) => `/a/c/${encodeURIComponent(chatId)}`,
  message: (chatId, seq) => `/a/c/${encodeURIComponent(chatId)}/${seq}`,
  settings: (section) => (section ? `/a/settings/${section}` : '/a/settings'),
  wallet: () => '/a/wallet',
  profile: (username) => `/${encodeURIComponent(username)}`,
  joinGroup: (hash) => `/join/${encodeURIComponent(hash)}`,
};

// Which top-level view each route renders. This is the bridge from the URL
// back to the existing `activeView` values, so components that still switch on
// those keep working while routes are adopted incrementally.
const VIEW_FOR_ROUTE = {
  landing: 'landing',
  login: 'auth',
  register: 'auth',
  chatList: 'chat',
  chat: 'chat',
  message: 'chat',
  settings: 'chat',
  settingsSection: 'chat',
  wallet: 'vaultcoin',
  joinGroup: 'chat',
  stickers: 'chat',
  profile: 'landing',
  notFound: 'landing',
};

export const viewForRoute = derived(route, ($r) => VIEW_FOR_ROUTE[$r.name] || 'landing');
