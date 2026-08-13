import { Capacitor } from '@capacitor/core';

const DARK_BG = '#09090b';
const LIGHT_BG = '#fafafa';

// Only set while a switch is actually in flight. The colour transition in
// app.css is gated on this class rather than applied permanently for two
// reasons: it must not run on first paint (every surface would fade in from
// the wrong theme on load), and leaving it on would tint every unrelated
// hover and state change with a 220ms colour lag.
let themeSwitchTimer = null;
let applied = false;
const THEME_SWITCH_MS = 220;

export function applyTheme(newTheme) {
  const isLight = newTheme === 'light';
  const root = document.documentElement;

  // Never animate the first call. index.html hard-codes class="light" so the
  // page has something to paint before JS runs; a user whose stored theme is
  // dark therefore hits a light→dark change on every boot, and animating it
  // would turn a flash into a visible 220ms fade on app start. Only a
  // deliberate switch, once the app is up, is worth easing.
  const isChange = applied && root.classList.contains('light') !== isLight;
  applied = true;

  if (isChange) {
    root.classList.add('theme-switching');
    clearTimeout(themeSwitchTimer);
    themeSwitchTimer = setTimeout(
      () => root.classList.remove('theme-switching'),
      THEME_SWITCH_MS + 40
    );
  }

  document.documentElement.classList.toggle('light', isLight);

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', isLight ? LIGHT_BG : DARK_BG);

  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', isLight ? 'light' : 'dark');

  // The <meta name="theme-color"> above is a browser-chrome hint Android's
  // WebView doesn't read — without this, the status bar icons stay
  // whichever color they launched with regardless of in-app theme. The app
  // draws edge-to-edge (see App.svelte), so it's only the icon color that
  // matters here, not a background fill.
  if (Capacitor.isNativePlatform()) {
    import('@capacitor/status-bar')
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: isLight ? Style.Light : Style.Dark }))
      .catch(() => {});
  }
}


// ─── Accent colour ──────────────────────────────────────────
// The six palettes below already existed as *per-chat* themes (ChatView's
// CHAT_THEMES). They were unreachable anywhere else, so the feed, profiles,
// notifications and every button in the app were locked to emerald whatever
// someone chose for a conversation.
//
// Applied by overwriting the accent custom properties on :root. Everything in
// the product reads those variables rather than a literal, so this recolours
// the whole app without touching a component — which is also why it must set
// every one of them: leaving the glow variables behind would give a green halo
// around a purple button.

export const ACCENTS = [
  { name: 'emerald', label: 'Emerald', hex: '#10b981', hover: '#34d399', dim: '#059669' },
  { name: 'ocean',   label: 'Ocean',   hex: '#0ea5e9', hover: '#38bdf8', dim: '#0284c7' },
  { name: 'sunset',  label: 'Sunset',  hex: '#f97316', hover: '#fb923c', dim: '#ea580c' },
  { name: 'orchid',  label: 'Orchid',  hex: '#a855f7', hover: '#c084fc', dim: '#9333ea' },
  { name: 'rose',    label: 'Rose',    hex: '#f43f5e', hover: '#fb7185', dim: '#e11d48' },
  { name: 'slate',   label: 'Slate',   hex: '#64748b', hover: '#94a3b8', dim: '#475569' },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function applyAccent(name) {
  const accent = ACCENTS.find((a) => a.name === name) ?? ACCENTS[0];
  const root = document.documentElement;
  const [r, g, b] = hexToRgb(accent.hex);

  root.style.setProperty('--color-vault-accent', accent.hex);
  root.style.setProperty('--color-vault-accent-hover', accent.hover);
  root.style.setProperty('--color-vault-accent-dim', accent.dim);
  // Derived rather than hardcoded per palette, so adding a seventh accent
  // means adding one row above and nothing else.
  root.style.setProperty('--color-vault-accent-glow', `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.style.setProperty('--color-vault-accent-glow-strong', `rgba(${r}, ${g}, ${b}, 0.25)`);
}

/** Reads the stored choice. Safe to call before the DOM exists. */
export function storedAccent() {
  try {
    return localStorage.getItem('vault_accent') || 'emerald';
  } catch {
    return 'emerald';
  }
}
