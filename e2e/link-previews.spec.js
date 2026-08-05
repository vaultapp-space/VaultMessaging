import { test, expect } from '@playwright/test';

// ============================================================
// Link previews
// ============================================================
// The interesting cases are the ones where a preview must NOT appear:
//
//   - secret chats, because unfurling would mean the server reading content it
//     cannot see, and would tell the linked site that this URL was shared in
//     an encrypted conversation — a traffic-analysis leak
//   - anything private or non-HTTP, which the SSRF guard rejects before a
//     single packet leaves the machine
//
// The SSRF behaviour itself is covered exhaustively in
// server/test/safe-fetch.test.js; this spec checks the wiring.

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

async function startChat(page, peerUsername, mode) {
  await page.getByPlaceholder('Search users...').fill(peerUsername);
  if (mode === 'secret') {
    await page.getByRole('button', { name: `Start a secret chat with ${peerUsername}` })
      .click({ timeout: 20_000 });
  } else {
    await page.getByText(peerUsername, { exact: false }).first().click({ timeout: 20_000 });
  }
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
}

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
}

async function setup(browser, mode = 'cloud') {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('lpa');
  const bobName = uniqueUsername('lpb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('link previews', () => {
  test('a private address is never unfurled', async ({ browser }) => {
    // The SSRF case, end to end. The server must not fetch this, so no
    // preview can appear — and crucially the message itself still sends.
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const text = `check http://169.254.169.254/latest/meta-data/ now ${Date.now()}`;
      await sendMessage(alice, text);

      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });
      await alice.waitForTimeout(3000);

      // No preview card rendered for a blocked address.
      await expect(alice.locator('a[rel*="nofollow"]')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('loopback is never unfurled', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const text = `see http://127.0.0.1:3001/health ${Date.now()}`;
      await sendMessage(alice, text);

      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });
      await alice.waitForTimeout(3000);
      await expect(alice.locator('a[rel*="nofollow"]')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a message with a link still sends promptly', async ({ browser }) => {
    // Unfurling happens after the reply, so a slow or unreachable site must
    // not delay the message. This would fail if the fetch were awaited inline.
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const started = Date.now();
      const text = `slow link http://10.255.255.1/ ${started}`;
      await sendMessage(alice, text);

      await expect(alice.getByText(text)).toBeVisible({ timeout: 10_000 });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a secret chat is never unfurled', async ({ browser }) => {
    // Even a perfectly fetchable URL must not be unfurled here: doing so
    // would tell the linked site that this link was shared in an end-to-end
    // encrypted conversation.
    const ctx = await setup(browser, 'secret');
    const { alice } = ctx;

    try {
      const text = `secret link https://example.com/ ${Date.now()}`;
      await sendMessage(alice, text);

      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });
      await alice.waitForTimeout(3000);
      await expect(alice.locator('a[rel*="nofollow"]')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a message without a link is unaffected', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const text = `no links here ${Date.now()}`;
      await sendMessage(alice, text);
      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });
      await expect(alice.locator('a[rel*="nofollow"]')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
