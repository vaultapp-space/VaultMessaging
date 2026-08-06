<script>
  // ============================================================
  // Native-shell update banner (Android only)
  // ============================================================
  // See lib/capacitor/nativeUpdateCheck.js for why this exists separately
  // from the content-OTA path. A slim top banner, not a full-screen
  // interstitial or a blocking modal — a native-shell update is worth
  // knowing about, not worth interrupting whatever someone opened the app
  // to do.
  import { nativeUpdateInfo, dismissNativeUpdate } from '../lib/capacitor/nativeUpdateCheck.js';

  function openDownload() {
    // No @capacitor/browser dependency needed for this: Capacitor's WebView
    // honours window.open's '_system' target as "hand this to the OS's
    // default handler" — the ordinary browser download flow, ending in
    // Android's own install-unknown-apps prompt. No
    // REQUEST_INSTALL_PACKAGES permission, no in-app installer intent.
    window.open($nativeUpdateInfo.url, '_system');
  }
</script>

{#if $nativeUpdateInfo}
  <!-- fixed + its own safe-area padding, not relative: this has to float
       above Chat.svelte's own `fixed inset-0 z-10` regardless of which
       screen is showing, and fixed positioning escapes an ancestor's
       padding-top the same way Chat.svelte's root does (see App.svelte's
       and Chat.svelte's own comments on this). -->
  <div
    class="fixed top-0 inset-x-0 z-[70] flex items-center gap-3 px-4 py-2 bg-vault-accent/10 border-b border-vault-accent/30 text-xs backdrop-blur-sm"
    style="padding-top: calc(env(safe-area-inset-top, 0px) + 0.5rem)"
  >
    <svg class="w-4 h-4 text-vault-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
      <path d="M12 8v5m0 3h.01" stroke-linecap="round" />
    </svg>
    <span class="flex-1 text-vault-text">
      A new version of Vault is available{$nativeUpdateInfo.versionName ? ` (${$nativeUpdateInfo.versionName})` : ''}.
    </span>
    <button
      on:click={openDownload}
      class="text-vault-accent font-semibold hover:underline focus:outline-none flex-shrink-0"
    >
      Download
    </button>
    <button
      on:click={() => dismissNativeUpdate($nativeUpdateInfo.versionCode)}
      class="text-vault-text-dim hover:text-vault-text focus:outline-none flex-shrink-0"
      aria-label="Dismiss"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
{/if}
