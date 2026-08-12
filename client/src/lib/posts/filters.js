// ============================================================
// Vault — client-side keyword filters
// ============================================================
// Words a user does not want to see in the feed. Stored in localStorage and
// applied in the browser; the server is never told.
//
// That is the whole point, and it is a deliberate asymmetry with mutes. A mute
// is server-side because a client-side one still ships the content over the
// wire, which makes "I don't want to see this" cosmetic. A keyword list is the
// opposite: it is a plaintext record of what a named person finds upsetting —
// the most sensitive thing this product could choose to hold — and the cost of
// keeping it local is only that the content arrives and is discarded.
//
// It does not sync across devices. The app already works this way for key
// material (stores/session.js is "backed by NOTHING"), so this is consistent
// rather than a gap. If syncing is ever wanted, the home is the
// client-encrypted vault, not a new table.

const STORAGE_KEY = 'vault_feed_filters';
const MAX_FILTERS = 100;
const MAX_LENGTH = 40;

/** @returns {string[]} lower-cased, deduplicated */
export function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w) => typeof w === 'string')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_FILTERS);
  } catch {
    // A corrupt or unreadable list must not take the feed down with it.
    return [];
  }
}

export function saveFilters(words) {
  const clean = [...new Set(
    words.map((w) => w.trim().toLowerCase()).filter(Boolean)
  )].slice(0, MAX_FILTERS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function addFilter(word) {
  const trimmed = word.trim().toLowerCase().slice(0, MAX_LENGTH);
  if (!trimmed) return loadFilters();
  return saveFilters([...loadFilters(), trimmed]);
}

export function removeFilter(word) {
  const target = word.trim().toLowerCase();
  return saveFilters(loadFilters().filter((w) => w !== target));
}

/**
 * Whether a post should be hidden.
 *
 * Matches on word boundaries rather than as a substring: a filter for "art"
 * that also hides "start" and "particle" is the classic way these become
 * useless and get switched off. Punctuation counts as a boundary so "spoiler!"
 * still matches a "spoiler" filter.
 *
 * @param {{body?: string|null, username?: string}} post
 * @param {string[]} filters
 */
export function isFiltered(post, filters) {
  if (!filters?.length) return false;
  const body = (post?.body ?? '').toLowerCase();
  if (!body) return false;

  return filters.some((word) => {
    if (!word) return false;
    // A multi-word filter is matched as a phrase; boundaries still apply at
    // each end so "the cat" does not match "breathe cattle".
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(body);
  });
}

/**
 * Applies the whole list to a page of posts.
 * Kept separate from isFiltered so the caller can show a "N hidden" count
 * rather than silently shrinking the feed — a filter that hides things without
 * saying so reads as content failing to load.
 */
export function partitionFiltered(posts, filters) {
  if (!filters?.length) return { visible: posts, hiddenCount: 0 };
  const visible = posts.filter((p) => !isFiltered(p, filters));
  return { visible, hiddenCount: posts.length - visible.length };
}
