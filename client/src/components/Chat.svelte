<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, clearSession, activePeer, sidebarOpen, oneTimePrekeyPairs, activeCall, recentCalls } from '../lib/stores/session.js';
  import { conversations, messagesByPeer, addMessage, addMessages, setTyping, typingUsers, updateMessageDeliveryStatus } from '../lib/stores/messages.js';
  import { fetchConversations, fetchPendingMessages, logout, searchUsers, getPrekeyCount, replenishPrekeys, fetchGroups } from '../lib/api/http.js';
  import { connectWebSocket, disconnectWebSocket, onWsEvent, wsConnected, wsError, wsSend } from '../lib/api/ws.js';
  import { generateOneTimePrekeys, importStaticKey } from '../lib/crypto/keys.js';
  import { decryptSignalingPayload } from '../lib/crypto/decryption.js';
  import { fromBase64 } from '../lib/crypto/utils.js';
  import ChatSidebar from './ChatSidebar.svelte';
  import ChatView from './ChatView.svelte';

  let unsubscribers = [];

  onMount(async () => {
    // 1. Fetch conversations & groups from server
    try {
      const data = await fetchConversations();
      const groups = await fetchGroups();
      const groupConvs = groups.map(g => ({
        peerId: `group-${g.id}`,
        peerUsername: g.name,
        isGroup: true,
        members: g.members,
        joinKey: g.joinKey,
        lastMessageAt: null,
        hasUndelivered: false
      }));
      conversations.set([...groupConvs, ...(data.conversations || [])]);
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    }

    // 2. Connect WebSocket for real-time messaging
    // Cookie-based auth: JWT cookie sent automatically during upgrade
    connectWebSocket();

    // Setup Web Push notifications
    setupPushNotifications();

    // 3. Register WebSocket event handlers
    unsubscribers.push(
      onWsEvent('message', handleIncomingMessage),
      onWsEvent('typing', handleTyping),
      onWsEvent('connected', handleConnected),
      onWsEvent('sent', handleSent),
      onWsEvent('call_invite', handleGlobalCallInvite),
      onWsEvent('call_accept', handleGlobalCallAccept),
      onWsEvent('call_reject', handleGlobalCallReject),
      onWsEvent('call_hangup', handleGlobalCallHangup),
    );
  });

  onDestroy(() => {
    for (const unsub of unsubscribers) unsub();
    disconnectWebSocket();
  });

  function handleSent(data) {
    updateMessageDeliveryStatus(data.recipientId, data.id, data.delivered);
  }

  async function handleConnected() {
    // 1. Check and replenish prekeys if low
    try {
      const { count, low } = await getPrekeyCount();
      if (low) {
        console.log(`[Keys] One-time prekeys are running low (${count}). Replenishing...`);
        const { publicKeys, keyPairs } = await generateOneTimePrekeys(20);
        await replenishPrekeys(publicKeys);
        const newPairsWithPub = keyPairs.map((kp, idx) => ({
          keyPair: kp,
          pubKeyBase64: publicKeys[idx]
        }));
        oneTimePrekeyPairs.update(existing => [...existing, ...newPairsWithPub]);
        console.log('[Keys] One-time prekeys replenished successfully.');
      }
    } catch (err) {
      console.error('Failed to check/replenish prekeys:', err);
    }

    // 2. Fetch any pending messages on reconnect
    try {
      const data = await fetchPendingMessages();
      const msgs = data.messages || [];
      if (msgs.length === 0) return;

      // Group by threadId for batch updates (fewer re-renders)
      const byThread = new Map();
      for (const msg of msgs) {
        const threadId = msg.group_id ? `group-${msg.group_id}` : msg.sender_id;
        if (!byThread.has(threadId)) byThread.set(threadId, []);
        byThread.get(threadId).push({
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
          attachmentId: msg.attachment_id
        });
      }

      for (const [threadId, threadMsgs] of byThread) {
        addMessages(threadId, threadMsgs);
      }
    } catch (err) {
      console.error('Failed to fetch pending:', err);
    }
  }

  function handleIncomingMessage(data) {
    const threadId = data.groupId ? `group-${data.groupId}` : data.senderId;

    addMessage(threadId, {
      id: data.id,
      senderId: data.senderId,
      senderUsername: data.senderUsername,
      text: data.ciphertext,
      encrypted: true,
      iv: data.iv,
      ephemeralKey: data.ephemeralKey,
      messageNumber: data.messageNumber,
      previousChain: data.previousChain,
      sentAt: data.sentAt,
      expiresAt: data.expiresAt,
      groupId: data.groupId
    });

    // Update conversations list (insertion-sort: move to front)
    conversations.update(convs => {
      const isCurrentlyActive = get(activePeer)?.id === threadId;
      const existing = convs.find(c => c.peerId === threadId);
      if (existing) {
        existing.lastMessageAt = data.sentAt;
        existing.hasUndelivered = !isCurrentlyActive;
        if (data.groupMembers) {
          existing.members = data.groupMembers;
          if (isCurrentlyActive) {
            activePeer.update(peer => {
              if (peer) peer.members = data.groupMembers;
              return peer;
            });
          }
        }
        const idx = convs.indexOf(existing);
        if (idx > 0) {
          convs.splice(idx, 1);
          convs.unshift(existing);
        }
      } else {
        convs.unshift({
          peerId: threadId,
          peerUsername: data.groupName || data.senderUsername,
          isGroup: !!data.groupId,
          members: data.groupMembers || [],
          joinKey: data.groupJoinKey,
          lastMessageAt: data.sentAt,
          hasUndelivered: !isCurrentlyActive,
        });
      }
      return [...convs];
    });
  }

  function handleTyping(data) {
    setTyping(data.senderId);
  }

  async function handleGlobalCallInvite(data) {
    const currentCall = get(activeCall);
    if (currentCall) {
      wsSend({ type: 'call_reject', recipientId: data.senderId, reason: 'busy' });
      return;
    }

    const callId = crypto.randomUUID();
    recentCalls.update(calls => [
      {
        id: callId,
        peerId: data.senderId,
        peerUsername: data.senderUsername,
        type: data.callType,
        direction: 'incoming',
        status: 'missed',
        timestamp: new Date().toISOString()
      },
      ...calls
    ]);

    activeCall.set({
      id: callId,
      status: 'incoming',
      peerId: data.senderId,
      peerUsername: data.senderUsername,
      type: data.callType,
      direction: 'incoming',
      encryptedKey: data.encryptedKey
    });
  }

  function handleGlobalCallReject(data) {
    const currentCall = get(activeCall);
    if (currentCall && currentCall.peerId === data.senderId) {
      recentCalls.update(calls => {
        const found = calls.find(c => c.id === currentCall.id);
        if (found) found.status = 'rejected';
        return [...calls];
      });
      activeCall.set(null);
      alert(`${data.senderUsername || 'Peer'} rejected the call: ${data.reason || 'declined'}`);
    }
  }

  function handleGlobalCallAccept(data) {
    const currentCall = get(activeCall);
    if (currentCall && currentCall.peerId === data.senderId && currentCall.direction === 'outgoing') {
      // Callee accepted — transition to ongoing and signal ChatView to start SDP negotiation
      activeCall.set({
        ...currentCall,
        status: 'ongoing',
        peerAccepted: true
      });
    }
  }

  function handleGlobalCallHangup(data) {
    const currentCall = get(activeCall);
    if (currentCall && currentCall.peerId === data.senderId) {
      recentCalls.update(calls => {
        const found = calls.find(c => c.id === currentCall.id);
        if (found && found.status === 'ongoing') found.status = 'completed';
        return [...calls];
      });
      activeCall.set(null);
    }
  }

  async function acceptIncomingCall() {
    const call = get(activeCall);
    if (!call || call.status !== 'incoming') return;

    try {
      const decrypted = await decryptSignalingPayload(call.peerId, call.encryptedKey);
      if (!decrypted || !decrypted.key) {
        throw new Error('Could not decrypt E2EE call key');
      }

      const rawBytes = fromBase64(decrypted.key);
      const importedKey = await importStaticKey(rawBytes);

      activeCall.set({
        ...call,
        status: 'ongoing',
        currentCallKey: importedKey
      });

      recentCalls.update(calls => {
        const found = calls.find(c => c.id === call.id);
        if (found) found.status = 'ongoing';
        return [...calls];
      });

      activePeer.set({
        id: call.peerId,
        username: call.peerUsername,
        isGroup: false
      });

      wsSend({ type: 'call_accept', recipientId: call.peerId });

    } catch (err) {
      console.error('Failed to accept incoming call:', err);
      alert('Encryption negotiation failed. Cannot accept call.');
      declineIncomingCall();
    }
  }

  function declineIncomingCall() {
    const call = get(activeCall);
    if (!call) return;

    wsSend({ type: 'call_reject', recipientId: call.peerId, reason: 'declined' });

    recentCalls.update(calls => {
      const found = calls.find(c => c.id === call.id);
      if (found) found.status = 'rejected';
      return [...calls];
    });

    activeCall.set(null);
  }

  async function setupPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('Web Push is not supported in this browser.');
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const res = await fetch('/api/push/public-key');
      const data = await res.json();
      const vapidPublicKey = data.publicKey;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
      }

      const rawSub = JSON.parse(JSON.stringify(subscription));
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: rawSub })
      });
      console.log('Web Push subscription registered on server.');
    } catch (err) {
      console.error('Failed to set up Web Push:', err);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {}
    disconnectWebSocket();
    clearSession();
  }
</script>

<div class="fixed inset-0 z-10 flex">
  <!-- Sidebar -->
  <ChatSidebar
    on:logout={handleLogout}
  />

  <!-- Main Chat Area -->
  {#if $activePeer}
    <ChatView />
  {:else}
    <!-- Empty State -->
    <div class="flex-1 flex items-center justify-center bg-vault-black relative">
      <div class="text-center animate-fade-in">
        <div class="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-vault-elevated border border-vault-border mb-6">
          <svg class="w-10 h-10 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
          </svg>
        </div>
        <h2 class="text-lg font-medium text-vault-text-secondary mb-2">Select a conversation</h2>
        <p class="text-sm text-vault-text-dim max-w-xs">
          All messages are end-to-end encrypted and auto-delete within 24 hours.
        </p>

        <!-- Connection Status -->
        <div class="mt-8 flex items-center justify-center gap-2 text-xs">
          <div class="w-1.5 h-1.5 rounded-full {$wsConnected ? 'bg-vault-accent' : 'bg-vault-danger'} animate-pulse"></div>
          <span class="text-vault-text-dim">
            {#if $wsConnected}
              Encrypted connection active
            {:else if $wsError}
              Connection error: {$wsError} · <button on:click={() => connectWebSocket()} class="underline text-vault-accent hover:text-vault-accent-hover cursor-pointer bg-transparent border-none p-0 inline focus:outline-none">Retry</button>
            {:else}
              Connecting...
            {/if}
          </span>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Global Incoming Call Popup Overlay -->
{#if $activeCall && $activeCall.status === 'incoming'}
  <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-80 p-4 bg-vault-surface/90 border border-vault-border rounded-2xl shadow-2xl flex flex-col gap-3 backdrop-blur-md animate-slide-down text-center text-vault-text">
    <div class="w-12 h-12 rounded-full bg-vault-accent/10 flex items-center justify-center mx-auto text-vault-accent">
      <svg class="w-6 h-6 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    </div>
    <div>
      <h4 class="text-sm font-semibold text-vault-text animate-pulse">Incoming Call</h4>
      <p class="text-[10px] text-vault-text-dim mt-0.5">{$activeCall.peerUsername} is calling you via E2EE {$activeCall.type}...</p>
    </div>
    <div class="flex gap-2">
      <button
        on:click={declineIncomingCall}
        class="btn-ghost flex-1 py-2 text-xs border-vault-danger/30 text-vault-danger hover:bg-vault-danger/5 rounded-xl cursor-pointer focus:outline-none"
      >
        Decline
      </button>
      <button
        on:click={acceptIncomingCall}
        class="btn-primary flex-1 py-2 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer focus:outline-none"
      >
        Accept
      </button>
    </div>
  </div>
{/if}
