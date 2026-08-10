<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade, scale } from 'svelte/transition';
  import { currentUser, activePeer, activeChannelId, composeStoryRequested, sidebarOpen, localBackupEnabled, localBackupPassphrase, localBackupKey, vaultMasterKey, identityKeyPair, signedPrekeyPair, recentCalls, ratchetSessions, groupSenderKeys } from '../lib/stores/session.js';
  import { conversations, typingUsers, clearBackup, restoreBackup } from '../lib/stores/messages.js';
  import { openPrivateChat, fetchFolders, createFolder, setFolderChats, deleteFolder,
    fetchChannels, createChannel, searchChannels, subscribeChannel } from '../lib/api/http.js';
  import {
    setMuted, isMuted, setArchived, setPinnedToTop,
    runSearch, hydrateDrafts, refreshPresence, presence, describePresence,
  } from '../lib/chat/chatSettings.js';
  import { clickOutside } from '../lib/actions/clickOutside.js';
  import { searchUsers, createGroup as createGroupApi, saveEncryptedVault, API_BASE, PUBLIC_ORIGIN } from '../lib/api/http.js';
  import { wsConnected } from '../lib/api/ws.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { exportIdentityBackup, importIdentityBackup, encryptIdentityVault } from '../lib/crypto/keys.js';
  import { isPrfSupported, authenticateBiometric } from '../lib/crypto/webauthn.js';
  import { enableBiometric, disableBiometric } from '../lib/biometric.js';

  import { syncCloudVault } from '../lib/crypto/sync.js';
  import { encryptSyncPayload } from '../lib/crypto/keys.js';
  import { toBase64 } from '../lib/crypto/utils.js';
  import { applyTheme as applyThemeGlobal } from '../lib/theme.js';
  import { showToast } from '../lib/stores/toast.js';
  import { pushBackHandler } from '../lib/backHandler.js';
  import { showConfirm } from '../lib/stores/confirm.js';
  import { promptPassphrase } from '../lib/stores/passphrasePrompt.js';
  import WalletSettings from './WalletSettings.svelte';
  import ActiveSessions from './ActiveSessions.svelte';
  import DonateBar from './DonateBar.svelte';
  import Stories from './Stories.svelte';
  import QRCode from 'qrcode';

  // Lifted to a prop so the mobile bottom tab bar (a sibling in Chat.svelte,
  // outside this component) can open Settings too — the modal below renders
  // as its own overlay outside <aside>, so it isn't affected by the sidebar
  // being hidden on mobile.
  export let showBackupModal = false;
  // Android back button closes whichever of these is on top instead of
  // falling through to WebView history (see lib/backHandler.js) — each
  // pushes its close callback while open and pops it however it closes,
  // in-app control or the back button itself.
  let unregisterBackupBack = null;
  $: {
    if (showBackupModal && !unregisterBackupBack) {
      unregisterBackupBack = pushBackHandler(() => { showBackupModal = false; });
    } else if (!showBackupModal && unregisterBackupBack) {
      unregisterBackupBack();
      unregisterBackupBack = null;
    }
  }
  // Below md this <aside> is always in the DOM (see the slide transition on
  // it further down) rather than display:none while closed, so it no longer
  // drops out of the accessibility tree/tab order for free the way it used
  // to. `inert` puts that back — but only below md, since above it the panel
  // is the normal, always-visible sidebar regardless of $sidebarOpen.
  let isNarrowViewport = false;
  onMount(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    isNarrowViewport = mq.matches;
    const handler = (e) => { isNarrowViewport = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  // Must match App.svelte's own applyTheme(localStorage.getItem('vault_theme')
  // || 'light') fallback exactly — that's what's actually rendered on first
  // load for anyone who's never touched this setting, so a different
  // default here just makes this indicator wrong, not the theme itself.
  let theme = localStorage.getItem('vault_theme') || 'light';
  let isSyncing = false;
  let syncError = '';
  let lastSyncedTime = new Date().toLocaleTimeString();

  let showSyncModal = false;
  let unregisterSyncBack = null;
  $: {
    if (showSyncModal && !unregisterSyncBack) {
      unregisterSyncBack = pushBackHandler(() => { showSyncModal = false; });
    } else if (!showSyncModal && unregisterSyncBack) {
      unregisterSyncBack();
      unregisterSyncBack = null;
    }
  }
  let syncQrUrl = '';
  let syncLink = '';

  async function initiateQrSync() {
    try {
      const syncId = crypto.randomUUID();
      const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      const keyBase64 = toBase64(aesKeyBytes);
      
      const serializedRatchets = {};
      for (const [peerId, session] of $ratchetSessions.entries()) {
        serializedRatchets[peerId] = await session.serialize();
      }

      const serializedGroupKeys = {};
      for (const [key, session] of $groupSenderKeys.entries()) {
        serializedGroupKeys[key] = await session.serialize();
      }

      let localBackupKeyBase64 = null;
      if ($localBackupKey) {
        const raw = await crypto.subtle.exportKey('raw', $localBackupKey);
        localBackupKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
      }

      const syncPayload = {
        identityKeyPair: {
          ecdh: {
            publicKey: await crypto.subtle.exportKey('jwk', $identityKeyPair.ecdh.publicKey),
            privateKey: await crypto.subtle.exportKey('jwk', $identityKeyPair.ecdh.privateKey)
          },
          ecdsa: {
            publicKey: await crypto.subtle.exportKey('jwk', $identityKeyPair.ecdsa.publicKey),
            privateKey: await crypto.subtle.exportKey('jwk', $identityKeyPair.ecdsa.privateKey)
          }
        },
        signedPrekeyPair: {
          publicKey: await crypto.subtle.exportKey('jwk', $signedPrekeyPair.publicKey),
          privateKey: await crypto.subtle.exportKey('jwk', $signedPrekeyPair.privateKey)
        },
        vaultMasterKey: $vaultMasterKey,
        currentUser: $currentUser,
        localBackupKeyBase64,
        localBackupPassphrase: $localBackupPassphrase,
        ratchetSessions: serializedRatchets,
        groupSenderKeys: serializedGroupKeys
      };

      const encryptedPayload = await encryptSyncPayload(syncPayload, aesKeyBytes);
      
      const res = await fetch(`${API_BASE}/auth/sync/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Cross-origin inside the Android app (app.vaultapp.space →
        // vaultapp.space), where fetch's default 'same-origin' credentials
        // mode would drop the session cookie.
        credentials: 'include',
        body: JSON.stringify({ syncId, payload: encryptedPayload })
      });
      
      if (res.ok) {
        // The key lives in the URL fragment, never the query string: fragments
        // are a browser-only concept and are never sent in any HTTP request
        // (not this page load, not the /sync/retrieve call below), so it never
        // reaches nginx access logs. syncId alone is a single-use, 120s-TTL
        // capability token and is useless without the fragment key.
        syncLink = `${PUBLIC_ORIGIN}/?syncId=${syncId}#key=${encodeURIComponent(keyBase64)}`;
        // Rendered locally — never hand the link (with the key) to a third
        // party like api.qrserver.com to generate the QR image.
        syncQrUrl = await QRCode.toDataURL(syncLink, { width: 200, margin: 1 });
        showSyncModal = true;
      } else {
        const errBody = await res.json().catch(() => null);
        showToast(errBody?.error ? `Failed to initiate sync session: ${errBody.error}` : 'Failed to initiate sync session on server');
      }
    } catch (err) {
      console.error('QR Sync initiation failed:', err);
      showToast(err?.message ? `Failed to construct sync payload: ${err.message}` : 'Failed to construct sync payload');
    }
  }

  async function triggerManualSync() {
    isSyncing = true;
    syncError = '';
    try {
      await syncCloudVault();
      lastSyncedTime = new Date().toLocaleTimeString();
    } catch (e) {
      console.error(e);
      syncError = 'Sync failed';
    } finally {
      isSyncing = false;
    }
  }

  function applyTheme(newTheme) {
    theme = newTheme;
    localStorage.setItem('vault_theme', newTheme);
    applyThemeGlobal(newTheme);
  }

  const dispatch = createEventDispatcher();

  let biometricSupported = false;
  let biometricEnabled = false;
  let ping = 32;
  let pingInterval;

  onMount(() => {
    biometricSupported = isPrfSupported();
    if ($currentUser) {
      biometricEnabled = localStorage.getItem(`vault_bio_enabled_${$currentUser.id}`) === 'true';
    }

    pingInterval = setInterval(() => {
      ping = Math.floor(Math.random() * (45 - 28 + 1)) + 28;
    }, 2500);

    return () => {
      clearInterval(pingInterval);
    };
  });

  async function toggleBiometric(e) {
    const enabled = e.target.checked;
    if (enabled) {
      try {
        const result = await enableBiometric($currentUser, get(vaultMasterKey));

        // Update local backup keys using derived WebAuthn PRF key
        localBackupKey.set(result.prfKey);
        localBackupPassphrase.set('BIOMETRIC_UNLOCKED');
        localBackupEnabled.set(true);

        biometricEnabled = true;
        showToast('Biometric Vault Unlock enabled successfully!', { type: 'success' });
      } catch (err) {
        console.error('Biometric registration failed:', err);
        showToast(err.message || 'Biometric registration failed');
        e.target.checked = false;
        biometricEnabled = false;
      }
    } else {
      disableBiometric($currentUser.id);
      localBackupEnabled.set(false);
      localBackupPassphrase.set('');
      localBackupKey.set(null);
      biometricEnabled = false;
      showToast('Biometric Vault Unlock disabled.', { type: 'success' });
      setTimeout(syncVault, 100);
    }
  }

  async function syncVault() {
    const masterKey = get(vaultMasterKey);
    if (!masterKey) {
      console.warn('Vault master key not available for ZK vault sync.');
      return;
    }
    if (!$identityKeyPair || !$signedPrekeyPair) return;

    try {
      let localBackupKeyBase64 = null;
      const dbKey = get(localBackupKey);
      if (dbKey) {
        const raw = await crypto.subtle.exportKey('raw', dbKey);
        localBackupKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
      }

      const encryptedVault = await encryptIdentityVault({
        identityKeyPair: $identityKeyPair,
        signedPrekeyPair: $signedPrekeyPair,
        localBackupKeyBase64,
        localBackupPassphrase: $localBackupPassphrase
      }, masterKey);

      await saveEncryptedVault(encryptedVault);
      console.log('[Sync] Zero-knowledge identity vault synchronized.');
    } catch (err) {
      console.error('[Sync] Failed to synchronize identity vault:', err);
    }
  }

  let searchQuery = '';
  let searchResults = [];
  let searching = false;
  let searchInputEl;

  // Desktop convention (Slack, Discord, Telegram web) with no equivalent
  // here before — the only keyboard handling anywhere in the app was the
  // composer's own Enter/Escape. Skipped whenever focus is already in an
  // editable element, so it doesn't hijack a literal "/" being typed into a
  // message, another search box, or any modal's input.
  function handleSlashShortcut(e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const active = document.activeElement;
    const isEditable = active && (
      active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable
    );
    if (isEditable) return;
    e.preventDefault();
    searchInputEl?.focus();
  }

  let showGroupModal = false;
  let unregisterGroupBack = null;
  $: {
    if (showGroupModal && !unregisterGroupBack) {
      unregisterGroupBack = pushBackHandler(() => { showGroupModal = false; });
    } else if (!showGroupModal && unregisterGroupBack) {
      unregisterGroupBack();
      unregisterGroupBack = null;
    }
  }
  let activeTab = 'chats';
  // Message search is folded away until asked for; two identical-looking
  // search boxes doing different things is worse than one extra click.
  let showMessageSearch = false;
  let unregisterSearchBack = null;
  $: {
    if (showMessageSearch && !unregisterSearchBack) {
      unregisterSearchBack = pushBackHandler(() => { showMessageSearch = false; });
    } else if (!showMessageSearch && unregisterSearchBack) {
      unregisterSearchBack();
      unregisterSearchBack = null;
    }
  }
  // One creation menu rather than an icon per thing you can create.
  let showNewMenu = false;

  // ─── Global search ──────────────────────────────────────
  // Searches message *content* across every cloud chat, as distinct from the
  // user search above it. Secret chats cannot be included — they have no
  // plaintext on the server — and the UI says so rather than quietly
  // returning less than the user expects.
  let showArchived = false;
  let messageQuery = '';
  let messageResults = [];
  let searchingMessages = false;
  let searchNotice = '';
  let messageSearchTimer;

  function handleMessageSearch(e) {
    const query = e.target.value;
    messageQuery = query;
    clearTimeout(messageSearchTimer);

    if (query.trim().length < 2) {
      messageResults = [];
      searchNotice = '';
      return;
    }

    searchingMessages = true;
    messageSearchTimer = setTimeout(async () => {
      try {
        const res = await runSearch(query);
        messageResults = res.results || [];
        // Worth being blunt about. Server-side search reads plaintext, so it
        // can only ever see cloud chats — and one-to-one chats are encrypted
        // by default now, which means this misses most of them. The old
        // wording ("secret chats are not searchable") was accurate when
        // secret was the exception and is quietly misleading now that it is
        // the rule: someone would reasonably conclude search was broken.
        searchNotice = res.excludesSecretChats
          ? 'Searches groups and cloud chats from the last 24 hours. Encrypted chats stay on your device, so they are not searched here — open one and use search inside it.'
          : 'Searches your last 24 hours.';
      } catch (err) {
        console.error('Search failed:', err);
        messageResults = [];
      } finally {
        searchingMessages = false;
      }
    }, 300);
  }

  function openResult(result) {
    const conv = $conversations.find(c => c.chatId === result.chatId);
    if (!conv) return;
    selectPeer({
      id: conv.peerId, username: conv.peerUsername, isGroup: conv.isGroup,
      members: conv.members, chatId: conv.chatId, mode: conv.mode,
    });
    messageQuery = '';
    messageResults = [];
  }

  // ─── Per-chat menu ──────────────────────────────────────
  let openMenuFor = null;

  async function doMute(conv) {
    openMenuFor = null;
    try { await setMuted(conv, !isMuted(conv)); }
    catch (err) { console.error('Failed to mute:', err); }
  }

  async function doArchive(conv) {
    openMenuFor = null;
    try { await setArchived(conv, !conv.archived); }
    catch (err) { console.error('Failed to archive:', err); }
  }

  async function doPinToTop(conv) {
    openMenuFor = null;
    try { await setPinnedToTop(conv, !conv.pinnedOrder); }
    catch (err) { console.error('Failed to pin chat:', err); }
  }

  // Presence for the people actually on screen — polling every contact would
  // be a request per second for information nobody is looking at.
  $: visiblePeerIds = $conversations.filter(c => !c.isGroup).map(c => c.peerId);
  let presenceTimer;
  onMount(() => {
    hydrateDrafts();
    loadFolders();
    loadChannels();
    refreshPresence(visiblePeerIds);
    presenceTimer = setInterval(() => refreshPresence(visiblePeerIds), 45000);
    return () => clearInterval(presenceTimer);
  });
  let groupName = '';
  let groupAddedUsers = [];
  let groupMembersSearch = [];
  let groupMembersQuery = '';
  let groupSearchTimeout;

  async function searchGroupMembers(e) {
    const q = e.target.value;
    groupMembersQuery = q;
    clearTimeout(groupSearchTimeout);
    if (q.length < 1) {
      groupMembersSearch = [];
      return;
    }
    groupSearchTimeout = setTimeout(async () => {
      try {
        const res = await searchUsers(q);
        const selfId = $currentUser?.id;
        groupMembersSearch = (res.users || []).filter(
          u => u.id !== selfId && !groupAddedUsers.some(a => a.id === u.id)
        );
      } catch (err) {
        groupMembersSearch = [];
      }
    }, 250);
  }

  function addGroupUser(user) {
    groupAddedUsers = [...groupAddedUsers, user];
    groupMembersSearch = groupMembersSearch.filter(u => u.id !== user.id);
  }

  function removeGroupUser(user) {
    groupAddedUsers = groupAddedUsers.filter(u => u.id !== user.id);
  }

  let groupBusy = false;

  async function submitCreateGroup() {
    if (groupBusy) return;
    groupBusy = true;
    try {
      const memberIds = groupAddedUsers.map(u => u.id);
      const res = await createGroupApi(groupName, memberIds);
      
      conversations.update(convs => {
        convs.unshift({
          peerId: `group-${res.id}`,
          peerUsername: res.name,
          isGroup: true,
          members: res.members,
          createdBy: res.createdBy,
          // A group's chat id *is* its group id, and groups are cloud. Both
          // have to be carried or the send path falls back to the secret
          // ratchet — silently, because an absent mode reads as secret.
          chatId: res.id,
          mode: 'cloud',
          lastMessageAt: null,
          hasUndelivered: false
        });
        return [...convs];
      });

      selectPeer({
        id: `group-${res.id}`,
        username: res.name,
        isGroup: true,
        members: res.members,
        createdBy: res.createdBy,
        chatId: res.id,
        mode: 'cloud'
      });

      showGroupModal = false;
      groupName = '';
      groupAddedUsers = [];
      groupMembersSearch = [];
      groupMembersQuery = '';
    } catch (err) {
      console.error('Failed to create group:', err);
      showToast(err?.message ? `Failed to create group: ${err.message}` : 'Failed to create group');
    } finally {
      groupBusy = false;
    }
  }

  // Identity key backup methods
  async function exportIdentity() {
    if (!$identityKeyPair || !$signedPrekeyPair) {
      showToast('Keys not generated yet');
      return;
    }
    const passphrase = await promptPassphrase({
      title: 'Encrypt Identity Backup',
      message: 'This password encrypts the backup file — you\'ll need it to restore your identity keys later.',
      mode: 'create',
    });
    if (!passphrase) return;
    try {
      const encrypted = await exportIdentityBackup($identityKeyPair.ecdh, $identityKeyPair.ecdsa, passphrase);
      
      const blob = new Blob([encrypted], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${$currentUser.username}_identity.vaultkey`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export keys:', e);
      showToast(e?.message ? `Failed to export identity keys: ${e.message}` : 'Failed to export identity keys');
    }
  }

  async function importIdentity(e) {
    const file = e.target.files[0];
    if (!file) return;
    const passphrase = await promptPassphrase({
      title: 'Decrypt Identity Backup',
      message: 'Enter the password used to encrypt this identity key file.',
      mode: 'enter',
    });
    if (!passphrase) return;
    try {
      const text = await file.text();
      const restored = await importIdentityBackup(text, passphrase);
      
      identityKeyPair.set({
        ecdh: restored.dh,
        ecdsa: restored.ecdsa
      });
      
      // Save/backup the restored identity keys to the cloud vault
      await syncCloudVault();
      
      showToast('Identity keys imported successfully! Safety numbers restored.', { type: 'success' });
      showBackupModal = false;
    } catch (err) {
      console.error('Failed to import keys:', err);
      showToast('Incorrect password or invalid identity file');
    }
  }
  let searchTimeout;

  // ─── Channels ─────────────────────────────────────────────
  // Kept in their own section rather than mixed into the conversation list:
  // a channel has subscribers rather than members and posts rather than
  // messages, and folding it into `conversations` would mean every per-peer
  // code path (ratchets, typing, calls) had to learn to skip it.
  let channels = [];
  let channelResults = [];
  let showChannelModal = false;
  let unregisterChannelBack = null;
  $: {
    if (showChannelModal && !unregisterChannelBack) {
      unregisterChannelBack = pushBackHandler(() => { showChannelModal = false; });
    } else if (!showChannelModal && unregisterChannelBack) {
      unregisterChannelBack();
      unregisterChannelBack = null;
    }
  }
  let channelTitle = '';
  let channelUsername = '';
  let channelBusy = false;
  let channelError = '';

  async function loadChannels() {
    try {
      const res = await fetchChannels();
      channels = res.channels ?? [];
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  }

  async function makeChannel() {
    const title = channelTitle.trim();
    if (!title || channelBusy) return;
    channelBusy = true;
    channelError = '';
    try {
      const channel = await createChannel({
        title,
        // Blank means private: reachable only by invite, not by knowing its
        // id. A username is what makes a channel publicly readable.
        username: channelUsername.trim() || null,
      });
      await loadChannels();
      showChannelModal = false;
      channelTitle = '';
      channelUsername = '';
      activeChannelId.set(channel.id);
      activePeer.set(null);
    } catch (err) {
      console.error('Failed to create channel:', err);
      channelError = err?.message?.includes('taken')
        ? 'That username is taken.'
        : 'Could not create that channel.';
    } finally {
      channelBusy = false;
    }
  }

  function openChannel(id) {
    activePeer.set(null);
    activeChannelId.set(id);
    if (window.innerWidth < 768) sidebarOpen.set(false);
  }

  async function joinChannel(channel) {
    try {
      await subscribeChannel(channel.id);
      await loadChannels();
      openChannel(channel.id);
      searchQuery = '';
      channelResults = [];
    } catch (err) {
      console.error('Failed to subscribe:', err);
    }
  }

  // ─── Folders ──────────────────────────────────────────────
  // Explicit chat lists only. Telegram also supports rule-based folders
  // ("all groups", "unread"); those are a separate feature and are not
  // modelled here, so a folder is exactly the set of chats put into it.
  let folders = [];
  let activeFolderId = null;
  let showFolderEditor = false;
  let unregisterFolderBack = null;
  $: {
    if (showFolderEditor && !unregisterFolderBack) {
      unregisterFolderBack = pushBackHandler(() => { showFolderEditor = false; });
    } else if (!showFolderEditor && unregisterFolderBack) {
      unregisterFolderBack();
      unregisterFolderBack = null;
    }
  }
  let editingFolder = null;
  let folderDraftTitle = '';
  let folderDraftChats = new Set();
  let folderBusy = false;

  // A folder holds chat ids, but the conversation list is keyed by peer, so
  // membership has to be resolved through chatId on every render.
  $: activeFolder = folders.find((f) => f.id === activeFolderId) ?? null;
  $: folderChatIds = new Set(activeFolder?.chatIds ?? []);
  $: visibleConversations = $conversations.filter((conv) => {
    if (Boolean(conv.archived) !== showArchived) return false;
    if (!activeFolder) return true;
    return conv.chatId && folderChatIds.has(conv.chatId);
  });

  async function loadFolders() {
    try {
      const res = await fetchFolders();
      folders = res.folders ?? [];
      // A folder can be deleted from another device; do not leave the list
      // filtered by something that no longer exists.
      if (activeFolderId && !folders.some((f) => f.id === activeFolderId)) {
        activeFolderId = null;
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  }

  function openFolderEditor(folder = null) {
    editingFolder = folder;
    folderDraftTitle = folder?.title ?? '';
    folderDraftChats = new Set(folder?.chatIds ?? []);
    showFolderEditor = true;
  }

  function toggleFolderChat(chatId) {
    folderDraftChats = new Set(
      folderDraftChats.has(chatId)
        ? [...folderDraftChats].filter((id) => id !== chatId)
        : [...folderDraftChats, chatId]
    );
  }

  async function saveFolder() {
    const title = folderDraftTitle.trim();
    if (!title || folderBusy) return;
    folderBusy = true;
    try {
      const folder = editingFolder ?? await createFolder(title);
      await setFolderChats(folder.id, [...folderDraftChats]);
      await loadFolders();
      showFolderEditor = false;
    } catch (err) {
      console.error('Failed to save folder:', err);
      showToast(err?.message ? `Could not save that folder: ${err.message}` : 'Could not save that folder.');
    } finally {
      folderBusy = false;
    }
  }

  async function removeFolder(folderId) {
    if (!(await showConfirm('Delete this folder? The chats in it are not affected.', { confirmLabel: 'Delete' }))) return;
    try {
      await deleteFolder(folderId);
      if (activeFolderId === folderId) activeFolderId = null;
      await loadFolders();
    } catch (err) {
      console.error('Failed to delete folder:', err);
    }
  }

  // Opens a conversation with a user found through search.
  //
  // Cloud is the default, matching Telegram: the server can read these, which
  // is what makes global search, link previews and syncing history to a second
  // device possible. `secret` creates an end-to-end encrypted chat instead —
  // the two are separate conversations and a pair can have both.
  // Defaults to secret. A one-to-one chat is the conversation people assume
  // is private, so the encrypted mode is the one you get without asking.
  async function startChatWith(user, mode = 'secret') {
    try {
      const chat = await openPrivateChat(user.id, mode);
      selectPeer({
        id: user.id,
        username: user.username,
        chatId: chat.id,
        mode: chat.mode,
        isGroup: false,
      });
    } catch (err) {
      console.error('Failed to open chat:', err);
      // Fall back to the implicit conversation rather than blocking the user;
      // sending still works, it just has no chat row until the first message.
      selectPeer({ id: user.id, username: user.username });
    }
  }

  function selectPeer(peer) {
    activePeer.set(peer);
    searchQuery = '';
    searchResults = [];
    
    // Add to conversations list immediately if not present or clear unread badge
    conversations.update(convs => {
      const existing = convs.find(c => c.peerId === peer.id);
      if (existing) {
        existing.hasUndelivered = false;
        if (peer.isGroup && peer.members && !existing.members) {
          existing.members = peer.members;
        }
      } else {
        convs.unshift({
          peerId: peer.id,
          peerUsername: peer.username,
          chatId: peer.chatId,
          mode: peer.mode,
          unreadCount: 0,
          isEmpty: true,
          lastMessageAt: null,
          hasUndelivered: false,
          isGroup: peer.isGroup,
          members: peer.members
        });
      }
      return [...convs];
    });

    // Close sidebar on mobile
    if (window.innerWidth < 768) sidebarOpen.set(false);
  }

  function handleSearch(e) {
    const query = e.target.value;
    clearTimeout(searchTimeout);

    if (query.length < 1) {
      searchResults = [];
      channelResults = [];
      searching = false;
      return;
    }

    searching = true;
    searchTimeout = setTimeout(async () => {
      try {
        const data = await searchUsers(query);
        searchResults = data.users || [];
      } catch {
        searchResults = [];
      }
      try {
        // The public channel directory shares the search box: a name typed
        // here is as likely to be a channel as a person, and two boxes for
        // one intent is worse than one list with two sections.
        const found = await searchChannels(query);
        channelResults = (found.channels || []).filter(
          (c) => !channels.some((mine) => mine.id === c.id)
        );
      } catch {
        channelResults = [];
      } finally {
        searching = false;
      }
    }, 300);
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
</script>

<svelte:window on:keydown={handleSlashShortcut} />

<!-- Below md, this is always the fixed full-screen layer (never display:none)
     so closing it can slide off-canvas instead of vanishing instantly — a
     hard cut read as a glitch next to the tab bar's otherwise native feel.
     Being always-fixed on mobile also means the safe-area top padding below
     is needed unconditionally there (fixed positioning is relative to the
     viewport, not App.svelte's <main> padding box, the same reason
     Chat.svelte's own root repeats it) but must NOT apply on desktop, where
     this stays in normal flow inside that already-padded <main> — hence the
     max-md: prefix rather than the previous $sidebarOpen-conditional style. -->
<aside class="w-full md:w-80 md:min-w-[320px] h-full flex flex-col bg-vault-surface border-r border-vault-border relative z-20 max-md:pb-14
  max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[42] max-md:pt-[max(env(safe-area-inset-top,0px),1.5rem)]
  max-md:transition-transform max-md:duration-300 max-md:ease-out motion-reduce:max-md:transition-none"
  class:max-md:translate-x-0={$sidebarOpen}
  class:max-md:-translate-x-full={!$sidebarOpen}
  inert={!$sidebarOpen && isNarrowViewport}
>
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-vault-border">
    <div class="flex items-center gap-2.5">
      <div class="w-8 h-8 rounded-xl bg-vault-surface border border-vault-border/50 flex items-center justify-center">
        <svg class="w-4 h-4 text-vault-text hover:text-vault-accent transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
          <path d="M12 22V12" stroke-dasharray="3 3" />
        </svg>
      </div>
      <div>
        <div class="text-sm font-semibold text-vault-text tracking-tight">Vault</div>
        <!-- Connected is the normal case and needs no commentary. A latency
             figure on screen at all times is a developer's readout, not a
             user's: it changes constantly, nobody acts on it, and it makes
             the header look like a diagnostic panel. What matters is being
             told when the connection is *not* working. -->
        <!-- One persistent live region wrapping both states, not one per
             branch — a screen reader may not pick up aria-live on an
             element that's freshly inserted along with the branch switch
             itself, only on text changing inside an element already
             present. -->
        <div aria-live="polite" aria-atomic="true">
          {#if !$wsConnected}
            <div class="text-[10px] text-vault-warning flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full bg-vault-warning animate-pulse"></div>
              Reconnecting…
            </div>
          {:else}
            <div class="text-[10px] text-vault-text-dim" title="Latency {ping}ms">
              End-to-end encrypted
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="flex items-center gap-1">
      <!-- One "New" menu instead of an icon per thing you can create. Four
           unlabelled glyphs in a 200px header is a guessing game, and every
           new feature made it worse; a menu absorbs the next one for free and
           says what each item actually is. -->
      <div class="relative">
        <button
          on:click={() => (showNewMenu = !showNewMenu)}
          class="p-2 rounded-lg transition-all focus:outline-none
            {showNewMenu ? 'text-vault-accent bg-vault-elevated' : 'text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated'}"
          title="New"
          aria-label="New"
          aria-expanded={showNewMenu}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {#if showNewMenu}
          <div
            class="absolute right-0 top-full mt-1 z-50 w-52 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg"
            use:clickOutside={() => (showNewMenu = false)}
          >
            <button
              on:click={() => { showNewMenu = false; showGroupModal = true; }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
            >
              <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              </svg>
              New group
            </button>

            <button
              on:click={() => { showNewMenu = false; showChannelModal = true; }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
            >
              <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 11l18-8-8 18-2-7-8-3z" />
              </svg>
              New channel
            </button>

            <button
              on:click={() => { showNewMenu = false; composeStoryRequested.set(true); }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
            >
              <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9" stroke-dasharray="3 3" />
                <path d="M12 9v6M9 12h6" stroke-linecap="round" />
              </svg>
              Post a story
            </button>

            <button
              on:click={() => { showNewMenu = false; openFolderEditor(); }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none text-left"
            >
              <svg class="w-4 h-4 text-vault-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              New folder
            </button>
          </div>
        {/if}
      </div>

      <!-- Hidden on mobile: the bottom tab bar's Settings tab (MobileTabBar,
           bound to the same showBackupModal) does this job there, and a
           second entry point to the identical modal is clutter, not choice. -->
      <button
        on:click={() => showBackupModal = true}
        class="max-md:hidden p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
        title="Settings"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      <!-- Hidden on mobile: reachable from the Account row in the Settings
           panel now, alongside who's signed in — the same move as the
           gear icon above. -->
      <button
        on:click={() => dispatch('logout')}
        class="max-md:hidden p-2 rounded-lg text-vault-text-dim hover:text-vault-danger hover:bg-vault-elevated transition-all focus:outline-none"
        title="Logout & wipe session"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>

  <DonateBar />

  <!-- Tab Navigation -->
  <div class="flex border-b border-vault-border text-xs px-2 pt-1 gap-1">
    <button
      on:click={() => activeTab = 'chats'}
      class="flex-1 py-2 font-semibold transition-all border-b-2 text-center cursor-pointer focus:outline-none
        {activeTab === 'chats' ? 'border-vault-accent text-vault-accent' : 'border-transparent text-vault-text-dim hover:text-vault-text'}"
    >
      Chats
    </button>
    <button
      on:click={() => activeTab = 'calls'}
      class="flex-1 py-2 font-semibold transition-all border-b-2 text-center cursor-pointer focus:outline-none
        {activeTab === 'calls' ? 'border-vault-accent text-vault-accent' : 'border-transparent text-vault-text-dim hover:text-vault-text'}"
    >
      Calls
    </button>
    <!-- The Wallet tab is hidden for now. Payments are out of scope, and a
         tab that opens a feature the product has decided against is the most
         prominent piece of dead UI in the app. The pane below and
         WalletSettings.svelte are left in place so this is one line to
         restore rather than a rebuild. -->
  </div>

  {#if activeTab === 'chats'}
    <!-- Search -->
    <div class="px-3 py-2">
      <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-vault-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          bind:this={searchInputEl}
          bind:value={searchQuery}
          on:input={handleSearch}
          placeholder="Search users... (press / to focus)"
          class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle"
          style="padding-left: 2.25rem; padding-right: 2.25rem;"
        />
        <!-- Opens the second search rather than showing it permanently. The
             two boxes look identical and do different things, which is a
             worse problem than one extra click. -->
        <button
          on:click={() => (showMessageSearch = !showMessageSearch)}
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors focus:outline-none
            {showMessageSearch || messageQuery ? 'text-vault-accent' : 'text-vault-text-dim hover:text-vault-text'}"
          title="Search inside conversations"
          aria-label="Search inside conversations"
          aria-pressed={showMessageSearch || Boolean(messageQuery)}
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Search Results -->
    {#if searchQuery}
      <div class="px-2 pb-2">
        {#if searching}
          <p class="text-[10px] text-vault-text-dim px-2 py-1">Searching…</p>
        {:else if searchResults.length === 0}
          <p class="text-[10px] text-vault-text-dim px-2 py-1">No users found</p>
        {:else}
        <div class="text-[10px] text-vault-text-dim uppercase tracking-wider px-2 py-1">Users</div>
        {#each searchResults as user}
          <div class="w-full flex items-center gap-1 animate-fade-in">
            <button
              on:click={() => startChatWith(user, 'secret')}
              class="flex-1 flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-vault-elevated transition-all text-left"
            >
              <div
                class="w-9 h-9 rounded-xl flex items-center justify-center text-vault-white font-semibold text-sm flex-shrink-0 shadow-inner"
                style="background: {getAvatarGradient(user.username)}"
              >
                {user.username[0].toUpperCase()}
              </div>
              <div>
                <div class="text-sm text-vault-text font-medium">{user.username}</div>
                <div class="text-[10px] text-vault-text-dim">Start chat · encrypted</div>
              </div>
            </button>
            <!-- Cloud sits beside the row rather than replacing it. Giving up
                 end-to-end encryption should be one deliberate tap, never
                 something you land on by accident — which is exactly why the
                 defaults are this way round and not the other. -->
            <button
              on:click={() => startChatWith(user, 'cloud')}
              class="flex-shrink-0 p-2.5 rounded-xl text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
              title="Start a cloud chat (syncs across your devices; the server can read it)"
              aria-label="Start a cloud chat with {user.username}"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
              </svg>
            </button>
          </div>
        {/each}
        {/if}
      </div>
    {/if}

    <!-- Conversations List -->
    <div class="flex-1 overflow-y-auto px-2 py-1">
      <!-- Message search is folded away until it is wanted. Two permanent
           search boxes stacked on each other made the sidebar look like a
           form, and most of the time you are looking for a person, not a
           phrase inside a conversation. -->
      {#if showMessageSearch || messageQuery}
        <div class="px-3 pb-2">
          <!-- svelte-ignore a11y-autofocus -->
          <input
            value={messageQuery}
            on:input={handleMessageSearch}
            placeholder="Search inside conversations..."
            autofocus
            class="input w-full text-xs py-1.5 bg-vault-elevated border-vault-border-subtle"
          />
        </div>
      {/if}

      {#if messageQuery.trim().length >= 2}
        <div class="px-2 pb-2">
          {#if searchingMessages}
            <p class="text-[10px] text-vault-text-dim px-1 py-2">Searching…</p>
          {:else if messageResults.length === 0}
            <p class="text-[10px] text-vault-text-dim px-1 py-2">No messages found</p>
          {:else}
            {#each messageResults as result (result.chatId + '-' + result.seq)}
              <button
                on:click={() => openResult(result)}
                class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-vault-elevated transition-colors focus:outline-none"
              >
                <div class="text-[10px] text-vault-accent">{result.senderUsername || 'Unknown'}</div>
                <div class="text-xs text-vault-text truncate">{result.body}</div>
              </button>
            {/each}
          {/if}
          {#if searchNotice}
            <p class="text-[9px] text-vault-text-dim px-1 pt-1.5 italic">{searchNotice}</p>
          {/if}
        </div>
      {/if}

      <Stories />

      {#if channelResults.length > 0}
        <div class="px-2 pb-2">
          <div class="text-[10px] uppercase tracking-wide text-vault-muted px-1 pb-1">
            Channels
          </div>
          {#each channelResults as channel (channel.id)}
            <button
              on:click={() => joinChannel(channel)}
              class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vault-elevated text-left focus:outline-none"
            >
              <div
                class="w-7 h-7 rounded-lg flex items-center justify-center text-vault-white text-[11px] font-semibold shrink-0"
                style="background: {getAvatarGradient(channel.title)}"
              >{channel.title[0].toUpperCase()}</div>
              <div class="min-w-0">
                <div class="text-xs text-vault-text truncate">{channel.title}</div>
                <div class="text-[9px] text-vault-text-dim">
                  @{channel.username} · {channel.subscribersCount} subscribers
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}

      {#if channels.length > 0 && !searchQuery}
        <div class="px-2 pb-2">
          <div class="flex items-center justify-between px-1 pb-1">
            <span class="text-[10px] uppercase tracking-wide text-vault-muted">Channels</span>
            <button
              on:click={() => (showChannelModal = true)}
              class="text-[10px] text-vault-accent hover:underline focus:outline-none"
              title="New channel"
            >New</button>
          </div>
          {#each channels as channel (channel.id)}
            <button
              on:click={() => openChannel(channel.id)}
              class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left focus:outline-none
                {$activeChannelId === channel.id ? 'bg-vault-accent/10' : 'hover:bg-vault-elevated'}"
            >
              <div
                class="w-7 h-7 rounded-lg flex items-center justify-center text-vault-white text-[11px] font-semibold shrink-0"
                style="background: {getAvatarGradient(channel.title)}"
              >{channel.title[0].toUpperCase()}</div>
              <div class="min-w-0 flex-1">
                <div class="text-xs text-vault-text truncate">{channel.title}</div>
                <div class="text-[9px] text-vault-text-dim">
                  {channel.subscribersCount} subscribers
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Folder tabs, only once there is a folder to switch between. An
           "All +" row with nothing to filter is a band of chrome advertising
           a feature; creating the first folder lives in the New menu. -->
      {#if folders.length > 0}
      <div class="flex items-center gap-1 px-2 pb-1.5 overflow-x-auto">
        <button
          on:click={() => (activeFolderId = null)}
          class="shrink-0 px-2 py-1 rounded-lg text-[11px] transition-colors focus:outline-none
            {activeFolderId === null ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim hover:text-vault-text'}"
        >All</button>
        {#each folders as folder (folder.id)}
          <button
            on:click={() => (activeFolderId = folder.id)}
            on:dblclick={() => openFolderEditor(folder)}
            title="Select, then use Edit to rename"
            class="shrink-0 px-2 py-1 rounded-lg text-[11px] transition-colors focus:outline-none
              {activeFolderId === folder.id ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim hover:text-vault-text'}"
          >{folder.title}</button>
        {/each}
        <button
          on:click={() => openFolderEditor()}
          class="shrink-0 px-2 py-1 rounded-lg text-[11px] text-vault-text-dim hover:text-vault-accent focus:outline-none"
          title="New folder"
        >+</button>
        {#if activeFolder}
          <button
            on:click={() => openFolderEditor(activeFolder)}
            class="shrink-0 px-2 py-1 rounded-lg text-[11px] text-vault-text-dim hover:text-vault-accent focus:outline-none"
            title="Edit this folder"
          >Edit</button>
          <button
            on:click={() => removeFolder(activeFolder.id)}
            class="shrink-0 px-2 py-1 rounded-lg text-[11px] text-vault-text-dim hover:text-vault-danger focus:outline-none"
            title="Delete this folder"
          >Delete</button>
        {/if}
      </div>
      {/if}

      <!-- Archived toggle -->
      {#if $conversations.some(c => c.archived) || showArchived}
        <button
          on:click={() => showArchived = !showArchived}
          class="w-full px-3 py-1.5 text-left text-[10px] text-vault-text-dim hover:text-vault-accent transition-colors focus:outline-none"
        >
          {showArchived ? '← Back to chats' : 'Archived chats →'}
        </button>
      {/if}

      {#if activeFolder && visibleConversations.length === 0 && !searchQuery}
        <div class="text-center py-12 px-4">
          <p class="text-xs text-vault-text-dim">Nothing in {activeFolder.title}</p>
          <button
            on:click={() => openFolderEditor(activeFolder)}
            class="text-[10px] text-vault-accent hover:underline mt-1 focus:outline-none"
          >Add chats to it</button>
        </div>
      {:else if $conversations.length === 0 && !searchQuery}
        <div class="text-center py-12 px-4">
          <div class="w-12 h-12 rounded-2xl bg-vault-elevated flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          <p class="text-xs text-vault-text-dim">No conversations yet</p>
          <p class="text-[10px] text-vault-text-dim mt-1">Search for a user to start chatting</p>
        </div>
      {:else}
        {#each visibleConversations as conv (conv.peerId)}
          {@const isActive = $activePeer?.id === conv.peerId}
          {@const isTyping = $typingUsers.has(conv.peerId)}
          {@const presenceEntry = conv.isGroup ? null : $presence.get(conv.peerId)}
          <div class="relative group/row">
          <button
            on:click={() => selectPeer({ id: conv.peerId, username: conv.peerUsername, isGroup: conv.isGroup, members: conv.members, createdBy: conv.createdBy, chatId: conv.chatId, mode: conv.mode, isEmpty: conv.isEmpty, lastMessageAt: conv.lastMessageAt, isForum: conv.isForum })}
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left mb-0.5 group
              {isActive ? 'bg-vault-accent/10 border border-vault-accent/20' : 'hover:bg-vault-elevated border border-transparent'}"
          >
            <div class="relative flex-shrink-0">
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center text-vault-white text-sm font-semibold transition-colors shadow-inner"
                style="background: {getAvatarGradient(conv.peerUsername)}"
              >
                {conv.peerUsername[0].toUpperCase()}
              </div>
              <!-- A numeric badge, now that chat_read_state tracks a real
                   count rather than a boolean "something is undelivered". -->
              {#if conv.unreadCount > 0}
                <div class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-vault-accent border-2 border-vault-surface flex items-center justify-center text-[10px] font-semibold text-vault-black leading-none">
                  {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                </div>
              {:else if conv.hasUndelivered}
                <div class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-vault-accent border-2 border-vault-surface"></div>
              {/if}
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium {isActive ? 'text-vault-accent' : 'text-vault-text'} truncate flex items-center gap-1">
                  <!-- Mark the exception, not the rule. One-to-one chats are
                       encrypted by default, so a lock on almost every row
                       carries no information — what a user needs to spot at a
                       glance is the conversation the server *can* read. Groups
                       are always cloud, so they are left unmarked: the badge
                       would be on every one of them and mean nothing. -->
                  {#if conv.mode === 'cloud' && !conv.isGroup}
                    <svg class="w-3 h-3 flex-shrink-0 text-vault-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Cloud chat — stored on the server">
                      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                    </svg>
                  {/if}
                  <span class="truncate">{conv.peerUsername}</span>
                </span>
                <span class="text-[10px] text-vault-text-dim flex-shrink-0 ml-2 flex items-center gap-1">
                  {#if conv.pinnedOrder}
                    <svg class="w-2.5 h-2.5 text-vault-accent" viewBox="0 0 24 24" fill="currentColor" aria-label="Pinned to top">
                      <path d="M16 3v6l2 3v2h-5v7l-1 1-1-1v-7H6v-2l2-3V3h8z" />
                    </svg>
                  {/if}
                  {#if isMuted(conv)}
                    <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Muted">
                      <path d="M18.63 13A17.9 17.9 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22" stroke-linecap="round" />
                    </svg>
                  {/if}
                  {formatTime(conv.lastMessageAt)}
                </span>
              </div>
              {#if presenceEntry?.online}
              <span class="sr-only">online</span>
            {/if}
            <div class="text-xs text-vault-text-dim truncate mt-0.5">
                {#if isTyping}
                  <span class="text-vault-accent flex items-center gap-1">
                    typing<span class="typing-dots"><span></span><span></span><span></span></span>
                  </span>
                {:else if conv.draft}
                  <span class="flex items-center gap-1 text-vault-warning">
                    <span class="italic">Draft:</span>
                    <span class="truncate">{conv.draft}</span>
                  </span>
                {:else if presenceEntry && describePresence(presenceEntry)}
                  <span class="flex items-center gap-1">
                    {#if presenceEntry.online}
                      <span class="w-1.5 h-1.5 rounded-full bg-vault-success inline-block"></span>
                    {/if}
                    {describePresence(presenceEntry)}
                  </span>
                {:else}
                  <span class="flex items-center gap-1">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                    Encrypted message
                  </span>
                {/if}
              </div>
            </div>
          </button>

          <!-- Per-chat menu. Sits outside the row button rather than inside
               it: nesting interactive elements breaks keyboard navigation and
               is invalid HTML. -->
          <button
            on:click|stopPropagation={() => openMenuFor = openMenuFor === conv.peerId ? null : conv.peerId}
            class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-vault-text-dim opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
            aria-label="Chat options for {conv.peerUsername}"
            title="Chat options"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>

          {#if openMenuFor === conv.peerId}
            <div
              class="absolute right-1.5 top-10 z-30 w-44 py-1 rounded-xl bg-vault-surface border border-vault-border shadow-lg"
              use:clickOutside={() => openMenuFor = null}
            >
              <button
                on:click={() => doPinToTop(conv)}
                class="w-full text-left px-3 py-1.5 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none"
              >
                {conv.pinnedOrder ? 'Unpin from top' : 'Pin to top'}
              </button>
              <button
                on:click={() => doMute(conv)}
                class="w-full text-left px-3 py-1.5 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none"
              >
                {isMuted(conv) ? 'Unmute' : 'Mute notifications'}
              </button>
              <button
                on:click={() => doArchive(conv)}
                class="w-full text-left px-3 py-1.5 text-xs text-vault-text hover:bg-vault-elevated transition-colors focus:outline-none"
              >
                {conv.archived ? 'Unarchive' : 'Archive'}
              </button>
            </div>
          {/if}
          </div>
        {/each}
      {/if}
    </div>
  {:else if activeTab === 'calls'}
    <!-- Recent Calls List -->
    <div class="flex-1 overflow-y-auto px-2 py-3 space-y-2">
      {#if $recentCalls.length === 0}
        <div class="text-center py-12 px-4">
          <div class="w-12 h-12 rounded-2xl bg-vault-elevated flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6 text-vault-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <p class="text-xs text-vault-text-dim">No recent calls</p>
          <p class="text-[10px] text-vault-text-dim mt-1">Start a call from an active chat thread</p>
        </div>
      {:else}
        {#each $recentCalls as call (call.id)}
          <div class="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-vault-elevated border border-vault-border rounded-xl animate-fade-in">
            <div class="flex items-center gap-3">
              <div
                class="w-9 h-9 rounded-xl flex items-center justify-center text-vault-white text-xs font-semibold shadow-inner"
                style="background: {getAvatarGradient(call.peerUsername)}"
              >
                {call.peerUsername[0].toUpperCase()}
              </div>
              <div>
                <div class="text-xs font-semibold text-vault-text">{call.peerUsername}</div>
                <div class="flex items-center gap-1.5 text-[9px] mt-0.5 text-vault-text-dim">
                  {#if call.direction === 'incoming'}
                    <span class="text-vault-accent">↙ Incoming</span>
                  {:else}
                    <span class="text-vault-warning">↗ Outgoing</span>
                  {/if}
                  <span>·</span>
                  <span class="font-mono text-vault-text-dim">{formatTime(call.timestamp)}</span>
                  <span>·</span>
                  <span class="capitalize
                    {call.status === 'completed' ? 'text-vault-accent' : ''}
                    {call.status === 'missed' ? 'text-vault-danger font-medium' : ''}
                    {call.status === 'rejected' ? 'text-vault-danger/60' : ''}
                    {call.status === 'ongoing' ? 'text-vault-accent animate-pulse' : ''}"
                  >
                    {call.status}
                  </span>
                </div>
              </div>
            </div>
            
            <!-- Quick Chat Action Button -->
            <button
              on:click={() => {
                selectPeer({ id: call.peerId, username: call.peerUsername, isGroup: false });
                activeTab = 'chats';
              }}
              class="p-2 bg-vault-surface hover:bg-vault-border text-vault-accent hover:text-vault-accent-hover rounded-lg transition-all focus:outline-none cursor-pointer border-none"
              title="Open Chat"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        {/each}
      {/if}
    </div>
  {:else if activeTab === 'wallet'}
    <div class="flex-1 overflow-y-auto p-4 text-left bg-vault-surface/40">
      <WalletSettings />
    </div>
  {/if}

  <!-- Footer. Hidden on mobile: it duplicated the identity strip once the
       bottom tab bar existed, stacking two bars at the bottom of a small
       screen. Moved into the Settings panel below instead. -->
  <div class="max-md:hidden px-4 py-3 border-t border-vault-border">
    <div class="flex items-center gap-2">
      <div
        class="w-7 h-7 rounded-lg flex items-center justify-center text-vault-white text-xs font-semibold flex-shrink-0 shadow-inner"
        style="background: {getAvatarGradient($currentUser?.username)}"
      >
        {$currentUser?.username?.[0]?.toUpperCase() || '?'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-medium text-vault-text truncate">{$currentUser?.username || 'Unknown'}</div>
        <div class="text-[10px] text-vault-text-dim">Session active</div>
      </div>
      <div class="shield-badge text-[9px] py-0.5 px-2">
        <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
        </svg>
        E2EE
      </div>
    </div>
  </div>
</aside>

{#if showBackupModal}
  <!-- Fills the screen on mobile rather than floating as a small centered
       card: Settings is reached from the bottom tab bar there now, which
       makes it a primary destination, not an occasional dialog. A 380px
       scroll box inside a card with a wide margin of bare backdrop above and
       below looked like a popup that happened to be tall, not a screen.
       max-md:pb-14 on the overlay reserves exactly the tab bar's height so
       it stays visible (and tappable) above the panel rather than the panel
       running underneath it. -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text max-md:p-0 max-md:pb-14 max-md:items-stretch"
    transition:fade={{ duration: 150 }}
  >
    <!-- max-md:pt-[env(...)] because max-md:h-full/fixed above escapes
         App.svelte's <main> padding-top the same way every other fixed
         full-screen panel in this app does — this one was missed when that
         pattern got applied elsewhere, and it's the primary Settings
         screen, so it's the most visible instance of the status-bar
         overlap bug. -->
    <!-- max-md:max-h-[100dvh], in addition to max-md:h-full: a percentage
         height can lag behind the actual visible viewport when Android
         resizes the window for the on-screen keyboard — dvh is the unit
         built specifically to track that correctly instead of a stale
         value, which is what pushed the Done button below the visible
         area. -->
    <div
      class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden max-md:max-w-full max-md:h-full max-md:max-h-[100dvh] max-md:rounded-none max-md:flex max-md:flex-col max-md:pt-[max(env(safe-area-inset-top,0px),1.5rem)]"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center max-md:flex-shrink-0">
        <h3 class="text-sm font-semibold text-vault-text">Settings</h3>
        <button on:click={() => showBackupModal = false} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close settings">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <DonateBar />

      <div class="p-5 space-y-4 text-left max-h-[380px] overflow-y-auto max-md:max-h-none max-md:flex-1">
        <!-- Account. Mobile-only: desktop already shows this in the
             sidebar's own footer, which stays visible there, so repeating
             it in the modal would just be the same information twice. -->
        <div class="md:hidden flex items-center gap-2.5 border-b border-vault-border pb-4">
          <div
            class="w-9 h-9 rounded-xl flex items-center justify-center text-vault-white text-sm font-semibold flex-shrink-0 shadow-inner"
            style="background: {getAvatarGradient($currentUser?.username)}"
          >
            {$currentUser?.username?.[0]?.toUpperCase() || '?'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-vault-text truncate">{$currentUser?.username || 'Unknown'}</div>
            <div class="text-[10px] text-vault-text-dim">Session active</div>
          </div>
          <div class="shield-badge text-[9px] py-0.5 px-2">
            <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
            </svg>
            E2EE
          </div>
          <button
            on:click={() => dispatch('logout')}
            class="p-2 rounded-lg text-vault-text-dim hover:text-vault-danger hover:bg-vault-elevated transition-all focus:outline-none flex-shrink-0"
            title="Logout & wipe session"
            aria-label="Logout & wipe session"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <ActiveSessions />

        <!-- Appearance Settings -->
        <div class="flex items-center justify-between border-b border-vault-border pb-4">
          <div>
            <span class="text-xs font-semibold text-vault-text block">Appearance</span>
            <span class="text-[10px] text-vault-text-dim">Toggle between dark and light interface</span>
          </div>
          <div class="flex items-center gap-1 bg-vault-elevated border border-vault-border rounded-xl p-0.5">
            <button
              on:click={() => applyTheme('dark')}
              class="py-1 px-3 rounded-lg text-[10px] font-semibold transition-all cursor-pointer focus:outline-none
                {theme === 'dark' ? 'bg-vault-accent text-vault-black' : 'text-vault-text-dim hover:text-vault-text'}"
            >
              Dark
            </button>
            <button
              on:click={() => applyTheme('light')}
              class="py-1 px-3 rounded-lg text-[10px] font-semibold transition-all cursor-pointer focus:outline-none
                {theme === 'light' ? 'bg-vault-accent text-vault-black' : 'text-vault-text-dim hover:text-vault-text'}"
            >
              Light
            </button>
          </div>
        </div>

        {#if biometricEnabled && !$localBackupEnabled}
          <button
            on:click={async () => {
              try {
                const credId = localStorage.getItem(`vault_bio_cred_id_${$currentUser.id}`);
                if (!credId) throw new Error('Biometric credential not found. Please re-enable Biometric Vault Unlock.');
                const prfKey = await authenticateBiometric(credId, $currentUser.salt);
                localBackupKey.set(prfKey);
                localBackupPassphrase.set('BIOMETRIC_UNLOCKED');
                localBackupEnabled.set(true);
                await restoreBackup();
                showToast('Vault unlocked successfully using biometrics!', { type: 'success' });
              } catch (err) {
                console.error('Biometric unlock failed:', err);
                showToast(err.message || 'Biometric unlock failed');
              }
            }}
            class="w-full py-2 bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-xs rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Biometric Unlock Vault
          </button>
        {/if}

        <div class="flex items-center justify-between">
          <div>
            <span class="text-xs font-semibold text-vault-text block">Biometric Unlock</span>
            <span class="text-[10px] text-vault-text-dim font-normal block">
              {biometricSupported ? 'Use fingerprint or face recognition' : 'Not available on this device or app version'}
            </span>
          </div>
          {#if biometricSupported}
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={biometricEnabled}
                on:change={toggleBiometric}
                class="sr-only peer"
              />
              <div class="w-9 h-5 bg-vault-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-vault-text after:border-vault-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-vault-accent"></div>
            </label>
          {/if}
        </div>

        <div class="flex items-center justify-between">
          <div>
            <span class="text-xs font-semibold text-vault-text block">Local Encrypted Backup</span>
            <span class="text-[10px] text-vault-text-dim">Caches history securely inside IndexedDB</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={$localBackupEnabled}
              on:change={async (e) => {
                const enabled = e.target.checked;
                if (!enabled) {
                  localBackupEnabled.set(false);
                  localBackupPassphrase.set('');
                  localBackupKey.set(null);
                  clearBackup();
                  setTimeout(syncVault, 100);
                } else {
                  // Unchecked immediately, then re-checked on success — the
                  // toggle shouldn't sit in the "on" position while the
                  // passphrase modal (a separate overlay) is still up
                  // deciding whether this actually turns on.
                  e.target.checked = false;
                  const phrase = await promptPassphrase({
                    title: 'Encrypt Local Backup',
                    message: 'This password encrypts your local message history cache.',
                    mode: 'create',
                  });
                  if (phrase) {
                    localBackupPassphrase.set(phrase);
                    localBackupEnabled.set(true);
                    setTimeout(syncVault, 100);
                  }
                }
              }}
              class="sr-only peer"
            />
            <div class="w-9 h-5 bg-vault-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-vault-text after:border-vault-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-vault-accent"></div>
          </label>
        </div>

        {#if $localBackupEnabled}
          <div class="space-y-1">
            <span class="text-[10px] text-vault-text-dim block uppercase tracking-wider font-semibold">Current Backup Passphrase</span>
            <div class="flex items-center justify-between gap-2 px-3 py-2 bg-vault-elevated border border-vault-border rounded-xl">
              <span class="text-xs font-mono truncate">{$localBackupPassphrase.replace(/./g, '•')}</span>
              <button
                on:click={async () => {
                  const phrase = await promptPassphrase({
                    title: 'Change Backup Passphrase',
                    message: 'This replaces the password encrypting your local message history cache.',
                    mode: 'create',
                  });
                  if (phrase) {
                    localBackupPassphrase.set(phrase);
                    setTimeout(syncVault, 100);
                  }
                }}
                class="text-[10px] text-vault-accent hover:underline focus:outline-none"
              >
                Change
              </button>
            </div>
          </div>
        {/if}

        <div class="text-[10px] text-vault-text-dim leading-relaxed bg-vault-elevated p-3 border border-vault-border rounded-xl">
          🔒 <strong class="text-vault-text-secondary">Zero-Knowledge Security:</strong> Your backup is encrypted on your client using PBKDF2/AES-GCM before writing to storage. The server never receives your passphrase or decrypted message logs.
        </div>

        <div class="border-t border-vault-border pt-4 space-y-3">
          <span class="text-xs font-semibold text-vault-text block">Identity Key Backup</span>
          <span class="text-[10px] text-vault-text-dim block">Export or import your E2EE keys to preserve stable safety numbers.</span>
          <div class="flex gap-2">
            <button
              on:click={exportIdentity}
              class="py-1.5 px-3 text-[10px] bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer"
            >
              Export Keys
            </button>
            <label
              class="py-1.5 px-3 text-[10px] bg-vault-elevated text-vault-text hover:bg-vault-border border border-vault-border font-semibold rounded-xl cursor-pointer text-center"
            >
              Import Keys
              <input type="file" accept=".vaultkey" on:change={importIdentity} class="hidden" />
            </label>
          </div>
        </div>

        <div class="border-t border-vault-border pt-4 space-y-3">
          <span class="text-xs font-semibold text-vault-text block">Zero-Knowledge Cloud Backup</span>
          <span class="text-[10px] text-vault-text-dim block">Vault automatically backs up your encrypted keys & sessions to the cloud. You can also trigger a manual sync.</span>
          <div class="flex items-center justify-between p-2.5 bg-vault-black/30 border border-vault-border rounded-xl w-full select-none">
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] text-vault-text-dim uppercase tracking-wider font-bold flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full {isSyncing ? 'bg-vault-warning animate-pulse' : (syncError ? 'bg-vault-danger' : 'bg-vault-accent')}"></span>
                Status: {isSyncing ? 'Syncing...' : (syncError ? syncError : 'Synchronized')}
              </span>
              <span class="text-[9px] text-vault-text-dim">Last Synced: {lastSyncedTime}</span>
            </div>
            <button
              on:click={triggerManualSync}
              disabled={isSyncing}
              class="py-1.5 px-3 text-[10px] bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold rounded-xl cursor-pointer flex items-center gap-1 border-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {#if isSyncing}
                <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                </svg>
              {/if}
              Sync Now
            </button>
          </div>
        </div>

        <div class="border-t border-vault-border pt-4 space-y-3">
          <span class="text-xs font-semibold text-vault-text block">QR Sync (Multi-Device)</span>
          <span class="text-[10px] text-vault-text-dim block">Instant login on another device by scanning a secure transient QR sync link.</span>
          <button
            on:click={initiateQrSync}
            class="py-1.5 px-3 text-[10px] bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer focus:outline-none"
          >
            Generate Sync QR
          </button>
        </div>
      </div>

      <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end max-md:flex-shrink-0">
        <button
          on:click={() => showBackupModal = false}
          class="btn-primary py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl"
        >
          Done
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showSyncModal}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden text-center"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
        <h3 class="text-sm font-semibold text-vault-text">Device QR Sync</h3>
        <button on:click={() => showSyncModal = false} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close sync modal">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="p-6 flex flex-col items-center gap-4">
        <p class="text-xs text-vault-text-dim leading-relaxed">
          Scan this QR code with another device or open the link to instantly sync your keys and session.
        </p>
        
        {#if syncQrUrl}
          <div class="p-3 bg-white rounded-2xl border border-vault-border shadow-inner">
            <img src={syncQrUrl} alt="Sync QR Code" class="w-[200px] h-[200px]" />
          </div>
        {/if}

        <div class="w-full mt-2 space-y-1 text-left">
          <span class="text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold">Direct Sync Link</span>
          <div class="flex items-center gap-2 p-2.5 bg-vault-elevated border border-vault-border rounded-xl">
            <input
              type="text"
              readonly
              value={syncLink}
              class="w-full bg-transparent border-none text-[10px] font-mono text-vault-text-dim focus:outline-none select-all"
            />
            <button
              on:click={async () => {
                try {
                  await navigator.clipboard.writeText(syncLink);
                  showToast('Sync link copied to clipboard!', { type: 'success' });
                } catch {
                  // The field above is readonly + select-all, so manual
                  // copy is still available without the Clipboard API.
                  showToast('Could not copy automatically — select the link above and copy it manually.', { type: 'info', duration: 6000 });
                }
              }}
              class="text-[10px] text-vault-accent hover:underline font-semibold focus:outline-none bg-transparent border-none cursor-pointer"
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end">
        <button
          on:click={() => showSyncModal = false}
          class="btn-primary py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl"
        >
          Close
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showGroupModal}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden text-left"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
        <h3 class="text-sm font-semibold text-vault-text">Create E2EE Group</h3>
        <button on:click={() => { showGroupModal = false; groupMembersSearch = []; groupMembersQuery = ''; groupName = ''; groupAddedUsers = []; }} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close group creation">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="p-5 space-y-4">
        <div>
          <label for="group-name-input" class="text-xs font-semibold text-vault-text block mb-1">Group Name</label>
          <input
            id="group-name-input"
            type="text"
            bind:value={groupName}
            placeholder="E.g., Secret Project Alpha"
            maxlength="128"
            class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle"
          />
        </div>

        <div>
          <label for="group-members-input" class="text-xs font-semibold text-vault-text block mb-1">Add Members</label>
          <div class="flex gap-2 mb-2">
            <input
              id="group-members-input"
              type="text"
              placeholder="Search username..."
              on:input={searchGroupMembers}
              class="input py-1.5 text-[11px] bg-vault-elevated border-vault-border-subtle"
            />
          </div>
          
          {#if groupMembersSearch.length > 0}
            <div class="bg-vault-elevated border border-vault-border rounded-xl max-h-32 overflow-y-auto p-1.5 space-y-1">
              {#each groupMembersSearch as user}
                <button
                  on:click={() => addGroupUser(user)}
                  class="w-full flex items-center justify-between text-left px-2 py-1.5 hover:bg-vault-surface rounded-lg text-xs"
                >
                  <span>{user.username}</span>
                  <span class="text-[10px] text-vault-accent hover:underline">Add</span>
                </button>
              {/each}
            </div>
          {:else if groupMembersQuery.length > 0}
            <p class="text-[10px] text-vault-text-dim px-2 py-1">No users found</p>
          {/if}

          {#if groupAddedUsers.length > 0}
            <div class="flex flex-wrap gap-1.5 mt-2">
              {#each groupAddedUsers as user}
                <span class="flex items-center gap-1 px-2 py-0.5 bg-vault-accent/10 border border-vault-accent/20 rounded-full text-[10px] text-vault-accent">
                  {user.username}
                  <button
                    on:click={() => removeGroupUser(user)}
                    class="hover:text-vault-danger font-semibold bg-transparent border-none p-1.5 -m-1 cursor-pointer text-vault-accent leading-none"
                    aria-label="Remove {user.username}"
                  >
                    ×
                  </button>
                </span>
              {/each}
            </div>
          {/if}
        </div>

        <!-- The "Join Group with Key" box lived here. It took a permanent,
             unrevocable bearer secret; invite links replaced it and the
             column is gone as of migration 0016. Joining now happens by
             opening an invite link, which App.svelte redeems. -->
      </div>

      <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
        <button
          on:click={() => { showGroupModal = false; groupMembersSearch = []; groupMembersQuery = ''; groupName = ''; groupAddedUsers = []; }}
          class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl focus:outline-none"
        >
          Cancel
        </button>
        <button
          on:click={submitCreateGroup}
          disabled={!groupName.trim() || groupAddedUsers.length === 0 || groupBusy}
          class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
        >
          {groupBusy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showFolderEditor}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    on:click|self={() => (showFolderEditor = false)}
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm rounded-2xl glass-strong border border-vault-border p-4 flex flex-col gap-3"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-vault-text">
          {editingFolder ? 'Edit folder' : 'New folder'}
        </h3>
        <button
          on:click={() => (showFolderEditor = false)}
          class="text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Close"
        >✕</button>
      </div>

      <input
        bind:value={folderDraftTitle}
        placeholder="Folder name"
        maxlength="60"
        class="w-full px-3 py-2 rounded-lg bg-vault-elevated border border-vault-border text-sm text-vault-text focus:outline-none focus:border-vault-accent"
      />

      <div class="max-h-56 overflow-y-auto flex flex-col gap-0.5">
        <!-- Only chats with a `chats` row can be filed: a conversation that
             exists implicitly, before its first message, has no id to store. -->
        {#each $conversations.filter(c => c.chatId) as conv (conv.peerId)}
          <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vault-elevated cursor-pointer">
            <input
              type="checkbox"
              checked={folderDraftChats.has(conv.chatId)}
              on:change={() => toggleFolderChat(conv.chatId)}
            />
            <span class="text-xs text-vault-text truncate">{conv.peerUsername}</span>
          </label>
        {/each}
      </div>

      <div class="flex justify-end gap-2">
        <button
          on:click={() => (showFolderEditor = false)}
          class="px-3 py-1.5 rounded-lg text-xs text-vault-text-dim hover:text-vault-text focus:outline-none"
        >Cancel</button>
        <button
          on:click={saveFolder}
          disabled={folderBusy || !folderDraftTitle.trim()}
          class="px-3 py-1.5 rounded-lg text-xs bg-vault-accent text-vault-black font-medium disabled:opacity-50 focus:outline-none"
        >{folderBusy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

{#if showChannelModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    on:click|self={() => (showChannelModal = false)}
    transition:fade={{ duration: 150 }}
  >
    <div
      class="w-full max-w-sm rounded-2xl glass-strong border border-vault-border p-4 flex flex-col gap-3"
      transition:scale={{ duration: 200, start: 0.95, opacity: 0 }}
    >
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-vault-text">New channel</h3>
        <button
          on:click={() => (showChannelModal = false)}
          class="text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Close"
        >✕</button>
      </div>

      <input
        bind:value={channelTitle}
        placeholder="Channel name"
        maxlength="128"
        class="w-full px-3 py-2 rounded-lg bg-vault-elevated border border-vault-border text-sm text-vault-text focus:outline-none focus:border-vault-accent"
      />

      <div>
        <input
          bind:value={channelUsername}
          placeholder="Public username (optional)"
          maxlength="32"
          class="w-full px-3 py-2 rounded-lg bg-vault-elevated border border-vault-border text-sm text-vault-text focus:outline-none focus:border-vault-accent"
        />
        <!-- Said plainly, because the difference is the whole privacy model
             of the channel: a username makes it readable by anyone. -->
        <p class="text-[10px] text-vault-muted mt-1">
          With a username anyone can find and read this channel. Leave it blank
          to keep it invite-only.
        </p>
      </div>

      <p class="text-[10px] text-vault-muted">
        Posts are deleted 24 hours after publishing, like every other message
        here. A channel is a live feed, not an archive.
      </p>

      {#if channelError}
        <div class="text-[11px] text-vault-danger">{channelError}</div>
      {/if}

      <div class="flex justify-end gap-2">
        <button
          on:click={() => (showChannelModal = false)}
          class="px-3 py-1.5 rounded-lg text-xs text-vault-text-dim hover:text-vault-text focus:outline-none"
        >Cancel</button>
        <button
          on:click={makeChannel}
          disabled={channelBusy || !channelTitle.trim()}
          class="px-3 py-1.5 rounded-lg text-xs bg-vault-accent text-vault-black font-medium disabled:opacity-50 focus:outline-none"
        >{channelBusy ? 'Creating…' : 'Create'}</button>
      </div>
    </div>
  </div>
{/if}
