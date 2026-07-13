<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { currentUser, activePeer, sidebarOpen, localBackupEnabled, localBackupPassphrase, localBackupKey, loginPassword, identityKeyPair, signedPrekeyPair, activeCall, recentCalls } from '../lib/stores/session.js';
  import { conversations, typingUsers, clearBackup, restoreBackup } from '../lib/stores/messages.js';
  import { searchUsers, createGroup as createGroupApi, saveEncryptedVault, joinGroup } from '../lib/api/http.js';
  import { wsConnected } from '../lib/api/ws.js';
  import { getAvatarGradient } from '../lib/avatar.js';
  import { exportIdentityBackup, importIdentityBackup, encryptIdentityVault } from '../lib/crypto/keys.js';
  import { isPrfSupported, registerBiometric, authenticateBiometric } from '../lib/crypto/webauthn.js';

  import { syncCloudVault } from '../lib/crypto/sync.js';
  import WalletSettings from './WalletSettings.svelte';

  let showBackupModal = false;
  let theme = localStorage.getItem('vault_theme') || 'dark';
  let settingsTab = 'general';
  let isSyncing = false;
  let syncError = '';
  let lastSyncedTime = new Date().toLocaleTimeString();

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
    if (newTheme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
  }

  const dispatch = createEventDispatcher();

  let biometricSupported = false;
  let biometricEnabled = false;

  onMount(() => {
    biometricSupported = isPrfSupported();
    if ($currentUser) {
      biometricEnabled = localStorage.getItem(`vault_bio_enabled_${$currentUser.id}`) === 'true';
    }
  });

  async function toggleBiometric(e) {
    const enabled = e.target.checked;
    if (enabled) {
      try {
        const result = await registerBiometric($currentUser.username, $currentUser.salt);
        localStorage.setItem(`vault_bio_enabled_${$currentUser.id}`, 'true');
        localStorage.setItem(`vault_bio_cred_id_${$currentUser.id}`, result.credentialId);
        
        // Update local backup keys using derived WebAuthn PRF key
        localBackupKey.set(result.prfKey);
        localBackupPassphrase.set('BIOMETRIC_UNLOCKED');
        localBackupEnabled.set(true);
        biometricEnabled = true;
        alert('Biometric Vault Unlock enabled successfully!');
      } catch (err) {
        console.error('Biometric registration failed:', err);
        alert(err.message || 'Biometric registration failed');
        e.target.checked = false;
        biometricEnabled = false;
      }
    } else {
      localStorage.removeItem(`vault_bio_enabled_${$currentUser.id}`);
      localStorage.removeItem(`vault_bio_cred_id_${$currentUser.id}`);
      localBackupEnabled.set(false);
      localBackupPassphrase.set('');
      localBackupKey.set(null);
      biometricEnabled = false;
      alert('Biometric Vault Unlock disabled.');
      setTimeout(syncVault, 100);
    }
  }

  async function syncVault() {
    const password = get(loginPassword);
    if (!password) {
      console.warn('Login password not available for ZK vault sync.');
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
      }, password);

      await saveEncryptedVault(encryptedVault);
      console.log('[Sync] Zero-knowledge identity vault synchronized.');
    } catch (err) {
      console.error('[Sync] Failed to synchronize identity vault:', err);
    }
  }

  let searchQuery = '';
  let searchResults = [];
  let searching = false;

  let showGroupModal = false;
  let activeTab = 'chats';
  let groupName = '';
  let groupAddedUsers = [];
  let groupMembersSearch = [];
  let groupSearchTimeout;

  async function searchGroupMembers(e) {
    const q = e.target.value;
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

  async function submitCreateGroup() {
    try {
      const memberIds = groupAddedUsers.map(u => u.id);
      const res = await createGroupApi(groupName, memberIds);
      
      conversations.update(convs => {
        convs.unshift({
          peerId: `group-${res.id}`,
          peerUsername: res.name,
          isGroup: true,
          members: res.members,
          lastMessageAt: null,
          hasUndelivered: false
        });
        return [...convs];
      });

      selectPeer({
        id: `group-${res.id}`,
        username: res.name,
        isGroup: true,
        members: res.members
      });

      showGroupModal = false;
      groupName = '';
      groupAddedUsers = [];
      groupMembersSearch = [];
    } catch (err) {
      console.error('Failed to create group:', err);
      alert('Failed to create group');
    }
  }

  let joinKey = '';

  async function submitJoinGroup() {
    try {
      const res = await joinGroup(joinKey);
      
      conversations.update(convs => {
        const filtered = convs.filter(c => c.peerId !== `group-${res.id}`);
        filtered.unshift({
          peerId: `group-${res.id}`,
          peerUsername: res.name,
          isGroup: true,
          members: res.members,
          joinKey: res.joinKey,
          lastMessageAt: null,
          hasUndelivered: false
        });
        return filtered;
      });

      selectPeer({
        id: `group-${res.id}`,
        username: res.name,
        isGroup: true,
        members: res.members,
        joinKey: res.joinKey
      });

      showGroupModal = false;
      joinKey = '';
      alert(`Successfully joined group: ${res.name}!`);
    } catch (err) {
      console.error('Failed to join group:', err);
      alert(err.message || 'Failed to join group');
    }
  }

  // Identity key backup methods
  async function exportIdentity() {
    if (!$identityKeyPair || !$signedPrekeyPair) {
      alert('Keys not generated yet');
      return;
    }
    const passphrase = prompt('Create a password to encrypt your identity key backup file:');
    if (!passphrase) return;
    try {
      const encrypted = await exportIdentityBackup($identityKeyPair, $identityKeyPair.ecdsa, passphrase);
      
      const blob = new Blob([encrypted], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${$currentUser.username}_identity.vaultkey`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export keys:', e);
      alert('Failed to export identity keys');
    }
  }

  async function importIdentity(e) {
    const file = e.target.files[0];
    if (!file) return;
    const passphrase = prompt('Enter the password to decrypt your identity key file:');
    if (!passphrase) return;
    try {
      const text = await file.text();
      const restored = await importIdentityBackup(text, passphrase);
      
      identityKeyPair.set({
        publicKey: restored.dh.publicKey,
        privateKey: restored.dh.privateKey,
        ecdsa: restored.ecdsa
      });
      alert('Identity keys imported successfully! Safety numbers restored.');
      showBackupModal = false;
      window.location.reload();
    } catch (err) {
      console.error('Failed to import keys:', err);
      alert('Incorrect password or invalid identity file');
    }
  }
  let searchTimeout;

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

<aside class="w-full md:w-80 md:min-w-[320px] h-full flex flex-col bg-vault-surface border-r border-vault-border relative z-20"
  class:max-md:hidden={!$sidebarOpen}
  class:max-md:fixed={$sidebarOpen}
  class:max-md:inset-y-0={$sidebarOpen}
  class:max-md:left-0={$sidebarOpen}
  class:max-md:z-50={$sidebarOpen}
>
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-vault-border">
    <div class="flex items-center gap-2.5">
      <div class="w-8 h-8 rounded-xl bg-vault-accent/10 flex items-center justify-center">
        <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
        </svg>
      </div>
      <div>
        <div class="text-sm font-semibold text-vault-text tracking-tight">Vault</div>
        <div class="text-[10px] text-vault-text-dim flex items-center gap-1">
          <div class="w-1 h-1 rounded-full {$wsConnected ? 'bg-vault-accent' : 'bg-vault-warning'}"></div>
          {$wsConnected ? 'Encrypted' : 'Connecting'}
        </div>
      </div>
    </div>

    <div class="flex items-center gap-1">
      <button
        on:click={() => showGroupModal = true}
        class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
        title="Create Group Chat"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </button>

      <button
        on:click={() => showBackupModal = true}
        class="p-2 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-all focus:outline-none"
        title="Settings"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      <button
        on:click={() => dispatch('logout')}
        class="p-2 rounded-lg text-vault-text-dim hover:text-vault-danger hover:bg-vault-elevated transition-all focus:outline-none"
        title="Logout & wipe session"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>

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
    <button
      on:click={() => activeTab = 'wallet'}
      class="flex-1 py-2 font-semibold transition-all border-b-2 text-center cursor-pointer focus:outline-none
        {activeTab === 'wallet' ? 'border-vault-accent text-vault-accent' : 'border-transparent text-vault-text-dim hover:text-vault-text'}"
    >
      Wallet
    </button>
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
          bind:value={searchQuery}
          on:input={handleSearch}
          placeholder="Search users..."
          class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle"
          style="padding-left: 2.25rem;"
        />
      </div>
    </div>

    <!-- Search Results -->
    {#if searchQuery && searchResults.length > 0}
      <div class="px-2 pb-2">
        <div class="text-[10px] text-vault-text-dim uppercase tracking-wider px-2 py-1">Users</div>
        {#each searchResults as user}
          <button
            on:click={() => selectPeer({ id: user.id, username: user.username })}
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-vault-elevated transition-all text-left animate-fade-in"
          >
            <div
              class="w-9 h-9 rounded-xl flex items-center justify-center text-vault-white font-semibold text-sm flex-shrink-0 shadow-inner"
              style="background: {getAvatarGradient(user.username)}"
            >
              {user.username[0].toUpperCase()}
            </div>
            <div>
              <div class="text-sm text-vault-text font-medium">{user.username}</div>
              <div class="text-[10px] text-vault-text-dim">Start encrypted chat</div>
            </div>
          </button>
        {/each}
      </div>
    {/if}

    <!-- Conversations List -->
    <div class="flex-1 overflow-y-auto px-2 py-1">
      {#if $conversations.length === 0 && !searchQuery}
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
        {#each $conversations as conv (conv.peerId)}
          {@const isActive = $activePeer?.id === conv.peerId}
          {@const isTyping = $typingUsers.has(conv.peerId)}
          <button
            on:click={() => selectPeer({ id: conv.peerId, username: conv.peerUsername, isGroup: conv.isGroup, members: conv.members, joinKey: conv.joinKey })}
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
              {#if conv.hasUndelivered}
                <div class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-vault-accent border-2 border-vault-surface"></div>
              {/if}
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium {isActive ? 'text-vault-accent' : 'text-vault-text'} truncate">
                  {conv.peerUsername}
                </span>
                <span class="text-[10px] text-vault-text-dim flex-shrink-0 ml-2">
                  {formatTime(conv.lastMessageAt)}
                </span>
              </div>
              <div class="text-xs text-vault-text-dim truncate mt-0.5">
                {#if isTyping}
                  <span class="text-vault-accent flex items-center gap-1">
                    typing<span class="typing-dots"><span></span><span></span><span></span></span>
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

  <!-- Footer -->
  <div class="px-4 py-3 border-t border-vault-border">
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
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
    <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up">
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
        <h3 class="text-sm font-semibold text-vault-text">Local Backup Settings</h3>
        <button on:click={() => showBackupModal = false} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close settings">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Settings Tab Switcher -->
      <div class="flex border-b border-vault-border text-xs px-5 pt-2 gap-1 bg-vault-surface">
        <button
          on:click={() => settingsTab = 'general'}
          class="flex-1 py-2 font-semibold transition-all border-b-2 text-center cursor-pointer focus:outline-none
            {settingsTab === 'general' ? 'border-vault-accent text-vault-accent' : 'border-transparent text-vault-text-dim hover:text-vault-text'}"
        >
          General
        </button>
        <button
          on:click={() => settingsTab = 'wallet'}
          class="flex-1 py-2 font-semibold transition-all border-b-2 text-center cursor-pointer focus:outline-none
            {settingsTab === 'wallet' ? 'border-vault-accent text-vault-accent' : 'border-transparent text-vault-text-dim hover:text-vault-text'}"
        >
          DeFi Wallet
        </button>
      </div>

      {#if settingsTab === 'general'}
        <div class="p-5 space-y-4 text-left max-h-[380px] overflow-y-auto">
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
                  alert('Vault unlocked successfully using biometrics!');
                } catch (err) {
                  console.error('Biometric unlock failed:', err);
                  alert(err.message || 'Biometric unlock failed');
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

          {#if biometricSupported}
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-semibold text-vault-text block">Biometric Unlock</span>
                <span class="text-[10px] text-vault-text-dim font-normal block">Use fingerprint or face recognition</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={biometricEnabled}
                  on:change={toggleBiometric}
                  class="sr-only peer"
                />
                <div class="w-9 h-5 bg-vault-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-vault-text after:border-vault-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-vault-accent"></div>
              </label>
            </div>
          {/if}

          <div class="flex items-center justify-between">
            <div>
              <span class="text-xs font-semibold text-vault-text block">Local Encrypted Backup</span>
              <span class="text-[10px] text-vault-text-dim">Caches history securely inside IndexedDB</span>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={$localBackupEnabled}
                on:change={(e) => {
                  const enabled = e.target.checked;
                  if (!enabled) {
                    localBackupEnabled.set(false);
                    localBackupPassphrase.set('');
                    localBackupKey.set(null);
                    clearBackup();
                    setTimeout(syncVault, 100);
                  } else {
                    const phrase = prompt('Enter a passphrase to encrypt your local database:');
                    if (phrase) {
                      localBackupPassphrase.set(phrase);
                      localBackupEnabled.set(true);
                      setTimeout(syncVault, 100);
                    } else {
                      e.target.checked = false;
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
                  on:click={() => {
                    const phrase = prompt('Enter new passphrase:');
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
            🔒 **Zero-Knowledge Security:** Your backup is encrypted on your client using PBKDF2/AES-GCM before writing to storage. The server never receives your passphrase or decrypted message logs.
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
        </div>
      {:else}
        <div class="p-5 space-y-4 text-left max-h-[380px] overflow-y-auto">
          <WalletSettings />
        </div>
      {/if}

      <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end">
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

{#if showGroupModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
    <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
      <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
        <h3 class="text-sm font-semibold text-vault-text">Create E2EE Group</h3>
        <button on:click={() => { showGroupModal = false; groupMembersSearch = []; groupName = ''; groupAddedUsers = []; }} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close group creation">
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
          {/if}

          {#if groupAddedUsers.length > 0}
            <div class="flex flex-wrap gap-1.5 mt-2">
              {#each groupAddedUsers as user}
                <span class="flex items-center gap-1 px-2 py-0.5 bg-vault-accent/10 border border-vault-accent/20 rounded-full text-[10px] text-vault-accent">
                  {user.username}
                  <button
                    on:click={() => removeGroupUser(user)}
                    class="hover:text-vault-danger font-semibold bg-transparent border-none p-0 cursor-pointer text-vault-accent"
                  >
                    ×
                  </button>
                </span>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Join Group with Key -->
        <div class="border-t border-vault-border pt-4">
          <label for="group-join-key-input" class="text-xs font-semibold text-vault-text block mb-1">Join Group with Key</label>
          <div class="flex gap-2">
            <input
              id="group-join-key-input"
              type="text"
              bind:value={joinKey}
              placeholder="Paste group join key..."
              class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle"
            />
            <button
              on:click={submitJoinGroup}
              disabled={!joinKey.trim()}
              class="py-2 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none whitespace-nowrap cursor-pointer"
            >
              Join
            </button>
          </div>
        </div>
      </div>

      <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
        <button
          on:click={() => { showGroupModal = false; groupMembersSearch = []; groupName = ''; groupAddedUsers = []; }}
          class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl focus:outline-none"
        >
          Cancel
        </button>
        <button
          on:click={submitCreateGroup}
          disabled={!groupName.trim() || groupAddedUsers.length === 0}
          class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
        >
          Create
        </button>
      </div>
    </div>
  </div>
{/if}
