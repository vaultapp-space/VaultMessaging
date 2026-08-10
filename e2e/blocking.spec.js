import { test, expect, clickConfirm } from './fixtures.js';

// ============================================================
// Blocking
// ============================================================
// The property that matters is enforcement, not the button. A block that is
// recorded but not enforced is worse than no blocking at all, because the
// user believes they are protected and stops watching.
//
// Also tested: the person who was blocked is not told. Telling them hands
// over information the blocker did not choose to share.

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

async function startChat(page, peerUsername) {
  await page.getByPlaceholder('Search users...').fill(peerUsername);
  await page.getByText(peerUsername, { exact: false }).first().click({ timeout: 20_000 });
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
}

async function openConversation(page, name) {
  await page.getByText(name, { exact: false }).first().click({ timeout: 20_000 });
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
}

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
}

async function setup(browser) {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('bka');
  const bobName = uniqueUsername('bkb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

async function block(page) {
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: /^Block / }).click();
  await clickConfirm(page, 'Block');
}

test.describe('blocking', () => {
  test('blocking shows a banner and locks the composer', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      await sendMessage(alice, `before blocking ${Date.now()}`);
      await block(alice);

      await expect(alice.getByText(`You blocked ${bobName}`)).toBeVisible({ timeout: 20_000 });
      // A send that cannot succeed should not look available.
      await expect(alice.getByPlaceholder('You blocked this user')).toBeDisabled();
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a blocked user’s message does not arrive', async ({ browser }) => {
    // The enforcement check. Blocking that only hides a button is theatre.
    const ctx = await setup(browser);
    const { alice, bob, aliceName } = ctx;

    try {
      const before = `delivered ${Date.now()}`;
      await sendMessage(alice, before);

      await openConversation(bob, aliceName);
      await expect(bob.getByText(before)).toBeVisible({ timeout: 30_000 });

      await block(alice);
      await expect(alice.getByText(/You blocked/)).toBeVisible({ timeout: 20_000 });

      const after = `should never arrive ${Date.now()}`;
      await sendMessage(bob, after);

      // Bob's client may show its own optimistic copy; what matters is that
      // Alice never receives it.
      await alice.waitForTimeout(3000);
      await expect(alice.getByText(after)).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('the blocked user is not told they were blocked', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, aliceName } = ctx;

    try {
      await sendMessage(alice, `hello ${Date.now()}`);
      await openConversation(bob, aliceName);
      await block(alice);

      await bob.waitForTimeout(1500);

      await expect(bob.getByText(/You blocked/)).toHaveCount(0);
      await expect(bob.getByText(/blocked you/i)).toHaveCount(0);
      // Bob's composer stays enabled — he learns nothing from the UI.
      await expect(bob.getByPlaceholder('Type a message...')).toBeEnabled();
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('unblocking restores the conversation', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, aliceName, bobName } = ctx;

    try {
      await sendMessage(alice, `initial ${Date.now()}`);
      await openConversation(bob, aliceName);

      await block(alice);
      await expect(alice.getByText(`You blocked ${bobName}`)).toBeVisible({ timeout: 20_000 });

      await alice.getByRole('button', { name: 'More options' }).click();
      await alice.getByRole('button', { name: /^Unblock / }).click();

      await expect(alice.getByText(`You blocked ${bobName}`)).toHaveCount(0, { timeout: 20_000 });
      await expect(alice.getByPlaceholder('Type a message...')).toBeEnabled();

      // And delivery resumes.
      const after = `after unblock ${Date.now()}`;
      await sendMessage(bob, after);
      await expect(alice.getByText(after)).toBeVisible({ timeout: 30_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('the block is persisted server-side, not just in memory', async ({ browser }) => {
    // The UI reads its blocked set from /api/blocks at startup. What matters
    // for persistence is that the block is actually recorded against the
    // account rather than living only in the tab that created it — otherwise
    // a refresh silently un-blocks in the UI while the server keeps enforcing
    // it, which is the worst of both.
    //
    // Asserted through the page's own session rather than by driving the UI
    // after a reload, because post-reload navigation is a separate concern.
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      await sendMessage(alice, `persist ${Date.now()}`);
      await block(alice);
      await expect(alice.getByText(`You blocked ${bobName}`)).toBeVisible({ timeout: 20_000 });

      await alice.reload();

      const blocked = await alice.evaluate(async () => {
        const res = await fetch('/api/blocks', { credentials: 'include' });
        return (await res.json()).blocked;
      });

      expect(blocked.map((u) => u.username)).toContain(bobName);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
