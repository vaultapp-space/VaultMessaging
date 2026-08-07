<script>
  // ============================================================
  // Forum topics
  // ============================================================
  // A strip of named threads inside a group. Selecting one narrows the
  // message list to it, and sending while it is selected tags the message
  // with it — which is what makes topics separate conversations rather than
  // one interleaved stream with labels on it.
  //
  // Only shown when the group is actually a forum. A topic bar on an ordinary
  // group would imply a structure that does not exist.

  import { onMount } from 'svelte';
  import { fetchTopics, createTopic, updateTopic, setForum } from '../lib/api/http.js';
  import { onWsEvent } from '../lib/api/ws.js';

  export let chatId;
  export let isForum = false;
  export let canModerate = false;
  export let activeTopicId = null;
  export let onSelect = null;

  let topics = [];
  let showCreate = false;
  let draftTitle = '';
  let busy = false;

  const unsubscribers = [];

  onMount(() => {
    if (isForum) load();
    unsubscribers.push(
      onWsEvent('topic_created', (data) => {
        if (data.chatId === chatId) load();
      }),
    );
    return () => { for (const unsub of unsubscribers) unsub(); };
  });

  // Reload when the chat changes; a topic list left over from another group
  // would silently file messages into the wrong conversation.
  $: if (chatId && isForum) load();

  async function load() {
    try {
      const res = await fetchTopics(chatId);
      topics = res.topics ?? [];
    } catch (err) {
      console.error('Failed to load topics:', err);
    }
  }

  async function make() {
    const title = draftTitle.trim();
    if (!title || busy) return;
    busy = true;
    try {
      const topic = await createTopic(chatId, { title });
      draftTitle = '';
      showCreate = false;
      await load();
      select(topic.topicId);
    } catch (err) {
      console.error('Failed to create topic:', err);
    } finally {
      busy = false;
    }
  }

  async function enableForum() {
    if (busy) return;
    busy = true;
    try {
      await setForum(chatId, true);
      isForum = true;
      await load();
    } catch (err) {
      console.error('Failed to enable topics:', err);
    } finally {
      busy = false;
    }
  }

  async function toggleClosed(topic) {
    try {
      await updateTopic(chatId, topic.topicId, { closed: !topic.closed });
      await load();
    } catch (err) {
      console.error('Failed to update topic:', err);
    }
  }

  function select(topicId) {
    activeTopicId = topicId;
    onSelect?.(topicId);
  }

  $: activeTopic = topics.find((t) => t.topicId === activeTopicId) ?? null;
</script>

{#if isForum}
  <div class="flex items-center gap-1 px-2 py-1.5 border-b border-vault-border overflow-x-auto">
    <button
      on:click={() => select(null)}
      class="shrink-0 px-2 py-1 rounded-lg text-[10px] transition-colors focus:outline-none
        {activeTopicId === null ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim hover:text-vault-text'}"
    >All</button>

    {#each topics as topic (topic.topicId)}
      <button
        on:click={() => select(topic.topicId)}
        on:dblclick={() => canModerate && toggleClosed(topic)}
        title={topic.closed ? 'Closed' : (canModerate ? 'Select, then use Close' : topic.title)}
        class="shrink-0 px-2 py-1 rounded-lg text-[10px] transition-colors focus:outline-none
          {activeTopicId === topic.topicId ? 'bg-vault-accent/15 text-vault-accent' : 'text-vault-text-dim hover:text-vault-text'}
          {topic.closed ? 'line-through opacity-60' : ''}"
      >
        {topic.iconEmoji ?? ''}{topic.title}
      </button>
    {/each}

    {#if canModerate && activeTopic}
      <button
        on:click={() => toggleClosed(activeTopic)}
        class="shrink-0 px-2 py-1 rounded-lg text-[10px] text-vault-text-dim hover:text-vault-accent focus:outline-none"
        title={activeTopic.closed ? 'Reopen this topic' : 'Close this topic'}
      >{activeTopic.closed ? 'Reopen' : 'Close'}</button>
    {/if}

    <button
      on:click={() => (showCreate = !showCreate)}
      class="shrink-0 px-2 py-1 rounded-lg text-[10px] text-vault-text-dim hover:text-vault-accent focus:outline-none"
      title="New topic"
    >+</button>
  </div>

  {#if showCreate}
    <div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-vault-border">
      <input
        bind:value={draftTitle}
        on:keydown={(e) => e.key === 'Enter' && make()}
        placeholder="Topic name"
        maxlength="128"
        class="flex-1 px-2 py-1 rounded-lg bg-vault-elevated border border-vault-border text-[11px] text-vault-text focus:outline-none focus:border-vault-accent"
      />
      <button
        on:click={make}
        disabled={busy || !draftTitle.trim()}
        class="text-[10px] text-vault-accent disabled:opacity-40 focus:outline-none"
      >Create</button>
    </div>
  {/if}
{:else if canModerate}
  <button
    on:click={enableForum}
    disabled={busy}
    class="w-full px-3 py-1.5 text-left text-[10px] text-vault-text-dim hover:text-vault-accent transition-colors focus:outline-none"
  >{busy ? 'Enabling…' : 'Turn on topics →'}</button>
{/if}
