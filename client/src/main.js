import './app.css'
import App from './App.svelte'
import { mount } from 'svelte'
import { Capacitor } from '@capacitor/core'
import { isLoading } from './lib/stores/session.js'


const app = mount(App, {
  target: document.getElementById('app'),
})

// ---- Prerendered landing shell ----
// scripts/prerender.mjs injects a static copy of the landing page ahead of
// #app, so crawlers that do not run JavaScript get the real content. It is
// styled but inert — no event handlers — so it has to come down as soon as the
// mounted app has something to show.
//
// The trigger is isLoading rather than "immediately after mount", because App
// renders a connection spinner for the length of the session check. Removing
// the shell on mount would produce landing → spinner → landing, replacing a
// blank first paint with a flicker. Waiting means a logged-out visitor never
// sees the spinner at all: the static page is on screen, and it is swapped for
// the identical interactive one. A signed-in visitor sees the landing page for
// the length of that check instead of a spinner, then their chats.
//
// The failsafe matters more than it looks. isLoading never flipping is a real
// state — offline, a hung /auth/me — and without the timeout the visitor is
// left holding a page whose buttons do nothing, with no indication why.
// Dropping the shell reveals the app's own spinner, which is at least honest
// about waiting.
const shell = document.getElementById('prerender')
if (shell && Capacitor.isNativePlatform()) {
  // Belt and braces. `npm run build:native` skips the prerender step, so this
  // element should not exist inside the APK at all — but the two builds differ
  // only by which npm script was run, and getting that wrong is silent. On
  // Android App.svelte renders NativeWelcome, never Landing, so leaving the
  // shell up would flash the web marketing page at someone who just opened
  // the app.
  shell.remove()
} else if (shell) {
  let dropped = false
  let unsubscribe = null
  let failsafe = null

  const drop = () => {
    if (dropped) return
    dropped = true
    shell.remove()
    clearTimeout(failsafe)
    // Null only if drop() ran synchronously from subscribe() below, which the
    // trailing call there handles.
    if (unsubscribe) unsubscribe()
  }

  failsafe = setTimeout(drop, 4000)

  // subscribe() fires synchronously with the current value. isLoading starts
  // true, so drop() normally runs from a later tick — the line after covers
  // the case where it does not, which would otherwise leave a live
  // subscription with nothing holding its cancel function.
  unsubscribe = isLoading.subscribe((loading) => {
    if (!loading) drop()
  })
  if (dropped) unsubscribe()
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registered successfully:', reg.scope))
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}

// Suppress the browser's automatic "Add to Home Screen" / install mini-infobar.
// There's no in-app install button today, so there's nothing constructive for
// the deferred prompt to do — this just stops it popping up unprompted.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
});

export default app
