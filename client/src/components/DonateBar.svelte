<script>
  // Full-width "buy me a coffee" bar, dropped in above the chat list
  // (ChatSidebar's <aside>) and above the Settings options (the
  // showBackupModal panel, also in ChatSidebar) — same component in both
  // spots rather than two copies that could drift apart. Mirrors
  // Landing.svelte's donate banner/modal, but in the app's own Tailwind +
  // vault-* design tokens instead of the marketing site's separate CSS.
  let open = false;
  let copiedTicker = '';

  const addresses = [
    { coin: 'Bitcoin', ticker: 'BTC', address: '1DKyDtvjyhCr1tu22Lfw9nxcQEB4MfFkr1' },
    { coin: 'Ethereum', ticker: 'ETH', address: '0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b' },
    { coin: 'Solana', ticker: 'SOL', address: '9tKGtaS3xAe3ZDtFmksW7NYrdKGN3YNxyUTivfw3mFk2' },
    { coin: 'USDT (ERC-20)', ticker: 'USDT', address: '0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b' },
  ];

  async function copyAddress(entry) {
    try {
      await navigator.clipboard.writeText(entry.address);
      copiedTicker = entry.ticker;
      setTimeout(() => { if (copiedTicker === entry.ticker) copiedTicker = ''; }, 1800);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape' && open) open = false;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 bg-vault-accent/10 border-b border-vault-border">
  <div class="flex items-center gap-2 min-w-0 text-vault-text-dim">
    <svg class="w-4 h-4 text-vault-accent shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8h1a4 4 0 010 8h-1" />
      <path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z" />
      <line x1="6" y1="1" x2="6" y2="4" />
      <line x1="10" y1="1" x2="10" y2="4" />
      <line x1="14" y1="1" x2="14" y2="4" />
    </svg>
    <span class="text-xs truncate">Enjoying Vault? Buy the developer a coffee.</span>
  </div>
  <button
    on:click={() => (open = true)}
    class="shrink-0 text-xs font-semibold text-vault-accent border border-vault-accent/40 rounded-lg px-3 py-1.5 hover:bg-vault-accent hover:text-vault-black transition-all focus:outline-none"
  >Donate</button>
</div>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    on:click|self={() => (open = false)}
  >
    <div class="w-full max-w-sm max-h-[85vh] bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left flex flex-col" role="dialog" aria-modal="true" aria-label="Donate">
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center shrink-0">
        <h3 class="text-sm font-semibold text-vault-text">Buy me a coffee</h3>
        <button on:click={() => (open = false)} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="p-5 space-y-3 overflow-y-auto">
        <p class="text-xs text-vault-text-dim leading-relaxed">Vault is free and doesn't run ads or sell data. Donations go straight to the developer, no processor in between.</p>
        {#each addresses as entry (entry.ticker)}
          <div class="border border-vault-border rounded-xl p-3 bg-vault-elevated">
            <div class="flex items-baseline gap-2">
              <span class="text-xs font-semibold text-vault-text">{entry.coin}</span>
              <span class="text-[10px] text-vault-text-dim font-mono">{entry.ticker}</span>
            </div>
            <div class="flex items-center gap-2 mt-2">
              <code class="flex-1 min-w-0 text-[11px] text-vault-text-dim bg-vault-black px-2 py-1.5 rounded-lg break-all">{entry.address}</code>
              <button
                on:click={() => copyAddress(entry)}
                class="shrink-0 text-[11px] font-semibold text-vault-text-dim border border-vault-border rounded-lg px-2.5 py-1.5 hover:border-vault-accent hover:text-vault-accent transition-all focus:outline-none min-w-[52px]"
              >{copiedTicker === entry.ticker ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
