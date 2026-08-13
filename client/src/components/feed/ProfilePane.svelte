<script>
  // ============================================================
  // A user's public profile
  // ============================================================
  // The header the server already computes (follower counts and the viewer's
  // relationship), that user's top-level posts, and follow/mute.
  //
  // A blocked user's profile 404s server-side, deliberately — a profile that
  // renders for someone you blocked is a hole in the block — so the error
  // state below is the honest rendering of that, not a special case.
  import { createEventDispatcher, onMount } from 'svelte';

  import {
    fetchUserProfile, fetchUserPosts, followUser, unfollowUser, muteUser, unmuteUser,
    likePost, unlikePost, fetchFollowList,
  } from '../../lib/api/http.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { currentUser } from '../../lib/stores/session.js';
  import { getAvatarGradient } from '../../lib/avatar.js';
  import { pushBackHandler } from '../../lib/backHandler.js';
  import PostCard from './PostCard.svelte';

  export let username;

  const dispatch = createEventDispatcher();

  let profile = null;
  let posts = [];
  // The API has always returned hasMore and a cursor here; nothing read them,
  // so a profile stopped dead at the first page with no sign there was more.
  let cursor = null;
  let hasMore = false;
  let loadingMore = false;
  let scroller;
  let loading = true;
  let error = null;
  let popBack = null;

  onMount(() => {
    popBack = pushBackHandler(() => dispatch('close'));
    load();
    return () => popBack?.();
  });

  // 'posts' or 'replies'. Separate views rather than one merged list: a reply
  // shown outside its thread reads as a non-sequitur, with the half that gave
  // it meaning missing.
  let kind = 'posts';

  async function load() {
    loading = true;
    error = null;
    try {
      const [{ profile: p }, listed] = await Promise.all([
        fetchUserProfile(username),
        fetchUserPosts(username, { kind }),
      ]);
      profile = p;
      posts = listed.posts;
      cursor = listed.nextCursor;
      hasMore = listed.hasMore;
    } catch (err) {
      error = err.message || 'This profile is not available';
    } finally {
      loading = false;
    }
  }

  async function switchKind(next) {
    if (kind === next) return;
    kind = next;
    posts = [];
    // Leaves the follower list if it was open — otherwise switching to
    // Replies appears to do nothing, because the list is rendered in place of
    // the posts.
    listDirection = null;
    loading = true;
    try {
      const listed = await fetchUserPosts(username, { kind });
      posts = listed.posts;
      cursor = listed.nextCursor;
      hasMore = listed.hasMore;
    } catch (err) {
      showToast(err?.message || 'Could not load those');
    } finally {
      loading = false;
    }
  }

  $: initial = (username ?? '?').charAt(0).toUpperCase();
  // No follow or mute button on your own profile — both would be refused by
  // the server (409) and neither means anything.
  $: isSelf = profile && $currentUser && profile.id === $currentUser.id;

  let busy = false;

  // ─── Follower / following list ──────────────────────────
  // The counts used to be plain text, so there was no way to find out *who* —
  // the server has always had the endpoint, and nothing called it.
  let listDirection = null;   // 'followers' | 'following' | null
  let listUsers = [];
  let listLoading = false;
  let listError = null;

  async function openList(direction) {
    listDirection = direction;
    listLoading = true;
    listError = null;
    listUsers = [];
    try {
      const res = await fetchFollowList(profile.id, direction);
      listUsers = res.users;
    } catch (err) {
      listError = err?.message || 'Could not load that list';
    } finally {
      listLoading = false;
    }
  }

  // Opening someone from the list replaces this pane rather than stacking
  // another one: the parent owns which profile is shown, so a second
  // ProfilePane inside this one would be a component rendering itself with no
  // way back out.
  function openFromList(username) {
    listDirection = null;
    dispatch('profile', username);
  }

  // Handled here rather than forwarded: this component owns `posts`, and an
  // event bubbled to Thoughts would have nothing to update — its own timeline
  // array does not contain these rows.
  async function toggleLike(event) {
    const target = event.detail;
    const wasLiked = target.likedByMe;
    posts = posts.map((p) => (p.id === target.id
      ? { ...p, likedByMe: !wasLiked, likesCount: p.likesCount + (wasLiked ? -1 : 1) }
      : p));
    try {
      const res = wasLiked ? await unlikePost(target.id) : await likePost(target.id);
      posts = posts.map((p) => (p.id === target.id
        ? { ...p, likesCount: res.likesCount, likedByMe: res.likedByMe }
        : p));
    } catch (err) {
      posts = posts.map((p) => (p.id === target.id
        ? { ...p, likedByMe: wasLiked, likesCount: target.likesCount }
        : p));
      showToast(err?.message || 'Could not save that');
    }
  }

  async function loadMore() {
    if (!hasMore || loadingMore || listDirection) return;
    loadingMore = true;
    try {
      const listed = await fetchUserPosts(username, { kind, cursor });
      // De-duplicated for the same reason the timeline is: a post arriving
      // between two fetches shifts the window and can return on both sides.
      const seen = new Set(posts.map((p) => p.id));
      posts = [...posts, ...listed.posts.filter((p) => !seen.has(p.id))];
      cursor = listed.nextCursor;
      hasMore = listed.hasMore;
    } catch (err) {
      showToast(err?.message || 'Could not load more');
    } finally {
      loadingMore = false;
    }
  }

  function onScroll() {
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < 600) loadMore();
  }

  function onDeleted(event) {
    posts = posts.filter((p) => p.id !== event.detail.id);
  }

  function onReposted(event) {
    const { original } = event.detail;
    posts = posts.map((p) => (p.id === original.id
      ? { ...p, repostsCount: (p.repostsCount ?? 0) + 1 }
      : p));
  }

  // Optimistic, with rollback, for the same reason likes are: a follow button
  // that waits for a round trip before changing reads as an unresponsive tap.
  async function toggleFollow() {
    if (busy || !profile) return;
    busy = true;
    const was = profile.following;
    profile = {
      ...profile,
      following: !was,
      followersCount: profile.followersCount + (was ? -1 : 1),
    };
    try {
      await (was ? unfollowUser(profile.id) : followUser(profile.id));
    } catch (err) {
      profile = { ...profile, following: was, followersCount: profile.followersCount + (was ? 1 : -1) };
      showToast(err?.message || 'Could not save that');
    } finally {
      busy = false;
    }
  }

  // Mute is one-way and silent: nothing is sent to the other person, and their
  // own feed is unaffected. It is the softer sibling of a block, which also
  // stops DMs and is symmetric.
  async function toggleMute() {
    if (busy || !profile) return;
    busy = true;
    const was = profile.muted;
    profile = { ...profile, muted: !was };
    try {
      await (was ? unmuteUser(profile.id) : muteUser(profile.id));
      showToast(was ? `Unmuted @${profile.username}` : `Muted @${profile.username}`, { type: 'success' });
      // Their posts are filtered server-side from here on, so what is already
      // rendered is stale.
      if (!was) posts = [];
    } catch (err) {
      profile = { ...profile, muted: was };
      showToast(err?.message || 'Could not save that');
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex-1 flex flex-col bg-vault-black min-w-0">
  <div class="px-4 py-3 border-b border-vault-border glass-strong flex items-center gap-3 relative z-10">
    <button
      on:click={() => dispatch('close')}
      class="text-vault-text-dim hover:text-vault-text focus:outline-none"
      aria-label="Back"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <h1 class="text-sm font-semibold text-vault-text truncate">@{username}</h1>
  </div>

  <div bind:this={scroller} on:scroll={onScroll} class="flex-1 overflow-y-auto">
    {#if loading}
      <div class="px-4 py-5 flex items-center gap-3" aria-busy="true" aria-label="Loading profile">
        <div class="skeleton w-14 h-14 rounded-full" aria-hidden="true"></div>
        <div class="flex-1 flex flex-col gap-2" aria-hidden="true">
          <div class="skeleton h-3 rounded" style="width: 40%"></div>
          <div class="skeleton h-3 rounded" style="width: 60%"></div>
        </div>
      </div>
    {:else if error}
      <div class="text-center py-16 px-6">
        <p class="text-xs text-vault-text-dim">{error}</p>
      </div>
    {:else}
      <div class="px-4 py-5 border-b border-vault-border-subtle">
        <div class="flex items-center gap-3">
          <div
            class="w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold text-white"
            style="background: {getAvatarGradient(profile.username)}"
          >{initial}</div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-vault-text truncate">@{profile.username}</div>
            <!-- Tappable. These were plain text, so the one question a
                 follower count raises — who? — had no answer anywhere in the
                 app, despite the server having served it all along. -->
            <div class="text-[11px] text-vault-text-dim mt-0.5">
              <button
                on:click={() => openList('followers')}
                class="hover:text-vault-text transition-colors focus:outline-none"
              >
                <strong class="text-vault-text">{profile.followersCount}</strong> followers
              </button>
              <span class="mx-1">·</span>
              <button
                on:click={() => openList('following')}
                class="hover:text-vault-text transition-colors focus:outline-none"
              >
                <strong class="text-vault-text">{profile.followingCount}</strong> following
              </button>
            </div>
          </div>
        </div>

        {#if !isSelf}
          <div class="flex gap-2 mt-4">
            <button
              on:click={toggleFollow}
              disabled={busy}
              class="flex-1 py-2 rounded-xl text-xs font-semibold transition-all focus:outline-none disabled:opacity-50
                {profile.following
                  ? 'bg-vault-elevated text-vault-text border border-vault-border'
                  : 'bg-vault-accent text-vault-black'}"
            >{profile.following ? 'Following' : 'Follow'}</button>

            <button
              on:click={toggleMute}
              disabled={busy}
              class="px-3 py-2 rounded-xl text-xs border transition-all focus:outline-none disabled:opacity-50
                {profile.muted
                  ? 'bg-vault-warning/15 text-vault-warning border-vault-warning/30'
                  : 'bg-vault-elevated text-vault-text-dim border-vault-border hover:text-vault-text'}"
              title="Muting hides their posts from your feed. They are not told."
            >{profile.muted ? 'Muted' : 'Mute'}</button>
          </div>
        {/if}
      </div>

      <!-- Posts / Replies. Shown for everyone, not just yourself: a reply you
           made was previously unreachable from anywhere in the app once it
           left the thread. -->
      <div class="flex items-center gap-1 px-4 py-2 border-b border-vault-border-subtle">
        {#each [['posts', 'Posts'], ['replies', 'Replies']] as [value, label] (value)}
          <button
            on:click={() => switchKind(value)}
            class="px-3 py-1 rounded-lg text-xs transition-colors focus:outline-none
              {kind === value && !listDirection
                ? 'bg-vault-accent/15 text-vault-accent'
                : 'text-vault-text-dim hover:text-vault-text'}"
            aria-current={kind === value && !listDirection}
          >{label}</button>
        {/each}
      </div>

      {#if listDirection}
        <!-- Rendered in place of the posts rather than as a modal: it is a
             different view of the same person, and a dialog over a pane that
             is itself a detail view stacks two dismiss gestures on one
             screen. -->
        <div class="border-b border-vault-border-subtle">
          <div class="px-4 py-2 flex items-center justify-between">
            <span class="text-[10px] uppercase tracking-wider text-vault-text-dim">
              {listDirection === 'followers' ? 'Followers' : 'Following'}
            </span>
            <button
              on:click={() => (listDirection = null)}
              class="text-[10px] text-vault-accent hover:underline focus:outline-none"
            >Back to posts</button>
          </div>

          {#if listLoading}
            <div class="px-4 pb-3 space-y-2" aria-busy="true">
              {#each Array(3) as _, i (i)}
                <div class="flex items-center gap-3" aria-hidden="true">
                  <div class="skeleton w-8 h-8 rounded-full"></div>
                  <div class="skeleton h-3 rounded" style="width: {35 + i * 10}%"></div>
                </div>
              {/each}
            </div>
          {:else if listError}
            <p class="px-4 pb-4 text-xs text-vault-text-dim">{listError}</p>
          {:else if listUsers.length === 0}
            <p class="px-4 pb-4 text-xs text-vault-text-dim">
              {listDirection === 'followers'
                ? 'Nobody yet.'
                : 'Not following anyone yet.'}
            </p>
          {:else}
            {#each listUsers as user (user.id)}
              <button
                on:click={() => openFromList(user.username)}
                class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-vault-elevated transition-colors text-left focus:outline-none"
              >
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white flex-shrink-0"
                  style="background: {getAvatarGradient(user.username)}"
                >{user.username.charAt(0).toUpperCase()}</div>
                <span class="text-sm text-vault-text truncate">@{user.username}</span>
              </button>
            {/each}
          {/if}
        </div>
      {:else if posts.length === 0}
        <div class="text-center py-14 px-6">
          <p class="text-xs text-vault-text-dim">
            {kind === 'replies' ? 'No replies in the last 24 hours' : 'Nothing in the last 24 hours'}
          </p>
          <p class="text-[10px] text-vault-text-dim mt-1">
            {kind === 'replies'
              ? 'A reply expires with the post it answers, so it can vanish sooner.'
              : 'Posts expire, so a profile only ever shows the last day.'}
          </p>
        </div>
      {:else}
        {#each posts as post (post.id)}
          <PostCard {post} on:open on:profile on:like={toggleLike} on:reposted={onReposted} on:deleted={onDeleted} />
        {/each}
      {/if}
    {/if}
  </div>
</div>
