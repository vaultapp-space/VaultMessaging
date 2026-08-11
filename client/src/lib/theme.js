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
