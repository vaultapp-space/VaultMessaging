<script>
  // ============================================================
  // The bell — likes, replies, reposts and follows
  // ============================================================
  // Before this, an interaction with your post was only discoverable by
  // reopening the thread and noticing a counter had moved. On a feed where
  // everything is deleted after 24 hours, that meant most replies were never
  // seen by the person they were addressed to.
  //
  // The socket event carries **no content** — it is a bare "something
  // happened", and the list is refetched. That is deliberate: the list and
  // count queries filter blocked actors in SQL, and a push naming the actor
  // would route around that and tell you a blocked user had interacted with
  // you. Same reasoning as feed_tick.
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';

  import { fetchNotifications, markNotificationsRead } from '../../lib/api/http.js';
  import { onWsEvent } from '../../lib/api/ws.js';
  import { clickOutside } from '../../lib/actions/clickOutside.js';
  import { getAvatarGradient } from '../../lib/avatar.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { unreadNotifications, clearUnreadLocally } from '../../lib/stores/notifications.js';

  const dispatch = createEventDispatcher();

  let open = false;
  let items = [];
  let loading = false;
  let unsubscribe = null;

  const VERB = {
    like: 'liked your post',
    reply: 'replied to your post',
    repost: 'reposted your post',
    follow: 'followed you',
  };

  async function load() {
    loading = true;
    try {
      const res = await fetchNotifications();
      items = res.notifications;
      // Shared with the tab bar's dot, so the badge here and the dot there are
      // literally the same number.
      unreadNotifications.set(res.unreadCount);
    } catch {
      // A bell that cannot load is not worth a toast on every poll — the
      // badge simply stays where it was.
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    unsubscribe = onWsEvent('notification_tick', () => {
      // Only while the panel is open. The badge is driven by the shared count
      // in stores/notifications.js, which Chat.svelte keeps fresh for the
      // whole app — this component subscribing as well meant every
      // notification cost two HTTP requests, and two more at launch now that
      // the feed is the app's home screen.
      //
      // Refetching rather than incrementing is still right: the server applies
      // block filtering, so a locally maintained list would drift the moment
      // anything was blocked or expired.
      if (open) load();
    });
  });

  onDestroy(() => unsubscribe?.());

  async function toggle() {
    open = !open;
    if (!open) return;
    await load();

    // Marked read on open, not on tap. The badge answers "is there anything
    // new", and looking is the thing that makes it no longer new.
    if ($unreadNotifications > 0) {
      const previous = $unreadNotifications;
      clearUnreadLocally();
      try {
        await markNotificationsRead();
        items = items.map((n) => ({ ...n, read: true }));
      } catch (err) {
        unreadNotifications.set(previous);
        showToast(err?.message || 'Could not mark those read');
      }
    }
  }

  function openItem(item) {
    open = false;
    // A follow has no post to open, so it goes to the person instead.
    if (item.kind === 'follow') dispatch('profile', item.actorUsername);
    else if (item.postId) dispatch('open', { id: item.postId });
  }

  function relative(iso) {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  }
</script>

<div class="relative">
  <button
    on:click={toggle}
    class="p-1.5 rounded-lg transition-colors focus:outline-none relative
      {open ? 'text-vault-accent bg-vault-elevated' : 'text-vault-text-dim hover:text-vault-text'}"
    aria-label={$unreadNotifications > 0 ? `Notifications, ${$unreadNotifications} unread` : 'Notifications'}
    aria-expanded={open}
  >
    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M13.7 21a2 2 0 01-3.4 0" stroke-linecap="round" />
    </svg>

    {#if $unreadNotifications > 0}
      <!-- Keyed on the count so the badge re-animates when it changes, not
           only when it first appears. A badge whose whole job is to be noticed
           should not arrive silently. -->
      {#key $unreadNotifications}
      <span
        class="animate-badge-in absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-vault-accent
               text-vault-black text-[9px] font-bold flex items-center justify-center leading-none"
        aria-hidden="true"
      >{$unreadNotifications > 99 ? '99+' : $unreadNotifications}</span>
      {/key}
    {/if}
  </button>

  {#if open}
    <!-- Drops from the icon rather than fading in place: the panel is anchored
         to the bell, so it should look like it came from it. -->
    <div
      class="absolute right-0 top-9 z-40 w-72 max-h-96 overflow-y-auto rounded-xl
             bg-vault-surface border border-vault-border shadow-lg"
      use:clickOutside={() => (open = false)}
      transition:fly={{ y: -8, duration: 160 }}
    >
      <div class="px-3 py-2 border-b border-vault-border-subtle">
        <span class="text-[10px] uppercase tracking-wider text-vault-text-dim">Notifications</span>
      </div>

      {#if loading && items.length === 0}
        <div class="px-3 py-3 space-y-2" aria-busy="true">
          {#each Array(3) as _, i (i)}
            <div class="flex items-center gap-2" aria-hidden="true">
              <div class="skeleton w-7 h-7 rounded-full"></div>
              <div class="skeleton h-3 rounded" style="width: {50 + i * 8}%"></div>
            </div>
          {/each}
        </div>
      {:else if items.length === 0}
        <div class="px-3 py-6 text-center">
          <p class="text-xs text-vault-text-dim">Nothing yet</p>
          <p class="text-[10px] text-vault-text-dim mt-1">
            Likes, replies and follows show up here. They expire with the posts they are about.
          </p>
        </div>
      {:else}
        {#each items as item (item.id)}
          <button
            on:click={() => openItem(item)}
            class="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-vault-elevated transition-colors text-left focus:outline-none
              {item.read ? '' : 'bg-vault-accent/5'}"
          >
            <div
              class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
              style="background: {getAvatarGradient(item.actorUsername)}"
            >{item.actorUsername.charAt(0).toUpperCase()}</div>

            <div class="min-w-0 flex-1">
              <div class="text-xs text-vault-text">
                <strong class="font-semibold">@{item.actorUsername}</strong>
                <span class="text-vault-text-dim">{VERB[item.kind] ?? 'interacted'}</span>
                <span class="text-vault-text-dim">· {relative(item.createdAt)}</span>
              </div>
              {#if item.postExcerpt}
                <div class="text-[11px] text-vault-text-dim truncate mt-0.5">{item.postExcerpt}</div>
              {:else if item.kind !== 'follow'}
                <!-- The notification outlived its post by up to a reaper pass.
                     Saying so is better than rendering an empty quote. -->
                <div class="text-[11px] text-vault-text-dim italic mt-0.5">That post has expired</div>
              {/if}
            </div>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
