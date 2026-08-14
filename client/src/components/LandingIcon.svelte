<script>
  // ============================================================
  // Landing page line icons
  // ============================================================
  // Inline rather than <use href="/icons.svg#…"> on purpose: each path is
  // animated individually (drawn on reveal via stroke-dashoffset), and a
  // sprite reference gives you one opaque shadow node with nothing to target.
  //
  // Every path carries pathLength="1", which renormalises its geometry so
  // stroke-dasharray: 1 means "exactly one full length" regardless of how long
  // the path actually is. Without it each icon needs its own measured dash
  // value and they all finish drawing at different times.
  export let name;
  export let size = 22;

  // Arcs rather than <circle>, because pathLength on a circle element is SVG2
  // and support is thinner than for paths — a circle that ignores pathLength
  // renders its dasharray in user units and flickers as a dotted ring.
  const icons = {
    groups: [
      'M5.8 8a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0',
      'M2.5 20c0-3.3 2.9-5.2 6.5-5.2s6.5 1.9 6.5 5.2',
      'M15.1 9.5a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0',
      'M17 14.9c2.8.3 4.7 2.1 4.7 5.1',
    ],
    files: [
      'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
      'M14 3v5h5',
      'M9 13h6',
      'M9 17h4',
    ],
    calls: [
      'M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z',
    ],
    signin: [
      'M4 13v-1a8 8 0 0 1 8-8',
      'M20 12a8 8 0 0 0-4-6.9',
      'M8 17v-5a4 4 0 0 1 4-4',
      'M16 12v4',
      'M12 12v7',
    ],
    devices: [
      'M4 9V5h5',
      'M15 5h5v4',
      'M4 15v4h5',
      'M15 19h5v-4',
      'M9.5 9.5h5v5h-5z',
    ],
    // A bin, not the "dissolving square" that was here first: two corner
    // brackets and three dots was legible at 64px and pure noise at 22, which
    // is the only size it is ever drawn at.
    memory: [
      'M4 7h16',
      'M9.5 7V4.5h5V7',
      'M6.5 7l1 12.5h9L17.5 7',
      'M10.5 10.5v6',
      'M13.5 10.5v6',
    ],
    thoughts: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
      'M3.5 9h17',
      'M3.5 15h17',
      'M12 3c3 3.6 3 14.4 0 18',
      'M12 3c-3 3.6-3 14.4 0 18',
    ],
    lock: [
      'M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
      'M8.5 10V7a3.5 3.5 0 0 1 7 0v3',
      'M12 14v3',
    ],
    transit: [
      'M4 8l8-4 8 4v8l-8 4-8-4z',
      'M4 8l8 4 8-4',
      'M12 12v8',
    ],
    key: [
      'M11.5 9a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0',
      'M12.5 11.5L4 20',
      'M7 17l2 2',
      'M9.5 14.5l2 2',
    ],
  };

  $: paths = icons[name] ?? [];
</script>

<svg
  class="li-icon"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each paths as d, i (d)}
    <path {d} pathLength="1" style="--i:{i}" />
  {/each}
</svg>

<style>
  .li-icon { display: block; overflow: visible; }
</style>
