<script>
  // Mounted once at the app root (see App.svelte), same pattern as
  // ToastHost.svelte. Renders whatever lib/stores/confirm.js's showConfirm()
  // last set, or nothing.
  import { confirmState } from '../lib/stores/confirm.js';

  function handleKeydown(e) {
    if (e.key === 'Escape' && $confirmState) $confirmState.resolve('cancel');
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $confirmState}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[80] flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    on:click|self={() => $confirmState.resolve('cancel')}
  >
    <div class="w-full max-w-sm max-h-[85vh] bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left flex flex-col" role="alertdialog" aria-modal="true">
      <div class="px-5 py-4 overflow-y-auto">
        <p class="text-sm text-vault-text leading-relaxed break-words">{$confirmState.message}</p>
      </div>
      <div class="flex flex-col border-t border-vault-border shrink-0">
        {#if $confirmState.neutralLabel}
          <button
            on:click={() => $confirmState.resolve('neutral')}
            class="w-full px-5 py-3 text-sm text-vault-text hover:bg-vault-elevated transition-colors border-b border-vault-border focus:outline-none"
          >{$confirmState.neutralLabel}</button>
        {/if}
        <button
          on:click={() => $confirmState.resolve('confirm')}
          class="w-full px-5 py-3 text-sm font-semibold hover:bg-vault-elevated transition-colors border-b border-vault-border focus:outline-none
            {$confirmState.danger ? 'text-vault-danger' : 'text-vault-accent'}"
        >{$confirmState.confirmLabel}</button>
        <button
          on:click={() => $confirmState.resolve('cancel')}
          class="w-full px-5 py-3 text-sm text-vault-text-dim hover:bg-vault-elevated transition-colors focus:outline-none"
        >{$confirmState.cancelLabel}</button>
      </div>
    </div>
  </div>
{/if}
