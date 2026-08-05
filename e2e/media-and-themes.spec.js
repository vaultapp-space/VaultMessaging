import { test, expect } from '@playwright/test';

// ============================================================
// View-once media, albums, chat themes
// ============================================================
// The Phase 3 tail. The interesting assertion is the view-once one: the
// content has to be gone from the *server*, not merely hidden by the client,
// or the whole feature is defeated by opening a network tab.

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

async function startChat(page, peerUsername, mode = 'cloud') {
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

async function setup(browser, mode = 'cloud') {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('vqa');
  const bobName = uniqueUsername('vqb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('view-once messages', () => {
  test('opening one destroys it, on the server as well as on screen', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, aliceName } = ctx;

    try {
      const secret = `only once ${Date.now()}`;

      await alice.getByLabel('Attach').click();
      await alice.getByRole('button', { name: /View once/ }).click();
      await sendMessage(alice, secret);
      await expect(alice.getByText(secret)).toBeVisible({ timeout: 20_000 });

      await bob.getByText(aliceName, { exact: false }).first().click({ timeout: 20_000 });

      // Bob sees a placeholder, not the message.
      const openButton = bob.getByRole('button', { name: /Tap to view once/ });
      await expect(openButton).toBeVisible({ timeout: 20_000 });
      await expect(bob.getByText(secret)).toHaveCount(0);

      await openButton.click();
      await expect(bob.getByText(secret)).toBeVisible({ timeout: 15_000 });

      // The server no longer holds the content — this is the assertion the
      // feature actually rests on.
      const stored = await bob.evaluate(async () => {
        const chats = (await (await fetch('/api/chats', { credentials: 'include' })).json()).chats;
        const res = await fetch(`/api/chats/${chats[0].id}/messages`, { credentials: 'include' });
        return (await res.json()).messages.map((m) => m.body);
      });
      expect(stored).not.toContain(secret);

      // And Alice's own copy is retired rather than left showing plaintext
      // the server has already dropped.
      await expect(alice.getByText(/could only be viewed once/)).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('the toggle resets after sending, so it cannot leak into the next message', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, aliceName } = ctx;

    try {
      await alice.getByLabel('Attach').click();
      await alice.getByRole('button', { name: /View once/ }).click();
      await sendMessage(alice, `first ${Date.now()}`);

      const ordinary = `ordinary ${Date.now()}`;
      await sendMessage(alice, ordinary);

      await bob.getByText(aliceName, { exact: false }).first().click({ timeout: 20_000 });
      await expect(bob.getByText(ordinary)).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a secret chat is not offered view-once', async ({ browser }) => {
    // The server holds only ciphertext there, so it has nothing to clear —
    // offering the toggle would promise an enforcement that does not exist.
    const ctx = await setup(browser, 'secret');
    const { alice } = ctx;

    try {
      // The whole menu entry is absent in a secret chat, not merely disabled.
      await alice.getByLabel('Attach').click();
      await expect(alice.getByRole('button', { name: /View once/ })).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('chat themes', () => {
  test('a theme applies to the conversation and not to the other participant', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, aliceName } = ctx;

    try {
      await alice.getByLabel('More options').click();
      await alice.getByRole('button', { name: 'Ocean' }).click();

      // Applied to the chat pane, scoped there rather than to the document.
      await expect(alice.locator('[data-chat-theme="ocean"]')).toBeVisible({ timeout: 15_000 });

      // It survives a reload, so the client reads it back from the server
      // rather than holding it in local state. The app always opens on the
      // landing page, so getting back to a themed pane means going through
      // the CTA and reopening the conversation.
      await alice.reload();
      await alice.getByRole('button', { name: /start a private chat/i }).first().click();
      // The identity keys live in memory only, so a reload always comes back
      // to the unlock screen — there is no way to reach a themed pane without
      // going through it.
      await alice.getByPlaceholder('Enter password').fill(PASSWORD);
      await alice.getByRole('button', { name: /unlock vault/i }).click();
      await expect(alice.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
      await startChat(alice, ctx.bobName);
      await expect(alice.locator('[data-chat-theme="ocean"]')).toBeVisible({ timeout: 30_000 });

      // Bob's view of the same conversation is untouched — picking a theme
      // must not restyle someone else's client.
      await startChat(bob, aliceName);
      await expect(bob.locator('[data-chat-theme="ocean"]')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a theme can be set back to the default', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      await alice.getByLabel('More options').click();
      await alice.getByRole('button', { name: 'Ocean' }).click();
      await expect(alice.locator('[data-chat-theme="ocean"]')).toBeVisible({ timeout: 15_000 });

      await alice.getByLabel('More options').click();
      await alice.getByRole('button', { name: 'Default' }).click();
      await expect(alice.locator('[data-chat-theme="ocean"]')).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
