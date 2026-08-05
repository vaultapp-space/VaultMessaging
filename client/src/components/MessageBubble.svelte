<script>
  import { parseEnvelope, isMedia } from '$shared/envelope.js';
  import Poll from './Poll.svelte';
  import { currentUser } from '../lib/stores/session.js';
  import { clickOutside } from '../lib/actions/clickOutside.js';
  import { onDestroy, onMount } from 'svelte';
  import { decryptFile, decryptChunk } from '../lib/crypto/keys.js';
  import { fetchAttachment, fetchAttachmentChunk, markMessageViewed, publicMediaUrl, pressBotButton } from '../lib/api/http.js';
  import { getAvatarGradient } from '../lib/avatar.js';

  export let message;
  export let isOwn = false;
  export let showAvatar = true;
  export let searchQuery = '';
  // Supplied by the message list; null in contexts that cannot react (e.g. a
  // message whose chat has no id yet).
  export let onToggleReaction = null;
  // Reply affordances, supplied by the message list.
  export let onReply = null;
  export let onJumpToSeq = null;
  // The message this one answers, already resolved by the list. Null when the
  // original has expired — replies outlive what they answer, because messages
  // are reaped individually.
  export let quoted = null;
  export let onEdit = null;
  export let onDelete = null;
  export let onTogglePin = null;
  export let onForward = null;

  // A deliberately small set. A full emoji picker is Phase 2 work in its own
  // right; these six cover the overwhelming majority of real usage and keep
  // the interaction one tap.
  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  let showReactionPicker = false;

  $: myUserId = $currentUser?.id;
  $: reactions = message.reactions || [];
  $: canReact = typeof onToggleReaction === 'function' && Boolean(message.seq);
  $: canReply = typeof onReply === 'function' && Boolean(message.seq);
  // Only the author, and only for text — editing media is a later feature.
  $: canEditThis = typeof onEdit === 'function' && isOwn && Boolean(message.seq) && !isAttachment && !message.deletedAt;
  $: canDelete = typeof onDelete === 'function' && Boolean(message.seq) && !message.deletedAt;
  $: canPin = typeof onTogglePin === 'function' && Boolean(message.seq) && !message.deletedAt;
  $: canForward = typeof onForward === 'function' && Boolean(message.seq) && !message.deletedAt && !isAttachment;
  $: isDeleted = Boolean(message.deletedAt);

  // ─── View-once ────────────────────────────────────────────
  // Distinct from burn-on-read above, which is a client-side timer on an
  // E2EE attachment. This one is enforced by the server: opening it clears
  // the content server-side, so it is gone rather than merely hidden.
  // ─── Inline keyboards ─────────────────────────────────────
  // A bot's buttons. The press is validated server-side against the markup
  // stored on the message, so a fabricated payload gets nowhere — this is
  // only the rendering.
  $: keyboardRows = message.replyMarkup?.inline_keyboard ?? [];
  let pressing = null;

  async function pressButton(button) {
    if (pressing || !message.chatId || message.seq == null) return;
    pressing = button.callback_data;
    try {
      await pressBotButton(message.chatId, message.seq, button.callback_data);
    } catch (err) {
      console.error('Failed to press button:', err);
    } finally {
      pressing = null;
    }
  }

  $: isViewOnce = Boolean(message.viewOnce);
  // Content already gone: either someone opened it, or it was never ours to
  // see. Either way the bubble shows a spent marker, not an empty message.
  $: viewOnceSpent = isViewOnce && !message.text && !message.body && !message.media;
  let openingViewOnce = false;
  let viewOnceOpen = false;

  async function openViewOnce() {
    if (openingViewOnce || viewOnceOpen || !message.chatId || message.seq == null) return;
    openingViewOnce = true;
    try {
      await markMessageViewed(message.chatId, message.seq);
      // Shown from the copy already in memory. The server has cleared it by
      // now, so this is the only chance to display it — which is the point.
      viewOnceOpen = true;
    } catch (err) {
      console.error('Failed to open view-once message:', err);
    } finally {
      openingViewOnce = false;
    }
  }

  function toggle(emoji) {
    showReactionPicker = false;
    onToggleReaction?.(message, emoji);
  }

  function reactedByMe(entry) {
    return Boolean(myUserId && entry.users?.includes(myUserId));
  }

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

  let objectUrl = null;
  let loadingFile = false;
  let loadFileError = null;

  // Payload type comes from the envelope, not from sniffing the string's
  // prefix. Legacy attachment payloads are lifted into envelope form by
  // parseEnvelope, so pre-existing messages keep rendering unchanged.
  // Prefer the envelope the store already built. Re-parsing `text` only
  // works for secret messages, where the envelope *is* the plaintext; a cloud
  // message's structure lives in columns, and its `text` is just the body —
  // empty for a sticker, which would then render as an empty bubble.
  $: envelope = message.envelope ?? (message.text != null ? parseEnvelope(message.text) : null);
  // A sticker is media, but it renders as a bare image with no bubble
  // chrome — running it through the attachment path would try to fetch and
  // decrypt a file that is public and unencrypted by design.
  $: isSticker = envelope?.t === 'sticker' && envelope?.media?.fileId;
  $: isAttachment = isMedia(envelope) && !isSticker;
  // isBurned is folded in here rather than nulled by burnAndDestroy(): the
  // value is derived now, so an imperative assignment would be recomputed
  // away on the next update and the burned media would reappear.
  $: attachmentData = isAttachment && !isBurned
    ? { ...envelope.media, type: 'attachment' }
    : null;

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
    // Media envelopes render from `media`, never as their serialised text.
    if (isAttachment) return '';

    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    if (search) {
      const regex = new RegExp(`(${search.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
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

<!-- data-seq is the anchor jumpToSeq() scrolls to when a quoted reply is
     tapped; without it a reply can reference a message the UI cannot find. -->
<div
  data-seq={message.seq ?? undefined}
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
        {:else if isSticker}
          <img
            src={publicMediaUrl(envelope.media.fileId)}
            alt={envelope.media.emoji || 'Sticker'}
            loading="lazy"
            class="w-32 h-32 object-contain"
          />
        {:else if viewOnceSpent}
          <div class="italic text-vault-text-dim text-sm flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22" />
            </svg>
            Opened — this could only be viewed once
          </div>
        {:else if isViewOnce && !isOwn && !viewOnceOpen}
          <button
            on:click={openViewOnce}
            disabled={openingViewOnce}
            class="flex items-center gap-2 px-3 py-2 rounded-lg bg-vault-black/20 hover:bg-vault-black/30 transition-colors focus:outline-none"
          >
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span class="text-xs">{openingViewOnce ? 'Opening…' : 'Tap to view once'}</span>
          </button>
        {:else if message.poll}
          <Poll poll={message.poll} chatId={message.chatId} seq={message.seq} />
        {:else if isDeleted}
          <div class="italic text-vault-text-dim text-sm flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
            This message was deleted
          </div>
        {:else}
          {#if message.replyToSeq}
            <!-- The original may have expired even though this reply has not;
                 say so rather than rendering an empty quote. -->
            <button
              on:click={() => quoted && onJumpToSeq?.(message.replyToSeq)}
              disabled={!quoted}
              class="w-full flex items-start gap-1.5 mb-1 px-2 py-1 rounded-md bg-vault-black/20 border-l-2 border-vault-accent/60 text-left {quoted ? 'hover:bg-vault-black/30 cursor-pointer' : 'cursor-default'} transition-colors focus:outline-none"
              title={quoted ? 'Jump to the original message' : 'The original message has expired'}
            >
              <span class="text-[11px] truncate {quoted ? 'text-vault-text-dim' : 'text-vault-muted italic'}">
                {quoted ? (quoted.text || 'Attachment') : 'Original message expired'}
              </span>
            </button>
          {/if}
          <div class="whitespace-pre-wrap break-words text-left">{@html parsedText}</div>

          {#if message.preview}
            <!-- Everything here is rendered as TEXT, never {@html}. The title
                 and description come from a third-party page the sender chose,
                 so they are attacker-controlled: interpolating them as markup
                 would hand anyone who can post a link a scripting primitive in
                 every recipient's client. -->
            <a
              href={message.preview.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="mt-1.5 flex flex-col rounded-lg overflow-hidden border-l-2 border-vault-accent bg-vault-black/20 hover:bg-vault-black/30 transition-colors"
            >
              <div class="px-2.5 py-2">
                {#if message.preview.siteName}
                  <div class="text-[10px] text-vault-accent font-medium truncate">
                    {message.preview.siteName}
                  </div>
                {/if}
                <div class="text-xs text-vault-text font-medium line-clamp-2">
                  {message.preview.title}
                </div>
                {#if message.preview.description}
                  <div class="text-[11px] text-vault-text-dim line-clamp-2 mt-0.5">
                    {message.preview.description}
                  </div>
                {/if}
              </div>
            </a>
          {/if}
        {/if}

        {#if keyboardRows.length > 0}
          <div class="flex flex-col gap-1 mt-1.5">
            {#each keyboardRows as row, rowIndex (rowIndex)}
              <div class="flex gap-1">
                {#each row as button (button.callback_data ?? button.text)}
                  <button
                    on:click={() => pressButton(button)}
                    disabled={pressing === button.callback_data || !button.callback_data}
                    class="flex-1 px-2 py-1 rounded-lg bg-vault-black/25 hover:bg-vault-black/40 text-[11px] text-vault-text transition-colors disabled:opacity-50 focus:outline-none"
                  >{button.text}</button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Meta row -->
        <div class="flex items-center justify-end gap-1.5 mt-1 -mb-0.5">
          {#if message.failed}
            <span class="text-[9px] text-vault-danger">Failed to send</span>
          {/if}

          {#if message.pinnedAt}
            <span class="text-[9px] text-vault-accent flex items-center gap-0.5" title="Pinned message">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 3v6l2 3v2h-5v7l-1 1-1-1v-7H6v-2l2-3V3h8z" />
              </svg>
            </span>
          {/if}

          {#if message.editedAt}
            <span class="text-[9px] text-vault-text-dim italic" title="This message was edited">edited</span>
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

      <!-- Reactions -->
      {#if !isDeleted && (reactions.length > 0 || canReact || canReply || canEditThis || canDelete || canPin || canForward)}
        <div class="flex items-center gap-1 mt-1 flex-wrap {isOwn ? 'justify-end' : 'justify-start'}">
          {#each reactions as entry (entry.emoji)}
            <button
              on:click={() => toggle(entry.emoji)}
              disabled={!canReact}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-all focus:outline-none
                {reactedByMe(entry)
                  ? 'bg-vault-accent/20 border-vault-accent/50 text-vault-accent'
                  : 'bg-vault-elevated border-vault-border-subtle text-vault-text-dim hover:border-vault-border'}"
              title={reactedByMe(entry) ? 'Remove your reaction' : 'React'}
              aria-label="{reactedByMe(entry) ? 'Remove your' : 'Add'} {entry.emoji} reaction ({entry.count})"
            >
              <span>{entry.emoji}</span>
              {#if entry.count > 1}<span class="font-medium">{entry.count}</span>{/if}
            </button>
          {/each}

          {#if canForward}
            <button
              on:click={() => onForward(message)}
              class="px-1.5 py-0.5 rounded-full text-[11px] text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
              title="Forward"
              aria-label="Forward this message"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 17 20 12 15 7" />
                <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
              </svg>
            </button>
          {/if}

          {#if canPin}
            <button
              on:click={() => onTogglePin(message)}
              class="px-1.5 py-0.5 rounded-full text-[11px] {message.pinnedAt ? 'text-vault-accent' : 'text-vault-text-dim'} hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
              title={message.pinnedAt ? 'Unpin' : 'Pin'}
              aria-label={message.pinnedAt ? 'Unpin this message' : 'Pin this message'}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 3v6l2 3v2h-5v7l-1 1-1-1v-7H6v-2l2-3V3h8z" />
              </svg>
            </button>
          {/if}

          {#if canDelete}
            <button
              on:click={() => onDelete(message)}
              class="px-1.5 py-0.5 rounded-full text-[11px] text-vault-text-dim hover:text-vault-danger hover:bg-vault-elevated transition-all focus:outline-none"
              title="Delete"
              aria-label="Delete this message"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
            </button>
          {/if}

          {#if canEditThis}
            <button
              on:click={() => onEdit(message)}
              class="px-1.5 py-0.5 rounded-full text-[11px] text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
              title="Edit"
              aria-label="Edit this message"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          {/if}

          {#if canReply}
            <button
              on:click={() => onReply(message)}
              class="px-1.5 py-0.5 rounded-full text-[11px] text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
              title="Reply"
              aria-label="Reply to this message"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 17 4 12 9 7" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
            </button>
          {/if}

          {#if canReact}
            <div class="relative">
              <button
                on:click={() => showReactionPicker = !showReactionPicker}
                class="px-1.5 py-0.5 rounded-full text-[11px] text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
                title="Add reaction"
                aria-label="Add reaction"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" stroke-linecap="round" />
                  <line x1="9" y1="9" x2="9.01" y2="9" stroke-linecap="round" />
                  <line x1="15" y1="9" x2="15.01" y2="9" stroke-linecap="round" />
                </svg>
              </button>

              {#if showReactionPicker}
                <div
                  class="absolute z-20 bottom-full mb-1 {isOwn ? 'right-0' : 'left-0'} flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg"
                  use:clickOutside={() => showReactionPicker = false}
                >
                  {#each QUICK_REACTIONS as emoji}
                    <button
                      on:click={() => toggle(emoji)}
                      class="w-7 h-7 rounded-lg text-base hover:bg-vault-elevated transition-all focus:outline-none"
                      title="React with {emoji}"
                      aria-label="React with {emoji}"
                    >
                      {emoji}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  :global(.status-icon) {
    display: inline-block;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    animation: status-appear 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  /* Flashed briefly after jumping to a quoted message, so the eye lands on
     the right one rather than hunting for it. */
  :global(.reply-flash) {
    animation: reply-flash 1.2s ease-out;
  }

  @keyframes reply-flash {
    0%, 40% { background-color: rgba(var(--vault-accent-rgb, 99 102 241), 0.16); border-radius: 0.75rem; }
    100% { background-color: transparent; }
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
