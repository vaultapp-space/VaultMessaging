<script>
  import { votePoll } from '../lib/api/http.js';

  export let poll;
  export let chatId;
  export let seq;

  let busy = false;
  let error = '';
  // Staged selections for a multiple-choice poll, which needs a submit step.
  // Single-choice votes fire on click, like Telegram's.
  let staged = new Set();

  $: hasVoted = poll?.options?.some((o) => o.mine) ?? false;
  // Results are hidden until you have voted — seeing the running tally first
  // biases the answer, which is the whole reason Telegram hides it too.
  $: showResults = hasVoted || poll?.closed;
  $: total = poll?.totalVoters ?? 0;

  function pct(option) {
    if (total === 0) return 0;
    return Math.round((option.votes / total) * 100);
  }

  function toggleStaged(id) {
    staged = new Set(staged.has(id) ? [...staged].filter((x) => x !== id) : [...staged, id]);
  }

  async function submit(optionIds) {
    if (busy || poll.closed || optionIds.length === 0) return;
    busy = true;
    error = '';
    try {
      const res = await votePoll(chatId, seq, optionIds);
      poll = res.poll;
      staged = new Set();
    } catch (err) {
      console.error('Failed to vote:', err);
      error = 'Could not record your vote.';
    } finally {
      busy = false;
    }
  }
</script>

{#if poll}
  <div class="flex flex-col gap-1.5 text-left">
    <div class="text-sm font-medium break-words">{poll.question}</div>
    <div class="text-[10px] text-vault-text-dim">
      {poll.isAnonymous ? 'Anonymous poll' : 'Public poll'}{poll.allowsMultiple ? ' · pick several' : ''}{poll.closed ? ' · closed' : ''}
    </div>

    <div class="flex flex-col gap-1 mt-0.5">
      {#each poll.options as option (option.id)}
        <button
          type="button"
          disabled={busy || poll.closed}
          on:click={() => (poll.allowsMultiple ? toggleStaged(option.id) : submit([option.id]))}
          class="relative w-full text-left px-2 py-1.5 rounded-md overflow-hidden border transition-colors
                 {option.mine ? 'border-vault-accent' : 'border-vault-border'}
                 {poll.closed ? 'cursor-default' : 'hover:bg-vault-black/20'}
                 {staged.has(option.id) ? 'bg-vault-accent/10' : ''}"
        >
          {#if showResults}
            <!-- The filled bar sits behind the label rather than beside it, so
                 a long option never gets squeezed by the percentage. -->
            <div
              class="absolute inset-y-0 left-0 bg-vault-accent/20 pointer-events-none"
              style="width: {pct(option)}%"
            ></div>
          {/if}
          <div class="relative flex items-center justify-between gap-2">
            <span class="text-xs break-words">
              {#if option.mine}<span class="text-vault-accent">✓ </span>{/if}{option.text}
            </span>
            {#if showResults}
              <span class="text-[10px] text-vault-text-dim shrink-0">{pct(option)}%</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>

    {#if poll.allowsMultiple && !poll.closed}
      <button
        type="button"
        disabled={busy || staged.size === 0}
        on:click={() => submit([...staged])}
        class="self-start text-[11px] px-2 py-1 rounded-md bg-vault-accent/20 text-vault-accent disabled:opacity-40"
      >
        {hasVoted ? 'Change vote' : 'Vote'}
      </button>
    {/if}

    <div class="text-[10px] text-vault-text-dim">
      {total === 0 ? 'No votes yet' : `${total} ${total === 1 ? 'vote' : 'votes'}`}
    </div>

    {#if error}
      <div class="text-[10px] text-vault-danger">{error}</div>
    {/if}
  </div>
{/if}
