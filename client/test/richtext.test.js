import { describe, test, expect } from 'vitest';

import { tokenize } from '../src/lib/posts/richtext.js';

// The tokenizer is the safety boundary for public content. It emits tokens,
// never markup — so the tests that matter most are the ones proving that
// hostile input comes back as inert *text*, with no element or attribute for
// it to escape into.

const text = (tokens) => tokens.filter((t) => t.t === 'text').map((t) => t.v).join('');
const kinds = (tokens) => tokens.map((t) => t.t);

describe('plain text', () => {
  test('an ordinary sentence is one text token', () => {
    expect(tokenize('just a thought')).toEqual([{ t: 'text', v: 'just a thought' }]);
  });

  test('empty input produces no tokens', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe('hostile input stays text', () => {
  // None of these can become markup, because the tokenizer never emits
  // markup. They are here so that stays true if anyone changes it.
  test('a script tag survives as literal characters', () => {
    const tokens = tokenize('<script>alert(1)</script>');
    expect(kinds(tokens)).toEqual(['text']);
    expect(text(tokens)).toBe('<script>alert(1)</script>');
  });

  test('an img onerror payload survives as literal characters', () => {
    const body = '<img src=x onerror="alert(1)">';
    expect(text(tokenize(body))).toBe(body);
    expect(tokenize(body).every((t) => t.t === 'text')).toBe(true);
  });

  test('quote-breaking characters are not special', () => {
    const body = `" onmouseover='alert(1)' data-x="`;
    expect(text(tokenize(body))).toBe(body);
  });

  test('a javascript: URL never becomes a link', () => {
    const tokens = tokenize('tap here javascript:alert(1)');
    expect(tokens.some((t) => t.t === 'link')).toBe(false);
    expect(text(tokens)).toContain('javascript:alert(1)');
  });

  test('a data: URL never becomes a link', () => {
    const tokens = tokenize('data:text/html;base64,PHNjcmlwdD4=');
    expect(tokens.some((t) => t.t === 'link')).toBe(false);
  });

  test('an http URL carrying a quote does not break out of an attribute', () => {
    // Even though the href is bound by Svelte rather than interpolated, the
    // parsed href must not contain a raw quote.
    const tokens = tokenize('https://example.com/"onload="alert(1)');
    const link = tokens.find((t) => t.t === 'link');
    if (link) expect(link.href).not.toContain('"');
  });
});

describe('links', () => {
  test('a bare URL becomes a link token', () => {
    const tokens = tokenize('see https://vaultapp.space for more');
    expect(kinds(tokens)).toEqual(['text', 'link', 'text']);
    expect(tokens[1].href).toBe('https://vaultapp.space/');
  });

  test('trailing sentence punctuation is not part of the link', () => {
    const tokens = tokenize('read https://vaultapp.space.');
    const link = tokens.find((t) => t.t === 'link');
    expect(link.v).toBe('https://vaultapp.space');
    expect(text(tokens)).toContain('.');
  });

  test('two links in one post are both found', () => {
    const tokens = tokenize('https://a.example and https://b.example');
    expect(tokens.filter((t) => t.t === 'link')).toHaveLength(2);
  });
});

describe('mentions', () => {
  test('an @username becomes a mention token', () => {
    const tokens = tokenize('hello @alice');
    expect(kinds(tokens)).toEqual(['text', 'mention']);
    expect(tokens[1].username).toBe('alice');
  });

  test('a mention matches the username rule, not any @ text', () => {
    // Too short to be a real account, so it stays text rather than becoming a
    // link to a profile that cannot exist.
    expect(tokenize('email me @ ab').every((t) => t.t === 'text')).toBe(true);
  });

  test('an @ inside a URL is part of the URL, not a mention', () => {
    const tokens = tokenize('https://example.com/@alice/posts');
    expect(tokens.some((t) => t.t === 'mention')).toBe(false);
    expect(tokens.filter((t) => t.t === 'link')).toHaveLength(1);
  });

  test('punctuation ends a mention', () => {
    const tokens = tokenize('thanks @alice!');
    expect(tokens.find((t) => t.t === 'mention').username).toBe('alice');
    expect(text(tokens)).toContain('!');
  });
});

describe('round trip', () => {
  test('concatenating every token value reproduces the input exactly', () => {
    // The property that guarantees nothing is silently dropped or duplicated —
    // a renderer showing text the author did not write, or losing text they
    // did, is a correctness bug even when it is not a security one.
    const bodies = [
      'plain',
      'see https://vaultapp.space now',
      '@alice @bob hello',
      'mixed @alice https://a.example end.',
      '<script>@alice</script> https://b.example',
      '   leading and trailing   ',
    ];
    for (const body of bodies) {
      expect(tokenize(body).map((t) => t.v).join('')).toBe(body);
    }
  });
});
