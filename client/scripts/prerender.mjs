// ============================================================
// Prerender the landing page into dist/index.html
// ============================================================
// Runs after `vite build`, as part of `npm run build`, so a production deploy
// cannot ship a client that skipped this step.
//
// The problem it solves: Vault's landing page is client-rendered, so the HTML
// a crawler receives is <div id="app"></div> and nothing else. Googlebot
// executes JavaScript and sees the real page. Most AI crawlers do not, and
// robots.txt invites them by name — which, without this, hands them a blank
// document and a JSON-LD block as the only description of the product.
//
// What it does NOT do is hydrate. Svelte 5's hydrate() needs the server render
// and the client mount to be the same component tree, and they are not here:
// the server renders Landing alone, while the browser mounts App (routing,
// auth, websocket, crypto). So the prerendered markup is a throwaway shell —
// visible, styled, and inert — that main.js removes once the real app is ready.
//
// Failing loudly is deliberate. A prerender that silently no-ops leaves the
// page looking fine in a browser while quietly reverting the entire reason
// this file exists, and nobody would notice for months.

import { build } from 'vite';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SSR_DIR = resolve(root, 'dist-ssr');
const INDEX = resolve(root, 'dist/index.html');

// A landing page that renders to less than this is a broken render, not a
// short page — the real output is ~31 KB. Without the floor, a component that
// throws early would inject an empty string and pass.
const MIN_BODY_BYTES = 8000;

console.log('==> Prerendering the landing page');

await build({
  root,
  logLevel: 'warn',
  build: {
    ssr: resolve(root, 'src/prerender-entry.js'),
    outDir: SSR_DIR,
    emptyOutDir: true,
    // The SSR bundle is a build artefact consumed seconds from now and then
    // deleted; minifying it costs time and buys nothing.
    minify: false,
  },
});

const { renderLanding } = await import(resolve(SSR_DIR, 'prerender-entry.js'));
const { body } = renderLanding();

if (!body || body.length < MIN_BODY_BYTES) {
  throw new Error(
    `Prerender produced ${body?.length ?? 0} bytes, expected at least ${MIN_BODY_BYTES}. ` +
      'Refusing to inject a broken shell.'
  );
}

const html = await readFile(INDEX, 'utf8');
const TARGET = '<div id="app"></div>';
if (!html.includes(TARGET)) {
  throw new Error(`Could not find ${TARGET} in dist/index.html — the mount point moved.`);
}

// Before #app, not inside it. Svelte 5's mount() appends to its target rather
// than replacing the target's contents, so markup left inside #app would sit
// there underneath the mounted app forever: a duplicate <h1> and a second copy
// of every heading, which is both an accessibility problem and exactly the
// kind of duplication that makes a page look spammy.
const shell = `<div id="prerender" aria-hidden="false">${body}</div>\n    `;
await writeFile(INDEX, html.replace(TARGET, shell + TARGET), 'utf8');

await rm(SSR_DIR, { recursive: true, force: true });

console.log(`==> Prerendered ${body.length} bytes into dist/index.html`);
