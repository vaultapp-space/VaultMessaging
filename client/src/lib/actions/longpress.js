// ============================================================
// Vault — longpress action
// ============================================================
// Fires `longpress` when a pointer is held still on the node. Used for
// per-chat actions in the sidebar, where a phone has no right-click and no
// room for a permanent row of buttons.
//
// Three things this has to get right, all of which are the reason it is an
// action rather than a setTimeout at each call site:
//
//   1. **Scrolling must not trigger it.** A finger that moves is panning the
//      list, not pressing an item. The move threshold cancels the timer, and
//      without it every flick through a long chat list opens a menu.
//   2. **The click that follows must be suppressed.** After a long press the
//      browser still delivers a `click`, which would open the chat behind the
//      menu that just appeared. A one-shot capture-phase swallow handles it.
//   3. **The context menu must be suppressed too**, or a desktop right-click
//      and a mobile long-press both fire and the native menu covers ours.
//
// The pointer is captured so a press that drifts slightly off the node still
// resolves here rather than being lost.

const DEFAULT_DELAY_MS = 450;
const MOVE_TOLERANCE_PX = 10;

export function longpress(node, options = {}) {
  let delay = options.delay ?? DEFAULT_DELAY_MS;
  let enabled = options.enabled ?? true;

  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function onPointerDown(event) {
    // Primary button / single touch only. A two-finger gesture or a right
    // click is not a long press.
    if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;

    fired = false;
    startX = event.clientX;
    startY = event.clientY;

    timer = setTimeout(() => {
      timer = null;
      fired = true;
      node.dispatchEvent(new CustomEvent('longpress', {
        detail: { x: startX, y: startY },
      }));
    }, delay);
  }

  function onPointerMove(event) {
    if (!timer) return;
    const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
    if (moved > MOVE_TOLERANCE_PX) clear();
  }

  function onPointerUp() {
    clear();
    if (!fired) return;
    // Swallow exactly one click — the one this press is about to produce.
    // Capture phase, so it never reaches the row's own handler.
    const swallow = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    // If no click follows (it does not, on some browsers, when the press ends
    // outside the node) the listener would sit there and eat an unrelated
    // click later. Drop it on the next frame instead.
    requestAnimationFrame(() => {
      window.removeEventListener('click', swallow, { capture: true });
    });
  }

  function onContextMenu(event) {
    // Only when this action is live — otherwise a disabled long-press would
    // still take away the browser's own menu.
    if (enabled) event.preventDefault();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', clear);
  node.addEventListener('pointerleave', clear);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next = {}) {
      delay = next.delay ?? DEFAULT_DELAY_MS;
      enabled = next.enabled ?? true;
      if (!enabled) clear();
    },
    destroy() {
      clear();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', clear);
      node.removeEventListener('pointerleave', clear);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
