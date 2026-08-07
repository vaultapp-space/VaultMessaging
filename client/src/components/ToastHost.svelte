<script>
  // Mounted once at the app root (see App.svelte). Stacks above the mobile
  // tab bar (z-[60]) and clears the bottom safe-area inset the same way
  // MobileTabBar.svelte does, so a toast never lands under the gesture bar
  // or, on desktop, floats bottom-center above nothing in particular.
  import { fly, fade } from 'svelte/transition';
  import { toasts, dismissToast } from '../lib/stores/toast.js';
</script>

<div
  class="fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 px-4 pointer-events-none max-h-[70vh] overflow-y-auto"
  style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 5rem)"
>
  {#each $toasts as toast (toast.id)}
    <div
      role="alert"
      in:fly={{ y: 16, duration: 200 }}
      out:fade={{ duration: 150 }}
      class="pointer-events-auto w-full max-w-sm px-4 py-2.5 rounded-xl text-xs shadow-lg border flex items-start gap-2
        {toast.type === 'error'
          ? 'bg-vault-danger/15 border-vault-danger/40 text-vault-danger'
          : toast.type === 'success'
            ? 'bg-vault-accent/15 border-vault-accent/40 text-vault-accent'
            : 'bg-vault-surface border-vault-border text-vault-text'}"
    >
      <span class="flex-1">{toast.message}</span>
      <button
        on:click={() => dismissToast(toast.id)}
        class="shrink-0 opacity-60 hover:opacity-100 focus:outline-none"
        aria-label="Dismiss"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/each}
</div>
