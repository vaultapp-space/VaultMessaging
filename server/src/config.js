// ============================================================
// Vault Server Configuration
// All values sourced from environment; sensible defaults for dev
// ============================================================

const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'vault-dev-secret-change-in-production',
  jwtExpiresIn: '24h',

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
