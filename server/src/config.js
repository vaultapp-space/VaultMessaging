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
  },

  // CORS — client origin
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
};

export default config;

// ─── Production Safety Checks ──────────────────────────────
if (process.env.NODE_ENV === 'production') {
  if (config.jwtSecret === 'vault-dev-secret-change-in-production') {
    throw new Error('FATAL: JWT_SECRET must be set in production. Do not use the default dev secret.');
  }
  if (config.clientOrigin.startsWith('http://')) {
    console.warn('[SECURITY] CLIENT_ORIGIN is using HTTP in production. HTTPS is strongly recommended.');
  }
}
