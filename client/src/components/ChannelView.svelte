<script>
  // ============================================================
  // Channel view
  // ============================================================
  // A broadcast feed. Admins post; everyone else reads and comments.
  //
  // Two things here are not cosmetic:
  //
  //   - The empty state has to say posts *expired*, not that nothing was
  //     posted. A channel is exactly what people expect to be an archive, so
  //     an unexplained empty feed reads as data loss. This is the most
  //     surprising consequence of the 24h rule in the whole product.
  //
  //   - `watch_channel` over the socket is what makes a post cost O(1) on the
  //     server: it delivers to whoever is looking, and everyone else pulls on
  //     open. Forgetting to unwatch leaks the socket into a viewer set.

  import { onMount, onDestroy } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import {
    fetchChannel, fetchChannelPosts, postToChannel, markPostViewed,
    subscribeChannel, unsubscribeChannel, fetchPostComments, commentOnPost,
    updateChannelSettings,
  } from '../lib/api/http.js';
  import { onWsEvent, wsSend } from '../lib/api/ws.js';
  import { getAvatarGradient } from '../lib/avatar.js';

  export let chatId;
  export let onClose = null;

  let channel = null;
  let posts = [];
  let loading = true;
  let error = '';
  let draft = '';
  // Multi-line entry is now reachable on native Android (see the textarea's
  // keydown handler below), which a fixed rows="1" box would just scroll
  // instead of showing — same fix as ChatView.svelte's composer.
  let composerEl;
  $: if (composerEl) { void draft; autoGrowComposer(); }
  function autoGrowComposer() {
    composerEl.style.height = 'auto';
    composerEl.style.height = Math.min(composerEl.scrollHeight, 120) + 'px';
  }
  let posting = false;

  // Comments are loaded per post, on demand: fetching every thread up front
  // would make opening a busy channel a burst of requests for content most
  // readers never expand.
  let openThread = null;
  let comments = [];
  let commentDraft = '';
  let commentBusy = false;

  const unsubscribers = [];
  const viewed = new Set();

  onMount(async () => {
    await load();
    wsSend({ type: 'watch_channel', chatId });

    unsubscribers.push(
      onWsEvent('channel_post', (data) => {
        if (data.chatId !== chatId) return;
        if (posts.some((p) => p.seq === data.seq)) return;
        posts = [...posts, data];
      }),
      onWsEvent('thread_updated', (data) => {
        if (data.chatId !== chatId) return;
        posts = posts.map((p) =>
          p.seq === data.seq ? { ...p, repliesCount: data.repliesCount } : p
        );
      }),
    );
  });

  onDestroy(() => {
    // A socket left in the viewer set means every future post writes to a
    // view nobody is looking at.
    wsSend({ type: 'unwatch_channel', chatId });
    for (const unsub of unsubscribers) unsub();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      channel = await fetchChannel(chatId);
      const res = await fetchChannelPosts(chatId);
      posts = res.posts ?? [];
    } catch (err) {
      console.error('Failed to load channel:', err);
      error = 'Could not load this channel.';
    } finally {
      loading = false;
    }
  }

  async function publish() {
    const body = draft.trim();
    if (!body || posting) return;
    posting = true;
    try {
      const created = await postToChannel(chatId, { body });
      // The socket echo is filtered by seq, so inserting here is safe and
      // makes the post appear immediately rather than on round-trip.
      if (!posts.some((p) => p.seq === created.seq)) posts = [...posts, created];
      draft = '';
    } catch (err) {
      console.error('Failed to post:', err);
      error = 'Could not publish that post.';
    } finally {
      posting = false;
    }
  }

  async function toggleSubscription() {
    try {
      if (channel.subscribed) {
        await unsubscribeChannel(chatId);
      } else {
        await subscribeChannel(chatId);
      }
      channel = { ...channel, subscribed: !channel.subscribed };
    } catch (err) {
      console.error('Failed to change subscription:', err);
      error = 'Could not change your subscription.';
    }
  }

  // Counted once per reader, server-side. Fired when a post first renders
  // rather than on scroll, which is close enough and avoids an observer.
  async function countView(post) {
    if (viewed.has(post.seq)) return;
    viewed.add(post.seq);
    try {
      const { views } = await markPostViewed(chatId, post.seq);
      posts = posts.map((p) => (p.seq === post.seq ? { ...p, views } : p));
    } catch {
      // A missed view count is not worth surfacing to anyone.
    }
  }

  async function openComments(post) {
    if (openThread === post.seq) {
      openThread = null;
      return;
    }
    openThread = post.seq;
    comments = [];
    try {
      const res = await fetchPostComments(chatId, post.seq);
      comments = res.comments ?? [];
    } catch (err) {
      console.error('Failed to load comments:', err);
    }
  }

  async function submitComment() {
    const body = commentDraft.trim();
    if (!body || commentBusy || openThread == null) return;
    commentBusy = true;
    try {
      await commentOnPost(chatId, openThread, body);
      const res = await fetchPostComments(chatId, openThread);
      comments = res.comments ?? [];
      commentDraft = '';
    } catch (err) {
      console.error('Failed to comment:', err);
      error = 'Could not post that comment.';
    } finally {
      commentBusy = false;
    }
  }

  async function toggleSignatures() {
    try {
      channel = {
        ...channel,
        ...(await updateChannelSettings(chatId, {
          signaturesEnabled: !channel.signaturesEnabled,
        })),
      };
    } catch (err) {
      console.error('Failed to change signatures:', err);
    }
  }

  // Counts a view the first time a post is rendered. An action rather than a
  // per-post onMount, because posts arrive over the socket as well as from
  // the initial load and both paths need it.
  function seen(node, post) {
    countView(post);
    return {};
  }

  function timeOf(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="flex-1 flex flex-col bg-vault-black h-full animate-fade-in">
  <!-- Header -->
  <div class="flex items-center gap-3 px-4 py-3 border-b border-vault-border glass-strong relative z-40">
    {#if onClose}
      <button
        on:click={onClose}
        class="p-1.5 rounded-lg text-vault-text-dim hover:text-vault-text focus:outline-none"
        aria-label="Back"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    {/if}

    <div
      class="w-10 h-10 rounded-xl flex items-center justify-center text-vault-white text-sm font-semibold shrink-0"
      style="background: {getAvatarGradient(channel?.title || 'channel')}"
    >
      {(channel?.title || '?')[0].toUpperCase()}
    </div>

    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-vault-text truncate">
        {channel?.title || 'Channel'}
      </div>
      <div class="text-[10px] text-vault-text-dim">
        {channel?.subscribersCount ?? 0} subscribers
        {#if channel?.username}· @{channel.username}{/if}
      </div>
    </div>

    {#if channel && !channel.canPost}
      <button
        on:click={toggleSubscription}
        class="px-3 py-1.5 rounded-lg text-xs font-medium focus:outline-none
          {channel.subscribed
            ? 'bg-vault-elevated text-vault-text-dim'
            : 'bg-vault-accent text-vault-black'}"
      >{channel.subscribed ? 'Subscribed' : 'Subscribe'}</button>
    {:else if channel?.canPost}
      <button
        on:click={toggleSignatures}
        class="px-2 py-1 rounded-lg text-[10px] focus:outline-none
          {channel.signaturesEnabled
            ? 'bg-vault-accent/20 text-vault-accent'
            : 'bg-vault-elevated text-vault-text-dim'}"
        title="Show the admin's name on each post"
      >Signed posts</button>
    {/if}
  </div>

  <!-- Feed -->
  <div class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
    {#if loading}
      <div class="text-center text-xs text-vault-text-dim py-10">Loading…</div>
    {:else if posts.length === 0}
      <!-- The wording matters. "No posts yet" would be a lie for a channel
           that has simply gone quiet for a day, and reads as data loss. -->
      <div class="text-center py-16 px-6">
        <div class="w-12 h-12 rounded-2xl bg-vault-elevated flex items-center justify-center mx-auto mb-3">
          <svg class="w-6 h-6 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 11l18-8-8 18-2-7-8-3z" />
          </svg>
        </div>
        <p class="text-xs text-vault-text-dim">Nothing here right now</p>
        <p class="text-[10px] text-vault-text-dim mt-1 max-w-xs mx-auto">
          Posts in this channel are deleted 24 hours after they are published,
          so anything older has already expired.
        </p>
      </div>
    {:else}
      {#each posts as post (post.seq)}
        <article
          class="rounded-xl bg-vault-surface border border-vault-border p-3"
          use:seen={post}
        >
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-[11px] font-medium text-vault-accent">
              {post.postAuthor || channel?.title}
            </span>
            <span class="text-[9px] text-vault-text-dim">{timeOf(post.sentAt)}</span>
          </div>

          <div class="text-sm text-vault-text whitespace-pre-wrap break-words">{post.body}</div>

          <div class="flex items-center gap-3 mt-2 text-[10px] text-vault-text-dim">
            <span class="flex items-center gap-1">
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {post.views ?? 0}
            </span>
            <button
              on:click={() => openComments(post)}
              class="hover:text-vault-accent focus:outline-none"
            >
              {post.repliesCount ?? 0} comments
            </button>
          </div>

          {#if openThread === post.seq}
            <div class="mt-2 pt-2 border-t border-vault-border flex flex-col gap-1.5">
              {#each comments as comment (comment.id)}
                <div class="text-[11px]">
                  <span class="text-vault-accent">{comment.senderUsername}</span>
                  <span class="text-vault-text"> {comment.body}</span>
                </div>
              {/each}
              {#if comments.length === 0}
                <div class="text-[10px] text-vault-text-dim">No comments yet.</div>
              {/if}

              <div class="flex items-center gap-1.5 mt-1">
                <input
                  bind:value={commentDraft}
                  on:keydown={(e) => e.key === 'Enter' && submitComment()}
                  placeholder="Write a comment"
                  maxlength="8192"
                  class="flex-1 px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
                />
                <button
                  on:click={submitComment}
                  disabled={commentBusy || !commentDraft.trim()}
                  class="text-[10px] text-vault-accent disabled:opacity-40 focus:outline-none"
                >Send</button>
              </div>
            </div>
          {/if}
        </article>
      {/each}
    {/if}

    {#if error}
      <div class="text-[11px] text-vault-danger text-center">{error}</div>
    {/if}
  </div>

  <!-- Composer, admins only -->
  {#if channel?.canPost}
    <div class="px-3 py-2 border-t border-vault-border glass-strong flex items-end gap-2">
      <textarea
        bind:this={composerEl}
        bind:value={draft}
        on:keydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !Capacitor.isNativePlatform()) { e.preventDefault(); publish(); } }}
        placeholder="Broadcast to subscribers..."
        rows="1"
        class="flex-1 px-3 py-2 rounded-xl bg-vault-elevated border border-vault-border text-sm text-vault-text resize-none focus:outline-none focus:border-vault-accent max-h-[120px]"
      ></textarea>
      <button
        on:click={publish}
        disabled={posting || !draft.trim()}
        class="px-3 py-2 rounded-xl bg-vault-accent text-vault-black text-xs font-medium disabled:opacity-40 focus:outline-none"
      >{posting ? 'Posting…' : 'Post'}</button>
    </div>
  {:else}
    <div class="px-4 py-2.5 border-t border-vault-border text-center text-[10px] text-vault-text-dim">
      Only admins can post in this channel · posts are deleted after 24h
    </div>
  {/if}
</div>

