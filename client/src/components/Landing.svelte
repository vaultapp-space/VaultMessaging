<script>
  import { activeView } from '../lib/stores/session.js';

  // Security features list
  const features = [
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>`,
      title: 'End-to-End Cryptography',
      desc: 'All communications are fully encrypted in transit. Plaintext messages and media never touch the network.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>`,
      title: 'Double Ratchet Protocol',
      desc: 'Cryptographic self-healing. Every message has a unique key. If one key is compromised, past and future logs remain safe.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>`,
      title: 'X3DH Offline Handshake',
      desc: 'Establishes highly secure forward-secret sessions using Extended Triple Diffie-Hellman, even when the recipient is offline.'
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
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" />
      </svg>`,
      title: 'Burn-on-Read Media',
      desc: 'Share media ephemerally. Encrypted attachments are instantly purged from the server database and disk after download.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
      </svg>`,
      title: 'Metadata-Free Uploads',
      desc: 'Automatic client-side stripping of GPS coordinates and camera EXIF markers from JPEGs and PNGs before encryption.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A4 4 0 0111 3h2a4 4 0 013.136 1.243l2.764 2.764A4 4 0 0120 10v2a4 4 0 01-1.243 2.864l-2.764 2.764A4 4 0 0113 19h-2a4 4 0 01-3.136-1.243L5.092 15A4 4 0 014 12v-2a4 4 0 011.243-2.864l2.764-2.764z" />
      </svg>`,
      title: 'Biometric Vault Unlock',
      desc: 'Decrypt local back-up logs instantly using FaceID/TouchID via secure WebAuthn PRF keys without passwords.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
      </svg>`,
      title: 'Zero-Knowledge Backups',
      desc: 'Optional history logs encrypted inside IndexedDB using keys derived from PBKDF2. The server never gets your passphrase.'
    },
    {
      icon: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a9 9 0 1118 0 9 9 0 01-18 0z" />
      </svg>`,
      title: 'Volatile In-Memory Safety',
      desc: 'Active keys live exclusively in volatile JS memory. Closing your browser tab immediately destroys all decryption keys.'
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
    <div class="shield-badge">
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
      Zero-Knowledge Messaging
    </div>
    
    <h1 class="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] max-w-2xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      Decentralized Trust.<br/>Absolute Privacy.
    </h1>
    
    <p class="text-sm sm:text-lg text-vault-text-secondary max-w-lg leading-relaxed">
      Vault is an ephemeral, double-ratcheted secure messaging application designed to prevent logging, intercept, and digital trail tracing. 
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

  <!-- Technical Spec Footer -->
  <footer class="w-full border-t border-vault-border bg-vault-surface py-8 z-10">
    <div class="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-[10px] text-vault-text-dim uppercase tracking-wider font-semibold">
      <div class="flex items-center gap-2">
        <span>© {new Date().getFullYear()} Vault Cryptosystems</span>
      </div>
      <div class="flex gap-6">
        <span>Protocols: X3DH + Double Ratchet</span>
        <span>Storage: In-Memory / Local IndexedDB</span>
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
