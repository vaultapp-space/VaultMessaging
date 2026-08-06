<script>
  // ============================================================
  // Active Sessions
  // ============================================================
  // Until devices existed, a session was an opaque server-side key: there
  // was no way to see what was signed in to an account, and no way to sign
  // out a phone you no longer had. The second is a security control, not a
  // convenience — a lost device otherwise keeps working until its 24h token
  // expires on its own.

  import { fetchDevices, revokeDevice } from '../lib/api/http.js';

  // Folded away behind a single row rather than always expanded — every
  // device was rendering inline in a settings panel that already has
  // Appearance, Biometric Unlock and Local Encrypted Backup competing for
  // the same space, and most visits to Settings have nothing to do with
  // session management. Lazily loaded on first open rather than on mount,
  // so opening Settings doesn't fire a devices request nobody asked for.
  let open = false;
  let devices = [];
  let loaded = false;
  let loading = false;
  let error = '';
  let revoking = null;

  function toggle() {
    open = !open;
    if (open && !loaded) load();
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await fetchDevices();
      devices = res.devices ?? [];
    } catch (err) {
      console.error('Failed to load devices:', err);
      error = 'Could not load your sessions.';
    } finally {
      loading = false;
      loaded = true;
    }
  }

  async function signOut(device) {
    // Revoking the current device is just a logout, and calling it "sign out
    // this device" in a list of others is a good way to have someone lock
    // themselves out by accident.
    if (device.current) return;
    if (!confirm(`Sign out ${describe(device)}? It will lose access immediately.`)) return;

    revoking = device.id;
    try {
      await revokeDevice(device.id);
      devices = devices.filter((d) => d.id !== device.id);
    } catch (err) {
      console.error('Failed to revoke device:', err);
      error = 'Could not sign that device out.';
    } finally {
      revoking = null;
    }
  }

  function describe(device) {
    return device.name || device.platform || 'Unknown device';
  }

  function lastSeen(device) {
    if (device.current) return 'Active now';
    const then = new Date(device.lastActiveAt).getTime();
    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) return 'Active now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
</script>

<div class="border-b border-vault-border pb-4">
  <div class="flex items-center justify-between">
    <div>
      <span class="text-xs font-semibold text-vault-text block">Sessions</span>
      <span class="text-[10px] text-vault-text-dim">
        {#if loaded}{devices.length} signed in{:else}Everything signed in to this account{/if}
      </span>
    </div>
    <button
      on:click={toggle}
      class="text-[10px] text-vault-accent hover:underline focus:outline-none"
    >{open ? 'Hide' : 'View'}</button>
  </div>

  {#if open}
  <div class="mt-2">
  <div class="flex items-center justify-between mb-1">
    <span class="text-[10px] text-vault-text-dim">
      Signing one out takes effect at once.
    </span>
    <button
      on:click={load}
      class="text-[10px] text-vault-accent hover:underline focus:outline-none shrink-0"
    >Refresh</button>
  </div>

  {#if loading}
    <div class="text-[10px] text-vault-text-dim">Loading…</div>
  {:else if error}
    <div class="text-[10px] text-vault-danger">{error}</div>
  {:else if devices.length === 0}
    <div class="text-[10px] text-vault-text-dim">No sessions found.</div>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each devices as device (device.id)}
        <div class="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-vault-elevated">
          <div class="min-w-0">
            <div class="text-[11px] text-vault-text truncate">
              {describe(device)}
              {#if device.current}
                <span class="text-vault-accent">· this device</span>
              {/if}
            </div>
            <div class="text-[9px] text-vault-text-dim">
              {device.platform || 'unknown platform'} · {lastSeen(device)}
            </div>
          </div>

          {#if device.current}
            <span class="text-[9px] text-vault-text-dim shrink-0">Current</span>
          {:else}
            <button
              on:click={() => signOut(device)}
              disabled={revoking === device.id}
              class="text-[10px] text-vault-danger hover:underline shrink-0 disabled:opacity-50 focus:outline-none"
            >{revoking === device.id ? 'Signing out…' : 'Sign out'}</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  </div>
  {/if}
</div>
