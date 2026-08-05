import { test, expect } from './fixtures.js';

// ============================================================
// Devices and multi-device sync
// ============================================================
// The property worth proving end to end is revocation: signing a device out
// has to take effect immediately, not whenever its 24h token happens to
// expire. A lost phone that keeps working for a day is the failure this
// feature exists to prevent.

const PASSWORD = 'a-sufficiently-long-test-password';

function uniqueUsername(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

async function register(page, username) {
  await page.goto('/');
  await page.getByRole('button', { name: /start a private chat/i }).first().click();
  await page.getByPlaceholder('Choose a username').fill(username);
  await page.getByPlaceholder('Min 12 characters').fill(PASSWORD);
  await page.getByPlaceholder('Re-enter your password').fill(PASSWORD);
  await page.getByRole('button', { name: /create secure account/i }).click();
  await expect(page.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
}

// A second browser context signing in to the same account — which is what a
// second device actually is.
async function signInAs(page, username) {
  await page.goto('/');
  await page.getByRole('button', { name: /start a private chat/i }).first().click();
  // A fresh context has never registered, so the form opens on sign-up.
  await page.getByText(/already have an account\? sign in/i).click();
  await page.getByPlaceholder('Choose a username').fill(username);
  await page.getByPlaceholder('Enter password').fill(PASSWORD);
  await page.getByRole('button', { name: /unlock vault/i }).click();
  await expect(page.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
}

async function openSettings(page) {
  await page.getByTitle('Settings').click();
  await expect(page.getByText('Active Sessions')).toBeVisible({ timeout: 15_000 });
}

test.describe('active sessions', () => {
  test('the current device is listed and cannot be signed out from itself', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('dva'));
      await openSettings(page);

      await expect(page.getByText('this device')).toBeVisible({ timeout: 15_000 });
      // Offering "sign out" next to the session you are using is how someone
      // locks themselves out by accident; it is labelled, not actionable.
      await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('a second sign-in appears as a second session', async ({ browser }) => {
    const firstCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const secondCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await firstCtx.newPage();
    const second = await secondCtx.newPage();

    try {
      const name = uniqueUsername('dvb');
      await register(first, name);
      await signInAs(second, name);

      await openSettings(first);
      // One current session plus one that can be signed out.
      await expect(first.getByRole('button', { name: 'Sign out' })).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await firstCtx.close();
      await secondCtx.close();
    }
  });

  test('signing a device out cuts its access off at once', async ({ browser }) => {
    const firstCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const secondCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await firstCtx.newPage();
    const second = await secondCtx.newPage();

    try {
      const name = uniqueUsername('dvc');
      await register(first, name);
      await signInAs(second, name);

      // The second device works to begin with.
      const before = await second.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return res.status;
      });
      expect(before).toBe(200);

      await openSettings(first);
      first.once('dialog', (d) => d.accept());
      await first.getByRole('button', { name: 'Sign out' }).first().click();
      await expect(first.getByRole('button', { name: 'Sign out' })).toHaveCount(0, { timeout: 15_000 });

      // And now it does not — this is the assertion the feature rests on.
      await expect.poll(
        () => second.evaluate(async () => {
          const res = await fetch('/api/auth/me', { credentials: 'include' });
          return res.status;
        }),
        { timeout: 20_000 }
      ).toBe(401);

      // The device that did the revoking is unaffected.
      const stillFine = await first.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return res.status;
      });
      expect(stillFine).toBe(200);
    } finally {
      await firstCtx.close();
      await secondCtx.close();
    }
  });
});

test.describe('multi-device sync', () => {
  test('a cloud message reaches a second device of the same account', async ({ browser }) => {
    // The reason cloud mode exists. The server holds the plaintext, so a
    // second device can be told about a message it was not present for.
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const aliceTwoCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });

    const alice = await aliceCtx.newPage();
    const aliceTwo = await aliceTwoCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      const aliceName = uniqueUsername('mda');
      const bobName = uniqueUsername('mdb');

      await register(alice, aliceName);
      await register(bob, bobName);
      await signInAs(aliceTwo, aliceName);

      // Bob writes to Alice.
      await bob.getByPlaceholder('Search users...').fill(aliceName);
      await bob.getByText(aliceName, { exact: false }).first().click({ timeout: 20_000 });
      await expect(bob.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });

      const text = `synced ${Date.now()}`;
      const composer = bob.getByPlaceholder('Type a message...');
      await composer.fill(text);
      await composer.press('Enter');

      // Alice's second device sees it without ever having opened the chat
      // on her first.
      await aliceTwo.getByText(bobName, { exact: false }).first().click({ timeout: 30_000 });
      await expect(aliceTwo.getByText(text)).toBeVisible({ timeout: 30_000 });
    } finally {
      await aliceCtx.close();
      await aliceTwoCtx.close();
      await bobCtx.close();
    }
  });

  test('the update log carries what a device missed', async ({ browser }) => {
    // Directly exercises the catch-up path: a device asks what happened past
    // the point it last saw, rather than relying on a delivered flag that
    // cannot have one answer across devices.
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      const aliceName = uniqueUsername('uma');
      const bobName = uniqueUsername('umb');
      await register(alice, aliceName);
      await register(bob, bobName);

      // Explicitly a *cloud* chat. The update log is plaintext, so secret
      // chats — now the one-to-one default — are deliberately never written
      // to it, and a secret chat here would correctly catch up on nothing.
      await alice.getByPlaceholder('Search users...').fill(bobName);
      await alice.getByRole('button', { name: `Start a cloud chat with ${bobName}` })
        .click({ timeout: 20_000 });
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });

      const start = await bob.evaluate(async () => {
        const res = await fetch('/api/updates?pts=0', { credentials: 'include' });
        return (await res.json()).pts;
      });

      const text = `missed this ${Date.now()}`;
      const composer = alice.getByPlaceholder('Type a message...');
      await composer.fill(text);
      await composer.press('Enter');
      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });

      const caught = await bob.evaluate(async (from) => {
        const res = await fetch(`/api/updates?pts=${from}`, { credentials: 'include' });
        return res.json();
      }, start);

      expect(caught.tooLong).toBe(false);
      expect(caught.updates.map((u) => u.body)).toContain(text);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
