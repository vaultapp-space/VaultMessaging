<script>
  import { activeView } from '../lib/stores/session.js';

  // Security & DeFi features list
  const features = [
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>`,
      title: 'Multi-Chain DeFi Wallet',
      desc: 'Native support for Bitcoin, Solana, Ethereum, Base, Arbitrum, Optimism, and Polygon mainnet balances fetched live from RPCs.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>`,
      title: 'zk-SNARK Private Payments',
      desc: 'Broadcast confidential transactions inside chat streams where addresses are completely hidden under zero-knowledge proofs.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
      </svg>`,
      title: 'WalletConnect dApp Gateway',
      desc: 'Link securely with decentralized applications (e.g. Uniswap) and sign contract calls using local biometrics.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>`,
      title: 'Optimized Cross-Chain Routing',
      desc: 'Look up paths and swap tokens instantly between EVM and Solana chains via unified bridging protocols.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>`,
      title: 'Double Ratchet Protocol',
      desc: 'Cryptographic self-healing. Every chat message has a unique key. If compromised, past and future logs remain safe.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>`,
      title: 'X3DH Offline Handshake',
      desc: 'Establishes secure forward-secret sessions using Extended Triple Diffie-Hellman, even when the recipient is offline.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>`,
      title: 'E2EE Voice & Video Calls',
      desc: 'Symmetric WebRTC streams encrypted using dynamic keys negotiated via Double Ratchet. Free from server listening.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A4 4 0 0111 3h2a4 4 0 013.136 1.243l2.764 2.764A4 4 0 0120 10v2a4 4 0 01-1.243 2.864l-2.764 2.764A4 4 0 0113 19h-2a4 4 0 01-3.136-1.243L5.092 15A4 4 0 014 12v-2a4 4 0 011.243-2.864l2.764-2.764z" />
      </svg>`,
      title: 'Biometric Vault Unlock',
      desc: 'Decrypt local backup logs instantly using FaceID/TouchID via secure WebAuthn PRF keys without passwords.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a9 9 0 1118 0 9 9 0 01-18 0z" />
      </svg>`,
      title: 'Volatile In-Memory Safety',
      desc: 'Active keys live exclusively in volatile JS memory. Closing your browser tab instantly destroys all decryption keys.'
    }
  ];
</script>

<div class="h-screen overflow-y-auto flex flex-col justify-between relative bg-vault-black text-vault-text font-sans">
  <!-- Nav Bar -->
  <header class="w-full max-w-6xl mx-auto px-6 py-6 flex justify-between items-center z-10">
    <div class="flex items-center gap-2">
      <svg class="w-8 h-8 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
        <path d="M12 22V12" stroke-dasharray="3 3" />
      </svg>
      <span class="text-lg font-bold tracking-tight uppercase">Vault</span>
      <span class="text-[9px] bg-vault-accent/10 text-vault-accent border border-vault-accent/25 px-1.5 py-0.5 rounded font-mono">BETA</span>
    </div>
    <div>
      <button 
        on:click={() => activeView.set('auth')} 
        class="btn-primary py-2 px-5 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl focus:outline-none transition-all cursor-pointer"
      >
        Launch Web App
      </button>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="max-w-4xl mx-auto px-6 pt-12 pb-16 text-center flex flex-col items-center gap-6 z-10">

    
    <h1 class="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] max-w-3xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      Confidential Chat.<br/>Shielded Web3.
    </h1>
    
    <p class="text-sm sm:text-lg text-vault-text-secondary max-w-xl leading-relaxed">
      Vault is a secure communication hub combining double-ratcheted E2EE messaging, confidential voice/video streams, and native zk-SNARK private payment rails on EVM & Solana.
    </p>
    
    <div class="flex flex-col sm:flex-row gap-3.5 mt-2">
      <button 
        on:click={() => activeView.set('auth')} 
        class="btn-primary py-3.5 px-8 text-sm bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-bold rounded-xl focus:outline-none transition-all cursor-pointer"
      >
        Start Encryption Session
      </button>
    </div>
  </section>

  <!-- Cryptographic Details Grid -->
  <section class="w-full max-w-5xl mx-auto px-6 py-12 z-10">
    <div class="text-center mb-10">
      <h2 class="text-2xl font-extrabold tracking-tight">Security Features</h2>
      <p class="text-xs text-vault-text-dim mt-1.5">How Vault safeguards your identity and logs at the protocol level.</p>
    </div>
    
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each features as feature}
        <div class="flex flex-col gap-3 p-5 bg-vault-surface border border-vault-border rounded-2xl hover:border-vault-accent/30 transition-all shadow-sm">
          <div class="w-10 h-10 rounded-xl bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent">
            {@html feature.icon}
          </div>
          <div>
            <h4 class="text-sm font-bold text-vault-text mb-1">{feature.title}</h4>
            <p class="text-xs text-vault-text-secondary leading-relaxed font-normal">{feature.desc}</p>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <footer class="w-full border-t border-vault-border bg-vault-surface py-8 z-10">
    <div class="max-w-6xl mx-auto px-6 flex flex-col items-center gap-6">
      
      <!-- Support Us Section -->
      <div class="flex flex-col items-center gap-2 p-4 bg-vault-elevated border border-vault-border rounded-2xl max-w-md w-full text-center animate-fade-in">
        <div class="flex items-center gap-2 text-xs font-bold text-vault-accent">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Support Us
        </div>
        <p class="text-[10px] text-vault-text-dim leading-relaxed font-medium">Help support Vault's infrastructure. Donate BNB to our address below:</p>
        <div class="flex items-center gap-2 w-full p-2 bg-vault-surface border border-vault-border rounded-xl mt-1">
          <span class="text-[9px] font-mono text-vault-text truncate flex-1 select-all">0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b</span>
          <button
            on:click={() => {
              navigator.clipboard.writeText('0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b');
              alert('BNB Address copied to clipboard!');
            }}
            class="text-[9px] text-vault-accent hover:underline font-bold whitespace-nowrap focus:outline-none cursor-pointer bg-transparent border-none"
          >
            Copy
          </button>
        </div>
      </div>

      <div class="w-full flex flex-col sm:flex-row justify-between items-center gap-4 text-[10px] text-vault-text-dim uppercase tracking-wider font-semibold border-t border-vault-border/50 pt-4">
        <div class="flex items-center gap-2">
          <span>© {new Date().getFullYear()} Vault Cryptosystems</span>
        </div>
        <div class="flex gap-6">
          <span>Protocols: X3DH + Double Ratchet</span>
          <span>Storage: In-Memory / Local IndexedDB</span>
        </div>
      </div>

    </div>
  </footer>
</div>

<style>
  /* Local smooth animations */
  .grid > div {
    animation: fadeIn 0.4s ease-out;
  }
</style>
