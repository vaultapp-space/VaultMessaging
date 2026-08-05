// ============================================================
// Vault — Link preview extraction
// ============================================================
// Pulls Open Graph / Twitter Card metadata out of a fetched document.
//
// Deliberately regex-based rather than a DOM parser: the input is untrusted
// HTML from an arbitrary site, only <head> matters, and adding a full parser
// would mean adding a dependency that also has to be kept patched. The regexes
// only ever *read* — nothing here is re-serialised into a page.
//
// Everything extracted is truncated and HTML-unescaped, then stored as text.
// Clients must still render it as text; it is attacker-controlled content.

import { safeFetch } from './safe-fetch.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;
const MAX_SITE_NAME = 100;

// Matches the first URL in a message body. Only http/https — a bare "www."
// is not a URL and guessing a scheme for it invites mistakes.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

export function extractFirstUrl(text) {
  if (!text) return null;
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  // Trailing punctuation is almost never part of the URL when a link is
  // written inline in a sentence.
  return match[0].replace(/[.,;:!?)\]}]+$/, '');
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, '&');
}

function clean(value, limit) {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// Reads <meta property="og:title" content="..."> in either attribute order,
// with single or double quotes.
function readMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match && match[1]) return match[1];
    }
  }
  return null;
}

function readTitleTag(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1] : null;
}

/** Parses metadata out of an HTML document. Never throws. */
export function parseMetadata(html, finalUrl) {
  if (!html) return null;

  // Only <head> is of interest, and stopping there avoids scanning a large
  // body for patterns that cannot legitimately appear in it.
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd === -1 ? html.slice(0, 64 * 1024) : html.slice(0, headEnd);

  const title = clean(
    readMeta(head, ['og:title', 'twitter:title']) || readTitleTag(head),
    MAX_TITLE
  );
  const description = clean(
    readMeta(head, ['og:description', 'twitter:description', 'description']),
    MAX_DESCRIPTION
  );
  const siteName = clean(readMeta(head, ['og:site_name']), MAX_SITE_NAME);

  let imageUrl = readMeta(head, ['og:image', 'twitter:image', 'og:image:url']);
  if (imageUrl) {
    try {
      // Resolve relative image paths, and drop anything that is not http(s).
      const resolved = new URL(decodeEntities(imageUrl), finalUrl);
      imageUrl = ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
    } catch {
      imageUrl = null;
    }
  }

  // A preview with no title is not worth showing.
  if (!title) return null;

  return { title, description, siteName, imageUrl, url: finalUrl };
}

/**
 * Fetches a URL and extracts its preview metadata.
 *
 * Returns null on any failure — a preview is a nicety, and no fetch problem
 * should ever surface to the user as an error on their message.
 */
export async function fetchPreview(url) {
  const result = await safeFetch(url);
  if (!result.ok) return null;

  try {
    return parseMetadata(result.body, result.finalUrl);
  } catch {
    return null;
  }
}
