import type { CapacitorConfig } from '@capacitor/cli';

// Android app config. There is no equivalent iOS entry here: the iOS client
// is a separate native Swift app (ios/), not a Capacitor wrapper — it never
// got the Double Ratchet ported, so it stays cloud-chats-only by design. The
// Android app wraps this same web client instead, which is what lets it keep
// full E2EE: it's the same JS running in a WebView, not a second crypto port.
const config: CapacitorConfig = {
  appId: 'space.vaultapp.messenger', // matches ios/project.yml's bundleIdPrefix + PRODUCT_BUNDLE_IDENTIFIER
  appName: 'Vault',
  webDir: 'dist',
  android: {
    // Lands the generated native project at repo-root android/, sibling to
    // ios/, client/ and server/ — not nested inside client/.
    path: '../android',
  },
  server: {
    // A *subdomain* of the real site, not the real hostname itself — this
    // was tried as literally 'vaultapp.space' first and confirmed broken on
    // a real device: Capacitor's WebViewLocalServer (see its Java source,
    // isMainUrl()) treats every request whose host matches the app's own
    // configured hostname as a local-asset request, full stop — including
    // /api/*, which then 404s against the bundled files instead of ever
    // reaching the network. There is no path-based exception; the only way
    // a request reaches the real network is if its host does NOT match this
    // one. app.vaultapp.space never needs to resolve in real DNS — nothing
    // ever actually connects to it, it exists purely as the origin label
    // Capacitor uses for locally-bundled content.
    //
    // It still has to be a subdomain of vaultapp.space rather than something
    // unrelated (Capacitor's default 'localhost', for instance): the session
    // cookie is sameSite:'strict' (server/src/routes/auth.routes.js), which
    // requires the *site* (registrable domain) to match, not the exact
    // origin — app.vaultapp.space and vaultapp.space share one site, so the
    // cookie set by a login response from the real API still attaches to
    // later requests made from this page. http.js/ws.js point their actual
    // API/WS calls at the real https://vaultapp.space (see API_BASE in
    // http.js) — a different host than this one, on purpose, so those
    // requests fall straight through to the network instead of being
    // claimed locally. The server's CORS allowlist
    // (server/src/app.js isOriginAllowed) needed one explicit addition for
    // this origin — see that file.
    hostname: 'app.vaultapp.space',
    androidScheme: 'https',
  },
  plugins: {
    CapacitorUpdater: {
      // autoUpdate is off deliberately, not merely unset: @capgo/capacitor-
      // updater's own docs say isAutoUpdateAvailable() returns false the
      // moment a custom updateUrl is configured, because a self-hosted
      // server "may not support all auto-update features" of their native
      // pipeline. Rather than depend on a guarantee the docs themselves
      // hedge on, client/src/lib/capacitor/updater.js drives the documented
      // manual-mode sequence explicitly: getLatest() -> download() ->
      // next(), plus the notifyAppReady() rollback safety net.
      autoUpdate: false,
      updateUrl: 'https://vaultapp.space/ota/check',
      appReadyTimeout: 10000,
    },
    // CapacitorHttp stays off (the default). Turning it on patches
    // window.fetch/XHR to go through native HTTP, which uses a different
    // cookie store than the WebView's CookieManager — would break the
    // sameSite:'strict' cookie flow this whole design leans on.
  },
};

export default config;
