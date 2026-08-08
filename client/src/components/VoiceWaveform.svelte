<script>
  // Small live level-meter for a MediaStream — reassurance that audio is
  // actually flowing on a call, not just that the connection is "ongoing".
  // Driven by real analyser data rather than a synthetic CSS loop, so it
  // still functions under prefers-reduced-motion (app.css caps the bars'
  // own transition duration there; the underlying levels keep updating,
  // they just stop tweening between values).
  import { onDestroy } from 'svelte';

  export let stream = null;
  export let bars = 5;
  export let color = 'bg-vault-accent';

  let levels = new Array(bars).fill(0.08);
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let dataArray = null;

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (source) { try { source.disconnect(); } catch {} source = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    levels = new Array(bars).fill(0.08);
  }

  function tick() {
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);
    // One bar per frequency-band slice, floored so silence still shows a
    // faint baseline rather than fully-collapsed bars (reads as "muted or
    // dead" rather than "quiet").
    const sliceSize = Math.floor(dataArray.length / bars);
    levels = Array.from({ length: bars }, (_, i) => {
      const slice = dataArray.subarray(i * sliceSize, (i + 1) * sliceSize);
      const avg = slice.reduce((sum, v) => sum + v, 0) / (slice.length || 1);
      return Math.max(0.08, Math.min(1, avg / 160));
    });
    rafId = requestAnimationFrame(tick);
  }

  $: setup(stream);

  function setup(s) {
    teardown();
    if (!s || s.getAudioTracks().length === 0) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.6;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source = audioCtx.createMediaStreamSource(s);
      source.connect(analyser);
      rafId = requestAnimationFrame(tick);
    } catch (err) {
      console.error('VoiceWaveform: could not attach analyser:', err);
    }
  }

  onDestroy(teardown);
</script>

<div class="flex items-end gap-0.5 h-4" aria-hidden="true">
  {#each levels as level}
    <div
      class="w-1 rounded-full {color} transition-[height] duration-100 ease-out"
      style="height: {Math.round(level * 100)}%; opacity: {0.4 + level * 0.6}"
    ></div>
  {/each}
</div>
