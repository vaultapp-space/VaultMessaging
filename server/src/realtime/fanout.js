// ============================================================
// Vault — realtime/fanout.js
// ============================================================
// The single way anything in this codebase sends data to a connected client.
//
// Before this existed, every delivery site did the same thing by hand:
//
//     const sockets = store.getConnections(userId);
//     for (const s of sockets) { try { s.send(payload); } catch {} }
//
// repeated across ws.routes.js, messages.routes.js and groups.routes.js.
// Collapsing it here means adding multi-process delivery, or per-device
// targeting, or delivery metrics, is one change instead of eight — and it is
// why this lands before the feature phases rather than after.

export function createFanout({ registry, bus, logger }) {
  function sendLocal(userId, payload) {
    let delivered = 0;
    for (const socket of registry.getLocal(userId)) {
      try {
        socket.send(payload);
        delivered += 1;
      } catch (err) {
        logger?.warn?.({ err, userId }, 'websocket send failed');
      }
    }
    return delivered;
  }

  return {
    // Delivers to every connection a user has, wherever it lives.
    // Resolves to the number of sockets written to on this process; remote
    // deliveries are fire-and-forget by nature.
    async deliverToUser(userId, message, { excludeSocket = null } = {}) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);

      let delivered = 0;
      for (const socket of registry.getLocal(userId)) {
        if (socket === excludeSocket) continue;
        try {
          socket.send(payload);
          delivered += 1;
        } catch (err) {
          logger?.warn?.({ err, userId }, 'websocket send failed');
        }
      }

      // Reach connections held by other processes, if any.
      if (bus) {
        const routes = await registry.routesFor(userId);
        for (const target of routes) {
          if (target === registry.processId) continue;
          await bus.publishTo(target, { kind: 'deliver', userId, payload });
        }
      }

      return delivered;
    },

    // Delivers the same message to many users — group traffic and membership
    // changes. Sequential on purpose: these fan out to tens of members, not
    // thousands, and unbounded concurrency here would be a foot-gun once
    // channels arrive (see the plan's channel fanout notes).
    async deliverToUsers(userIds, message, { exclude = [] } = {}) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      const skip = new Set(exclude);
      let delivered = 0;
      for (const userId of userIds) {
        if (skip.has(userId)) continue;
        delivered += await this.deliverToUser(userId, payload);
      }
      return delivered;
    },

    /**
     * Delivers a channel post.
     *
     * The important thing about this method is what it does *not* do: it
     * never iterates subscribers. A channel post writes one row and reaches
     * whoever is currently watching; everyone else finds it from
     * `chats.last_message_at` and pulls on open.
     *
     * Doing it the obvious way — deliverToUsers(subscriberIds, …) — is O(n)
     * per post and turns a single post to a large channel into hundreds of
     * thousands of writes. That is the failure mode this whole design exists
     * to avoid, so if a future feature needs per-subscriber work, it belongs
     * in a batched worker, not here.
     */
    async deliverToChannel(chatId, message) {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);

      let delivered = 0;
      for (const socket of registry.channelViewers(chatId)) {
        try {
          socket.send(payload);
          delivered += 1;
        } catch (err) {
          logger?.warn?.({ err, chatId }, 'channel send failed');
        }
      }

      // Other processes have their own viewers, and one publish reaches all
      // of them regardless of how many that is.
      if (bus) {
        await bus.publishChannel(chatId, payload);
      }

      return delivered;
    },

    // Applies a message that arrived from another process via the bus.
    handleBusMessage(envelope) {
      if (envelope?.kind === 'channel') {
        // The originating process already wrote to its own viewers.
        if (envelope.from === registry.processId) return;
        for (const socket of registry.channelViewers(envelope.chatId)) {
          try { socket.send(envelope.payload); } catch { /* dead socket */ }
        }
        return;
      }
      if (envelope?.kind !== 'deliver') return;
      sendLocal(envelope.userId, envelope.payload);
    },
  };
}
