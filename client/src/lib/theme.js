import { Capacitor } from '@capacitor/core';

const DARK_BG = '#09090b';
const LIGHT_BG = '#fafafa';

// Only set while a switch is actually in flight. The colour transition in
// app.css is gated on this class rather than applied permanently for two
// reasons: it must not run on first paint (every surface would fade in from
// the wrong theme on load), and leaving it on would tint every unrelated
// hover and state change with a 220ms colour lag.
let themeSwitchTimer = null;
// Set by applyAccent; read by applyTheme so a theme switch can recompute the
// accent's light/dark variant. Null until the first applyAccent call, which is
// why the boot order in App.svelte (theme first, accent second) is safe.
let currentAccent = null;
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

  // The accent has a per-theme variant, so it has to be recomputed after the
  // class changes rather than only at boot.
  if (currentAccent) applyAccent(currentAccent);

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
// The palettes below started life as *per-chat* themes (ChatView's
// CHAT_THEMES). They were unreachable anywhere else, so the feed, profiles,
// notifications and every button in the app were locked to emerald whatever
// someone chose for a conversation.
//
// Applied by overwriting the accent custom properties on :root. Everything in
// the product reads those variables rather than a literal, so this recolours
// the whole app without touching a component — which is also why it must set
// every one of them: leaving the glow variables behind would give a green halo
// around a purple button.

// `light` is an optional darker variant used when the light theme is active.
// It exists because the app's default theme is light, and a mid-tone accent
// that reads well on #0b0c0e can be close to invisible on #fafafa — Vault Gold
// is about 2.2:1 against the light background, which is not usable for text.
// Palettes without a `light` entry fall back to their single hex, which is
// exactly what every one of them did before this field existed.
export const ACCENTS = [
  { name: 'gold',    label: 'Vault Gold', hex: '#c99a44', hover: '#dcb264', dim: '#a87f34',
    light: { hex: '#9c7530', hover: '#b3873a', dim: '#7d5d26' } },
  { name: 'emerald', label: 'Emerald', hex: '#10b981', hover: '#34d399', dim: '#059669',
    light: { hex: '#059669', hover: '#10b981', dim: '#047857' } },
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

  // Remembered so applyTheme can re-run this on a theme switch. The values it
  // writes now depend on which theme is active, so applying the accent once at
  // boot is no longer enough — without this, switching to light would leave
  // the dark variant inline on :root, overriding the light rules in app.css.
  currentAccent = accent.name;

  const variant = root.classList.contains('light') && accent.light ? accent.light : accent;
  const [r, g, b] = hexToRgb(variant.hex);

  root.style.setProperty('--color-vault-accent', variant.hex);
  root.style.setProperty('--color-vault-accent-hover', variant.hover);
  root.style.setProperty('--color-vault-accent-dim', variant.dim);
  // Derived rather than hardcoded per palette, so adding a seventh accent
  // means adding one row above and nothing else.
  root.style.setProperty('--color-vault-accent-glow', `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.style.setProperty('--color-vault-accent-glow-strong', `rgba(${r}, ${g}, ${b}, 0.25)`);
}

/** Reads the stored choice. Safe to call before the DOM exists. */
export function storedAccent() {
  try {
    return localStorage.getItem('vault_accent') || 'gold';
  } catch {
    return 'gold';
  }
}
