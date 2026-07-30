const DARK_BG = '#09090b';
const LIGHT_BG = '#fafafa';

export function applyTheme(newTheme) {
  const isLight = newTheme === 'light';
  document.documentElement.classList.toggle('light', isLight);

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', isLight ? LIGHT_BG : DARK_BG);

  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', isLight ? 'light' : 'dark');
}
