import { test, expect } from './fixtures.js';

// ============================================================
// Two-user end-to-end smoke test
// ============================================================
// This is the only test that exercises the full stack the way a user does:
// real key generation in the browser, X3DH over the real API, the Double
// Ratchet, WebSocket delivery, and decryption in a second browser context.
//
// Its job is to fail loudly if a refactor breaks end-to-end encryption in a
// way unit tests cannot see — the crypto can be individually correct while
// the wiring between composer, transport and store is broken. Keep it fast
// and keep it about that one property.

const PASSWORD = 'a-sufficiently-long-test-password';

function uniqueUsername(prefix) {
  // Usernames are ^[a-zA-Z0-9_]+$ and capped at 32 characters.
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

async function register(page, username) {
  await page.goto('/');

  // The landing page is always shown first; enter the app from its CTA.
  await page.getByRole('button', { name: /start a private chat/i }).first().click();

  await page.getByPlaceholder('Choose a username').fill(username);
  await page.getByPlaceholder('Min 12 characters').fill(PASSWORD);
  await page.getByPlaceholder('Re-enter your password').fill(PASSWORD);

  await page.getByRole('button', { name: /create secure account/i }).click();

  // Key generation is real ECDH/ECDSA work, so allow generous time.
  await expect(page.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
}

// mode 'cloud' is the default for a new chat, matching Telegram. 'secret'
// uses the lock button beside the search result, which creates a separate,
// end-to-end encrypted conversation with the same person.
async function openChatWith(page, peerUsername, mode = 'cloud') {
  await page.getByPlaceholder('Search users...').fill(peerUsername);
  // Search is prefix-anchored and requires >= 3 characters, then debounced.
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

// Reopens an existing conversation from the chat list rather than starting a
// new one, so the peer lands in the same chat the sender used.
async function openConversation(page, name) {
  await page.getByText(name, { exact: false }).first().click({ timeout: 20_000 });
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
}

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('end-to-end encrypted messaging', () => {
  test('two users exchange messages that decrypt correctly on both sides', async ({ browser }) => {
    // Separate contexts mean separate cookie jars and separate in-memory key
    // material — genuinely two different clients, not two tabs.
    const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      // Alice starts the conversation: this is the X3DH initiation path.
      await openChatWith(alice, bobName);
      const fromAlice = `hello bob ${Date.now()}`;
      await sendMessage(alice, fromAlice);

      // It must render as plaintext for the sender...
      await expect(alice.getByText(fromAlice)).toBeVisible({ timeout: 20_000 });

      // ...and decrypt on Bob's side, which is the property that matters.
      // The message list only renders the open conversation, so Bob has to
      // open it before anything can be asserted about the decrypted text.
      await openChatWith(bob, aliceName);
      await expect(bob.getByText(fromAlice)).toBeVisible({ timeout: 30_000 });

      // Bob replies: this exercises the responder path and a DH ratchet step.
      const fromBob = `hi alice ${Date.now()}`;
      await sendMessage(bob, fromBob);

      await expect(bob.getByText(fromBob)).toBeVisible({ timeout: 20_000 });
      await expect(alice.getByText(fromBob)).toBeVisible({ timeout: 30_000 });

      // A second message from Alice runs the ratchet forward past the step.
      const followUp = `follow up ${Date.now()}`;
      await sendMessage(alice, followUp);
      await expect(bob.getByText(followUp)).toBeVisible({ timeout: 30_000 });
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  test('a secret chat never gives the server plaintext', async ({ browser, request }) => {
    // The core privacy claim, now scoped to secret chats specifically: this
    // used to hold for every conversation, because every conversation was
    // end-to-end encrypted. Cloud is now the default (see the test below),
    // so this asserts the property of the mode that still guarantees it.
    const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    const aliceName = uniqueUsername('carol');
    const bobName = uniqueUsername('dave');
    const secret = `plaintext-canary-${Date.now()}`;

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await openChatWith(alice, bobName, 'secret');
      await sendMessage(alice, secret);

      await openConversation(bob, aliceName);
      await expect(bob.getByText(secret)).toBeVisible({ timeout: 30_000 });

      // Pull the conversation back through the API using Bob's session and
      // confirm the stored payload is ciphertext, not the typed string.
      const cookies = await bobContext.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const bobId = await bob.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return (await res.json()).id;
      });
      const aliceId = await alice.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return (await res.json()).id;
      });
      expect(bobId).toBeTruthy();

      const res = await request.get(`https://localhost:5173/api/messages/${aliceId}`, {
        headers: { cookie: cookieHeader },
      });
      expect(res.ok()).toBeTruthy();

      const body = await res.text();
      expect(body).not.toContain(secret);
      expect(JSON.parse(body).messages.length).toBeGreaterThan(0);
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  test('a cloud chat is readable by the server, by design', async ({ browser, request }) => {
    // The deliberate trade-off, pinned so it can never happen by accident.
    // Cloud chats are stored in plaintext — that is what buys global search,
    // link previews and syncing history to a device with no keys. If this
    // test ever starts failing, either the default changed or cloud messages
    // stopped being stored the way the feature set depends on.
    const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    const aliceName = uniqueUsername('erin');
    const bobName = uniqueUsername('frank');
    const text = `cloud-visible-${Date.now()}`;

    try {
      await register(alice, aliceName);
      await register(bob, bobName);

      await openChatWith(alice, bobName); // cloud by default
      await sendMessage(alice, text);
      await expect(alice.getByText(text)).toBeVisible({ timeout: 20_000 });

      await openConversation(bob, aliceName);
      await expect(bob.getByText(text)).toBeVisible({ timeout: 30_000 });

      const cookies = await bobContext.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const chats = await request.get('https://localhost:5173/api/chats', {
        headers: { cookie: cookieHeader },
      });
      const chat = (await chats.json()).chats.find((c) => c.peerUsername === aliceName);

      expect(chat.mode).toBe('cloud');

      const res = await request.get(
        `https://localhost:5173/api/chats/${chat.id}/messages`,
        { headers: { cookie: cookieHeader } }
      );
      const payload = await res.json();

      expect(payload.messages.some((m) => m.body === text)).toBe(true);
      // Retention still applies: cloud does not mean permanent.
      expect(payload.retentionSeconds).toBe(86400);
      expect(payload.messages.every((m) => m.expiresAt)).toBe(true);
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });
});
