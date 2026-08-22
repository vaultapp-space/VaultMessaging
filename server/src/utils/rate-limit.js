// ============================================================
// Vault — per-account rate limiting
// ============================================================
// @fastify/rate-limit keys on `request.ip` by default, which is the wrong
// bucket for anything an *account* does. IP keying fails in both directions:
// one spammer rotating addresses is under-limited, while a university or
// carrier NAT puts a whole campus in one bucket — on a public feed that is a
// visible failure, where the second person to post gets a 429 they did
// nothing to earn.
//
// Keying on `request.user.id` does not work under the plugin's default
// `onRequest` hook: that runs before the `preValidation` that authenticates,
// so `request.user` is always undefined there and the key silently falls back
// to the IP — worse than leaving it alone, because it looks correct.
//
// The fix is per-route rather than global. `mergeParams(globalParams,
// routeOptions.config.rateLimit)` inside the plugin means a route's config
// overrides the global one, `hook` included, so a route can move its own
// limiter to `preHandler` (which runs after preValidation) without changing
// the hook for every other route in the app. The global IP-keyed limiter
// stays exactly where it is, at onRequest, and remains the backstop against
// unauthenticated flooding.
//
// One consequence worth knowing: a request that fails authentication never
// reaches preHandler, so it is not counted against a per-user bucket. That is
// correct — there is no user to charge — and the global IP limiter is what
// covers that traffic.

import config from '../config.js';

// Present only when RATE_LIMIT_DISABLED=1 outside production, where it hands
// every request its own bucket. Reused rather than re-derived so a per-route
// limiter cannot quietly re-enable limiting during an e2e run: without this,
// the keyGenerator below would override the bypass, and 30-odd specs would
// start failing on limits that have nothing to do with what they test.
const bypassKeyGenerator = config.rateLimit.keyGenerator;

/**
 * Rate limit config keyed on the authenticated account rather than the IP.
 * Only for routes behind `preValidation: [fastify.authenticate]` — on an
 * unauthenticated route there is no `request.user` and this degrades to the
 * IP keying it was meant to replace.
 */
export function perAccount({ max, timeWindow }) {
  return {
    max,
    timeWindow,
    hook: 'preHandler',
    keyGenerator: bypassKeyGenerator ?? ((request) => request.user?.id ?? request.ip),
  };
}
