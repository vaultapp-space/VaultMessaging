<script>
  // ============================================================
  // Writing a thought
  // ============================================================
  // Used for both a new post and a reply — the API is the same row shape with
  // a different reference, so this is one component with a `replyToId` rather
  // than two that drift apart.
  import { createEventDispatcher } from 'svelte';

  import { createPost, uploadPublicMedia, publicMediaUrl } from '../../lib/api/http.js';
  import { readImageDimensions } from '../../lib/chat/metadata.js';
  import { showToast } from '../../lib/stores/toast.js';
  import { hapticLight } from '../../lib/haptics.js';

  export let replyToId = null;
  export let placeholder = 'Say something. It disappears in 24 hours.';

  const MAX_LENGTH = 500;
  const MAX_MEDIA_BYTES = 512 * 1024;
  // Matches the server's allowlist (media.routes.js). SVG is excluded there
  // deliberately — it can carry script — so it is not offered here either.
  const ACCEPT = 'image/webp,image/png,image/gif,video/webm';

  const dispatch = createEventDispatcher();

  let body = '';
  let media = null;      // { fileId, mimeType, width, height, previewUrl }
  let uploading = false;
  let sending = false;
  let fileInput;
  let textarea;

  $: remaining = MAX_LENGTH - body.length;
  $: canSend = !sending && !uploading && (body.trim().length > 0 || media !== null);

  function autoGrow() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  async function pickFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Checked here as well as server-side so the user is told before spending
    // an upload on it; the server's 413 is the authority.
    if (file.size > MAX_MEDIA_BYTES) {
      showToast('Images must be under 512KB.');
      event.target.value = '';
      return;
    }

    uploading = true;
    try {
      // Dimensions travel with the post so the recipient can reserve the right
      // box before the image loads — the same reason attachments carry them.
      const dimensions = await readImageDimensions(file);
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { fileId } = await uploadPublicMedia(file.type, base64);
      media = {
        fileId,
        mimeType: file.type,
        ...(dimensions ?? {}),
        previewUrl: publicMediaUrl(fileId),
      };
    } catch (err) {
      showToast(err?.message || 'That file type is not supported.');
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function submit() {
    if (!canSend) return;
    sending = true;
    try {
      // previewUrl is local-only and must not be sent: the server's media
      // schema is additionalProperties:false, so an extra key is a 400.
      const { previewUrl: _previewUrl, ...mediaPayload } = media ?? {};
      const { post } = await createPost({
        body: body.trim() || null,
        media: media ? mediaPayload : null,
        replyToId,
      });
      hapticLight();
      body = '';
      media = null;
      if (textarea) textarea.style.height = 'auto';
      dispatch('posted', post);
    } catch (err) {
      showToast(err?.message || 'Could not post that');
    } finally {
      sending = false;
    }
  }

  function onKeydown(event) {
    // Enter inserts a newline; a post is more like a paragraph than a chat
    // message, and losing a half-written thought to a stray Enter is worse
    // than needing a modifier to send.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="px-4 py-3 border-b border-vault-border">
  <textarea
    bind:this={textarea}
    bind:value={body}
    on:input={autoGrow}
    on:keydown={onKeydown}
    {placeholder}
    maxlength={MAX_LENGTH}
    rows="2"
    class="w-full bg-transparent text-sm text-vault-text placeholder:text-vault-text-dim resize-none outline-none"
  ></textarea>

  {#if media}
    <div class="relative inline-block mt-2">
      <img
        src={media.previewUrl}
        alt=""
        class="max-h-40 rounded-xl border border-vault-border"
      />
      <button
        on:click={() => (media = null)}
        class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-vault-black/70 text-vault-text flex items-center justify-center backdrop-blur-sm focus:outline-none"
        aria-label="Remove image"
      >
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  <div class="flex items-center justify-between mt-2">
    <div class="flex items-center gap-2">
      <input
        bind:this={fileInput}
        on:change={pickFile}
        type="file"
        accept={ACCEPT}
        class="hidden"
        id="post-media-{replyToId ?? 'root'}"
      />
      <label
        for="post-media-{replyToId ?? 'root'}"
        class="p-1.5 rounded-lg text-vault-text-dim hover:text-vault-accent hover:bg-vault-elevated transition-colors cursor-pointer"
        title="Add an image"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </label>
      {#if uploading}
        <span class="text-[10px] text-vault-text-dim">Uploading…</span>
      {/if}
    </div>

    <div class="flex items-center gap-3">
      {#if remaining <= 100}
        <span class="text-[10px] {remaining < 0 ? 'text-vault-danger' : 'text-vault-text-dim'}">
          {remaining}
        </span>
      {/if}
      <button
        on:click={submit}
        disabled={!canSend}
        class="px-3.5 py-1.5 rounded-xl bg-vault-accent text-vault-black text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none transition-all"
      >
        {sending ? 'Posting…' : replyToId ? 'Reply' : 'Post'}
      </button>
    </div>
  </div>
</div>
