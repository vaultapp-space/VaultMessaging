<script>
  // Mounted once at the app root (see App.svelte), same pattern as
  // UpdateBanner.svelte. A one-time nudge — shown at most once per app
  // launch per account — for anyone who could enable Biometric Vault
  // Unlock (in Settings) but hasn't. Without this, someone would only ever
  // discover the feature by happening to scroll Settings.
  import { get } from 'svelte/store';
  import { currentUser, vaultMasterKey, activeView } from '../lib/stores/session.js';
  import { isPrfSupported } from '../lib/crypto/webauthn.js';
  import { enableBiometric, isBiometricEnabled } from '../lib/biometric.js';
  import { showToast } from '../lib/stores/toast.js';
  import { fade, scale } from 'svelte/transition';

  let show = false;
  let enabling = false;
  let shownForUserId = null;

  // Gated on activeView, not just currentUser: App.svelte's boot flow sets
  // currentUser as soon as the session cookie checks out, before Auth.svelte
  // has actually unlocked the vault (see its "resume" flow) — checking only
  // currentUser would pop this up over the unlock screen itself, before
  // vaultMasterKey even has anything real in it to wrap.
  $: if ($currentUser && $activeView === 'chat' && $currentUser.id !== shownForUserId) {
    shownForUserId = $currentUser.id;
    const dismissed = localStorage.getItem(`vault_bio_prompt_dismissed_${$currentUser.id}`) === 'true';
    show = isPrfSupported() && !isBiometricEnabled($currentUser.id) && !dismissed;
  }

  async function enable() {
    enabling = true;
    try {
      await enableBiometric($currentUser, get(vaultMasterKey));
      showToast('Biometric Vault Unlock enabled!', { type: 'success' });
      show = false;
    } catch (err) {
      console.error('Biometric enrollment failed:', err);
      showToast(err.message || 'Could not enable biometric unlock.');
    } finally {
      enabling = false;
    }
  }

  function dismiss() {
    localStorage.setItem(`vault_bio_prompt_dismissed_${$currentUser.id}`, 'true');
    show = false;
  }
</script>

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[80] flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    on:click|self={dismiss}
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden text-left"
      role="alertdialog"
      aria-modal="true"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="px-5 py-4">
        <h2 class="text-sm font-semibold text-vault-text flex items-center gap-2">
          <svg class="w-4 h-4 text-vault-accent shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 11c0 3.5-1 6.5-3 9M8 20a24.9 24.9 0 002-6M2 12c0-1.5.2-2.9.7-4.2M7 4.6A9.9 9.9 0 0112 3c5 0 9 3.6 9.8 8.3M17.6 20c.5-1 .9-2 1.2-3.1M12 12a3 3 0 013 3c0 1.6-.2 3.1-.5 4.5" />
          </svg>
          Enable Biometric Unlock?
        </h2>
        <p class="text-sm text-vault-text-dim mt-1.5 leading-relaxed">
          Unlock your vault with a fingerprint or face scan instead of typing your password every time. Your password is still never stored anywhere — only your device's own biometric can unwrap the key.
        </p>
      </div>
      <div class="flex flex-col border-t border-vault-border">
        <button
          on:click={enable}
          disabled={enabling}
          class="w-full px-5 py-3 text-sm font-semibold text-vault-accent hover:bg-vault-elevated transition-colors border-b border-vault-border focus:outline-none disabled:opacity-60"
        >{enabling ? 'Setting up…' : 'Enable'}</button>
        <button
          on:click={dismiss}
          disabled={enabling}
          class="w-full px-5 py-3 text-sm text-vault-text-dim hover:bg-vault-elevated transition-colors focus:outline-none disabled:opacity-60"
        >Not now</button>
      </div>
    </div>
  </div>
{/if}
