// ============================================================
// Vault — realtime/bus.js
// ============================================================
// Cross-process delivery over Redis pub/sub.
//
// Today the app runs as a single PM2 fork, so every socket is in one process
// and this layer is a no-op pass-through. It exists so that the fanout API
// callers use is already the right shape: switching ecosystem.config.cjs to
// cluster mode then becomes a configuration change rather than a rewrite of
// every delivery site.
//
// Note ioredis requires a dedicated connection for subscriptions — a client
// in subscriber mode cannot issue ordinary commands — hence two clients.

const CHANNEL_BROADCAST = 'chan:posts';

export function createBus({ redis, subscriber, processId, onMessage, logger }) {
  const channel = (target) => `node:${target}`;
  let subscribed = false;

  return {
    processId,

    async start() {
      if (subscribed || !subscriber) return;
      subscriber.on('message', (_channel, raw) => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        try {
          onMessage(parsed);
        } catch (err) {
          logger?.warn?.({ err }, 'realtime bus handler failed');
        }
      });
      await subscriber.subscribe(channel(processId));
      // One subscription covers every channel, rather than one per channel:
      // subscribing per channel would mean a Redis subscription for each of
      // potentially thousands, and unsubscribing correctly as viewers come
      // and go. The receiving process filters by chatId instead, which costs
      // nothing next to the delivery it is already doing.
      await subscriber.subscribe(CHANNEL_BROADCAST);
      subscribed = true;
    },

    async stop() {
      if (!subscribed || !subscriber) return;
      try { await subscriber.unsubscribe(channel(processId)); } catch {}
      try { await subscriber.unsubscribe(CHANNEL_BROADCAST); } catch {}
      subscribed = false;
    },

    // Forwards an envelope to a specific process. Returns false when the bus
    // is unavailable so the caller can fall back to local-only delivery.
    async publishTo(targetProcessId, envelope) {
      if (targetProcessId === processId) return false; // handle locally
      try {
        await redis.publish(channel(targetProcessId), JSON.stringify(envelope));
        return true;
      } catch (err) {
        logger?.warn?.({ err, targetProcessId }, 'realtime bus publish failed');
        return false;
      }
    },

    /**
     * Publishes a channel post to every process.
     *
     * Unlike publishTo, this deliberately does not exclude the calling
     * process — but the caller has already written to its own viewers, so
     * the envelope carries the origin and each process skips its own.
     */
    async publishChannel(chatId, payload) {
      try {
        await redis.publish(CHANNEL_BROADCAST, JSON.stringify({
          kind: 'channel', chatId, payload, from: processId,
        }));
        return true;
      } catch (err) {
        logger?.warn?.({ err, chatId }, 'channel broadcast failed');
        return false;
      }
    },
  };
}
