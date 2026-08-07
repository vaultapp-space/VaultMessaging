<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { currentUser, isLoading, setUser, activeView, pendingChatId, identityKeyPair, signedPrekeyPair, oneTimePrekeyPairs, vaultMasterKey, localBackupKey, localBackupPassphrase, localBackupEnabled, ratchetSessions, groupSenderKeys } from './lib/stores/session.js';
  import { getMe, replenishPrekeys } from './lib/api/http.js';
  import { decryptSyncPayload, generateOneTimePrekeys } from './lib/crypto/keys.js';
  import { fromBase64 } from './lib/crypto/utils.js';
  import { RatchetSession } from './lib/crypto/ratchet.js';
  import { describeThisDevice } from './lib/device.js';
  import { SenderKeySession } from './lib/crypto/senderkeys.js';
  import Landing from './components/Landing.svelte';
  import NativeWelcome from './components/NativeWelcome.svelte';
  import { applyTheme } from './lib/theme.js';
  import { Capacitor } from '@capacitor/core';
  import ToastHost from './components/ToastHost.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import PassphrasePromptModal from './components/PassphrasePromptModal.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import BiometricPrompt from './components/BiometricPrompt.svelte';
  import { showToast } from './lib/stores/toast.js';
  import { initBackButtonHandler, triggerBackOnEscape } from './lib/backHandler.js';

  // Decided once — the platform doesn't change mid-session, so this doesn't
  // need to be a store. The marketing landing page is for a browser visitor
  // deciding whether to try Vault; someone opening the Android app already
  // installed it, so it shows a plain welcome screen instead (see
  // NativeWelcome.svelte).
  const isNative = Capacitor.isNativePlatform();

  // Auth/Chat/VaultCoin are lazy-loaded (see {#await import(...)} below) so a
  // first-time visitor landing on the marketing page isn't also downloading
  // the full chat client before it's needed.

  // Initialize theme from localStorage immediately (no flicker)
  applyTheme(localStorage.getItem('vault_theme') || 'light');

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
    initBackButtonHandler();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // /join/<hash> — an invite link someone was sent.
    //
    // Handled here rather than in Chat.svelte because that component only
    // mounts once the chat view is active, and the app always opens on the
    // landing page: a pasted invite link would otherwise do nothing at all.
    // The URL is cleared afterwards so a refresh cannot redeem a single-use
    // link a second time.
    const joinMatch = window.location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)$/);
    if (joinMatch) {
      try {
        const user = await getMe();
        setUser(user);
        const res = await fetch(`/api/invites/${joinMatch[1]}/join`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) throw new Error((await res.json()).error || 'invite is not valid');
        const joined = await res.json();
        pendingChatId.set(joined?.id ?? null);
        activeView.set('chat');
      } catch (err) {
        console.error('Failed to join via invite:', err);
        showToast('That invite link is no longer valid.');
      }
      window.history.replaceState({}, document.title, '/');
      isLoading.set(false);
      return;
    }

    // Check for QR Sync params in URL. syncId is a single-use, short-TTL
    // capability token and travels in the query string (fine — it's useless
    // without the key). The key itself is only ever in the URL fragment,
    // which browsers never transmit in any HTTP request, so it never reaches
    // server access logs.
    const urlParams = new URLSearchParams(window.location.search);
    const syncId = urlParams.get('syncId');
    const keyMatch = window.location.hash.match(/[&#]key=([^&]+)/);
    const keyParam = keyMatch ? keyMatch[1] : null;
    if (syncId && keyParam) {
      isLoading.set(true);
      try {
        const deviceInfo = describeThisDevice();
        const query = new URLSearchParams(
          Object.fromEntries(Object.entries(deviceInfo).filter(([, v]) => v != null))
        );
        const res = await fetch(`/api/auth/sync/retrieve/${syncId}?${query}`);
        if (res.ok) {
          const { payload, deviceId } = await res.json();
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
          vaultMasterKey.set(decrypted.vaultMasterKey);

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

          // deviceId from the response, not decrypted.currentUser — the
          // vault payload was encrypted on the *other* device and carries
          // its deviceId, not this new one's freshly-issued id.
          setUser({ ...decrypted.currentUser, deviceId });
          activeView.set('chat');
          isLoading.set(false);
          return;
        }
      } catch (err) {
        console.error('Failed to execute QR session sync:', err);
      } finally {
        // Scrub the sync key out of the URL unconditionally — on the
        // success path above too, but critically also here. This used to
        // only run inside the `res.ok` branch, so any failure (an expired
        // or already-consumed syncId, a wrong or corrupted key — both
        // realistic for a single-use, short-TTL token) left the vault
        // master key sitting in the URL fragment, and from there in
        // browser history, directly undermining the "never persists
        // anywhere" guarantee described above.
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      isLoading.set(false);
    }

    // Try to restore session from HTTP-only cookie (server validates). A
    // valid cookie only proves the account session is alive — it says
    // nothing about the E2EE key material, which is deliberately never
    // persisted (see stores/session.js) and is gone the moment Android
    // kills the process. Routing straight into 'chat' here would show a
    // broken, key-less app; leaving activeView at its 'landing' default
    // made an already-authenticated user look signed out instead. Auth.svelte
    // treats a truthy currentUser as "resume" and prompts to unlock
    // (biometric or password) rather than register/log in from scratch.
    try {
      const user = await getMe();
      setUser(user);
      activeView.set('auth');
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

<svelte:window on:keydown={triggerBackOnEscape} />

<!-- Android 15+ (targetSdk 36, see android/variables.gradle) enforces
     edge-to-edge rendering — apps can no longer opt out of drawing behind
     the system status/nav bars, so without this the top of every screen
     renders underneath the wifi/signal/clock icons. env() resolves to 0
     anywhere there's no real inset (desktop browsers, iOS Safari outside a
     notch), so this is inert everywhere except where it's actually needed —
     same mechanism MobileTabBar.svelte already uses for the bottom edge. -->
<main
  class="min-h-screen bg-vault-black relative overflow-hidden"
  style="padding-top: env(safe-area-inset-top, 0px)"
>
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
          {#if isNative}
            <NativeWelcome />
          {:else}
            <Landing />
          {/if}
        </div>
      {:else if $activeView === 'auth'}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          {#await import('./components/Auth.svelte') then m}
            <svelte:component this={m.default} />
          {/await}
        </div>
      {:else if $activeView === 'vaultcoin'}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          {#await import('./components/VaultCoin.svelte') then m}
            <svelte:component this={m.default} />
          {/await}
        </div>
      {:else}
        <div class="absolute inset-0" in:fade={{ duration: 250, delay: 100 }} out:fade={{ duration: 150 }}>
          {#await import('./components/Chat.svelte') then m}
            <svelte:component this={m.default} />
          {/await}
        </div>
      {/if}
    </div>
  {/if}

  <ToastHost />
  <ConfirmDialog />
  <PassphrasePromptModal />
  <UpdateBanner />
  <BiometricPrompt />
</main>
