<script>
  // ============================================================
  // Bot manager (the BotFather equivalent)
  // ============================================================
  // Creating a bot, seeing its token once, and setting what it is allowed to
  // read.
  //
  // Two things this UI has to get right because the server cannot:
  //
  //   - **The token is shown once.** Only a hash is stored, so if the user
  //     closes this without copying it, the only remedy is rotating. That has
  //     to be said, not implied.
  //
  //   - **Privacy mode is explained, not just toggled.** "Read all group
  //     messages" is a switch that hands a third party every conversation the
  //     bot is in. A user turning it on should know that is what it does.

  import { onMount } from 'svelte';
  import {
    fetchBots, createBot, updateBot, rotateBotToken, deleteBot,
  } from '../lib/api/http.js';

  let bots = [];
  let loading = true;
  let error = '';

  let showCreate = false;
  let newUsername = '';
  let newDescription = '';
  let creating = false;

  // Held only in memory, and only until this component is dismissed.
  let freshToken = null;
  let freshTokenFor = null;

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await fetchBots();
      bots = res.bots ?? [];
    } catch (err) {
      console.error('Failed to load bots:', err);
      error = 'Could not load your bots.';
    } finally {
      loading = false;
    }
  }

  async function make() {
    const username = newUsername.trim();
    if (!username || creating) return;
    creating = true;
    error = '';
    try {
      const bot = await createBot({
        username,
        description: newDescription.trim() || null,
      });
      freshToken = bot.token;
      freshTokenFor = bot.username;
      newUsername = '';
      newDescription = '';
      showCreate = false;
      await load();
    } catch (err) {
      console.error('Failed to create bot:', err);
      error = err?.message?.includes('taken')
        ? 'That username is taken.'
        : 'A bot username must end in "bot" and be at least 5 characters.';
    } finally {
      creating = false;
    }
  }

  async function rotate(bot) {
    if (!confirm(`Rotate ${bot.username}'s token? The current one stops working immediately.`)) return;
    try {
      const { token } = await rotateBotToken(bot.id);
      freshToken = token;
      freshTokenFor = bot.username;
    } catch (err) {
      console.error('Failed to rotate token:', err);
      error = 'Could not rotate that token.';
    }
  }

  async function remove(bot) {
    if (!confirm(`Delete ${bot.username}? This cannot be undone.`)) return;
    try {
      await deleteBot(bot.id);
      await load();
    } catch (err) {
      console.error('Failed to delete bot:', err);
    }
  }

  async function toggle(bot, field) {
    try {
      const updated = await updateBot(bot.id, { [field]: !bot[field] });
      bots = bots.map((b) => (b.id === bot.id ? { ...b, ...updated } : b));
    } catch (err) {
      console.error('Failed to update bot:', err);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(freshToken);
    } catch {
      // Clipboard can be blocked; the token is on screen to copy by hand.
    }
  }
</script>

<div class="border-b border-vault-border pb-4">
  <div class="flex items-center justify-between mb-1">
    <span class="text-xs font-semibold text-vault-text block">Bots</span>
    <button
      on:click={() => (showCreate = !showCreate)}
      class="text-[10px] text-vault-accent hover:underline focus:outline-none"
    >{showCreate ? 'Cancel' : 'New bot'}</button>
  </div>
  <span class="text-[10px] text-vault-text-dim block mb-2">
    Bots work in cloud chats only — a bot reading a message means the server can too.
  </span>

  {#if freshToken}
    <!-- Shown once. Only a hash is stored, so this cannot be recovered. -->
    <div class="mb-2 p-2 rounded-lg bg-vault-accent/10 border border-vault-accent/30">
      <div class="text-[10px] text-vault-accent font-medium mb-1">
        Token for {freshTokenFor} — copy it now
      </div>
      <code class="block text-[10px] text-vault-text break-all mb-1">{freshToken}</code>
      <div class="flex items-center gap-2">
        <button
          on:click={copyToken}
          class="text-[10px] text-vault-accent hover:underline focus:outline-none"
        >Copy</button>
        <button
          on:click={() => { freshToken = null; freshTokenFor = null; }}
          class="text-[10px] text-vault-text-dim hover:text-vault-text focus:outline-none"
        >Done</button>
      </div>
      <p class="text-[9px] text-vault-muted mt-1">
        This is the only time it is shown. If you lose it you will have to rotate.
      </p>
    </div>
  {/if}

  {#if showCreate}
    <div class="flex flex-col gap-1.5 mb-2">
      <input
        bind:value={newUsername}
        placeholder="username, must end in bot"
        maxlength="32"
        class="w-full px-2 py-1.5 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
      />
      <input
        bind:value={newDescription}
        placeholder="What does it do? (optional)"
        maxlength="512"
        class="w-full px-2 py-1.5 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
      />
      <button
        on:click={make}
        disabled={creating || !newUsername.trim()}
        class="self-start px-2 py-1 rounded-lg text-[10px] bg-vault-accent text-vault-black font-medium disabled:opacity-50 focus:outline-none"
      >{creating ? 'Creating…' : 'Create bot'}</button>
    </div>
  {/if}

  {#if error}
    <div class="text-[10px] text-vault-danger mb-1">{error}</div>
  {/if}

  {#if loading}
    <div class="text-[10px] text-vault-text-dim">Loading…</div>
  {:else if bots.length === 0}
    <div class="text-[10px] text-vault-text-dim">You have no bots.</div>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each bots as bot (bot.id)}
        <div class="px-2 py-1.5 rounded-lg bg-vault-elevated">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] text-vault-text truncate">@{bot.username}</span>
            <div class="flex items-center gap-2 shrink-0">
              <button
                on:click={() => rotate(bot)}
                class="text-[10px] text-vault-accent hover:underline focus:outline-none"
              >Rotate token</button>
              <button
                on:click={() => remove(bot)}
                class="text-[10px] text-vault-danger hover:underline focus:outline-none"
              >Delete</button>
            </div>
          </div>

          <label class="flex items-center gap-1.5 mt-1 text-[10px] text-vault-text-dim">
            <input
              type="checkbox"
              checked={bot.canJoinGroups}
              on:change={() => toggle(bot, 'canJoinGroups')}
            />
            Can be added to groups
          </label>
          <label class="flex items-center gap-1.5 text-[10px] text-vault-text-dim">
            <input
              type="checkbox"
              checked={bot.canReadAllGroupMessages}
              on:change={() => toggle(bot, 'canReadAllGroupMessages')}
            />
            Read <em>all</em> group messages
          </label>
          <!-- Said plainly. This switch hands a third party every
               conversation the bot is in; the default is off for that
               reason. -->
          {#if bot.canReadAllGroupMessages}
            <p class="text-[9px] text-vault-danger mt-0.5">
              This bot sees every message in every group it is in, not just
              commands addressed to it.
            </p>
          {/if}
          <label class="flex items-center gap-1.5 text-[10px] text-vault-text-dim">
            <input
              type="checkbox"
              checked={bot.supportsInline}
              on:change={() => toggle(bot, 'supportsInline')}
            />
            Supports inline queries
          </label>
        </div>
      {/each}
    </div>
  {/if}
</div>
