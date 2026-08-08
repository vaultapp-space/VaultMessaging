<script>
  // Mounted once at the app root (see App.svelte), same pattern as
  // ConfirmDialog.svelte/ToastHost.svelte.
  import { passphrasePromptState } from '../lib/stores/passphrasePrompt.js';
  import { estimatePasswordStrength } from '../lib/passwordStrength.js';
  import { fade, scale } from 'svelte/transition';

  let value = '';
  let confirmValue = '';
  let show = false;

  // Reset the fields fresh each time a new prompt opens — otherwise a
  // second "create" prompt later in the session would start pre-filled
  // with whatever was typed (or abandoned) in the first one.
  $: if ($passphrasePromptState) { value = ''; confirmValue = ''; show = false; }

  $: isCreate = $passphrasePromptState?.mode === 'create';
  $: strength = isCreate ? estimatePasswordStrength(value) : null;
  $: tooShort = isCreate && value.length > 0 && value.length < $passphrasePromptState.minLength;
  $: mismatched = isCreate && confirmValue.length > 0 && value !== confirmValue;
  $: canSubmit = isCreate
    ? value.length >= ($passphrasePromptState?.minLength ?? 8) && value === confirmValue
    : value.length > 0;

  function submit() {
    if (!canSubmit) return;
    $passphrasePromptState.resolve(value);
  }

  function cancel() {
    $passphrasePromptState?.resolve(null);
  }

  function handleKeydown(e) {
    if (!$passphrasePromptState) return;
    if (e.key === 'Escape') cancel();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $passphrasePromptState}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[80] flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    on:click|self={cancel}
    transition:fade={{ duration: 150 }}
  >
    <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
    <form
      on:submit|preventDefault={submit}
      class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden text-left"
      role="dialog"
      aria-modal="true"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="px-5 py-4 border-b border-vault-border">
        <h3 class="text-sm font-semibold text-vault-text">{$passphrasePromptState.title}</h3>
        {#if $passphrasePromptState.message}
          <p class="text-xs text-vault-text-dim mt-1 leading-relaxed">{$passphrasePromptState.message}</p>
        {/if}
      </div>

      <div class="px-5 py-4 flex flex-col gap-3">
        <div class="relative">
          <!-- svelte-ignore a11y-autofocus -->
          <input
            type={show ? 'text' : 'password'}
            bind:value
            autofocus
            placeholder={isCreate ? `At least ${$passphrasePromptState.minLength} characters` : 'Passphrase'}
            class="input"
            style="padding-right: 2.5rem;"
          />
          <button
            type="button"
            class="absolute inset-y-0 right-0 pr-3 flex items-center text-vault-text-dim hover:text-vault-accent transition-colors"
            on:click={() => (show = !show)}
            tabindex="-1"
            aria-label={show ? 'Hide passphrase' : 'Show passphrase'}
          >
            {#if show}
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            {:else}
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            {/if}
          </button>
        </div>

        {#if isCreate}
          {#if value}
            <div class="flex items-center gap-2 -mt-1.5">
              <div class="flex-1 h-1 rounded-full bg-vault-border/40 overflow-hidden flex gap-0.5">
                {#each Array(4) as _, i}
                  <div class="flex-1 h-full rounded-full transition-colors {i < strength.score ? strength.color : 'bg-transparent'}"></div>
                {/each}
              </div>
              <span class="text-[10px] font-medium text-vault-text-dim w-14 text-right">{strength.label}</span>
            </div>
          {/if}

          <input
            type={show ? 'text' : 'password'}
            bind:value={confirmValue}
            placeholder="Confirm passphrase"
            class="input"
          />

          {#if tooShort}
            <p class="text-[10px] text-vault-danger -mt-1.5">Needs at least {$passphrasePromptState.minLength} characters.</p>
          {:else if mismatched}
            <p class="text-[10px] text-vault-danger -mt-1.5">Passphrases don't match.</p>
          {/if}
        {/if}
      </div>

      <div class="flex border-t border-vault-border">
        <button
          type="button"
          on:click={cancel}
          class="flex-1 px-5 py-3 text-sm text-vault-text-dim hover:bg-vault-elevated transition-colors border-r border-vault-border focus:outline-none"
        >Cancel</button>
        <button
          type="submit"
          disabled={!canSubmit}
          class="flex-1 px-5 py-3 text-sm font-semibold text-vault-accent hover:bg-vault-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
        >Continue</button>
      </div>
    </form>
  </div>
{/if}
