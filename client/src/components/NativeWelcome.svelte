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
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { onMount } from 'svelte';

  // This is the first screen an Android user ever sees, and it used to appear
  // fully formed in a single frame. A short staggered reveal is the cheapest
  // thing that makes an app feel built rather than rendered.
  //
  // Gated on a mounted flag rather than relying on Svelte's own intro
  // behaviour: transitions do not play on a component tree's first render, and
  // this component *is* that first render. Flipping the flag in onMount pushes
  // the elements into a second render where the intro does run.
  //
  // Durations stay under ~450ms in total — a first-run animation is charming
  // once and an obstacle every launch after, and this screen is seen on every
  // cold start until the user signs in. app.css's prefers-reduced-motion rule
  // collapses all of it to a single frame.
  let mounted = false;
  onMount(() => { mounted = true; });

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
    {#if mounted}
      <div
        class="w-[60px] h-[60px] rounded-3xl overflow-hidden border border-vault-border shadow-lg"
        in:fly={{ y: 12, duration: 320, easing: cubicOut }}
      >
        <img src="/logo.jpg" alt="Vault" class="w-full h-full object-cover" />
      </div>

      <h1 class="text-4xl font-semibold text-vault-text mt-5" in:fly={{ y: 12, duration: 320, delay: 60, easing: cubicOut }}>Vault</h1>
      <p class="text-[15px] text-vault-text-dim mt-2 px-4" in:fly={{ y: 12, duration: 320, delay: 110, easing: cubicOut }}>Messages that do not stay behind.</p>

    <div class="flex flex-col gap-2.5 mt-8 w-full">
      {#each claims as claim, i (claim.title)}
        <div
          class="flex items-start gap-3 p-3.5 rounded-2xl bg-vault-surface/75 border border-vault-border text-left"
          in:fly={{ y: 14, duration: 320, delay: 160 + i * 70, easing: cubicOut }}
        >
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
      in:fly={{ y: 14, duration: 320, delay: 390, easing: cubicOut }}
      on:click={() => activeView.set('auth')}
      class="w-full py-3.5 rounded-xl bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-base flex items-center justify-center gap-2 transition-all focus:outline-none"
    >
      Start messaging
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M5 12h14m-6-6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
      <p class="text-[11px] text-vault-muted mt-3">New accounts are created on vaultapp.space</p>
    {/if}
  </div>
</div>
