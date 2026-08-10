import { test, expect } from './fixtures.js';

// ============================================================
// Voice notes
// ============================================================
// These were broken in every mode, by two separate faults that each stopped
// the send before it finished:
//
//   - ChatView imported `encrypt as encryptFile`, so sendVoiceNote called
//     encrypt(arrayBuffer) and passed the audio as the *key* argument.
//   - The secret path then authorised the recipient through
//     `this.authorizeAttachmentUser` in the messages repo, a method that
//     lives on the attachments repo — so it threw and 500'd. That fault hit
//     every attachment in a secret chat, not only voice.
//
// Chromium's fake audio device makes this testable without a real
// microphone, which is why nothing caught it before.

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

for (const mode of ['secret', 'cloud']) {
  test(`a voice note sends and reaches the other side in a ${mode} chat`, async ({ browser }) => {
    const aliceCtx = await browser.newContext({
      ignoreHTTPSErrors: true, permissions: ['microphone'],
    });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    // A failed send surfaces an error toast (role="alert"); watching for one
    // turns a silent failure into a named one. This used to listen for a
    // native dialog, which ebc6d13 replaced with the toast store — so the
    // assertion below had quietly become vacuous: no dialog is ever emitted
    // now, so the collected list was always empty whether the send failed or
    // not. Collected via an exposed binding rather than a query at the end,
    // because toasts self-dismiss after 4s and would be gone by then.
    const toastMessages = [];
    await alice.exposeBinding('__recordToast', (_source, message) => {
      toastMessages.push(message);
    });
    await alice.addInitScript(() => {
      const seen = new WeakSet();
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role="alert"]')) {
          if (seen.has(el)) continue;
          seen.add(el);
          window.__recordToast?.(el.textContent?.trim() ?? '');
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    try {
      const aliceName = uniqueUsername('vna');
      const bobName = uniqueUsername('vnb');
      await register(alice, aliceName);
      await register(bob, bobName);

      await alice.getByPlaceholder('Search users...').fill(bobName);
      if (mode === 'cloud') {
        await alice.getByRole('button', { name: `Start a cloud chat with ${bobName}` })
          .click({ timeout: 20_000 });
      } else {
        await alice.getByText(bobName, { exact: false }).first().click({ timeout: 20_000 });
      }
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });

      await alice.getByTitle(/voice|record/i).first().click();
      await expect(alice.getByText(/Recording:/)).toBeVisible({ timeout: 10_000 });
      await alice.waitForTimeout(1200);
      await alice.getByRole('button', { name: /send/i }).first().click();

      // It renders for the sender as playable audio, not a failed send.
      await expect(alice.locator('audio').first()).toBeVisible({ timeout: 25_000 });
      expect(toastMessages, 'the send must not raise an error toast').toEqual([]);

      // And it decrypts and renders for the recipient, which is what proves
      // the key material actually travelled with it.
      await bob.getByText(aliceName, { exact: false }).first().click({ timeout: 20_000 });
      await expect(bob.locator('audio').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
}
