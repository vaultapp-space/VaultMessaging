<script>
  // ============================================================
  // Full-screen media viewer
  // ============================================================
  // Replaces `window.open(objectUrl, '_blank')`, which was the only way to see
  // a received photo at full size. That never worked reliably in the Android
  // app: a Capacitor WebView has no tab model, which is the whole reason
  // lib/openExternal.js exists — and unlike an ordinary link, a blob: URL has
  // nowhere to be handed off to, so tapping a photo could do nothing at all.
  // On the web it "worked" by dumping a bare blob into browser chrome.
  //
  // Mounted once at the app root (App.svelte), like ConfirmDialog and
  // ToastHost: the message list lives inside an overflow-hidden, z-0 stacking
  // context, so a viewer rendered inside a bubble could never cover the screen.
  import { fade, scale } from 'svelte/transition';
  import { lightbox, closeLightbox } from '../lib/stores/lightbox.js';
  import { pushBackHandler } from '../lib/backHandler.js';

  // Pinch-zoom and pan, kept deliberately small: two pointers set the scale,
  // one pointer pans while zoomed, and a downward drag at rest dismisses.
  // Using Pointer Events rather than Touch means the same code drives a mouse
  // drag on desktop without a second path.
  let scaleValue = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  /** @type {Map<number, {x: number, y: number}>} */
  const pointers = new Map();
  let popBack = null;

  const MAX_SCALE = 4;
  // How far a one-finger drag has to travel, at rest, to count as a dismiss.
  const DISMISS_PX = 110;

  function reset() {
    scaleValue = 1;
    tx = 0;
    ty = 0;
    dragging = false;
    pointers.clear();
  }

  // Registers with the same LIFO stack the Android back button and desktop
  // Escape both read (lib/backHandler.js), so the viewer closes rather than
  // the app minimising or a panel underneath it closing first.
  $: if ($lightbox && !popBack) {
    reset();
    popBack = pushBackHandler(() => closeLightbox());
  } else if (!$lightbox && popBack) {
    popBack();
    popBack = null;
  }

  function distance() {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(event) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2) {
      pinchStartDist = distance();
      pinchStartScale = scaleValue;
      dragging = false;
    } else if (pointers.size === 1) {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startTx = tx;
      startTy = ty;
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchStartDist > 0) {
      const next = (distance() / pinchStartDist) * pinchStartScale;
      scaleValue = Math.min(MAX_SCALE, Math.max(1, next));
      return;
    }

    if (dragging && pointers.size === 1) {
      tx = startTx + (event.clientX - startX);
      ty = startTy + (event.clientY - startY);
    }
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);

    if (pointers.size < 2) pinchStartDist = 0;

    if (dragging && pointers.size === 0) {
      dragging = false;
      // Only a drag on an unzoomed image is a dismiss. While zoomed the same
      // gesture is a pan, and closing on it would make the image impossible
      // to look around.
      if (scaleValue <= 1.01 && Math.abs(ty) > DISMISS_PX) {
        closeLightbox();
        return;
      }
      if (scaleValue <= 1.01) {
        tx = 0;
        ty = 0;
      }
    }
  }

  function toggleZoom() {
    if (scaleValue > 1.01) {
      reset();
    } else {
      scaleValue = 2;
    }
  }

  // Fades the backdrop out as the image is dragged away, so the dismiss reads
  // as direct manipulation rather than a button press.
  $: dragProgress = scaleValue <= 1.01
    ? Math.min(1, Math.abs(ty) / (DISMISS_PX * 2))
    : 0;
</script>

{#if $lightbox}
  <!-- Backdrop tap-to-dismiss is a pointer affordance; keyboard users close
       with Escape, which lib/backHandler.js routes here via the same stack the
       Android back button uses (registered above). -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-vault-black touch-none select-none"
    style="opacity: {1 - dragProgress * 0.6}"
    transition:fade={{ duration: 160 }}
    on:click|self={closeLightbox}
    on:pointerdown={onPointerDown}
    on:pointermove={onPointerMove}
    on:pointerup={onPointerUp}
    on:pointercancel={onPointerUp}
    role="dialog"
    aria-modal="true"
    aria-label="Image viewer"
    tabindex="-1"
  >
    <img
      src={$lightbox.src}
      alt={$lightbox.alt}
      draggable="false"
      on:dblclick={toggleZoom}
      class="max-w-full max-h-full object-contain"
      style="transform: translate({tx}px, {ty}px) scale({scaleValue}); transition: {dragging ? 'none' : 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)'};"
      transition:scale={{ duration: 200, start: 0.92, opacity: 0 }}
    />

    <button
      on:click|stopPropagation={closeLightbox}
      class="absolute top-[calc(0.75rem+env(safe-area-inset-top,0px))] right-3 w-9 h-9 rounded-full bg-vault-surface/80 border border-vault-border text-vault-text flex items-center justify-center backdrop-blur-md focus:outline-none"
      aria-label="Close image viewer"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>

    <p
      class="absolute bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] inset-x-0 text-center text-[11px] text-vault-text-dim pointer-events-none"
      style="opacity: {scaleValue > 1.01 ? 0 : 1}"
    >
      Double-tap to zoom · swipe down to close
    </p>
  </div>
{/if}
