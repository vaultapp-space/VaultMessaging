import { Capacitor } from '@capacitor/core';

const DARK_BG = '#09090b';
const LIGHT_BG = '#fafafa';

export function applyTheme(newTheme) {
  const isLight = newTheme === 'light';
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
