<script>
  // ============================================================
  // Stories
  // ============================================================
  // Media on a profile that expires. The cheapest feature in the plan,
  // because the whole product is already built around 24-hour expiry — a
  // story is media with a TTL and a viewer list.
  //
  // The one thing worth stating in the UI: a story's "24 hours" is not a
  // story-specific rule. It is the same ceiling everything else here lives
  // under, so there is no setting to extend it.

  import { onMount } from 'svelte';
  import {
    fetchStories, postStory, markStoryViewed, fetchStoryViewers, deleteStory,
    uploadPublicMedia, publicMediaUrl,
  } from '../lib/api/http.js';
  import { currentUser } from '../lib/stores/session.js';
  import { getAvatarGradient } from '../lib/avatar.js';

  let stories = [];
  let loading = true;
  let error = '';

  let open = null;          // the story being viewed
  let viewers = [];
  let showCompose = false;
  let caption = '';
  let privacy = 'contacts';
  let posting = false;

  // A story's image goes through the *public* file path, not the E2EE
  // attachment path. Attachments are encrypted per-recipient and expire in
  // 24h; a story is shown to an audience the author chose and is not
  // encrypted to anyone in particular. Running it through the attachment path
  // would mean encrypting to a recipient list that does not exist.
  let fileInput;
  let pendingFile = null;   // { fileId, mimeType, previewUrl }
  let uploading = false;

  async function pickFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      error = 'Images must be under 512KB.';
      event.target.value = '';
      return;
    }

    uploading = true;
    error = '';
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { fileId } = await uploadPublicMedia(file.type, base64);
      pendingFile = { fileId, mimeType: file.type, previewUrl: publicMediaUrl(fileId) };
    } catch (err) {
      console.error('Failed to upload story image:', err);
      // The server's mime allowlist is the authority; this is the common case.
      error = 'That file type is not supported.';
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await fetchStories();
      stories = res.stories ?? [];
    } catch (err) {
      console.error('Failed to load stories:', err);
      error = 'Could not load stories.';
    } finally {
      loading = false;
    }
  }

  async function publish() {
    if (posting) return;
    posting = true;
    error = '';
    try {
      await postStory({
        media: pendingFile
          ? { kind: 'photo', fileId: pendingFile.fileId, mimeType: pendingFile.mimeType }
          : { kind: 'text' },
        caption: caption.trim() || null,
        privacy,
      });
      caption = '';
      pendingFile = null;
      showCompose = false;
      await load();
    } catch (err) {
      console.error('Failed to post story:', err);
      error = 'Could not post that story.';
    } finally {
      posting = false;
    }
  }

  async function view(story) {
    open = story;
    viewers = [];
    // Recorded server-side, and refused for a story the caller cannot see —
    // so this cannot be used to probe for someone else's.
    markStoryViewed(story.id).catch(() => {});
    if (story.userId === $currentUser?.id) {
      try {
        const res = await fetchStoryViewers(story.id);
        viewers = res.viewers ?? [];
      } catch {
        // Not worth surfacing.
      }
    }
  }

  async function remove(story) {
    if (!confirm('Delete this story?')) return;
    try {
      await deleteStory(story.id);
      open = null;
      await load();
    } catch (err) {
      console.error('Failed to delete story:', err);
    }
  }

  function expiresIn(story) {
    const ms = new Date(story.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1) return `${hours}h left`;
    return `${Math.max(1, Math.floor(ms / 60000))}m left`;
  }
</script>

{#if !loading && (stories.length > 0 || true)}
  <div class="px-2 py-2 border-b border-vault-border">
    <div class="flex items-center gap-2 overflow-x-auto">
      <button
        on:click={() => (showCompose = !showCompose)}
        class="shrink-0 flex flex-col items-center gap-1 focus:outline-none"
        title="Post a story"
      >
        <div class="w-11 h-11 rounded-full border-2 border-dashed border-vault-border flex items-center justify-center text-vault-text-dim">
          +
        </div>
        <span class="text-[9px] text-vault-text-dim">Add</span>
      </button>

      {#each stories as story (story.id)}
        <button
          on:click={() => view(story)}
          class="shrink-0 flex flex-col items-center gap-1 focus:outline-none"
        >
          <div
            class="w-11 h-11 rounded-full border-2 border-vault-accent flex items-center justify-center text-vault-white text-xs font-semibold"
            style="background: {getAvatarGradient(story.username || 'story')}"
          >
            {(story.username || '?')[0].toUpperCase()}
          </div>
          <span class="text-[9px] text-vault-text-dim max-w-12 truncate">
            {story.username}
          </span>
        </button>
      {/each}
    </div>

    {#if showCompose}
      <div class="mt-2 flex flex-col gap-1.5">
        <input
          type="file"
          accept="image/webp,image/png,image/gif"
          bind:this={fileInput}
          on:change={pickFile}
          class="hidden"
        />

        {#if pendingFile}
          <div class="relative self-start">
            <img
              src={pendingFile.previewUrl}
              alt="Story preview"
              class="h-24 rounded-lg object-contain bg-vault-elevated"
            />
            <button
              on:click={() => (pendingFile = null)}
              class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-vault-black/70 text-vault-text text-[10px] focus:outline-none"
              aria-label="Remove image"
            >✕</button>
          </div>
        {:else}
          <button
            on:click={() => fileInput?.click()}
            disabled={uploading}
            class="self-start px-2 py-1 rounded-lg text-[10px] bg-vault-elevated text-vault-text-dim hover:text-vault-text disabled:opacity-50 focus:outline-none"
          >{uploading ? 'Uploading…' : 'Add an image'}</button>
        {/if}

        <input
          bind:value={caption}
          placeholder="Say something"
          maxlength="1024"
          class="w-full px-2 py-1.5 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
        />
        <div class="flex items-center gap-1.5">
          {#each [['contacts', 'Contacts'], ['everyone', 'Everyone'], ['nobody', 'Only me']] as [value, label] (value)}
            <button
              on:click={() => (privacy = value)}
              class="px-2 py-1 rounded-lg text-[10px] focus:outline-none
                {privacy === value ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim'}"
            >{label}</button>
          {/each}
          <button
            on:click={publish}
            disabled={posting}
            class="ml-auto px-2 py-1 rounded-lg text-[10px] bg-vault-accent text-vault-black font-medium disabled:opacity-50 focus:outline-none"
          >{posting ? 'Posting…' : 'Post'}</button>
        </div>
        <!-- Not a story-specific rule: the same ceiling everything here lives
             under, which is why there is no setting to extend it. -->
        <p class="text-[9px] text-vault-muted">
          Disappears after 24 hours, like every message here.
        </p>
      </div>
    {/if}

    {#if error}
      <div class="text-[10px] text-vault-danger mt-1">{error}</div>
    {/if}
  </div>
{/if}

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
    on:click|self={() => (open = null)}
  >
    <div class="w-full max-w-sm rounded-2xl glass-strong border border-vault-border p-4 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold text-vault-text">{open.username}</div>
        <button
          on:click={() => (open = null)}
          class="text-vault-text-dim hover:text-vault-text focus:outline-none"
          aria-label="Close"
        >✕</button>
      </div>

      <div class="min-h-24 flex flex-col items-center justify-center gap-2 rounded-xl bg-vault-elevated px-3 py-4">
        {#if open.media?.fileId}
          <img
            src={publicMediaUrl(open.media.fileId)}
            alt={open.caption || 'Story'}
            class="max-h-64 rounded-lg object-contain"
          />
        {/if}
        {#if open.caption}
          <p class="text-sm text-vault-text text-center break-words">{open.caption}</p>
        {:else if !open.media?.fileId}
          <p class="text-sm text-vault-text-dim">No caption</p>
        {/if}
      </div>

      <div class="text-[10px] text-vault-text-dim">{expiresIn(open)}</div>

      {#if open.userId === $currentUser?.id}
        <!-- Only the author sees this; the server scopes it to them too. -->
        <div class="text-[10px] text-vault-text-dim">
          {viewers.length} {viewers.length === 1 ? 'view' : 'views'}
          {#if viewers.length > 0}
            · {viewers.map((v) => v.username).join(', ')}
          {/if}
        </div>
        <button
          on:click={() => remove(open)}
          class="self-start text-[10px] text-vault-danger hover:underline focus:outline-none"
        >Delete story</button>
      {/if}
    </div>
  </div>
{/if}
