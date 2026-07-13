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
        JWT_SECRET: 'be6996fe8217dfbd42e93b519775d89c4f7a2d8b7763f94c5540afac92b69ba6',
        TURN_SERVER: '13.204.30.174:3478',
        TURN_SECRET: 'vaultturnsecret',
        PGHOST: '127.0.0.1',
        PGPORT: 5432,
        PGUSER: 'vault',
        PGDATABASE: 'vault',
      }
    }
  ]
};
