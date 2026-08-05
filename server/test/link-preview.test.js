import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractFirstUrl, parseMetadata } from '../src/lib/link-preview.js';

describe('URL extraction', () => {
  test('finds a URL inside a sentence', () => {
    assert.equal(
      extractFirstUrl('look at https://example.com/page for details'),
      'https://example.com/page'
    );
  });

  test('strips trailing punctuation', () => {
    // "Have you seen https://example.com?" — the ? is the sentence, not the URL.
    assert.equal(extractFirstUrl('seen https://example.com?'), 'https://example.com');
    assert.equal(extractFirstUrl('(https://example.com/a)'), 'https://example.com/a');
    assert.equal(extractFirstUrl('go to https://example.com.'), 'https://example.com');
  });

  test('returns the first of several', () => {
    assert.equal(
      extractFirstUrl('https://one.example https://two.example'),
      'https://one.example'
    );
  });

  test('ignores text with no URL', () => {
    assert.equal(extractFirstUrl('just a message'), null);
    assert.equal(extractFirstUrl(''), null);
    assert.equal(extractFirstUrl(null), null);
  });

  test('ignores non-HTTP schemes', () => {
    // Guessing a scheme for "www.x.com" or accepting file:/ invites exactly
    // the input the SSRF guard exists to reject.
    assert.equal(extractFirstUrl('file:///etc/passwd'), null);
    assert.equal(extractFirstUrl('www.example.com'), null);
    assert.equal(extractFirstUrl('ftp://example.com/x'), null);
  });
});

describe('metadata parsing', () => {
  const page = (head) => `<html><head>${head}</head><body>ignored</body></html>`;

  test('reads Open Graph tags', () => {
    const meta = parseMetadata(page(`
      <meta property="og:title" content="The Title">
      <meta property="og:description" content="A description">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="https://example.com/img.png">
    `), 'https://example.com/page');

    assert.equal(meta.title, 'The Title');
    assert.equal(meta.description, 'A description');
    assert.equal(meta.siteName, 'Example');
    assert.equal(meta.imageUrl, 'https://example.com/img.png');
  });

  test('falls back to twitter tags then <title>', () => {
    const twitter = parseMetadata(
      page('<meta name="twitter:title" content="Twitter Title">'),
      'https://example.com/'
    );
    assert.equal(twitter.title, 'Twitter Title');

    const plain = parseMetadata(page('<title>Plain Title</title>'), 'https://example.com/');
    assert.equal(plain.title, 'Plain Title');
  });

  test('handles either attribute order and both quote styles', () => {
    const reversed = parseMetadata(
      page(`<meta content='Reversed' property='og:title'>`),
      'https://example.com/'
    );
    assert.equal(reversed.title, 'Reversed');
  });

  test('resolves a relative image against the final URL', () => {
    const meta = parseMetadata(
      page('<title>t</title><meta property="og:image" content="/img/hero.png">'),
      'https://example.com/articles/one'
    );
    assert.equal(meta.imageUrl, 'https://example.com/img/hero.png');
  });

  test('drops an image with a non-HTTP scheme', () => {
    // An attacker-supplied javascript: or data: image URL must never reach a
    // client that might put it in a src attribute.
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///etc/passwd']) {
      const meta = parseMetadata(
        page(`<title>t</title><meta property="og:image" content="${bad}">`),
        'https://example.com/'
      );
      assert.equal(meta.imageUrl, null, `expected ${bad} to be dropped`);
    }
  });

  test('decodes HTML entities', () => {
    const meta = parseMetadata(
      page('<meta property="og:title" content="Tom &amp; Jerry &quot;quoted&quot;">'),
      'https://example.com/'
    );
    assert.equal(meta.title, 'Tom & Jerry "quoted"');
  });

  test('truncates absurdly long values', () => {
    const long = 'x'.repeat(5000);
    const meta = parseMetadata(
      page(`<meta property="og:title" content="${long}">`),
      'https://example.com/'
    );
    assert.ok(meta.title.length <= 200, `expected truncation, got ${meta.title.length}`);
  });

  test('returns null when there is no usable title', () => {
    assert.equal(parseMetadata(page(''), 'https://example.com/'), null);
    assert.equal(parseMetadata('', 'https://example.com/'), null);
    assert.equal(parseMetadata(null, 'https://example.com/'), null);
  });

  test('does not execute or trust script content', () => {
    // The parser only reads. Whatever comes back is text, and stays text.
    const meta = parseMetadata(
      page('<title>Safe</title><script>window.x=1</script>'),
      'https://example.com/'
    );
    assert.equal(meta.title, 'Safe');
  });

  test('keeps markup in a title as literal text', () => {
    // Clients must render this as text; it is attacker-controlled.
    const meta = parseMetadata(
      page('<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">'),
      'https://example.com/'
    );
    assert.equal(meta.title, '<img src=x onerror=alert(1)>');
    assert.ok(!meta.title.includes('&lt;'), 'entities were decoded, not re-escaped');
  });

  test('never throws on malformed HTML', () => {
    for (const html of ['<html', '<meta property=', '<<<>>>', '<head><title>']) {
      assert.doesNotThrow(() => parseMetadata(html, 'https://example.com/'));
    }
  });
});
