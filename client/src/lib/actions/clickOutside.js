// ============================================================
// Vault — clickOutside action
// ============================================================
// Calls the handler when a pointer or focus event lands outside the node.
// Used to dismiss popovers (the reaction picker, and anything similar that
// follows) without each one hand-rolling its own document listener and
// forgetting to remove it.

export function clickOutside(node, handler) {
  let callback = handler;

  function onPointerDown(event) {
    // `composedPath` rather than `contains` so a click inside a shadow root or
    // on an element removed during the same tick still counts as inside.
    if (typeof callback === 'function' && !event.composedPath().includes(node)) {
      callback(event);
    }
  }

  function onKeyDown(event) {
    // Escape should dismiss a popover as reliably as clicking away does.
    if (event.key === 'Escape' && typeof callback === 'function') {
      callback(event);
    }
  }

  // Capture phase: a handler that stops propagation inside the popover must
  // not prevent an outside click from closing it.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);

  return {
    update(next) {
      callback = next;
    },
    destroy() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
