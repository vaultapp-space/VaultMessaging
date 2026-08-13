// ============================================================
// Vault — Database Connection Settings
// ============================================================
// Single source of truth for how to reach Postgres and Redis. Both the
// running server (src/store.js) and the migration CLI (scripts/migrate.js)
// read from here, so it is impossible for migrations to be applied to a
// different database than the one the app is talking to.

// ⚠ The password default below is **in use in production**. No PGPASSWORD is
// set on the VPS, so the running server and scripts/migrate.js both fall
// through to it. That is a known, accepted state — Postgres listens only on
// 127.0.0.1, so the exposure is that a foothold on the box does not also need
// to find the password.
//
// **Do not add a "refuse to boot on the default" guard here** to match the
// JWT_SECRET/TURN_SECRET checks in ../config.js. It would be correct in the
// abstract and would take the site down on the very next deploy. If this is
// ever rotated, the order is ALTER USER first, then PGPASSWORD into PM2 and
// /home/ubuntu/.vault-env together, then restart — and the guard can follow.
export const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'vault',
  password: process.env.PGPASSWORD || 'vault_dev_pass',
  database: process.env.PGDATABASE || 'vault',
  // Per process. The server's own max_connections is 100, so at 50 a single
  // app process could claim half the database's capacity — and each backend
  // costs the box 5-10MB of RAM whether or not it is doing anything. Measured
  // usage is 6 connections; 15 leaves an order of magnitude of headroom while
  // making it impossible for one process to starve psql, the migration CLI or
  // a second instance during a deploy.
  //
  // Raise this if the pool is ever genuinely exhausted (it surfaces as
  // requests queueing rather than failing), not pre-emptively.
  max: 15,
  idleTimeoutMillis: 30000,
};

export const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Lets an E2E or throwaway run keep its keys off db 0, so it can never
  // disturb a developer's working Redis state.
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

// node-pg-migrate takes a connection string rather than a config object.
export function pgConnectionString(overrides = {}) {
  const c = { ...pgConfig, ...overrides };
  const auth = `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`;
  return `postgres://${auth}@${c.host}:${c.port}/${c.database}`;
}
