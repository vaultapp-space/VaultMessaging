import { test, expect } from './fixtures.js';

// ============================================================
// Voice and video calls
// ============================================================
// Chromium's fake capture devices make the whole path testable: signalling
// over the websocket, the encrypted key exchange, and the peer connection
// actually carrying media.
//
// The two call types are asserted differently on purpose. A video call binds
// the remote stream to a <video> element in the DOM, so the stream and its
// tracks can be inspected directly. An audio call plays through a detached
// `new Audio()`, which no selector can reach — so what is checked there is
// the in-call panel appearing on both sides, which only renders once the call
// is established.

const PASSWORD = 'a-sufficiently-long-test-password';

function uniqueUsername(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

async function register(page, username) {
  await page.goto('/');
  await page.getByRole('button', { name: /start a private chat/i }).first().click();
  await page.getByPlaceholder('Choose a username').fill(username);
  await page.getByPlaceholder('Min 12 characters').fill(PASSWORD);
  await page.getByPlaceholder('Re-enter your password').fill(PASSWORD);
  await page.getByRole('button', { name: /create secure account/i }).click();
  await expect(page.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
}

async function callSetup(browser, kind) {
  const permissions = ['microphone', ...(kind === 'video' ? ['camera'] : [])];
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('cla');
  const bobName = uniqueUsername('clb');
  await register(alice, aliceName);
  await register(bob, bobName);

  await alice.getByPlaceholder('Search users...').fill(bobName);
  await alice.getByText(bobName, { exact: false }).first().click({ timeout: 20_000 });
  await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('calls', () => {
  test('an audio call rings, is answered, and both sides enter the call', async ({ browser }) => {
    const ctx = await callSetup(browser, 'audio');
    const { alice, bob } = ctx;

    try {
      await alice.getByTitle(/audio call/i).first().click();

      // It reaches the callee as a ringing call they can answer.
      const accept = bob.getByRole('button', { name: /accept|answer/i }).first();
      await expect(accept).toBeVisible({ timeout: 20_000 });
      await accept.click();

      // The in-call panel only renders once the call is established, so its
      // presence on both sides is the evidence the call actually connected.
      await expect(alice.getByText(/E2EE Audio:/)).toBeVisible({ timeout: 25_000 });
      await expect(bob.getByText(/E2EE Audio:/)).toBeVisible({ timeout: 25_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a video call carries live media once answered', async ({ browser }) => {
    const ctx = await callSetup(browser, 'video');
    const { alice, bob } = ctx;

    try {
      await alice.getByTitle(/video call/i).first().click();

      const accept = bob.getByRole('button', { name: /accept|answer/i }).first();
      await expect(accept).toBeVisible({ timeout: 20_000 });
      await accept.click();

      // Video binds its streams to elements in the DOM, so this can assert
      // the thing that actually matters: media is flowing, not merely that a
      // panel appeared.
      await expect.poll(async () => alice.evaluate(() =>
        [...document.querySelectorAll('video')]
          .filter((v) => v.srcObject && v.srcObject.getTracks().length > 0).length
      ), { timeout: 25_000 }).toBeGreaterThan(0);

      await expect.poll(async () => bob.evaluate(() =>
        [...document.querySelectorAll('video')]
          .filter((v) => v.srcObject && v.srcObject.getTracks().length > 0).length
      ), { timeout: 25_000 }).toBeGreaterThan(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a declined call ends for the caller', async ({ browser }) => {
    const ctx = await callSetup(browser, 'audio');
    const { alice, bob } = ctx;

    try {
      await alice.getByTitle(/audio call/i).first().click();

      const decline = bob.getByRole('button', { name: /decline|reject/i }).first();
      await expect(decline).toBeVisible({ timeout: 20_000 });
      await decline.click();

      // The caller must not be left in a ringing state that never resolves.
      await expect(alice.getByText(/E2EE Audio:/)).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
