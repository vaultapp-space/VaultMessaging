// ============================================================
// Vault — Fastify Application Factory
// ============================================================
// Everything here is pure wiring: no connections are opened, no port is
// bound, and no background timers start. That is what lets a test do
// `buildApp({ store })` and drive the whole HTTP/WS surface through
// fastify.inject() without a live server. Process concerns (listen,
// reaper, signal handlers) live in index.js.

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyWebSocket from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';

import defaultConfig from './config.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.routes.js';
import keysRoutes from './routes/keys.routes.js';
import messageRoutes from './routes/messages.routes.js';
import wsRoutes from './routes/ws.routes.js';
import attachmentRoutes from './routes/attachments.routes.js';
import groupRoutes from './routes/groups.routes.js';
import chatRoutes from './routes/chats.routes.js';
import chatMessageRoutes from './routes/chat-messages.routes.js';
import reactionRoutes from './routes/reactions.routes.js';
import phase2Routes from './routes/phase2.routes.js';
import phase3Routes from './routes/phase3.routes.js';
import deviceRoutes from './routes/devices.routes.js';
import channelRoutes from './routes/channels.routes.js';
import stickerRoutes from './routes/stickers.routes.js';
import mediaRoutes from './routes/media.routes.js';
import phase8Routes from './routes/phase8.routes.js';
import postRoutes from './routes/posts.routes.js';
import { validateUrl } from './lib/safe-fetch.js';
import chunkRoutes from './routes/chunks.routes.js';
import pushRoutes from './routes/push.routes.js';
import turnRoutes from './routes/turn.routes.js';

import { createBus } from './realtime/bus.js';
import { createFanout } from './realtime/fanout.js';

export async function buildApp({ store, config = defaultConfig, logger, serverOptions = {} } = {}) {
  if (!store) throw new Error('buildApp requires a store');

  // Boot counts as the reaper's baseline "last success", so a freshly started
  // instance is not reported unhealthy before its first pass has run.
  const bootedAt = Date.now();

  const isProd = process.env.NODE_ENV === 'production';

  const fastify = Fastify({
    logger: logger ?? {
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
    // Helps ordinary keep-alive sockets drain on close. Note it is NOT
    // sufficient for sockets left behind by a rejected WebSocket upgrade —
    // those are not in fastify's connection accounting. See the forced-close
    // fallback in index.js's shutdown handler.
    forceCloseConnections: true,
    ...serverOptions,
  });

  // ─── Global Plugins ─────────────────────────────────────────

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

  // Shared by the CORS layer and the WebSocket route, so HTTP and upgrade
  // requests can never disagree about which origins are acceptable.
  const isOriginAllowed = (origin) => {
    const isDev = process.env.NODE_ENV !== 'production';
    return !origin
      || origin === config.clientOrigin
      || origin === 'https://vaultapp.space'
      || origin === 'https://www.vaultapp.space'
      // The Android app (client/capacitor.config.ts). Its own WebView
      // content is deliberately served from this subdomain rather than
      // vaultapp.space itself — see that file's server.hostname comment —
      // so its actual API calls arrive with this as their Origin.
      || origin === 'https://app.vaultapp.space'
      || (isDev && (
        origin.startsWith('http://localhost:')
        || origin.match(/^http:\/\/\d+\.\d+\.\d+\.\d+:5173$/)
        || origin.endsWith(':5173')
      ));
  };
  fastify.decorate('isOriginAllowed', isOriginAllowed);

  // Registered as a delegator so the per-request decision can see the request
  // itself, which the plain `origin` callback cannot.
  //
  // WebSocket upgrades are deliberately passed through to the route. CORS was
  // rejecting a disallowed Origin with a 500 *before* ws.routes.js ran, which
  // had two bad effects: the intended 4003 close code was unreachable dead
  // code, and the refused upgrade left a half-open socket that blocked
  // graceful shutdown (see the bounded shutdown in index.js). The route's own
  // check still refuses the connection — it just does so cleanly.
  await fastify.register(fastifyCors, () => (req, cb) => {
    const isUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (isUpgrade) {
      cb(null, { origin: true, credentials: true });
      return;
    }
    cb(null, {
      credentials: true,
      // @fastify/cors defaults this to 'GET,HEAD,POST' — fine as long as
      // every client is same-origin (the browser and iOS never send a real
      // preflight, so the gap was invisible). The Android app is genuinely
      // cross-origin by design (see capacitor.config.ts), so its PUT/PATCH/
      // DELETE calls actually preflight now, and were failing here.
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      origin: (origin, originCb) => {
        if (isOriginAllowed(origin)) {
          originCb(null, true);
          return;
        }
        originCb(new Error('Not allowed by CORS'), false);
      },
    });
  });

  await fastify.register(fastifyCookie);
  await fastify.register(fastifyFormBody);
  await fastify.register(fastifyWebSocket);
  await fastify.register(fastifyRateLimit, config.rateLimit);

  // Decorate with the data store and config so route modules stay
  // constructor-free and can be exercised against a test store.
  fastify.decorate('store', store);
  fastify.decorate('config', config);

  // Direct access to the individual repositories, for code written after the
  // store was split up. `fastify.store` remains as the migration seam.
  fastify.decorate('repos', {
    users: store.users,
    prekeys: store.prekeys,
    messages: store.messages,
    groups: store.groups,
    chats: store.chats,
    reactions: store.reactions,
    phase2: store.phase2,
    phase3: store.phase3,
    devices: store.devices,
    channels: store.channels,
    stickers: store.stickers,
    phase8: store.phase8,
    posts: store.posts,
    attachments: store.attachments,
    push: store.push,
    config: store.config,
  });

  // One delivery path for every websocket write in the app.
  const subscriber = store.redis.duplicate();
  const bus = createBus({
    redis: store.redis,
    subscriber,
    processId: store.processId,
    onMessage: (envelope) => fastify.fanout.handleBusMessage(envelope),
    logger: fastify.log,
  });
  const fanout = createFanout({ registry: store.registry, bus, logger: fastify.log });

  fastify.decorate('fanout', fanout);

  // The same SSRF guard link previews use, exposed so the bot webhook route
  // can apply it. A webhook URL is attacker-chosen by definition — anyone can
  // register a bot — so pointing one at a metadata endpoint or an internal
  // service has to be impossible rather than discouraged.
  fastify.decorate('validateOutboundUrl', validateUrl);
  fastify.decorate('bus', bus);

  await bus.start().catch((err) => {
    // Single-process deployments work fine without the bus; log and continue
    // rather than refusing to boot because Redis pub/sub is unavailable.
    fastify.log.warn({ err }, 'realtime bus unavailable; delivery stays process-local');
  });

  fastify.addHook('onClose', async () => {
    await bus.stop().catch(() => {});
    try { subscriber.disconnect(); } catch {}
  });

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
  await fastify.register(chatRoutes);
  await fastify.register(chatMessageRoutes);
  await fastify.register(reactionRoutes);
  await fastify.register(phase2Routes);
  await fastify.register(phase3Routes);
  await fastify.register(deviceRoutes);
  await fastify.register(channelRoutes);
  await fastify.register(mediaRoutes);
  await fastify.register(stickerRoutes);
  await fastify.register(phase8Routes);
  await fastify.register(postRoutes);
  await fastify.register(chunkRoutes);
  await fastify.register(turnRoutes);

  // ─── Health Check ───────────────────────────────────────────

  // ─── Reaper health ──────────────────────────────────────────
  //
  // The reaper is now the only thing bounding database size, and its failure
  // mode is silent: nothing breaks for a day, then storage climbs and old
  // messages quietly outlive the 24-hour rule. That is the worst kind of
  // failure this codebase can have — the privacy guarantee stops holding and
  // no user-visible symptom says so.
  //
  // So its state is exposed and /health *fails* when it stalls. A monitor
  // that only checks "is the process up" would report green through exactly
  // the outage that matters.
  const reaperState = {
    lastSuccessAt: null,
    lastError: null,
    runs: 0,
    rowsDeletedTotal: 0,
  };
  fastify.decorate('reaperState', reaperState);

  fastify.decorate('recordReaperRun', ({ rowsDeleted = 0, error = null } = {}) => {
    reaperState.runs += 1;
    if (error) {
      reaperState.lastError = String(error?.message ?? error);
      return;
    }
    reaperState.lastError = null;
    reaperState.lastSuccessAt = Date.now();
    reaperState.rowsDeletedTotal += rowsDeleted;
  });

  // How long without a successful pass before the instance is unhealthy.
  // Fifteen minutes: long enough to ride out a slow pass or a brief database
  // blip, short enough that a genuine stall is caught the same hour.
  const REAPER_STALL_MS = 15 * 60 * 1000;

  fastify.get('/health', async (request, reply) => {
    const now = Date.now();
    // Boot counts as a success so a freshly started instance is not reported
    // unhealthy for its first interval.
    const since = now - (reaperState.lastSuccessAt ?? bootedAt);
    const reaperHealthy = since < REAPER_STALL_MS;

    const body = {
      status: reaperHealthy ? 'ok' : 'degraded',
      timestamp: new Date(now).toISOString(),
      reaper: {
        healthy: reaperHealthy,
        lastSuccessAt: reaperState.lastSuccessAt
          ? new Date(reaperState.lastSuccessAt).toISOString()
          : null,
        secondsSinceLastSuccess: Math.floor(since / 1000),
        runs: reaperState.runs,
        rowsDeletedTotal: reaperState.rowsDeletedTotal,
        lastError: reaperState.lastError,
      },
    };

    // 503, not 200-with-a-flag. A load balancer or uptime check reading only
    // the status code has to see this.
    return reaperHealthy ? body : reply.code(503).send(body);
  });

  // ─── Network Stats ─────────────────────────────────────────
  // Only ever report real, measured values here — no invented "relay count"
  // or "latency" figures. Both used to be hardcoded constants dressed up
  // with client-side random jitter to look live, which is exactly the kind
  // of misleading stat this app's zero-knowledge claims should not tolerate.
  fastify.get('/api/network/stats', async () => {
    const activeConnections = fastify.websocketServer?.clients?.size || 0;
    return {
      status: 'ok',
      activeConnections: Math.max(activeConnections, 1),
      timestamp: new Date().toISOString()
    };
  });

  return fastify;
}

export default buildApp;
