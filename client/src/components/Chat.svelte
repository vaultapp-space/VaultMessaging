<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, clearSession, activePeer, activeChannelId, pendingChatId, syncPts, oneTimePrekeyPairs, activeCall, recentCalls, groupSenderKeys, groupKeyRecipients, sidebarOpen } from '../lib/stores/session.js';
  import { conversations, conversationsLoaded, addMessage, addMessages, setTyping, updateMessageDeliveryStatus } from '../lib/stores/messages.js';
  import { setReactions } from '../lib/chat/reactions.js';
  import { applyEdit } from '../lib/chat/edit.js';
  import { tombstoneLocally, setPinned, setPreview, setPoll, consumeViewOnce } from '../lib/chat/actions.js';
  import { hydrateBlocked } from '../lib/chat/chatSettings.js';
  import { fetchPoll, fetchUpdates, fetchChats, fetchPendingMessages, logout, getPrekeyCount, replenishPrekeys, API_BASE } from '../lib/api/http.js';
  import { connectWebSocket, disconnectWebSocket, onWsEvent, wsConnected, wsError, wsSend } from '../lib/api/ws.js';
  import { generateOneTimePrekeys, importStaticKey } from '../lib/crypto/keys.js';
  import { decryptSignalingPayload } from '../lib/crypto/decryption.js';
  import { fromBase64 } from '../lib/crypto/utils.js';
  import { playOutgoingCallSound, playIncomingCallSound, stopCallSounds } from '../lib/callSounds.js';
  import ChatSidebar from './ChatSidebar.svelte';
  import ChatView from './ChatView.svelte';
  import ChannelView from './ChannelView.svelte';
  import MiniCallBar from './MiniCallBar.svelte';
  import MobileTabBar from './MobileTabBar.svelte';
  import { showToast } from '../lib/stores/toast.js';
  import { hapticMedium, hapticLight } from '../lib/haptics.js';
  import { requestNotificationPermission, notifyNewMessage } from '../lib/notifications.js';

  const unsubscribers = [];
  let ping = 32;
  let pingInterval;
  let showBackupModal = false;

  $: if ($activeCall) {
    if ($activeCall.status === 'ringing') {
      if ($activeCall.direction === 'outgoing') {
        playOutgoingCallSound();
      } else if ($activeCall.direction === 'incoming') {
        playIncomingCallSound();
      }
    } else {
      stopCallSounds();
    }
  } else {
    stopCallSounds();
  }

  // Maps a chat onto the shape the existing components already read. Keeping
  // `peerId` in the old form ('group-<id>' for groups, the peer's user id for
  // private chats) means the sidebar, ChatView and the send path keep working
  // unchanged while the new fields ride alongside.
  // The same peer shape ChatSidebar builds when a conversation row is clicked.
  function toActivePeer(conv) {
    return {
      id: conv.peerId,
      username: conv.peerUsername,
      isGroup: conv.isGroup,
      members: conv.members,
      createdBy: conv.createdBy,
      chatId: conv.chatId,
      mode: conv.mode,
      isEmpty: conv.isEmpty,
      lastMessageAt: conv.lastMessageAt,
      isForum: conv.isForum,
    };
  }

  function toConversation(chat) {
    const isGroup = chat.type === 'group';
    return {
      // New fields.
      chatId: chat.id,
      mode: chat.mode,
      unreadCount: chat.unreadCount,
      isEmpty: chat.isEmpty,
      theme: chat.theme ?? null,
      isForum: Boolean(chat.isForum),
      lastSeq: chat.lastSeq,

      // Existing shape.
      peerId: isGroup ? `group-${chat.id}` : chat.peerId,
      peerUsername: isGroup ? chat.title : chat.peerUsername,
      isGroup,
      members: chat.members || [],
      membersCount: chat.membersCount,
      createdBy: chat.createdBy,
      lastMessageAt: chat.lastMessageAt,
      hasUndelivered: chat.unreadCount > 0,
    };
  }

  onMount(async () => {
    // Asked once someone is actually in the app using it, not at the
    // landing page — a permission prompt before anyone has a reason to
    // want notifications from this origin gets reflexively denied, and
    // Notification.permission can't be re-prompted once it's 'denied'.
    requestNotificationPermission();

    // 1. Load the chat list from the chat model.
    //
    // This replaces the old pair of calls (/api/conversations + /api/groups),
    // which derived conversations from message rows. That mattered: messages
    // expire after 24h and chats do not, so a conversation used to disappear
    // once it went quiet for a day. Reading /api/chats keeps it — empty —
    // and brings real unread counts with it.
    try {
      const { chats } = await fetchChats();
      const convs = chats.map(toConversation);
      conversations.set(convs);
      conversationsLoaded.set(true);

      // Arrived through an invite link: open what they joined, rather than
      // dropping them into a list with no explanation of why it changed.
      const joinedId = get(pendingChatId);
      if (joinedId) {
        pendingChatId.set(null);
        const joined = convs.find(c => c.chatId === joinedId);
        if (joined) activePeer.set(toActivePeer(joined));
      }
    } catch (err) {
      console.error('Failed to fetch chats:', err);
      // Marked loaded on failure too. The flag answers "has the first attempt
      // finished", not "did it succeed" — leaving it false would park the
      // sidebar on skeleton rows indefinitely, which reads as a hang rather
      // than the empty state plus whatever error surfaced.
      conversationsLoaded.set(true);
    }

    // Blocked users are global state, not per-conversation: loading them here
    // means the block is known before any chat is opened, and survives a
    // reload rather than only appearing once you happen to open that chat.
    hydrateBlocked();


    // Start from wherever the account's log currently is. A first load has
    // just fetched the chat list, so replaying the last day on top of it
    // would duplicate everything it already has.
    try {
      const { pts } = await fetchUpdates(0);
      syncPts.set(pts ?? 0);
    } catch (err) {
      console.error('Failed to read sync position:', err);
    }

    // 2. Connect WebSocket for real-time messaging
    // Cookie-based auth: JWT cookie sent automatically during upgrade
    connectWebSocket();

    // Catch up whenever the socket comes back. Messages that arrived while
    // it was down are replayed from the log; ones that were delivered live
    // are dropped by the store's id check, so a replay that overlaps costs
    // nothing but is never missing anything.
    let wasConnected = false;
    unsubscribers.push(wsConnected.subscribe((connected) => {
      if (connected && wasConnected) catchUp();
      wasConnected = connected;
    }));

    // Setup Web Push notifications
    setupPushNotifications();

    // Fluctuating network latency ticker
    pingInterval = setInterval(() => {
      ping = Math.floor(Math.random() * (45 - 28 + 1)) + 28;
    }, 2500);

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
      onWsEvent('reaction', handleReaction),
      onWsEvent('message_edited', handleMessageEdited),
      onWsEvent('message_deleted', handleMessageDeleted),
      onWsEvent('message_pinned', handleMessagePinned),
      onWsEvent('message_unpinned', handleMessageUnpinned),
      onWsEvent('message_preview', handleMessagePreview),
      onWsEvent('poll_updated', handlePollUpdated),
      onWsEvent('message_consumed', handleMessageConsumed),
      onWsEvent('device_revoked', handleDeviceRevoked),
      onWsEvent('group_updated', handleGroupUpdated),
      onWsEvent('group_removed', handleGroupRemoved),
    );
  });

  onDestroy(() => {
    for (const unsub of unsubscribers) unsub();
    clearInterval(pingInterval);
    disconnectWebSocket();
    stopCallSounds();
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

  // Cloud-chat reactions arrive as their own event carrying the recomputed
  // summary. Secret-chat reactions never come through here — they are ops
  // inside encrypted messages, applied in the message store.
  function handleReaction(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (!conv) return;
    setReactions(conv.peerId, data.seq, data.reactions);
  }

  function handleMessageEdited(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (!conv) return;
    applyEdit(conv.peerId, { seq: data.seq, body: data.body, editedAt: data.editedAt });
  }

  function handleMessageDeleted(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (conv) tombstoneLocally(conv.peerId, data.seq);
  }

  function handleMessagePinned(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (conv) setPinned(conv.peerId, data.seq, new Date().toISOString());
  }

  function handleMessageUnpinned(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (conv) setPinned(conv.peerId, data.seq, null);
  }

  function handleMessagePreview(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (conv) setPreview(conv.peerId, data.seq, data.preview);
  }

  // A vote landed. The tally is viewer-specific — which option is *mine* —
  // so the server cannot include it in the broadcast and each client fetches
  // its own copy.
  async function handlePollUpdated(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (!conv) return;
    try {
      const { poll } = await fetchPoll(data.chatId, data.seq);
      setPoll(conv.peerId, data.seq, poll);
    } catch (err) {
      console.error('Failed to refresh poll:', err);
    }
  }

  // A view-once message was opened by its last remaining recipient. The
  // server has already cleared it; this drops the local copy so a client that
  // happens to be looking at it does not keep showing content the server no
  // longer has.
  function handleMessageConsumed(data) {
    const conv = get(conversations).find(c => c.chatId === data.chatId);
    if (conv) consumeViewOnce(conv.peerId, data.seq);
  }

  // Broadcast to every device on the account when ANY one of them is
  // revoked (devices.routes.js's deliverToUser has no per-device targeting
  // — see its own comment), not just the one that was actually revoked.
  // Previously this handler ignored the payload and cleared local state
  // unconditionally, which meant revoking device B from device A's own
  // Active Sessions list signed device A itself out too, just for having
  // received the same notification everyone else on the account did.
  function handleDeviceRevoked(data) {
    if (data?.deviceId !== get(currentUser)?.deviceId) return;
    showToast('This device was signed out from another session.', { type: 'info', duration: 6000 });
    // The server now force-closes this socket right after sending this
    // event (see server/src/routes/devices.routes.js), so without this the
    // client's auto-reconnect (ws.js) would immediately try to reconnect a
    // session that no longer exists, fail, and retry forever with backoff.
    disconnectWebSocket();
    clearSession();
  }

  // Catches up on everything missed while the socket was down.
  //
  // `tooLong` means the gap is bigger than the log can serve — with a 24h
  // retention, mostly that the client was away for more than a day. Refetching
  // the chat list is the right answer and a cheap one, because there is only
  // ever a day of it to fetch.
  async function catchUp() {
    try {
      const from = get(syncPts);
      const { updates, pts, tooLong } = await fetchUpdates(from);

      if (tooLong) {
        const { chats } = await fetchChats();
        conversations.set(chats.map(toConversation));
        syncPts.set(pts ?? 0);
        return;
      }

      for (const update of updates) {
        if (update.kind === 'message') handleIncomingMessage(update);
      }
      syncPts.set(pts ?? from);
    } catch (err) {
      console.error('Failed to catch up after reconnect:', err);
    }
  }

  function handleIncomingMessage(data) {
    // The store is keyed by peer, so a message has to be filed against the
    // *other* party — but the fanout reaches the sender too, and `senderId`
    // is then the reader's own id. Resolving through the chat first puts a
    // server-originated message the client did not insert optimistically
    // (a poll, a scheduled send) into the right conversation instead of a
    // phantom one keyed by the reader.
    const conv = data.chatId
      ? get(conversations).find(c => c.chatId === data.chatId)
      : null;
    const threadId = conv?.peerId
      ?? (data.groupId ? `group-${data.groupId}` : data.senderId);

    // A cloud message arrives already in plaintext — there is nothing to
    // decrypt, and treating it as ciphertext would push it through the ratchet
    // and fail. A secret message keeps the existing path exactly.
    if (data.mode === 'cloud') {
      addMessage(threadId, {
        id: data.id,
        chatId: data.chatId,
        seq: data.seq,
        senderId: data.senderId,
        senderUsername: data.senderUsername,
        mode: 'cloud',
        messageType: data.messageType,
        text: data.body,
        body: data.body,
        entities: data.entities,
        media: data.media,
        replyToSeq: data.replyToSeq,
        preview: data.preview ?? null,
        poll: data.poll ?? null,
        // Lets the store recognise this as the echo of a send this client
        // made itself, rather than a second message.
        clientRandomId: data.clientRandomId ?? null,
        viewOnce: Boolean(data.viewOnce),
        encrypted: false,
        sentAt: data.sentAt,
        expiresAt: data.expiresAt,
      });
    } else {
      addMessage(threadId, {
        id: data.id,
        chatId: data.chatId,
        seq: data.seq,
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
    }

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
          lastMessageAt: data.sentAt,
          hasUndelivered: !isCurrentlyActive,
          unreadCount: isCurrentlyActive ? 0 : 1,
          isEmpty: false,
          // Carry the chat identity through. A conversation first seen via an
          // incoming message used to be created without these, so anything
          // keyed on the chat — reactions, read receipts, per-chat settings —
          // silently did nothing until the next page load repopulated it from
          // /api/chats.
          chatId: data.chatId || (data.groupId ?? null),
          mode: data.mode || (data.groupId ? 'secret' : undefined),
        });
        // The join key isn't sent with individual messages (it's a bearer
        // secret that lets anyone into the group, so it shouldn't ride
        // along with every message payload) — backfill it from the
        // authoritative group list for a conversation we're seeing for
        // the first time (e.g. just added to a new group).
        // Also covers a private chat seen for the first time: a secret
        // message carries no chatId, so resolve it from the authoritative
        // chat list rather than leaving the conversation half-formed.
        {
          fetchChats().then(({ chats }) => {
            const g = data.groupId
              ? chats.find(c => c.id === data.groupId)
              : chats.find(c => c.peerId === data.senderId);
            if (!g) return;
            conversations.update(cs => {
              const conv = cs.find(c => c.peerId === threadId);
              if (conv) {
                conv.createdBy = g.createdBy;
                conv.chatId = g.id;
                conv.mode = g.mode;
              }
              return [...cs];
            });
          }).catch(err => console.error('Failed to backfill group join key:', err));
        }
      }
      return [...convs];
    });

    // Desktop-only (see lib/notifications.js) and only while the tab is
    // actually unfocused (checked inside notifyNewMessage) — otherwise this
    // would fire for a message in the conversation already on screen.
    if (data.senderId !== get(currentUser)?.id) {
      notifyNewMessage({
        title: data.groupName || data.senderUsername || 'New message',
        // Cloud messages arrive as plaintext already (server-visible,
        // nothing additional leaked by a notification). Secret-chat
        // messages arrive as ciphertext at this point in the flow —
        // decrypting just to populate a system notification would mean
        // duplicating the ratchet's decrypt path here, so those get a
        // content-free notification instead, matching how most E2EE
        // messengers handle previews by default anyway.
        body: data.mode === 'cloud' ? data.body : 'Sent you a new message',
        onClick: () => {
          activePeer.set(conv ? toActivePeer(conv) : { id: threadId, username: data.senderUsername, isGroup: !!data.groupId });
          sidebarOpen.set(false);
        },
      });
    }
  }

  function handleTyping(data) {
    setTyping(data.senderId);
  }

  // Membership changed (someone joined/left/was removed) — refresh the
  // cached member list so E2EE group fan-out and the members UI stay
  // accurate instead of only updating on the next message.
  function handleGroupUpdated(data) {
    if (!data.group) return;
    const threadId = `group-${data.groupId}`;
    conversations.update(convs => {
      const conv = convs.find(c => c.peerId === threadId);
      if (conv) {
        conv.members = data.group.members;
        return [...convs];
      }

      // Being added to a group has to *create* the row, not just refresh one.
      // This used to work by accident: groups were secret, so the first
      // message arrived through the ratchet path and built the thread on the
      // way past. Cloud group messages carry a chatId the recipient has never
      // seen, so without this a member added to a group simply never sees it.
      convs.unshift({
        peerId: threadId,
        peerUsername: data.group.name,
        isGroup: true,
        members: data.group.members,
        createdBy: data.group.createdBy,
        chatId: data.groupId,
        mode: 'cloud',
        unreadCount: 0,
        isEmpty: true,
        lastMessageAt: null,
        hasUndelivered: false,
      });
      return [...convs];
    });
    activePeer.update(peer => {
      if (peer && peer.id === threadId) peer.members = data.group.members;
      return peer;
    });

    // Someone left or was removed — rotate our Sender Key so their
    // already-derived copy of the old key can't decrypt anything we
    // encrypt from now on. Dropping our session forces encryptAndSend to
    // mint a fresh one and redistribute it to the remaining members.
    if (data.membershipChange === 'departed') {
      const mySessionKey = `${threadId}:${get(currentUser)?.id}`;
      groupSenderKeys.update(m => { m.delete(mySessionKey); return m; });
      groupKeyRecipients.update(m => { m.delete(mySessionKey); return m; });
    }
  }

  // We were removed from (or left) a group — drop it locally.
  function handleGroupRemoved(data) {
    const threadId = `group-${data.groupId}`;
    conversations.update(convs => convs.filter(c => c.peerId !== threadId));
    if (get(activePeer)?.id === threadId) {
      activePeer.set(null);
    }
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
    hapticMedium();
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
      showToast(`${data.senderUsername || 'Peer'} rejected the call: ${data.reason || 'declined'}`, { type: 'info' });
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
      showToast('Encryption negotiation failed. Cannot accept call.');
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
      const res = await fetch(`${API_BASE}/push/public-key`, { credentials: 'include' });
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
      await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Cross-origin inside the Android app, so the session cookie needs
        // asking for explicitly — fetch defaults to 'same-origin'.
        credentials: 'include',
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
      .replace(/-/g, '+')
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

<!-- fixed inset-0 escapes App.svelte's <main> padding-top entirely (fixed
     positioning is relative to the viewport, not an ancestor's padding
     box), so the same safe-area-inset-top fix has to be repeated here for
     the chat screen specifically — see App.svelte's comment for why.
     max-md:-scoped max() floor: a plain env() falls back to 0 whenever the
     OS resizes the window for the on-screen keyboard and misreports the
     inset during that transition — this is the main chat screen, where
     the composer keeps a keyboard open constantly, so it's the highest-
     traffic place that could happen. Not unconditional: desktop has no
     inset to compensate for at all, and a floor there would just add
     unwanted padding. -->
<div class="fixed inset-0 z-10 flex max-md:pt-[max(env(safe-area-inset-top,0px),1.5rem)]">
  <!-- Sidebar -->
  <ChatSidebar
    on:logout={handleLogout}
    bind:showBackupModal
  />

  <!-- Main Chat Area -->
  {#if $activeChannelId}
    <ChannelView chatId={$activeChannelId} onClose={() => activeChannelId.set(null)} />
  {:else if $activePeer}
    <ChatView />
  {:else}
    <!-- Empty State -->
    <div class="flex-1 flex items-center justify-center bg-vault-black relative">
      <div class="text-center animate-fade-in">
        <div class="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-vault-elevated border border-vault-border mb-6">
          <svg class="w-10 h-10 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
            <path d="M12 22V12" stroke-dasharray="3 3" />
          </svg>
        </div>
        <h2 class="text-lg font-medium text-vault-text-secondary mb-2">Select a conversation</h2>
        <p class="text-sm text-vault-text-dim max-w-xs">
          All messages are end-to-end encrypted and auto-delete within 24 hours.
        </p>

        <!-- Connection Status -->
        <div class="mt-8 flex items-center justify-center gap-2 text-xs">
          <div class="w-1.5 h-1.5 rounded-full {$wsConnected ? 'bg-vault-accent' : 'bg-vault-danger'} animate-pulse"></div>
          <span class="text-vault-text-dim font-mono">
            {#if $wsConnected}
              Secure Relay Active · Latency: {ping}ms
            {:else if $wsError}
              Connection error: {$wsError} · <button on:click={() => connectWebSocket()} class="underline text-vault-accent hover:text-vault-accent-hover cursor-pointer bg-transparent border-none p-0 inline focus:outline-none">Retry</button>
            {:else}
              Connecting to secure relay node...
            {/if}
          </span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Nested inside this wrapper, not a sibling of it: the wrapper's own
       z-10 caps everything within it to one stacking layer, so a sibling
       tab bar here would always paint above every sidebar/chat modal
       (z-50+) no matter what z-index the tab bar used — only nesting lets
       its z-index actually compete with theirs. -->
  <MobileTabBar bind:showBackupModal />
</div>

<!-- Mini call bar: shown when a call is live but the user has navigated
     away from that peer's chat (ChatView renders the full call UI itself
     when it IS the active peer's chat). -->
<MiniCallBar />

<!-- Global Incoming Call Popup Overlay.
     A w-80 card in a corner is easy to miss entirely on a phone — real
     phone call UIs go full-screen for exactly this reason. Below md this
     is now a full-screen ringing screen; at md+ it stays the compact
     centered card, since a desktop window is already fully in view. -->
{#if $activeCall && $activeCall.status === 'incoming'}
  <div class="fixed z-50 flex flex-col text-center text-vault-text animate-slide-down
    max-md:inset-0 max-md:justify-between max-md:bg-vault-black/95 max-md:backdrop-blur-xl
    max-md:pt-[max(env(safe-area-inset-top,0px),2.5rem)] max-md:pb-[max(env(safe-area-inset-bottom,0px),2rem)] max-md:px-6
    md:top-6 md:left-1/2 md:-translate-x-1/2 md:w-80 md:p-4 md:gap-3 md:bg-vault-surface/90 md:border md:border-vault-border md:rounded-2xl md:shadow-2xl md:backdrop-blur-md"
  >
    <div class="max-md:mt-16 max-md:flex max-md:flex-col max-md:items-center">
      <div class="rounded-full bg-vault-accent/10 flex items-center justify-center mx-auto text-vault-accent max-md:w-28 max-md:h-28 w-12 h-12 animate-pulse-glow">
        <svg class="animate-bounce max-md:w-12 max-md:h-12 w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      </div>
      <h4 class="font-semibold text-vault-text animate-pulse max-md:text-2xl max-md:mt-6 text-sm">{$activeCall.peerUsername}</h4>
      <p class="text-vault-text-dim max-md:text-sm max-md:mt-2 text-[10px] mt-0.5">Incoming E2EE {$activeCall.type} call...</p>
    </div>
    <div class="flex gap-2 max-md:gap-6 max-md:mt-10">
      <button
        on:click={() => { hapticLight(); declineIncomingCall(); }}
        class="btn-ghost flex-1 border-vault-danger/30 text-vault-danger hover:bg-vault-danger/5 rounded-xl cursor-pointer focus:outline-none
          max-md:py-4 max-md:text-sm max-md:font-semibold py-2 text-xs"
      >
        Decline
      </button>
      <button
        on:click={() => { hapticMedium(); acceptIncomingCall(); }}
        class="btn-primary flex-1 bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer focus:outline-none
          max-md:py-4 max-md:text-sm py-2 text-xs"
      >
        Accept
      </button>
    </div>
  </div>
{/if}
