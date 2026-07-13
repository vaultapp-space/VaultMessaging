<script>
  import { onDestroy, onMount } from 'svelte';
  import { decryptFile, decryptChunk } from '../lib/crypto/keys.js';
  import { fetchAttachment, fetchAttachmentChunk } from '../lib/api/http.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { getEVMTransactionStatus, getSolanaTransactionStatus, releaseEscrowAssets, decryptWallet, decryptWalletWithBioKey, ERC20_TOKENS, SPL_TOKENS } from '../lib/crypto/wallet.js';
  import { activePaymentDetails, currentUser, loginPassword, walletBioEnabled, walletState } from '../lib/stores/session.js';
  import { loadEncryptedBioWallet, loadEncryptedWallet } from '../lib/db.js';
  import { authenticateBiometric } from '../lib/crypto/webauthn.js';

  export let message;
  export let isOwn = false;
  export let showAvatar = true;
  export let searchQuery = '';

  function formatTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getExpiryInfo(expiresAt) {
    if (!expiresAt) return null;
    const diff = new Date(expiresAt) - new Date();
    if (diff <= 0) return 'Expired';
    if (diff < 60000) return `${Math.ceil(diff / 1000)}s`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    return `${Math.floor(diff / 3600000)}h`;
  }

  function getExplorerUrl(hash, network) {
    if (!hash) return '#';
    const chain = network ? network.toLowerCase() : 'ethereum';
    if (chain === 'bitcoin') return `https://mempool.space/tx/${hash}`;
    if (chain === 'solana' || chain === 'solana-devnet' || chain === 'solana-mainnet') return `https://solscan.io/tx/${hash}`;
    if (chain === 'base' || chain === 'base-sepolia') return `https://basescan.org/tx/${hash}`;
    if (chain === 'arbitrum') return `https://arbiscan.io/tx/${hash}`;
    if (chain === 'optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
    if (chain === 'polygon') return `https://polygonscan.com/tx/${hash}`;
    return `https://etherscan.io/tx/${hash}`;
  }

  function getChainName(network) {
    if (!network) return 'Ethereum';
    const chain = network.toLowerCase();
    if (chain === 'bitcoin') return 'Bitcoin';
    if (chain.includes('solana')) return 'Solana';
    if (chain === 'base' || chain === 'base-sepolia') return 'Base L2';
    if (chain === 'arbitrum') return 'Arbitrum L2';
    if (chain === 'optimism') return 'Optimism L2';
    if (chain === 'polygon') return 'Polygon';
    if (chain === 'ethereum') return 'Ethereum';
    return network;
  }

  let timer;
  let expiryText = getExpiryInfo(message.expiresAt);

  let burnOnReadRevealed = false;
  let burnOnReadTimerVal = 15;
  let burnOnReadCountdownTimer = null;
  let isBurned = false;

  async function revealBurnOnRead() {
    if (burnOnReadRevealed || isBurned) return;
    burnOnReadRevealed = true;
    await loadAndDecryptFile();
    if (objectUrl) {
      startBurnCountdown();
    } else {
      burnOnReadRevealed = false;
    }
  }

  function startBurnCountdown() {
    const isAudio = attachmentData && attachmentData.mimeType && attachmentData.mimeType.startsWith('audio/');
    burnOnReadTimerVal = isAudio ? 60 : 15;
    
    burnOnReadCountdownTimer = setInterval(() => {
      burnOnReadTimerVal--;
      if (burnOnReadTimerVal <= 0) {
        clearInterval(burnOnReadCountdownTimer);
        burnOnReadCountdownTimer = null;
        burnAndDestroy();
      }
    }, 1000);
  }

  function burnAndDestroy() {
    isBurned = true;
    if (burnOnReadCountdownTimer) {
      clearInterval(burnOnReadCountdownTimer);
      burnOnReadCountdownTimer = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    attachmentData = null;
  }

  onMount(() => {
    timer = setInterval(() => {
      expiryText = getExpiryInfo(message.expiresAt);
    }, 1000);
    
    if (isAttachment && attachmentData && !attachmentData.burnOnRead) {
      loadAndDecryptFile();
    }
  });

  onDestroy(() => {
    clearInterval(timer);
    if (burnOnReadCountdownTimer) clearInterval(burnOnReadCountdownTimer);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  });

  $: {
    expiryText = getExpiryInfo(message.expiresAt);
  }

  let isAttachment = false;
  let attachmentData = null;
  let objectUrl = null;
  let loadingFile = false;
  let loadFileError = null;

  $: {
    if (message.text && message.text.startsWith('{"type":"attachment"')) {
      try {
        attachmentData = JSON.parse(message.text);
        isAttachment = true;
      } catch {
        isAttachment = false;
        attachmentData = null;
      }
    } else {
      isAttachment = false;
      attachmentData = null;
    }
  }

  $: if (isAttachment && attachmentData && !attachmentData.burnOnRead && !objectUrl && !loadingFile && !loadFileError) {
    loadAndDecryptFile();
  }

  function base64ToBytes(base64) {
    const binString = atob(base64);
    const len = binString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
  }

  async function loadAndDecryptFile() {
    if (!attachmentData) return;
    loadingFile = true;
    loadFileError = null;
    try {
      const keyBytes = base64ToBytes(attachmentData.key);
      const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM' },
        true,
        ['decrypt']
      );
      const baseIv = base64ToBytes(attachmentData.iv);

      if (attachmentData.chunked) {
        // Progressive chunk download and decryption
        const totalChunks = attachmentData.totalChunks;
        const decryptedChunks = [];

        for (let i = 0; i < totalChunks; i++) {
          const chunkRes = await fetchAttachmentChunk(attachmentData.id, i);
          const encryptedChunkBytes = base64ToBytes(chunkRes.ciphertext);
          const decryptedBuffer = await decryptChunk(key, encryptedChunkBytes, i, baseIv);
          decryptedChunks.push(new Uint8Array(decryptedBuffer));
        }

        // Merge all decrypted chunks
        let totalLength = 0;
        decryptedChunks.forEach(chunk => totalLength += chunk.length);
        const mergedBytes = new Uint8Array(totalLength);
        let offset = 0;
        decryptedChunks.forEach(chunk => {
          mergedBytes.set(chunk, offset);
          offset += chunk.length;
        });

        const blob = new Blob([mergedBytes], { type: attachmentData.mimeType });
        objectUrl = URL.createObjectURL(blob);
      } else {
        // Fallback for old simple attachments
        const res = await fetchAttachment(attachmentData.id);
        const decryptedBuffer = await decryptFile(res.ciphertext, attachmentData.key, attachmentData.iv);
        const blob = new Blob([decryptedBuffer], { type: attachmentData.mimeType });
        objectUrl = URL.createObjectURL(blob);
      }
    } catch (err) {
      console.error('Failed to load/decrypt E2E file:', err);
      loadFileError = 'Failed to load file';
    } finally {
      loadingFile = false;
    }
  }

  function parseMarkdown(text, search = '') {
    if (!text) return '';
    if (text.startsWith('{"type":"attachment"')) return '';
    if (text.includes('"type":"crypto-payment"')) return '';
    if (text.includes('"type":"wallet-address-share"')) return '';
    if (text.includes('"type":"red-packet"')) return '';
    if (text.includes('"type":"escrow-otc"')) return '';
    if (text.includes('"type":"shielded-payment"')) return '';

    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    if (search) {
      const regex = new RegExp(`(${search.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
      escaped = escaped.replace(regex, '<mark class="bg-vault-warning/30 text-vault-warning border border-vault-warning/50 rounded px-0.5 font-semibold animate-pulse">$1</mark>');
    }

    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<div class="mt-1 bg-vault-black/60 border border-vault-border rounded-xl font-mono text-[11px] overflow-x-auto p-2.5 space-y-1 text-left relative group">
        <div class="text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold border-b border-vault-border pb-1 mb-1.5 flex justify-between">
          <span>${lang || 'code'}</span>
        </div>
        <pre class="whitespace-pre overflow-x-auto">${code.trim()}</pre>
      </div>`;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code class="bg-vault-black/40 border border-vault-border px-1.5 py-0.5 rounded font-mono text-[11px]">$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    const linkRegex = /(https?:\/\/[^\s]+)/g;
    escaped = escaped.replace(linkRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-vault-accent underline">$1</a>');

    return escaped;
  }

  $: displayText = message.decryptionError
    ? (message.text || '🔒 Decryption failed: Key mismatch')
    : message.decrypting
      ? 'Decrypting...'
      : message.encrypted
        ? 'Encrypted message'
        : message.text;

  $: parsedText = parseMarkdown(displayText, searchQuery);
  $: msgStatus = message.status || (message.delivered ? 'delivered' : 'sent');
  $: isSessionDesyncError = message.decryptionError && message.text && message.text.includes('Ratchet session not initialized');

  // Phase 3 DeFi: Payment parsing and tracking
  let isPayment = false;
  let paymentData = null;
  let paymentStatus = 'pending';
  let statusPollTimer = null;

  $: {
    if (message.text && message.text.includes('"type":"crypto-payment"')) {
      try {
        paymentData = JSON.parse(message.text);
        isPayment = true;
        paymentStatus = paymentData.status || 'pending';
      } catch {
        isPayment = false;
        paymentData = null;
      }
    } else {
      isPayment = false;
      paymentData = null;
    }
  }

  // Address Share parsing
  let isAddressShare = false;
  let addressShareData = null;
  let copiedText = '';

  $: {
    if (message.text && message.text.includes('"type":"wallet-address-share"')) {
      try {
        addressShareData = JSON.parse(message.text);
        isAddressShare = true;
      } catch {
        isAddressShare = false;
        addressShareData = null;
      }
    } else {
      isAddressShare = false;
      addressShareData = null;
    }
  }

  function copyAddressText(address, label) {
    navigator.clipboard.writeText(address);
    copiedText = label;
    setTimeout(() => copiedText = '', 2000);
  }

  function triggerInChatPayment() {
    if (!addressShareData) return;
    activePaymentDetails.set({
      evmAddress: addressShareData.evmAddress,
      solAddress: addressShareData.solAddress,
      username: addressShareData.senderUsername
    });
  }

  // Phase 5 DeFi: Red Packet Parsing and Logic
  let isRedPacket = false;
  let redPacketData = null;
  let redPacketClaimed = false;
  let isClaimingPacket = false;
  let claimedAmount = '';

  $: {
    if (message.text && message.text.includes('"type":"red-packet"')) {
      try {
        redPacketData = JSON.parse(message.text);
        isRedPacket = true;
        redPacketClaimed = redPacketData.claimedBy && redPacketData.claimedBy.includes($currentUser?.id);
      } catch {
        isRedPacket = false;
        redPacketData = null;
      }
    } else {
      isRedPacket = false;
      redPacketData = null;
    }
  }

  function triggerConfetti() {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#10b981', '#34d399', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa'];
    const particles = [];

    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: canvas.height + 10,
        vx: (Math.random() - 0.5) * 8,
        vy: -Math.random() * 12 - 10,
        size: Math.random() * 6 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rSpeed: Math.random() * 5 - 2.5
      });
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.35; // gravity
        p.rotation += p.rSpeed;
        
        if (p.y < canvas.height + 20) {
          alive = true;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }

      if (alive) {
        requestAnimationFrame(animate);
      } else {
        document.body.removeChild(canvas);
      }
    }

    animate();
  }

  async function handleClaimRedPacket() {
    if (!redPacketData || isClaimingPacket || redPacketClaimed) return;
    
    isClaimingPacket = true;
    try {
      const total = parseFloat(redPacketData.totalAmount);
      const claims = redPacketData.totalClaims;
      const share = (total / claims).toFixed(2);
      
      console.log(`[RedPacket] Claiming ${share} ${redPacketData.tokenSymbol}...`);
      
      if (typeof window !== 'undefined') {
        triggerConfetti();
      }

      redPacketData.claimedBy = [...(redPacketData.claimedBy || []), $currentUser.id];
      redPacketClaimed = true;
      claimedAmount = share;
      
      message.text = JSON.stringify(redPacketData);
    } catch (err) {
      console.error('Failed to claim red packet:', err);
      alert('Claim failed: ' + err.message);
    } finally {
      isClaimingPacket = false;
    }
  }

  // Phase 5 DeFi: Escrow OTC Contract Parsing and Logic
  let isEscrow = false;
  let escrowData = null;
  let escrowStatus = 'active'; // 'active' | 'released' | 'refunded'
  let isReleasingEscrow = false;
  let escrowTxHash = '';

  $: {
    if (message.text && message.text.includes('"type":"escrow-otc"')) {
      try {
        escrowData = JSON.parse(message.text);
        isEscrow = true;
        escrowStatus = escrowData.status || 'active';
      } catch {
        isEscrow = false;
        escrowData = null;
      }
    } else {
      isEscrow = false;
      escrowData = null;
    }
  }

  async function handleReleaseEscrow() {
    if (!escrowData || isReleasingEscrow || escrowStatus !== 'active') return;
    
    let password = $loginPassword;
    let bioKey = null;

    if ($walletBioEnabled) {
      isReleasingEscrow = true;
      try {
        const credId = localStorage.getItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
        const salt = $currentUser.salt;
        bioKey = await authenticateBiometric(credId, salt);
      } catch (err) {
        console.error('Biometric authentication failed:', err);
        isReleasingEscrow = false;
        return;
      }
    } else if (!password) {
      password = prompt('Enter your Vault account password to authorize and release escrow:');
      if (!password) return;
    }

    isReleasingEscrow = true;
    try {
      let mnemonic = '';
      if ($walletBioEnabled && bioKey) {
        const bioWalletData = await loadEncryptedBioWallet($currentUser.id);
        mnemonic = await decryptWalletWithBioKey(bioWalletData, bioKey);
      } else {
        const encryptedWallet = await loadEncryptedWallet($currentUser.id);
        if (!encryptedWallet) {
          throw new Error('No wallet backup found on this device.');
        }
        mnemonic = await decryptWallet(encryptedWallet, password);
      }

      const hash = await releaseEscrowAssets(
        mnemonic,
        escrowData.amount,
        escrowData.tokenSymbol,
        escrowData.network,
        escrowData.sellerAddress
      );

      escrowTxHash = hash;
      escrowStatus = 'released';
      escrowData.status = 'released';
      message.text = JSON.stringify(escrowData);
    } catch (err) {
      console.error('Release escrow failed:', err);
      alert('Release failed: ' + err.message);
    } finally {
      isReleasingEscrow = false;
    }
  }

  async function pollTransactionStatus() {
    if (!paymentData || paymentStatus !== 'pending') return;
    try {
      let status = 'pending';
      const isSolana = paymentData.network && paymentData.network.includes('solana');
      if (!isSolana) {
        status = await getEVMTransactionStatus(paymentData.txHash, paymentData.network);
      } else {
        status = await getSolanaTransactionStatus(paymentData.txHash);
      }
      
      if (status !== 'pending') {
        paymentStatus = status;
        if (statusPollTimer) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
        }
      }
    } catch (err) {
      console.error('Error polling transaction status:', err);
    }
  }

  $: if (isPayment && paymentStatus === 'pending' && !statusPollTimer) {
    statusPollTimer = setInterval(pollTransactionStatus, 4000);
    pollTransactionStatus();
  }

  // Phase 6 DeFi: Shielded Payment parsing
  let isShieldedPayment = false;
  let shieldedPaymentData = null;

  $: {
    if (message.text && message.text.includes('"type":"shielded-payment"')) {
      try {
        shieldedPaymentData = JSON.parse(message.text);
        isShieldedPayment = true;
      } catch {
        isShieldedPayment = false;
        shieldedPaymentData = null;
      }
    } else {
      isShieldedPayment = false;
      shieldedPaymentData = null;
    }
  }

  onDestroy(() => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
    }
  });</script>

<div
  class="flex {isOwn ? 'justify-end' : 'justify-start'} {showAvatar ? 'mt-3' : 'mt-0.5'}"
  class:animate-slide-right={!isOwn}
  class:animate-slide-left={isOwn}
>
  <div class="flex items-end gap-2 max-w-[75%] {isOwn ? 'flex-row-reverse' : 'flex-row'}">
    <!-- Avatar -->
    {#if showAvatar && !isOwn}
      <div
        class="w-8 h-8 rounded-full flex items-center justify-center text-vault-white font-semibold text-xs flex-shrink-0 shadow-inner"
        style="background: {getAvatarGradient(message.senderUsername)}"
      >
        {message.senderUsername?.[0]?.toUpperCase() || '?'}
      </div>
    {:else if !isOwn}
      <div class="w-6 flex-shrink-0"></div>
    {/if}

    <!-- Message Bubble -->
    <div class="group relative">
      <div class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed transition-all
        {isOwn
          ? 'bg-vault-accent/15 text-vault-text border border-vault-accent/20 rounded-br-md'
          : 'bg-vault-elevated text-vault-text border border-vault-border-subtle rounded-bl-md'}
        {message.failed ? 'border-vault-danger/30 bg-vault-danger/5' : ''}
        {message.optimistic ? 'opacity-70' : ''}
      ">
        <!-- Encrypted/Decrypting/Failed indicators -->
        {#if message.encrypted || message.decryptionError || message.decrypting}
          <div class="flex flex-col gap-1 text-xs italic {message.decryptionError ? 'text-vault-danger' : 'text-vault-text-dim'}">
            <div class="flex items-center gap-1.5">
              {#if message.decrypting}
                <svg class="w-3.5 h-3.5 text-vault-accent animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                </svg>
              {:else if message.decryptionError}
                <svg class="w-3.5 h-3.5 text-vault-danger flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              {:else}
                <svg class="w-3.5 h-3.5 text-vault-accent flex-shrink-0" style="animation: lock-pulse 2s ease-in-out infinite;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              {/if}
              <span class="truncate max-w-[200px]" title={displayText}>{displayText}</span>
            </div>
            {#if isSessionDesyncError}
              <div class="text-[10px] text-vault-text-dim mt-0.5 not-italic">
                Session reset (Sender refreshed. Send a message to restore E2EE sync).
              </div>
            {/if}
          </div>
        {:else if isAttachment}
          <!-- Attachment rendering block -->
          <div class="flex flex-col gap-1.5 min-w-[200px]">
            {#if isBurned}
              <div class="flex items-center gap-2 text-xs text-vault-danger/70 bg-vault-danger/5 border border-vault-danger/10 px-3.5 py-2.5 rounded-xl select-none">
                <svg class="w-4 h-4 text-vault-danger/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                </svg>
                <span>This media has been burned & deleted.</span>
              </div>
            {:else if attachmentData && attachmentData.burnOnRead && !burnOnReadRevealed}
              <div class="flex flex-col gap-2 p-3 bg-vault-surface-subtle border border-vault-border rounded-xl select-none text-center">
                <div class="text-[10px] text-vault-danger font-semibold uppercase tracking-wider flex items-center justify-center gap-1.5 animate-pulse">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                  </svg>
                  Burn-on-Read Media
                </div>
                <p class="text-[9px] text-vault-text-dim leading-normal">
                  This file can only be opened once. It will be permanently deleted after viewing.
                </p>
                <button
                  on:click={revealBurnOnRead}
                  class="w-full mt-1 py-1.5 bg-vault-danger hover:bg-vault-danger-hover text-vault-black font-semibold text-[10px] rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none border-none"
                >
                  Reveal Attachment
                </button>
              </div>
            {:else}
              <div class="text-[10px] text-vault-text-dim uppercase tracking-wider font-semibold flex items-center gap-1.5">
                <span>🔒 Encrypted Attachment</span>
                {#if attachmentData && attachmentData.burnOnRead}
                  <span class="text-vault-danger font-bold flex items-center gap-0.5 animate-pulse">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                    </svg>
                    Burning ({burnOnReadTimerVal}s)
                  </span>
                {/if}
              </div>
              {#if loadingFile}
                <div class="flex items-center gap-2 text-xs text-vault-text-dim py-2">
                  <svg class="w-4 h-4 animate-spin text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                  </svg>
                  Decrypting...
                </div>
              {:else if loadFileError}
                <div class="text-xs text-vault-danger py-1">
                  ⚠️ {loadFileError}
                </div>
              {:else if objectUrl && attachmentData}
                {#if attachmentData.mimeType.startsWith('image/')}
                  <button
                    on:click={() => window.open(objectUrl, '_blank')}
                    class="bg-transparent border-none p-0 cursor-pointer text-left block max-w-full focus:outline-none"
                    aria-label="View full size image"
                  >
                    <img
                      src={objectUrl}
                      alt={attachmentData.filename}
                      class="max-w-full max-h-[200px] rounded-lg border border-vault-border object-contain"
                    />
                  </button>
                {:else if attachmentData.mimeType.startsWith('audio/')}
                  <div class="flex flex-col gap-1.5 p-2.5 bg-vault-black/30 border border-vault-border rounded-xl min-w-[240px]">
                    <div class="flex items-center gap-2 text-xs font-semibold text-vault-accent">
                      <svg class="w-4 h-4 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
                      </svg>
                      Voice Note
                    </div>
                    <audio 
                      src={objectUrl} 
                      controls 
                      on:ended={burnAndDestroy}
                      class="w-full mt-1.5 accent-vault-accent focus:outline-none"
                    ></audio>
                  </div>
                {:else}
                  <a
                    href={objectUrl}
                    download={attachmentData.filename}
                    on:click={() => {
                      if (attachmentData && attachmentData.burnOnRead) {
                        setTimeout(burnAndDestroy, 3000);
                      }
                    }}
                    class="flex items-center gap-2 px-3 py-2 bg-vault-black/40 hover:bg-vault-elevated border border-vault-border rounded-xl text-xs font-semibold text-vault-accent transition-all cursor-pointer"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download {attachmentData.filename}
                  </a>
                {/if}
              {/if}
            {/if}
          </div>
        {:else}
          {#if isPayment && paymentData}
            <div class="flex flex-col gap-2 p-3 bg-vault-black/30 border border-vault-border rounded-2xl min-w-[240px] text-left">
              <div class="flex items-center justify-between">
                <span class="text-[9px] text-vault-accent font-bold uppercase tracking-wider flex items-center gap-1">
                  {#if paymentStatus === 'pending'}
                    <span class="w-1.5 h-1.5 rounded-full bg-vault-warning animate-ping"></span>
                    <span class="text-vault-warning">Pending</span>
                  {:else if paymentStatus === 'confirmed'}
                    <span class="w-1.5 h-1.5 rounded-full bg-vault-accent animate-pulse"></span>
                    <span class="text-vault-accent">Confirmed</span>
                  {:else}
                    <span class="w-1.5 h-1.5 rounded-full bg-vault-danger"></span>
                    <span class="text-vault-danger">Failed</span>
                  {/if}
                </span>
                <span class="text-[8px] text-vault-text-dim font-bold uppercase">
                  {getChainName(paymentData.network)}
                </span>
              </div>

              <div class="flex items-center gap-2 py-1">
                <span class="text-lg font-semibold w-8 h-8 rounded-xl bg-vault-black/40 border border-vault-border flex items-center justify-center text-vault-accent">
                  💲
                </span>
                <div>
                  <span class="text-sm font-bold block leading-none font-mono text-vault-text">{paymentData.amount} {paymentData.tokenSymbol}</span>
                  <span class="text-[9px] text-vault-text-dim mt-0.5 block">Payment Transfer</span>
                </div>
              </div>

              <div class="border-t border-vault-border-subtle pt-2 flex flex-col gap-1 text-[9px] text-vault-text-dim">
                <div class="truncate">
                  Hash: <span class="font-mono">{paymentData.txHash}</span>
                </div>
                <a
                  href={getExplorerUrl(paymentData.txHash, paymentData.network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-vault-accent font-semibold hover:underline block"
                >
                  View on Block Explorer
                </a>
              </div>
            </div>
          {:else if isAddressShare && addressShareData}
            <div class="flex flex-col gap-2 p-3 bg-vault-black/30 border border-vault-border rounded-2xl min-w-[240px] text-left">
              <div class="flex items-center justify-between">
                <span class="text-[9px] text-vault-accent font-bold uppercase tracking-wider">Address Card</span>
                <span class="text-[8px] text-vault-text-dim font-bold uppercase">DeFi Keys</span>
              </div>
              
              <div class="text-[11px] font-bold text-vault-text">
                {addressShareData.senderUsername || 'Contact'}'s Public Addresses
              </div>
              
              <div class="space-y-1.5 mt-1 border-t border-vault-border-subtle pt-2">
                <div class="flex flex-col gap-0.5">
                  <div class="flex items-center justify-between text-[8px] text-vault-text-dim">
                    <span>EVM (BASE/ARBITRUM)</span>
                    <button 
                      on:click={() => copyAddressText(addressShareData.evmAddress, 'evm')} 
                      class="text-vault-accent hover:underline text-[9px] cursor-pointer border-none bg-transparent p-0"
                    >
                      {copiedText === 'evm' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div class="font-mono text-[9px] truncate bg-vault-black/40 p-1.5 rounded border border-vault-border-subtle select-all">
                    {addressShareData.evmAddress}
                  </div>
                </div>
                
                <div class="flex flex-col gap-0.5">
                  <div class="flex items-center justify-between text-[8px] text-vault-text-dim">
                    <span>SOLANA</span>
                    <button 
                      on:click={() => copyAddressText(addressShareData.solAddress, 'sol')} 
                      class="text-vault-accent hover:underline text-[9px] cursor-pointer border-none bg-transparent p-0"
                    >
                      {copiedText === 'sol' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div class="font-mono text-[9px] truncate bg-vault-black/40 p-1.5 rounded border border-vault-border-subtle select-all">
                    {addressShareData.solAddress}
                  </div>
                </div>
              </div>
              
              {#if !isOwn}
                <button
                  on:click={triggerInChatPayment}
                  class="mt-2 w-full py-1.5 px-3 bg-vault-accent hover:bg-vault-accent-hover text-vault-black text-[10px] font-bold rounded-xl transition-all text-center cursor-pointer border-none"
                >
                  Send Payment
                </button>
              {/if}
            </div>
          {:else if isRedPacket && redPacketData}
            <div class="flex flex-col gap-2.5 p-3.5 bg-gradient-to-br from-vault-danger/20 to-vault-surface/40 border border-vault-danger/30 rounded-2xl min-w-[240px] text-left relative overflow-hidden">
              <div class="absolute -right-3 -top-3 text-4xl opacity-10 select-none">🧧</div>
              
              <div class="flex items-center justify-between">
                <span class="text-[9px] text-vault-danger font-bold uppercase tracking-wider flex items-center gap-1">
                  <span>🧧</span> Airdrop Red Envelope
                </span>
                <span class="text-[8px] bg-vault-danger/20 text-vault-danger border border-vault-danger/30 px-1.5 py-0.5 rounded-full font-bold font-mono">
                  {redPacketData.tokenSymbol}
                </span>
              </div>
              
              <div>
                <span class="text-xs text-vault-text-dim block leading-tight">Total Envelope Pool</span>
                <span class="text-lg font-bold block leading-none font-mono text-vault-text mt-0.5">
                  {redPacketData.totalAmount} {redPacketData.tokenSymbol}
                </span>
              </div>

              <div class="border-t border-vault-border-subtle pt-2 text-[9px] text-vault-text-dim space-y-1">
                <div class="flex justify-between font-medium">
                  <span>Claims Progress:</span>
                  <span class="text-vault-text font-mono font-bold">{(redPacketData.claimedBy || []).length} / {redPacketData.totalClaims}</span>
                </div>
                <div class="w-full h-1 bg-vault-black/40 rounded-full overflow-hidden">
                  <div class="h-full bg-vault-danger transition-all duration-300" style="width: {((redPacketData.claimedBy || []).length / redPacketData.totalClaims) * 100}%"></div>
                </div>
              </div>

              {#if redPacketClaimed}
                <div class="mt-1 bg-vault-accent/10 border border-vault-accent/20 rounded-xl p-2 text-center text-[10px] text-vault-accent font-semibold flex items-center justify-center gap-1">
                  <span>🎉</span> You claimed this packet!
                </div>
              {:else if (redPacketData.claimedBy || []).length >= redPacketData.totalClaims}
                <div class="mt-1 bg-vault-elevated border border-vault-border rounded-xl p-2 text-center text-[10px] text-vault-text-dim">
                  All envelopes have been claimed.
                </div>
              {:else}
                <button
                  on:click={handleClaimRedPacket}
                  disabled={isClaimingPacket}
                  class="mt-1.5 w-full py-2 bg-vault-danger hover:bg-vault-danger-hover text-vault-white text-[10px] font-bold rounded-xl transition-all text-center cursor-pointer border-none flex items-center justify-center gap-1.5 shadow-md shadow-vault-danger/20 disabled:opacity-40"
                >
                  {#if isClaimingPacket}
                    <svg class="w-3 h-3 animate-spin text-vault-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                    </svg>
                    Claiming...
                  {:else}
                    <span>🧧</span> Open Red Packet
                  {/if}
                </button>
              {/if}
            </div>
          {:else if isEscrow && escrowData}
            <div class="flex flex-col gap-2.5 p-3.5 bg-vault-black/30 border border-vault-border rounded-2xl min-w-[240px] text-left relative">
              <div class="flex items-center justify-between">
                <span class="text-[9px] text-vault-accent font-bold uppercase tracking-wider flex items-center gap-1">
                  <span>🛡️</span> Trustless OTC Escrow
                </span>
                <span class="text-[8px] px-1.5 py-0.5 rounded-full font-bold font-mono uppercase border {escrowStatus === 'released' ? 'bg-vault-accent/20 text-vault-accent border-vault-accent/30' : 'bg-vault-warning/20 text-vault-warning border-vault-warning/30'}">
                  {escrowStatus}
                </span>
              </div>

              <div>
                <span class="text-[10px] text-vault-text-dim block leading-tight">Locked Collateral</span>
                <span class="text-base font-bold block leading-none font-mono text-vault-text mt-0.5">
                  {escrowData.amount} {escrowData.tokenSymbol}
                </span>
              </div>

              <div class="border-t border-vault-border-subtle pt-2 space-y-1.5 text-[9px] text-vault-text-dim">
                <div class="flex justify-between">
                  <span>Seller (Recipient):</span>
                  <span class="text-vault-text font-semibold font-mono truncate max-w-[120px]" title={escrowData.sellerAddress}>
                    {escrowData.sellerUsername || escrowData.sellerAddress}
                  </span>
                </div>
                <div class="flex justify-between">
                  <span>Buyer (Depositor):</span>
                  <span class="text-vault-text font-semibold font-mono truncate max-w-[120px]" title={escrowData.buyerAddress}>
                    {escrowData.buyerUsername || escrowData.buyerAddress}
                  </span>
                </div>
                {#if escrowData.description}
                  <div class="flex flex-col gap-0.5 border-t border-vault-border-subtle/50 pt-1.5">
                    <span>Agreement/Terms:</span>
                    <span class="text-vault-text font-sans font-medium italic mt-0.5 bg-vault-black/20 p-1.5 rounded border border-vault-border-subtle/30">
                      "{escrowData.description}"
                    </span>
                  </div>
                {/if}
              </div>

              {#if escrowStatus === 'released'}
                <div class="mt-1 bg-vault-accent/10 border border-vault-accent/20 rounded-xl p-2 text-center text-[10px] text-vault-accent font-semibold">
                  Released. Funds sent to Seller.
                </div>
                {#if escrowTxHash}
                  <div class="text-[8px] text-vault-text-dim font-mono truncate text-center mt-1">
                    Tx: {escrowTxHash}
                  </div>
                {/if}
              {:else if escrowStatus === 'active'}
                {#if $currentUser?.username?.toLowerCase() === escrowData.buyerUsername?.toLowerCase() || $walletState?.evmAddress?.toLowerCase() === escrowData.buyerAddress?.toLowerCase() || $walletState?.solAddress?.toLowerCase() === escrowData.buyerAddress?.toLowerCase()}
                  <button
                    on:click={handleReleaseEscrow}
                    disabled={isReleasingEscrow}
                    class="mt-1.5 w-full py-2 bg-vault-accent hover:bg-vault-accent-hover text-vault-black text-[10px] font-bold rounded-xl transition-all text-center cursor-pointer border-none flex items-center justify-center gap-1 disabled:opacity-40"
                  >
                    {#if isReleasingEscrow}
                      <svg class="w-3 h-3 animate-spin text-vault-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                      </svg>
                      Releasing Funds...
                    {:else}
                      Approve & Release Funds
                    {/if}
                  </button>
                {:else}
                  <div class="mt-1.5 bg-vault-black/30 border border-vault-border-subtle/50 rounded-xl p-2 text-center text-[9px] text-vault-text-dim font-medium">
                    Waiting for buyer approval & release
                  </div>
                {/if}
              {/if}
            </div>
          {:else if isShieldedPayment && shieldedPaymentData}
            <div class="flex flex-col gap-2 p-3 bg-vault-black/80 border border-vault-border rounded-2xl min-w-[240px] text-left relative overflow-hidden">
              <div class="absolute -right-3 -top-3 text-4xl opacity-10 select-none">🛡️</div>
              
              <div class="flex items-center justify-between">
                <span class="text-[9px] text-vault-accent font-bold uppercase tracking-wider flex items-center gap-1">
                  <span>🛡️</span> zk-SNARK Private Shielded Transfer
                </span>
                <span class="text-[8px] bg-vault-accent/20 text-vault-accent border border-vault-accent/30 px-1.5 py-0.5 rounded-full font-bold">
                  Verified
                </span>
              </div>

              <div class="flex items-center gap-2 py-1 mt-1">
                <span class="text-lg font-semibold w-8 h-8 rounded-xl bg-vault-black/40 border border-vault-border flex items-center justify-center text-vault-accent">
                  👤
                </span>
                <div>
                  <span class="text-sm font-bold block leading-none font-mono text-vault-text">{shieldedPaymentData.amount} {shieldedPaymentData.tokenSymbol}</span>
                  <span class="text-[8px] text-vault-accent mt-0.5 block font-semibold uppercase tracking-wider font-sans">Zero-Knowledge Private Transaction</span>
                </div>
              </div>

              <div class="border-t border-vault-border-subtle pt-2 flex flex-col gap-1 text-[8px] text-vault-text-dim select-none font-mono">
                <div class="flex justify-between">
                  <span>Sender Address:</span>
                  <span class="text-vault-text-secondary">[SHIELDED zk-SENDER]</span>
                </div>
                <div class="flex justify-between">
                  <span>Recipient Address:</span>
                  <span class="text-vault-text-secondary">[SHIELDED zk-RECIPIENT]</span>
                </div>
                <div class="truncate">
                  Proof: <span class="text-vault-text">{shieldedPaymentData.zkProof.substring(0, 16)}...</span>
                </div>
                <div class="truncate">
                  Nullifier: <span class="text-vault-text">{shieldedPaymentData.zkNullifier.substring(0, 16)}...</span>
                </div>
              </div>
            </div>
          {:else}
            <div class="whitespace-pre-wrap break-words text-left">{@html parsedText}</div>
          {/if}
        {/if}

        <!-- Meta row -->
        <div class="flex items-center justify-end gap-1.5 mt-1 -mb-0.5">
          {#if message.failed}
            <span class="text-[9px] text-vault-danger">Failed to send</span>
          {/if}

          {#if expiryText}
            <span class="text-[9px] text-vault-warning/60 flex items-center gap-0.5">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              {expiryText}
            </span>
          {/if}

          <span class="text-[9px] text-vault-text-dim/40">{formatTime(message.sentAt)}</span>

          {#if isOwn && !message.failed}
            {#if msgStatus === 'sending'}
              <svg class="w-2.5 h-2.5 text-vault-text-dim/20 animate-spin status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.2" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            {:else if msgStatus === 'sent'}
              <svg class="w-3 h-3 text-vault-text-dim/30 status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12l5 5L20 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {:else if msgStatus === 'delivered'}
              <svg class="w-3 h-3 text-vault-text-dim/50 status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12l5 5L18 5M6 12l5 5L23 5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {:else if msgStatus === 'read'}
              <svg class="w-3 h-3 text-vault-accent status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12l5 5L18 5M6 12l5 5L23 5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  :global(.status-icon) {
    display: inline-block;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    animation: status-appear 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  @keyframes status-appear {
    from {
      opacity: 0;
      transform: scale(0.8) rotate(-10deg);
    }
    to {
      opacity: 1;
      transform: scale(1) rotate(0deg);
    }
  }
</style>
