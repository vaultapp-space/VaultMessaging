// ============================================================
// Prerender entry — server build only
// ============================================================
// Renders Landing.svelte to a static HTML string at build time, so the page a
// crawler receives contains the actual marketing copy rather than an empty
// <div id="app">.
//
// This entry exists because it is the *only* component that gets rendered.
// Rendering App.svelte instead would pull in the chat tree, the WebSocket
// client and the crypto stack — none of which run under Node, and none of
// which a crawler needs. Landing is a leaf as far as the server is concerned:
// it reads a store and imports a theme helper, and does neither at module
// scope.
//
// Consumed by scripts/prerender.mjs. Not part of the browser bundle.
import { render } from 'svelte/server';
import Landing from './components/Landing.svelte';

export function renderLanding() {
  return render(Landing);
}
