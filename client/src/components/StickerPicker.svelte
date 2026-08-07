<script>
  // ============================================================
  // Sticker picker
  // ============================================================
  // Recents, favourites and installed sets.
  //
  // Sending is not done here: the picker hands a sticker back to the composer
  // and the ordinary dual-mode send path carries it. That is what lets
  // stickers work in secret chats without the server learning that one was
  // sent, let alone which — so it is worth not "simplifying" this into a
  // direct send later.

  import { onMount } from 'svelte';
  import {
    fetchStickers, searchStickerSets, installStickerSet, publicMediaUrl,
  } from '../lib/api/http.js';
  import { showToast } from '../lib/stores/toast.js';

  export let onPick = null;
  export let onClose = null;

  let sets = [];
  let favorites = [];
  let recents = [];
  let loading = true;
  let query = '';
  let results = [];
  let searchTimer;

  // 'recent' | 'fav' | set id
  let tab = 'recent';

  onMount(load);

  async function load() {
    loading = true;
    try {
      const data = await fetchStickers();
      sets = data.sets ?? [];
      favorites = data.favorites ?? [];
      recents = data.recents ?? [];
      // Landing on an empty tab looks broken; open on whatever has content.
      if (recents.length === 0 && favorites.length > 0) tab = 'fav';
      else if (recents.length === 0 && sets.length > 0) tab = sets[0].id;
    } catch (err) {
      console.error('Failed to load stickers:', err);
    } finally {
      loading = false;
    }
  }

  function search(e) {
    query = e.target.value;
    clearTimeout(searchTimer);
    if (query.trim().length < 2) {
      results = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const found = await searchStickerSets(query.trim());
        results = (found.sets || []).filter(
          (s) => !sets.some((mine) => mine.id === s.id)
        );
      } catch {
        results = [];
      }
    }, 300);
  }

  let installingId = null;

  async function install(set) {
    if (installingId) return;
    installingId = set.id;
    try {
      await installStickerSet(set.id);
      await load();
      query = '';
      results = [];
      tab = set.id;
    } catch (err) {
      console.error('Failed to install set:', err);
      showToast('Could not add that sticker pack');
    } finally {
      installingId = null;
    }
  }

  $: visible =
    tab === 'recent' ? recents
    : tab === 'fav' ? favorites
    : (sets.find((s) => s.id === tab)?.stickers ?? []);
</script>

<div class="w-72 max-h-80 rounded-2xl glass-strong border border-vault-border flex flex-col overflow-hidden">
  <div class="p-2 border-b border-vault-border flex items-center gap-1.5">
    <input
      value={query}
      on:input={search}
      placeholder="Find sticker packs"
      class="flex-1 px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
    />
    {#if onClose}
      <button
        on:click={onClose}
        class="text-vault-text-dim hover:text-vault-text text-xs focus:outline-none"
        aria-label="Close sticker picker"
      >✕</button>
    {/if}
  </div>

  {#if results.length > 0}
    <div class="p-2 flex flex-col gap-1 overflow-y-auto">
      {#each results as set (set.id)}
        <button
          on:click={() => install(set)}
          disabled={installingId !== null}
          class="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-vault-elevated text-left focus:outline-none disabled:opacity-50"
        >
          <div class="min-w-0">
            <div class="text-[11px] text-vault-text truncate">{set.title}</div>
            <div class="text-[9px] text-vault-text-dim">{set.installsCount} installs</div>
          </div>
          <span class="text-[10px] text-vault-accent shrink-0">{installingId === set.id ? 'Adding…' : 'Add'}</span>
        </button>
      {/each}
    </div>
  {:else if loading}
    <div class="p-6 text-center text-[11px] text-vault-text-dim">Loading…</div>
  {:else if sets.length === 0 && recents.length === 0}
    <div class="p-6 text-center">
      <p class="text-[11px] text-vault-text-dim">No sticker packs yet</p>
      <p class="text-[10px] text-vault-muted mt-1">Search above to add one.</p>
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto p-2">
      {#if visible.length === 0}
        <div class="text-center text-[10px] text-vault-text-dim py-6">
          Nothing here yet.
        </div>
      {:else}
        <div class="grid grid-cols-4 gap-1.5">
          {#each visible as sticker (sticker.id)}
            <button
              on:click={() => onPick?.(sticker)}
              class="aspect-square rounded-lg hover:bg-vault-elevated p-1 focus:outline-none"
              title={sticker.emoji || 'Sticker'}
            >
              <img
                src={publicMediaUrl(sticker.fileId)}
                alt={sticker.emoji || 'Sticker'}
                loading="lazy"
                class="w-full h-full object-contain"
              />
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Tab strip: recents, favourites, then one per installed set. -->
    <div class="flex items-center gap-1 p-1.5 border-t border-vault-border overflow-x-auto">
      <button
        on:click={() => (tab = 'recent')}
        class="shrink-0 px-2 py-1 rounded-lg text-[10px] focus:outline-none
          {tab === 'recent' ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim'}"
      >Recent</button>
      <button
        on:click={() => (tab = 'fav')}
        class="shrink-0 px-2 py-1 rounded-lg text-[10px] focus:outline-none
          {tab === 'fav' ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim'}"
      >★</button>
      {#each sets as set (set.id)}
        <button
          on:click={() => (tab = set.id)}
          title={set.title}
          class="shrink-0 px-2 py-1 rounded-lg text-[10px] max-w-20 truncate focus:outline-none
            {tab === set.id ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim'}"
        >{set.title}</button>
      {/each}
    </div>
  {/if}
</div>
