<script>
  // ============================================================
  // Change Password
  // ============================================================
  // Folded away behind a button rather than shown open. A settings panel
  // that greets you with three empty password fields invites the one thing
  // this operation must not be — done absent-mindedly.
  //
  // The heavy lifting is in lib/crypto/password.js; this is the form. Two
  // things it has to get right that an ordinary password form does not:
  // the confirm field is not politeness (a typo here is an account you can
  // never open again, and there is no reset link), and the warning about
  // other devices is real — they are signed out, because a password change
  // that leaves the intruder's session alive has not done anything.

  import { changeAccountPassword, MIN_PASSWORD_LENGTH } from '../lib/crypto/password.js';

  let open = false;
  let current = '';
  let next = '';
  let confirm = '';
  let busy = false;
  let error = '';
  let done = '';

  $: strengthLabel =
    next.length === 0 ? '' :
    next.length < MIN_PASSWORD_LENGTH ? `${MIN_PASSWORD_LENGTH - next.length} more characters needed` :
    next.length < 16 ? 'Acceptable' :
    next.length < 24 ? 'Strong' : 'Very strong';

  $: canSubmit =
    !busy &&
    current.length > 0 &&
    next.length >= MIN_PASSWORD_LENGTH &&
    next === confirm &&
    next !== current;

  function reset() {
    current = ''; next = ''; confirm = ''; error = '';
  }

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    error = '';
    done = '';

    try {
      const { revokedDevices } = await changeAccountPassword(current, next);
      done = revokedDevices > 0
        ? `Password changed. ${revokedDevices} other ${revokedDevices === 1 ? 'device was' : 'devices were'} signed out.`
        : 'Password changed.';
      reset();
      open = false;
    } catch (err) {
      console.error('Password change failed:', err);
      error = err?.message || 'Could not change your password.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="border-b border-vault-border pb-4">
  <div class="flex items-center justify-between">
    <div>
      <span class="text-xs font-semibold text-vault-text block">Password</span>
      <span class="text-[10px] text-vault-text-dim">Changes your login and re-encrypts your keys</span>
    </div>
    <button
      on:click={() => { open = !open; reset(); done = ''; }}
      class="text-[10px] text-vault-accent hover:underline focus:outline-none"
    >{open ? 'Cancel' : 'Change'}</button>
  </div>

  {#if done}
    <div class="mt-2 text-[10px] text-vault-accent">{done}</div>
  {/if}

  {#if open}
    <form class="mt-3 flex flex-col gap-2" on:submit|preventDefault={submit}>
      <input
        type="password"
        bind:value={current}
        placeholder="Current password"
        autocomplete="current-password"
        class="w-full px-2.5 py-1.5 bg-vault-elevated border border-vault-border rounded-lg text-[11px] text-vault-text placeholder-vault-muted focus:outline-none focus:border-vault-accent"
      />
      <input
        type="password"
        bind:value={next}
        placeholder="New password"
        autocomplete="new-password"
        class="w-full px-2.5 py-1.5 bg-vault-elevated border border-vault-border rounded-lg text-[11px] text-vault-text placeholder-vault-muted focus:outline-none focus:border-vault-accent"
      />
      <input
        type="password"
        bind:value={confirm}
        placeholder="Confirm new password"
        autocomplete="new-password"
        class="w-full px-2.5 py-1.5 bg-vault-elevated border border-vault-border rounded-lg text-[11px] text-vault-text placeholder-vault-muted focus:outline-none focus:border-vault-accent"
      />

      {#if strengthLabel}
        <div class="text-[9px] {next.length < MIN_PASSWORD_LENGTH ? 'text-vault-warning' : 'text-vault-text-dim'}">
          {strengthLabel}
        </div>
      {/if}
      {#if confirm && next !== confirm}
        <div class="text-[9px] text-vault-warning">Passwords do not match</div>
      {/if}
      {#if error}
        <div class="text-[10px] text-vault-danger">{error}</div>
      {/if}

      <div class="text-[9px] text-vault-text-dim leading-relaxed">
        Your other devices will be signed out. There is no password reset — if
        you forget this one, the account and everything in it is gone.
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        class="w-full py-1.5 bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-[11px] rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus:outline-none"
      >{busy ? 'Changing…' : 'Change password'}</button>
    </form>
  {/if}
</div>
