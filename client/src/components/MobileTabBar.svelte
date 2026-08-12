<script>
  // ============================================================
  // Mobile bottom tab bar — Chats / Thoughts / Profile / Settings
  // ============================================================
  // Profile used to be folded into Settings, on the reasoning that the
  // sidebar footer already showed who you are and there was no account screen
  // worth a tab. Thoughts changed that: there is now a public profile with
  // your posts on it, which is content rather than configuration, and burying
  // it under the same panel as key backup and biometrics both hid it and
  // implied it was something you administer rather than something you have.
  // The desktop layout keeps its sidebar and header icons unchanged; this
  // bar exists only below the md breakpoint, where there is no sidebar
  // chrome to put a Settings entry point in once a conversation is open.
  //
  // Reuses the existing settings modal rather than a second copy of it.
  // That modal already renders as its own fixed-position overlay outside
  // the sidebar's <aside>, so it isn't affected by the sidebar being
  // hidden on mobile — `showBackupModal` just needed lifting up so this
  // bar can set it too.
  import { activePeer, activeChannelId, sidebarOpen, activeSection, activeThreadId, activeProfile, currentUser } from '../lib/stores/session.js';

  export let showBackupModal = false;

  // Hidden while a specific conversation is open, matching the iOS app's
  // `.toolbar(.hidden, for: .tabBar)` — full immersion in a chat, with the
  // existing back arrow (which sets sidebarOpen) the way out.
  //
  // The feed keeps the bar: a timeline is a top-level destination, not
  // something you are "inside". A single thread or profile *is*, so those
  // hide it the same way a conversation does.
  $: onFeed = $activeSection === 'thoughts';

  // **Your own profile is a tab, so it is a destination, not a detail.**
  // Someone else's profile is something you navigated *into* from a post and
  // still hides the bar; yours is where a tab lands you, and hiding the bar
  // there would strand you on a screen with no visible way back.
  $: ownProfile = onFeed
    && Boolean($activeProfile)
    && $activeProfile?.toLowerCase() === $currentUser?.username?.toLowerCase();

  $: inFeedDetail = onFeed && ($activeThreadId || ($activeProfile && !ownProfile));
  $: hidden = inFeedDetail || (!onFeed && ($activePeer || $activeChannelId) && !$sidebarOpen);

  $: chatsActive = !onFeed && !showBackupModal;
  // Thoughts and Profile share a section, so the timeline is only "current"
  // when a profile is not on top of it — otherwise both tabs light up at once.
  $: thoughtsActive = onFeed && !ownProfile && !showBackupModal;

  function openChats() {
    showBackupModal = false;
    activeSection.set('chats');
    sidebarOpen.set(true);
  }

  function openThoughts() {
    showBackupModal = false;
    // Clear the detail views. Without this, tapping Thoughts while a profile
    // or thread is open leaves that on screen — the tab appears to do nothing,
    // which is exactly the bug the feed tab shipped with in v1.26.
    activeThreadId.set(null);
    activeProfile.set(null);
    activeSection.set('thoughts');
    // Closing the sidebar is what actually reveals the feed. Below md the
    // sidebar is a full-width overlay (ChatSidebar's max-md:translate-x-0),
    // not a column beside the pane — so setting the section while it stays
    // open switched the pane underneath and left the screen looking
    // completely unchanged. Opening a chat has always done this; the feed
    // needs it for the same reason.
    sidebarOpen.set(false);
  }

  // Your own profile, as everyone else sees it — the same pane, so what you
  // are showing the world is never a guess. ProfilePane already drops Follow
  // and Mute on your own profile.
  function openProfile() {
    if (!$currentUser?.username) return;
    showBackupModal = false;
    activeThreadId.set(null);
    activeProfile.set($currentUser.username);
    activeSection.set('thoughts');
    sidebarOpen.set(false);
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
        {chatsActive ? 'text-vault-accent' : 'text-vault-text-dim'}"
      aria-current={chatsActive}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="text-[10px] font-medium">Chats</span>
    </button>

    <button
      on:click={openThoughts}
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 focus:outline-none
        {thoughtsActive ? 'text-vault-accent' : 'text-vault-text-dim'}"
      aria-current={thoughtsActive}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12h4l3 8 4-16 3 8h4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="text-[10px] font-medium">Thoughts</span>
    </button>

    <button
      on:click={openProfile}
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 focus:outline-none
        {ownProfile ? 'text-vault-accent' : 'text-vault-text-dim'}"
      aria-current={ownProfile}
      aria-label="Your profile and posts"
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" stroke-linecap="round" />
      </svg>
      <span class="text-[10px] font-medium">Profile</span>
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
