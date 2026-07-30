// Secrets (JWT_SECRET, TURN_SECRET, PGPASSWORD, ...) are intentionally NOT
// hardcoded here — this file is tracked in git. Set them in the shell
// environment (or a gitignored .env loaded via `pm2 start --env-file`)
// before starting PM2, e.g.:
//   export JWT_SECRET=... TURN_SECRET=... PGPASSWORD=...
//   pm2 start ecosystem.config.cjs
// server/src/config.js refuses to boot in production if JWT_SECRET/TURN_SECRET
// are left unset/default, so a misconfigured deploy fails loudly instead of
// silently running with weak secrets.
module.exports = {
  apps: [
    {
      name: 'vault-server',
      script: './src/index.js',
      cwd: '/home/ubuntu/VaultMessaging/server',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOST: '0.0.0.0',
        CLIENT_ORIGIN: 'https://vaultapp.space',
        JWT_SECRET: process.env.JWT_SECRET,
        TURN_SERVER: process.env.TURN_SERVER || '13.204.30.174:3478',
        TURN_SECRET: process.env.TURN_SECRET,
        PGHOST: '127.0.0.1',
        PGPORT: 5432,
        PGUSER: 'vault',
        PGPASSWORD: process.env.PGPASSWORD,
        PGDATABASE: 'vault',
      }
    }
  ]
};
