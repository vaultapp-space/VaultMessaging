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

export const test = base.extend({
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
