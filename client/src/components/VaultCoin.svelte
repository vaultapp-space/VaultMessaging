<script>
  import { activeView } from '../lib/stores/session.js';

  function goToLanding() {
    activeView.set('landing');
  }

  const architecture = [
    {
      title: 'Ring Signatures',
      subtitle: 'Sender Hidden',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />`,
      desc: "Spontaneous Anonymous Group (SAG) ring signatures blend the real spending key with decoy public keys sampled from historical outputs. An observer can prove one ring member signed — never which one. A unique Key Image per spend prevents double-spending without revealing the spent output."
    },
    {
      title: 'RingCT',
      subtitle: 'Amount Hidden',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />`,
      desc: 'Ring Confidential Transactions use Pedersen Commitments (C = aG + xH) to conceal transfer amounts entirely. The network verifies that input commitments balance output commitments plus fees — without ever learning the real numeric values.'
    },
    {
      title: 'Stealth Addresses',
      subtitle: 'Receiver Hidden',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />`,
      desc: 'Every VLT address carries a dual keypair (public spend + public view key). Senders derive a one-time ephemeral stealth address per transaction; only the recipient can scan the chain and derive the matching private spend key, so payments can never be linked to a public address.'
    }
  ];

  const heroStats = [
    { value: '60s', label: 'Block Time' },
    { value: '3', label: 'Anonymity Primitives' },
    { value: '256-bit', label: 'Stealth Keypairs' },
    { value: '0', label: 'Exploitable Metadata' }
  ];

  const networkParams = [
    { label: 'Ticker Symbol', value: 'VLT' },
    { label: 'Address Prefix', value: 'd5' },
    { label: 'Target Block Time', value: '60s' },
    { label: 'Initial Block Reward', value: '~17.58 VLT' },
    { label: 'Atomic Unit Divisor', value: '10¹²' },
    { label: 'Confirmation Lock', value: '60 blocks' },
    { label: 'Consensus', value: 'RandomX PoW' },
    { label: 'P2P Port', value: '29080' }
  ];

  const desktopFeatures = [
    {
      title: 'Pure Pitch Black UI',
      desc: 'Glassmorphism panels with dark-mode ergonomics (#000000 theme).',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />`
    },
    {
      title: 'Native C++ Daemon',
      desc: 'Pre-built vaultd and vault-wallet-rpc binaries for single-click local node sync.',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />`
    },
    {
      title: 'Dual Sync Engine',
      desc: 'Switches automatically between local full-node sync and instant remote SSL bootstrap.',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />`
    },
    {
      title: 'Send Max & QR Receive',
      desc: 'Auto-calculated max spendable balance, plus 2D QR codes for instant payment receipts.',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.5v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.5v-4.5z" />`
    },
    {
      title: 'Disposable Subaddresses',
      desc: 'Generate secondary stealth subaddresses for untraceable contact sharing.',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />`
    },
    {
      title: '25-Word Mnemonic',
      desc: 'Full seed generation and restoration, exportable transaction history via CSV.',
      icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />`
    }
  ];

  const desktopWalletUrl = 'https://github.com/vaultapp-space/vault-wallets';
</script>

<svelte:head>
  <title>VAULT (VLT) — Untraceable Privacy Cryptocurrency</title>
  <meta name="description" content="VAULT (VLT) is an untraceable, privacy-first cryptocurrency built on ring signatures, RingCT, and dual-key stealth addresses — mandatory protocol-level privacy for every transaction." />
</svelte:head>

<div class="h-screen overflow-y-auto flex flex-col bg-vault-black text-vault-text font-sans selection:bg-vault-accent/20 selection:text-vault-accent">

  <!-- Ambient background glow -->
  <div class="pointer-events-none fixed inset-0 z-0">
    <div class="absolute top-[-30%] left-[-10%] w-[600px] h-[600px] rounded-full bg-vault-accent/[0.025] blur-[150px]"></div>
    <div class="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-vault-accent/[0.03] blur-[120px]"></div>
    <div class="absolute inset-0 opacity-[0.03]" style="background-image: radial-gradient(circle, var(--color-vault-text-dim) 1px, transparent 1px); background-size: 32px 32px;"></div>
  </div>

  <!-- Nav Bar -->
  <header class="w-full max-w-5xl mx-auto px-6 py-6 flex justify-between items-center z-10">
    <button
      type="button"
      on:click={goToLanding}
      class="flex items-center gap-2 select-none cursor-pointer focus:outline-none group"
      aria-label="Back to Vault Messenger"
    >
      <svg class="w-7 h-7 text-vault-text group-hover:text-vault-accent transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
        <path d="M12 22V12" stroke-dasharray="3 3" />
      </svg>
      <span class="text-base font-bold tracking-wider uppercase font-sans">Vault</span>
      <span class="text-[8px] bg-vault-accent/10 text-vault-accent border border-vault-accent/25 px-1.5 py-0.5 rounded font-mono font-bold">VLT</span>
    </button>

    <div class="flex items-center gap-1.5 sm:gap-2">
      <button
        on:click={goToLanding}
        class="hidden sm:block py-2 px-4 text-xs text-vault-text-dim hover:text-vault-text font-bold rounded-xl focus:outline-none transition-all cursor-pointer"
      >
        ← Messenger
      </button>
      <a
        href="https://explorer.vaultapp.space"
        target="_blank"
        rel="noopener noreferrer"
        title="Block Explorer"
        class="flex items-center gap-1.5 py-2 px-3 text-xs text-vault-text-dim hover:text-vault-accent border border-vault-border/30 hover:border-vault-accent/30 font-bold rounded-xl focus:outline-none transition-all cursor-pointer no-underline"
      >
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 000 18M12.5 3a17 17 0 010 18" />
          <circle cx="12" cy="12" r="9" stroke-linecap="round" />
        </svg>
        <span class="hidden md:inline">Explorer</span>
      </a>
      <a
        href="https://github.com/vaultapp-space/VAULT"
        target="_blank"
        rel="noopener noreferrer"
        title="Source on GitHub"
        class="flex items-center gap-1.5 py-2 px-3 text-xs text-vault-text-dim hover:text-vault-accent border border-vault-border/30 hover:border-vault-accent/30 font-bold rounded-xl focus:outline-none transition-all cursor-pointer no-underline"
      >
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.11-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.74.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18a10.9 10.9 0 015.73 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.08.78 2.17 0 1.57-.01 2.83-.01 3.22 0 .3.2.66.79.55A10.51 10.51 0 0023.5 12C23.5 5.65 18.35.5 12 .5z" />
        </svg>
        <span class="hidden md:inline">GitHub</span>
      </a>
      <a
        href="https://webwallet.vaultapp.space"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-1.5 py-2 px-3 sm:px-5 text-xs bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl focus:outline-none transition-all cursor-pointer shadow-md btn-glow no-underline"
      >
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
        </svg>
        <span class="hidden sm:inline">Open Web Wallet</span>
        <span class="sm:hidden">Wallet</span>
      </a>
    </div>
  </header>

  <!-- Hero -->
  <section class="max-w-3xl mx-auto px-6 pt-10 pb-4 text-center flex flex-col items-center gap-5 z-10">

    <!-- Animated ring emblem: 3 concentric rings = the 3 anonymity primitives -->
    <div class="relative w-28 h-28 mb-1 flex items-center justify-center select-none">
      <div class="absolute inset-0 rounded-full border border-dashed border-vault-accent/30 animate-hud-rotate"></div>
      <div class="absolute inset-3 rounded-full border border-dashed border-vault-accent/40 animate-hud-rotate-reverse"></div>
      <div class="absolute inset-6 rounded-full border border-vault-accent/20"></div>
      <div class="absolute inset-0 rounded-full bg-vault-accent/[0.04] blur-xl"></div>
      <svg class="w-9 h-9 text-vault-accent relative z-10 animate-pulse-glow rounded-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
      </svg>
    </div>

    <div class="flex flex-wrap justify-center gap-1.5 select-none text-[9px] font-mono font-bold tracking-wider uppercase">
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Ring Signatures</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">RingCT</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Stealth Addresses</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">RandomX PoW</span>
    </div>

    <h1 class="text-5xl sm:text-6xl font-black tracking-tight leading-[1.05] max-w-2xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      VAULT <span class="text-glow-accent text-vault-accent">(VLT)</span>
    </h1>
    <p class="text-sm text-vault-text-secondary max-w-lg leading-relaxed opacity-90">
      An untraceable, privacy-first cryptocurrency built on an advanced CryptoNote core — Ring Confidential Transactions, dual-key stealth addresses, and ring signatures obfuscate every sender, receiver, and amount at the protocol level. Privacy isn't opt-in here; it's mandatory.
    </p>

    <!-- Hero stat strip -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-xl mt-4">
      {#each heroStats as s}
        <div class="glass border border-vault-border/20 rounded-xl py-3 px-2 flex flex-col items-center gap-0.5">
          <span class="text-lg font-black text-vault-accent font-mono">{s.value}</span>
          <span class="text-[8px] text-vault-text-dim uppercase tracking-wider font-bold text-center">{s.label}</span>
        </div>
      {/each}
    </div>

    <div class="flex items-center gap-1.5 mt-3 text-[9px] font-mono font-bold uppercase tracking-wider text-vault-text-dim select-none">
      <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-vault-warning"></span>
      Not yet listed on any exchange — mainnet in active development
    </div>
  </section>

  <!-- Why transparent ledgers fail -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 text-center mb-2">01 — The Problem</p>
    <h2 class="text-lg font-bold tracking-tight text-vault-text text-center mb-3">Why Mandatory Privacy</h2>
    <p class="text-xs text-vault-text-secondary leading-relaxed max-w-2xl mx-auto text-center opacity-80">
      Most public blockchains — Bitcoin, Ethereum — operate on fully transparent, pseudonymous ledgers. Every balance, output history, and transaction amount is permanently public and queryable. Chain-analysis heuristics and KYC exchange gateways routinely deanonymize users from that transparency. VAULT enforces protocol-level privacy instead of treating it as an optional feature: every transaction is mathematically anonymized by default.
    </p>
  </section>

  <!-- Cryptographic Architecture -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-3">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 mb-2">02 — Architecture</p>
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Core Cryptographic Architecture</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Three primitives combine for multi-dimensional transaction anonymity.</p>
    </div>

    <!-- Flow connector (desktop only) -->
    <div class="hidden sm:flex items-center justify-center gap-2 my-6 px-16 select-none opacity-60">
      <div class="flex-1 h-px bg-gradient-to-r from-transparent via-vault-accent/40 to-vault-accent/40"></div>
      <svg class="w-3 h-3 text-vault-accent/60" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <div class="flex-1 h-px bg-vault-accent/40"></div>
      <svg class="w-3 h-3 text-vault-accent/60" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <div class="flex-1 h-px bg-gradient-to-l from-transparent via-vault-accent/40 to-vault-accent/40"></div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {#each architecture as item, i}
        <div class="glass border border-vault-border/20 rounded-2xl p-5 flex flex-col gap-3 text-left glow-card relative">
          <span class="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-vault-black border border-vault-accent/40 text-vault-accent text-[10px] font-mono font-bold flex items-center justify-center">{i + 1}</span>
          <div class="w-10 h-10 rounded-xl bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              {@html item.icon}
            </svg>
          </div>
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-vault-text">{item.title}</h3>
            <span class="text-[8px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-vault-accent/10 text-vault-accent border border-vault-accent/20">{item.subtitle}</span>
          </div>
          <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90">{item.desc}</p>
        </div>
      {/each}
    </div>

    <!-- Transaction anonymization flow diagram -->
    <div class="mt-8 glass border border-vault-border/20 rounded-2xl p-5 flex flex-col items-center gap-3">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-text-dim self-start">How a transaction gets anonymized</p>
      <svg class="w-full max-w-[820px] h-[160px]" viewBox="0 0 820 160" fill="none">
        <defs>
          <marker id="vlt-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--color-vault-accent)" opacity="0.6" />
          </marker>
          <filter id="vlt-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <!-- Connecting spine -->
        <line x1="80" y1="80" x2="740" y2="80" stroke="var(--color-vault-accent)" stroke-opacity="0.25" stroke-width="1.5" marker-end="url(#vlt-arrow)" />

        <!-- Sender -->
        <g transform="translate(50, 80)">
          <circle r="26" class="fill-vault-surface stroke-vault-border" stroke-width="1.5" />
          <text y="4" text-anchor="middle" class="text-[16px]" fill="currentColor">🧑</text>
          <text y="46" text-anchor="middle" class="text-[9px] font-mono font-bold fill-vault-text-dim">SENDER</text>
        </g>

        <!-- Ring Signature: decoy ring around a central node -->
        <g transform="translate(240, 80)">
          {#each Array.from({ length: 6 }, (_, i) => i) as i}
            <circle
              cx={26 * Math.cos((i / 6) * 2 * Math.PI)}
              cy={26 * Math.sin((i / 6) * 2 * Math.PI)}
              r="4"
              class="fill-vault-border stroke-vault-border-subtle"
              opacity={i === 0 ? '0' : '0.7'}
            />
          {/each}
          <circle r="22" class="fill-vault-accent/10 stroke-vault-accent animate-pulse" stroke-width="1.5" filter="url(#vlt-glow)" />
          <text y="4" text-anchor="middle" class="text-[15px]" fill="currentColor">🔏</text>
          <text y="48" text-anchor="middle" class="text-[9px] font-mono font-bold fill-vault-accent">RING SIG</text>
          <text y="60" text-anchor="middle" class="text-[7.5px] font-mono fill-vault-text-dim">sender hidden</text>
        </g>

        <!-- RingCT: hidden amount -->
        <g transform="translate(420, 80)">
          <circle r="22" class="fill-vault-accent/10 stroke-vault-accent" stroke-width="1.5" filter="url(#vlt-glow)" />
          <text y="4" text-anchor="middle" class="text-[15px]" fill="currentColor">🔒</text>
          <text y="48" text-anchor="middle" class="text-[9px] font-mono font-bold fill-vault-accent">RINGCT</text>
          <text y="60" text-anchor="middle" class="text-[7.5px] font-mono fill-vault-text-dim">amount hidden</text>
        </g>

        <!-- Stealth address: one-time derived address -->
        <g transform="translate(600, 80)">
          <circle r="22" class="fill-vault-accent/10 stroke-vault-accent" stroke-width="1.5" filter="url(#vlt-glow)" />
          <text y="4" text-anchor="middle" class="text-[15px]" fill="currentColor">🕶️</text>
          <text y="48" text-anchor="middle" class="text-[9px] font-mono font-bold fill-vault-accent">STEALTH</text>
          <text y="60" text-anchor="middle" class="text-[7.5px] font-mono fill-vault-text-dim">receiver hidden</text>
        </g>

        <!-- Receiver -->
        <g transform="translate(770, 80)">
          <circle r="26" class="fill-vault-surface stroke-vault-border" stroke-width="1.5" />
          <text y="4" text-anchor="middle" class="text-[16px]" fill="currentColor">🧑</text>
          <text y="46" text-anchor="middle" class="text-[9px] font-mono font-bold fill-vault-text-dim">RECEIVER</text>
        </g>
      </svg>
      <p class="text-[9.5px] text-vault-text-dim text-center max-w-lg leading-relaxed">
        Every field an outside observer would normally read off-chain — sender, amount, receiver — is obfuscated by a distinct primitive before the transaction is broadcast.
      </p>
    </div>
  </section>

  <!-- Network Parameters -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-6">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 mb-2">03 — Specification</p>
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Network Parameters</h2>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {#each networkParams as p}
        <div class="glass border border-vault-border/20 rounded-xl p-3.5 flex flex-col gap-1 glow-card">
          <span class="text-[8.5px] text-vault-text-dim uppercase tracking-wide font-bold">{p.label}</span>
          <span class="text-sm text-vault-text font-black font-mono">{p.value}</span>
        </div>
      {/each}
    </div>
  </section>

  <!-- Desktop Wallet -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-8">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 mb-2">04 — Desktop</p>
      <h2 class="text-lg font-bold tracking-tight text-vault-text">VAULT Core Desktop Wallet</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Cross-platform (macOS &amp; Windows) — Electron shell over a native C++ daemon.</p>
      <a
        href={desktopWalletUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 mt-4 px-4 py-2 rounded-xl border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline text-[10px] font-mono font-bold uppercase"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        Download Desktop Wallet
      </a>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each desktopFeatures as f}
        <div class="glass border border-vault-border/20 rounded-2xl p-4 text-left glow-card flex gap-3">
          <div class="w-8 h-8 shrink-0 rounded-lg bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              {@html f.icon}
            </svg>
          </div>
          <div>
            <h3 class="text-xs font-bold text-vault-text mb-1">{f.title}</h3>
            <p class="text-[10.5px] text-vault-text-secondary leading-relaxed opacity-90">{f.desc}</p>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Web Ecosystem -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-6">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 mb-2">05 — Web</p>
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Web Application Ecosystem</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Instant light-client access without downloading the full ledger.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="glass border border-vault-border/20 rounded-2xl p-5 text-left glow-card">
        <div class="w-9 h-9 rounded-xl bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent mb-3">
          <svg class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 000 18M12.5 3a17 17 0 010 18" />
          </svg>
        </div>
        <h3 class="text-sm font-bold text-vault-text mb-2">Web Wallet</h3>
        <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90 mb-3">
          Zero-trust client cryptography — keys and seeds are generated and held exclusively in browser memory, never transmitted in plaintext. Connects over HTTPS JSON-RPC to a remote node, with instant session restore from a standard 25-word seed.
        </p>
        <a href="https://webwallet.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-[10px] font-mono font-bold uppercase text-vault-accent hover:underline">webwallet.vaultapp.space →</a>
      </div>
      <div class="glass border border-vault-border/20 rounded-2xl p-5 text-left glow-card">
        <div class="w-9 h-9 rounded-xl bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent mb-3">
          <svg class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
        </div>
        <h3 class="text-sm font-bold text-vault-text mb-2">Block Explorer</h3>
        <p class="text-[11px] text-vault-text-secondary leading-relaxed opacity-90 mb-3">
          Real-time block heights, transaction volume, cumulative difficulty, and hash rates — all without exposing confidential ring details. A RESTful API exposes the same data for developers.
        </p>
        <a href="https://explorer.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-[10px] font-mono font-bold uppercase text-vault-accent hover:underline">explorer.vaultapp.space →</a>
      </div>
    </div>
  </section>

  <!-- Ecosystem / Messenger relationship -->
  <section class="w-full max-w-4xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-6">
      <p class="text-[9px] font-mono font-bold uppercase tracking-widest text-vault-accent/70 mb-2">06 — Ecosystem</p>
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Part of the Vault Privacy Ecosystem</h2>
    </div>
    <div class="glass-strong rounded-2xl p-6 text-left max-w-3xl mx-auto relative overflow-hidden">
      <div class="absolute -right-6 -top-6 text-6xl opacity-[0.04] select-none pointer-events-none">🛡️</div>
      <p class="text-[11.5px] text-vault-text-secondary leading-relaxed opacity-90 relative">
        VAULT (VLT) and Vault Messenger share a name, a domain, and a design philosophy — mandatory, protocol-level privacy rather than privacy as an opt-in feature. The messenger's Double Ratchet + X3DH encryption and VLT's Ring Signatures + RingCT solve the same problem — leaving no exploitable metadata — for two different mediums: conversations and value transfer.
      </p>
      <p class="text-[11.5px] text-vault-text-secondary leading-relaxed opacity-90 mt-3 relative">
        <strong class="text-vault-text">Today, these are two separate products.</strong> Vault Messenger does not currently have a built-in VLT wallet or in-chat payment feature — sending and receiving VLT happens through the dedicated
        <a href="https://webwallet.vaultapp.space" target="_blank" rel="noopener noreferrer" class="text-vault-accent hover:underline">web wallet</a>
        or the desktop GUI wallet. Deeper integration between the two is on the
        <a href="/roadmap.pdf" target="_blank" rel="noopener noreferrer" class="text-vault-accent hover:underline">roadmap</a>,
        not shipped — this page won't claim otherwise.
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
