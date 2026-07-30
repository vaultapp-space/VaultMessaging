<script>
  import { activeCall, activePeer } from '../lib/stores/session.js';
  import { micMuted, toggleMic, hangupCall } from '../lib/webrtc.js';

  // Shown whenever a call is live but the user isn't currently looking at
  // that peer's chat — ChatView already renders the full call UI in that case.
  $: visible = $activeCall &&
    ($activeCall.status === 'ongoing' || $activeCall.status === 'ringing') &&
    $activeCall.peerId !== $activePeer?.id;

  function returnToCall() {
    if (!$activeCall) return;
    activePeer.set({ id: $activeCall.peerId, username: $activeCall.peerUsername, isGroup: false });
  }
</script>

{#if visible}
  <div class="fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 pl-3 pr-2 py-2 bg-vault-surface/95 border border-vault-border rounded-full shadow-xl backdrop-blur-md animate-slide-down cursor-pointer select-none"
    on:click={returnToCall}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') returnToCall(); }}
  >
    <div class="w-2 h-2 rounded-full {$activeCall.status === 'ongoing' ? 'bg-vault-accent' : 'bg-vault-warning'} animate-pulse"></div>

    <div class="text-xs text-vault-text font-medium truncate max-w-[140px]">
      {$activeCall.status === 'ongoing' ? 'On call' : 'Calling'} · {$activeCall.peerUsername}
    </div>

    <button
      on:click|stopPropagation={() => toggleMic()}
      class="p-1.5 rounded-full transition-all focus:outline-none
        {$micMuted ? 'bg-vault-danger/20 text-vault-danger' : 'bg-vault-elevated text-vault-text-dim hover:text-vault-text'}"
      title={$micMuted ? 'Unmute Mic' : 'Mute Mic'}
      aria-label={$micMuted ? 'Unmute Mic' : 'Mute Mic'}
    >
      {#if $micMuted}
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
          <path d="M17 16.95A7 7 0 0 1 5 12v-2M19 12v0a7 7 0 0 1-.11 1.23" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
      {:else}
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
      {/if}
    </button>

    <button
      on:click|stopPropagation={() => hangupCall()}
      class="p-1.5 rounded-full bg-vault-danger/20 text-vault-danger hover:bg-vault-danger/30 transition-all focus:outline-none"
      title="Hang Up"
      aria-label="Hang Up"
    >
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
        <line x1="23" y1="1" x2="1" y2="23" />
      </svg>
    </button>
  </div>
{/if}
