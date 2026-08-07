// ============================================================
// Vault — Android Hardware/Gesture Back Button
// ============================================================
// Every full-screen panel and modal in the app (Settings, member list,
// safety-number view, sticker picker, poll composer, folder editor, ...)
// is plain component-local boolean state, not a router entry. Without this,
// Android's back button falls through to the WebView's navigation history
// instead of closing whatever panel is open — it can dismiss the whole
// conversation, or exit the app, while the panel is still visually up.
//
// Fix is a shared LIFO stack: any component with a closeable panel pushes a
// close callback while it's open and pops it when it closes (however it
// closed — back button or an in-app close control). The back button always
// closes just the top-most one; with nothing open, it falls back to
// minimizing the app rather than letting the WebView pop through history.

import { get } from 'svelte/store';
import { Capacitor } from '@capacitor/core';
import { confirmState } from './stores/confirm.js';
import { passphrasePromptState } from './stores/passphrasePrompt.js';

const stack = [];
let listenerRegistered = false;

export function pushBackHandler(onBack) {
  stack.push(onBack);
  return () => {
    const idx = stack.lastIndexOf(onBack);
    if (idx !== -1) stack.splice(idx, 1);
  };
}

export async function initBackButtonHandler() {
  if (listenerRegistered || !Capacitor.isNativePlatform()) return;
  listenerRegistered = true;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => {
    if (!triggerTop()) App.minimizeApp();
  });
}

// Desktop-web equivalent of the hardware back button: Escape closes
// whichever of the same panels is on top. Reuses this module's stack
// rather than every modal wiring its own keydown listener — same registry
// either input closes, so there's exactly one place that has to know what
// "currently open" means.
function triggerTop() {
  // ConfirmDialog/PassphrasePromptModal aren't pushed onto the stack below
  // (they're a one-off promise resolve, not a panel something else
  // reopens) but they're still the topmost thing on screen, and previously
  // only the desktop Escape path knew to check for them — the native
  // Android back button skipped straight to the stack (or minimized the
  // app) with the dialog left open and untouched underneath it.
  const cs = get(confirmState);
  if (cs) { cs.resolve('cancel'); return true; }
  const pp = get(passphrasePromptState);
  if (pp) { pp.resolve(null); return true; }

  const top = stack[stack.length - 1];
  if (top) top();
  return Boolean(top);
}

export function triggerBackOnEscape(event) {
  if (event.key !== 'Escape') return;
  triggerTop();
}
