<script>
  // ============================================================
  // Muted and blocked accounts
  // ============================================================
  // Both lists were unreachable, and both for the same reason: the only undo
  // lived on the other person's surface. Unmuting was on their profile, which
  // muting hides from your feed; unblocking was in a chat header, which
  // blocking removes you from. So each control could put you in a state with
  // no way out except remembering an exact username and searching for it.
  //
  // The server could answer both questions all along — GET /api/mutes had
  // never been called by anything.
  import { onMount } from 'svelte';

  import { fetchMutes, fetchBlocked, unmuteUser } from '../lib/api/http.js';
  import { toggleBlock } from '../lib/chat/chatSettings.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { showToast } from '../lib/stores/toast.js';

  let muted = [];
  let blocked = [];
  let loading = true;
  let busy = null;

  onMount(load);

  // Both lists come from the server rather than from the blockedUsers store.
  // That store holds ids only — it exists to answer "is this person blocked?"
  // in a chat header, where the name is already on screen — and a list of
  // truncated uuids is not something anyone can act on. /api/blocks has
  // returned usernames all along.
  async function load() {
    loading = true;
    try {
      const [mutes, blocks] = await Promise.all([fetchMutes(), fetchBlocked()]);
      muted = mutes.users;
      blocked = blocks.blocked;
    } catch (err) {
      showToast(err?.message || 'Could not load those lists');
    } finally {
      loading = false;
    }
  }

  async function unmute(user) {
    busy = user.id;
    try {
      await unmuteUser(user.id);
      muted = muted.filter((u) => u.id !== user.id);
      showToast(`Unmuted @${user.username}`, { type: 'success' });
    } catch (err) {
      showToast(err?.message || 'Could not unmute');
    } finally {
      busy = null;
    }
  }

  async function unblock(user) {
    busy = user.id;
    try {
      // toggleBlock keeps the shared blockedUsers store in step, which is what
      // every chat header reads — unblocking here has to be visible there
      // without a reload.
      await toggleBlock(user.id);
      blocked = blocked.filter((u) => u.id !== user.id);
      showToast(`Unblocked @${user.username}`, { type: 'success' });
    } catch (err) {
      showToast(err?.message || 'Could not unblock');
    } finally {
      busy = null;
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h3 class="text-sm font-medium text-vault-text">Muted accounts</h3>
    <p class="text-[10px] text-vault-text-dim mt-0.5">
      Their posts are hidden from your feed. They are not told, and they can still message you.
    </p>

    {#if loading}
      <div class="mt-2 space-y-2" aria-busy="true">
        {#each Array(2) as _, i (i)}
          <div class="skeleton h-8 rounded-lg" aria-hidden="true"></div>
        {/each}
      </div>
    {:else if muted.length === 0}
      <p class="text-xs text-vault-text-dim mt-2">Nobody muted.</p>
    {:else}
      <div class="mt-2 space-y-1">
        {#each muted as user (user.id)}
          <div class="flex items-center gap-2.5 py-1.5">
            <div
              class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
              style="background: {getAvatarGradient(user.username)}"
            >{user.username.charAt(0).toUpperCase()}</div>
            <span class="text-xs text-vault-text flex-1 truncate">@{user.username}</span>
            <button
              on:click={() => unmute(user)}
              disabled={busy === user.id}
              class="px-2.5 py-1 rounded-lg text-[11px] bg-vault-elevated text-vault-text border border-vault-border hover:text-vault-accent transition-colors disabled:opacity-50 focus:outline-none"
            >Unmute</button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="border-t border-vault-border pt-4">
    <h3 class="text-sm font-medium text-vault-text">Blocked accounts</h3>
    <p class="text-[10px] text-vault-text-dim mt-0.5">
      Blocking is symmetric: neither of you can message the other, and neither sees the other's
      posts. They are not told.
    </p>

    {#if loading}
      <div class="mt-2 space-y-2" aria-busy="true">
        <div class="skeleton h-8 rounded-lg" aria-hidden="true"></div>
      </div>
    {:else if blocked.length === 0}
      <p class="text-xs text-vault-text-dim mt-2">Nobody blocked.</p>
    {:else}
      <div class="mt-2 space-y-1">
        {#each blocked as user (user.id)}
          <div class="flex items-center gap-2.5 py-1.5">
            <div
              class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
              style="background: {getAvatarGradient(user.username)}"
            >{user.username.charAt(0).toUpperCase()}</div>
            <span class="text-xs text-vault-text flex-1 truncate">@{user.username}</span>
            <button
              on:click={() => unblock(user)}
              disabled={busy === user.id}
              class="px-2.5 py-1 rounded-lg text-[11px] bg-vault-elevated text-vault-text border border-vault-border hover:text-vault-accent transition-colors disabled:opacity-50 focus:outline-none"
            >Unblock</button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
