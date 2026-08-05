// ============================================================
// Vault — SSRF-hardened fetch
// ============================================================
// Fetching a URL supplied by a user turns this server into a proxy that can
// reach anything the server can reach. On a normal VPS that includes
// 127.0.0.1 (Postgres, Redis, the app's own admin surface) and, on most cloud
// providers, a link-local metadata endpoint that hands out credentials.
//
// Everything below exists because of that. The defences, and what each stops:
//
//   scheme allowlist       data:, file:, gopher:, ftp: — non-HTTP protocols
//                          that bypass the rest of these checks entirely
//   port allowlist         http://127.0.0.1:5432 — reaching internal services
//                          on non-web ports
//   DNS resolution + IP    http://internal.corp/ and hostnames that resolve
//   range check            to private space
//   connect to pinned IP   DNS rebinding: a name that resolves to a public IP
//                          when validated and a private one microseconds
//                          later, when the HTTP client resolves it again
//   redirect cap + revalidation   a public URL that 302s to 169.254.169.254
//   response size cap      a multi-gigabyte body exhausting memory
//   hard timeout           a server that accepts and never responds
//
// The pinned-IP connect is the one most implementations miss. Validating the
// hostname and then handing the *hostname* to fetch() re-resolves it, so an
// attacker controlling DNS can answer differently the second time. We resolve
// once, check that address, and then connect to that exact address.

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 512 * 1024;      // enough for <head>, far short of a payload
export const TIMEOUT_MS = 5000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set([80, 443]);

/**
 * True if an IP address must never be fetched.
 *
 * Covers loopback, RFC1918 private space, link-local (including the cloud
 * metadata address), carrier-grade NAT, and the IPv6 equivalents — plus
 * IPv4-mapped IPv6 (::ffff:127.0.0.1), which is a common bypass.
 */
export function isBlockedAddress(ip) {
  if (!ip) return true;

  const version = net.isIP(ip);
  if (version === 0) return true;

  if (version === 6) {
    const lower = ip.toLowerCase();

    // IPv4-mapped and IPv4-compatible forms: unwrap and check as IPv4, or a
    // blocked v4 address sails through dressed as v6.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);

    if (lower === '::' || lower === '::1') return true;       // unspecified, loopback
    if (lower.startsWith('fe80')) return true;                // link-local
    if (/^f[cd]/.test(lower)) return true;                    // unique local (fc00::/7)
    if (lower.startsWith('::ffff:')) return true;             // any other mapped form
    return false;
  }

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a >= 224) return true;                       // multicast, reserved, broadcast

  return false;
}

/**
 * WHATWG URL keeps the brackets on an IPv6 host, so `hostname` is "[::1]"
 * rather than "::1" — and net.isIP() rejects the bracketed form, which meant
 * a literal IPv6 address skipped the IP check entirely.
 */
export function bareHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** Validates a URL's shape before any network access happens. */
export function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    return { ok: false, reason: `port ${port} is not allowed` };
  }

  // A literal IP host is checked here; hostnames are checked after
  // resolution. Both forms go through bareHostname first.
  const host = bareHostname(url.hostname);
  if (net.isIP(host) && isBlockedAddress(host)) {
    return { ok: false, reason: 'address is in a blocked range' };
  }

  return { ok: true, url, port, host };
}

/** Resolves a hostname and returns the first address that is safe to contact. */
export async function resolveSafely(rawHostname) {
  const hostname = bareHostname(rawHostname);

  if (net.isIP(hostname)) {
    return isBlockedAddress(hostname) ? null : hostname;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return null;
  }

  // Every answer must be acceptable. Picking the first safe one from a mixed
  // set would let an attacker pair a public address with a private one and
  // rely on ordering.
  if (records.length === 0) return null;
  for (const record of records) {
    if (isBlockedAddress(record.address)) return null;
  }

  return records[0].address;
}

/**
 * Fetches a URL with every guard above applied, following redirects manually
 * so each hop is revalidated.
 *
 * Returns { ok, status, contentType, body, finalUrl } or { ok: false, reason }.
 */
export async function safeFetch(rawUrl, { redirectsLeft = MAX_REDIRECTS } = {}) {
  const validated = validateUrl(rawUrl);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const { url, port, host } = validated;
  const address = await resolveSafely(host);
  if (!address) return { ok: false, reason: 'host did not resolve to a public address' };

  const transport = url.protocol === 'https:' ? https : http;

  const response = await new Promise((resolve) => {
    const request = transport.request(
      {
        // Connect to the address we validated, not the hostname — re-resolving
        // is exactly the window a DNS-rebinding attack needs.
        host: address,
        port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          // The real hostname still has to travel in Host, or virtual hosts
          // and TLS SNI break.
          Host: url.host,
          'User-Agent': 'VaultBot/1.0 (+link preview)',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
        },
        servername: host,
        timeout: TIMEOUT_MS,
        // Certificates are still verified against the real hostname.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let aborted = false;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            // Stop reading rather than buffering an unbounded body. What we
            // have is enough: <head> comes first.
            aborted = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated: aborted,
        }));

        res.on('close', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated: aborted,
        }));
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end();
  });

  if (!response) return { ok: false, reason: 'request failed or timed out' };

  // Redirects are followed by hand so each destination goes through the full
  // validation again. Handing `redirect: 'follow'` to a client would let the
  // second hop reach anything.
  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    if (redirectsLeft <= 0) return { ok: false, reason: 'too many redirects' };
    const next = new URL(response.headers.location, url).toString();
    return safeFetch(next, { redirectsLeft: redirectsLeft - 1 });
  }

  if (response.status !== 200) {
    return { ok: false, reason: `unexpected status ${response.status}` };
  }

  const contentType = response.headers['content-type'] || '';
  if (!contentType.includes('html')) {
    return { ok: false, reason: 'not an HTML document' };
  }

  return {
    ok: true,
    status: response.status,
    contentType,
    body: response.body,
    finalUrl: url.toString(),
  };
}
