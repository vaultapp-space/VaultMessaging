<script>
  // ============================================================
  // A user's public profile
  // ============================================================
  // Read-only in this phase: follow, mute and block controls arrive with the
  // write path. What is here is the header the server already computes
  // (follower counts and the viewer's relationship) and that user's top-level
  // posts.
  //
  // A blocked user's profile 404s server-side, deliberately — a profile that
  // renders for someone you blocked is a hole in the block — so the error
  // state below is the honest rendering of that, not a special case.
  import { createEventDispatcher, onMount } from 'svelte';

  import { fetchUserProfile, fetchUserPosts } from '../../lib/api/http.js';
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
            {#if profile.following}
              <div class="text-[10px] text-vault-accent mt-1">You follow them</div>
            {/if}
          </div>
        </div>
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
          <PostCard {post} on:open on:profile />
        {/each}
      {/if}
    {/if}
  </div>
</div>
