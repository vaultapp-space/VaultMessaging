<script>
  import { onDestroy, onMount } from 'svelte';
  import { decryptFile, decryptChunk } from '../lib/crypto/keys.js';
  import { fetchAttachment, fetchAttachmentChunk } from '../lib/api/http.js';
  import { getAvatarGradient } from '../lib/avatar.js';

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

  let timer;
  let expiryText = getExpiryInfo(message.expiresAt);

  onMount(() => {
    timer = setInterval(() => {
      expiryText = getExpiryInfo(message.expiresAt);
    }, 1000);
    
    if (isAttachment) {
      loadAndDecryptFile();
    }
  });

  onDestroy(() => {
    clearInterval(timer);
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

  $: if (isAttachment && attachmentData && !objectUrl && !loadingFile && !loadFileError) {
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
</script>

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
            <div class="text-[10px] text-vault-text-dim uppercase tracking-wider font-semibold">🔒 Encrypted Attachment</div>
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
            {:else if objectUrl}
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
                  <audio src={objectUrl} controls class="w-full mt-1.5 accent-vault-accent focus:outline-none"></audio>
                </div>
              {:else}
                <a
                  href={objectUrl}
                  download={attachmentData.filename}
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
          </div>
        {:else}
          <div class="whitespace-pre-wrap break-words text-left">{@html parsedText}</div>
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
