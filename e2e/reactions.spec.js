import { test, expect, messageBubble } from './fixtures.js';

// ============================================================
// Reactions, in both chat modes
// ============================================================
// The point of this spec is that the *same* interaction works over two
// completely different transports:
//
//   cloud  → an HTTP call to the reactions endpoint; the server recomputes the
//            summary and broadcasts it.
//   secret → an encrypted t:'op' envelope through the Double Ratchet, applied
//            client-side by each recipient. The server never learns that a
//            reaction happened at all.
//
// If the secret case ever regresses it will fail silently in production — the
// sender sees their own optimistic update and never finds out the peer got
// nothing — which is exactly why it is tested here rather than by hand.

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
  await expect(messageBubble(page, text)).toBeVisible({ timeout: 20_000 });
}

async function react(page, emoji) {
  await page.getByRole('button', { name: 'Add reaction' }).first().click({ timeout: 20_000 });
  await page.getByRole('button', { name: `React with ${emoji}` }).click({ timeout: 10_000 });
}

async function expectReaction(page, emoji) {
  await expect(
    page.getByRole('button', { name: new RegExp(`(Remove your|Add) ${emoji} reaction`) }).first()
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('reactions', () => {
  test('a reaction in a cloud chat reaches the other participant', async ({ browser }) => {
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    const aliceName = uniqueUsername('rca');
    const bobName = uniqueUsername('rcb');

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await startChat(alice, bobName, 'cloud');
      await sendMessage(alice, `cloud reaction target ${Date.now()}`);

      await openConversation(bob, aliceName);
      await react(bob, '🔥');

      // Bob sees his own reaction...
      await expectReaction(bob, '🔥');
      // ...and it propagates to Alice over the broadcast.
      await expectReaction(alice, '🔥');
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('a reaction in a secret chat reaches the peer without the server seeing it', async ({ browser }) => {
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    const aliceName = uniqueUsername('rsa');
    const bobName = uniqueUsername('rsb');

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await startChat(alice, bobName, 'secret');
      await sendMessage(alice, `secret reaction target ${Date.now()}`);

      await openConversation(bob, aliceName);
      await react(bob, '👍');

      await expectReaction(bob, '👍');
      // Travelled as an encrypted op through the ratchet and was applied
      // locally — no server-side reaction record involved.
      await expectReaction(alice, '👍');
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('a reaction op is applied, never rendered as a message', async ({ browser }) => {
    // The failure this guards: if consumeIfOperation() stops recognising the
    // envelope, the recipient sees raw operation JSON in the transcript —
    // exactly the class of bug that broke group sender-key distribution.
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    const aliceName = uniqueUsername('rop');
    const bobName = uniqueUsername('rob');

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await startChat(alice, bobName, 'secret');
      await sendMessage(alice, `op target ${Date.now()}`);

      await openConversation(bob, aliceName);
      await react(bob, '😂');
      await expectReaction(alice, '😂');

      await expect(alice.getByText('"kind":"react"')).toHaveCount(0);
      await expect(alice.getByText('"t":"op"')).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('reacting twice removes the reaction', async ({ browser }) => {
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    const aliceName = uniqueUsername('rta');
    const bobName = uniqueUsername('rtb');

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await startChat(alice, bobName, 'cloud');
      await sendMessage(alice, `toggle target ${Date.now()}`);

      await openConversation(bob, aliceName);
      await react(bob, '❤️');
      await expectReaction(bob, '❤️');

      // Tapping the existing pill toggles it back off.
      await bob.getByRole('button', { name: /Remove your ❤️ reaction/ }).first().click();

      await expect(
        bob.getByRole('button', { name: /Remove your ❤️ reaction/ })
      ).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
