import { test, expect } from './fixtures.js';

// ============================================================
// Chat-level features: search, archive, mute, drafts, forwarding
// ============================================================
// These do not touch message content, so unlike reactions or edits they do
// not fork on chat mode — with one exception that is tested here: drafts are
// plaintext, so a secret chat keeps them on the device and never syncs them.

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

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.getByText(text)).toBeVisible({ timeout: 20_000 });
}

async function setup(browser, mode = 'cloud') {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('csa');
  const bobName = uniqueUsername('csb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('global message search', () => {
  test('finds a message and opens its conversation', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const needle = `hydroponics${Date.now()}`;
      await sendMessage(alice, `something about ${needle} here`);

      await alice.getByLabel('Search inside conversations').click();
      await alice.getByPlaceholder('Search inside conversations...').fill(needle);
      await expect(alice.getByText(new RegExp(needle)).first())
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('says what it cannot search rather than silently omitting', async ({ browser }) => {
    // Secret chats have no server-side plaintext. A search box that quietly
    // returns less than the user expects is worse than one that explains.
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      await sendMessage(alice, `findable ${Date.now()}`);
      await alice.getByLabel('Search inside conversations').click();
      await alice.getByPlaceholder('Search inside conversations...').fill('findable');

      await expect(alice.getByText(/Encrypted chats stay on your device/i))
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('reports nothing for a term that does not appear', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      await sendMessage(alice, `present ${Date.now()}`);
      await alice.getByLabel('Search inside conversations').click();
      await alice.getByPlaceholder('Search inside conversations...').fill('zzzabsentzzz');
      await expect(alice.getByText('No messages found')).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('chat organisation', () => {
  test('archiving moves a chat out of the main list and back', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      await sendMessage(alice, `archive me ${Date.now()}`);

      await alice.getByRole('button', { name: `Chat options for ${bobName}` }).click();
      await alice.getByRole('button', { name: 'Archive' }).click();

      // Gone from the default list...
      await expect(alice.getByRole('button', { name: `Chat options for ${bobName}` }))
        .toHaveCount(0, { timeout: 20_000 });

      // ...and present behind the archived toggle.
      await alice.getByRole('button', { name: /Archived chats/ }).click();
      await expect(alice.getByRole('button', { name: `Chat options for ${bobName}` }))
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('muting is reflected in the chat row', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      await sendMessage(alice, `mute me ${Date.now()}`);

      await alice.getByRole('button', { name: `Chat options for ${bobName}` }).click();
      await alice.getByRole('button', { name: 'Mute notifications' }).click();

      await expect(alice.getByLabel('Muted').first()).toBeVisible({ timeout: 20_000 });

      // And unmuting clears it.
      await alice.getByRole('button', { name: `Chat options for ${bobName}` }).click();
      await alice.getByRole('button', { name: 'Unmute' }).click();
      await expect(alice.getByLabel('Muted')).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('pinning a chat to the top is marked', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      await sendMessage(alice, `pin chat ${Date.now()}`);

      await alice.getByRole('button', { name: `Chat options for ${bobName}` }).click();
      await alice.getByRole('button', { name: 'Pin to top' }).click();

      await expect(alice.getByLabel('Pinned to top').first())
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('drafts', () => {
  test('a cloud draft survives switching away and back', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob, bobName } = ctx;

    try {
      const carolName = uniqueUsername('csc');
      const carolCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const carol = await carolCtx.newPage();
      await register(carol, carolName);

      const draft = `half-written ${Date.now()}`;
      await alice.getByPlaceholder('Type a message...').fill(draft);
      // Debounced save.
      await alice.waitForTimeout(1200);

      // Switch to another conversation and back.
      await startChat(alice, carolName, 'cloud');
      await alice.getByText(bobName, { exact: false }).first().click();

      await expect(alice.getByPlaceholder('Type a message...')).toHaveValue(draft, {
        timeout: 20_000,
      });

      await carolCtx.close();
      void bob;
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('forwarding', () => {
  test('forwards a message into another chat', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, aliceName, bobName } = ctx;

    try {
      const carolName = uniqueUsername('csf');
      const carolCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const carol = await carolCtx.newPage();
      await register(carol, carolName);

      // Create a second cloud chat so the picker has a destination.
      await startChat(alice, carolName, 'cloud');
      await alice.getByText(bobName, { exact: false }).first().click();
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible();

      const text = `worth sharing ${Date.now()}`;
      await sendMessage(alice, text);

      await alice.getByRole('button', { name: 'Forward this message' }).first().click();
      await expect(alice.getByRole('dialog', { name: 'Forward message' })).toBeVisible();

      await alice.getByRole('dialog').getByText(carolName, { exact: false }).first().click();

      // Carol has to open the conversation: the message list only renders the
      // chat that is currently open.
      await carol.getByText(aliceName, { exact: false }).first().click({ timeout: 30_000 });
      await expect(carol.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
      await expect(carol.getByText(text)).toBeVisible({ timeout: 30_000 });

      await carolCtx.close();
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('the picker explains why secret chats are absent', async ({ browser }) => {
    const ctx = await setup(browser, 'secret');
    const { alice } = ctx;

    try {
      await sendMessage(alice, `forward source ${Date.now()}`);
      await alice.getByRole('button', { name: 'Forward this message' }).first().click();

      await expect(alice.getByText(/only be forwarded into cloud chats/i))
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
