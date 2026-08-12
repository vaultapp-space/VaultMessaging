// ============================================================
// Vault — Data Store Facade
// ============================================================
// This used to be a 900-line class that owned Postgres, Redis, WebSocket
// connections and WebRTC call state all at once. The behaviour is unchanged;
// what changed is where it lives:
//
//   src/repos/     Postgres — one module per table group
//   src/cache/     Redis    — sessions, sync relay, pending queues, quotas
//   src/realtime/  in-process — socket registry, call state, fanout
//
// What remains here is composition plus a delegating surface, so that every
// existing `fastify.store.x(...)` call site keeps working while new code can
// depend on the narrow module it actually needs. The delegations are the
// migration seam, not the destination: as routes move to `fastify.repos`,
// entries here disappear.

import pg from 'pg';
import Redis from 'ioredis';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pgConfig, redisConfig } from './db/config.js';

import { createUsers } from './repos/users.repo.js';
import { createPrekeys } from './repos/prekeys.repo.js';
import { createMessages } from './repos/messages.repo.js';
import { createGroups } from './repos/groups.repo.js';
import { createChats } from './repos/chats.repo.js';
import { createReactions } from './repos/reactions.repo.js';
import { createPhase2 } from './repos/phase2.repo.js';
import { createPhase3 } from './repos/phase3.repo.js';
import { createDevices } from './repos/devices.repo.js';
import { createChannels } from './repos/channels.repo.js';
import { createStickers } from './repos/stickers.repo.js';
import { createPhase8 } from './repos/phase8.repo.js';
import { createAttachments } from './repos/attachments.repo.js';
import { createPush } from './repos/push.repo.js';
import { createConfig } from './repos/config.repo.js';
import { createPosts } from './repos/posts.repo.js';
import { createMedia } from './repos/media.repo.js';
import { createNotifications } from './repos/notifications.repo.js';
import { createMaintenance } from './repos/maintenance.repo.js';

import { createSessions } from './cache/sessions.js';
import { createSync } from './cache/sync.js';
import { createPending } from './cache/pending.js';
import { createQuota } from './cache/quota.js';

import { createRegistry } from './realtime/registry.js';
import { createCallState } from './realtime/calls.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export class DataStore {
  // Connection settings are injected rather than read from the module scope so
  // that tests can point a store at a throwaway database. Callers that pass
  // nothing get the env-derived dev/prod defaults, which is what the server does.
  constructor({ pg: pgOverrides, redis: redisOverrides } = {}) {
    this.pool = new Pool({ ...pgConfig, ...pgOverrides });
    this.redis = new Redis({ ...redisConfig, ...redisOverrides });
    this.uploadsDir = UPLOADS_DIR;

    // Distinguishes this process on the realtime bus. Random rather than
    // pid-based so a restarted process never inherits a predecessor's routes.
    this.processId = crypto.randomUUID();

    const { pool, redis, uploadsDir } = this;

    this.users = createUsers({ pool });
    this.prekeys = createPrekeys({ pool, users: this.users });
    this.messages = createMessages({ pool });
    this.groups = createGroups({ pool });
    this.chats = createChats({ pool });
    this.reactions = createReactions({ pool });
    this.phase2 = createPhase2({ pool });
    this.phase3 = createPhase3({ pool });
    this.devices = createDevices({ pool });
    this.channels = createChannels({ pool, redis });
    this.stickers = createStickers({ pool });
    this.phase8 = createPhase8({ pool });
    this.attachments = createAttachments({ pool, uploadsDir });
    this.push = createPush({ pool });
    this.config = createConfig({ pool });
    this.posts = createPosts({ pool, uploadsDir });
    this.media = createMedia({ pool });
    this.notifications = createNotifications({ pool });
    this.maintenance = createMaintenance({ pool, uploadsDir, media: this.media });

    this.sessions = createSessions({ redis });
    this.sync = createSync({ redis });
    this.pending = createPending({ redis });
    this.quota = createQuota({ redis });

    this.registry = createRegistry({ redis, processId: this.processId });
    this.calls = createCallState();

    this.#delegate();

    // The store no longer creates schema — migrations own that (see
    // migrations/ and scripts/migrate.js). What used to be a "build the
    // schema" promise is now a gate that fails loudly if the database has
    // not been migrated, instead of letting routes fail one query at a time.
    this.schemaReady = this.verifySchema();
  }

  // Re-exposes each module's methods on the store itself, preserving the
  // original flat API that all nine route modules were written against.
  #delegate() {
    const modules = [
      this.users, this.prekeys, this.messages, this.groups,
      this.chats, this.reactions, this.phase2, this.phase3, this.devices, this.channels, this.stickers, this.phase8, this.media, this.notifications, this.attachments, this.push, this.config, this.maintenance,
      this.sessions, this.sync, this.pending, this.quota, this.calls,
    ];

    for (const mod of modules) {
      for (const key of Object.keys(mod)) {
        if (typeof mod[key] !== 'function') continue;
        if (key in this) continue; // never shadow a real member
        this[key] = mod[key].bind(mod);
      }
    }
  }

  async verifySchema() {
    const { rows } = await this.pool.query(
      `SELECT to_regclass('public.pgmigrations') IS NOT NULL AS migrated,
              to_regclass('public.users')        IS NOT NULL AS has_users`
    );
    const { migrated, has_users: hasUsers } = rows[0];
    if (!migrated || !hasUsers) {
      throw new Error(
        '[DB] Database is not migrated. Run `npm run migrate:up` in server/ before starting.'
      );
    }
    console.log('[DB] Schema verified');
  }

  // ─── Realtime (kept explicit: signatures differ from the old Map API) ────

  registerConnection(userId, socket) {
    // Fire-and-forget: the Redis presence write must never delay accepting a
    // socket, and registry.register tolerates Redis being unavailable.
    void this.registry.register(userId, socket);
  }

  unregisterConnection(userId, socket) {
    void this.registry.unregister(userId, socket);
  }

  // Sockets on this process. Retained because every existing call site is
  // synchronous and expects a Set it can iterate.
  getConnections(userId) {
    return this.registry.getLocal(userId);
  }

  // Synchronous, and therefore only knows about this process. Cluster-aware
  // callers should await registry.isOnline() instead.
  isOnline(userId) {
    return this.registry.isLocallyConnected(userId);
  }

  touchPresence(userId) {
    void this.registry.touch(userId);
  }

  // Tests build and tear down many stores in one process; without this the
  // pg pool and Redis socket keep the event loop alive and the run hangs.
  async close() {
    await this.pool.end();
    this.redis.disconnect();
  }
}

// Importing this module must not open a database connection — index.js and the
// test harness both decide when a store is constructed, and importing app.js in
// a test should never require a live Postgres.
export function createStore(options) {
  return new DataStore(options);
}
