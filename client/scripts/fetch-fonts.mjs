// Downloads the Google Fonts CSS, keeps only the latin + latin-ext subsets,
// pulls each woff2 into client/public/fonts/, and emits a local stylesheet.
//
// Google now serves *variable* fonts: every weight of a given family+subset
// resolves to one and the same woff2. So this groups by URL and emits a
// single @font-face per file carrying the whole weight range, rather than
// one @font-face per weight all pointing at the same download.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = process.argv[2];
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap';
// Chrome UA so Google serves woff2 rather than the ttf fallback.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const KEEP = new Set(['latin', 'latin-ext']);

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

// Each @font-face is preceded by a /* subset */ comment naming its subset.
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
if (!blocks.length) throw new Error('no @font-face blocks parsed');

/** @type {Map<string, {family: string, subset: string, range: string, weights: number[]}>} */
const byUrl = new Map();

for (const [, subset, face] of blocks) {
  if (!KEEP.has(subset)) continue;

  const family = /font-family:\s*'([^']+)'/.exec(face)[1];
  const weight = Number(/font-weight:\s*(\d+)/.exec(face)[1]);
  const range = /unicode-range:\s*([^;]+);/.exec(face)[1].trim();
  const url = /url\((https:\/\/[^)]+\.woff2)\)/.exec(face)[1];

  const entry = byUrl.get(url) ?? { family, subset, range, weights: [] };
  entry.weights.push(weight);
  byUrl.set(url, entry);
}

const out = [];
let total = 0;

for (const [url, { family, subset, range, weights }] of byUrl) {
  const file = `${family.toLowerCase().replace(/\s+/g, '-')}-${subset}.woff2`;
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  await writeFile(join(OUT_DIR, file), bytes);
  total += bytes.length;

  const lo = Math.min(...weights);
  const hi = Math.max(...weights);
  console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KiB  (weights ${lo}-${hi})`);

  out.push(
    `/* ${family} — ${subset} */\n` +
      `@font-face {\n` +
      `  font-family: '${family}';\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${lo} ${hi};\n` +
      `  font-display: swap;\n` +
      `  src: url('/fonts/${file}') format('woff2');\n` +
      `  unicode-range: ${range};\n` +
      `}`
  );
}

const header =
  `/* Self-hosted Inter + JetBrains Mono — generated, do not hand-edit.\n` +
  `   Regenerate with scripts/fetch-fonts.mjs. Variable fonts: one file per\n` +
  `   family+subset covers the whole weight range the UI uses. Only the latin\n` +
  `   and latin-ext subsets are bundled; other scripts fall back to the system\n` +
  `   stack in --font-sans / --font-mono. */\n\n`;

await writeFile(join(OUT_DIR, 'fonts.css'), header + out.join('\n\n') + '\n');
console.log(`\n${byUrl.size} files, ${(total / 1024).toFixed(1)} KiB total`);
