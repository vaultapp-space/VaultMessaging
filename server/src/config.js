// ============================================================
// Vault Server Configuration
// All values sourced from environment; sensible defaults for dev
// ============================================================

const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',

  // Session lifetime. Bounded, not truly infinite, but long enough that
  // nobody is ever logged out just by having closed the app for a while —
  // only an explicit sign-out (their own, or another device revoking this
  // one via ActiveSessions) actually ends a session. 400 days specifically
  // because that's also the hard ceiling Chrome enforces on a cookie's own
  // Max-Age; anything longer gets silently clamped down to it by the
  // browser anyway, so this is the real achievable maximum, not an
  // arbitrary round number. Drives the JWT's own expiry, the cookie's
  // Max-Age (auth.routes.js), and the Redis session record's TTL
  // (cache/sessions.js) — all three used to independently default to 24h,
  // which meant even continuous daily use didn't save you: the JWT's
  // expiry is fixed at issuance, not a sliding window, so it lapsed
  // exactly 24h after login regardless of activity.
  sessionMaxAgeSeconds: 400 * 24 * 60 * 60,

  // JWT — same duration as sessionMaxAgeSeconds above, in the units
  // jsonwebtoken's `expiresIn` wants (a plain number of seconds is fine).
  jwtSecret: process.env.JWT_SECRET || 'vault-dev-secret-change-in-production',
  jwtExpiresIn: 400 * 24 * 60 * 60,

  // Cookie
  cookieName: process.env.NODE_ENV === 'production' ? '__Host-vault_session' : 'vault_session',
  cookieSecure: process.env.NODE_ENV === 'production',

  // Message TTL
  maxMessageTTLHours: 24,
  maxMessageTTLMs: 24 * 60 * 60 * 1000,

  // Reaper
  reaperIntervalMs: parseInt(process.env.REAPER_INTERVAL_MS || '60000', 10),

  // Rate limiting
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
    // End-to-end runs drive several registrations from one IP in quick
    // succession and would otherwise trip the per-route 5/min register limit,
    // failing for a reason that has nothing to do with what is under test.
    // Giving every request its own bucket disables limiting without editing
    // route configs. Refused outright in production: this switch would
    // otherwise remove the abuse controls on the real service.
    ...(process.env.RATE_LIMIT_DISABLED === '1' && process.env.NODE_ENV !== 'production'
      ? { keyGenerator: () => Math.random().toString(36) }
      : {}),
  },

  // TURN server (ephemeral credentials)
  turnServer: process.env.TURN_SERVER || '13.204.30.174:3478',
  turnSecret: process.env.TURN_SECRET || 'vaultturnsecret',
  turnCredentialTTL: parseInt(process.env.TURN_CREDENTIAL_TTL || '300', 10), // 5 minutes

  // CORS — client origin
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
};

export default config;

// ─── Production Safety Checks ──────────────────────────────
if (process.env.NODE_ENV === 'production') {
  if (config.jwtSecret === 'vault-dev-secret-change-in-production') {
    throw new Error('FATAL: JWT_SECRET must be set in production. Do not use the default dev secret.');
  }
  if (config.turnSecret === 'vaultturnsecret') {
    throw new Error('FATAL: TURN_SECRET must be set in production. Do not use the default dev secret.');
  }
  if (config.clientOrigin.startsWith('http://')) {
    console.warn('[SECURITY] CLIENT_ORIGIN is using HTTP in production. HTTPS is strongly recommended.');
  }
}
