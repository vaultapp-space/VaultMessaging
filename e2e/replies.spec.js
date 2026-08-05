import { test, expect } from '@playwright/test';

// ============================================================
// Replies, in both chat modes
// ============================================================
// Cloud replies ride a column (`reply_to_seq`). Secret replies ride the
// envelope's `replyTo` through the ratchet — and that is the case worth
// testing, because a plain text message is still sent bare for backwards
// compatibility. Only a message *carrying structure* is serialised as an
// envelope, so if that rule regresses the reply arrives as ordinary text with
// no idea what it answered, and nobody sees an error.

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

async function replyTo(page, text) {
  await page.getByRole('button', { name: 'Reply to this message' }).first().click({ timeout: 20_000 });
  await expect(page.getByText(/^Replying to/)).toBeVisible({ timeout: 10_000 });
  await sendMessage(page, text);
}

async function setup(browser, mode) {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername(`${mode[0]}ra`);
  const bobName = uniqueUsername(`${mode[0]}rb`);

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('replies', () => {
  for (const mode of ['cloud', 'secret']) {
    test(`a ${mode} reply shows the quoted original to both sides`, async ({ browser }) => {
      const ctx = await setup(browser, mode);
      const { alice, bob, aliceName } = ctx;

      try {
        const question = `question ${Date.now()}`;
        await sendMessage(alice, question);

        await openConversation(bob, aliceName);
        await expect(bob.getByText(question)).toBeVisible({ timeout: 30_000 });

        const answer = `answer ${Date.now()}`;
        await replyTo(bob, answer);

        // Bob sees his reply with the original quoted above it.
        await expect(bob.getByText(answer)).toBeVisible({ timeout: 20_000 });
        await expect(bob.getByTitle('Jump to the original message').first())
          .toBeVisible({ timeout: 20_000 });

        // And it arrives at Alice with the reference intact — the part that
        // breaks silently if envelope serialisation regresses.
        await expect(alice.getByText(answer)).toBeVisible({ timeout: 30_000 });
        await expect(alice.getByTitle('Jump to the original message').first())
          .toBeVisible({ timeout: 20_000 });
      } finally {
        await ctx.aliceCtx.close();
        await ctx.bobCtx.close();
      }
    });
  }

  test('the reply bar can be cancelled before sending', async ({ browser }) => {
    const ctx = await setup(browser, 'cloud');
    const { alice, bob, aliceName } = ctx;

    try {
      await sendMessage(alice, `cancel target ${Date.now()}`);
      await openConversation(bob, aliceName);

      await bob.getByRole('button', { name: 'Reply to this message' }).first().click();
      await expect(bob.getByText(/^Replying to/)).toBeVisible();

      await bob.getByRole('button', { name: 'Cancel reply' }).click();
      await expect(bob.getByText(/^Replying to/)).toHaveCount(0);

      // A message sent afterwards must not carry a stale reply reference.
      const plain = `plain after cancel ${Date.now()}`;
      await sendMessage(bob, plain);
      await expect(bob.getByTitle('Jump to the original message')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a reply is not sent as raw envelope JSON', async ({ browser }) => {
    // Structured messages are serialised as envelopes on the secret path. If
    // the receiving side stops parsing them, the reply renders as JSON — the
    // same class of failure that broke sender-key distribution.
    const ctx = await setup(browser, 'secret');
    const { alice, bob, aliceName } = ctx;

    try {
      await sendMessage(alice, `json check ${Date.now()}`);
      await openConversation(bob, aliceName);

      const answer = `readable answer ${Date.now()}`;
      await replyTo(bob, answer);

      await expect(alice.getByText(answer)).toBeVisible({ timeout: 30_000 });
      await expect(alice.getByText('"replyTo"')).toHaveCount(0);
      await expect(alice.getByText('"v":1')).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
