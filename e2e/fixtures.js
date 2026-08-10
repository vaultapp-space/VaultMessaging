// ============================================================
// Vault — E2E fixtures
// ============================================================
// Specs import `test` and `expect` from here rather than from
// `@playwright/test`, for one reason: **browser contexts must not survive a
// failed test.**
//
// The suite creates contexts by hand (`browser.newContext()`) because most
// tests need two or three users talking to each other, which the built-in
// `page` fixture cannot express. Those contexts were closed in `finally`
// blocks — but not all of them. Several specs create an extra context partway
// through a test and close it on the next line after an assertion:
//
//     const thirdCtx = await browser.newContext();
//     …
//     expect(joined).toBe(0);   // throws here
//     await thirdCtx.close();   // never runs
//
// A leaked context is a live Chromium process holding an open WebSocket to
// the test server. One is survivable; the problem is that it is
// self-reinforcing — a failure leaks a browser, the leak slows every
// subsequent test, and slower tests fail more. That is exactly the observed
// behaviour: runs with a failure took 9.8 minutes against a 5.5-minute
// baseline, failures clustered late, and every failing test passed in
// isolation.
//
// Rather than move a dozen `close()` calls into `finally` blocks and rely on
// nobody ever forgetting again, this closes whatever is still open after each
// test. Specs keep their explicit cleanup — this is the backstop for the
// paths that do not reach it.

import { test as base, expect } from '@playwright/test';

// Runs in every page before any app code does.
//
// BiometricPrompt.svelte pops a full-screen "Enable Biometric Unlock?" modal
// the first time an account reaches the chat view, gated on isPrfSupported()
// (client/src/lib/crypto/webauthn.js), which is a bare feature check for
// window.PublicKeyCredential. Headless Chromium defines that object, so the
// check passes and the prompt appears — but there is no platform
// authenticator behind it, so the feature it is offering cannot actually work
// here. The modal is z-[80] and fixed inset-0, so it swallows every click
// after login: 29 tests across the suite failed on "<div …> intercepts
// pointer events", all of them the same modal rather than 29 separate bugs.
//
// Removing the interface is the honest fix rather than clicking the prompt
// away in each spec: it makes the test browser report what it actually is, a
// browser with no usable platform authenticator, and the app's existing
// capability check does the rest. No coverage is lost — nothing in this suite
// exercises WebAuthn, and it could not without a virtual authenticator.
function disablePlatformAuthenticator() {
  try {
    delete window.PublicKeyCredential;
  } catch {
    // Non-configurable in some builds; the fallback below handles it.
  }
  if (window.PublicKeyCredential) {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: undefined,
      configurable: true,
    });
  }
}

export const test = base.extend({
  // Specs build their own contexts (`browser.newContext()`) because most need
  // two or three users at once, so neither `test.use({...})` nor the built-in
  // `context` fixture can reach them — there is no single context to
  // configure. Wrapping the factory is the one place that catches all of
  // them, however many a spec creates and whenever it creates them.
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await context.addInitScript(disablePlatformAuthenticator);
      return context;
    };

    await use(browser);

    // The browser is worker-scoped and outlives this fixture, so the patch is
    // removed rather than left on a shared object.
    browser.newContext = newContext;
  }, { scope: 'worker' }],

  // Auto-use: applies to every test in every spec that imports this `test`,
  // without the spec having to opt in or even know it exists.
  closeStrayContexts: [async ({ browser }, use) => {
    await use();

    // Anything still open after the test body — including its `finally` —
    // was leaked. Closing is best-effort: a context whose browser already
    // went away throws, and that is not worth failing an otherwise good test
    // over.
    await Promise.all(
      browser.contexts().map((context) => context.close().catch(() => {}))
    );
  }, { auto: true }],
});

export { expect };

// ─── In-app confirmation dialog ──────────────────────────────
// ebc6d13 replaced every window.confirm()/alert() with the in-app
// ConfirmDialog component, but the specs were not updated with it: they still
// registered `page.once('dialog', d => d.accept())`, which now waits for a
// native dialog that is never emitted. The handler simply never fires, the
// modal stays open, and the assertion after it times out — which is why the
// whole suite is stale rather than nine independent tests being wrong.
//
// The dialog resolves to one of three outcomes ('confirm' | 'neutral' |
// 'cancel'), and which button carries which label is per-call-site, so these
// take the visible label rather than trying to guess. Scoped to
// role="alertdialog" so a label like "Delete" cannot match some other button
// that happens to be on the page behind the modal.

/** The open confirmation modal, if any. */
export function confirmDialog(page) {
  return page.getByRole('alertdialog');
}

/**
 * Click a button in the confirmation modal, waiting for it to appear first.
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp} label - visible button text, e.g. 'Delete for Everyone'
 */
export async function clickConfirm(page, label) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: label, exact: true }).click();
  // The caller's next assertion usually races the close transition otherwise.
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
