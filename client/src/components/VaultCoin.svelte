<script>
  import { activeView } from '../lib/stores/session.js';

  function goToLanding() {
    activeView.set('landing');
  }

  const architecture = [
    {
      title: 'Ring Signatures',
      subtitle: 'Sender Hidden',
      desc: "Spontaneous Anonymous Group (SAG) ring signatures blend the real spending key with decoy public keys sampled from historical outputs. An observer can prove one ring member signed — never which one. A unique Key Image per spend prevents double-spending without revealing the spent output."
    },
    {
      title: 'RingCT',
      subtitle: 'Amount Hidden',
      desc: 'Ring Confidential Transactions use Pedersen Commitments (C = aG + xH) to conceal transfer amounts entirely. The network verifies that input commitments balance output commitments plus fees — without ever learning the real numeric values.'
    },
    {
      title: 'Stealth Addresses',
      subtitle: 'Receiver Hidden',
      desc: 'Every VLT address carries a dual keypair (public spend + public view key). Senders derive a one-time ephemeral stealth address per transaction; only the recipient can scan the chain and derive the matching private spend key, so payments can never be linked to a public address.'
    }
  ];

  const networkParams = [
    { label: 'Ticker Symbol', value: 'VLT' },
    { label: 'Address Prefix', value: 'd5 (96 hex chars)' },
    { label: 'Target Block Time', value: '60 seconds' },
    { label: 'Initial Block Reward', value: '~17.578350 VLT' },
    { label: 'Atomic Unit Divisor', value: '10¹² (1 VLT = 1,000,000,000,000 units)' },
    { label: 'Block Confirmation Lock', value: '60 blocks' },
    { label: 'Consensus', value: 'CryptoNote / RandomX PoW' },
    { label: 'Default P2P Port', value: '29080' }
  ];

  const desktopFeatures = [
    { title: 'Pure Pitch Black UI', desc: 'Glassmorphism panels with dark-mode ergonomics (#000000 theme).' },
    { title: 'Native C++ Daemon Bundle', desc: 'Pre-built vaultd and vault-wallet-rpc binaries for single-click local node sync.' },
    { title: 'Dual Sync Engine', desc: 'Switches automatically between local full-node sync and instant remote SSL bootstrap.' },
    { title: 'Send Max & QR Receive', desc: 'Auto-calculated max spendable balance, plus 2D QR codes for instant payment receipts.' },
    { title: 'Disposable Subaddresses', desc: 'Generate secondary stealth subaddresses for untraceable contact sharing.' },
    { title: '25-Word Mnemonic Recovery', desc: 'Full seed generation and restoration, exportable transaction history via CSV.' }
  ];

  const resources = [
    { label: 'Web Wallet', url: 'https://webwallet.vaultapp.space' },
    { label: 'Block Explorer', url: 'https://explorer.vaultapp.space' },
    { label: 'Source Code', url: 'https://github.com/vaultapp-space/VAULT' },
    { label: 'GUI Wallets', url: 'https://github.com/vaultapp-space/vault-wallets' }
  ];
</script>

<div class="h-screen overflow-y-auto flex flex-col bg-vault-black text-vault-text font-sans selection:bg-vault-accent/20 selection:text-vault-accent">

  <!-- Minimalist background overlay -->
  <div class="pointer-events-none fixed inset-0 z-0">
    <div class="absolute top-[-30%] left-[-10%] w-[600px] h-[600px] rounded-full bg-vault-accent/[0.015] blur-[150px]"></div>
    <div class="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-vault-accent/[0.02] blur-[120px]"></div>
  </div>

  <!-- Nav Bar -->
  <header class="w-full max-w-5xl mx-auto px-6 py-6 flex justify-between items-center z-10">
    <button
      type="button"
      on:click={goToLanding}
      class="flex items-center gap-2 select-none cursor-pointer focus:outline-none"
      aria-label="Back to Vault Messenger"
    >
      <svg class="w-7 h-7 text-vault-text hover:text-vault-accent transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
        <path d="M12 22V12" stroke-dasharray="3 3" />
      </svg>
      <span class="text-base font-bold tracking-wider uppercase font-sans">Vault</span>
      <span class="text-[8px] bg-vault-border/50 text-vault-text-secondary border border-vault-border px-1.5 py-0.5 rounded font-mono">VLT</span>
    </button>

    <div class="flex items-center gap-2">
      <button
        on:click={goToLanding}
        class="py-2 px-4 text-xs text-vault-text-dim hover:text-vault-text font-bold rounded-xl focus:outline-none transition-all cursor-pointer"
      >
        ← Messenger
      </button>
      <a
        href="https://webwallet.vaultapp.space"
        target="_blank"
        rel="noopener noreferrer"
        class="py-2 px-5 text-xs bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl focus:outline-none transition-all cursor-pointer shadow-md btn-glow no-underline"
      >
        Open Web Wallet
      </a>
    </div>
  </header>

  <!-- Hero -->
  <section class="max-w-3xl mx-auto px-6 pt-12 pb-10 text-center flex flex-col items-center gap-5 z-10">
    <div class="flex flex-wrap justify-center gap-1.5 select-none text-[9px] font-mono font-bold tracking-wider uppercase">
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Ring Signatures</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">RingCT</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Stealth Addresses</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">RandomX PoW</span>
    </div>

    <h1 class="text-4xl sm:text-5xl font-black tracking-tight leading-[1.08] max-w-2xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      VAULT (VLT)
    </h1>
    <p class="text-sm text-vault-text-secondary max-w-lg leading-relaxed opacity-90">
      An untraceable, privacy-first cryptocurrency built on an advanced CryptoNote core — Ring Confidential Transactions, dual-key stealth addresses, and ring signatures obfuscate every sender, receiver, and amount at the protocol level. Privacy isn't opt-in here; it's mandatory.
    </p>

    <div class="flex flex-wrap justify-center gap-3 mt-1">
      {#each resources as r}
        <a
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline text-[10px] font-mono font-bold uppercase"
        >
          {r.label}
        </a>
      {/each}
    </div>
  </section>

  <!-- Why transparent ledgers fail -->
  <section class="w-full max-w-4xl mx-auto px-6 py-8 z-10 border-t border-vault-border/20">
    <h2 class="text-lg font-bold tracking-tight text-vault-text text-center mb-3">Why Mandatory Privacy</h2>
    <p class="text-xs text-vault-text-secondary leading-relaxed max-w-2xl mx-auto text-center opacity-80">
      Most public blockchains — Bitcoin, Ethereum — operate on fully transparent, pseudonymous ledgers. Every balance, output history, and transaction amount is permanently public and queryable. Chain-analysis heuristics and KYC exchange gateways routinely deanonymize users from that transparency. VAULT enforces protocol-level privacy instead of treating it as an optional feature: every transaction is mathematically anonymized by default.
    </p>
  </section>

  <!-- Cryptographic Architecture -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Core Cryptographic Architecture</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Three primitives combine for multi-dimensional transaction anonymity.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {#each architecture as item}
        <div class="glass border border-vault-border/20 rounded-2xl p-5 flex flex-col gap-2 text-left glow-card">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-vault-text">{item.title}</h3>
            <span class="text-[8px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-vault-accent/10 text-vault-accent border border-vault-accent/20">{item.subtitle}</span>
          </div>
          <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90">{item.desc}</p>
        </div>
      {/each}
    </div>
  </section>

  <!-- Network Parameters -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <div class="text-center mb-6">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Network Parameters</h2>
    </div>
    <div class="glass border border-vault-border/20 rounded-2xl overflow-hidden">
      <div class="grid grid-cols-1 sm:grid-cols-2">
        {#each networkParams as p, i}
          <div class="flex items-center justify-between px-4 py-3 text-[11px] font-mono {i % 2 === 0 ? 'sm:border-r border-vault-border/15' : ''} border-b border-vault-border/15">
            <span class="text-vault-text-dim uppercase tracking-wide text-[9px]">{p.label}</span>
            <span class="text-vault-text font-bold">{p.value}</span>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Desktop Wallet -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">VAULT Core Desktop Wallet</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Cross-platform (macOS &amp; Windows) — Electron shell over a native C++ daemon.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each desktopFeatures as f}
        <div class="glass border border-vault-border/20 rounded-2xl p-4 text-left glow-card">
          <h3 class="text-xs font-bold text-vault-text mb-1">{f.title}</h3>
          <p class="text-[10.5px] text-vault-text-secondary leading-relaxed opacity-90">{f.desc}</p>
        </div>
      {/each}
    </div>
  </section>

  <!-- Web Ecosystem -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <div class="text-center mb-6">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Web Application Ecosystem</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Instant light-client access without downloading the full ledger.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="glass border border-vault-border/20 rounded-2xl p-5 text-left">
        <h3 class="text-sm font-bold text-vault-text mb-2">Web Wallet</h3>
        <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90 mb-2">
          Zero-trust client cryptography — keys and seeds are generated and held exclusively in browser memory, never transmitted in plaintext. Connects over HTTPS JSON-RPC to a remote node, with instant session restore from a standard 25-word seed.
        </p>
        <a href="https://webwallet.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-[10px] font-mono font-bold uppercase text-vault-accent hover:underline">webwallet.vaultapp.space →</a>
      </div>
      <div class="glass border border-vault-border/20 rounded-2xl p-5 text-left">
        <h3 class="text-sm font-bold text-vault-text mb-2">Block Explorer</h3>
        <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90 mb-2">
          Real-time block heights, transaction volume, cumulative difficulty, and hash rates — all without exposing confidential ring details. A RESTful API exposes the same data for developers.
        </p>
        <a href="https://explorer.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-[10px] font-mono font-bold uppercase text-vault-accent hover:underline">explorer.vaultapp.space →</a>
      </div>
    </div>
  </section>

  <!-- Ecosystem / Messenger relationship -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <div class="text-center mb-6">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Part of the Vault Privacy Ecosystem</h2>
    </div>
    <div class="glass border border-vault-border/20 rounded-2xl p-6 text-left max-w-3xl mx-auto">
      <p class="text-[11.5px] text-vault-text-secondary leading-relaxed opacity-90">
        VAULT (VLT) and Vault Messenger share a name, a domain, and a design philosophy — mandatory, protocol-level privacy rather than privacy as an opt-in feature. The messenger's Double Ratchet + X3DH encryption and VLT's Ring Signatures + RingCT solve the same problem — leaving no exploitable metadata — for two different mediums: conversations and value transfer.
      </p>
      <p class="text-[11.5px] text-vault-text-secondary leading-relaxed opacity-90 mt-3">
        <strong class="text-vault-text">Today, these are two separate products.</strong> Vault Messenger does not currently have a built-in VLT wallet or in-chat payment feature — sending and receiving VLT happens through the dedicated
        <a href="https://webwallet.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-vault-accent hover:underline">web wallet</a>
        or the desktop GUI wallet. Deeper integration between the two is on the roadmap, not shipped — this page won't claim otherwise.
      </p>
    </div>
  </section>

  <!-- Footer -->
  <footer class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 text-center">
    <div class="flex flex-wrap justify-center gap-3 mb-4">
      <a href="https://x.com/VaultMessenger" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline text-[10px] font-mono font-bold uppercase">✖️ Twitter</a>
      <a href="https://t.me/Vault_Space" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline text-[10px] font-mono font-bold uppercase">✈️ Telegram</a>
      <a href="https://discord.gg/VZyvTsJcFQ" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline text-[10px] font-mono font-bold uppercase">👾 Discord</a>
    </div>
    <p class="text-[9px] text-vault-text-dim uppercase tracking-widest">Copyright © 2026 VAULT Core Developers &amp; Ecosystem · Open-source, MIT License</p>
  </footer>
</div>
