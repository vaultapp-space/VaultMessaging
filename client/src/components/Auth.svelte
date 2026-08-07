<script>
  import { currentUser, setUser, activeView, identityKeyPair, signedPrekeyPair, oneTimePrekeyPairs, historyKey, localBackupKey, localBackupEnabled, localBackupPassphrase, vaultMasterKey, ratchetSessions, groupSenderKeys } from '../lib/stores/session.js';
  import { describeThisDevice } from '../lib/device.js';
  import { estimatePasswordStrength } from '../lib/passwordStrength.js';
  import { register, login, updateKeys, fetchSalt, saveEncryptedVault } from '../lib/api/http.js';
  import { generateExportableKeyPair, exportPublicKeyBase64, generateOneTimePrekeys, signData, generateSigningKeyPair, deriveHistoryKey, deriveMasterKeyBits, deriveServerAuthSecret, encryptIdentityVault, decryptIdentityVault } from '../lib/crypto/keys.js';
  import { toBase64 } from '../lib/crypto/utils.js';
  import { RatchetSession } from '../lib/crypto/ratchet.js';
  import { SenderKeySession } from '../lib/crypto/senderkeys.js';

  let mode = 'register'; // 'register' | 'login'
  let username = '';
  let password = '';
  let confirmPassword = '';
  let error = '';
  let loading = false;
  let showPassword = false;

  if ($currentUser) {
    username = $currentUser.username;
    mode = 'login';
  }

  // Rough client-side strength estimate — not a substitute for the 12-char
  // minimum enforced below, just extra signal to steer people away from
  // weak-but-long passwords (e.g. "aaaaaaaaaaaa") since this password is
  // what the whole key hierarchy is derived from.
  $: passwordStrength = mode === 'register' ? estimatePasswordStrength(password) : null;

  function goToLanding() {
    activeView.set('landing');
  }

  async function handleRegister() {
    if (username.length < 3) { error = 'Username must be at least 3 characters'; return; }
    if (username.length > 20) { error = 'Username must be at most 20 characters'; return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      error = 'Username can only contain letters, numbers, and underscores';
      return;
    }
    if (password.length < 12) {
      error = 'Password must be at least 12 characters for strong end-to-end encryption';
      return;
    }
    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    error = '';
    loading = true;

    try {
      // Generate a random salt for PBKDF2
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const saltBase64 = toBase64(saltBytes);

      // Stretch the real password ONCE into a master key. Everything else
      // (history key, vault encryption, server auth) derives from this —
      // the real password itself is never sent anywhere past this point.
      const masterKeyBits = await deriveMasterKeyBits(password, saltBase64);
      const masterKeyBase64 = toBase64(masterKeyBits);
      const authSecret = await deriveServerAuthSecret(masterKeyBits);

      // Parallelize independent key generation operations
      const [hk, ikp_ecdh, ikp_ecdsa, spk] = await Promise.all([
        deriveHistoryKey(masterKeyBase64, saltBase64),
        generateExportableKeyPair(),
        generateSigningKeyPair(),
        generateExportableKeyPair(),
      ]);
      historyKey.set(hk);

      // Parallelize exports + prekey generation + signing
      const spkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', spk.publicKey));
      const [ecdhPub, ecdsaPub, signedPrekeyBase64, sig, prekeys] = await Promise.all([
        exportPublicKeyBase64(ikp_ecdh.publicKey),
        exportPublicKeyBase64(ikp_ecdsa.publicKey),
        exportPublicKeyBase64(spk.publicKey),
        signData(ikp_ecdsa.privateKey, spkRaw),
        generateOneTimePrekeys(20),
      ]);

      const identityKeyBase64 = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));
      const prekeySigBase64 = toBase64(sig);

      // Create initial zero-knowledge identity vault before registering
      const initialVault = await encryptIdentityVault({
        identityKeyPair: { ecdh: ikp_ecdh, ecdsa: ikp_ecdsa },
        signedPrekeyPair: spk,
        localBackupKeyBase64: null,
        localBackupPassphrase: null
      }, masterKeyBase64);

      // Register with server atomically with vault backup. The server only
      // ever sees authSecret, a one-way derivation of the master key it
      // cannot reverse — never the real password.
      const user = await register({
        ...describeThisDevice(),
        username,
        password: authSecret,
        identityKey: identityKeyBase64,
        signedPrekey: signedPrekeyBase64,
        prekeySig: prekeySigBase64,
        oneTimePrekeys: prekeys.publicKeys,
        salt: saltBase64,
        encryptedVault: initialVault,
      });

      // Store keys in volatile memory ONLY
      identityKeyPair.set({ ecdh: ikp_ecdh, ecdsa: ikp_ecdsa });
      signedPrekeyPair.set(spk);
      
      const otpPairsWithPub = prekeys.keyPairs.map((kp, idx) => ({
        keyPair: kp,
        pubKeyBase64: prekeys.publicKeys[idx]
      }));
      oneTimePrekeyPairs.set(otpPairsWithPub);
      vaultMasterKey.set(masterKeyBase64);

      // Set user session
      setUser(user);
      activeView.set('chat');

    } catch (err) {
      error = err.message || 'Registration failed';
    } finally {
      loading = false;
    }
  }

  async function handleLogin() {
    if (!username || !password) { error = 'Enter username and password'; return; }

    error = '';
    loading = true;

    try {
      // Fetch user salt from server
      const { salt } = await fetchSalt(username);

      // Same one-time stretch as registration: the real password never
      // leaves the client past this point.
      const masterKeyBits = await deriveMasterKeyBits(password, salt);
      const masterKeyBase64 = toBase64(masterKeyBits);
      const authSecret = await deriveServerAuthSecret(masterKeyBits);

      // Derive history key from the master key and retrieved salt
      const hk = await deriveHistoryKey(masterKeyBase64, salt);
      historyKey.set(hk);

      const user = await login(username, authSecret, describeThisDevice());
      vaultMasterKey.set(masterKeyBase64);

      let ikp_ecdh, ikp_ecdsa, spk;
      let isRestored = false;

      if (user.encryptedVault) {
        try {
          const vault = await decryptIdentityVault(user.encryptedVault, masterKeyBase64);
          ikp_ecdh = vault.identityKeyPair.ecdh;
          ikp_ecdsa = vault.identityKeyPair.ecdsa;
          spk = vault.signedPrekeyPair;

          identityKeyPair.set(vault.identityKeyPair);
          signedPrekeyPair.set(vault.signedPrekeyPair);

          if (vault.localBackupKeyBase64) {
            const rawBackupKey = new Uint8Array(atob(vault.localBackupKeyBase64).split('').map(c => c.charCodeAt(0)));
            const dbKey = await crypto.subtle.importKey('raw', rawBackupKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
            localBackupKey.set(dbKey);
            localBackupPassphrase.set(vault.localBackupPassphrase);
            localBackupEnabled.set(true);
          }

          // Restore Double Ratchet Sessions
          if (vault.ratchetSessions) {
            const sessionsMap = new Map();
            for (const [peerId, sessionData] of Object.entries(vault.ratchetSessions)) {
              sessionsMap.set(peerId, await RatchetSession.deserialize(sessionData));
            }
            ratchetSessions.set(sessionsMap);
          }

          // Restore Group Sender Keys
          if (vault.groupSenderKeys) {
            const groupKeysMap = new Map();
            for (const [key, sessionData] of Object.entries(vault.groupSenderKeys)) {
              groupKeysMap.set(key, await SenderKeySession.deserialize(sessionData));
            }
            groupSenderKeys.set(groupKeysMap);
          }

          isRestored = true;
        } catch (decErr) {
          console.error('Failed to decrypt identity vault, regenerating keys:', decErr);
        }
      }

      if (!isRestored) {
        // Fallback or legacy account: generate fresh keys
        ikp_ecdh = await generateExportableKeyPair();
        ikp_ecdsa = await generateSigningKeyPair();
        spk = await generateExportableKeyPair();

        identityKeyPair.set({ ecdh: ikp_ecdh, ecdsa: ikp_ecdsa });
        signedPrekeyPair.set(spk);

        // Encrypt and upload initial cloud vault
        const initialVault = await encryptIdentityVault({
          identityKeyPair: { ecdh: ikp_ecdh, ecdsa: ikp_ecdsa },
          signedPrekeyPair: spk,
          localBackupKeyBase64: null,
          localBackupPassphrase: null
        }, masterKeyBase64);
        await saveEncryptedVault(initialVault);
      }

      // Generate prekey signature and compile user keys bundle
      const spkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', spk.publicKey));
      const [ecdhPub, ecdsaPub, signedPrekeyBase64, sig, prekeys] = await Promise.all([
        exportPublicKeyBase64(ikp_ecdh.publicKey),
        exportPublicKeyBase64(ikp_ecdsa.publicKey),
        exportPublicKeyBase64(spk.publicKey),
        signData(ikp_ecdsa.privateKey, spkRaw),
        generateOneTimePrekeys(20),
      ]);

      const identityKeyBase64 = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));
      const prekeySigBase64 = toBase64(sig);

      // Upload updated keys to server so peers can start sessions with us
      await updateKeys({
        identityKey: identityKeyBase64,
        signedPrekey: signedPrekeyBase64,
        prekeySig: prekeySigBase64,
        oneTimePrekeys: prekeys.publicKeys,
      });

      const otpPairsWithPub = prekeys.keyPairs.map((kp, idx) => ({
        keyPair: kp,
        pubKeyBase64: prekeys.publicKeys[idx]
      }));
      oneTimePrekeyPairs.set(otpPairsWithPub);

      setUser(user);
      activeView.set('chat');

    } catch (err) {
      error = err.message || 'Login failed';
    } finally {
      loading = false;
    }
  }

  function handleSubmit() {
    if (mode === 'register') handleRegister();
    else handleLogin();
  }

  function toggleMode() {
    mode = mode === 'register' ? 'login' : 'register';
    error = '';
    showPassword = false;
    confirmPassword = '';
  }
</script>

<!-- fixed inset-0 escapes App.svelte's <main> padding-top the same way
     Chat.svelte's and ChatSidebar's own roots do — same safe-area fix.
     max-md:-scoped max() floor, not an unconditional one: on desktop
     there's genuinely no inset to compensate for and a floor would just
     add unwanted top padding there. The floor itself guards against
     env(safe-area-inset-top) misreporting 0 during the on-screen
     keyboard's window resize on Android — this screen has two text
     fields, so it's the one most likely to trigger that. -->
<div class="fixed inset-0 z-10 flex items-center justify-center p-4 max-md:pt-[max(env(safe-area-inset-top,0px),1.5rem)]">
  <div class="w-full max-w-md animate-fade-in-scale">
    <!-- Logo & Branding -->
    <div class="text-center mb-8">
      <button
        type="button"
        on:click={goToLanding}
        class="inline-flex items-center justify-center w-16 h-16 rounded-2xl overflow-hidden border border-vault-border/50 mb-4 animate-pulse-glow cursor-pointer focus:outline-none"
        aria-label="Back to home"
        title="Back to home"
      >
        <img src="/logo.jpg" alt="Vault" class="w-full h-full object-cover" />
      </button>
      <h1 class="text-2xl font-semibold text-vault-text tracking-tight">Vault</h1>
      <p class="text-vault-text-dim text-sm mt-1">End-to-end encrypted messaging</p>
    </div>

    <!-- Auth Card -->
    <div class="glass-strong rounded-2xl p-6 shadow-2xl shadow-black/40">
      <!-- Security Badge -->
      <div class="flex justify-center mb-6">
        <div class="shield-badge">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
          </svg>
          {mode === 'register' ? 'Zero-Knowledge Registration' : 'Encrypted Session'}
        </div>
      </div>

      {#if mode === 'register'}
        <div class="mb-5 flex gap-2 text-[11px] leading-relaxed text-vault-warning bg-vault-warning/10 border border-vault-warning/25 rounded-lg px-3 py-2.5">
          <span class="shrink-0">⚠️</span>
          <span><strong class="font-semibold">There is no password recovery.</strong> Vault stores no email or phone number, so if you lose this password your account and message history are gone permanently. Write it down and keep it somewhere safe.</span>
        </div>
      {/if}

      <form on:submit|preventDefault={handleSubmit} class="space-y-4">
        <!-- Username -->
        <div>
          <label for="auth-username" class="block text-xs font-medium text-vault-text-secondary mb-1.5 uppercase tracking-wider">
            Username
          </label>
          <!-- svelte-ignore a11y-autofocus -->
          <!-- The first field on the app's actual entry screen, not
               mid-page autofocus — same tradeoff every login form makes. -->
          <input
            id="auth-username"
            type="text"
            bind:value={username}
            placeholder="Choose a username"
            class="input"
            autocomplete="username"
            autofocus
            disabled={loading}
          />
        </div>

        <!-- Password -->
        <div>
          <label for="auth-password" class="block text-xs font-medium text-vault-text-secondary mb-1.5 uppercase tracking-wider">
            Password
          </label>
          <div class="relative">
            <input
              id="auth-password"
              type={showPassword ? 'text' : 'password'}
              bind:value={password}
              placeholder={mode === 'register' ? 'Min 12 characters' : 'Enter password'}
              class="input"
              style="padding-right: 2.5rem;"
              disabled={loading}
              autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 pr-3 flex items-center text-vault-text-dim hover:text-vault-accent transition-colors"
              on:click={() => showPassword = !showPassword}
              tabindex="-1"
            >
              {#if showPassword}
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              {:else}
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              {/if}
            </button>
          </div>
          {#if mode === 'register' && password}
            <div class="mt-1.5 flex items-center gap-2">
              <div class="flex-1 h-1 rounded-full bg-vault-border/40 overflow-hidden flex gap-0.5">
                {#each Array(4) as _, i}
                  <div class="flex-1 h-full rounded-full transition-colors {i < passwordStrength.score ? passwordStrength.color : 'bg-transparent'}"></div>
                {/each}
              </div>
              <span class="text-[10px] font-medium text-vault-text-dim w-14 text-right">{passwordStrength.label}</span>
            </div>
          {/if}
        </div>

        {#if mode === 'register'}
          <!-- Confirm Password -->
          <div>
            <label for="auth-confirm-password" class="block text-xs font-medium text-vault-text-secondary mb-1.5 uppercase tracking-wider">
              Confirm Password
            </label>
            <input
              id="auth-confirm-password"
              type={showPassword ? 'text' : 'password'}
              bind:value={confirmPassword}
              placeholder="Re-enter your password"
              class="input"
              disabled={loading}
              autocomplete="new-password"
            />
            {#if confirmPassword && confirmPassword !== password}
              <p class="text-[10px] text-vault-danger mt-1">Passwords don't match yet</p>
            {/if}
          </div>
        {/if}

        <!-- Error -->
        {#if error}
          <!-- role="alert" (not aria-live) deliberately — it's built for
               exactly this pattern, an element that doesn't exist until the
               error does, unlike aria-live regions which some screen
               readers only pick up once already present in the DOM. -->
          <div role="alert" class="text-xs text-vault-danger bg-vault-danger/10 border border-vault-danger/20 rounded-lg px-3 py-2 animate-fade-in">
            {error}
          </div>
        {/if}

        <!-- Submit -->
        <button
          type="submit"
          class="btn-primary w-full"
          disabled={loading}
        >
          {#if loading}
            <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
            </svg>
            {mode === 'register' ? 'Generating keys...' : 'Authenticating...'}
          {:else}
            {mode === 'register' ? 'Create Secure Account' : 'Unlock Vault'}
          {/if}
        </button>
      </form>

      <!-- Toggle Mode -->
      <div class="mt-4 text-center">
        <button
          on:click={toggleMode}
          class="text-xs text-vault-text-dim hover:text-vault-accent transition-colors"
        >
          {mode === 'register' ? 'Already have an account? Sign in' : 'Need an account? Create one'}
        </button>
      </div>
    </div>

    <!-- Footer Info -->
    <div class="mt-6 text-center space-y-2">
      <div class="flex items-center justify-center gap-4 text-[10px] text-vault-text-dim uppercase tracking-widest">
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          E2E Encrypted
        </span>
        <span class="text-vault-border">·</span>
        <span>Zero PII</span>
        <span class="text-vault-border">·</span>
        <span>24h Auto-Delete</span>
      </div>
    </div>
  </div>
</div>
