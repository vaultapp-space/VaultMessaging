// ============================================================
// Vault — realtime/registry.js
// ============================================================
// Tracks which sockets belong to which user, and — via Redis — which process
// those sockets live on.
//
// The local Map is still the only thing that can actually hold a socket: a
// WebSocket is not serialisable and cannot leave the process that owns it.
// What Redis adds is *routing*: any process can now discover that a user is
// connected somewhere and forward to that process (see bus.js), which is the
// prerequisite for running more than one instance.
//
// Presence is deliberately keyed per connection and given a TTL that the
// existing 30s heartbeat refreshes, so a process that dies without running
// its cleanup handlers does not leave a user looking permanently online.

const PRESENCE_TTL_SECONDS = 90; // ~3 missed heartbeats

export function createRegistry({ redis, processId }) {
  // chatId -> Set<socket>, for channels being viewed on this process.
  const channelViewers = new Map();

  // userId -> Set<socket>, local to this process.
  const local = new Map();

  const presenceKey = (userId) => `presence:${userId}`;
  const routeKey = (userId) => `route:${userId}`;

  let connectionSeq = 0;

  return {
    processId,
    local,

    async register(userId, socket) {
      if (!local.has(userId)) local.set(userId, new Set());
      local.get(userId).add(socket);

      // Tag the socket so unregister can find its presence entry again.
      socket.__vaultConnectionId = `${processId}:${(connectionSeq += 1)}`;

      try {
        await redis
          .multi()
          .sadd(presenceKey(userId), socket.__vaultConnectionId)
          .expire(presenceKey(userId), PRESENCE_TTL_SECONDS)
          .sadd(routeKey(userId), processId)
          .expire(routeKey(userId), PRESENCE_TTL_SECONDS)
          .exec();
      } catch {
        // Presence is best-effort: losing Redis must not drop the socket.
      }
    },

    async unregister(userId, socket) {
      const sockets = local.get(userId);
      if (sockets) {
        sockets.delete(socket);
        if (sockets.size === 0) local.delete(userId);
      }

      try {
        if (socket.__vaultConnectionId) {
          await redis.srem(presenceKey(userId), socket.__vaultConnectionId);
        }
        // Only drop this process from the route set once it holds no sockets
        // for the user at all, otherwise a second tab would be cut off.
        if (!local.has(userId)) {
          await redis.srem(routeKey(userId), processId);
        }
      } catch {
        // Best-effort, as above.
      }
    },

    // Refreshes the TTL for every connection this process holds. Called from
    // the heartbeat so presence survives exactly as long as the socket does.
    async touch(userId) {
      if (!local.has(userId)) return;
      try {
        await redis
          .multi()
          .expire(presenceKey(userId), PRESENCE_TTL_SECONDS)
          .expire(routeKey(userId), PRESENCE_TTL_SECONDS)
          .exec();
      } catch {
        // Best-effort.
      }
    },

    // ─── Channel viewers ──────────────────────────────────
    // Who is *watching* a channel right now, on this process.
    //
    // This is what makes a channel post cost O(1) instead of O(subscribers):
    // the post is written to the people actually looking at it, and everyone
    // else discovers it from `chats.last_message_at` when they next open the
    // channel. Keeping a live viewer set is far cheaper than iterating a
    // subscriber list that can run to seven figures.

    watchChannel(chatId, socket) {
      if (!channelViewers.has(chatId)) channelViewers.set(chatId, new Set());
      channelViewers.get(chatId).add(socket);
    },

    unwatchChannel(chatId, socket) {
      const viewers = channelViewers.get(chatId);
      if (!viewers) return;
      viewers.delete(socket);
      if (viewers.size === 0) channelViewers.delete(chatId);
    },

    // Drops a socket from every channel it was watching. Called on close,
    // because a socket that goes away without this leaks into every set it
    // ever joined.
    unwatchAll(socket) {
      for (const [chatId, viewers] of channelViewers) {
        viewers.delete(socket);
        if (viewers.size === 0) channelViewers.delete(chatId);
      }
    },

    channelViewers(chatId) {
      return channelViewers.get(chatId) || new Set();
    },

    // Sockets held by *this* process. Callers that need to reach every
    // connection of a user should go through fanout.deliverToUser instead.
    getLocal(userId) {
      return local.get(userId) || new Set();
    },

    // True if the user has a socket on this process.
    isLocallyConnected(userId) {
      return local.has(userId);
    },

    // True if the user is connected to any process in the cluster.
    async isOnline(userId) {
      if (local.has(userId)) return true;
      try {
        return (await redis.scard(presenceKey(userId))) > 0;
      } catch {
        return false;
      }
    },

    async connectionCount(userId) {
      try {
        return await redis.scard(presenceKey(userId));
      } catch {
        return this.getLocal(userId).size;
      }
    },

    // Which processes currently hold sockets for this user.
    async routesFor(userId) {
      try {
        return await redis.smembers(routeKey(userId));
      } catch {
        return local.has(userId) ? [processId] : [];
      }
    },
  };
}
