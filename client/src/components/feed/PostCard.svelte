<script>
  // ============================================================
  // One post in the feed
  // ============================================================
  // Renders a post body as tokens, never as HTML. See lib/posts/richtext.js
  // for why: a post is written by a stranger and shown to everyone, so the
  // usual escape-then-splice approach is one mistake away from a bug that
  // spreads to every user who scrolls. There is no {@html} anywhere in the
  // feed tree, which is also why this file is absent from the
  // svelte/no-at-html-tags exemption list in eslint.config.js — it does not
  // need to be there, and it should never be added.
  import { createEventDispatcher } from 'svelte';

  import { tokenize } from '../../lib/posts/richtext.js';
  import { getAvatarGradient } from '../../lib/avatar.js';
  import { publicMediaUrl, reportPost, repostPost, deletePost } from '../../lib/api/http.js';
  import { currentUser } from '../../lib/stores/session.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { showConfirm } from '../../lib/stores/confirm.js';
  import { clickOutside } from '../../lib/actions/clickOutside.js';
  import { openLightbox } from '../../lib/stores/lightbox.js';

  export let post;
  // A thread view already shows the root in full; a timeline card is tappable
  // to open it.
  export let interactive = true;

  const dispatch = createEventDispatcher();

  let menuOpen = false;
  let reposting = false;
  // Which way the menu opens. It lives inside an overflow-y-auto scroller, so
  // a menu that always opened upward was clipped for the first card in the
  // feed — the report options simply could not be reached. Same approach
  // MessageBubble takes for its reaction picker: measure at open time.
  let menuAbove = false;

  $: isMine = $currentUser && post.authorId === $currentUser.id;

  function toggleMenu(event) {
    if (!menuOpen) {
      const rect = event.currentTarget.getBoundingClientRect();
      menuAbove = window.innerHeight - rect.bottom < 260;
    }
    menuOpen = !menuOpen;
  }

  async function remove() {
    menuOpen = false;
    if (!(await showConfirm(
      'Delete this post? It disappears for everyone immediately.',
      { confirmLabel: 'Delete', danger: true }
    ))) return;
    try {
      await deletePost(post.id);
      dispatch('deleted', post);
      showToast('Deleted', { type: 'success' });
    } catch (err) {
      showToast(err?.message || 'Could not delete that');
    }
  }

  // The category list *is* the content policy: nothing is removed for being
  // disagreeable, only for being illegal. Offering "offensive" here would
  // promise a review that will not happen. Kept in step with the enum the
  // server enforces (posts.routes.js and a CHECK constraint).
  const REPORT_CATEGORIES = [
    ['csam', 'Child sexual abuse material'],
    ['terrorism', 'Terrorism or violent extremism'],
    ['nonconsensual_intimate', 'Non-consensual intimate imagery'],
    ['credible_threat', 'A credible threat of violence'],
    ['other_illegal', 'Something else illegal'],
  ];

  async function report(category, label) {
    menuOpen = false;
    // showConfirm resolves a *boolean* in two-button mode and only resolves
    // 'confirm'|'neutral'|'cancel' when a neutralLabel is passed (see
    // stores/confirm.js). Comparing against the string here meant the guard
    // was always true and no report was ever sent.
    if (!(await showConfirm(
      `Report this post as: ${label}?\n\nReports are only actioned for illegal content — nothing is removed for being disagreeable.`,
      { confirmLabel: 'Report', danger: true }
    ))) return;
    try {
      await reportPost(post.id, category);
      showToast('Reported. Thank you.', { type: 'success' });
    } catch (err) {
      showToast(err?.message || 'Could not send that report');
    }
  }

  async function repost() {
    if (reposting) return;
    menuOpen = false;
    reposting = true;
    try {
      const { post: created } = await repostPost(post.id);
      // Dispatched rather than mutating `post` in place: the prop is owned by
      // whichever list rendered this card, so a local write is reverted the
      // next time that list re-renders and the count silently snaps back.
      dispatch('reposted', { original: post, repost: created });
      showToast('Reposted', { type: 'success' });
    } catch (err) {
      showToast(err?.message || 'Could not repost that');
    } finally {
      reposting = false;
    }
  }

  $: tokens = tokenize(post.body ?? '');
  $: initial = (post.username ?? '?').charAt(0).toUpperCase();

  // The countdown is the differentiator, so it is shown rather than hidden.
  // A feed where everything disappears within a day is a different product
  // from one that accumulates, and the card should say so.
  function timeLeft(expiresAt) {
    const ms = new Date(expiresAt) - Date.now();
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1) return `${hours}h left`;
    return `${Math.max(1, Math.floor(ms / 60000))}m left`;
  }

  function posted(createdAt) {
    const ms = Date.now() - new Date(createdAt);
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }
</script>

<!--
  Tapping the card opens the thread, via a stretched transparent button rather
  than a click handler on the <article>. An article with a role and a tabindex
  is not a real control — screen readers and keyboard users get something that
  announces as a button but is not one, and svelte-check rightly objects. A
  real button underneath, with the genuine controls layered above it, gives
  correct semantics and keeps the whole-card tap target.
-->
<article
  class="relative px-4 py-3 border-b border-vault-border-subtle {interactive ? 'hover:bg-vault-surface/40 transition-colors' : ''}"
>
  {#if interactive}
    <button
      on:click={() => dispatch('open', post)}
      class="absolute inset-0 w-full h-full cursor-pointer focus:outline-none focus-visible:bg-vault-surface/40"
      aria-label="Open thread by {post.username}"
    ></button>
  {/if}

  <!-- Above the stretched button so the real controls stay clickable. -->
  <div class="relative pointer-events-none flex gap-3">
    <button
      on:click|stopPropagation={() => dispatch('profile', post.username)}
      class="pointer-events-auto w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white focus:outline-none"
      style="background: {getAvatarGradient(post.username)}"
      aria-label="View {post.username}'s profile"
    >{initial}</button>

    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5 text-xs">
        <button
          on:click|stopPropagation={() => dispatch('profile', post.username)}
          class="pointer-events-auto font-semibold text-vault-text hover:underline focus:outline-none truncate"
        >@{post.username}</button>
        <span class="text-vault-text-dim">·</span>
        <span class="text-vault-text-dim">{posted(post.createdAt)}</span>
        <span class="text-vault-text-dim">·</span>
        <span class="text-vault-text-dim" title="Every post is deleted within 24 hours">
          {timeLeft(post.expiresAt)}
        </span>
      </div>

      {#if tokens.length}
        <p class="text-sm text-vault-text mt-1 whitespace-pre-wrap break-words">
          {#each tokens as token}
            {#if token.t === 'link'}
              <!-- href is bound, never interpolated into a string, and the
                   tokenizer has already rejected any non-http(s) scheme. -->
              <a
                href={token.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                on:click|stopPropagation
                class="pointer-events-auto text-vault-accent hover:underline"
              >{token.v}</a>
            {:else if token.t === 'mention'}
              <button
                on:click|stopPropagation={() => dispatch('profile', token.username)}
                class="pointer-events-auto text-vault-accent hover:underline focus:outline-none"
              >{token.v}</button>
            {:else}{token.v}{/if}
          {/each}
        </p>
      {/if}

      {#if post.media}
        <button
          on:click|stopPropagation={() => openLightbox(publicMediaUrl(post.media.fileId), 'Post image')}
          class="pointer-events-auto mt-2 block bg-transparent border-none p-0 cursor-pointer focus:outline-none"
          aria-label="View image full size"
        >
          <img
            src={publicMediaUrl(post.media.fileId)}
            alt=""
            decoding="async"
            loading="lazy"
            style={post.media.width && post.media.height
              ? `aspect-ratio: ${post.media.width} / ${post.media.height}; max-height: 320px; width: 100%;`
              : null}
            class="max-w-full max-h-80 rounded-xl border border-vault-border object-cover"
          />
        </button>
      {/if}

      <div class="flex items-center gap-5 mt-2 text-vault-text-dim">
        <button
          on:click|stopPropagation={() => dispatch('open', post)}
          class="pointer-events-auto flex items-center gap-1.5 text-[11px] hover:text-vault-text focus:outline-none"
          aria-label="{post.repliesCount} replies"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {post.repliesCount || ''}
        </button>

        <button
          on:click|stopPropagation={() => dispatch('like', post)}
          class="pointer-events-auto flex items-center gap-1.5 text-[11px] focus:outline-none transition-colors
            {post.likedByMe ? 'text-vault-danger' : 'hover:text-vault-text'}"
          aria-pressed={post.likedByMe}
          aria-label="{post.likedByMe ? 'Unlike' : 'Like'}, {post.likesCount} likes"
        >
          <svg
            class="w-3.5 h-3.5" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
            fill={post.likedByMe ? 'currentColor' : 'none'}
          >
            <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z" />
          </svg>
          {post.likesCount || ''}
        </button>

        <button
          on:click|stopPropagation={repost}
          disabled={reposting}
          class="pointer-events-auto flex items-center gap-1.5 text-[11px] hover:text-vault-accent focus:outline-none disabled:opacity-50"
          aria-label="Repost"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {post.repostsCount || ''}
        </button>

        <div class="relative ml-auto pointer-events-auto" use:clickOutside={() => (menuOpen = false)}>
          <button
            on:click|stopPropagation={toggleMenu}
            class="text-[11px] hover:text-vault-text focus:outline-none px-1"
            aria-label="More options"
            aria-expanded={menuOpen}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>

          {#if menuOpen}
            <div
              class="absolute right-0 w-60 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg z-20
                {menuAbove ? 'bottom-full mb-1' : 'top-full mt-1'}"
            >
              {#if isMine}
                <button
                  on:click|stopPropagation={remove}
                  class="w-full text-left px-3 py-1.5 text-[11px] text-vault-danger hover:bg-vault-elevated focus:outline-none"
                >Delete this post</button>
                <div class="my-1 border-t border-vault-border-subtle"></div>
              {/if}

              <div class="px-3 py-1.5 text-[9px] uppercase tracking-wider text-vault-text-dim">
                Report as illegal
              </div>
              {#each REPORT_CATEGORIES as [value, label] (value)}
                <button
                  on:click|stopPropagation={() => report(value, label)}
                  class="w-full text-left px-3 py-1.5 text-[11px] text-vault-text hover:bg-vault-elevated focus:outline-none"
                >{label}</button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
</article>
