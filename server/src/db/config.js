// ============================================================
// Vault — Database Connection Settings
// ============================================================
// Single source of truth for how to reach Postgres and Redis. Both the
// running server (src/store.js) and the migration CLI (scripts/migrate.js)
// read from here, so it is impossible for migrations to be applied to a
// different database than the one the app is talking to.

export const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'vault',
  password: process.env.PGPASSWORD || 'vault_dev_pass',
  database: process.env.PGDATABASE || 'vault',
  max: 50,
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
