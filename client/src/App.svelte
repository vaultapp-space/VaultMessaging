<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { currentUser, isLoading, setUser, activeView, identityKeyPair, signedPrekeyPair, oneTimePrekeyPairs, loginPassword, localBackupKey, localBackupPassphrase, localBackupEnabled, ratchetSessions, groupSenderKeys } from './lib/stores/session.js';
  import { getMe, replenishPrekeys } from './lib/api/http.js';
  import { decryptSyncPayload, generateOneTimePrekeys } from './lib/crypto/keys.js';
  import { fromBase64 } from './lib/crypto/utils.js';
  import { RatchetSession } from './lib/crypto/ratchet.js';
  import { SenderKeySession } from './lib/crypto/senderkeys.js';
  import Auth from './components/Auth.svelte';
  import Chat from './components/Chat.svelte';
  import Landing from './components/Landing.svelte';
  import VaultCoin from './components/VaultCoin.svelte';

  // Initialize theme from localStorage immediately (no flicker)
  const initialTheme = localStorage.getItem('vault_theme') || 'dark';
  if (initialTheme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }

  let mounted = false;
  let wakeLock = null;

  async function requestWakeLock() {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (wakeLock) return; // already acquired
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        console.log('Screen Wake Lock was released');
      });
      console.log('Screen Wake Lock is active');
    } catch (err) {
      console.warn(`Failed to request Screen Wake Lock: ${err.name}, ${err.message}`);
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try {
        await wakeLock.release();
        wakeLock = null;
        console.log('Screen Wake Lock released manually');
      } catch (err) {
        console.error('Failed to release wake lock:', err);
      }
    }
  }

  function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  // Reactively request or release wake lock based on login status and mobile device
  $: if (mounted && isMobileDevice()) {
    if ($currentUser) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }

  // Re-acquire lock if tab becomes visible again
  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && $currentUser && isMobileDevice()) {
      await requestWakeLock();
    }
  }

  onMount(async () => {
    mounted = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // Check for QR Sync params in URL
    const urlParams = new URLSearchParams(window.location.search);
    const syncId = urlParams.get('syncId');
    const keyMatch = window.location.search.match(/[&?]key=([^&]+)/);
    const keyParam = keyMatch ? keyMatch[1] : null;
    if (syncId && keyParam) {
      isLoading.set(true);
      try {
        const res = await fetch(`/api/auth/sync/retrieve/${syncId}`);
        if (res.ok) {
          const { payload } = await res.json();
          const keyRaw = fromBase64(decodeURIComponent(keyParam));
          
          const decrypted = await decryptSyncPayload(payload, keyRaw);
          
          // Import JWKs to CryptoKeys
          const ikpEcdhPrivate = await crypto.subtle.importKey('jwk', decrypted.identityKeyPair.ecdh.privateKey, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
          const ikpEcdhPublic = await crypto.subtle.importKey('jwk', decrypted.identityKeyPair.ecdh.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
          const ikpEcdsaPrivate = await crypto.subtle.importKey('jwk', decrypted.identityKeyPair.ecdsa.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
          const ikpEcdsaPublic = await crypto.subtle.importKey('jwk', decrypted.identityKeyPair.ecdsa.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
          
          const spkPrivate = await crypto.subtle.importKey('jwk', decrypted.signedPrekeyPair.privateKey, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
          const spkPublic = await crypto.subtle.importKey('jwk', decrypted.signedPrekeyPair.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

          identityKeyPair.set({
            ecdh: { privateKey: ikpEcdhPrivate, publicKey: ikpEcdhPublic },
            ecdsa: { privateKey: ikpEcdsaPrivate, publicKey: ikpEcdsaPublic }
          });
          signedPrekeyPair.set({ privateKey: spkPrivate, publicKey: spkPublic });
          loginPassword.set(decrypted.loginPassword);

          if (decrypted.localBackupKeyBase64) {
            const rawBackupKey = new Uint8Array(atob(decrypted.localBackupKeyBase64).split('').map(c => c.charCodeAt(0)));
            const dbKey = await crypto.subtle.importKey('raw', rawBackupKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
            localBackupKey.set(dbKey);
            localBackupPassphrase.set(decrypted.localBackupPassphrase);
            localBackupEnabled.set(true);
          }

          // Restore Double Ratchet Sessions
          if (decrypted.ratchetSessions) {
            const sessionsMap = new Map();
            for (const [peerId, sessionData] of Object.entries(decrypted.ratchetSessions)) {
              sessionsMap.set(peerId, await RatchetSession.deserialize(sessionData));
            }
            ratchetSessions.set(sessionsMap);
          }

          // Restore Group Sender Keys
          if (decrypted.groupSenderKeys) {
            const groupKeysMap = new Map();
            for (const [key, sessionData] of Object.entries(decrypted.groupSenderKeys)) {
              groupKeysMap.set(key, await SenderKeySession.deserialize(sessionData));
            }
            groupSenderKeys.set(groupKeysMap);
          }

          // This device has no private halves for the one-time prekeys already
          // published under this identity — generate and upload a fresh batch so
          // new incoming sessions started against this device can be decrypted.
          try {
            const { publicKeys, keyPairs } = await generateOneTimePrekeys(20);
            await replenishPrekeys(publicKeys);
            const otpPairsWithPub = keyPairs.map((kp, idx) => ({
              keyPair: kp,
              pubKeyBase64: publicKeys[idx]
            }));
            oneTimePrekeyPairs.set(otpPairsWithPub);
          } catch (err) {
            console.error('Failed to replenish one-time prekeys after QR sync:', err);
          }

          // Clear query params from URL
          window.history.replaceState({}, document.title, window.location.pathname);

          setUser(decrypted.currentUser);
          isLoading.set(false);
          return;
        }
      } catch (err) {
        console.error('Failed to execute QR session sync:', err);
      }
      isLoading.set(false);
    }

    // Try to restore session from HTTP-only cookie (server validates)
    try {
      const user = await getMe();
      setUser(user);
    } catch {
      setUser(null);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    releaseWakeLock();
  });
</script>

<main class="min-h-screen bg-vault-black relative overflow-hidden">
  <!-- Ambient background glow -->
  <div class="pointer-events-none fixed inset-0 z-0">
    <div class="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-vault-accent/[0.03] blur-[120px]"></div>
    <div class="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-vault-accent/[0.02] blur-[100px]"></div>
  </div>

  {#if $isLoading}
    <!-- Loading screen -->
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black" out:fade={{ duration: 250 }}>
      <div class="flex flex-col items-center gap-4 animate-fade-in">
        <div class="relative">
          <svg class="w-12 h-12 text-vault-text animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
            <path d="M12 22V12" stroke-dasharray="3 3" />
          </svg>
        </div>
        <div class="text-vault-text-dim text-sm tracking-wider uppercase">Establishing secure connection...</div>
      </div>
    </div>
  {:else}
    <div class="absolute inset-0">
      {#if $activeView === 'landing'}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          <Landing />
        </div>
      {:else if $activeView === 'auth'}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          <Auth />
        </div>
      {:else if $activeView === 'vaultcoin'}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          <VaultCoin />
        </div>
      {:else}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          <Chat />
        </div>
      {/if}
    </div>
  {/if}
</main>
