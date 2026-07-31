// ============================================================
// Vault — Fastify Server Entrypoint
// ============================================================

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyWebSocket from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';

import config from './config.js';
import store from './store.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.routes.js';
import keysRoutes from './routes/keys.routes.js';
import messageRoutes from './routes/messages.routes.js';
import wsRoutes from './routes/ws.routes.js';
import attachmentRoutes from './routes/attachments.routes.js';
import groupRoutes from './routes/groups.routes.js';
import chunkRoutes from './routes/chunks.routes.js';
import pushRoutes from './routes/push.routes.js';
import turnRoutes from './routes/turn.routes.js';

const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
  // Default (1 MiB) is too small for encrypted attachment chunks: a 1MB
  // chunk becomes ~1.33MB after base64 encoding, plus JSON overhead.
  bodyLimit: 6 * 1024 * 1024,
  // Behind nginx (127.0.0.1 -> this process), so req.ip reflects the real
  // client via X-Forwarded-For instead of always being the proxy's own
  // address — otherwise every client buckets under one IP for rate
  // limiting, making per-attacker limits useless and enabling a trivial
  // self-DoS. Safe only because port 3001 is not reachable directly from
  // the internet (verified: no path to Fastify except through nginx).
  trustProxy: true,
});

// ─── Global Plugins ─────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

await fastify.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.qrserver.com"],
      connectSrc: isProd
        ? ["'self'", "wss:", "https://vaultapp.space", "https://www.vaultapp.space"]
        : ["'self'", "ws:", "wss:", "http://localhost:3001"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
});

await fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    const isDev = process.env.NODE_ENV !== 'production';
    if (!origin || origin === config.clientOrigin || origin === 'https://vaultapp.space' || origin === 'https://www.vaultapp.space' || (isDev && (origin.startsWith('http://localhost:') || origin.match(/^http:\/\/\d+\.\d+\.\d+\.\d+:5173$/) || origin.endsWith(':5173')))) {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
});

await fastify.register(fastifyCookie);
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWebSocket);
await fastify.register(fastifyRateLimit, config.rateLimit);

// Decorate with the in-memory store
fastify.decorate('store', store);

// Auth plugin (JWT + authenticate decorator)
await fastify.register(authPlugin);

// ─── Routes ─────────────────────────────────────────────────

await fastify.register(authRoutes);
await fastify.register(keysRoutes);
await fastify.register(pushRoutes);
await fastify.register(messageRoutes);
await fastify.register(wsRoutes);
await fastify.register(attachmentRoutes);
await fastify.register(groupRoutes);
await fastify.register(chunkRoutes);
await fastify.register(turnRoutes);

// ─── Reaper Worker (24h hard deletion) ──────────────────────

const reaperInterval = setInterval(async () => {
  try {
    const reaped = await store.reap();
    if (reaped > 0) {
      fastify.log.info(`Reaper: purged ${reaped} expired items`);
    }
  } catch (err) {
    fastify.log.error(err, 'Reaper task failed');
  }
}, config.reaperIntervalMs);

// ─── Health Check ───────────────────────────────────────────

fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Network Stats ─────────────────────────────────────────
fastify.get('/api/network/stats', async () => {
  const activeConnections = fastify.websocketServer?.clients?.size || 0;
  return {
    status: 'ok',
    activeConnections: Math.max(activeConnections, 1),
    relays: 4,
    latency: 24,
    timestamp: new Date().toISOString()
  };
});

// ─── Start ──────────────────────────────────────────────────

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Vault server running on http://${config.host}:${config.port}`);
} catch (err) {
  fastify.log.error(err);
  clearInterval(reaperInterval);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async () => {
  clearInterval(reaperInterval);
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
