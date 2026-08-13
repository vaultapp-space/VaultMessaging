// ============================================================
// Vault — Server Process Entrypoint
// ============================================================
// Process-level concerns only: open connections, bind the port, run the
// reaper, handle signals. The application itself is assembled by
// buildApp() in app.js, which knows nothing about any of this.

import config from './config.js';
import { createStore } from './store.js';
import { buildApp } from './app.js';

const store = createStore();

// Fail fast and legibly if the database has not been migrated, rather than
// letting individual routes error on missing tables at request time.
try {
  await store.schemaReady;
} catch (err) {
  console.error(err.message);
  await store.close().catch(() => {});
  process.exit(1);
}

const fastify = await buildApp({ store, config });

// ─── Reaper Worker (expired message/attachment deletion) ────

// Backs off while there is nothing to do. Seven queries a minute forever is a
// small constant, but it is a constant paid on an idle instance at three in
// the morning as surely as at peak — roughly twenty thousand passes over a
// fortnight, almost all finding nothing.
//
// **The 24-hour guarantee is unaffected.** Expiry is enforced by the queries
// themselves (`expires_at > now()` is a predicate on every read), not by how
// often the reaper runs; the reaper only reclaims storage. The worst case here
// is that an expired row occupies disk for five minutes longer than it used
// to, while remaining invisible to every route the whole time.
//
// Any deletion snaps the cadence straight back to the base interval, so a
// sudden burst is followed at full speed rather than at the idle rate.
const IDLE_PASSES_BEFORE_BACKOFF = 5;
const MAX_REAPER_INTERVAL_MS = 5 * 60 * 1000;

let idlePasses = 0;
let reaperInterval = null;

async function reaperPass() {
  let nextDelay = config.reaperIntervalMs;

  try {
    const { messages, chatIds } = await store.reap();

    if (messages > 0) {
      // Messages expire but chats do not, so unread counters must be brought
      // back in line with what actually remains — otherwise a chat sits at
      // "3 unread" with an empty message list.
      //
      // Scoped to the chats that just lost a message. Called with no argument
      // this recomputes every user-and-chat pair in the database, joining
      // against the messages table, once a minute for as long as anything is
      // expiring. Nothing else can have gone stale, so nothing else needs
      // looking at.
      const corrected = await store.chats.reconcileUnread(chatIds);
      fastify.log.info(
        `Reaper: purged ${messages} expired items across ${chatIds.length} chats, `
        + `corrected ${corrected} unread counters`
      );
    }

    idlePasses = messages > 0 ? 0 : idlePasses + 1;
    if (idlePasses >= IDLE_PASSES_BEFORE_BACKOFF) {
      nextDelay = MAX_REAPER_INTERVAL_MS;
    }

    // Recorded on every pass, not only when something was deleted: an idle
    // hour with nothing to reap is still a healthy reaper, and treating it as
    // silence would fire the alarm on a quiet night.
    fastify.recordReaperRun({ rowsDeleted: messages });
  } catch (err) {
    fastify.log.error(err, 'Reaper task failed');
    // The failure is recorded as well as logged. The reaper is the only thing
    // bounding database size *and* the only thing enforcing the 24-hour rule,
    // so a stall has to surface on /health rather than in a log nobody reads.
    fastify.recordReaperRun({ error: err });
    // A failing pass does not count as idle — backing off while broken would
    // slow down the recovery as well as the work.
    idlePasses = 0;
  }

  // setTimeout rather than setInterval, so the delay can change and so a slow
  // pass can never overlap the next one.
  reaperInterval = setTimeout(reaperPass, nextDelay);
  reaperInterval.unref?.();
}

reaperInterval = setTimeout(reaperPass, config.reaperIntervalMs);
reaperInterval.unref?.();

// ─── Start ──────────────────────────────────────────────────

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Vault server running on http://${config.host}:${config.port}`);
} catch (err) {
  fastify.log.error(err);
  clearTimeout(reaperInterval);
  await store.close().catch(() => {});
  process.exit(1);
}

// Graceful shutdown.
//
// fastify.close() can block forever on sockets it does not track. A rejected
// WebSocket upgrade is enough to cause it: @fastify/cors answers a bad-Origin
// upgrade with a 500, the TCP connection is left open, and close() then waits
// on it indefinitely — so any unauthenticated client can permanently prevent
// this process from shutting down cleanly by sending one such request. The
// timeout below bounds the graceful phase and then forces the remainder shut.
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '5000', 10);

const shutdown = async () => {
  clearTimeout(reaperInterval);

  // Stage 1: at the end of the grace period, drop any remaining sockets.
  const forceClose = setTimeout(() => {
    fastify.log.warn('Graceful shutdown timed out; forcing remaining connections closed');
    try { fastify.server.closeAllConnections?.(); } catch {}
  }, SHUTDOWN_GRACE_MS);
  forceClose.unref?.();

  // Stage 2: even that is not always enough — @fastify/websocket's own close
  // hook can stay pending — so exit unconditionally shortly after. A shutdown
  // that never completes is worse than one that drops a few sockets.
  const hardExit = setTimeout(() => {
    fastify.log.warn('Shutdown did not complete; exiting immediately');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS + 2000);
  hardExit.unref?.();

  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error(err, 'Error during fastify.close()');
  }
  clearTimeout(forceClose);
  clearTimeout(hardExit);

  await store.close().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
