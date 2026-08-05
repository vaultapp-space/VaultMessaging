<script>
  // ============================================================
  // Group voice chat
  // ============================================================
  // The room: who is in the call, who is muted, and a way to join or leave.
  //
  // The participant cap is real and is shown, not hidden. The media plane is
  // still the 1:1 WebRTC mesh — O(n²) connections — so a call genuinely does
  // not work well past a handful of people. Scaling further needs an SFU,
  // which is infrastructure rather than code. Saying "up to N" is a better
  // experience than letting a call quietly fall apart, so the number is on
  // screen.

  import { onMount, onDestroy } from 'svelte';
  import {
    fetchVoiceChat, startVoiceChat, joinVoiceChat, leaveVoiceChat, setVoiceMute,
  } from '../lib/api/http.js';
  import { onWsEvent } from '../lib/api/ws.js';
  import { currentUser } from '../lib/stores/session.js';

  export let chatId;

  let voiceChat = null;
  let participants = [];
  let maxParticipants = 0;
  let busy = false;
  let error = '';

  const unsubscribers = [];

  $: inCall = participants.some((p) => p.userId === $currentUser?.id);
  $: me = participants.find((p) => p.userId === $currentUser?.id);
  $: full = maxParticipants > 0 && participants.length >= maxParticipants && !inCall;

  onMount(async () => {
    await load();
    unsubscribers.push(
      onWsEvent('voice_chat_started', (data) => {
        if (data.chatId === chatId) load();
      }),
      onWsEvent('voice_chat_updated', (data) => {
        if (data.chatId !== chatId) return;
        participants = data.participants ?? [];
      }),
      onWsEvent('voice_chat_ended', (data) => {
        if (data.chatId !== chatId) return;
        voiceChat = null;
        participants = [];
      }),
    );
  });

  onDestroy(() => {
    for (const unsub of unsubscribers) unsub();
  });

  async function load() {
    try {
      const res = await fetchVoiceChat(chatId);
      voiceChat = res.voiceChat ?? null;
      participants = res.participants ?? [];
      maxParticipants = res.maxParticipants ?? 0;
    } catch (err) {
      console.error('Failed to load voice chat:', err);
    }
  }

  async function start() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const started = await startVoiceChat(chatId);
      voiceChat = started;
      maxParticipants = started.maxParticipants ?? maxParticipants;
      await join();
    } catch (err) {
      console.error('Failed to start voice chat:', err);
      error = 'Could not start the call.';
    } finally {
      busy = false;
    }
  }

  async function join() {
    if (!voiceChat) return;
    try {
      const res = await joinVoiceChat(voiceChat.id);
      participants = res.participants ?? [];
    } catch (err) {
      console.error('Failed to join voice chat:', err);
      // The cap is enforced server-side in a transaction, so this is the
      // authoritative answer even if the count on screen looked fine.
      error = 'This call is full.';
    }
  }

  async function leave() {
    if (!voiceChat) return;
    try {
      await leaveVoiceChat(voiceChat.id);
      await load();
    } catch (err) {
      console.error('Failed to leave voice chat:', err);
    }
  }

  async function toggleMute() {
    if (!voiceChat || !me) return;
    try {
      await setVoiceMute(voiceChat.id, !me.isMuted);
      await load();
    } catch (err) {
      console.error('Failed to change mute:', err);
      // Happens when an admin muted you — the server refuses the un-mute,
      // which is the entire point of admin muting.
      error = 'You were muted by an admin.';
    }
  }
</script>

{#if voiceChat}
  <div class="px-3 py-2 border-b border-vault-border bg-vault-accent/5 flex items-center gap-2">
    <span class="relative flex h-2 w-2 shrink-0">
      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-vault-accent opacity-75"></span>
      <span class="relative inline-flex rounded-full h-2 w-2 bg-vault-accent"></span>
    </span>

    <div class="min-w-0 flex-1">
      <div class="text-[11px] text-vault-text truncate">
        Voice chat · {participants.length}/{maxParticipants}
      </div>
      <div class="text-[9px] text-vault-text-dim truncate">
        {participants.map((p) => p.username + (p.isMuted ? ' (muted)' : '')).join(', ') || 'Nobody yet'}
      </div>
    </div>

    {#if inCall}
      <button
        on:click={toggleMute}
        class="px-2 py-1 rounded-lg text-[10px] focus:outline-none
          {me?.isMuted ? 'bg-vault-danger/20 text-vault-danger' : 'bg-vault-elevated text-vault-text-dim'}"
        title={me?.mutedByAdmin ? 'Muted by an admin' : 'Mute yourself'}
      >{me?.isMuted ? 'Unmute' : 'Mute'}</button>
      <button
        on:click={leave}
        class="px-2 py-1 rounded-lg text-[10px] bg-vault-danger/20 text-vault-danger focus:outline-none"
      >Leave</button>
    {:else}
      <button
        on:click={join}
        disabled={full}
        class="px-2 py-1 rounded-lg text-[10px] bg-vault-accent text-vault-black font-medium disabled:opacity-40 focus:outline-none"
        title={full ? `This call holds ${maxParticipants} people` : 'Join the call'}
      >{full ? 'Full' : 'Join'}</button>
    {/if}
  </div>

  {#if error}
    <div class="px-3 py-1 text-[10px] text-vault-danger">{error}</div>
  {/if}
{:else}
  <button
    on:click={start}
    disabled={busy}
    class="w-full px-3 py-1.5 text-left text-[10px] text-vault-text-dim hover:text-vault-accent transition-colors focus:outline-none"
  >{busy ? 'Starting…' : 'Start a voice chat →'}</button>
{/if}
