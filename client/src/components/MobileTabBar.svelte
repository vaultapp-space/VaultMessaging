<script>
  // ============================================================
  // Mobile bottom tab bar — Chats / Settings
  // ============================================================
  // The iOS app's whole navigation is two tabs at the bottom (a third,
  // Profile, folded into Settings — there is no separate account screen
  // worth having here since the sidebar footer already shows who you are).
  // The desktop layout keeps its sidebar and header icons unchanged; this
  // bar exists only below the md breakpoint, where there is no sidebar
  // chrome to put a Settings entry point in once a conversation is open.
  //
  // Reuses the existing settings modal rather than a second copy of it.
  // That modal already renders as its own fixed-position overlay outside
  // the sidebar's <aside>, so it isn't affected by the sidebar being
  // hidden on mobile — `showBackupModal` just needed lifting up so this
  // bar can set it too.
  import { activePeer, activeChannelId, sidebarOpen } from '../lib/stores/session.js';

  export let showBackupModal = false;

  // Hidden while a specific conversation is open, matching the iOS app's
  // `.toolbar(.hidden, for: .tabBar)` — full immersion in a chat, with the
  // existing back arrow (which sets sidebarOpen) the way out.
  $: hidden = ($activePeer || $activeChannelId) && !$sidebarOpen;

  function openChats() {
    showBackupModal = false;
    sidebarOpen.set(true);
  }
</script>

{#if !hidden}
  <nav
    class="md:hidden fixed bottom-0 inset-x-0 z-[45] flex items-stretch bg-vault-surface border-t border-vault-border"
    style="padding-bottom: env(safe-area-inset-bottom, 0px)"
  >
    <button
      on:click={openChats}
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 focus:outline-none
        {!showBackupModal ? 'text-vault-accent' : 'text-vault-text-dim'}"
      aria-current={!showBackupModal}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-[10px] font-medium">Chats</span>
    </button>

    <button
      on:click={() => (showBackupModal = true)}
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 focus:outline-none
        {showBackupModal ? 'text-vault-accent' : 'text-vault-text-dim'}"
      aria-current={showBackupModal}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
      <span class="text-[10px] font-medium">Settings</span>
    </button>
  </nav>
{/if}
