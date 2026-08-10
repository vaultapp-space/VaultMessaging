<script>
  import { Capacitor } from '@capacitor/core';
  import QRCode from 'qrcode';
  import { draggable } from '../lib/chat/draggable.js';
  import { clickOutside } from '../lib/actions/clickOutside.js';
  import { stripJpegExif, stripPngMetadata } from '../lib/chat/metadata.js';
  import { encryptAndSend as sendEncrypted, sendMessage as sendToChat } from '../lib/chat/send.js';
  import { markChatRead, createPoll, updateChatSettings, markStickerUsed, PUBLIC_ORIGIN } from '../lib/api/http.js';
  import StickerPicker from './StickerPicker.svelte';
  import VoiceWaveform from './VoiceWaveform.svelte';
  import VoiceChatBar from './VoiceChatBar.svelte';
  import TopicBar from './TopicBar.svelte';
  import { createTextEnvelope, createMediaEnvelope, MessageType } from '$shared/envelope.js';
  import { capabilities } from '$shared/capabilities.js';
  import { toggleReaction } from '../lib/chat/reactions.js';
  import {
    saveDraftFor, draftFor, refreshPresence, presence, describePresence,
    blockedUsers, toggleBlock,
  } from '../lib/chat/chatSettings.js';
  import { editMessage } from '../lib/chat/edit.js';
  import { deleteMessage as deleteMsg, togglePin, canDeleteForEveryone } from '../lib/chat/actions.js';
  import {
    forwardMessages, createInvite, listInvites, revokeInvite,
    fetchRights, setMemberRole, banMember,
  } from '../lib/api/http.js';
  import { encryptSignalingPayload as encryptSignaling } from '../lib/chat/sessions.js';
  import { onMount, afterUpdate, onDestroy, tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { currentUser, activePeer, sidebarOpen, ratchetSessions, identityKeyPair, signedPrekeyPair, verifiedPeers, localBackupEnabled, localBackupPassphrase, activeCall } from '../lib/stores/session.js';
  import { messagesByPeer, addMessages, typingUsers, conversations, restoreBackup, removeMessage } from '../lib/stores/messages.js';
  import { fetchMessages, fetchChatMessages, uploadAttachment, initChunkedUpload, uploadAttachmentChunk, updateSignedPrekey, leaveGroup, removeGroupMember } from '../lib/api/http.js';
  import { sendTyping, onWsEvent } from '../lib/api/ws.js';
  // `encryptFile`, not `encrypt` aliased to that name. The alias meant
  // sendVoiceNote called encrypt(arrayBuffer) — passing the audio as the
  // *key* argument — so every voice note failed with "parameter 2 is not of
  // type CryptoKey" before it left the browser. The two functions have
  // different signatures and different jobs: encrypt() takes a CryptoKey and
  // a string, encryptFile() generates its own key and returns the material
  // needed to send it.
  import { exportPublicKeyBase64, encryptFile, generateKeyPair, signData, encryptChunk } from '../lib/crypto/keys.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { showToast } from '../lib/stores/toast.js';
  import { pushBackHandler } from '../lib/backHandler.js';
  import { showConfirm } from '../lib/stores/confirm.js';
  import { hapticLight } from '../lib/haptics.js';
  import MessageBubble from './MessageBubble.svelte';
  import DonateBar from './DonateBar.svelte';
  import {
    localStreamStore, remoteStreamStore, micMuted, cameraOff, remoteMicMuted, remoteCameraOff,
    isScreenSharing, verificationWords, p2pFileTransferState, isScreenShareSupported, dataChannelReady,
    startCall as webrtcStartCall, hangupCall as webrtcHangupCall,
    toggleMic as webrtcToggleMic, toggleCamera as webrtcToggleCamera, toggleScreenShare,
    startP2PFileSend as webrtcStartP2PFileSend
  } from '../lib/webrtc.js';

  let messageText = '';
  let messagesContainer;
  let sendingMessage = false;
  let loading = false;
  let ttlMinutes = 1440; // Default 24h
  let showTtlSelector = false;

  // Optimistic & Scroll helpers
  let lastMessageCount = 0;
  let shouldAutoScroll = false;

  // ─── Typing debounce (throttle, not broken setTimeout) ───
  let lastTypingSent = 0;

  // ─── LoadMessages dedup guard ────────────────────────────
  let loadedPeerId = null;
  let loadInProgress = false;

  // Scroll & Pagination state
  let isScrolledUp = false;
  let hasNewUnreadInScroll = false;
  let loadingOlder = false;
  let hasMore = true;

  // Reactive: get messages for active peer
  $: peerMessages = $activePeer ? ($messagesByPeer.get($activePeer.id) || []) : [];

  // Drives the aria-live announcement below — null for an empty thread or
  // when the newest message is the current user's own (already implied by
  // having just sent it).
  $: lastIncomingMessage = (() => {
    const last = peerMessages[peerMessages.length - 1];
    return last && last.senderId !== $currentUser?.id ? last : null;
  })();

  // Album membership, computed once for the whole list rather than per bubble.
  // A run is *consecutive* messages sharing a groupedId — the same rule
  // Telegram uses, and the reason a later unrelated send never joins an
  // earlier album even if the id somehow repeated.
  $: albumRuns = (() => {
    const first = new Map();   // index -> run length, for the first of a run
    const inRun = new Set();   // every index that belongs to some run
    let i = 0;
    while (i < peerMessages.length) {
      const gid = peerMessages[i].groupedId;
      if (gid == null) { i += 1; continue; }
      let j = i;
      while (j + 1 < peerMessages.length && peerMessages[j + 1].groupedId === gid) j += 1;
      if (j > i) {
        first.set(i, j - i + 1);
        for (let k = i; k <= j; k++) inRun.add(k);
      }
      i = j + 1;
    }
    return { first, inRun };
  })();
  $: isTyping = $activePeer ? $typingUsers.has($activePeer.id) : false;

  $: currentRatchet = $activePeer ? $ratchetSessions.get($activePeer.id) : null;
  $: savedIdentityKey = $activePeer ? $verifiedPeers.get($activePeer.id) : null;
  $: hasKeyMismatch = currentRatchet && currentRatchet.peerIdentityKey && savedIdentityKey && savedIdentityKey !== currentRatchet.peerIdentityKey;

  let hasCollision = false;
  let remoteAudioElement = null;

  $: isCallActive = $activeCall && ($activeCall.status === 'ongoing' || $activeCall.status === 'ringing') && $activeCall.peerId === $activePeer?.id;
  $: callType = $activeCall ? $activeCall.type : null;
  $: callingPeer = $activeCall ? $activeCall.peerUsername : null;

  // Note: the incoming/outgoing connection-establishment flow (key import,
  // peer connection init, offer negotiation, media acquisition) is driven
  // from lib/webrtc.js itself via a store subscription — NOT from here.
  // This component only mounts when a peer is selected, so it can't be the
  // thing responsible for connecting a call (e.g. a call accepted while no
  // conversation is open would never connect otherwise).

  // Bind the remote/local streams to the <video>/<audio> elements whenever they change
  $: if (remoteVideo) remoteVideo.srcObject = $remoteStreamStore;
  $: if (callType !== 'video' && $remoteStreamStore) {
    if (!remoteAudioElement) remoteAudioElement = new Audio();
    remoteAudioElement.srcObject = $remoteStreamStore;
    remoteAudioElement.play().catch(e => console.error('Failed to autoplay remote audio:', e));
    applySinkPreference();
  }
  $: if (localVideo) localVideo.srcObject = $localStreamStore;

  let showMembersModal = false;
  // Android back button closes whichever of these is on top instead of
  // falling through to WebView history (see lib/backHandler.js).
  let unregisterMembersBack = null;
  $: {
    if (showMembersModal && !unregisterMembersBack) {
      unregisterMembersBack = pushBackHandler(() => { showMembersModal = false; });
    } else if (!showMembersModal && unregisterMembersBack) {
      unregisterMembersBack();
      unregisterMembersBack = null;
    }
  }
  let p2pFileInput;

  async function handleLeaveGroup() {
    if (!$activePeer?.isGroup) return;
    const groupId = $activePeer.id.replace(/^group-/, '');
    if (!(await showConfirm(`Leave "${$activePeer.username}"? You won't receive future messages from this group.`, { confirmLabel: 'Leave' }))) return;
    try {
      await leaveGroup(groupId);
      showMembersModal = false;
      conversations.update(cs => cs.filter(c => c.peerId !== $activePeer.id));
      activePeer.set(null);
    } catch (err) {
      showToast(`Failed to leave group: ${err.message}`);
    }
  }

  async function handleRemoveMember(memberId, memberUsername) {
    if (!$activePeer?.isGroup) return;
    const groupId = $activePeer.id.replace(/^group-/, '');
    if (!(await showConfirm(`Remove ${memberUsername} from "${$activePeer.username}"?`, { confirmLabel: 'Remove' }))) return;
    try {
      await removeGroupMember(groupId, memberId);
      const updatedMembers = $activePeer.members.filter(m => m.id !== memberId);
      activePeer.update(peer => peer ? { ...peer, members: updatedMembers } : peer);
      conversations.update(cs => {
        const conv = cs.find(c => c.peerId === $activePeer.id);
        if (conv) conv.members = updatedMembers;
        return [...cs];
      });
    } catch (err) {
      showToast(`Failed to remove member: ${err.message}`);
    }
  }

  function startP2PFileSend(e) {
    const file = e.target.files[0];
    webrtcStartP2PFileSend(file);
  }

  let callWindowSize = 'normal'; // 'normal' | 'large' | 'fullscreen'
  let position = { x: 0, y: 0 };
  let isDragging = false;

  // Calls always start as a small floating widget — fullscreen is still
  // available (below) via manually tapping to expand into it, on every
  // platform including native Android. Keyed on call id, not just
  // isCallActive, so re-opening the small window mid-call doesn't get
  // silently forced back to some other size every time this reactive
  // block re-runs.
  let sizedForCallId = null;
  $: if (isCallActive && $activeCall?.id && $activeCall.id !== sizedForCallId) {
    sizedForCallId = $activeCall.id;
    callWindowSize = 'normal';
  }

  // Elapsed time since the call actually connected — previously shown
  // nowhere, on a screen whose entire job is telling you about the call.
  let callDurationSeconds = 0;
  let callDurationInterval = null;
  $: if ($activeCall?.status === 'ongoing' && !callDurationInterval) {
    callDurationInterval = setInterval(() => { callDurationSeconds++; }, 1000);
  } else if ($activeCall?.status !== 'ongoing' && callDurationInterval) {
    clearInterval(callDurationInterval);
    callDurationInterval = null;
    callDurationSeconds = 0;
  }

  function toggleMic() {
    webrtcToggleMic();
  }

  function toggleCamera() {
    webrtcToggleCamera();
  }

  // Speaker (audio output device) toggle for audio calls. setSinkId isn't
  // universally supported (notably absent in Safari as of writing), so this
  // degrades to a disabled button with an explanatory tooltip rather than
  // failing silently.
  const isSinkIdSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  let speakerOn = false;

  async function applySinkPreference() {
    if (!isSinkIdSupported || !remoteAudioElement) return;
    try {
      if (!speakerOn) {
        await remoteAudioElement.setSinkId('default');
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      const speakerDevice = outputs.find(d => /speaker/i.test(d.label));
      await remoteAudioElement.setSinkId(speakerDevice ? speakerDevice.deviceId : 'default');
    } catch (e) {
      console.error('Failed to switch audio output:', e);
    }
  }

  async function toggleSpeaker() {
    speakerOn = !speakerOn;
    await applySinkPreference();
  }

  let localVideo;
  let remoteVideo;

  const wsUnsubscribes = [];
  let prekeyRotationTimer;

  // Search variables
  let searchActive = false;
  let searchQuery = '';

  // Audio recording variables
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let recordSeconds = 0;
  let recordInterval = null;

  const burnOnReadActive = false;

  // Try to restore IndexedDB backup on login/load
  $: if ($currentUser && $localBackupEnabled && $localBackupPassphrase && !$messagesByPeer.has($activePeer?.id)) {
    restoreBackup().catch(err => {
      console.error('Failed to decrypt and restore local backup:', err);
    });
  }

  // Track when new messages arrive → trigger scroll. lastMessageCount === 0
  // also covers the initial load of a freshly-opened conversation, which
  // should always land at the bottom regardless of who sent the last message.
  $: if (peerMessages.length > lastMessageCount) {
    const lastMsg = peerMessages[peerMessages.length - 1];
    const isOwn = lastMsg?.senderId === $currentUser?.id;
    const isInitialLoad = lastMessageCount === 0;
    if (isInitialLoad || isOwn || !isScrolledUp) {
      shouldAutoScroll = true;
    } else {
      shouldAutoScroll = false;
      hasNewUnreadInScroll = true;
    }
    lastMessageCount = peerMessages.length;
  }

  // Auto-scroll only when new messages arrive, not on every reactive update.
  // Scrolls after this update AND on the next frame, since a just-appended
  // message bubble (images, multi-line text, transitions) can still grow
  // after the initial layout pass, leaving scrollHeight measured too early.
  afterUpdate(() => {
    if (shouldAutoScroll && messagesContainer) {
      const el = messagesContainer;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight;
        });
      });
      shouldAutoScroll = false;
    }
  });

  onMount(async () => {
    if ($activePeer) {
      await loadMessages();
    }
  });

  // Watch for peer changes (with dedup)
  $: if ($activePeer && $activePeer.id !== loadedPeerId) {
    lastMessageCount = 0;
    loadMessages();
  }

  async function loadMessages() {
    if (!$activePeer || loadInProgress) return;
    loadInProgress = true;
    loadedPeerId = $activePeer.id;
    loading = true;
    hasMore = true; // Reset pagination state on peer change
    try {
      await loadMessagesData();
      // Explicit scroll-to-bottom for the initial open of a conversation —
      // more deterministic than relying on the shared afterUpdate path,
      // since `loading` and the message list can flip in the same tick.
      await tick();
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
          });
        });
      }
      await markConversationRead();
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      loading = false;
      loadInProgress = false;
      // If the peer changed again while this load was in flight, the
      // reactive block below only fires on a *change* to $activePeer or
      // loadedPeerId — and the switch that happened mid-load hit the
      // loadInProgress guard above and returned without updating
      // loadedPeerId, so nothing would otherwise re-trigger a fetch for
      // wherever the user actually ended up. Without this, that
      // conversation's history just never loads until you navigate away
      // and back.
      if ($activePeer && $activePeer.id !== loadedPeerId) {
        loadMessages();
      }
    }
  }

  // Marks everything currently in the conversation as read.
  //
  // Read receipts were previously unreachable: the server handled a per-message
  // 'read' websocket ack and MessageBubble rendered a read tick, but no client
  // code ever sent one. This uses the watermark endpoint instead — one call per
  // chat open rather than one per message — which is also what clears the
  // unread badge for this user's other devices.
  async function markConversationRead() {
    const chatId = $activePeer?.chatId;
    if (!chatId) return; // legacy conversation with no chat row yet

    const messages = $messagesByPeer.get($activePeer.id) || [];
    const maxSeq = messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
    if (maxSeq <= 0) return;

    try {
      const { unreadCount } = await markChatRead(chatId, maxSeq);
      conversations.update(cs => {
        const conv = cs.find(c => c.chatId === chatId);
        if (conv) {
          conv.unreadCount = unreadCount;
          conv.hasUndelivered = unreadCount > 0;
        }
        return [...cs];
      });
    } catch (err) {
      // Never let a failed receipt break opening a conversation.
      console.error('Failed to mark chat read:', err);
    }
  }

  async function loadMessagesData() {
    // Cloud chats read their history from the chat model, which returns
    // plaintext columns. The legacy pairwise endpoint below returns ciphertext
    // and marks everything `encrypted: true`, so routing a cloud chat through
    // it produced an empty conversation on every reopen — live messages
    // arrived over the socket and nothing else ever did.
    if ($activePeer.mode === 'cloud' && $activePeer.chatId) {
      const cloud = await fetchChatMessages($activePeer.chatId, { topicId: activeTopicId });
      hasMore = cloud.hasMore;
      if (cloud.messages?.length) {
        // Already in the normalized shape the store expects, so it is passed
        // through rather than re-mapped.
        addMessages($activePeer.id, cloud.messages);
      }
      return { hasMore: cloud.hasMore, messages: cloud.messages };
    }

    const data = await fetchMessages($activePeer.id);
    hasMore = data.hasMore;
    if (data.messages && data.messages.length > 0) {
      // Use batch add — single re-render instead of N
      addMessages($activePeer.id, data.messages.map(msg => ({
        id: msg.id,
        senderId: msg.sender_id,
        senderUsername: msg.sender_username,
        text: msg.ciphertext,
        encrypted: true,
        iv: msg.iv,
        ephemeralKey: msg.ephemeral_key,
        messageNumber: msg.message_number,
        previousChain: msg.previous_chain,
        sentAt: msg.sent_at,
        expiresAt: msg.expires_at,
        groupId: msg.group_id,
        attachmentId: msg.attachment_id,
      })));
    }
    return data;
  }

  // webrtc.js invokes this as (peerId, payload). The peer's username is not
  // part of that contract, so it is bound here where it is known.
  function encryptSignalingPayload(peerId, payloadObj) {
    return encryptSignaling(peerId, payloadObj, callingPeer || $activePeer?.username);
  }

  // What this conversation supports, from its mode. Used to hide affordances
  // that would be meaningless or misleading in the other mode.
  $: chatCaps = capabilities({ mode: $activePeer?.mode || 'secret' });

  // True when this conversation has had messages before but they have since
  // expired — as opposed to a chat that was never used. Comes from the chat
  // list, where isEmpty means the chat row outlived its contents.
  $: conversationExpired = Boolean($activePeer?.isEmpty && $activePeer?.lastMessageAt);

  // The message currently being replied to, or null. Cleared on send, on
  // cancel, and whenever the conversation changes — a reply bar left over
  // from another chat would silently attach the reply to the wrong message.
  let composerEl;
  // Grows the composer as multi-line text is entered — previously only
  // reachable via desktop Shift+Enter, but now also how the native Android
  // app enters line breaks (see handleKeydown), so a fixed one-row box would
  // hide most of what's typed.
  $: if (composerEl) { void messageText; autoGrowComposer(); }
  function autoGrowComposer() {
    composerEl.style.height = 'auto';
    composerEl.style.height = Math.min(composerEl.scrollHeight, 120) + 'px';
  }
  let replyingTo = null;
  // The message being edited, or null. Mutually exclusive with replying:
  // the composer can only be doing one thing at a time.
  let editingMessage = null;
  $: if ($activePeer) { void $activePeer.id; replyingTo = null; editingMessage = null; }

  function startReply(message) {
    editingMessage = null;
    replyingTo = message;
    composerEl?.focus();
  }

  function startEdit(message) {
    replyingTo = null;
    editingMessage = message;
    messageText = message.text || '';
    composerEl?.focus();
  }

  function cancelEdit() {
    editingMessage = null;
    messageText = '';
  }

  function cancelReply() {
    replyingTo = null;
  }

  // Scrolls to a message by its per-chat seq and flashes it, so tapping a
  // quoted preview lands you on the original.
  async function jumpToSeq(seq) {
    const target = messagesContainer?.querySelector(`[data-seq="${seq}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('reply-flash');
    setTimeout(() => target.classList.remove('reply-flash'), 1200);
  }

  // Finds the quoted message so the preview can render its text.
  function quotedMessage(seq) {
    if (!seq) return null;
    return peerMessages.find((m) => m.seq === seq) || null;
  }

  // ─── Invites and rights ─────────────────────────────────
  // Replaces the old `joinKey`, which was a permanent bearer secret: anyone
  // who ever saw it could rejoin forever, with no way to withdraw it.
  let myRights = [];
  let invites = [];
  let loadingInvites = false;

  $: canManageInvites = myRights.includes('manageInvites');
  $: canBan = myRights.includes('ban');
  $: canPromote = myRights.includes('promote');

  // Rights are resolved server-side; this is only a UI hint.
  $: if ($activePeer?.chatId) void loadRights($activePeer.chatId);

  async function loadRights(chatId) {
    try {
      myRights = (await fetchRights(chatId)).rights;
    } catch {
      myRights = [];
    }
  }

  async function loadInvites() {
    if (!$activePeer?.chatId || !canManageInvites) return;
    loadingInvites = true;
    try {
      invites = (await listInvites($activePeer.chatId)).invites;
    } catch (err) {
      console.error('Failed to load invites:', err);
      invites = [];
    } finally {
      loadingInvites = false;
    }
  }

  async function makeInvite({ expiresHours = null, usageLimit = null } = {}) {
    try {
      const invite = await createInvite($activePeer.chatId, {
        expiresAt: expiresHours
          ? new Date(Date.now() + expiresHours * 3600_000).toISOString()
          : null,
        usageLimit,
      });
      invites = [invite, ...invites];
      await copyInvite(invite.hash);
    } catch (err) {
      console.error('Failed to create invite:', err);
      showToast(err?.message ? `Could not create an invite link: ${err.message}` : 'Could not create an invite link');
    }
  }

  async function copyInvite(hash) {
    const link = `${PUBLIC_ORIGIN}/join/${hash}`;
    try {
      await navigator.clipboard.writeText(link);
      inviteCopied = hash;
      setTimeout(() => { if (inviteCopied === hash) inviteCopied = null; }, 2000);
    } catch {
      // Clipboard can be denied; a toast with the link itself is the
      // fallback — selectable text, same as every other error surface in
      // the app, instead of a native prompt() dialog.
      showToast(`Could not copy automatically. Link: ${link}`, { type: 'info', duration: 8000 });
    }
  }
  let inviteCopied = null;

  async function doRevokeInvite(hash) {
    if (!(await showConfirm('Revoke this link? Anyone still holding it will no longer be able to join.', { confirmLabel: 'Revoke' }))) return;
    try {
      await revokeInvite($activePeer.chatId, hash);
      invites = invites.map((i) => (i.hash === hash ? { ...i, revoked: true } : i));
    } catch (err) {
      console.error('Failed to revoke invite:', err);
    }
  }

  async function promote(member) {
    if (!(await showConfirm(`Make ${member.username} an admin? They'll be able to manage members and settings for this group.`, { confirmLabel: 'Make Admin', danger: false }))) return;
    try {
      await setMemberRole($activePeer.chatId, member.id, 'admin');
      showToast(`${member.username} is now an admin`, { type: 'success' });
    } catch (err) {
      console.error('Failed to promote:', err);
      showToast(err?.message ? `Could not change that member's role: ${err.message}` : 'Could not change that member\'s role');
    }
  }

  async function ban(member) {
    if (!(await showConfirm(`Ban ${member.username}? They will be removed and cannot rejoin with an invite link.`, { confirmLabel: 'Ban' }))) return;
    try {
      await banMember($activePeer.chatId, member.id);
      activePeer.update((p) => {
        if (p?.members) p.members = p.members.filter((m) => m.id !== member.id);
        return p;
      });
    } catch (err) {
      console.error('Failed to ban:', err);
      showToast(err?.message ? `Could not ban that member: ${err.message}` : 'Could not ban that member');
    }
  }

  function describeInvite(invite) {
    if (invite.revoked) return 'revoked';
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return 'expired';
    const used = invite.usage_limit
      ? `${invite.usage_count}/${invite.usage_limit} used`
      : `${invite.usage_count} used`;
    return used;
  }

  // ─── Blocking ───────────────────────────────────────────
  let showChatMenu = false;
  let unregisterChatMenuBack = null;
  $: {
    if (showChatMenu && !unregisterChatMenuBack) {
      unregisterChatMenuBack = pushBackHandler(() => { showChatMenu = false; });
    } else if (!showChatMenu && unregisterChatMenuBack) {
      unregisterChatMenuBack();
      unregisterChatMenuBack = null;
    }
  }

  $: peerBlocked = $activePeer && !$activePeer.isGroup
    && $blockedUsers.has($activePeer.id);

  async function handleToggleBlock() {
    showChatMenu = false;
    if (!$activePeer || $activePeer.isGroup) return;

    const blocking = !peerBlocked;
    if (blocking && !(await showConfirm(
      `Block ${$activePeer.username}? They will not be able to message you, and you will not be able to message them. They are not told that you blocked them.`,
      { confirmLabel: 'Block' }
    ))) return;

    try {
      await toggleBlock($activePeer.id);
    } catch (err) {
      console.error('Failed to change block state:', err);
      showToast(err?.message ? `Could not update block settings: ${err.message}` : 'Could not update block settings');
    }
  }

  // ─── Forwarding ─────────────────────────────────────────
  // Only cloud chats can be forwarded into: the server copies the body, and
  // it has no plaintext to copy for a secret destination. Those are filtered
  // out of the picker rather than failing after the user has chosen one.
  let forwardingMessage = null;

  function startForward(message) {
    forwardingMessage = message;
  }

  $: forwardTargets = $conversations.filter(
    (c) => c.chatId && c.mode === 'cloud' && c.chatId !== $activePeer?.chatId
  );

  async function doForward(target) {
    const message = forwardingMessage;
    forwardingMessage = null;
    if (!message?.seq || !$activePeer?.chatId) return;

    try {
      await forwardMessages($activePeer.chatId, target.chatId, [message.seq]);
    } catch (err) {
      console.error('Failed to forward:', err);
      showToast(err?.message ? `Failed to forward message: ${err.message}` : 'Failed to forward message');
    }
  }

  // ─── Drafts ─────────────────────────────────────────────
  // Restored when a conversation opens, saved as you type (debounced), and
  // cleared on send. Cloud chats sync theirs so a half-written message
  // follows you between devices; secret chats keep theirs on the device,
  // because a draft is plaintext.
  let draftTimer;
  let draftLoadedFor = null;

  $: if ($activePeer && $activePeer.id !== draftLoadedFor) {
    draftLoadedFor = $activePeer.id;
    const existing = draftFor($activePeer);
    if (existing && !messageText) messageText = existing;
  }

  function scheduleDraftSave() {
    if (!$activePeer?.chatId || editingMessage) return;
    clearTimeout(draftTimer);
    const body = messageText;
    draftTimer = setTimeout(() => saveDraftFor($activePeer, body), 600);
  }

  // ─── Presence ───────────────────────────────────────────
  $: peerPresence = $activePeer && !$activePeer.isGroup
    ? $presence.get($activePeer.id)
    : null;

  $: if ($activePeer && !$activePeer.isGroup) refreshPresence([$activePeer.id]);

  function chatRef() {
    return { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' };
  }

  function actionContext() {
    return {
      storeKey: $activePeer.id,
      peer: $activePeer,
      currentUser: $currentUser,
      ttlMinutes,
      chatId: $activePeer.chatId,
    };
  }

  // Deleting is the one action here that destroys something, so it asks
  // first — and it distinguishes the two meanings of the word rather than
  // silently picking one. Only the author is offered "for everyone".
  async function handleDelete(message) {
    const mine = canDeleteForEveryone(message, $currentUser?.id);
    let forEveryone = false;

    if (mine) {
      // A real three-way choice, not a yes/no — "for everyone" and "for me"
      // are both a delete, just not the same one, so a two-button confirm()
      // repurposing Cancel to mean "the other kind of delete" (which is what
      // this used to do) reads as a trap rather than a choice.
      const result = await showConfirm('Delete this message?', {
        confirmLabel: 'Delete for Everyone',
        neutralLabel: 'Delete for Me',
        cancelLabel: 'Cancel',
      });
      if (result === 'cancel') return;
      forEveryone = result === 'confirm';
    } else if (!(await showConfirm('Remove this message from your view? Others will still see it.', { confirmLabel: 'Remove' }))) {
      return;
    }

    try {
      await deleteMsg(chatRef(), message, { forEveryone, ...actionContext() });
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  }

  async function handleTogglePin(message) {
    try {
      await togglePin(chatRef(), message, actionContext());
    } catch (err) {
      console.error('Failed to pin message:', err);
    }
  }

  // Reacting works in both modes: cloud posts to the reactions endpoint,
  // secret sends an encrypted t:'op' envelope that peers apply locally. The
  // bubble calls this and never learns which happened.
  async function handleToggleReaction(message, emoji) {
    if (!$activePeer?.chatId) return;
    try {
      await toggleReaction(
        { id: $activePeer.chatId, mode: $activePeer.mode || 'secret' },
        message,
        emoji,
        {
          storeKey: $activePeer.id,
          peer: $activePeer,
          currentUser: $currentUser,
          ttlMinutes,
        }
      );
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  }

  // Binds the component's conversation context to the extracted send path.
  function encryptAndSend(text, isAttachment = false) {
    return sendEncrypted(text, isAttachment, {
      peer: $activePeer,
      currentUser: $currentUser,
      ttlMinutes,
    });
  }

  async function handleSend() {
    if (!messageText.trim() || sendingMessage) return;
    if (peerBlocked) return;

    const text = messageText.trim();
    const editTarget = editingMessage;
    messageText = '';
    sendingMessage = true;
    // Fired on the tap, not the network round trip — the composer already
    // clears optimistically, so the tactile confirmation should match.
    hapticLight();

    try {
      if (editTarget) {
        editingMessage = null;
        await editMessage(
          { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
          editTarget,
          text,
          {
            storeKey: $activePeer.id,
            peer: $activePeer,
            currentUser: $currentUser,
            ttlMinutes,
            chatId: $activePeer.chatId,
          }
        );
        return;
      }

      // Goes through the dual-mode fork: sendMessage decides from chat.mode
      // whether this is encrypted through the ratchet or posted as a cloud
      // message. Everything above this line is mode-agnostic.
      await sendToChat(
        { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
        createTextEnvelope(text, {
          replyTo: replyingTo?.seq
            ? { chatId: $activePeer.chatId, seq: replyingTo.seq }
            : null,
          viewOnce: viewOnceActive,
        }),
        {
          peer: $activePeer, currentUser: $currentUser, ttlMinutes,
          chatId: $activePeer.chatId,
          // Cloud only. A secret chat has no server-side topic model, and
          // forums are a cloud-group feature.
          topicId: activeTopicId,
        }
      );
      replyingTo = null;
      viewOnceActive = false;
      clearTimeout(draftTimer);
      if ($activePeer?.chatId) saveDraftFor($activePeer, '');
    } catch (err) {
      console.error('Failed to send message:', err);
      showToast(err?.message ? `Failed to send message: ${err.message}` : 'Failed to send message');
    } finally {
      sendingMessage = false;
    }
  }

  // Tapping "Failed to send" on a stuck bubble (see lib/chat/send.js's
  // markMessageFailed). Removes the failed placeholder and re-runs the send
  // with its original envelope — the same one both send paths already store
  // on the optimistic message for exactly this.
  async function retryFailedMessage(message) {
    if (!message?.envelope) {
      showToast('Cannot retry this message — try sending it again.');
      return;
    }
    removeMessage($activePeer.id, message.id);
    try {
      await sendToChat(
        { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
        message.envelope,
        {
          peer: $activePeer, currentUser: $currentUser, ttlMinutes,
          chatId: $activePeer.chatId,
          topicId: activeTopicId,
        }
      );
    } catch (err) {
      console.error('Retry failed:', err);
      showToast(err?.message ? `Failed to send message: ${err.message}` : 'Failed to send message');
    }
  }

  function handleKeydown(e) {
    // Escape backs out of edit or reply mode, which is what every messenger
    // does and what a user will try first.
    if (e.key === 'Escape') {
      if (editingMessage) { cancelEdit(); return; }
      if (replyingTo) { cancelReply(); return; }
    }

    // The native Android app has no reliable Shift+Enter on its on-screen
    // keyboard, so Enter has to stay a plain newline there and sending goes
    // through the Send button instead. Desktop/web keeps Enter-to-send,
    // since that's the physical-keyboard convention users expect.
    if (e.key === 'Enter' && !e.shiftKey && !Capacitor.isNativePlatform()) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput() {
    scheduleDraftSave();
    // Throttled typing indicator — at most once every 2s
    if ($activePeer) {
      const now = Date.now();
      if (now - lastTypingSent > 2000) {
        sendTyping($activePeer.id);
        lastTypingSent = now;
      }
    }
  }

  function formatTTL(minutes) {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return '24h';
  }

  async function loadOlderMessages() {
    if (loadingOlder || !hasMore || peerMessages.length === 0 || !$activePeer) return;
    loadingOlder = true;
    try {
      const oldestMsg = peerMessages[0];
      const isCloud = $activePeer.mode === 'cloud' && $activePeer.chatId;
      const data = isCloud
        ? await fetchChatMessages($activePeer.chatId, { before: oldestMsg.seq })
        : await fetchMessages($activePeer.id, 50, oldestMsg.sentAt);
      if (data.messages && data.messages.length > 0) {
        const oldScrollHeight = messagesContainer.scrollHeight;
        const oldScrollTop = messagesContainer.scrollTop;

        // Cloud history is already in the store's shape; only the legacy
        // ciphertext rows need mapping.
        addMessages($activePeer.id, isCloud ? data.messages : data.messages.map(msg => ({
          id: msg.id,
          senderId: msg.sender_id,
          senderUsername: msg.sender_username,
          text: msg.ciphertext,
          encrypted: true,
          iv: msg.iv,
          ephemeralKey: msg.ephemeral_key,
          messageNumber: msg.message_number,
          previousChain: msg.previous_chain,
          sentAt: msg.sent_at,
          expiresAt: msg.expires_at,
          groupId: msg.group_id,
          attachmentId: msg.attachment_id,
        })));
        
        hasMore = data.hasMore;
        
        await tick();
        if (messagesContainer) {
          messagesContainer.scrollTop = oldScrollTop + (messagesContainer.scrollHeight - oldScrollHeight);
        }
      } else {
        hasMore = false;
      }
    } catch (err) {
      console.error('Failed to load older messages:', err);
    } finally {
      loadingOlder = false;
    }
  }

  function handleScroll() {
    if (!messagesContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
    
    // Scrolled up if client is more than 150px away from bottom
    isScrolledUp = scrollHeight - scrollTop - clientHeight > 150;
    
    if (!isScrolledUp) {
      hasNewUnreadInScroll = false;
    }
    
    // Trigger infinite scroll load older messages if scrollTop is near top
    if (scrollTop < 50 && hasMore && !loadingOlder) {
      loadOlderMessages();
    }
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      hasNewUnreadInScroll = false;
      isScrolledUp = false;
    }
  }

  let copied = false;
  function copyFingerprint() {
    navigator.clipboard.writeText(safetyNumber).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    }).catch(() => {
      showToast('Could not copy automatically — the safety number is selectable text above.', { type: 'info' });
    });
  }

  let showSafetyNumberModal = false;
  let unregisterSafetyBack = null;
  $: {
    if (showSafetyNumberModal && !unregisterSafetyBack) {
      unregisterSafetyBack = pushBackHandler(() => { showSafetyNumberModal = false; });
    } else if (!showSafetyNumberModal && unregisterSafetyBack) {
      unregisterSafetyBack();
      unregisterSafetyBack = null;
    }
  }
  let safetyNumber = '';
  let safetyNumberQrUrl = '';

  // Rendered locally — this fingerprint is derived from both parties'
  // identity keys, and handing it to a third-party image service (as a URL
  // query param, logged on their end along with the requester's IP) would
  // leak verification metadata through the one screen whose entire job is
  // proving the connection is private. Same reasoning as the sync-link QR
  // in ChatSidebar.svelte.
  $: if (safetyNumber && safetyNumber !== 'Unavailable' && safetyNumber !== 'Error calculating fingerprint') {
    QRCode.toDataURL(safetyNumber, { width: 150, margin: 1 })
      .then((url) => { safetyNumberQrUrl = url; })
      .catch((err) => { console.error('Failed to render safety number QR code:', err); safetyNumberQrUrl = ''; });
  } else {
    safetyNumberQrUrl = '';
  }

  async function calculateSafetyNumber() {
    const ratchet = $ratchetSessions.get($activePeer?.id);
    if (!ratchet || !ratchet.peerIdentityKey || !$identityKeyPair) {
      safetyNumber = 'Unavailable';
      return;
    }

    try {
      const ecdhPub = await exportPublicKeyBase64($identityKeyPair.ecdh.publicKey);
      const ecdsaPub = await exportPublicKeyBase64($identityKeyPair.ecdsa.publicKey);
      const ownIdentityPub = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));
      
      const peerIdentityPub = ratchet.peerIdentityKey;

      // Sort them lexicographically to ensure order independence
      const sorted = [ownIdentityPub, peerIdentityPub].sort();
      const encoder = new TextEncoder();
      const data = encoder.encode(sorted.join(':'));
      const hash = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hash));

      // Format as five blocks of 5 digits (e.g. 12345 67890 ...)
      let numberStr = '';
      for (let i = 0; i < 5; i++) {
        const val = (hashArray[i*4] << 24 | hashArray[i*4+1] << 16 | hashArray[i*4+2] << 8 | hashArray[i*4+3]) >>> 0;
        const block = (val % 100000).toString().padStart(5, '0');
        numberStr += (numberStr ? ' ' : '') + block;
      }
      safetyNumber = numberStr;
    } catch (e) {
      console.error('Error calculating safety number:', e);
      safetyNumber = 'Error calculating fingerprint';
    }
  }

  $: if ($activePeer && $ratchetSessions && $ratchetSessions.has($activePeer.id)) {
    calculateSafetyNumber();
  }

  let fileInput;

  // ─── Polls ────────────────────────────────────────────────
  // Cloud only. The capability table lists polls as universal because the
  // envelope can carry one either way, but the secret-chat path would have to
  // tally votes client-side through `t:'op'` messages and that is not built —
  // the server refuses a poll in a secret chat, so the button is not offered
  // there rather than failing after the user has typed one out.
  let showPollComposer = false;
  let unregisterPollBack = null;
  $: {
    if (showPollComposer && !unregisterPollBack) {
      unregisterPollBack = pushBackHandler(() => { showPollComposer = false; });
    } else if (!showPollComposer && unregisterPollBack) {
      unregisterPollBack();
      unregisterPollBack = null;
    }
  }
  let pollQuestion = '';
  let pollOptions = ['', ''];
  let pollAnonymous = true;
  let pollMultiple = false;
  let pollError = '';
  let creatingPoll = false;

  // Groups only. A poll needs an audience to be worth running — offering one
  // in a two-person chat is asking someone to vote at the person who can
  // simply reply. It also costs a permanent slot in the composer, which is
  // the scarcest space in the UI.
  $: canPoll = $activePeer?.mode === 'cloud'
    && $activePeer?.chatId
    && $activePeer?.isGroup;

  // ─── Forum topics ─────────────────────────────────────────
  // The selected topic narrows the message list and tags what is sent. Reset
  // whenever the conversation changes, or a topic from the previous group
  // would silently file the next message into the wrong thread.
  let activeTopicId = null;
  $: if ($activePeer) { void $activePeer.id; activeTopicId = null; }

  function selectTopic(topicId) {
    activeTopicId = topicId;
    // The store is keyed by peer, not by topic, so switching topics has to
    // reload rather than filter what is already held.
    loadMessages();
  }

  // ─── Chat theme ───────────────────────────────────────────
  // A name from a fixed list, never a colour: the value round-trips through
  // the server and back out to the other participant's client, so accepting
  // arbitrary CSS would hand anyone you talk to a styling primitive in your
  // browser. The swatches below are only for the picker.
  const CHAT_THEMES = [
    { name: null,      label: 'Default', swatch: '#10b981' },
    { name: 'ocean',   label: 'Ocean',   swatch: '#0ea5e9' },
    { name: 'sunset',  label: 'Sunset',  swatch: '#f97316' },
    { name: 'orchid',  label: 'Orchid',  swatch: '#a855f7' },
    { name: 'rose',    label: 'Rose',    swatch: '#f43f5e' },
    { name: 'slate',   label: 'Slate',   swatch: '#64748b' },
  ];

  let chatTheme = null;
  // Re-read from the conversation whenever the open chat changes, so the
  // previous chat's accent does not bleed into the next one.
  $: chatTheme = $conversations.find((c) => c.chatId === $activePeer?.chatId)?.theme ?? null;

  async function applyTheme(name) {
    if (!$activePeer?.chatId) return;
    const previous = chatTheme;
    chatTheme = name;
    conversations.update((convs) => convs.map(
      (c) => (c.chatId === $activePeer.chatId ? { ...c, theme: name } : c)
    ));
    try {
      await updateChatSettings($activePeer.chatId, { theme: name });
    } catch (err) {
      console.error('Failed to save chat theme:', err);
      chatTheme = previous;
    }
  }

  // ─── Stickers ─────────────────────────────────────────────
  // Works in both modes. A sticker message carries a *reference* to the
  // sticker, so in a secret chat it goes through the ratchet like any other
  // envelope and the server never learns that a sticker was sent, let alone
  // which one. That is why the recents call is made by this client rather
  // than inferred server-side from the send.
  let showStickers = false;
  let unregisterStickersBack = null;
  $: {
    if (showStickers && !unregisterStickersBack) {
      unregisterStickersBack = pushBackHandler(() => { showStickers = false; });
    } else if (!showStickers && unregisterStickersBack) {
      unregisterStickersBack();
      unregisterStickersBack = null;
    }
  }
  let showAttachMenu = false;
  let unregisterAttachBack = null;
  $: {
    if (showAttachMenu && !unregisterAttachBack) {
      unregisterAttachBack = pushBackHandler(() => { showAttachMenu = false; });
    } else if (!showAttachMenu && unregisterAttachBack) {
      unregisterAttachBack();
      unregisterAttachBack = null;
    }
  }

  async function sendSticker(sticker) {
    showStickers = false;
    if (!$activePeer) return;
    try {
      await sendToChat(
        { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
        createMediaEnvelope(MessageType.STICKER, {
          stickerId: sticker.id,
          fileId: sticker.fileId,
          emoji: sticker.emoji,
          width: sticker.width,
          height: sticker.height,
        }),
        { peer: $activePeer, currentUser: $currentUser, ttlMinutes, chatId: $activePeer.chatId }
      );
      // Best-effort: a missing recents entry is not worth failing a send over.
      markStickerUsed(sticker.id).catch(() => {});
    } catch (err) {
      console.error('Failed to send sticker:', err);
      showToast(err?.message ? `Failed to send sticker: ${err.message}` : 'Failed to send sticker');
    }
  }

  // ─── View-once ────────────────────────────────────────────
  // Cloud only, and for a real reason: the guarantee is that the *server*
  // clears the content once it has been opened. A secret chat's server holds
  // only ciphertext, so there is nothing for it to clear — burn-on-read is
  // the honest equivalent there, and it is already labelled as client-side.
  $: canViewOnce = $activePeer?.mode === 'cloud' && $activePeer?.chatId;
  let viewOnceActive = false;
  // Turning it off when leaving a cloud chat stops the toggle silently
  // persisting into a conversation that cannot honour it.
  $: if (!canViewOnce) viewOnceActive = false;

  function openPollComposer() {
    pollQuestion = '';
    pollOptions = ['', ''];
    pollAnonymous = true;
    pollMultiple = false;
    pollError = '';
    showPollComposer = true;
  }

  async function submitPoll() {
    const question = pollQuestion.trim();
    const options = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!question) { pollError = 'Give the poll a question.'; return; }
    if (options.length < 2) { pollError = 'A poll needs at least two options.'; return; }

    creatingPoll = true;
    pollError = '';
    try {
      await createPoll($activePeer.chatId, {
        question, options,
        isAnonymous: pollAnonymous,
        allowsMultiple: pollMultiple,
      });
      // The poll arrives through the normal message fanout, so there is
      // nothing to insert here.
      showPollComposer = false;
    } catch (err) {
      console.error('Failed to create poll:', err);
      pollError = 'Could not create the poll.';
    } finally {
      creatingPoll = false;
    }
  }
  let sendingFile = false;
  // The P2P direct-transfer path already has a percentage progress bar
  // ($p2pFileTransferState.progress) — this is the same idea for the
  // ordinary chunked-upload path, which previously showed only a generic
  // spinner for however long a multi-MB upload took.
  let uploadProgress = 0;
  let uploadFileName = '';

  // Picks the envelope type from the mime type, so a photo, a video and a
  // generic file are distinguishable without re-sniffing later.
  function mediaKindFor(mimeType) {
    if (!mimeType) return MessageType.DOCUMENT;
    if (mimeType.startsWith('image/')) return MessageType.PHOTO;
    if (mimeType.startsWith('video/')) return MessageType.VIDEO;
    if (mimeType.startsWith('audio/')) return MessageType.AUDIO;
    return MessageType.DOCUMENT;
  }

  // A single picked file goes through a review step instead of sending the
  // instant it's chosen — the pipeline below is a one-way encrypt-then-
  // upload with no undo, and there was previously no point between picking
  // the wrong file and it already being sent. Multiple files (an album)
  // skip this: there's no established UI here for a per-file caption on a
  // batch, and sending immediately matches how albums already worked.
  let pendingAttachment = null; // { file, previewUrl }
  let attachmentCaption = '';
  let unregisterAttachmentPreviewBack = null;
  $: {
    if (pendingAttachment && !unregisterAttachmentPreviewBack) {
      unregisterAttachmentPreviewBack = pushBackHandler(cancelPendingAttachment);
    } else if (!pendingAttachment && unregisterAttachmentPreviewBack) {
      unregisterAttachmentPreviewBack();
      unregisterAttachmentPreviewBack = null;
    }
  }

  async function handleFileChange(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !$activePeer) return;

    if (files.length === 1) {
      const file = files[0];
      if (file.size > 10 * 1024 * 1024) {
        showToast(`${file.name} exceeds the 10MB limit`);
      } else {
        attachmentCaption = '';
        pendingAttachment = {
          file,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        };
      }
      if (fileInput) fileInput.value = '';
      return;
    }

    // Several files picked at once become an album: one shared id the
    // message list grids on.
    const albumId = String(Date.now());
    try {
      for (const file of files) {
        await sendOneFile(file, albumId);
      }
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }

  function cancelPendingAttachment() {
    if (pendingAttachment?.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
    pendingAttachment = null;
    attachmentCaption = '';
  }

  async function confirmSendAttachment() {
    if (!pendingAttachment) return;
    const { file, previewUrl } = pendingAttachment;
    const caption = attachmentCaption.trim();
    pendingAttachment = null;
    attachmentCaption = '';
    await sendOneFile(file, null, caption || null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }

  async function sendOneFile(file, groupedId = null, caption = null) {
    // Support uploads up to 10MB!
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name} exceeds the 10MB limit`);
      return;
    }

    sendingFile = true;
    uploadProgress = 0;
    uploadFileName = file.name;
    try {
      // 1. Read entire file into ArrayBuffer
      let arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      });

      // 2. Automatically remove metadata from image files (JPEG and PNG)
      const isJpeg = file.type === 'image/jpeg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
      
      if (isJpeg) {
        arrayBuffer = stripJpegExif(arrayBuffer);
      } else if (isPng) {
        arrayBuffer = stripPngMetadata(arrayBuffer);
      }

      const cleanFileSize = arrayBuffer.byteLength;
      const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB chunks
      const totalChunks = Math.ceil(cleanFileSize / CHUNK_SIZE) || 1;

      // 3. Initialize E2E key material
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      const baseIv = crypto.getRandomValues(new Uint8Array(12));

      // Export key for packaging
      const exportedKey = await crypto.subtle.exportKey('raw', key);
      const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(exportedKey)));
      const ivBase64 = btoa(String.fromCharCode(...baseIv));

      // 4. Initialize chunked upload session on server
      const uploadRes = await initChunkedUpload(file.name, file.type, totalChunks, burnOnReadActive);
      const attachmentId = uploadRes.id;

      // 5. Encrypt and upload chunks sequentially from the clean buffer
      for (let index = 0; index < totalChunks; index++) {
        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, cleanFileSize);
        const chunkData = arrayBuffer.slice(start, end);

        // Encrypt the current chunk using baseIv and index
        const encryptedChunkBytes = await encryptChunk(key, chunkData, index, baseIv);
        
        // Convert to base64
        let chunkBase64 = '';
        const step = 1024;
        for (let i = 0; i < encryptedChunkBytes.length; i += step) {
          chunkBase64 += String.fromCharCode(...encryptedChunkBytes.subarray(i, i + step));
        }
        chunkBase64 = btoa(chunkBase64);

        // Upload chunk
        await uploadAttachmentChunk(attachmentId, index, chunkBase64);
        uploadProgress = Math.round(((index + 1) / totalChunks) * 100);
      }

      // 6. Send the attachment metadata as a media envelope.
      //
      // Goes through the same fork as text. With no groupedId the secret path
      // still serialises this to the exact legacy `{type:'attachment', …}`
      // payload, so clients that predate the envelope keep working; an album
      // carries structure and travels as a full envelope.
      await sendToChat(
        { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
        createMediaEnvelope(mediaKindFor(file.type), {
          id: attachmentId,
          key: keyBase64,
          iv: ivBase64,
          filename: file.name,
          mimeType: file.type,
          chunked: true,
          totalChunks: totalChunks,
          burnOnRead: burnOnReadActive,
        }, { groupedId, viewOnce: viewOnceActive }),
        { peer: $activePeer, currentUser: $currentUser, ttlMinutes, chatId: $activePeer.chatId }
      );
    } catch (err) {
      console.error('Failed to send E2E attachment:', err);
      showToast(err?.message ? `Failed to send attachment: ${err.message}` : 'Failed to send E2E attachment');
    } finally {
      sendingFile = false;
      uploadProgress = 0;
      uploadFileName = '';
    }
  }

  async function rotateSignedPrekey() {
    if (!$identityKeyPair) return;
    try {
      const newPrekeyPair = await generateKeyPair();
      const rawPublic = await exportPublicKeyBase64(newPrekeyPair.publicKey);
      const signatureBytes = await signData($identityKeyPair.ecdsa.privateKey, new TextEncoder().encode(rawPublic));
      const signature = btoa(String.fromCharCode(...signatureBytes));

      await updateSignedPrekey(rawPublic, signature);
      signedPrekeyPair.set(newPrekeyPair);
      console.log('[Security] Rotated and registered new Signed Prekey successfully.');
    } catch (e) {
      console.error('[Security] Failed to rotate Signed Prekey:', e);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        if (audioChunks.length === 0) return;
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        await sendVoiceNote(audioBlob);
      };
      mediaRecorder.start();
      isRecording = true;
      recordSeconds = 0;
      recordInterval = setInterval(() => {
        recordSeconds++;
      }, 1000);
    } catch (err) {
      console.error('Failed to start audio recording:', err);
      // NotAllowedError means the permission prompt won't fire again — a
      // generic "could not access" toast is a dead end every time after
      // that, since there's nothing left for the user to retry from here.
      showToast(
        err?.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Enable it in your phone\'s Settings → Apps → Vault → Permissions.'
          : 'Could not access microphone',
        { duration: err?.name === 'NotAllowedError' ? 7000 : 4000 }
      );
    }
  }

  function cancelRecording() {
    if (mediaRecorder && isRecording) {
      isRecording = false;
      clearInterval(recordInterval);
      audioChunks = [];
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
  }

  async function stopAndSendRecording() {
    if (mediaRecorder && isRecording) {
      isRecording = false;
      clearInterval(recordInterval);
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
  }

  async function sendVoiceNote(blob) {
    if (!$activePeer) return;
    sendingFile = true;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const { keyBase64, ivBase64, ciphertextBase64 } = await encryptFile(arrayBuffer);
      const uploadRes = await uploadAttachment('voicenote.webm', 'audio/webm', ciphertextBase64, burnOnReadActive);

      await sendToChat(
        { id: $activePeer.chatId || $activePeer.id, mode: $activePeer.mode || 'secret' },
        createMediaEnvelope(MessageType.VOICE, {
          id: uploadRes.id,
          key: keyBase64,
          iv: ivBase64,
          filename: 'voicenote.webm',
          mimeType: 'audio/webm',
          burnOnRead: burnOnReadActive,
        }),
        { peer: $activePeer, currentUser: $currentUser, ttlMinutes, chatId: $activePeer.chatId }
      );
    } catch (err) {
      console.error('Failed to send E2EE voice note:', err);
      showToast(err?.message ? `Failed to send voice note: ${err.message}` : 'Failed to send voice note');
    } finally {
      sendingFile = false;
    }
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  async function startCall(type) {
    if (!$activePeer) return;
    // Ratchet-based key exchange stays here (owned by the messaging layer);
    // everything else (media, peer connection, signaling) lives in webrtc.js
    // so the call keeps running even if the user navigates away afterward.
    await webrtcStartCall($activePeer, type, encryptSignalingPayload);
  }

  function hangupCall() {
    webrtcHangupCall();
  }

  onMount(() => {
    // WebRTC signaling (webrtc_sdp/webrtc_ice/webrtc_media_state) is handled
    // globally by lib/webrtc.js's registerCallSignaling(), so it keeps working
    // even while this component isn't mounted (e.g. no chat open, or a
    // different chat open than the call peer).
    wsUnsubscribes.push(onWsEvent('session_collision', () => {
      hasCollision = true;
    }));

    prekeyRotationTimer = setInterval(() => {
      rotateSignedPrekey();
    }, 24 * 60 * 60 * 1000);
  });

  onDestroy(() => {
    if (prekeyRotationTimer) clearInterval(prekeyRotationTimer);
    if (callDurationInterval) clearInterval(callDurationInterval);
    // Unmounting (e.g. switching to a channel, or being removed from a
    // group while its members modal was still open) previously left these
    // closures behind on backHandler's shared stack — a phantom entry for
    // a component that no longer exists, silently eating the next back
    // press/Escape for the rest of the session instead of doing anything.
    [
      unregisterMembersBack, unregisterChatMenuBack, unregisterSafetyBack,
      unregisterPollBack, unregisterStickersBack, unregisterAttachBack,
      unregisterConversationBack, unregisterAttachmentPreviewBack,
    ].forEach((unregister) => unregister?.());
    if (pendingAttachment?.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
    wsUnsubscribes.forEach(unsub => unsub());
    // Deliberately NOT calling resetCallState() here — an active call must
    // survive this component unmounting (e.g. the user navigates to a
    // different conversation or back to the empty state). Call teardown is
    // driven entirely by the activeCall store inside lib/webrtc.js.

    // Drag listeners are torn down by the draggable action's destroy().
  });

  function goBack() {
    activePeer.set(null);
    sidebarOpen.set(true);
  }

  // On mobile the conversation view covers the chat list rather than
  // pushing a new WebView history entry, so without this the Android back
  // button falls through past it (to whatever the WebView last navigated,
  // or out of the app) instead of returning to the list the way the
  // in-app back arrow (goBack, above) does.
  let unregisterConversationBack = null;
  $: {
    if ($activePeer && !$sidebarOpen && !unregisterConversationBack) {
      unregisterConversationBack = pushBackHandler(goBack);
    } else if ((!$activePeer || $sidebarOpen) && unregisterConversationBack) {
      unregisterConversationBack();
      unregisterConversationBack = null;
    }
  }
</script>

<!-- The theme scopes to this pane, not the document: it recolours the open
     conversation without restyling the sidebar or anything else. -->
<div
  class="flex-1 min-w-0 flex flex-col bg-vault-black h-full animate-fade-in relative"
  data-chat-theme={chatTheme || undefined}
>
  <DonateBar />

  <!-- Chat Header -->
  <!-- relative z-40: the message list below is a later sibling with its own
       stacking context (`relative`), so without this the header's popovers
       paint underneath it. They stay visible but stop receiving clicks, which
       looks like a dead button rather than a z-index problem. -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-vault-border glass-strong relative z-40">
    <div class="flex items-center gap-3 min-w-0 flex-1">
      <!-- Back button (mobile) -->
      <button
        on:click={goBack}
        class="md:hidden p-1.5 rounded-lg text-vault-text-dim hover:text-vault-text hover:bg-vault-elevated transition-all flex-shrink-0"
        aria-label="Back to conversations"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      <div
        class="w-10 h-10 rounded-xl flex items-center justify-center text-vault-white text-sm font-semibold flex-shrink-0 shadow-inner"
        style="background: {getAvatarGradient($activePeer?.username)}"
      >
        {$activePeer?.username?.[0]?.toUpperCase() || '?'}
      </div>
      <div class="min-w-0">
        <div class="flex items-center gap-1.5">
          <div class="text-sm font-semibold text-vault-text truncate">{$activePeer?.username || 'Unknown'}</div>
          {#if savedIdentityKey && savedIdentityKey === currentRatchet?.peerIdentityKey}
            <svg class="w-3.5 h-3.5 text-vault-accent flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" title="Verified Identity">
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
          {/if}
        </div>
        {#if !$activePeer.isGroup && chatCaps.has('safetyNumbers')}
          <button
            on:click={() => { if (!isTyping) showSafetyNumberModal = true; }}
            class="text-[10px] text-vault-text-dim flex items-center gap-1 hover:text-vault-accent transition-colors cursor-pointer text-left focus:outline-none w-full min-w-0"
            title="Click to verify fingerprint"
            disabled={isTyping}
          >
            <svg class="w-3 h-3 text-vault-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <span class="truncate">End-to-end encrypted · verify</span>
          </button>
        {:else if !$activePeer.isGroup}
          <!-- Cloud chat. Offering "fingerprint safety numbers" here would be
               actively misleading: there is no ratchet to verify, and the
               server can read this conversation. Say so plainly. -->
          <div class="text-[10px] text-vault-text-dim flex items-center gap-1 min-w-0" title="Stored on the server so it can sync across your devices">
            {#if peerPresence && describePresence(peerPresence)}
              {#if peerPresence.online}
                <span class="w-1.5 h-1.5 rounded-full bg-vault-success inline-block flex-shrink-0"></span>
              {/if}
              <span class="flex-shrink-0">{describePresence(peerPresence)}</span>
              <span aria-hidden="true" class="flex-shrink-0">·</span>
            {/if}
            <svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
            </svg>
            <span class="truncate">Cloud chat · syncs across devices</span>
          </div>
        {:else}
          <button
            on:click={() => showMembersModal = true}
            class="text-[10px] text-vault-text-dim flex items-center gap-1 hover:text-vault-accent transition-colors cursor-pointer text-left focus:outline-none w-full min-w-0"
            title="Click to view group members"
          >
            <svg class="w-3 h-3 text-vault-text-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span class="truncate">{$activePeer.members?.length || 0} members</span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Header Actions -->
    <div class="flex items-center gap-1 flex-shrink-0">
      <button
        on:click={() => showTtlSelector = !showTtlSelector}
        class="p-2 rounded-lg {showTtlSelector ? 'text-vault-warning bg-vault-elevated' : 'text-vault-text-dim'} hover:text-vault-warning hover:bg-vault-elevated transition-all focus:outline-none"
        title="Custom Message Expiration (Self-Destruct)"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>

      <button
        on:click={() => { searchActive = !searchActive; if (!searchActive) searchQuery = ''; }}
        class="p-2 rounded-lg {searchActive ? 'text-vault-accent bg-vault-elevated' : 'text-vault-text-dim'} hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
        title="Search Messages"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      <!-- Outside the private-chat guard on purpose: themes apply to groups
           too, and only the blocking entry inside is one-to-one. -->
      <div class="relative">
        <button
          on:click={() => showChatMenu = !showChatMenu}
          class="p-2 rounded-lg {showChatMenu ? 'text-vault-accent bg-vault-elevated' : 'text-vault-text-dim'} hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
          title="More options"
          aria-label="More options"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>

        {#if showChatMenu}
          <!-- `fixed`, not `absolute`: the header sits inside an
               overflow-hidden container, which clips an absolutely
               positioned popover. It stays in the DOM but is never visible,
               so a click on it waits forever. top adds env() on top of the
               flat offset (rather than replacing it) since fixed
               positioning ignores the header's own inherited safe-area
               padding — a plain top-16 happened to clear a typical status
               bar but isn't correct on a device with a taller inset
               (notch/cutout). -->
          <div
            class="fixed right-4 top-[calc(4rem+env(safe-area-inset-top,0px))] z-[60] w-52 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg"
            use:clickOutside={() => showChatMenu = false}
          >
            {#if $activePeer.chatId}
              <div class="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-vault-muted">
                Theme
              </div>
              <div class="px-2 pb-2 flex items-center gap-1.5 flex-wrap">
                {#each CHAT_THEMES as option (option.name ?? 'default')}
                  <button
                    on:click={() => applyTheme(option.name)}
                    title={option.label}
                    aria-label={option.label}
                    aria-pressed={chatTheme === option.name}
                    class="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none
                      {chatTheme === option.name ? 'border-vault-text' : 'border-transparent'}"
                    style="background: {option.swatch}"
                  ></button>
                {/each}
              </div>
              <!-- Unlike everything a chat carries, this is a preference
                   rather than content, so it is not subject to the 24h rule
                   and survives the messages it was picked for. -->
              <div class="border-t border-vault-border my-1"></div>
            {/if}

            {#if !$activePeer.isGroup}
              <button
                on:click={handleToggleBlock}
                class="w-full text-left px-3 py-2 text-xs {peerBlocked ? 'text-vault-text' : 'text-vault-danger'} hover:bg-vault-elevated transition-colors focus:outline-none"
              >
                {peerBlocked ? `Unblock ${$activePeer.username}` : `Block ${$activePeer.username}`}
              </button>
            {/if}
          </div>
        {/if}
      </div>

      {#if !$activePeer.isGroup}
        <button
          on:click={() => startCall('audio')}
          class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
          title="Start an encrypted audio call — media is relayed, so your IP is never shared with the other party"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </button>

        <button
          on:click={() => startCall('video')}
          class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
          title="Start an encrypted video call — media is relayed, so your IP is never shared with the other party"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </button>

        <!-- The "Relayed Call" badge lived here, permanently, beside buttons
             that start a call. It reassured about something that had not
             happened yet and cost header space on every screen. The same
             promise now rides on the call buttons' own tooltips, where it is
             read at the moment it matters. -->
      {/if}
    </div>
  </div>

  <!-- Group voice chat. Groups only: a 1:1 call already has its own path,
       and a room model on top of it would be two ways to do one thing. -->
  {#if $activePeer.isGroup && $activePeer.chatId}
    <VoiceChatBar chatId={$activePeer.chatId} />
    <TopicBar
      chatId={$activePeer.chatId}
      isForum={Boolean($activePeer.isForum)}
      canModerate={$activePeer.createdBy === $currentUser?.id}
      {activeTopicId}
      onSelect={selectTopic}
    />
  {/if}

  <!-- Search Overlay panel -->
  {#if searchActive}
    <div class="px-4 py-2 border-b border-vault-border bg-vault-surface/40 flex items-center justify-between gap-3 animate-fade-in text-vault-text">
      <div class="flex-1 relative">
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Search messages in this chat..."
          class="input py-1.5 text-xs bg-vault-elevated border-vault-border-subtle"
          style="padding-left: 2rem;"
        />
        <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-vault-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      {#if searchQuery}
        {@const matchCount = peerMessages.filter(m => m.text && m.text.toLowerCase().includes(searchQuery.toLowerCase())).length}
        <span class="text-[10px] text-vault-text-dim whitespace-nowrap">{matchCount} matches</span>
      {/if}
      <button
        on:click={() => { searchActive = false; searchQuery = ''; }}
        class="text-xs text-vault-accent hover:underline focus:outline-none bg-transparent border-none p-0 cursor-pointer"
      >
        Cancel
      </button>
    </div>
  {/if}

  <!-- Collision Warning Banner -->
  {#if hasCollision}
    <div class="px-4 py-2.5 bg-vault-danger/20 border-b border-vault-danger/30 text-xs text-vault-danger flex items-center justify-between gap-3 animate-fade-in">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-vault-danger flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span>
          <strong>Session Warning:</strong> Your E2EE keys were overwritten from another device. This session is now disconnected from receiving new handshakes. Please log out and log back in to replenish keys.
        </span>
      </div>
      <button
        on:click={() => window.location.reload()}
        class="px-2.5 py-1 text-[10px] bg-vault-danger text-vault-black hover:bg-vault-accent-hover font-semibold rounded-md transition-all cursor-pointer focus:outline-none"
      >
        Reload
      </button>
    </div>
  {/if}

  <!-- Warning Banner -->
  {#if hasKeyMismatch}
    <div class="px-4 py-2.5 bg-vault-danger/10 border-b border-vault-danger/20 text-xs text-vault-danger flex items-center justify-between gap-3 animate-fade-in">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-vault-danger flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 01.71 3h16.94a2 2 0 0 01.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>
          <strong>Security Alert:</strong> The E2EE fingerprint safety numbers with {$activePeer?.username} have changed. Verified status is temporarily disabled, indicating a potential MITM interception or key reset.
        </span>
      </div>
      <button
        on:click={() => showSafetyNumberModal = true}
        class="px-2.5 py-1 text-[10px] bg-vault-danger text-vault-black hover:bg-vault-accent-hover font-semibold rounded-md transition-all cursor-pointer focus:outline-none"
      >
        Compare
      </button>
    </div>
  {/if}

  <!-- TTL Slider -->
  {#if showTtlSelector}
    <div class="px-4 py-3 border-b border-vault-border bg-vault-surface/50 animate-fade-in">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-vault-text-secondary">Auto-delete after</span>
        <span class="text-xs font-medium text-vault-warning">{formatTTL(ttlMinutes)}</span>
      </div>
      <input
        type="range"
        min="1"
        max="1440"
        step="1"
        bind:value={ttlMinutes}
        class="w-full h-1 bg-vault-border rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-3
          [&::-webkit-slider-thumb]:h-3
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-vault-warning
          [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:transition-transform
          [&::-webkit-slider-thumb]:hover:scale-125"
      />
      <div class="flex justify-between text-[10px] text-vault-text-dim mt-1">
        <span>1 min</span>
        <span>1 hour</span>
        <span>12 hours</span>
        <span>24 hours</span>
      </div>
    </div>
  {/if}

  <!-- Messages Area -->
  <!-- The dot-grid wallpaper is a CSS radial-gradient, not an image asset:
       zero network weight (this app avoids extra assets on principle — see
       lib/safe-fetch.js), scales to any DPI, and rides the existing
       --color-vault-border-subtle token so it's already correct in both
       light/dark and never competes with bubble/text contrast. -->
  <div
    bind:this={messagesContainer}
    on:scroll={handleScroll}
    class="flex-1 overflow-y-auto px-4 py-4 space-y-1 relative bg-[radial-gradient(var(--color-vault-border)_1px,transparent_1px)] [background-size:22px_22px]"
  >
    {#if peerBlocked}
      <div class="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-vault-danger/10 border border-vault-danger/30 text-center">
        <p class="text-xs text-vault-danger font-medium">You blocked {$activePeer.username}</p>
        <p class="text-[10px] text-vault-text-dim mt-0.5">
          Neither of you can send messages here. Unblock from the menu above to resume.
        </p>
      </div>
    {/if}

    {#if loading}
      <div class="flex justify-center py-8">
        <div class="flex items-center gap-2 text-xs text-vault-text-dim">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
          </svg>
          Fetching messages...
        </div>
      </div>
    {:else if peerMessages.length === 0}
      <!-- Two distinct empty states. A conversation that once had messages is
           not the same as a brand-new one: after the 24h expiry the chat row
           survives but its contents are gone, and saying "start a secure
           conversation" there reads as the app having lost the history
           rather than deliberately discarding it. -->
      <div class="flex flex-col items-center justify-center h-full text-center py-16">
        <div class="w-16 h-16 rounded-2xl bg-vault-elevated border border-vault-border flex items-center justify-center mb-4">
          {#if conversationExpired}
            <svg class="w-8 h-8 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {:else}
            <svg class="w-8 h-8 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              <path d="M9.5 12l2 2 3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </div>
        {#if conversationExpired}
          <p class="text-sm text-vault-text-secondary mb-1">Messages have expired</p>
          <p class="text-xs text-vault-text-dim max-w-[260px]">
            Everything sent here was deleted 24 hours after it was sent. The conversation is still open — send a message to pick it back up.
          </p>
        {:else}
          <p class="text-sm text-vault-text-secondary mb-1">Start a secure conversation</p>
          <p class="text-xs text-vault-text-dim max-w-[240px]">
            All messages are encrypted and ephemeral. Messages are deleted 24 hours after they are sent.
          </p>
        {/if}
      </div>
    {:else}
      {#if loadingOlder}
        <div class="flex justify-center py-2">
          <div class="flex items-center gap-1.5 text-[10px] text-vault-text-dim">
            <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
            </svg>
            Loading older messages...
          </div>
        </div>
      {/if}
      {#each peerMessages as msg, i (msg.id)}
        <!-- An album opens a grid that its remaining members render into,
             so consecutive files read as one attachment rather than a
             column of separate bubbles. -->
        {#if albumRuns.first.has(i)}
          <div class="text-[10px] text-vault-text-dim px-2 pt-1">
            Album · {albumRuns.first.get(i)} files
          </div>
        {/if}
        <!-- Album members are pulled together so a run of files reads as one
             attachment rather than a column of separate sends. A margin on
             the wrapper rather than CSS reaching into the child: the previous
             rule targeted a class the bubble had stopped using and silently
             stopped matching, and a scoped selector aimed at another
             component's internals cannot be checked at build time. -->
        <div class={albumRuns.inRun.has(i) ? '-mt-2.5' : ''}>
        <MessageBubble
          onToggleReaction={handleToggleReaction}
          onReply={startReply}
          onEdit={startEdit}
          onDelete={handleDelete}
          onTogglePin={handleTogglePin}
          onForward={startForward}
          onJumpToSeq={jumpToSeq}
          onRetry={retryFailedMessage}
          quoted={quotedMessage(msg.replyToSeq)}
          message={msg}
          isOwn={msg.senderId === $currentUser?.id}
          showAvatar={i === 0 || peerMessages[i - 1]?.senderId !== msg.senderId}
          searchQuery={searchQuery}
        />
        </div>
      {/each}
    {/if}

    <!-- Video Call Grid -->
    {#if isCallActive && callType === 'video'}
      <div
        role="region"
        aria-label="Video Call Panel"
        use:draggable={{ position, onMove: (p) => (position = p), onDragChange: (d) => (isDragging = d) }}
        style={callWindowSize === 'fullscreen' 
          ? 'width: 100vw; height: 100vh; height: 100dvh; left: 0; top: 0;' 
          : `transform: translate(${position.x}px, ${position.y}px); cursor: ${isDragging ? 'grabbing' : 'grab'};`}
        class={callWindowSize === 'fullscreen'
          ? "fixed z-40 bg-vault-black flex flex-col justify-between overflow-hidden"
          : "absolute top-4 right-4 z-30 flex flex-col gap-2 p-2.5 bg-vault-surface/95 backdrop-blur-md border border-vault-border rounded-2xl shadow-xl transition-all duration-200 select-none " + (callWindowSize === 'large' ? 'w-[308px]' : 'w-48')}
      >
        <!-- Conditionally render top-bar for non-fullscreen -->
        {#if callWindowSize !== 'fullscreen'}
          <div class="flex items-center justify-between w-full pb-1 border-b border-vault-border-subtle cursor-grab active:cursor-grabbing select-none z-10">
            <div class="flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-vault-accent animate-pulse"></span>
              <span class="text-[9px] text-vault-text-dim font-semibold uppercase tracking-wider">
                {$activeCall?.status === 'ongoing' ? formatDuration(callDurationSeconds) : 'Call'}
              </span>
            </div>
            <div class="flex items-center gap-1">
              <button
                on:click={() => callWindowSize = 'normal'}
                class="p-0.5 rounded hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer"
                title="Normal view"
              >
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
              <button
                on:click={() => callWindowSize = 'large'}
                class="p-0.5 rounded hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer"
                title="Large view"
              >
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
              </button>
              <button
                on:click={() => callWindowSize = 'fullscreen'}
                class="p-0.5 rounded hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer"
                title="Fullscreen"
              >
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>
            </div>
          </div>
        {:else}
          <!-- Top bar overlay when fullscreen. Capped short of the self-view
               PIP (w-48 + its own right-edge margin, positioned separately
               below) so a long username can't grow the bar into it — the
               name truncates instead. -->
          <div
            style="top: max(calc(1.5rem + env(safe-area-inset-top, 0px)), 3rem); left: calc(1.5rem + env(safe-area-inset-left, 0px));"
            class="absolute z-20 flex items-center gap-2 bg-vault-surface/80 backdrop-blur-md border border-vault-border px-3.5 py-1.5 rounded-xl shadow-xl select-none max-w-[calc(100%-14rem)]"
          >
            <span class="w-2 h-2 rounded-full bg-vault-accent animate-pulse shrink-0"></span>
            <span class="text-xs text-vault-text font-semibold flex items-center gap-1 min-w-0">
              <span class="shrink-0">E2EE Call:</span>
              <span class="truncate">{callingPeer}</span>
              {#if $activeCall?.status === 'ongoing'}
                <span class="shrink-0">· {formatDuration(callDurationSeconds)}</span>
              {/if}
            </span>
            <div class="w-px h-4 bg-vault-border mx-1 shrink-0"></div>
            <button
              on:click={() => callWindowSize = 'normal'}
              class="p-1 rounded-lg hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer flex items-center gap-1 text-[10px] shrink-0"
              title="Exit Fullscreen"
            >
              <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
              </svg>
              Exit Fullscreen
            </button>
          </div>
        {/if}

        <!-- Local Video Container -->
        <div 
          style={callWindowSize === 'fullscreen' ? "top: max(calc(1.5rem + env(safe-area-inset-top, 0px)), 3rem); right: calc(1.5rem + env(safe-area-inset-right, 0px));" : ""}
          class={callWindowSize === 'fullscreen' 
            ? "absolute w-48 h-36 z-10 bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-xl animate-fade-in" 
            : `relative ${callWindowSize === 'large' ? 'w-[288px] h-[216px]' : 'w-44 h-32'} bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-inner animate-fade-in`}
        >
          <video bind:this={localVideo} autoplay playsinline muted class="w-full h-full object-cover {$isScreenSharing ? '' : 'scale-x-[-1]'}"></video>
          <span class="absolute bottom-1.5 left-2 text-[8px] bg-vault-black/60 px-1.5 py-0.5 rounded text-vault-text font-medium uppercase tracking-wider">Self</span>
        </div>

        <!-- Remote Video Container -->
        <div 
          class={callWindowSize === 'fullscreen' 
            ? "absolute inset-0 w-full h-full z-0 bg-vault-black flex items-center justify-center" 
            : `relative ${callWindowSize === 'large' ? 'w-[288px] h-[216px]' : 'w-44 h-32'} bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-inner flex items-center justify-center animate-fade-in`}
        >
          <video bind:this={remoteVideo} autoplay playsinline class="w-full h-full object-cover {$remoteCameraOff ? 'hidden' : ''}"></video>
          {#if $remoteCameraOff}
            <div class="absolute inset-0 flex flex-col items-center justify-center bg-vault-surface-subtle text-vault-text-dim text-xs gap-1.5">
              <svg class="w-8 h-8 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M23 7l-7 5 7 5V7z" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              <span class="text-[10px]">Camera Off</span>
            </div>
          {/if}
          <span class="absolute bottom-1.5 left-2 text-[8px] bg-vault-black/60 px-1.5 py-0.5 rounded text-vault-text font-medium uppercase tracking-wider">{callingPeer}</span>
          {#if $remoteMicMuted}
            <span class="absolute top-1.5 right-2 bg-vault-danger/25 text-vault-danger border border-vault-danger/30 p-1 rounded-full animate-pulse z-10" title="Muted">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
              </svg>
            </span>
          {/if}
        </div>

        <!-- Controls Wrapper -->
        <div 
          style={callWindowSize === 'fullscreen' ? "bottom: calc(2rem + env(safe-area-inset-bottom));" : ""}
          class={callWindowSize === 'fullscreen' 
            ? "absolute left-1/2 -translate-x-1/2 z-10 flex flex-col gap-2.5 p-3 bg-vault-surface/85 backdrop-blur-md border border-vault-border rounded-2xl shadow-2xl w-60" 
            : "flex flex-col gap-2 w-full z-10"}
        >
          {#if $verificationWords}
            <div class="text-[9px] bg-vault-black/30 border border-vault-border/50 text-vault-accent font-semibold px-2 py-0.5 rounded-lg text-center font-mono select-all w-full">
              Verify Code: {$verificationWords}
            </div>
          {/if}
          <div class="flex gap-2 w-full">
            <button
              on:click={toggleMic}
              class="flex-1 py-1.5 rounded-xl border text-xs transition-all flex items-center justify-center gap-1.5 focus:outline-none cursor-pointer
                {$micMuted ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
              title={$micMuted ? "Unmute Mic" : "Mute Mic"}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                {#if $micMuted}
                  <line x1="1" y1="1" x2="23" y2="23" />
                {/if}
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
              </svg>
            </button>
            <button
              on:click={toggleCamera}
              class="flex-1 py-1.5 rounded-xl border text-xs transition-all flex items-center justify-center gap-1.5 focus:outline-none cursor-pointer
                {$cameraOff ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
              title={$cameraOff ? "Turn Video On" : "Turn Video Off"}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                {#if $cameraOff}
                  <line x1="1" y1="1" x2="23" y2="23" />
                {/if}
                <path d="M23 7l-7 5 7 5V7z" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </button>
            <button
              on:click={toggleScreenShare}
              disabled={$activeCall?.status === 'ringing' || !isScreenShareSupported}
              class="flex-1 py-1.5 rounded-xl border text-xs transition-all flex items-center justify-center gap-1.5 focus:outline-none cursor-pointer
                {$activeCall?.status === 'ringing' || !isScreenShareSupported ? 'opacity-40 cursor-not-allowed bg-vault-elevated text-vault-text-dim border-vault-border-subtle' : ''}
                {!$isScreenSharing && $activeCall?.status !== 'ringing' && isScreenShareSupported ? 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text' : ''}
                {$isScreenSharing ? 'bg-vault-accent/20 text-vault-accent border-vault-accent/30' : ''}"
              title={!isScreenShareSupported ? "Screen sharing not supported on this device" : ($activeCall?.status === 'ringing' ? "Waiting for call to connect..." : ($isScreenSharing ? "Stop Sharing Screen" : "Share Screen"))}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          </div>
          <button
            on:click={hangupCall}
            class="w-full py-1.5 bg-vault-danger hover:bg-vault-danger-hover text-vault-black font-semibold text-xs rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
            Hang Up
          </button>

          <!-- P2P Direct File Transfer -->
          {#if $dataChannelReady && $activeCall?.status === 'ongoing'}
            <div class="px-2.5 py-1.5 bg-vault-black/30 border border-vault-border/50 rounded-xl flex flex-col gap-1 w-full text-left mt-1.5">
              <span class="text-[8px] text-vault-text-dim uppercase tracking-wider font-bold">P2P File Transfer (Direct)</span>
              
              {#if $p2pFileTransferState.status === 'idle'}
                <input type="file" bind:this={p2pFileInput} on:change={startP2PFileSend} class="hidden" />
                <button
                  on:click={() => p2pFileInput.click()}
                  class="w-full py-1 bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-[9px] rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none border-none"
                >
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Send Direct File
                </button>
              {:else if $p2pFileTransferState.status === 'sending' || $p2pFileTransferState.status === 'receiving'}
                <div class="flex flex-col gap-0.5 text-[8px] text-vault-text font-medium truncate w-full">
                  <span class="truncate block">
                    {$p2pFileTransferState.role === 'sender' ? 'Sending' : 'Receiving'}: {$p2pFileTransferState.filename}
                  </span>
                  <div class="w-full bg-vault-border rounded-full h-1 overflow-hidden">
                    <div class="bg-vault-accent h-full transition-all duration-150" style="width: {$p2pFileTransferState.progress}%"></div>
                  </div>
                  <span class="text-[7px] text-vault-text-dim text-right block">{$p2pFileTransferState.progress}%</span>
                </div>
              {:else if $p2pFileTransferState.status === 'completed'}
                <div class="text-[8px] text-vault-accent font-semibold flex items-center gap-1 justify-center py-0.5 animate-pulse">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Transfer Completed!
                </div>
              {:else if $p2pFileTransferState.status === 'failed'}
                <div class="text-[8px] text-vault-danger font-semibold flex items-center gap-1 justify-center py-0.5">
                  ⚠️ Transfer Failed
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {:else if isCallActive && callType === 'audio'}
      <!-- Audio Call Panel. Reused sizedForCallId/callWindowSize from the
           video panel above rather than inventing separate state — a full
           phone screen for a video call and a small corner widget for an
           audio one would be an inconsistent rule for the user to learn. -->
      <div class="z-30 animate-scale-up
        {callWindowSize === 'fullscreen'
          ? 'fixed inset-0 bg-vault-black flex flex-col items-center justify-between px-6 pt-[max(env(safe-area-inset-top,0px),2.5rem)] pb-[max(env(safe-area-inset-bottom,0px),2rem)]'
          : 'absolute top-4 right-4 flex items-center gap-3 p-3 bg-vault-surface border border-vault-border rounded-2xl shadow-xl'}"
      >
        {#if callWindowSize === 'fullscreen'}
          <button
            on:click={() => callWindowSize = 'normal'}
            class="self-start flex items-center gap-1 text-[11px] text-vault-text-dim hover:text-vault-text focus:outline-none"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
            </svg>
            Exit Fullscreen
          </button>

          <div class="flex flex-col items-center gap-3">
            <div
              class="w-28 h-28 rounded-full bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center text-vault-accent text-4xl font-semibold"
              class:animate-pulse-glow={$activeCall?.status !== 'ongoing'}
            >
              {(callingPeer || '?')[0].toUpperCase()}
            </div>
            <div class="text-xl font-semibold text-vault-text">{callingPeer}</div>
            <div class="text-sm text-vault-text-dim">
              {$activeCall?.status === 'ongoing' ? formatDuration(callDurationSeconds) : 'Connecting…'}
            </div>
            {#if $activeCall?.status === 'ongoing' && !$remoteMicMuted}
              <VoiceWaveform stream={$remoteStreamStore} />
            {/if}
            {#if $remoteMicMuted}
              <span class="text-vault-danger text-xs font-medium flex items-center gap-1 animate-pulse">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
                </svg>
                Their mic is muted
              </span>
            {/if}
            {#if $verificationWords}
              <div class="text-[10px] bg-vault-black/30 border border-vault-border/50 text-vault-accent font-semibold px-2.5 py-1 rounded-lg text-center font-mono select-all">
                Verify: {$verificationWords}
              </div>
            {/if}
          </div>
        {:else}
        <div class="flex items-center gap-2">
          <div class="w-2.5 h-2.5 rounded-full bg-vault-accent animate-pulse"></div>
          <span class="text-xs text-vault-text font-medium flex items-center gap-1.5">
            E2EE Audio: {callingPeer}{$activeCall?.status === 'ongoing' ? ` · ${formatDuration(callDurationSeconds)}` : ''}
            {#if $remoteMicMuted}
              <span class="text-vault-danger text-[10px] font-medium flex items-center gap-0.5 ml-1 animate-pulse">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
                </svg>
                (Muted)
              </span>
            {/if}
          </span>
          <!-- The video call's compact widget has a matching button (line
               ~2070). Audio never had one, which left its fullscreen branch
               below — the big avatar, the live waveform, the mic-muted
               banner — permanently unreachable through the UI. -->
          <button
            on:click={() => callWindowSize = 'fullscreen'}
            class="p-0.5 rounded hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer"
            title="Fullscreen"
            aria-label="Expand to fullscreen"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
        </div>
        {#if $verificationWords}
          <div class="text-[9px] bg-vault-black/30 border border-vault-border/50 text-vault-accent font-semibold px-2 py-1 rounded-lg text-center font-mono select-all">
            Verify: {$verificationWords}
          </div>
        {/if}
        {/if}
        <div class="flex items-center gap-3 {callWindowSize === 'fullscreen' ? 'flex-wrap justify-center' : ''}">
        <button
          on:click={toggleMic}
          class="p-2 rounded-xl border transition-all focus:outline-none cursor-pointer
            {$micMuted ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
          title={$micMuted ? "Unmute Mic" : "Mute Mic"}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            {#if $micMuted}
              <line x1="1" y1="1" x2="23" y2="23" />
            {/if}
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
          </svg>
        </button>

        <button
          on:click={toggleSpeaker}
          disabled={!isSinkIdSupported}
          class="p-2 rounded-xl border transition-all focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
            {speakerOn ? 'bg-vault-accent/20 text-vault-accent border-vault-accent/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
          title={!isSinkIdSupported ? 'Speaker switching is not supported in this browser' : (speakerOn ? 'Switch to Default Output' : 'Switch to Speaker')}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            {#if speakerOn}
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            {/if}
          </svg>
        </button>

        <!-- P2P Direct File Transfer -->
        {#if $dataChannelReady && $activeCall?.status === 'ongoing'}
          <input type="file" bind:this={p2pFileInput} on:change={startP2PFileSend} class="hidden" />
          {#if $p2pFileTransferState.status === 'idle'}
            <button
              on:click={() => p2pFileInput.click()}
              class="p-2 rounded-xl border bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text transition-all focus:outline-none cursor-pointer"
              title="Send Direct P2P File"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          {:else if $p2pFileTransferState.status === 'sending' || $p2pFileTransferState.status === 'receiving'}
            <div class="flex flex-col gap-0.5 text-[8px] text-vault-text font-medium min-w-[60px] truncate">
              <span class="truncate block">{$p2pFileTransferState.role === 'sender' ? 'Sending' : 'Receiving'} {$p2pFileTransferState.progress}%</span>
              <div class="w-full bg-vault-border rounded-full h-1 overflow-hidden">
                <div class="bg-vault-accent h-full transition-all duration-150" style="width: {$p2pFileTransferState.progress}%"></div>
              </div>
            </div>
          {:else if $p2pFileTransferState.status === 'completed'}
            <span class="text-[8px] text-vault-accent font-semibold animate-pulse">Done</span>
          {:else if $p2pFileTransferState.status === 'failed'}
            <span class="text-[8px] text-vault-danger font-semibold">Failed</span>
          {/if}
        {/if}

        <button
          on:click={hangupCall}
          class="px-3 py-1.5 bg-vault-danger hover:bg-vault-danger-hover text-vault-black font-semibold text-xs rounded-xl transition-all cursor-pointer focus:outline-none"
        >
          Hang Up
        </button>
        </div>
      </div>
    {/if}

    <!-- Typing indicator -->
    {#if isTyping}
      <div class="flex items-center gap-2 px-2 py-1 animate-fade-in">
        <div class="w-6 h-6 rounded-lg bg-vault-elevated flex items-center justify-center text-vault-text-dim text-[10px] font-semibold">
          {$activePeer?.username?.[0]?.toUpperCase()}
        </div>
        <div class="px-3 py-2 rounded-2xl bg-vault-elevated">
          <div class="typing-dots">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    {/if}

    <!-- The dots above are decorative; this is what a screen reader actually
         announces. Single persistent region, matching the wsConnected
         indicator in ChatSidebar.svelte, so entering/leaving the DOM on its
         own doesn't affect whether it gets picked up as "live". -->
    <div class="sr-only" aria-live="polite">
      {#if isTyping}{$activePeer?.username || 'They'} is typing…{/if}
    </div>

    <!-- Announces the newest incoming message for screen-reader users who
         aren't focused on the message list — the visual bubble already
         covers sighted users. Content-keyed so switching to a different
         conversation re-announces its latest message (parity with what a
         sighted user sees on open) but re-renders of the same message
         (e.g. loading older history) don't re-trigger it. -->
    <div class="sr-only" aria-live="polite" aria-atomic="true">
      {#if lastIncomingMessage}
        New message from {$activePeer?.username || 'peer'}: {lastIncomingMessage.text || 'attachment'}
      {/if}
    </div>
  </div>


  <!-- Message Input -->
  <div class="px-2 md:px-4 py-2 md:py-3 border-t border-vault-border glass-strong animate-fade-in">

    <div class="flex items-end gap-1.5 md:gap-2">
      <input
        type="file"
        multiple
        bind:this={fileInput}
        on:change={handleFileChange}
        class="hidden"
      />

      <div class="relative flex-shrink-0">
        <button
          on:click={() => (showAttachMenu = !showAttachMenu)}
          disabled={sendingMessage || sendingFile}
          class="w-9 h-9 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center transition-all cursor-pointer focus:outline-none
            {showAttachMenu || viewOnceActive
              ? 'bg-vault-accent/20 text-vault-accent'
              : 'bg-vault-elevated text-vault-text-dim hover:text-vault-text hover:bg-vault-border'}"
          title="Attach"
          aria-label="Attach"
          aria-expanded={showAttachMenu}
        >
          {#if sendingFile}
            <svg class="w-4 h-4 animate-spin text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
            </svg>
          {:else}
            <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          {/if}
        </button>

        {#if showAttachMenu}
          <!-- One menu instead of a row of unlabelled icons. Everything here
               is infrequent enough that a second tap costs nothing, and the
               labels say what the icons could not: "view once" in particular
               is not guessable from an eye. -->
          <div
            class="absolute bottom-full left-0 mb-2 z-50 w-56 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg"
            use:clickOutside={() => (showAttachMenu = false)}
          >
            <button
              on:click={() => { showAttachMenu = false; fileInput.click(); }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
            >
              <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span>Photo or file<span class="block text-[10px] text-vault-text-dim">Pick several to send an album</span></span>
            </button>

            {#if canViewOnce}
              <button
                on:click={() => { viewOnceActive = !viewOnceActive; showAttachMenu = false; }}
                aria-pressed={viewOnceActive}
                class="w-full flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-vault-elevated transition-colors focus:outline-none text-left
                  {viewOnceActive ? 'text-vault-accent' : 'text-vault-text'}"
              >
                <svg class="w-4 h-4 shrink-0 {viewOnceActive ? 'text-vault-accent' : 'text-vault-text-dim'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>
                  View once{viewOnceActive ? ' · on' : ''}
                  <span class="block text-[10px] text-vault-text-dim">Deleted from the server once opened</span>
                </span>
              </button>
            {/if}

            {#if canPoll}
              <button
                on:click={() => { showAttachMenu = false; openPollComposer(); }}
                class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
              >
                <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M18 20V10M12 20V4M6 20v-6" />
                </svg>
                <span>Poll<span class="block text-[10px] text-vault-text-dim">Ask the group a question</span></span>
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <div class="relative flex-shrink-0">
        <button
          on:click={() => (showStickers = !showStickers)}
          disabled={sendingMessage || sendingFile}
          class="w-9 h-9 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center transition-all cursor-pointer focus:outline-none
            {showStickers
              ? 'bg-vault-accent/20 text-vault-accent'
              : 'bg-vault-elevated text-vault-text-dim hover:text-vault-text hover:bg-vault-border'}"
          title="Stickers"
          aria-label="Stickers"
        >
          <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 1 1-9-9c0 4 1 5 5 5s5 1 5 4z" />
            <path d="M12 21c4-4 5-5 9-9" />
          </svg>
        </button>

        {#if showStickers}
          <!-- Anchored above the composer; `bottom-full` keeps it from being
               clipped by the message list's own stacking context. -->
          <div class="absolute bottom-full left-0 mb-2 z-50">
            <StickerPicker
              onPick={sendSticker}
              onClose={() => (showStickers = false)}
            />
          </div>
        {/if}
      </div>

      {#if isRecording}
        <div class="flex-1 flex items-center justify-between px-3 py-2 bg-vault-danger/10 border border-vault-danger/20 rounded-xl animate-pulse text-vault-danger">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-vault-danger animate-ping"></span>
            <span class="text-xs font-semibold">Recording: {formatDuration(recordSeconds)}</span>
          </div>
          <div class="flex gap-2">
            <button
              on:click={cancelRecording}
              class="text-[10px] text-vault-text-dim hover:text-vault-text focus:outline-none bg-transparent border-none cursor-pointer p-0"
            >
              Cancel
            </button>
            <button
              on:click={stopAndSendRecording}
              class="text-[10px] text-vault-danger hover:underline font-semibold focus:outline-none bg-transparent border-none cursor-pointer p-0"
            >
              Send Note
            </button>
          </div>
        </div>
      {:else if sendingFile && uploadFileName}
        <!-- Gated on uploadFileName, not just sendingFile — sendVoiceNote
             also sets sendingFile but is a single-shot upload with no
             chunk-by-chunk progress to show, so it falls through to the
             ordinary composer below instead of a permanently-0% bar. -->
        <div class="flex-1 flex flex-col gap-1 px-3 py-2 bg-vault-elevated border border-vault-border-subtle rounded-xl">
          <span class="text-[11px] text-vault-text-dim truncate">Sending {uploadFileName}… {uploadProgress}%</span>
          <div class="w-full bg-vault-border rounded-full h-1 overflow-hidden">
            <div class="bg-vault-accent h-full transition-all duration-150" style="width: {uploadProgress}%"></div>
          </div>
        </div>
      {:else}
        <div class="flex-1 relative">
          {#if editingMessage}
            <div class="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded-lg bg-vault-elevated border-l-2 border-vault-warning">
              <svg class="w-3.5 h-3.5 text-vault-warning flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <div class="flex-1 min-w-0">
                <div class="text-[10px] text-vault-warning font-medium">Editing message</div>
                <div class="text-[11px] text-vault-text-dim truncate">{editingMessage.text}</div>
              </div>
              <button
                on:click={cancelEdit}
                class="flex-shrink-0 p-1 rounded text-vault-text-dim hover:text-vault-text transition-colors focus:outline-none"
                aria-label="Cancel edit"
                title="Cancel edit"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}

          {#if viewOnceActive}
            <!-- Armed state gets its own bar. It was a toggle on a permanently
                 visible icon before; now that it lives behind a menu, the only
                 thing standing between "armed" and "I forgot" is this. Sending
                 a message you meant to be ordinary as view-once destroys it
                 for the recipient, so the state has to be loud. -->
            <div class="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded-lg bg-vault-accent/10 border-l-2 border-vault-accent">
              <svg class="w-3.5 h-3.5 text-vault-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <div class="flex-1 min-w-0">
                <div class="text-[10px] text-vault-accent font-medium">View once</div>
                <div class="text-[11px] text-vault-text-dim truncate">
                  This message is deleted from the server once it is opened
                </div>
              </div>
              <button
                on:click={() => (viewOnceActive = false)}
                class="flex-shrink-0 p-1 rounded text-vault-text-dim hover:text-vault-text transition-colors focus:outline-none"
                aria-label="Turn off view once"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}

          {#if replyingTo}
            <div class="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded-lg bg-vault-elevated border-l-2 border-vault-accent">
              <svg class="w-3.5 h-3.5 text-vault-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 17 4 12 9 7" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
              <div class="flex-1 min-w-0">
                <div class="text-[10px] text-vault-accent font-medium">
                  Replying to {replyingTo.senderId === $currentUser?.id ? 'yourself' : $activePeer.username}
                </div>
                <div class="text-[11px] text-vault-text-dim truncate">
                  {replyingTo.text || 'Attachment'}
                </div>
              </div>
              <button
                on:click={cancelReply}
                class="flex-shrink-0 p-1 rounded text-vault-text-dim hover:text-vault-text transition-colors focus:outline-none"
                aria-label="Cancel reply"
                title="Cancel reply"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}
          <textarea
            bind:this={composerEl}
            bind:value={messageText}
            on:keydown={handleKeydown}
            on:input={handleInput}
            placeholder={peerBlocked ? 'You blocked this user' : 'Type a message...'}
            rows="1"
            class="input resize-none py-2.5 pr-10 min-h-[40px] max-h-[120px] text-sm bg-vault-elevated border-vault-border-subtle disabled:opacity-50"
            disabled={sendingMessage || peerBlocked}
          ></textarea>
        </div>

        <button
          on:click={startRecording}
          disabled={sendingMessage || sendingFile}
          class="flex-shrink-0 w-9 h-9 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center bg-vault-elevated text-vault-text-dim hover:text-vault-text hover:bg-vault-border transition-all cursor-pointer focus:outline-none"
          title="Record Voice Note"
        >
          <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
          </svg>
        </button>
      {/if}

      <button
        on:click={handleSend}
        disabled={!messageText.trim() || sendingMessage}
        class="flex-shrink-0 w-9 h-9 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center transition-all
          {messageText.trim() ? 'bg-vault-accent text-vault-black hover:bg-vault-accent-hover shadow-lg shadow-vault-accent/20' : 'bg-vault-elevated text-vault-muted'}"
      >
        {#if sendingMessage}
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
          </svg>
        {:else}
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        {/if}
      </button>
    </div>

    <!-- Encryption indicator -->
    <div class="flex items-center justify-center gap-1.5 mt-2 text-[10px] text-vault-text-dim">
      <svg class="w-3 h-3 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      End-to-end encrypted · Auto-deletes in {formatTTL(ttlMinutes)}
    </div>
  </div>
</div>

{#if isScrolledUp}
  <button
    on:click={scrollToBottom}
    class="absolute bottom-24 right-6 z-10 flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold rounded-full bg-vault-elevated border border-vault-border shadow-lg hover:bg-vault-border text-vault-text transition-all animate-slide-up cursor-pointer focus:outline-none"
  >
    <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
    {#if hasNewUnreadInScroll}
      <span class="w-2 h-2 rounded-full bg-vault-accent animate-pulse"></span>
      New Messages
    {:else}
      Scroll to bottom
    {/if}
  </button>
{/if}

{#if showSafetyNumberModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" transition:fade={{ duration: 150 }}>
    <div class="glass-strong rounded-2xl p-6 max-w-sm w-full border border-vault-border shadow-2xl" transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}>
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl bg-vault-accent/10 flex items-center justify-center text-vault-accent">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </div>
        <div>
          <h3 class="text-sm font-semibold text-vault-text">Verify Session Fingerprint</h3>
          <p class="text-[10px] text-vault-text-dim">Confirm safety numbers with {$activePeer?.username}</p>
        </div>
      </div>

      <div class="bg-vault-black/40 border border-vault-border rounded-xl p-4 text-center mb-4 relative">
        <p class="text-xs text-vault-text-dim mb-1 tracking-wider uppercase">Safety Number</p>
        <p class="text-lg font-mono font-bold tracking-widest text-vault-accent selection:bg-vault-accent/20">
          {safetyNumber}
        </p>
        <button
          on:click={copyFingerprint}
          class="absolute top-2 right-2 p-1.5 rounded-lg text-vault-text-dim hover:text-vault-text hover:bg-vault-elevated transition-all focus:outline-none cursor-pointer"
          title="Copy Safety Number"
        >
          {#if copied}
            <svg class="w-3.5 h-3.5 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          {/if}
        </button>
      </div>

      <!-- QR Code Session Verification -->
      {#if safetyNumberQrUrl}
        <div class="flex flex-col items-center justify-center p-3 bg-white rounded-xl mb-4 shadow-inner border border-vault-border/50 w-36 h-36 mx-auto select-none">
          <img
            src={safetyNumberQrUrl}
            alt="Safety Number QR Code"
            class="w-28 h-28"
          />
        </div>
      {/if}

      <p class="text-xs text-vault-text-dim leading-relaxed mb-6">
        To prevent eavesdropping, verify that these numbers match the safety numbers shown on {$activePeer?.username}'s device. If they match, your connection is cryptographically secure.
      </p>

      <!-- Verify Toggle button -->
      <div class="mt-4 flex gap-2">
        {#if savedIdentityKey === currentRatchet?.peerIdentityKey}
          <button
            on:click={() => {
              verifiedPeers.update(map => {
                map.delete($activePeer.id);
                return new Map(map);
              });
            }}
            class="btn-ghost flex-1 py-2 text-xs border-vault-danger/30 text-vault-danger hover:bg-vault-danger/5 rounded-xl cursor-pointer"
          >
            Clear Verification
          </button>
        {:else}
          <button
            on:click={() => {
              if (currentRatchet?.peerIdentityKey) {
                verifiedPeers.update(map => {
                  map.set($activePeer.id, currentRatchet.peerIdentityKey);
                  return new Map(map);
                });
              }
            }}
            class="btn-primary flex-1 py-2 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer"
            disabled={!currentRatchet?.peerIdentityKey}
          >
            Verify Fingerprint
          </button>
        {/if}
      </div>

      <button
        on:click={() => showSafetyNumberModal = false}
        class="btn-primary w-full py-2.5 text-xs text-vault-black bg-vault-accent hover:bg-vault-accent-hover font-semibold rounded-xl transition-all cursor-pointer mt-3"
      >
        Done
      </button>
    </div>
  </div>
{/if}

{#if showMembersModal && $activePeer?.isGroup}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" transition:fade={{ duration: 150 }}>
    <div class="glass-strong rounded-2xl p-6 max-w-sm w-full border border-vault-border shadow-2xl text-left" transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}>
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-sm font-semibold text-vault-text">Group Members</h3>
        <button on:click={() => showMembersModal = false} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close members list">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="space-y-2.5 max-h-60 overflow-y-auto pr-1">
        {#each $activePeer.members || [] as member}
          <div class="flex items-center gap-3 px-1 py-1">
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center text-vault-white font-semibold text-xs shadow-inner"
              style="background: {getAvatarGradient(member.username)}"
            >
              {member.username[0].toUpperCase()}
            </div>
            <div class="flex-1">
              <div class="text-xs font-semibold text-vault-text">{member.username}</div>
              {#if member.id === $currentUser?.id}
                <div class="text-[9px] text-vault-accent">You</div>
              {/if}
            </div>
            <!-- Moderation, gated on rights the *server* resolved. The
                 buttons hidden here are also refused server-side; this only
                 avoids offering an action that would fail. -->
            {#if member.id !== $currentUser?.id}
              <div class="flex items-center gap-2 flex-shrink-0">
                {#if canPromote}
                  <button
                    on:click={() => promote(member)}
                    class="text-[10px] text-vault-accent hover:underline focus:outline-none cursor-pointer"
                  >
                    Make admin
                  </button>
                {/if}
                {#if canBan}
                  <button
                    on:click={() => ban(member)}
                    class="text-[10px] text-vault-danger hover:underline focus:outline-none cursor-pointer"
                    title="Removes them and prevents rejoining with any invite link"
                  >
                    Ban
                  </button>
                {:else if $activePeer.createdBy === $currentUser?.id}
                  <button
                    on:click={() => handleRemoveMember(member.id, member.username)}
                    class="text-[10px] text-vault-danger hover:underline focus:outline-none cursor-pointer"
                  >
                    Remove
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <div class="border-t border-vault-border mt-4 pt-4">
        <button
          on:click={handleLeaveGroup}
          class="w-full text-xs text-vault-danger hover:bg-vault-danger/10 border border-vault-danger/20 rounded-xl py-2 font-semibold transition-colors cursor-pointer focus:outline-none"
        >
          Leave Group
        </button>
      </div>

      <!-- Invite links.
           Replaces the old join key, which could never be withdrawn: anyone
           who had ever seen it could rejoin indefinitely. These expire, can be
           limited by use count, and can be revoked. -->
      {#if canManageInvites}
        <div class="border-t border-vault-border mt-4 pt-4 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-vault-text-dim uppercase font-bold tracking-wider">Invite links</span>
            <button
              on:click={loadInvites}
              class="text-[10px] text-vault-accent hover:underline focus:outline-none"
            >
              {invites.length || loadingInvites ? 'Refresh' : 'Show links'}
            </button>
          </div>

          <div class="flex flex-wrap gap-1.5">
            <button
              on:click={() => makeInvite({ expiresHours: 24 })}
              class="px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[10px] text-vault-text hover:border-vault-accent transition-colors focus:outline-none"
            >
              New link · 24h
            </button>
            <button
              on:click={() => makeInvite({ usageLimit: 1 })}
              class="px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[10px] text-vault-text hover:border-vault-accent transition-colors focus:outline-none"
            >
              New link · single use
            </button>
            <button
              on:click={() => makeInvite()}
              class="px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[10px] text-vault-text hover:border-vault-accent transition-colors focus:outline-none"
            >
              New link · no limit
            </button>
          </div>

          {#if loadingInvites}
            <p class="text-[9px] text-vault-text-dim">Loading…</p>
          {:else if invites.length > 0}
            <div class="space-y-1 max-h-40 overflow-y-auto">
              {#each invites as invite (invite.hash)}
                <div class="flex items-center gap-2 p-1.5 bg-vault-elevated border border-vault-border rounded-lg">
                  <div class="flex-1 min-w-0">
                    <div class="text-[10px] font-mono text-vault-text truncate {invite.revoked ? 'line-through opacity-50' : ''}">
                      …{invite.hash.slice(-10)}
                    </div>
                    <div class="text-[9px] text-vault-text-dim">{describeInvite(invite)}</div>
                  </div>
                  {#if !invite.revoked}
                    <button
                      on:click={() => copyInvite(invite.hash)}
                      class="text-[10px] text-vault-accent hover:underline focus:outline-none whitespace-nowrap"
                    >
                      {inviteCopied === invite.hash ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      on:click={() => doRevokeInvite(invite.hash)}
                      class="text-[10px] text-vault-danger hover:underline focus:outline-none whitespace-nowrap"
                    >
                      Revoke
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          <p class="text-[9px] text-vault-text-dim leading-relaxed">
            Revoking a link stops anyone still holding it from joining. Banned members cannot rejoin with any link.
          </p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Forward picker -->
{#if pendingAttachment}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/70 backdrop-blur-sm p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Send attachment"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm rounded-2xl bg-vault-surface border border-vault-border p-4 flex flex-col gap-3"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-vault-text">Send file</h3>
        <button
          on:click={cancelPendingAttachment}
          class="p-1 rounded text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Cancel"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {#if pendingAttachment.previewUrl}
        <img
          src={pendingAttachment.previewUrl}
          alt="Preview"
          class="w-full max-h-64 rounded-xl object-contain bg-vault-black/40"
        />
      {:else}
        <div class="flex items-center gap-2.5 px-3 py-2.5 bg-vault-elevated border border-vault-border rounded-xl">
          <svg class="w-5 h-5 text-vault-accent shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span class="text-xs text-vault-text truncate">{pendingAttachment.file.name}</span>
        </div>
      {/if}

      <input
        bind:value={attachmentCaption}
        on:keydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !Capacitor.isNativePlatform()) { e.preventDefault(); confirmSendAttachment(); } }}
        placeholder="Add a caption…"
        maxlength="1024"
        class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle"
      />

      <div class="flex justify-end gap-2">
        <button
          on:click={cancelPendingAttachment}
          class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl focus:outline-none"
        >
          Cancel
        </button>
        <button
          on:click={confirmSendAttachment}
          class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl focus:outline-none"
        >
          Send
        </button>
      </div>
    </div>
  </div>
{/if}

{#if forwardingMessage}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/70 backdrop-blur-sm p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Forward message"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm rounded-2xl bg-vault-surface border border-vault-border p-4"
      use:clickOutside={() => forwardingMessage = null}
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold text-vault-text">Forward to…</h3>
        <button
          on:click={() => forwardingMessage = null}
          class="p-1 rounded text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Close"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <p class="text-[11px] text-vault-text-dim mb-3 truncate">{forwardingMessage.text}</p>

      {#if forwardTargets.length === 0}
        <!-- Secret chats are absent by design: forwarding copies the message
             body server-side, and there is no plaintext body to copy into an
             encrypted conversation. Saying so beats an empty list. -->
        <p class="text-xs text-vault-text-dim py-4 text-center">
          No chats available. Messages can only be forwarded into cloud chats.
        </p>
      {:else}
        <div class="max-h-64 overflow-y-auto space-y-1">
          {#each forwardTargets as target (target.chatId)}
            <button
              on:click={() => doForward(target)}
              class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-vault-elevated transition-colors text-left focus:outline-none"
            >
              <div
                class="w-7 h-7 rounded-lg flex items-center justify-center text-vault-white text-xs font-semibold flex-shrink-0"
                style="background: {getAvatarGradient(target.peerUsername || '?')}"
              >
                {(target.peerUsername || '?')[0].toUpperCase()}
              </div>
              <span class="text-sm text-vault-text truncate">{target.peerUsername}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if showPollComposer}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    on:click|self={() => (showPollComposer = false)}
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-md rounded-2xl glass-strong border border-vault-border p-4 flex flex-col gap-3"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-vault-text">New poll</h3>
        <button
          on:click={() => (showPollComposer = false)}
          class="text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Close"
        >✕</button>
      </div>

      <input
        bind:value={pollQuestion}
        placeholder="Ask a question"
        maxlength="300"
        class="w-full px-3 py-2 rounded-lg bg-vault-elevated border border-vault-border text-sm text-vault-text focus:outline-none focus:border-vault-accent"
      />

      <div class="flex flex-col gap-1.5">
        {#each pollOptions as _, i}
          <div class="flex items-center gap-1.5">
            <input
              bind:value={pollOptions[i]}
              placeholder={`Option ${i + 1}`}
              maxlength="100"
              class="flex-1 px-3 py-1.5 rounded-lg bg-vault-elevated border border-vault-border text-sm text-vault-text focus:outline-none focus:border-vault-accent"
            />
            {#if pollOptions.length > 2}
              <button
                on:click={() => (pollOptions = pollOptions.filter((_, j) => j !== i))}
                class="text-vault-text-dim hover:text-vault-danger text-xs focus:outline-none"
                aria-label={`Remove option ${i + 1}`}
              >✕</button>
            {/if}
          </div>
        {/each}
        {#if pollOptions.length < 10}
          <button
            on:click={() => (pollOptions = [...pollOptions, ''])}
            class="self-start text-[11px] text-vault-accent hover:underline focus:outline-none"
          >Add option</button>
        {/if}
      </div>

      <label class="flex items-center gap-2 text-xs text-vault-text-dim">
        <input type="checkbox" bind:checked={pollAnonymous} /> Anonymous
      </label>
      <label class="flex items-center gap-2 text-xs text-vault-text-dim">
        <input type="checkbox" bind:checked={pollMultiple} /> Allow multiple answers
      </label>

      <!-- Nothing here is exempt from the 24h rule: the poll row is tied to
           its message by foreign key and is deleted along with it. -->
      <p class="text-[10px] text-vault-muted">
        The poll disappears with its message after 24 hours.
      </p>

      {#if pollError}
        <div class="text-[11px] text-vault-danger">{pollError}</div>
      {/if}

      <div class="flex justify-end gap-2">
        <button
          on:click={() => (showPollComposer = false)}
          class="px-3 py-1.5 rounded-lg text-xs text-vault-text-dim hover:text-vault-text focus:outline-none"
        >Cancel</button>
        <button
          on:click={submitPoll}
          disabled={creatingPoll}
          class="px-3 py-1.5 rounded-lg text-xs bg-vault-accent text-vault-black font-medium disabled:opacity-50 focus:outline-none"
        >{creatingPoll ? 'Creating…' : 'Create poll'}</button>
      </div>
    </div>
  </div>
{/if}

