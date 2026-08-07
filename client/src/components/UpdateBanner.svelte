<script>
  // Mounted once at the app root (see App.svelte). Only ever shows anything
  // on native Android with a direct-APK install that's fallen behind — see
  // lib/apkUpdater.js for why this checks rather than auto-installs.
  import { onMount } from 'svelte';
  import { checkForUpdate } from '../lib/apkUpdater.js';
  import { openInRealBrowser } from '../lib/externalOpener.js';

  let update = null;
  let dismissed = false;

  onMount(async () => {
    update = await checkForUpdate();
  });
</script>

{#if update && !dismissed}
  <div
    class="fixed inset-x-0 z-[65] flex items-center justify-center gap-3 px-4 py-2.5 bg-vault-accent/15 border-b border-vault-accent/30 text-xs backdrop-blur-md"
    style="top: env(safe-area-inset-top, 0px)"
    role="status"
  >
    <span class="text-vault-text">Vault {update.versionName} is available.</span>
    <a
      href={update.downloadUrl}
      on:click={(e) => { e.preventDefault(); openInRealBrowser(update.downloadUrl); }}
      class="font-semibold text-vault-accent hover:underline shrink-0"
    >Update</a>
    <button
      on:click={() => (dismissed = true)}
      class="text-vault-text-dim hover:text-vault-text focus:outline-none shrink-0"
      aria-label="Dismiss update notice"
    >
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
{/if}
