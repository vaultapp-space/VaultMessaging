<script>
  // ============================================================
  // Thoughts — the public feed
  // ============================================================
  // A third pane inside Chat.svelte, sibling to ChannelView, rather than a new
  // activeView. Chat.svelte owns the websocket, the sync loop and the call
  // handlers; rendering the feed as a top-level view would unmount all of it
  // and calls would stop arriving while someone scrolls.
  //
  // Global is a *sampled* view, not a complete one: the server caps how many
  // posts one author may take on a page, and the capped ones are dropped
  // rather than deferred. Following is the complete feed. That is why paging
  // reads `hasMore` and never `posts.length === limit`.
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';

  import {
    activeSection, activeThreadId, activeProfile, sidebarOpen,
  } from '../../lib/stores/session.js';
  import { fetchTimeline, likePost, unlikePost, searchPosts } from '../../lib/api/http.js';
  import {
    loadFilters, partitionFiltered, addFilter, removeFilter,
  } from '../../lib/posts/filters.js';
  import { clickOutside } from '../../lib/actions/clickOutside.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { pushBackHandler } from '../../lib/backHandler.js';
  import { onWsEvent, wsSend } from '../../lib/api/ws.js';
  import PostCard from './PostCard.svelte';
  import PostComposer from './PostComposer.svelte';
  import ThreadView from './ThreadView.svelte';
  import ProfilePane from './ProfilePane.svelte';
  import NotificationsBell from './NotificationsBell.svelte';

  let tab = 'global';
  let posts = [];
  let cursor = null;
  let hasMore = false;
  let loading = true;
  let loadingMore = false;
  let error = null;
  let scroller;
  let popBack = null;
  let hasNew = false;
  let lastSelfPostAt = 0;
  // The server's tick window is 5s (realtime/feed-ticker.js); this covers it
  // with enough slack for the round trip.
  const SELF_POST_QUIET_MS = 6000;
  const unsubscribers = [];
  let filters = [];
  let filtersOpen = false;
  let newFilter = '';
  let searchQuery = '';
  let searching = false;
  // Distinct from `posts` so leaving search restores the timeline without a
  // refetch — and so a slow search never overwrites the feed underneath it.
  let searchResults = null;

  // Applied in the browser, never sent to the server — see lib/posts/filters.js.
  // The count is surfaced rather than the posts silently vanishing: a feed that
  // quietly gets shorter reads as content failing to load.
  // Keyword filters apply to search results too — a filtered word should not
  // come back just because it was searched for by something else.
  $: ({ visible, hiddenCount } = partitionFiltered(searchResults ?? posts, filters));

  // Android back leaves the feed rather than the app, matching how a chat
  // behaves. Registered while this pane is mounted and popped on destroy.
  onMount(() => {
    popBack = pushBackHandler(() => {
      activeSection.set('chats');
      // Reopen the list on the way out. The tab bar closes the sidebar to
      // reveal this pane, so leaving without reopening it drops the user on
      // the empty "select a conversation" state with their chats nowhere in
      // sight — recoverable only by finding the Chats tab, which is not what
      // back should mean. Narrow viewports only: on desktop the sidebar is a
      // permanent column and this store does not govern it.
      if (window.innerWidth < 768) sidebarOpen.set(true);
    });
    filters = loadFilters();
    load();

    // The server sends a bare nudge, never a post — it cannot filter per
    // viewer at publish time, so pushing bodies would deliver a blocked user's
    // content to the person who blocked them. Refreshing pulls the timeline,
    // which applies blocks and mutes in SQL.
    wsSend({ type: 'watch_feed' });
    unsubscribers.push(
      onWsEvent('feed_tick', () => {
        // Your own post ticks too. The server coalesces per window and the
        // nudge carries no author — deliberately, since naming one would tell
        // every watcher, including people that author has blocked, that they
        // posted. So the client suppresses ticks just after posting instead.
        // A tick genuinely from someone else inside that window is lost, and
        // that is the right trade: a banner that fails to appear costs a few
        // seconds of freshness, while one pointing at a post already on screen
        // reads as broken.
        if (Date.now() - lastSelfPostAt < SELF_POST_QUIET_MS) return;
        // Only a banner, never an automatic prepend. Content appearing above
        // what someone is reading moves it under their thumb mid-sentence.
        // They refresh when they are ready.
        if (!$activeThreadId && !$activeProfile) hasNew = true;
      }),
    );
  });

  onDestroy(() => {
    popBack?.();
    // A socket left in the viewer set means every future tick writes to a pane
    // nobody is looking at.
    wsSend({ type: 'unwatch_feed' });
    for (const unsub of unsubscribers) unsub();
    activeThreadId.set(null);
    activeProfile.set(null);
  });

  async function refreshForNew() {
    hasNew = false;
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    await load();
  }

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

  // Top is a bounded snapshot, not a page — see posts.repo.top. Paging it
  // would serve duplicates as posts gain likes between requests.
  $: paginated = tab !== 'top';

  async function loadMore() {
    if (!paginated) return;
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

  let searchTimer = null;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = searchQuery.trim();
    if (q.length < 2) {
      searchResults = null;
      return;
    }
    // Debounced: the query is a substring scan, so one request per keystroke
    // is a scan per keystroke.
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        const res = await searchPosts(q);
        searchResults = res.posts;
      } catch (err) {
        showToast(err?.message || 'Could not search');
        searchResults = [];
      } finally {
        searching = false;
      }
    }, 300);
  }

  function clearSearch() {
    clearTimeout(searchTimer);
    searchQuery = '';
    searchResults = null;
  }

  async function switchTab(next) {
    clearSearch();
    if (tab === next) return;
    tab = next;
    posts = [];
    cursor = null;
    if (scroller) scroller.scrollTop = 0;
    await load();
  }

  // Optimistic, with rollback. A like that waits for a round trip before the
  // heart fills feels broken on a slow connection, and the server is the
  // authority on the resulting count either way.
  async function toggleLike(event) {
    const post = event.detail;
    const wasLiked = post.likedByMe;
    posts = posts.map((p) => (p.id === post.id
      ? { ...p, likedByMe: !wasLiked, likesCount: p.likesCount + (wasLiked ? -1 : 1) }
      : p));

    try {
      const res = wasLiked ? await unlikePost(post.id) : await likePost(post.id);
      posts = posts.map((p) => (p.id === post.id
        ? { ...p, likesCount: res.likesCount, likedByMe: res.likedByMe }
        : p));
    } catch (err) {
      posts = posts.map((p) => (p.id === post.id
        ? { ...p, likedByMe: wasLiked, likesCount: post.likesCount }
        : p));
      showToast(err?.message || 'Could not save that');
    }
  }

  // Prepended rather than refetched: the author should see their own post
  // immediately, and a refetch could drop it behind the per-author page cap.
  function onPosted(event) {
    posts = [event.detail, ...posts];
    lastSelfPostAt = Date.now();
  }

  function openThread(event) {
    activeThreadId.set(event.detail.id);
  }

  function openProfile(event) {
    // Clearing the thread matters: the branch below renders ThreadView
    // whenever activeThreadId is set, so opening a profile from inside a
    // thread previously set activeProfile and then rendered nothing new —
    // tapping a username in a thread looked like a dead control.
    activeThreadId.set(null);
    activeProfile.set(event.detail);
  }

  function submitFilter() {
    const word = newFilter.trim();
    if (!word) return;
    filters = addFilter(word);
    newFilter = '';
  }

  function dropFilter(word) {
    filters = removeFilter(word);
  }

  function onDeleted(event) {
    posts = posts.filter((p) => p.id !== event.detail.id);
  }

  // A repost from the timeline bumps the original's counter in place.
  function onReposted(event) {
    const { original } = event.detail;
    posts = posts.map((p) => (p.id === original.id
      ? { ...p, repostsCount: (p.repostsCount ?? 0) + 1 }
      : p));
  }
</script>

{#if $activeThreadId}
  <ThreadView
    postId={$activeThreadId}
    on:close={() => activeThreadId.set(null)}
    on:profile={openProfile}
    on:reposted={onReposted}
    on:deleted={onDeleted}
  />
{:else if $activeProfile}
  <!-- on:profile was missing, so tapping an author inside a profile — or a
       name in its follower list — dispatched into nothing. -->
  <ProfilePane
    username={$activeProfile}
    on:close={() => activeProfile.set(null)}
    on:open={openThread}
    on:profile={openProfile}
  />
{:else}
  <div class="flex-1 flex flex-col bg-vault-black min-w-0">
    <div class="px-4 py-3 border-b border-vault-border glass-strong relative z-10">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-sm font-semibold text-vault-text">Thoughts</h1>
          <p class="text-[10px] text-vault-text-dim mt-0.5">
            Public — anyone can read this. Deleted within 24 hours, like everything else.
          </p>
        </div>
        <!-- Top right, beside the title rather than in the tab row: it is not
             a view of the feed, it is a view of what happened to you. -->
        <NotificationsBell on:open={openThread} on:profile={openProfile} />
      </div>

      <div class="relative mt-2">
        <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-vault-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" stroke-linecap="round" />
        </svg>
        <input
          bind:value={searchQuery}
          on:input={onSearchInput}
          placeholder="Search posts…"
          class="w-full bg-vault-elevated border border-vault-border-subtle rounded-lg py-1.5 pl-7 pr-7 text-xs text-vault-text placeholder:text-vault-text-dim outline-none focus:border-vault-accent/40 transition-colors"
        />
        {#if searchQuery}
          <button
            on:click={clearSearch}
            class="absolute right-2 top-1/2 -translate-y-1/2 text-vault-text-dim hover:text-vault-text focus:outline-none"
            aria-label="Clear search"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        {/if}
      </div>

      <div class="flex items-center gap-1 mt-2.5">
        {#each [['global', 'Global'], ['top', 'Top'], ['following', 'Following']] as [value, label] (value)}
          <button
            on:click={() => switchTab(value)}
            class="px-3 py-1 rounded-lg text-xs transition-colors focus:outline-none
              {tab === value
                ? 'bg-vault-accent/15 text-vault-accent'
                : 'text-vault-text-dim hover:text-vault-text'}"
            aria-current={tab === value}
          >{label}</button>
        {/each}

        <!-- Keyword filters had no entry point at all until now: the list was
             loaded and applied, but nothing let anyone add a word to it, so
             the feature was unreachable. -->
        <div class="relative ml-auto" use:clickOutside={() => (filtersOpen = false)}>
          <button
            on:click={() => (filtersOpen = !filtersOpen)}
            class="px-2 py-1 rounded-lg text-xs transition-colors focus:outline-none
              {filters.length
                ? 'text-vault-accent'
                : 'text-vault-text-dim hover:text-vault-text'}"
            aria-expanded={filtersOpen}
            title="Hide posts containing certain words"
          >
            <svg class="w-3.5 h-3.5 inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {filters.length || ''}
          </button>

          {#if filtersOpen}
            <div class="absolute right-0 top-full mt-1 w-64 p-3 rounded-xl bg-vault-surface border border-vault-border shadow-lg z-20">
              <p class="text-[10px] text-vault-text-dim leading-relaxed">
                Hide posts containing a word. Kept on this device only — the
                server is never told what you filter.
              </p>

              <form on:submit|preventDefault={submitFilter} class="flex gap-1.5 mt-2">
                <input
                  bind:value={newFilter}
                  placeholder="word or phrase"
                  maxlength="40"
                  class="flex-1 px-2 py-1 rounded-lg bg-vault-black border border-vault-border text-xs text-vault-text placeholder:text-vault-text-dim outline-none focus:border-vault-accent"
                />
                <button
                  type="submit"
                  class="px-2.5 py-1 rounded-lg bg-vault-elevated text-xs text-vault-text focus:outline-none"
                >Add</button>
              </form>

              {#if filters.length}
                <div class="flex flex-wrap gap-1 mt-2">
                  {#each filters as word (word)}
                    <button
                      on:click={() => dropFilter(word)}
                      class="px-2 py-0.5 rounded-full bg-vault-elevated text-[10px] text-vault-text-dim hover:text-vault-danger focus:outline-none"
                      title="Remove this filter"
                    >{word} ×</button>
                  {/each}
                </div>
              {:else}
                <p class="text-[10px] text-vault-text-dim mt-2">No filters yet.</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Floating rather than in flow: inserting a bar above the scroller would
         shift everything below it down by its height the moment it appears,
         which is the same reading-position problem the banner exists to
         avoid. -->
    {#if hasNew}
      <div class="relative z-20 flex justify-center" transition:fade={{ duration: 150 }}>
        <button
          on:click={refreshForNew}
          class="absolute top-2 px-3.5 py-1.5 rounded-full bg-vault-accent text-vault-black text-[11px] font-semibold shadow-lg focus:outline-none"
        >New posts ↑</button>
      </div>
    {/if}

    <div bind:this={scroller} on:scroll={onScroll} class="flex-1 overflow-y-auto">
      <PostComposer on:posted={onPosted} />

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
      {:else if searchResults !== null && visible.length === 0}
        <div class="text-center py-14 px-6">
          <p class="text-xs text-vault-text-dim">
            {searching ? 'Searching…' : 'Nothing matches that'}
          </p>
          <p class="text-[10px] text-vault-text-dim mt-1">
            Search only covers the last 24 hours — everything older has already been deleted.
          </p>
        </div>
      {:else}
        {#each visible as post (post.id)}
          <PostCard
            {post}
            on:open={openThread}
            on:profile={openProfile}
            on:like={toggleLike}
            on:reposted={onReposted}
            on:deleted={onDeleted}
          />
        {/each}

        {#if hiddenCount > 0}
          <div class="py-3 text-center text-[10px] text-vault-text-dim">
            {hiddenCount} {hiddenCount === 1 ? 'post' : 'posts'} hidden by your filters
          </div>
        {/if}

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
