<script>
  // ============================================================
  // A post and its replies
  // ============================================================
  // Threads are flat by design (depth 2 in the schema), so this is a root and
  // a list, not a tree. Replies read oldest-first — a conversation runs
  // downward — which is the opposite of the timeline and intentional.
  import { createEventDispatcher, onMount } from 'svelte';

  import { fetchPost, fetchPostReplies, likePost, unlikePost } from '../../lib/api/http.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { pushBackHandler } from '../../lib/backHandler.js';
  import PostCard from './PostCard.svelte';
  import PostComposer from './PostComposer.svelte';

  export let postId;

  const dispatch = createEventDispatcher();

  let root = null;
  let replies = [];
  let loading = true;
  let error = null;
  let popBack = null;

  onMount(() => {
    // Registered above the feed's own handler, so back closes the thread
    // before it closes the feed.
    popBack = pushBackHandler(() => dispatch('close'));
    load();
    return () => popBack?.();
  });

  // A reply lands under the root immediately and bumps the count shown on it,
  // rather than refetching — the server has already accepted it, and a round
  // trip here would make posting feel slower than it is.
  function onDeleted(event) {
    // Deleting the root leaves nothing to render, so the thread closes and the
    // timeline handles removing it. A deleted reply just leaves the list.
    if (event.detail.id === postId) {
      dispatch('close');
      return;
    }
    replies = replies.filter((r) => r.id !== event.detail.id);
    if (root) root = { ...root, repliesCount: Math.max(0, root.repliesCount - 1) };
  }

  function onReplied(event) {
    replies = [...replies, event.detail];
    if (root) root = { ...root, repliesCount: root.repliesCount + 1 };
  }

  async function toggleLike(event) {
    const target = event.detail;
    const wasLiked = target.likedByMe;
    const patch = (p) => (p && p.id === target.id
      ? { ...p, likedByMe: !wasLiked, likesCount: p.likesCount + (wasLiked ? -1 : 1) }
      : p);
    root = patch(root);
    replies = replies.map(patch);

    try {
      const res = wasLiked ? await unlikePost(target.id) : await likePost(target.id);
      const settle = (p) => (p && p.id === target.id
        ? { ...p, likesCount: res.likesCount, likedByMe: res.likedByMe }
        : p);
      root = settle(root);
      replies = replies.map(settle);
    } catch (err) {
      const rollback = (p) => (p && p.id === target.id
        ? { ...p, likedByMe: wasLiked, likesCount: target.likesCount }
        : p);
      root = rollback(root);
      replies = replies.map(rollback);
      showToast(err?.message || 'Could not save that');
    }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      // The root is fetched first and separately: the server 404s the replies
      // of a root the viewer cannot see, so a blocked or removed root hides
      // the whole thread rather than leaving the replies reachable alone.
      const { post } = await fetchPost(postId);
      root = post;
      const res = await fetchPostReplies(postId);
      replies = res.posts;
    } catch (err) {
      error = err.message || 'This post is no longer available';
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex-1 flex flex-col bg-vault-black min-w-0">
  <div class="px-4 py-3 border-b border-vault-border glass-strong flex items-center gap-3 relative z-10">
    <button
      on:click={() => dispatch('close')}
      class="text-vault-text-dim hover:text-vault-text focus:outline-none"
      aria-label="Back to the feed"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <h1 class="text-sm font-semibold text-vault-text">Thread</h1>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if loading}
      <div class="px-4 py-3 space-y-4" aria-busy="true" aria-label="Loading thread">
        {#each Array(3) as _, i (i)}
          <div class="flex gap-3" style="opacity: {1 - i * 0.2}" aria-hidden="true">
            <div class="skeleton w-9 h-9 rounded-full flex-shrink-0"></div>
            <div class="flex-1 flex flex-col gap-2">
              <div class="skeleton h-3 rounded" style="width: {45 + ((i * 19) % 30)}%"></div>
              <div class="skeleton h-3 rounded" style="width: 75%"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if error}
      <div class="text-center py-16 px-6">
        <p class="text-xs text-vault-text-dim">{error}</p>
        <p class="text-[10px] text-vault-text-dim mt-1">
          It may have expired, or been removed.
        </p>
      </div>
    {:else}
      <PostCard post={root} interactive={false} on:profile on:like={toggleLike} on:reposted on:deleted={onDeleted} />

      <PostComposer
        replyToId={postId}
        placeholder="Reply. It expires when this post does."
        on:posted={onReplied}
      />

      <div class="px-4 py-2 text-[10px] text-vault-text-dim uppercase tracking-wider border-b border-vault-border-subtle">
        {replies.length === 0 ? 'No replies' : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
      </div>

      {#each replies as reply (reply.id)}
        <PostCard post={reply} interactive={false} on:profile on:like={toggleLike} on:reposted on:deleted={onDeleted} />
      {/each}
    {/if}
  </div>
</div>
