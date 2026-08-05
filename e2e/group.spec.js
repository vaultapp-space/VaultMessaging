import { test, expect } from '@playwright/test';

// ============================================================
// Group messaging end-to-end
// ============================================================
// Covers the Signal Sender Key path, which the 1:1 spec does not touch at
// all and which fails in a specifically nasty way: if sender-key
// distribution breaks, sending still appears to succeed and only the
// recipients discover — silently — that nothing decrypts.
//
// Three users, not two, on purpose. With two participants a broken
// distribution loop can still coincidentally work; with three, every member
// must receive the sender key over their own pairwise ratchet.

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

async function createGroup(page, groupName, memberUsernames) {
  await page.getByTitle('Create Group Chat').click();
  await page.getByPlaceholder('E.g., Secret Project Alpha').fill(groupName);

  for (const username of memberUsernames) {
    await page.getByPlaceholder('Search username...').fill(username);
    // Debounced, prefix-anchored search, then the "Add" row for that user.
    await page.getByRole('button', { name: new RegExp(`${username}.*Add`, 'i') })
      .first().click({ timeout: 20_000 });
  }

  await page.getByRole('button', { name: /^Create$/ }).click();
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 30_000 });
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

test.describe('group messaging', () => {
  test('a sender key message decrypts for every member', async ({ browser }) => {
    const contexts = await Promise.all([
      browser.newContext({ ignoreHTTPSErrors: true }),
      browser.newContext({ ignoreHTTPSErrors: true }),
      browser.newContext({ ignoreHTTPSErrors: true }),
    ]);
    const [alice, bob, carol] = await Promise.all(contexts.map((c) => c.newPage()));

    const names = {
      alice: uniqueUsername('ga'),
      bob: uniqueUsername('gb'),
      carol: uniqueUsername('gc'),
    };
    const groupName = `grp${Date.now().toString(36)}`;

    try {
      // Members must exist before they can be found by search.
      await register(bob, names.bob);
      await register(carol, names.carol);
      await register(alice, names.alice);

      await createGroup(alice, groupName, [names.bob, names.carol]);

      const first = `group hello ${Date.now()}`;
      await sendMessage(alice, first);
      await expect(alice.getByText(first)).toBeVisible({ timeout: 20_000 });

      // Each member must independently decrypt using the distributed key.
      await openConversation(bob, groupName);
      await expect(bob.getByText(first)).toBeVisible({ timeout: 30_000 });

      await openConversation(carol, groupName);
      await expect(carol.getByText(first)).toBeVisible({ timeout: 30_000 });

      // A second message reuses the existing sender key rather than
      // redistributing, which is a different branch of the send path.
      const second = `second message ${Date.now()}`;
      await sendMessage(alice, second);
      await expect(bob.getByText(second)).toBeVisible({ timeout: 30_000 });
      await expect(carol.getByText(second)).toBeVisible({ timeout: 30_000 });

      // A reply from another member exercises distribution in the other
      // direction: bob now has to send *his* sender key to alice and carol.
      const reply = `bob replies ${Date.now()}`;
      await sendMessage(bob, reply);
      await expect(alice.getByText(reply)).toBeVisible({ timeout: 30_000 });
      await expect(carol.getByText(reply)).toBeVisible({ timeout: 30_000 });
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
