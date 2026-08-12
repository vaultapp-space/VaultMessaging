// ============================================================
// Vault — realtime/feed-ticker.js
// ============================================================
// Tells watchers of the public feed that something new exists, without telling
// them what.
//
// **The tick carries no post.** Pushing bodies would ship a blocked user's
// content to the person who blocked them: you cannot filter per viewer at
// publish time without O(viewers) work, and "the content arrived but the client
// hid it" is not blocking. The client is nudged and pulls the timeline, which
// applies blocks and mutes in SQL. It also keeps the bytes bounded for a phone
// on cellular.
//
// **The tick is coalesced.** One tick per post is 1000 socket messages a minute
// per viewer at 1000 posts a minute — for a message whose entire content is
// "there is something new", where the second one says nothing the first did
// not. A timer emits at most one per window if anything was posted in it.
//
// Multiple server processes each running their own ticker is fine: the message
// is idempotent, and a viewer receiving two ticks refreshes once either way.

export const FEED_KEY = 'feed:global';
export const TICK_WINDOW_MS = 5000;

export function createFeedTicker({ fanout, windowMs = TICK_WINDOW_MS }) {
  let dirty = false;
  let timer = null;

  async function flush() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await fanout.deliverToChannel(FEED_KEY, { type: 'feed_tick' });
    } catch {
      // A failed tick costs a viewer some freshness until their next pull or
      // the next post. It must never propagate into the request that posted —
      // the post itself succeeded.
    }
  }

  return {
    /**
     * Called on the write path. Deliberately synchronous and trivial: it sets
     * a flag and, at most, arms a timer. Anything heavier here would put
     * fanout work back on the request that created the post, which is the
     * shape this design exists to avoid.
     */
    notePost() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(flush, windowMs);
      // Not a reason to hold the process open. Without this an idle server
      // waits out the window before it can exit, and every test that creates
      // an app leaks a handle.
      timer.unref?.();
    },

    /** For tests and shutdown: emit anything pending and stop the timer. */
    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}
