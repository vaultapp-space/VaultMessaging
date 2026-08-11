// ============================================================
// Vault — Draggable action
// ============================================================
// The floating call window's drag behaviour, lifted out of ChatView.svelte
// where it accounted for ~50 lines of pointer bookkeeping that had nothing to
// do with messaging.
//
// Exposed as a Svelte action so the component keeps one attribute instead of
// six handlers, and as a pure `nextPosition` helper so the arithmetic — the
// part that actually breaks — can be unit tested without a browser.

/**
 * Pure translation maths. Split out because it is the only part with a
 * correctness question in it: the new position must be the drag delta applied
 * to where the element was when the drag *started*, not to where it is now.
 */
export function nextPosition(initial, start, current) {
  return {
    x: initial.x + (current.x - start.x),
    y: initial.y + (current.y - start.y),
  };
}

/**
 * Keeps a dragged element overlapping the viewport.
 *
 * Without this the call window could be dragged clean off the screen and there
 * was no way to get it back: the offset is component state, nothing resets it,
 * and the window is the only thing carrying the end-call button. On a phone
 * that is a call you cannot hang up without killing the app.
 *
 * Clamps so that at least MIN_VISIBLE px of the element stay on screen on
 * every edge, rather than forbidding overflow entirely — being able to push a
 * video window mostly off to peek at the conversation behind it is useful, and
 * is the behaviour every picture-in-picture has.
 *
 * @param {{x: number, y: number}} pos desired offset
 * @param {{width: number, height: number}} size element size
 * @param {{width: number, height: number}} viewport
 * @param {{top: number, right: number}} anchor element's untransformed offset
 *        from the viewport's top-right (it is positioned top-4 right-4)
 */
export function clampToViewport(pos, size, viewport, anchor = { top: 16, right: 16 }) {
  const MIN_VISIBLE = 56;

  // The element sits at top-right by default and is moved by a transform, so
  // its on-screen box is derived from that anchor plus the offset.
  const left = viewport.width - anchor.right - size.width + pos.x;
  const top = anchor.top + pos.y;

  const minLeft = MIN_VISIBLE - size.width;
  const maxLeft = viewport.width - MIN_VISIBLE;
  const minTop = 0;
  const maxTop = viewport.height - MIN_VISIBLE;

  const clampedLeft = Math.min(Math.max(left, minLeft), maxLeft);
  const clampedTop = Math.min(Math.max(top, minTop), maxTop);

  return {
    x: pos.x + (clampedLeft - left),
    y: pos.y + (clampedTop - top),
  };
}

/**
 * Svelte action. Usage:
 *
 *     <div use:draggable={{ position, onMove: (p) => (position = p) }}>
 *
 * Drags started on a button or a video are ignored so the window's own
 * controls and the video surface stay interactive.
 */
export function draggable(node, options = {}) {
  let { position = { x: 0, y: 0 }, onMove = () => {}, onDragChange = () => {} } = options;

  let dragging = false;
  let start = { x: 0, y: 0 };
  let initial = { x: 0, y: 0 };

  const isInteractive = (target) =>
    target?.closest?.('button') || target?.closest?.('video');

  // Measures the node each time rather than caching: the call window changes
  // size when the user switches normal/large, and a stale size would clamp
  // against the wrong box.
  function clampNode(pos) {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return pos;
    return clampToViewport(
      pos,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
  }

  function begin(clientX, clientY) {
    dragging = true;
    start = { x: clientX, y: clientY };
    initial = { ...position };
    onDragChange(true);
  }

  function end() {
    dragging = false;
    onDragChange(false);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
  }

  function onMouseDown(e) {
    if (e.button !== 0 || isInteractive(e.target)) return;
    begin(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!dragging) return;
    position = clampNode(nextPosition(initial, start, { x: e.clientX, y: e.clientY }));
    onMove(position);
  }

  function onMouseUp() {
    end();
  }

  function onTouchStart(e) {
    if (isInteractive(e.target)) return;
    const touch = e.touches[0];
    begin(touch.clientX, touch.clientY);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  }

  function onTouchMove(e) {
    if (!dragging) return;
    e.preventDefault(); // stop the page scrolling under the drag
    const touch = e.touches[0];
    position = clampNode(nextPosition(initial, start, { x: touch.clientX, y: touch.clientY }));
    onMove(position);
  }

  function onTouchEnd() {
    end();
  }

  node.addEventListener('mousedown', onMouseDown);
  node.addEventListener('touchstart', onTouchStart);

  return {
    update(next = {}) {
      if (next.position) position = next.position;
      if (next.onMove) onMove = next.onMove;
      if (next.onDragChange) onDragChange = next.onDragChange;
    },
    destroy() {
      // Without this, a call window unmounted mid-drag leaves window-level
      // listeners behind for the lifetime of the tab.
      end();
      node.removeEventListener('mousedown', onMouseDown);
      node.removeEventListener('touchstart', onTouchStart);
    },
  };
}
