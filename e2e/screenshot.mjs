// ============================================================
// Vault — layout screenshots
// ============================================================
// Captures a page at several viewport widths so a layout can be *looked at*
// rather than reasoned about.
//
// This exists because of a real miss: adding a seventh card to the landing
// page's feature grid left an orphan in the final row at three columns and
// again at two, and it went unnoticed through a full release. Every automated
// check passed, because nothing checks whether a grid divides evenly — that is
// not a thing an assertion catches, it is a thing you see.
//
// It lives in e2e/ because it uses the Playwright install that is already
// here, but it is deliberately *not* a spec: there is no assertion and it
// never fails a build. It is a looking glass, not a gate.
//
// Usage:
//   npx vite preview --port 4173        # in client/, or point at production
//   node e2e/screenshot.mjs                            # defaults below
//   node e2e/screenshot.mjs https://vaultapp.space
//   node e2e/screenshot.mjs https://vaultapp.space features 1280,800,480
//
// Arguments, all optional:
//   1  base URL          default https://localhost:4173
//   2  element id to scroll to, or 'top'
//   3  comma-separated widths
//
// Output lands in /tmp/vault-shots/.

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://localhost:4173';
const anchor = process.argv[3] || 'top';
const widths = (process.argv[4] || '1280,800,480').split(',').map((w) => Number(w.trim()));

const OUT = '/tmp/vault-shots';
await mkdir(OUT, { recursive: true });

// ignoreHTTPSErrors: the client dev server uses a self-signed certificate via
// @vitejs/plugin-basic-ssl, so without this every capture fails on the cert
// rather than on anything about the page.
const browser = await chromium.launch();

for (const width of widths) {
  const page = await browser.newPage({
    viewport: { width, height: 1100 },
    ignoreHTTPSErrors: true,
  });

  await page.goto(url, { waitUntil: 'load' });

  if (anchor !== 'top') {
    await page.evaluate((id) => {
      document.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' });
    }, anchor);
  }

  // The landing page reveals sections on scroll with a staggered delay of up
  // to ~360ms. Capturing sooner catches elements mid-fade and makes a correct
  // layout look broken — which is the opposite of useful here.
  await page.waitForTimeout(1400);

  const file = `${OUT}/${anchor}-${width}.png`;
  await page.screenshot({ path: file });
  console.log(file);

  await page.close();
}

await browser.close();
