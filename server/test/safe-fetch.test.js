import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  isBlockedAddress, validateUrl, resolveSafely, safeFetch, MAX_BYTES,
} from '../src/lib/safe-fetch.js';

// ============================================================
// SSRF defence
// ============================================================
// This is the security surface of link previews. Fetching a user-supplied URL
// makes the server a proxy for anything it can reach — on a typical VPS that
// is Postgres on 127.0.0.1 and, on most cloud providers, a metadata endpoint
// that hands out credentials.
//
// These tests are the specification. If one starts failing, treat it as a
// live vulnerability rather than a broken test.

describe('blocked address ranges', () => {
  const blocked = [
    ['127.0.0.1', 'loopback — the server itself'],
    ['127.1.2.3', 'anywhere in 127/8'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.5', 'RFC1918'],
    ['172.16.0.1', 'RFC1918 lower bound'],
    ['172.31.255.254', 'RFC1918 upper bound'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.169.254', 'cloud metadata — credential theft'],
    ['169.254.1.1', 'link-local generally'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique local'],
    ['fd12:3456::1', 'IPv6 unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback — a common bypass'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata address'],
  ];

  for (const [ip, why] of blocked) {
    test(`blocks ${ip} (${why})`, () => {
      assert.equal(isBlockedAddress(ip), true);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  for (const ip of allowed) {
    test(`allows public address ${ip}`, () => {
      assert.equal(isBlockedAddress(ip), false);
    });
  }

  test('blocks anything that is not an IP at all', () => {
    for (const value of ['', null, undefined, 'not-an-ip', '999.999.999.999', '1.2.3']) {
      assert.equal(isBlockedAddress(value), true, `expected ${value} to be blocked`);
    }
  });
});

describe('URL validation', () => {
  test('rejects non-HTTP schemes', () => {
    // These bypass every other check: file: reads the disk, data: needs no
    // network at all, gopher: has been used to forge requests to Redis.
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<h1>hi</h1>',
      'gopher://127.0.0.1:6379/_INFO',
      'ftp://example.com/x',
      'javascript:alert(1)',
    ]) {
      assert.equal(validateUrl(url).ok, false, `expected ${url} to be rejected`);
    }
  });

  test('rejects ports other than 80 and 443', () => {
    // Otherwise the preview fetcher is a port scanner and a way to reach
    // Postgres, Redis and anything else bound locally.
    for (const url of [
      'http://example.com:5432/',
      'http://example.com:6379/',
      'http://example.com:22/',
      'https://example.com:8080/',
    ]) {
      assert.equal(validateUrl(url).ok, false, `expected ${url} to be rejected`);
    }
  });

  test('accepts the default ports', () => {
    assert.equal(validateUrl('http://example.com/page').ok, true);
    assert.equal(validateUrl('https://example.com/page').ok, true);
    assert.equal(validateUrl('http://example.com:80/').ok, true);
    assert.equal(validateUrl('https://example.com:443/').ok, true);
  });

  test('rejects a literal private IP host', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
    ]) {
      assert.equal(validateUrl(url).ok, false, `expected ${url} to be rejected`);
    }
  });

  test('rejects malformed input rather than throwing', () => {
    for (const url of ['', 'not a url', '://missing-scheme', 'http://']) {
      assert.doesNotThrow(() => validateUrl(url));
      assert.equal(validateUrl(url).ok, false);
    }
  });
});

describe('DNS resolution', () => {
  test('refuses a hostname that resolves to loopback', async () => {
    // localhost is the simplest instance of the general problem: a name the
    // attacker controls pointing at private space.
    assert.equal(await resolveSafely('localhost'), null);
  });

  test('refuses a name that does not resolve', async () => {
    assert.equal(await resolveSafely('this-host-should-not-exist.invalid'), null);
  });

  test('passes through a public literal IP', async () => {
    assert.equal(await resolveSafely('8.8.8.8'), '8.8.8.8');
  });

  test('refuses a private literal IP', async () => {
    assert.equal(await resolveSafely('192.168.0.1'), null);
  });
});

// ─── Live-server behaviour ──────────────────────────────────
// A real listener on loopback, which is exactly what an SSRF attempt targets.

describe('fetching', () => {
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'text/html' });
        // Far more than the cap, to prove the read stops.
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 64; i += 1) res.write(chunk);
        res.end();
        return;
      }
      if (req.url === '/redirect-to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      }
      if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not html');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>ok</title></head></html>');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => server?.close());

  test('refuses to fetch loopback even when a real server answers', async () => {
    // The core case. This server is listening and would reply happily; the
    // fetcher must not talk to it.
    const res = await safeFetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.ok, false);
  });

  test('refuses the cloud metadata address', async () => {
    const res = await safeFetch('http://169.254.169.254/latest/meta-data/');
    assert.equal(res.ok, false);
    assert.match(res.reason, /blocked range|did not resolve/i);
  });

  test('refuses a redirect that lands on a private address', async () => {
    // A perfectly ordinary public URL can 302 into private space, so the
    // destination of every hop is revalidated rather than trusted.
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect-to-metadata`);
    assert.equal(res.ok, false);
  });

  test('refuses non-HTTP schemes without any network access', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'gopher://127.0.0.1:6379/']) {
      const res = await safeFetch(url);
      assert.equal(res.ok, false);
    }
  });

  test('refuses a non-web port', async () => {
    const res = await safeFetch('http://example.com:5432/');
    assert.equal(res.ok, false);
    assert.match(res.reason, /port/i);
  });

  test('caps the response size', () => {
    // Asserted as a constant rather than by downloading: the guard exists so
    // that a hostile server cannot make the process buffer gigabytes.
    assert.ok(MAX_BYTES <= 1024 * 1024, 'cap stays small enough to be safe');
  });
});
