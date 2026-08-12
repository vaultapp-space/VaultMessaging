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
    likePost, unlikePost,
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
  let loading = true;
  let error = null;
  let popBack = null;

  onMount(() => {
    popBack = pushBackHandler(() => dispatch('close'));
    load();
    return () => popBack?.();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const [{ profile: p }, listed] = await Promise.all([
        fetchUserProfile(username),
        fetchUserPosts(username),
      ]);
      profile = p;
      posts = listed.posts;
    } catch (err) {
      error = err.message || 'This profile is not available';
    } finally {
      loading = false;
    }
  }

  $: initial = (username ?? '?').charAt(0).toUpperCase();
  // No follow or mute button on your own profile — both would be refused by
  // the server (409) and neither means anything.
  $: isSelf = profile && $currentUser && profile.id === $currentUser.id;

  let busy = false;

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

  <div class="flex-1 overflow-y-auto">
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
            <div class="text-[11px] text-vault-text-dim mt-0.5">
              <strong class="text-vault-text">{profile.followersCount}</strong> followers
              <span class="mx-1">·</span>
              <strong class="text-vault-text">{profile.followingCount}</strong> following
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

      {#if posts.length === 0}
        <div class="text-center py-14 px-6">
          <p class="text-xs text-vault-text-dim">Nothing in the last 24 hours</p>
          <p class="text-[10px] text-vault-text-dim mt-1">
            Posts expire, so a profile only ever shows the last day.
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
