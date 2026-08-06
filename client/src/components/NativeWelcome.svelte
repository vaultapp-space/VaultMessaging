<script>
  // ============================================================
  // Native (Android/Capacitor) welcome screen
  // ============================================================
  // Landing.svelte is the marketing page: nav bar, hero, feature grid,
  // Discord/Twitter links, a "How Vault Compares" table — written for
  // someone deciding whether to try the product. Someone who opened the
  // Android app already made that decision; they installed it. Showing
  // them the marketing site as their first screen wastes it and looks like
  // the app forgot it's an app, not a browser tab. Mirrors the tone and
  // content of ios/VaultMessenger/Sources/Views/WelcomeView.swift — mark,
  // one sentence, three claims, one button — rather than inventing new copy.
  import { activeView } from '../lib/stores/session.js';

  const claims = [
    {
      icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
      title: 'End-to-end encrypted',
      detail: 'One-to-one chats are sealed on your device. Nobody else can read them — including us.',
    },
    {
      icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
      title: 'Everything deletes in 24 hours',
      detail: 'Every message, on every device. Not a setting, and not a tier.',
    },
    {
      icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7zM19 8l-4 4m0-4l4 4',
      title: 'No phone number, no email',
      detail: 'An account is a username and a password. There is nothing else to leak.',
    },
  ];
</script>

<div class="min-h-screen flex flex-col bg-vault-black relative overflow-hidden">
  <div class="pointer-events-none absolute inset-0">
    <div class="absolute top-[-15%] left-1/2 -translate-x-1/2 w-[420px] h-[420px] rounded-full bg-vault-accent/[0.10] blur-[100px]"></div>
  </div>

  <div class="relative flex-1 flex flex-col items-center px-6 pt-12 pb-8 max-w-md mx-auto w-full text-center">
    <div class="w-[60px] h-[60px] rounded-3xl bg-vault-surface border border-vault-border flex items-center justify-center shadow-lg">
      <svg class="w-7 h-7 text-vault-text" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
      </svg>
    </div>

    <h1 class="text-4xl font-semibold text-vault-text mt-5">Vault</h1>
    <p class="text-[15px] text-vault-text-dim mt-2 px-4">Messages that do not stay behind.</p>

    <div class="flex flex-col gap-2.5 mt-8 w-full">
      {#each claims as claim (claim.title)}
        <div class="flex items-start gap-3 p-3.5 rounded-2xl bg-vault-surface/75 border border-vault-border text-left">
          <svg class="w-4 h-4 text-vault-accent mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d={claim.icon} stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <div>
            <div class="text-sm font-semibold text-vault-text">{claim.title}</div>
            <div class="text-xs text-vault-text-dim mt-0.5">{claim.detail}</div>
          </div>
        </div>
      {/each}
    </div>

    <div class="flex-1 min-h-6"></div>

    <button
      on:click={() => activeView.set('auth')}
      class="w-full py-3.5 rounded-xl bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-base flex items-center justify-center gap-2 transition-all focus:outline-none"
    >
      Start messaging
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M5 12h14m-6-6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <p class="text-[11px] text-vault-muted mt-3">New accounts are created on vaultapp.space</p>
  </div>
</div>
