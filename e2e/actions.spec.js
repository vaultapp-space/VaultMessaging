import { test, expect } from './fixtures.js';

// ============================================================
// Delete and pin, in both chat modes
// ============================================================
// Deletion has two meanings and they are not interchangeable. "For me" hides
// a message from one person's view; "for everyone" destroys it for the room.
// Conflating them is how a user loses something irrecoverably by tapping the
// obvious button, so the distinction is tested rather than assumed.

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
  // Secret is the default now, so the row itself starts an encrypted chat and
  // cloud is the deliberate side button.
  if (mode === 'cloud') {
    await page.getByRole('button', { name: `Start a cloud chat with ${peerUsername}` })
      .click({ timeout: 20_000 });
  } else {
    await page.getByText(peerUsername, { exact: false }).first().click({ timeout: 20_000 });
  }
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
  await expect(page.getByText(text)).toBeVisible({ timeout: 20_000 });
}

async function setup(browser, mode) {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername(`${mode[0]}da`);
  const bobName = uniqueUsername(`${mode[0]}db`);

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('deleting messages', () => {
  for (const mode of ['cloud', 'secret']) {
    test(`a ${mode} delete-for-everyone tombstones it for both sides`, async ({ browser }) => {
      const ctx = await setup(browser, mode);
      const { alice, bob, aliceName } = ctx;

      try {
        const text = `unsend me ${Date.now()}`;
        await sendMessage(alice, text);
        await openConversation(bob, aliceName);
        await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

        // Accept the "for everyone" confirmation.
        alice.once('dialog', (d) => d.accept());
        await alice.getByRole('button', { name: 'Delete this message' }).first().click();

        // A tombstone, not a hole: the transcript keeps its shape.
        await expect(alice.getByText('This message was deleted').first())
          .toBeVisible({ timeout: 20_000 });
        await expect(alice.getByText(text)).toHaveCount(0);

        await expect(bob.getByText('This message was deleted').first())
          .toBeVisible({ timeout: 30_000 });
        await expect(bob.getByText(text)).toHaveCount(0);
      } finally {
        await ctx.aliceCtx.close();
        await ctx.bobCtx.close();
      }
    });
  }

  test('delete-for-me leaves the other person’s copy alone', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      const text = `only bob keeps this ${Date.now()}`;
      await sendMessage(alice, text);
      await openConversation(bob, aliceName);
      await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

      // Alice declines "for everyone", which falls back to hiding it for her.
      alice.once('dialog', (d) => d.dismiss());
      await alice.getByRole('button', { name: 'Delete this message' }).first().click();

      await expect(alice.getByText(text)).toHaveCount(0, { timeout: 20_000 });

      // Bob still has it, and it is not a tombstone.
      await expect(bob.getByText(text)).toBeVisible();
      await expect(bob.getByText('This message was deleted')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a recipient is only offered delete-for-me', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      const text = `alice wrote this ${Date.now()}`;
      await sendMessage(alice, text);
      await openConversation(bob, aliceName);
      await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

      let promptText = '';
      bob.once('dialog', (d) => { promptText = d.message(); d.accept(); });
      await bob.getByRole('button', { name: 'Delete this message' }).first().click();

      expect(promptText).toMatch(/only from your view|from your view/i);
      await expect(bob.getByText(text)).toHaveCount(0, { timeout: 20_000 });

      // Alice's copy is untouched.
      await expect(alice.getByText(text)).toBeVisible();
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('pinning messages', () => {
  test('a pin is visible to both participants', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      const text = `pin me ${Date.now()}`;
      await sendMessage(alice, text);
      await openConversation(bob, aliceName);
      await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

      await alice.getByRole('button', { name: 'Pin this message' }).first().click();

      await expect(alice.getByTitle('Pinned message').first()).toBeVisible({ timeout: 20_000 });
      await expect(bob.getByTitle('Pinned message').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a pin can be removed', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice } = ctx;

    try {
      await sendMessage(alice, `temporary pin ${Date.now()}`);
      await alice.getByRole('button', { name: 'Pin this message' }).first().click();
      await expect(alice.getByTitle('Pinned message').first()).toBeVisible({ timeout: 20_000 });

      await alice.getByRole('button', { name: 'Unpin this message' }).first().click();
      await expect(alice.getByTitle('Pinned message')).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('either participant can pin — it is a shared surface', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      const text = `bob pins this ${Date.now()}`;
      await sendMessage(alice, text);
      await openConversation(bob, aliceName);
      await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

      await bob.getByRole('button', { name: 'Pin this message' }).first().click();
      await expect(alice.getByTitle('Pinned message').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
