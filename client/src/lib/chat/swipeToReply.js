// ============================================================
// Vault — Swipe-to-reply action
// ============================================================
// The gesture every modern messenger has and this one did not: drag a message
// sideways to reply to it. Same shape as draggable.js — a Svelte action so the
// component keeps one attribute instead of six handlers, with the arithmetic
// split out as a pure function so the part that can actually be wrong is
// testable without a browser.
//
// Horizontal only, and only in the direction that points "inward" from the
// bubble's own side, so the gesture never fights the vertical scroll of the
// transcript underneath it.

/**
 * How far the bubble has actually moved, given a raw drag delta.
 *
 * Pure because this is where the behaviour lives: the drag is clamped to one
 * direction and rubber-banded past the trigger point, so the bubble keeps
 * responding to the finger without sliding off the screen. Returns 0 for a
 * drag the wrong way rather than a negative offset, which would let the
 * bubble escape its own side of the transcript.
 *
 * @param {number} dx raw horizontal delta in px
 * @param {number} direction +1 to allow rightward drag, -1 for leftward
 * @param {number} trigger px at which the reply fires
 * @returns {number} the offset to render, always in `direction`'s sign
 */
export function swipeOffset(dx, direction, trigger) {
  const travel = dx * direction;
  if (travel <= 0) return 0;
  // Past the trigger the bubble still moves, but at a third of the rate — the
  // standard rubber-band cue that you have gone far enough.
  const eased = travel <= trigger ? travel : trigger + (travel - trigger) / 3;
  return eased * direction;
}

/**
 * Svelte action. Usage:
 *
 *     <div use:swipeToReply={{ direction: -1, onReply: () => ... }}>
 *
 * @param {HTMLElement} node
 * @param {{ direction?: number, trigger?: number, onReply: () => void,
 *           onOffset?: (px: number) => void, enabled?: boolean }} options
 */
export function swipeToReply(node, options) {
  let opts = { direction: -1, trigger: 56, enabled: true, ...options };

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let offset = 0;
  // Undecided until the finger has moved enough to show intent. Locking the
  // axis matters: without it a mostly-vertical scroll that drifts sideways
  // would drag the bubble and fight the list.
  let axis = null;

  const AXIS_LOCK_PX = 8;

  // Same guard draggable.js applies, and for a sharper reason here: a message
  // bubble contains up to 13 buttons and, for a voice note, an <audio controls>
  // element whose scrubber is dragged *horizontally* — precisely the gesture
  // this action claims and calls preventDefault() on. Without this, seeking a
  // voice note would drag the bubble instead of moving the playhead.
  const isInteractive = (target) =>
    target?.closest?.('button, audio, video, input, a, [role="button"]');

  function emit(px) {
    offset = px;
    opts.onOffset?.(px);
  }

  function onPointerDown(event) {
    if (!opts.enabled) return;
    // Mouse drags are not how anyone replies; this is a touch affordance, and
    // claiming the mouse would break text selection in the bubble.
    if (event.pointerType === 'mouse') return;
    if (isInteractive(event.target)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    axis = null;
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (axis === null) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      // A vertical drag belongs to the scroller; let go of it entirely.
      if (axis === 'y') {
        pointerId = null;
        return;
      }
      node.setPointerCapture?.(event.pointerId);
    }

    if (axis !== 'x') return;
    // Only once the axis is known to be horizontal — calling this on an
    // undecided gesture would cancel scrolling that was never ours.
    if (event.cancelable) event.preventDefault();
    emit(swipeOffset(dx, opts.direction, opts.trigger));
  }

  function onPointerUp(event) {
    if (event.pointerId !== pointerId) return;
    const fired = Math.abs(offset) >= opts.trigger;
    pointerId = null;
    axis = null;
    emit(0);
    if (fired) opts.onReply();
  }

  function onPointerCancel() {
    pointerId = null;
    axis = null;
    emit(0);
  }

  node.addEventListener('pointerdown', onPointerDown, { passive: true });
  // Not passive: a horizontal drag has to be able to preventDefault so the
  // transcript does not scroll underneath the gesture.
  node.addEventListener('pointermove', onPointerMove, { passive: false });
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);

  return {
    update(next) {
      opts = { direction: -1, trigger: 56, enabled: true, ...next };
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
