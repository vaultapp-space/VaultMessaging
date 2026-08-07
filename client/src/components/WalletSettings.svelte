<script>
  import { openExternal } from '../lib/openExternal.js';
</script>

<!-- VAULT (VLT) launcher — opens the real, separately-hosted VLT wallet.
     webwallet.vaultapp.space sends X-Frame-Options: SAMEORIGIN (a deliberate
     anti-clickjacking measure on a page that moves real funds) and lives on
     a separate server, so it can't be safely embedded — it opens in its own
     tab instead. -->
<a
  href="https://webwallet.vaultapp.space"
  target="_blank"
  rel="noopener noreferrer"
  on:click={(e) => openExternal(e, 'https://webwallet.vaultapp.space')}
  class="flex items-center gap-3 p-3.5 bg-vault-accent/10 border border-vault-accent/20 rounded-2xl hover:bg-vault-accent/15 transition-all cursor-pointer no-underline group"
>
  <div class="w-10 h-10 rounded-xl bg-vault-black/40 border border-vault-accent/20 flex items-center justify-center text-vault-accent shrink-0">
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
    </svg>
  </div>
  <div class="flex-1 min-w-0 text-left">
    <div class="flex items-center gap-1.5">
      <h4 class="text-sm font-semibold tracking-tight text-vault-text">VAULT (VLT)</h4>
      <span class="text-[8px] bg-vault-accent/10 text-vault-accent border border-vault-accent/25 px-1.5 py-0.5 rounded font-mono font-bold">VLT</span>
    </div>
    <p class="text-[10px] text-vault-text-dim mt-0.5 leading-relaxed">Untraceable privacy cryptocurrency — ring signatures, RingCT, stealth addresses. Opens the official web wallet.</p>
  </div>
  <svg class="w-4 h-4 text-vault-text-dim group-hover:text-vault-accent transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
  </svg>
</a>
