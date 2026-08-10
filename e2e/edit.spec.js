import { test, expect, messageBubble } from './fixtures.js';

// ============================================================
// Message editing, in both chat modes
// ============================================================
// Cloud edits are a PATCH the server applies and broadcasts. Secret edits are
// an `t:'op'` envelope through the ratchet, applied locally by each recipient.
//
// The secret case carries a risk the cloud case does not: there is no server
// to arbitrate who may edit what, so the client must refuse an edit op that
// did not come from the message's author. Otherwise any group member could
// silently rewrite someone else's words — and the recipient would see the
// forged text with an innocuous "edited" marker.

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
  await expect(messageBubble(page, text)).toBeVisible({ timeout: 20_000 });
}

async function editFirst(page, newText) {
  await page.getByRole('button', { name: 'Edit this message' }).first().click({ timeout: 20_000 });
  await expect(page.getByText('Editing message')).toBeVisible({ timeout: 10_000 });
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(newText);
  await composer.press('Enter');
}

async function setup(browser, mode) {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername(`${mode[0]}ea`);
  const bobName = uniqueUsername(`${mode[0]}eb`);

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('message editing', () => {
  for (const mode of ['cloud', 'secret']) {
    test(`a ${mode} edit reaches the other participant`, async ({ browser }) => {
      const ctx = await setup(browser, mode);
      const { alice, bob, aliceName } = ctx;

      try {
        const original = `typo heer ${Date.now()}`;
        const corrected = `typo here ${Date.now()}`;

        await sendMessage(alice, original);
        await openConversation(bob, aliceName);
        await expect(messageBubble(bob, original)).toBeVisible({ timeout: 30_000 });

        await editFirst(alice, corrected);

        // The author sees the correction and an "edited" marker.
        await expect(messageBubble(alice, corrected)).toBeVisible({ timeout: 20_000 });
        await expect(messageBubble(alice, original)).toHaveCount(0);
        await expect(alice.getByTitle('This message was edited').first())
          .toBeVisible({ timeout: 20_000 });

        // And so does the recipient.
        await expect(messageBubble(bob, corrected)).toBeVisible({ timeout: 30_000 });
        await expect(messageBubble(bob, original)).toHaveCount(0);
      } finally {
        await ctx.aliceCtx.close();
        await ctx.bobCtx.close();
      }
    });
  }

  test('only the author is offered an edit control', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      await sendMessage(alice, `alice wrote this ${Date.now()}`);
      await openConversation(bob, aliceName);

      // Alice can edit her own message; Bob is offered nothing for it.
      await expect(alice.getByRole('button', { name: 'Edit this message' }).first())
        .toBeVisible({ timeout: 20_000 });
      await expect(bob.getByRole('button', { name: 'Edit this message' })).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('an edit can be cancelled without changing anything', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice } = ctx;

    try {
      const original = `unchanged ${Date.now()}`;
      await sendMessage(alice, original);

      await alice.getByRole('button', { name: 'Edit this message' }).first().click();
      await expect(alice.getByText('Editing message')).toBeVisible();

      await alice.getByRole('button', { name: 'Cancel edit' }).click();
      await expect(alice.getByText('Editing message')).toHaveCount(0);

      await expect(messageBubble(alice, original)).toBeVisible();
      await expect(alice.getByTitle('This message was edited')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('an unedited message carries no edited marker', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice } = ctx;

    try {
      await sendMessage(alice, `pristine ${Date.now()}`);
      await expect(alice.getByTitle('This message was edited')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
