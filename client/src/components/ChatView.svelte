<script>
  import { onMount, afterUpdate, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, activePeer, sidebarOpen, ratchetSessions, identityKeyPair, signedPrekeyPair, oneTimePrekeyPairs, groupSenderKeys, historyKey, verifiedPeers, localBackupEnabled, localBackupPassphrase, activeCall, recentCalls } from '../lib/stores/session.js';
  import { messagesByPeer, addMessage, addMessages, addOptimisticMessage, confirmMessage, typingUsers, conversations, restoreBackup } from '../lib/stores/messages.js';
  import { sendMessage, fetchMessages, fetchKeyBundle, uploadAttachment, initChunkedUpload, uploadAttachmentChunk, updateSignedPrekey, fetchTurnCredentials, sendClientDebugLog } from '../lib/api/http.js';
  import { sendTyping, wsConnected, onWsEvent, wsSend } from '../lib/api/ws.js';
  import { RatchetSession } from '../lib/crypto/ratchet.js';
  import { x3dhInitiate, x3dhRespond, deriveInitialKeys } from '../lib/crypto/x3dh.js';
  import { exportPublicKeyBase64, encrypt as encryptSelf, decrypt as decryptSelf, encryptFile, generateKeyPair, signData, encryptChunk, decryptChunk, importStaticKey } from '../lib/crypto/keys.js';
  import { SenderKeySession } from '../lib/crypto/senderkeys.js';
  import { randomHex, toBase64, fromBase64 } from '../lib/crypto/utils.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { syncCloudVault } from '../lib/crypto/sync.js';
  import MessageBubble from './MessageBubble.svelte';

  let messageText = '';
  let messagesContainer;
  let sendingMessage = false;
  let loading = false;
  let ttlMinutes = 1440; // Default 24h
  let currentCallKey = null;
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
  $: isTyping = $activePeer ? $typingUsers.has($activePeer.id) : false;

  $: currentRatchet = $activePeer ? $ratchetSessions.get($activePeer.id) : null;
  $: savedIdentityKey = $activePeer ? $verifiedPeers.get($activePeer.id) : null;
  $: hasKeyMismatch = currentRatchet && currentRatchet.peerIdentityKey && savedIdentityKey && savedIdentityKey !== currentRatchet.peerIdentityKey;

  // WebRTC connection variables
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let hasCollision = false;
  let initializingPeerConnection = false;
  let peerConnectionPromise = null;
  let localStreamPromise = null;
  let iceCandidatesQueue = [];
  let remoteAudioElement = null;

  $: isCallActive = $activeCall && ($activeCall.status === 'ongoing' || $activeCall.status === 'ringing') && $activeCall.peerId === $activePeer?.id;
  $: callType = $activeCall ? $activeCall.type : null;
  $: callingPeer = $activeCall ? $activeCall.peerUsername : null;

  // For incoming calls: when accepted by Chat.svelte, import the key and init peer connection
  $: if ($activeCall && $activeCall.status === 'ongoing' && $activeCall.currentCallKey && !currentCallKey && $activeCall.direction === 'incoming') {
    currentCallKey = $activeCall.currentCallKey;
    initializePeerConnection($activeCall.peerId);
  }

  // For outgoing calls: when callee accepts (peerAccepted flag), start SDP negotiation
  $: if ($activeCall && $activeCall.peerAccepted && $activeCall.direction === 'outgoing' && !peerConnection) {
    (async () => {
      try {
        await startOfferNegotiation($activeCall.peerId);
      } catch (err) {
        sendClientDebugLog('Reactive block startOfferNegotiation failed', err);
      }
    })();
  }

  $: if ($activeCall && $activeCall.status === 'ongoing' && !localStream && $activeCall.direction === 'incoming') {
    localStreamPromise = acquireMediaForIncomingCall();
  }

  $: if (!$activeCall && localStream) {
    resetCallState();
  }

  let showMembersModal = false;
  let micMuted = false;
  let cameraOff = false;
  let isScreenSharing = false;
  let screenStream = null;
  let remoteMicMuted = false;
  let remoteCameraOff = false;
  let sentInitialMediaState = false;

  let isScreenShareSupported = typeof navigator !== 'undefined' && 
                               navigator.mediaDevices && 
                               typeof navigator.mediaDevices.getDisplayMedia === 'function';

  let callWindowSize = 'normal'; // 'normal' | 'large' | 'fullscreen'
  let position = { x: 0, y: 0 };
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let initialPosition = { x: 0, y: 0 };

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button') || e.target.closest('video')) return;
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    initialPosition = { ...position };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function handleMouseMove(e) {
    if (!isDragging) return;
    position = {
      x: initialPosition.x + (e.clientX - dragStart.x),
      y: initialPosition.y + (e.clientY - dragStart.y)
    };
  }

  function handleMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }

  function handleTouchStart(e) {
    if (e.target.closest('button') || e.target.closest('video')) return;
    isDragging = true;
    const touch = e.touches[0];
    dragStart = { x: touch.clientX, y: touch.clientY };
    initialPosition = { ...position };
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
  }

  function handleTouchMove(e) {
    if (!isDragging) return;
    e.preventDefault(); // Prevent body scroll while dragging
    const touch = e.touches[0];
    position = {
      x: initialPosition.x + (touch.clientX - dragStart.x),
      y: initialPosition.y + (touch.clientY - dragStart.y)
    };
  }

  function handleTouchEnd() {
    isDragging = false;
    window.removeEventListener('touchmove', handleTouchMove);
    window.removeEventListener('touchend', handleTouchEnd);
  }

  function sendMediaState() {
    if ($activeCall && $activePeer) {
      wsSend({
        type: 'webrtc_media_state',
        recipientId: $activePeer.id,
        micMuted,
        cameraOff
      });
    }
  }

  $: if (isCallActive && $activeCall && $activeCall.status === 'ongoing' && !sentInitialMediaState) {
    sentInitialMediaState = true;
    sendMediaState();
  }

  function toggleMic() {
    micMuted = !micMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !micMuted);
    }
    sendMediaState();
  }

  function toggleCamera() {
    cameraOff = !cameraOff;
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = !cameraOff);
    }
    sendMediaState();
  }

  let localVideo;
  let remoteVideo;
  $: if (localVideo && localStream) {
    const targetSrc = isScreenSharing && screenStream ? screenStream : localStream;
    if (localVideo.srcObject !== targetSrc) localVideo.srcObject = targetSrc;
  }
  $: if (remoteVideo && remoteStream) {
    if (remoteVideo.srcObject !== remoteStream) remoteVideo.srcObject = remoteStream;
  }

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

  let burnOnReadActive = false;

  // Try to restore IndexedDB backup on login/load
  $: if ($currentUser && $localBackupEnabled && $localBackupPassphrase && !$messagesByPeer.has($activePeer?.id)) {
    restoreBackup().catch(err => {
      console.error('Failed to decrypt and restore local backup:', err);
    });
  }

  // Track when new messages arrive → trigger scroll
  $: if (peerMessages.length > lastMessageCount) {
    const lastMsg = peerMessages[peerMessages.length - 1];
    const isOwn = lastMsg?.senderId === $currentUser?.id;
    if (isOwn || !isScrolledUp) {
      shouldAutoScroll = true;
    } else {
      shouldAutoScroll = false;
      hasNewUnreadInScroll = true;
    }
    lastMessageCount = peerMessages.length;
  }

  // Auto-scroll only when new messages arrive, not on every reactive update
  afterUpdate(() => {
    if (shouldAutoScroll && messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      loading = false;
      loadInProgress = false;
    }
  }

  async function loadMessagesData() {
    const data = await fetchMessages($activePeer.id);
    hasMore = data.hasMore;
    if (data.messages && data.messages.length > 0) {
      // Use batch add — single re-render instead of N
      addMessages($activePeer.id, data.messages.map(msg => ({
        id: msg.id,
        senderId: msg.sender_id,
        text: msg.ciphertext,
        encrypted: true,
        iv: msg.iv,
        ephemeralKey: msg.ephemeral_key,
        messageNumber: msg.message_number,
        previousChain: msg.previous_chain,
        sentAt: msg.sent_at,
        expiresAt: msg.expires_at,
      })));
    }
    return data;
  }

  async function getOrCreateRatchetForUser(userId, username) {
    const sessions = get(ratchetSessions);

    if (sessions.has(userId)) {
      return { ratchet: sessions.get(userId), isNew: false };
    }

    const _ikp = get(identityKeyPair);
    if (!_ikp) {
      throw new Error('No identity key pair available');
    }

    const bundle = await fetchKeyBundle(username);
    const { sharedSecret, ephemeralKeyPair, ephemeralPublicKey } = await x3dhInitiate(_ikp, bundle);
    const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

    const ratchet = new RatchetSession();
    await ratchet.initAsSender(rootKey, chainKey, bundle.signedPrekey, bundle.identityKey);

    ratchetSessions.update(map => {
      map.set(userId, ratchet);
      return new Map(map);
    });

    const ecdhPub = await exportPublicKeyBase64(_ikp.ecdh.publicKey);
    const ecdsaPub = await exportPublicKeyBase64(_ikp.ecdsa.publicKey);
    const ownIdentityPub = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));

    return {
      ratchet,
      isNew: true,
      x3dhParams: {
        ik: ownIdentityPub,
        ek: ephemeralPublicKey,
        opk: bundle.oneTimePrekey
      }
    };
  }

  async function encryptSignalingPayload(peerId, payloadObj) {
    const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser(peerId, callingPeer || $activePeer?.username);
    const textToEncrypt = JSON.stringify(payloadObj);
    const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(textToEncrypt);

    const packagedCiphertext = btoa(JSON.stringify({
      bob: { ct: ciphertext, iv: iv }
    }));

    const packagedEphemeralHeader = JSON.stringify(isNew ? {
      type: 'x3dh',
      ik: x3dhParams.ik,
      ek: x3dhParams.ek,
      opk: x3dhParams.opk,
      rk: header.publicKey
    } : {
      type: 'ratchet',
      rk: header.publicKey
    });

    return {
      ciphertext: packagedCiphertext,
      ephemeralKey: packagedEphemeralHeader,
      messageNumber: header.messageNumber,
      previousChain: header.previousChainLength,
      iv: iv
    };
  }

  async function encryptStaticSignalingPayload(payloadObj) {
    if (!currentCallKey) throw new Error('No call session key active');
    const plaintext = JSON.stringify(payloadObj);
    const { iv, ciphertext } = await encryptSelf(currentCallKey, plaintext);
    return { iv, ciphertext };
  }

  async function decryptStaticSignalingPayload(data) {
    if (!currentCallKey) throw new Error('No call session key active');
    const plaintext = await decryptSelf(currentCallKey, data.iv, data.ciphertext);
    return JSON.parse(plaintext);
  }

  async function decryptSignalingPayload(senderId, data) {
    if (!data.ciphertext) {
      // Compatibility fallback
      return data;
    }

    try {
      const ephData = JSON.parse(data.ephemeralKey);
      let sessions = get(ratchetSessions);
      let ratchet = sessions.get(senderId);

      // Protocol Healing: If the incoming message is an X3DH initiation,
      // we must discard any existing session for the sender to establish a fresh one.
      if (ephData.type === 'x3dh') {
        if (ratchet) {
          ratchet = null;
          ratchetSessions.update(map => {
            map.delete(senderId);
            return new Map(map);
          });
        }
      }

      if (!ratchet) {
        const ikp = get(identityKeyPair);
        const spk = get(signedPrekeyPair);
        const otps = get(oneTimePrekeyPairs);

        if (!ikp || !spk) {
          throw new Error('Identity or signed prekey not loaded');
        }

        let otpPair = null;
        if (ephData.opk) {
          const found = otps.find(kp => kp.pubKeyBase64 === ephData.opk);
          if (found) {
            otpPair = found.keyPair;
          }
        }

        const { sharedSecret } = await x3dhRespond(
          ikp,
          spk,
          otpPair,
          ephData.ik,
          ephData.ek
        );

        const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

        const newRatchet = new RatchetSession();
        await newRatchet.initAsReceiver(rootKey, chainKey, spk, ephData.ik);

        ratchetSessions.update(map => {
          map.set(senderId, newRatchet);
          return new Map(map);
        });

        ratchet = newRatchet;
      }

      const jsonStr = atob(data.ciphertext);
      const parsed = JSON.parse(jsonStr);

      const header = {
        publicKey: ephData.rk,
        messageNumber: data.messageNumber,
        previousChainLength: data.previousChain,
      };

      const plaintext = await ratchet.ratchetDecrypt(header, parsed.bob.iv, parsed.bob.ct);
      return JSON.parse(plaintext);
    } catch (err) {
      console.error('Failed to decrypt E2EE signaling payload:', err);
      return null;
    }
  }

  async function encryptAndSend(text, isAttachment = false) {
    const tempId = `temp-${randomHex(8)}`;

    let attachmentId = null;
    if (isAttachment) {
      try {
        const parsed = JSON.parse(text);
        attachmentId = parsed.id;
      } catch (err) {}
    }

    addOptimisticMessage($activePeer.id, {
      id: tempId,
      senderId: $currentUser.id,
      text: text,
      encrypted: false,
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
    });

    if ($activePeer.isGroup) {
      // 1. Get or create our own Sender Key for this group
      const mySessionKey = `${$activePeer.id}:${$currentUser.id}`;
      let mySession = $groupSenderKeys.get(mySessionKey);
      let isNewSessionKey = false;
      if (!mySession) {
        mySession = new SenderKeySession($currentUser.id, $activePeer.id);
        await mySession.initSelf();
        groupSenderKeys.update(m => { m.set(mySessionKey, mySession); return m; });
        isNewSessionKey = true;
      }

      const otherMembers = $activePeer.members.filter(m => m.id !== $currentUser.id);

      // 2. If it is a new session key, distribute it to all group members pairwise
      if (isNewSessionKey) {
        const pack = await mySession.exportDistributionPackage();
        const distributionPayload = JSON.stringify({
          type: 'senderkey_distribution',
          groupId: $activePeer.id,
          pack
        });

        await Promise.all(otherMembers.map(async (member) => {
          try {
            const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser(member.id, member.username);
            const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(distributionPayload);

            let selfCiphertext = null;
            let selfIv = null;
            const _hk = get(historyKey);
            if (_hk) {
              const encSelf = await encryptSelf(_hk, distributionPayload);
              selfCiphertext = encSelf.ciphertext;
              selfIv = encSelf.iv;
            }

            const packagedCiphertext = btoa(JSON.stringify({
              bob: { ct: ciphertext, iv: iv },
              self: { ct: selfCiphertext, iv: selfIv }
            }));

            const packagedEphemeralHeader = JSON.stringify(isNew ? {
              type: 'x3dh',
              ik: x3dhParams.ik,
              ek: x3dhParams.ek,
              opk: x3dhParams.opk,
              rk: header.publicKey
            } : {
              type: 'ratchet',
              rk: header.publicKey
            });

            await sendMessage({
              recipientId: member.id,
              ciphertext: packagedCiphertext,
              ephemeralKey: packagedEphemeralHeader,
              messageNumber: header.messageNumber,
              previousChain: header.previousChainLength,
              ttlMinutes,
              iv: iv,
              groupId: $activePeer.id.replace('group-', '')
            });
          } catch (e) {
            console.error(`Failed to distribute group Sender Key to ${member.username}:`, e);
          }
        }));
      }

      // 3. Encrypt the group message payload ONCE using the Sender Key
      const packet = await mySession.encrypt(text);

      let selfCiphertext = null;
      let selfIv = null;
      const _hk = get(historyKey);
      if (_hk) {
        const encSelf = await encryptSelf(_hk, text);
        selfCiphertext = encSelf.ciphertext;
        selfIv = encSelf.iv;
      }

      const packagedCiphertext = btoa(JSON.stringify({
        bob: {
          ct: packet.ciphertext,
          iv: packet.iv,
          senderKey: {
            messageNumber: packet.messageNumber,
            signature: packet.signature,
            groupId: packet.groupId,
            senderId: packet.senderId
          }
        },
        self: { ct: selfCiphertext, iv: selfIv }
      }));

      // 4. Dispatch the encrypted ciphertext to all group members
      const sendPromises = otherMembers.map(async (member) => {
        try {
          return await sendMessage({
            recipientId: member.id,
            ciphertext: packagedCiphertext,
            ephemeralKey: JSON.stringify({ type: 'senderkey' }),
            messageNumber: packet.messageNumber,
            previousChain: 0,
            ttlMinutes,
            iv: packet.iv,
            groupId: $activePeer.id.replace('group-', ''),
            attachmentId
          });
        } catch (e) {
          console.error(`Failed to send SenderKey group message to ${member.username}:`, e);
        }
      });

      const results = await Promise.all(sendPromises);
      const successResult = results.find(r => r !== undefined);

      if (!successResult) {
        throw new Error('Failed to send group message.');
      }

      await syncCloudVault();

      confirmMessage($activePeer.id, tempId, {
        id: successResult.id,
        sentAt: successResult.sentAt,
        expiresAt: successResult.expiresAt,
        delivered: true
      });

      conversations.update(convs => {
        const existing = convs.find(c => c.peerId === $activePeer.id);
        if (existing) {
          existing.lastMessageAt = successResult.sentAt;
          const idx = convs.indexOf(existing);
          if (idx > 0) {
            convs.splice(idx, 1);
            convs.unshift(existing);
          }
        }
        return [...convs];
      });

    } else {
      const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser($activePeer.id, $activePeer.username);
      const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(text);

      let selfCiphertext = null;
      let selfIv = null;
      const _hk = get(historyKey);
      if (_hk) {
        const encSelf = await encryptSelf(_hk, text);
        selfCiphertext = encSelf.ciphertext;
        selfIv = encSelf.iv;
      }

      const packagedCiphertext = btoa(JSON.stringify({
        bob: { ct: ciphertext, iv: iv },
        self: { ct: selfCiphertext, iv: selfIv }
      }));

      const packagedEphemeralHeader = JSON.stringify(isNew ? {
        type: 'x3dh',
        ik: x3dhParams.ik,
        ek: x3dhParams.ek,
        opk: x3dhParams.opk,
        rk: header.publicKey
      } : {
        type: 'ratchet',
        rk: header.publicKey
      });

      const result = await sendMessage({
        recipientId: $activePeer.id,
        ciphertext: packagedCiphertext,
        ephemeralKey: packagedEphemeralHeader,
        messageNumber: header.messageNumber,
        previousChain: header.previousChainLength,
        ttlMinutes,
        iv: iv,
        attachmentId
      });

      await syncCloudVault();

      confirmMessage($activePeer.id, tempId, {
        id: result.id,
        sentAt: result.sentAt,
        expiresAt: result.expiresAt,
        delivered: result.delivered
      });

      conversations.update(convs => {
        const existing = convs.find(c => c.peerId === $activePeer.id);
        if (existing) {
          existing.lastMessageAt = result.sentAt;
          const idx = convs.indexOf(existing);
          if (idx > 0) {
            convs.splice(idx, 1);
            convs.unshift(existing);
          }
        }
        return [...convs];
      });
    }
  }

  async function handleSend() {
    if (!messageText.trim() || sendingMessage) return;

    const text = messageText.trim();
    messageText = '';
    sendingMessage = true;

    try {
      await encryptAndSend(text);
    } catch (err) {
      console.error('Failed to send message:', err);
      alert('Failed to send message');
    } finally {
      sendingMessage = false;
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput() {
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
      const data = await fetchMessages($activePeer.id, 50, oldestMsg.sentAt);
      if (data.messages && data.messages.length > 0) {
        const oldScrollHeight = messagesContainer.scrollHeight;
        const oldScrollTop = messagesContainer.scrollTop;
        
        addMessages($activePeer.id, data.messages.map(msg => ({
          id: msg.id,
          senderId: msg.sender_id,
          text: msg.ciphertext,
          encrypted: true,
          iv: msg.iv,
          ephemeralKey: msg.ephemeral_key,
          messageNumber: msg.message_number,
          previousChain: msg.previous_chain,
          sentAt: msg.sent_at,
          expiresAt: msg.expires_at,
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
    });
  }

  let showSafetyNumberModal = false;
  let safetyNumber = '';

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
  let sendingFile = false;

  function stripJpegExif(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) {
      return arrayBuffer; // Not a JPEG
    }
    
    let offset = 2;
    const length = view.byteLength;
    const newSegments = [new Uint8Array(arrayBuffer.slice(0, 2))]; // Start with SOI (FFD8)
    
    while (offset < length) {
      if (offset + 2 > length) break;
      const marker = view.getUint16(offset);
      
      if ((marker & 0xFF00) === 0xFF00) {
        if (marker === 0xFFD9) {
          // EOI (End of Image)
          newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
          break;
        }
        
        if (offset + 4 > length) {
          newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
          break;
        }
        const segmentLength = view.getUint16(offset + 2) + 2;
        if (offset + segmentLength > length) {
          newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
          break;
        }
        
        // If it is APP1 (EXIF / Metadata / GPS) marker FFE1, skip it!
        if (marker === 0xFFE1) {
          // Skip segment
        } else {
          // Keep segment
          newSegments.push(new Uint8Array(arrayBuffer.slice(offset, offset + segmentLength)));
        }
        offset += segmentLength;
      } else {
        // SOS or entropy-coded data, runs to the end
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
    }
    
    const totalLength = newSegments.reduce((sum, seg) => sum + seg.length, 0);
    const cleanBuffer = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const seg of newSegments) {
      cleanBuffer.set(seg, writeOffset);
      writeOffset += seg.length;
    }
    return cleanBuffer.buffer;
  }

  function stripPngMetadata(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
      return arrayBuffer; // Not a PNG
    }
    
    let offset = 8;
    const length = view.byteLength;
    const newSegments = [new Uint8Array(arrayBuffer.slice(0, 8))]; // PNG Signature
    
    while (offset < length) {
      if (offset + 12 > length) {
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
      const chunkLength = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      
      const fullChunkLength = 12 + chunkLength;
      if (offset + fullChunkLength > length) {
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
      
      // List of metadata chunk types to skip
      const metadataChunks = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dIHg'];
      
      if (metadataChunks.includes(chunkType)) {
        // Skip metadata chunk
      } else {
        // Keep chunk
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset, offset + fullChunkLength)));
      }
      
      offset += fullChunkLength;
    }
    
    const totalLength = newSegments.reduce((sum, seg) => sum + seg.length, 0);
    const cleanBuffer = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const seg of newSegments) {
      cleanBuffer.set(seg, writeOffset);
      writeOffset += seg.length;
    }
    return cleanBuffer.buffer;
  }

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file || !$activePeer) return;

    // Support uploads up to 10MB!
    if (file.size > 10 * 1024 * 1024) {
      alert('Attachment size exceeds 10MB limit');
      return;
    }

    sendingFile = true;
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
      }

      // 6. Send E2EE attachment metadata message
      const attachmentPayload = JSON.stringify({
        type: 'attachment',
        id: attachmentId,
        key: keyBase64,
        iv: ivBase64,
        filename: file.name,
        mimeType: file.type,
        chunked: true,
        totalChunks: totalChunks
      });

      await encryptAndSend(attachmentPayload, true);
    } catch (err) {
      console.error('Failed to send E2E attachment:', err);
      alert('Failed to send E2E attachment');
    } finally {
      sendingFile = false;
      if (fileInput) fileInput.value = '';
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
      alert('Could not access microphone');
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

      const attachmentPayload = JSON.stringify({
        type: 'attachment',
        id: uploadRes.id,
        key: keyBase64,
        iv: ivBase64,
        filename: 'voicenote.webm',
        mimeType: 'audio/webm'
      });

      await encryptAndSend(attachmentPayload, true);
    } catch (err) {
      console.error('Failed to send E2EE voice note:', err);
      alert('Failed to send voice note');
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

    // Generate static call key
    const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const staticCallKeyBase64 = toBase64(rawKeyBytes);
    currentCallKey = await importStaticKey(rawKeyBytes);

    const callId = crypto.randomUUID();
    
    // Set activeCall first to prevent reactive resetCallState from clearing localStream!
    activeCall.set({
      id: callId,
      status: 'ringing',
      peerId: $activePeer.id,
      peerUsername: $activePeer.username,
      type: type,
      direction: 'outgoing',
      currentCallKey: currentCallKey
    });

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    const videoConstraints = type === 'video' ? {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 60 },
      facingMode: "user"
    } : false;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints
      });
      localStreamPromise = Promise.resolve(localStream);
      if (localVideo) localVideo.srcObject = localStream;
    } catch (err) {
      console.error('Failed to get media devices:', err);
      alert('Could not access microphone/camera');
      activeCall.set(null);
      currentCallKey = null;
      return;
    }

    try {
      // Encrypt static key using Double Ratchet E2EE
      const encryptedKey = await encryptSignalingPayload($activePeer.id, { key: staticCallKeyBase64 });

      recentCalls.update(calls => [
        {
          id: callId,
          peerId: $activePeer.id,
          peerUsername: $activePeer.username,
          type: type,
          direction: 'outgoing',
          status: 'ringing',
          timestamp: new Date().toISOString()
        },
        ...calls
      ]);

      wsSend({
        type: 'call_invite',
        recipientId: $activePeer.id,
        callType: type,
        senderUsername: $currentUser.username,
        encryptedKey
      });
    } catch (err) {
      console.error('Failed to complete call initialization:', err);
      alert('Failed to establish encrypted call session.');
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
      activeCall.set(null);
      currentCallKey = null;
    }
  }

  function initializePeerConnection(peerId) {
    if (peerConnectionPromise) return peerConnectionPromise;

    peerConnectionPromise = (async () => {
      let iceServers = [
        { urls: 'stun:stun.l.google.com:19302' }
      ];

      try {
        const data = await fetchTurnCredentials();
        if (data && data.iceServers) {
          iceServers = data.iceServers;
        }
      } catch (e) {
        console.warn('Failed to fetch ephemeral TURN credentials, falling back to public STUN:', e);
        sendClientDebugLog('fetchTurnCredentials failed', e);
      }

      try {
        peerConnection = new RTCPeerConnection({ iceServers });
      } catch (e) {
        sendClientDebugLog('RTCPeerConnection instantiation failed', e);
        throw e;
      }

      if (localStream) {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      }

      peerConnection.ontrack = (event) => {
        remoteStream = event.streams[0];
        if (callType === 'video') {
          if (remoteVideo) remoteVideo.srcObject = remoteStream;
        } else {
          // Reuse or create a single audio element
          if (!remoteAudioElement) {
            remoteAudioElement = new Audio();
          }
          remoteAudioElement.srcObject = remoteStream;
          remoteAudioElement.play().catch(e => console.error("Failed to autoplay remote audio:", e));
        }
      };

      // ICE connection state monitoring for auto-reconnection
      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection?.iceConnectionState;
        if (state === 'failed') {
          // Attempt ICE restart
          peerConnection.restartIce();
        } else if (state === 'disconnected') {
          // Give 5 seconds before considering it dead
          setTimeout(() => {
            if (peerConnection?.iceConnectionState === 'disconnected') {
              peerConnection.restartIce();
            }
          }, 5000);
        }
      };

      peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
          try {
            const encrypted = await encryptStaticSignalingPayload(event.candidate);
            wsSend({
              type: 'webrtc_ice',
              recipientId: peerId,
              ...encrypted
            });
          } catch (e) {
            console.error('Failed to encrypt ICE candidate:', e);
            sendClientDebugLog('Failed to encrypt ICE candidate', e);
          }
        }
      };
    })();

    return peerConnectionPromise;
  }

  async function startOfferNegotiation(peerId) {
    try {
      await initializePeerConnection(peerId);
      if (!localStream) {
        throw new Error('localStream is null inside startOfferNegotiation');
      }
      if (!peerConnection) {
        throw new Error('peerConnection is null inside startOfferNegotiation');
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      
      const encrypted = await encryptStaticSignalingPayload(offer);
      wsSend({
        type: 'webrtc_sdp',
        recipientId: peerId,
        ...encrypted
      });
    } catch (err) {
      console.error('Failed to create offer:', err);
      sendClientDebugLog('startOfferNegotiation failed error caught', err, { peerId });
    }
  }

  async function acquireMediaForIncomingCall() {
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    const videoConstraints = callType === 'video' ? {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 60 },
      facingMode: "user"
    } : false;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints
      });
      if (localVideo) localVideo.srcObject = localStream;
      if (peerConnection) {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      }
      return localStream;
    } catch (err) {
      console.error('Failed to get media devices for incoming call:', err);
      alert('Could not access microphone/camera');
      hangupCall();
      throw err;
    }
  }

  async function ensureLocalStream() {
    if (localStreamPromise) {
      await localStreamPromise;
    }
  }

  async function processQueuedIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    const candidates = [...iceCandidatesQueue];
    iceCandidatesQueue = [];
    for (const candidate of candidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Failed to add queued ICE candidate:', err);
      }
    }
  }

  function hangupCall() {
    if ($activePeer) {
      wsSend({ type: 'call_hangup', recipientId: $activePeer.id });
    }
    activeCall.set(null);
    resetCallState();
  }

  async function toggleScreenShare() {
    if (isScreenSharing) {
      await stopScreenShare();
    } else {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: "always"
          },
          audio: false
        });
        isScreenSharing = true;

        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack) {
          // Listen to when screensharing is stopped via browser UI (e.g. "Stop sharing" button)
          screenTrack.onended = () => {
            stopScreenShare();
          };
        }

        if (peerConnection) {
          const senders = peerConnection.getSenders();
          const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(screenTrack);
          }
        }

        if (localVideo) {
          localVideo.srcObject = screenStream;
        }
      } catch (err) {
        console.error("Failed to start screen share:", err);
      }
    }
  }

  async function stopScreenShare() {
    if (!isScreenSharing) return;
    isScreenSharing = false;
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
    
    // Restore camera track
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !cameraOff;
        if (peerConnection) {
          const senders = peerConnection.getSenders();
          const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(videoTrack);
          }
        }
      }
    }

    if (localVideo && localStream) {
      localVideo.srcObject = localStream;
    }
  }

  function resetCallState() {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
    isScreenSharing = false;
    remoteMicMuted = false;
    remoteCameraOff = false;
    sentInitialMediaState = false;
    position = { x: 0, y: 0 };
    callWindowSize = 'normal';

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (remoteAudioElement) {
      try {
        remoteAudioElement.pause();
        remoteAudioElement.srcObject = null;
      } catch (e) {}
      remoteAudioElement = null;
    }
    remoteStream = null;
    micMuted = false;
    cameraOff = false;
    currentCallKey = null;
    initializingPeerConnection = false;
    peerConnectionPromise = null;
    localStreamPromise = null;
    iceCandidatesQueue = [];
  }

  onMount(() => {
    wsUnsubscribes.push(onWsEvent('session_collision', () => {
      hasCollision = true;
    }));

    wsUnsubscribes.push(onWsEvent('webrtc_sdp', async (data) => {
      try {
        const decryptedSdp = await decryptStaticSignalingPayload(data);
        if (!decryptedSdp) return;

        await initializePeerConnection(data.senderId);
        if (!peerConnection) return;

        await peerConnection.setRemoteDescription(new RTCSessionDescription(decryptedSdp));
        await processQueuedIceCandidates();

        if (decryptedSdp.type === 'offer') {
          await ensureLocalStream();
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          const encrypted = await encryptStaticSignalingPayload(answer);
          wsSend({
            type: 'webrtc_sdp',
            recipientId: data.senderId,
            ...encrypted
          });
        }
      } catch (err) {
        console.error('Failed to process incoming SDP:', err);
      }
    }));

    wsUnsubscribes.push(onWsEvent('webrtc_ice', async (data) => {
      try {
        const decryptedCandidate = await decryptStaticSignalingPayload(data);
        if (!decryptedCandidate) return;

        await initializePeerConnection(data.senderId);
        if (!peerConnection) return;

        if (peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(decryptedCandidate));
        } else {
          iceCandidatesQueue.push(decryptedCandidate);
        }
      } catch (err) {
        console.error('Failed to process incoming ICE candidate:', err);
      }
    }));

    wsUnsubscribes.push(onWsEvent('webrtc_media_state', (data) => {
      if (data.senderId === $activePeer?.id) {
        remoteMicMuted = data.micMuted;
        remoteCameraOff = data.cameraOff;
      }
    }));

    prekeyRotationTimer = setInterval(() => {
      rotateSignedPrekey();
    }, 24 * 60 * 60 * 1000);
  });

  onDestroy(() => {
    if (prekeyRotationTimer) clearInterval(prekeyRotationTimer);
    wsUnsubscribes.forEach(unsub => unsub());
    resetCallState();
  });

  function goBack() {
    activePeer.set(null);
    sidebarOpen.set(true);
  }
</script>

<div class="flex-1 flex flex-col bg-vault-black h-full animate-fade-in relative">
  <!-- Chat Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-vault-border glass-strong">
    <div class="flex items-center gap-3">
      <!-- Back button (mobile) -->
      <button
        on:click={goBack}
        class="md:hidden p-1.5 rounded-lg text-vault-text-dim hover:text-vault-text hover:bg-vault-elevated transition-all"
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
      <div>
        <div class="flex items-center gap-1.5">
          <div class="text-sm font-semibold text-vault-text">{$activePeer?.username || 'Unknown'}</div>
          {#if savedIdentityKey && savedIdentityKey === currentRatchet?.peerIdentityKey}
            <svg class="w-3.5 h-3.5 text-vault-accent" viewBox="0 0 24 24" fill="currentColor" title="Verified Identity">
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
          {/if}
        </div>
        {#if !$activePeer.isGroup}
          <button
            on:click={() => { if (!isTyping) showSafetyNumberModal = true; }}
            class="text-[10px] text-vault-text-dim flex items-center gap-1 hover:text-vault-accent transition-colors cursor-pointer text-left focus:outline-none"
            title="Click to verify fingerprint"
            disabled={isTyping}
          >
            <svg class="w-3 h-3 text-vault-text-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Fingerprint safety numbers
          </button>
        {:else}
          <button
            on:click={() => showMembersModal = true}
            class="text-[10px] text-vault-text-dim flex items-center gap-1 hover:text-vault-accent transition-colors cursor-pointer text-left focus:outline-none"
            title="Click to view group members"
          >
            <svg class="w-3 h-3 text-vault-text-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            {$activePeer.members?.length || 0} members
          </button>
        {/if}
      </div>
    </div>

    <!-- Header Actions -->
    <div class="flex items-center gap-1">
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

      {#if !$activePeer.isGroup}
        <button
          on:click={() => startCall('audio')}
          class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
          title="Start E2EE Audio Call"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </button>

        <button
          on:click={() => startCall('video')}
          class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
          title="Start E2EE Video Call"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </button>

        <div class="relative group">
          <div class="p-1 text-[10px] text-vault-warning bg-vault-warning/10 border border-vault-warning/20 rounded-md cursor-help font-semibold">
            ⚠️ P2P Call
          </div>
          <div class="absolute right-0 top-7 hidden group-hover:block z-50 w-48 p-2.5 bg-vault-surface border border-vault-border rounded-xl text-[9px] text-vault-text-dim leading-relaxed shadow-xl text-left">
            🔒 Calls are E2EE but establish direct P2P connections, which may expose your IP address. Route calls through a TURN proxy for full anonymity.
          </div>
        </div>
      {/if}
    </div>
  </div>

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
  <div
    bind:this={messagesContainer}
    on:scroll={handleScroll}
    class="flex-1 overflow-y-auto px-4 py-4 space-y-1 relative"
  >
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
      <div class="flex flex-col items-center justify-center h-full text-center py-16">
        <div class="w-16 h-16 rounded-2xl bg-vault-elevated border border-vault-border flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            <path d="M9.5 12l2 2 3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <p class="text-sm text-vault-text-secondary mb-1">Start a secure conversation</p>
        <p class="text-xs text-vault-text-dim max-w-[240px]">
          All messages are encrypted and ephemeral. Your chat history will vanish if you close the application.
        </p>
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
        <MessageBubble
          message={msg}
          isOwn={msg.senderId === $currentUser?.id}
          showAvatar={i === 0 || peerMessages[i - 1]?.senderId !== msg.senderId}
          searchQuery={searchQuery}
        />
      {/each}
    {/if}

    <!-- Video Call Grid -->
    {#if isCallActive && callType === 'video'}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        role="region"
        aria-label="Video Call Panel"
        on:mousedown={handleMouseDown}
        on:touchstart={handleTouchStart}
        style={callWindowSize !== 'fullscreen' ? `transform: translate(${position.x}px, ${position.y}px); cursor: ${isDragging ? 'grabbing' : 'grab'};` : ''}
        class={callWindowSize === 'fullscreen'
          ? "fixed inset-0 z-40 bg-vault-black flex flex-col justify-between overflow-hidden"
          : "absolute top-4 right-4 z-30 flex flex-col gap-2 p-2.5 bg-vault-surface/95 backdrop-blur-md border border-vault-border rounded-2xl shadow-xl transition-all duration-200 select-none " + (callWindowSize === 'large' ? 'w-[308px]' : 'w-48')}
      >
        <!-- Conditionally render top-bar for non-fullscreen -->
        {#if callWindowSize !== 'fullscreen'}
          <div class="flex items-center justify-between w-full pb-1 border-b border-vault-border-subtle cursor-grab active:cursor-grabbing select-none z-10">
            <div class="flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-vault-accent animate-pulse"></span>
              <span class="text-[9px] text-vault-text-dim font-semibold uppercase tracking-wider">Call</span>
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
          <!-- Top bar overlay when fullscreen -->
          <div class="absolute top-6 left-6 z-20 flex items-center gap-2 bg-vault-surface/80 backdrop-blur-md border border-vault-border px-3.5 py-1.5 rounded-xl shadow-xl select-none">
            <span class="w-2 h-2 rounded-full bg-vault-accent animate-pulse"></span>
            <span class="text-xs text-vault-text font-semibold">E2EE Call: {callingPeer}</span>
            <div class="w-px h-4 bg-vault-border mx-1"></div>
            <button
              on:click={() => callWindowSize = 'normal'}
              class="p-1 rounded-lg hover:bg-vault-elevated text-vault-text-dim hover:text-vault-text transition-all focus:outline-none cursor-pointer flex items-center gap-1 text-[10px]"
              title="Exit Fullscreen"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
              </svg>
              Exit Fullscreen
            </button>
          </div>
        {/if}

        <!-- Local Video Container -->
        <div 
          class={callWindowSize === 'fullscreen' 
            ? "absolute top-6 right-6 w-48 h-36 z-10 bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-xl animate-fade-in" 
            : `relative ${callWindowSize === 'large' ? 'w-[288px] h-[216px]' : 'w-44 h-32'} bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-inner animate-fade-in`}
        >
          <video bind:this={localVideo} autoplay playsinline muted class="w-full h-full object-cover {isScreenSharing ? '' : 'scale-x-[-1]'}"></video>
          <span class="absolute bottom-1.5 left-2 text-[8px] bg-vault-black/60 px-1.5 py-0.5 rounded text-vault-text font-medium uppercase tracking-wider">Self</span>
        </div>

        <!-- Remote Video Container -->
        <div 
          class={callWindowSize === 'fullscreen' 
            ? "absolute inset-0 w-full h-full z-0 bg-vault-black flex items-center justify-center" 
            : `relative ${callWindowSize === 'large' ? 'w-[288px] h-[216px]' : 'w-44 h-32'} bg-vault-black border border-vault-border rounded-xl overflow-hidden shadow-inner flex items-center justify-center animate-fade-in`}
        >
          <video bind:this={remoteVideo} autoplay playsinline class="w-full h-full object-cover {remoteCameraOff ? 'hidden' : ''}"></video>
          {#if remoteCameraOff}
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
          {#if remoteMicMuted}
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
          class={callWindowSize === 'fullscreen' 
            ? "absolute bottom-8 left-1/2 -translate-x-1/2 z-10 flex flex-col gap-2.5 p-3 bg-vault-surface/85 backdrop-blur-md border border-vault-border rounded-2xl shadow-2xl w-60" 
            : "flex flex-col gap-2 w-full z-10"}
        >
          <div class="flex gap-2 w-full">
            <button
              on:click={toggleMic}
              class="flex-1 py-1.5 rounded-xl border text-xs transition-all flex items-center justify-center gap-1.5 focus:outline-none cursor-pointer
                {micMuted ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
              title={micMuted ? "Unmute Mic" : "Mute Mic"}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                {#if micMuted}
                  <line x1="1" y1="1" x2="23" y2="23" />
                {/if}
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
              </svg>
            </button>
            <button
              on:click={toggleCamera}
              class="flex-1 py-1.5 rounded-xl border text-xs transition-all flex items-center justify-center gap-1.5 focus:outline-none cursor-pointer
                {cameraOff ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
              title={cameraOff ? "Turn Video On" : "Turn Video Off"}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                {#if cameraOff}
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
                {!isScreenSharing && $activeCall?.status !== 'ringing' && isScreenShareSupported ? 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text' : ''}
                {isScreenSharing ? 'bg-vault-accent/20 text-vault-accent border-vault-accent/30' : ''}"
              title={!isScreenShareSupported ? "Screen sharing not supported on this device" : ($activeCall?.status === 'ringing' ? "Waiting for call to connect..." : (isScreenSharing ? "Stop Sharing Screen" : "Share Screen"))}
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
        </div>
      </div>
    {:else if isCallActive && callType === 'audio'}
      <!-- Audio Call Panel -->
      <div class="absolute top-4 right-4 z-30 flex items-center gap-3 p-3 bg-vault-surface border border-vault-border rounded-2xl shadow-xl animate-scale-up">
        <div class="flex items-center gap-2">
          <div class="w-2.5 h-2.5 rounded-full bg-vault-accent animate-pulse"></div>
          <span class="text-xs text-vault-text font-medium flex items-center gap-1.5">
            E2EE Audio: {callingPeer}
            {#if remoteMicMuted}
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
        </div>
        <button
          on:click={toggleMic}
          class="p-2 rounded-xl border transition-all focus:outline-none cursor-pointer
            {micMuted ? 'bg-vault-danger/20 text-vault-danger border-vault-danger/30' : 'bg-vault-elevated text-vault-text-dim border-vault-border-subtle hover:text-vault-text'}"
          title={micMuted ? "Unmute Mic" : "Mute Mic"}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            {#if micMuted}
              <line x1="1" y1="1" x2="23" y2="23" />
            {/if}
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
          </svg>
        </button>
        <button
          on:click={hangupCall}
          class="px-3 py-1.5 bg-vault-danger hover:bg-vault-danger-hover text-vault-black font-semibold text-xs rounded-xl transition-all cursor-pointer focus:outline-none"
        >
          Hang Up
        </button>
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
  </div>

  <!-- Message Input -->
  <div class="px-2 md:px-4 py-2 md:py-3 border-t border-vault-border glass-strong">
    <div class="flex items-end gap-1.5 md:gap-2">
      <input
        type="file"
        bind:this={fileInput}
        on:change={handleFileChange}
        class="hidden"
      />

      <button
        on:click={() => fileInput.click()}
        disabled={sendingMessage || sendingFile}
        class="flex-shrink-0 w-9 h-9 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center bg-vault-elevated text-vault-text-dim hover:text-vault-text hover:bg-vault-border transition-all cursor-pointer focus:outline-none"
        title="Share E2EE File"
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
      {:else}
        <div class="flex-1 relative">
          <textarea
            bind:value={messageText}
            on:keydown={handleKeydown}
            on:input={handleInput}
            placeholder="Type a message..."
            rows="1"
            class="input resize-none py-2.5 pr-10 min-h-[40px] max-h-[120px] text-sm bg-vault-elevated border-vault-border-subtle"
            disabled={sendingMessage}
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
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4">
    <div class="glass-strong rounded-2xl p-6 max-w-sm w-full border border-vault-border shadow-2xl animate-fade-in-scale">
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
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4">
    <div class="glass-strong rounded-2xl p-6 max-w-sm w-full border border-vault-border shadow-2xl animate-fade-in-scale text-left">
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
            <div>
              <div class="text-xs font-semibold text-vault-text">{member.username}</div>
              {#if member.id === $currentUser?.id}
                <div class="text-[9px] text-vault-accent">You</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- Group Invite Key Section -->
      <div class="border-t border-vault-border mt-4 pt-4 space-y-2">
        <span class="text-[10px] text-vault-text-dim block uppercase font-bold tracking-wider">Group Join Key</span>
        <div class="flex items-center gap-2 p-2 bg-vault-elevated border border-vault-border rounded-xl">
          <input
            type="text"
            readonly
            value={$activePeer.joinKey || ''}
            class="bg-transparent border-none text-[10px] font-mono text-vault-text focus:outline-none w-full select-all"
          />
          <button
            on:click={() => {
              navigator.clipboard.writeText($activePeer.joinKey || '');
              alert('Group Join Key copied to clipboard!');
            }}
            class="text-[10px] text-vault-accent hover:underline focus:outline-none font-semibold whitespace-nowrap cursor-pointer"
          >
            Copy
          </button>
        </div>
        <p class="text-[9px] text-vault-text-dim leading-relaxed">Share this unique key. Anyone with this key can paste it to join this secure group chat instantly.</p>
      </div>
    </div>
  </div>
{/if}
