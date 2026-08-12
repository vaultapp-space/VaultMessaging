<script>
  // ============================================================
  // Thoughts — the public feed
  // ============================================================
  // A third pane inside Chat.svelte, sibling to ChannelView, rather than a new
  // activeView. Chat.svelte owns the websocket, the sync loop and the call
  // handlers; rendering the feed as a top-level view would unmount all of it
  // and calls would stop arriving while someone scrolls.
  //
  // Read-only for now: composing, liking and following arrive with the write
  // path. The timeline, threads and profiles are useful on their own and get
  // the risky part — rendering stranger-authored content — in front of real
  // use first.
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';

  import {
    activeSection, activeThreadId, activeProfile,
  } from '../../lib/stores/session.js';
  import { fetchTimeline } from '../../lib/api/http.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { pushBackHandler } from '../../lib/backHandler.js';
  import PostCard from './PostCard.svelte';
  import ThreadView from './ThreadView.svelte';
  import ProfilePane from './ProfilePane.svelte';

  let tab = 'global';
  let posts = [];
  let cursor = null;
  let hasMore = false;
  let loading = true;
  let loadingMore = false;
  let error = null;
  let scroller;
  let popBack = null;

  // Android back leaves the feed rather than the app, matching how a chat
  // behaves. Registered while this pane is mounted and popped on destroy.
  onMount(() => {
    popBack = pushBackHandler(() => activeSection.set('chats'));
    load();
  });

  onDestroy(() => {
    popBack?.();
    activeThreadId.set(null);
    activeProfile.set(null);
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetchTimeline({ tab });
      posts = res.posts;
      cursor = res.nextCursor;
      hasMore = res.hasMore;
    } catch (err) {
      error = err.message || 'Could not load the feed';
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    // Paged on `hasMore`, never on `posts.length === limit`: the global tab
    // caps how many posts one author may take on a page, so a full page can
    // legitimately come back short.
    if (!hasMore || loadingMore) return;
    loadingMore = true;
    try {
      const res = await fetchTimeline({ tab, cursor });
      // De-duplicated by id rather than appended blindly — a post arriving
      // between two page fetches shifts the window, and the same row can come
      // back on both sides of it.
      const seen = new Set(posts.map((p) => p.id));
      posts = [...posts, ...res.posts.filter((p) => !seen.has(p.id))];
      cursor = res.nextCursor;
      hasMore = res.hasMore;
    } catch (err) {
      showToast(err.message || 'Could not load more posts');
    } finally {
      loadingMore = false;
    }
  }

  function onScroll() {
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < 600) loadMore();
  }

  async function switchTab(next) {
    if (tab === next) return;
    tab = next;
    posts = [];
    cursor = null;
    if (scroller) scroller.scrollTop = 0;
    await load();
  }

  function openThread(event) {
    activeThreadId.set(event.detail.id);
  }

  function openProfile(event) {
    activeProfile.set(event.detail);
  }
</script>

{#if $activeThreadId}
  <ThreadView
    postId={$activeThreadId}
    on:close={() => activeThreadId.set(null)}
    on:profile={openProfile}
  />
{:else if $activeProfile}
  <ProfilePane
    username={$activeProfile}
    on:close={() => activeProfile.set(null)}
    on:open={openThread}
  />
{:else}
  <div class="flex-1 flex flex-col bg-vault-black min-w-0">
    <div class="px-4 py-3 border-b border-vault-border glass-strong relative z-10">
      <h1 class="text-sm font-semibold text-vault-text">Thoughts</h1>
      <p class="text-[10px] text-vault-text-dim mt-0.5">
        Public — anyone can read this. Deleted within 24 hours, like everything else.
      </p>

      <div class="flex gap-1 mt-2.5">
        {#each [['global', 'Global'], ['following', 'Following']] as [value, label] (value)}
          <button
            on:click={() => switchTab(value)}
            class="px-3 py-1 rounded-lg text-xs transition-colors focus:outline-none
              {tab === value
                ? 'bg-vault-accent/15 text-vault-accent'
                : 'text-vault-text-dim hover:text-vault-text'}"
            aria-current={tab === value}
          >{label}</button>
        {/each}
      </div>
    </div>

    <div bind:this={scroller} on:scroll={onScroll} class="flex-1 overflow-y-auto">
      {#if loading}
        <div class="px-4 py-3 space-y-4" aria-busy="true" aria-label="Loading posts">
          {#each Array(5) as _, i (i)}
            <div class="flex gap-3" style="opacity: {1 - i * 0.15}" aria-hidden="true">
              <div class="skeleton w-9 h-9 rounded-full flex-shrink-0"></div>
              <div class="flex-1 flex flex-col gap-2">
                <div class="skeleton h-3 rounded" style="width: {40 + ((i * 17) % 25)}%"></div>
                <div class="skeleton h-3 rounded" style="width: {70 + ((i * 23) % 25)}%"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if error}
        <div class="text-center py-16 px-6">
          <p class="text-xs text-vault-danger">{error}</p>
          <button on:click={load} class="text-[11px] text-vault-accent hover:underline mt-2 focus:outline-none">
            Try again
          </button>
        </div>
      {:else if posts.length === 0}
        <div class="text-center py-16 px-6" in:fade={{ duration: 200 }}>
          <div class="w-12 h-12 rounded-2xl bg-vault-elevated flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          {#if tab === 'following'}
            <p class="text-xs text-vault-text-dim">Nothing from anyone you follow</p>
            <p class="text-[10px] text-vault-text-dim mt-1">
              Find people on Global and follow them to fill this up.
            </p>
          {:else}
            <!-- Says "expired", not "nobody has posted". A quiet feed on a
                 product where everything dies in a day reads as broken unless
                 the reason is spelled out — the same lesson ChannelView's
                 empty state already learned. -->
            <p class="text-xs text-vault-text-dim">No posts in the last 24 hours</p>
            <p class="text-[10px] text-vault-text-dim mt-1">
              Everything here expires. Whatever was posted yesterday is already gone.
            </p>
          {/if}
        </div>
      {:else}
        {#each posts as post (post.id)}
          <PostCard {post} on:open={openThread} on:profile={openProfile} />
        {/each}

        {#if loadingMore}
          <div class="py-4 text-center text-[10px] text-vault-text-dim">Loading…</div>
        {:else if !hasMore}
          <div class="py-6 text-center text-[10px] text-vault-text-dim">
            That's everything from the last 24 hours.
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
