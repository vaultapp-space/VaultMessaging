<script>
  // Mounted once at the app root (see App.svelte). Only ever shows anything
  // on native Android with a direct-APK install that's fallen behind — see
  // lib/apkUpdater.js for why this checks rather than auto-installs. Renders
  // as a centered popup (same pattern as ConfirmDialog.svelte) rather than a
  // top banner — a fixed top strip overlapped the welcome screen's logo and
  // title on native.
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
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[80] flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    on:click|self={() => (dismissed = true)}
  >
    <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left" role="alertdialog" aria-modal="true">
      <div class="px-5 py-4">
        <h2 class="text-sm font-semibold text-vault-text">Update available</h2>
        <p class="text-sm text-vault-text-dim mt-1.5 leading-relaxed">Vault {update.versionName} is ready to download.</p>
      </div>
      <div class="flex flex-col border-t border-vault-border">
        <a
          href={update.downloadUrl}
          on:click={(e) => { e.preventDefault(); openInRealBrowser(update.downloadUrl); dismissed = true; }}
          class="w-full px-5 py-3 text-sm font-semibold text-vault-accent hover:bg-vault-elevated transition-colors border-b border-vault-border focus:outline-none text-center"
        >Update</a>
        <button
          on:click={() => (dismissed = true)}
          class="w-full px-5 py-3 text-sm text-vault-text-dim hover:bg-vault-elevated transition-colors focus:outline-none"
        >Not now</button>
      </div>
    </div>
  </div>
{/if}
