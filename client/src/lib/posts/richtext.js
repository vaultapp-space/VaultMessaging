// ============================================================
// Vault — Post rich text
// ============================================================
// Turns a post body into a token array. It never produces HTML, and nothing
// in the feed renders a post through `{@html}`.
//
// That is the whole design, and it is deliberate rather than incidental.
// MessageBubble renders chat text by escaping `& < > " '` by hand and then
// splicing markup into the string — safe today, and reviewed, but the author
// of a chat message is someone you chose to talk to. A post is written by a
// stranger and shown to everyone, so the same class of bug stops being "one
// peer can attack me" and becomes "one account attacks everyone who scrolls".
//
// The realistic failure was never a clever payload; it was a future developer
// copying parseMarkdown into a post component, hitting
// `svelte/no-at-html-tags`, and adding the file to the eslint exemption list.
// Returning tokens removes that path entirely: PostCard renders each token as
// a real Svelte element, Svelte escapes text and attribute values itself, and
// there is no escaper here to get wrong and no exemption to widen.
//
// Deliberately narrower than chat markdown: links and @mentions only. Bold,
// italics and code fences all exist in chat because a conversation benefits
// from them. A public feed benefits from being hard to make look like the UI.

// Trailing punctuation is common at the end of a sentence containing a URL and
// is almost never part of the link, so it is trimmed back onto the text token.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

// Matches the username rule enforced at registration (auth.routes.js), so a
// mention can never tokenise something that is not a possible account.
const MENTION = /@([a-zA-Z0-9_]{3,32})/g;
const URL_LIKE = /https?:\/\/[^\s<]+/g;

/**
 * @typedef {{t: 'text', v: string}
 *         | {t: 'link', href: string, v: string}
 *         | {t: 'mention', username: string, v: string}} Token
 */

/**
 * @param {string} body
 * @returns {Token[]}
 */
export function tokenize(body) {
  if (!body) return [];

  /** @type {Array<{start: number, end: number, token: Token}>} */
  const matches = [];

  for (const match of body.matchAll(URL_LIKE)) {
    let raw = match[0];
    const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
    // Only trim if something is left that still looks like a URL.
    if (trimmed.length > 'https://'.length) raw = trimmed;

    // Belt and braces. The regex already requires an http(s) scheme, but the
    // href is the one value that becomes a navigable target, so it is parsed
    // and re-checked rather than trusted. A URL that does not parse is left as
    // plain text rather than being guessed at.
    let href = null;
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
    } catch {
      href = null;
    }
    if (!href) continue;

    matches.push({
      start: match.index,
      end: match.index + raw.length,
      token: { t: 'link', href, v: raw },
    });
  }

  for (const match of body.matchAll(MENTION)) {
    const start = match.index;
    // A mention inside a URL is part of the URL, not a mention.
    if (matches.some((m) => start >= m.start && start < m.end)) continue;
    matches.push({
      start,
      end: start + match[0].length,
      token: { t: 'mention', username: match[1], v: match[0] },
    });
  }

  matches.sort((a, b) => a.start - b.start);

  /** @type {Token[]} */
  const tokens = [];
  let cursor = 0;
  for (const { start, end, token } of matches) {
    if (start < cursor) continue; // overlapping match, already consumed
    if (start > cursor) tokens.push({ t: 'text', v: body.slice(cursor, start) });
    tokens.push(token);
    cursor = end;
  }
  if (cursor < body.length) tokens.push({ t: 'text', v: body.slice(cursor) });

  return tokens;
}
