import { describe, test, expect, beforeEach } from 'vitest';

import {
  loadFilters, saveFilters, addFilter, removeFilter, isFiltered, partitionFiltered,
} from '../src/lib/posts/filters.js';

// A tiny localStorage stand-in. The module deliberately talks to localStorage
// directly rather than taking an injected store, because the whole point is
// that the list never leaves the device — an abstraction seam here would be
// the obvious place for someone to later hang a sync call.
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
});

const post = (body) => ({ body, username: 'someone' });

describe('storage', () => {
  test('starts empty and round-trips', () => {
    expect(loadFilters()).toEqual([]);
    saveFilters(['Spoilers', 'politics']);
    expect(loadFilters()).toEqual(['spoilers', 'politics']);
  });

  test('normalises case and whitespace, and deduplicates', () => {
    saveFilters(['  Spoilers ', 'SPOILERS', 'spoilers']);
    expect(loadFilters()).toEqual(['spoilers']);
  });

  test('add and remove work on the stored list', () => {
    addFilter('politics');
    addFilter('spoilers');
    expect(loadFilters()).toHaveLength(2);
    removeFilter('POLITICS');
    expect(loadFilters()).toEqual(['spoilers']);
  });

  test('a corrupt list does not take the feed down', () => {
    // Whatever is in localStorage came from a previous version, another tab,
    // or a user poking at devtools. An exception here would break rendering.
    localStorage.setItem('vault_feed_filters', 'not json at all');
    expect(loadFilters()).toEqual([]);
    localStorage.setItem('vault_feed_filters', '{"not":"an array"}');
    expect(loadFilters()).toEqual([]);
  });

  test('empty entries are dropped rather than hiding everything', () => {
    // A filter of "" would match every post if it reached isFiltered.
    saveFilters(['', '   ', 'real']);
    expect(loadFilters()).toEqual(['real']);
  });
});

describe('matching', () => {
  test('matches a whole word', () => {
    expect(isFiltered(post('contains politics here'), ['politics'])).toBe(true);
  });

  test('does not match inside a longer word', () => {
    // The classic reason people switch these off: a filter for "art" that also
    // hides "start" and "particle".
    expect(isFiltered(post('I will start now'), ['art'])).toBe(false);
    expect(isFiltered(post('a particle of dust'), ['art'])).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isFiltered(post('POLITICS again'), ['politics'])).toBe(true);
  });

  test('punctuation counts as a word boundary', () => {
    expect(isFiltered(post('spoilers!'), ['spoilers'])).toBe(true);
    expect(isFiltered(post('(spoilers)'), ['spoilers'])).toBe(true);
    expect(isFiltered(post('re: spoilers, sorry'), ['spoilers'])).toBe(true);
  });

  test('a multi-word filter matches as a phrase', () => {
    expect(isFiltered(post('the season finale leaked'), ['season finale'])).toBe(true);
    expect(isFiltered(post('season three finale'), ['season finale'])).toBe(false);
  });

  test('regex metacharacters in a filter are literal', () => {
    // Otherwise a filter of "." hides the entire feed.
    expect(isFiltered(post('anything at all'), ['.'])).toBe(false);
    expect(isFiltered(post('c++ is fine'), ['c++'])).toBe(true);
  });

  test('an empty filter list hides nothing', () => {
    expect(isFiltered(post('anything'), [])).toBe(false);
    expect(isFiltered(post('anything'), null)).toBe(false);
  });

  test('a post with no body is never filtered', () => {
    // An image-only post has nothing to match against; hiding it would be
    // filtering on absence.
    expect(isFiltered({ body: null }, ['politics'])).toBe(false);
  });
});

describe('partitioning', () => {
  test('reports how many were hidden rather than silently shrinking', () => {
    // A feed that quietly gets shorter reads as content failing to load.
    const posts = [post('about politics'), post('about cats'), post('more politics')];
    const { visible, hiddenCount } = partitionFiltered(posts, ['politics']);
    expect(visible).toHaveLength(1);
    expect(hiddenCount).toBe(2);
  });

  test('with no filters everything passes through untouched', () => {
    const posts = [post('a'), post('b')];
    expect(partitionFiltered(posts, []).visible).toBe(posts);
  });
});
