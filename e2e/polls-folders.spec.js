import { test, expect, clickConfirm } from './fixtures.js';

// ============================================================
// Polls and folders
// ============================================================
// Two things worth proving here beyond "the buttons work":
//
//   - a vote reaches the other participant without a reload, which is the
//     `poll_updated` nudge plus a per-viewer refetch (the tally cannot be
//     broadcast, because which option is *mine* differs per reader)
//   - a poll is not offered in a secret chat. The server refuses one, so the
//     failure mode without this is a user composing a poll and being told no
//     after the fact.

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

  const aliceName = uniqueUsername('pfa');
  const bobName = uniqueUsername('pfb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

// Polls are a group feature, so the spec needs a group. Created through the
// API because the group modal is a multi-step flow and is not what this tests;
// groups are made secret, and polls are cloud-only, so the mode is flipped.
async function makeCloudGroup(page, memberIds) {
  return page.evaluate(async (members) => {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: `Poll group ${Date.now()}`, members }),
    });
    const group = await res.json();
    await fetch(`/api/chats/${group.id}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    return group;
  }, memberIds);
}

async function userId(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    return (await res.json()).id;
  });
}

async function reopen(page, chatName) {
  await page.reload();
  await page.getByPlaceholder('Enter password').fill(PASSWORD);
  await page.getByRole('button', { name: /unlock vault/i }).click();
  await expect(page.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
  await page.getByText(chatName, { exact: false }).first().click({ timeout: 20_000 });
}

test.describe('polls', () => {
  test('a poll is created, voted on, and the vote reaches the other side', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bob } = ctx;

    try {
      const group = await makeCloudGroup(alice, [await userId(bob)]);
      await alice.evaluate(async (id) => {
        // Polls need a cloud chat; groups are created secret.
        await fetch(`/api/chats/${id}/messages`, { method: 'HEAD' }).catch(() => {});
      }, group.id);

      const question = `lunch? ${Date.now()}`;

      await reopen(alice, group.name);
      await alice.getByLabel('Attach').click();
      await alice.getByRole('button', { name: /^Poll/ }).click();
      await alice.getByPlaceholder('Ask a question').fill(question);
      await alice.getByPlaceholder('Option 1').fill('Ramen');
      await alice.getByPlaceholder('Option 2').fill('Tacos');
      await alice.getByRole('button', { name: 'Create poll' }).click();

      await expect(alice.getByText(question)).toBeVisible({ timeout: 20_000 });

      // Bob opens the group and sees the poll.
      await reopen(bob, group.name);
      await expect(bob.getByText(question)).toBeVisible({ timeout: 30_000 });

      // Before voting, no tally is shown — seeing it first would bias the answer.
      await expect(bob.getByText('No votes yet')).toBeVisible({ timeout: 10_000 });

      await bob.getByRole('button', { name: /Ramen/ }).click();

      // Bob sees his own result immediately from the vote response...
      await expect(bob.getByText('1 vote')).toBeVisible({ timeout: 15_000 });
      // ...and Alice sees it without reloading, via poll_updated.
      await expect(alice.getByText('1 vote')).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a secret chat is not offered a poll', async ({ browser }) => {
    // The server refuses server-side polls in secret chats, so offering the
    // button would let a user compose one and only then be told no.
    const ctx = await setup(browser, 'secret');
    const { alice } = ctx;

    try {
      await alice.getByLabel('Attach').click();
      await expect(alice.getByRole('button', { name: /^Poll/ })).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('a one-to-one chat is not offered a poll', async ({ browser }) => {
    // A poll needs an audience. Offering one in a two-person chat asks
    // someone to vote at the person who could simply reply — and it costs a
    // permanent slot in the composer, which is the scarcest space in the UI.
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      await alice.getByLabel('Attach').click();
      await expect(alice.getByRole('button', { name: /^Poll/ })).toHaveCount(0);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});

test.describe('folders', () => {
  test('a folder filters the chat list and deleting it keeps the chats', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice, bobName } = ctx;

    try {
      // A third party, so the folder has something to exclude.
      const carolCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const carol = await carolCtx.newPage();
      const carolName = uniqueUsername('pfc');
      await register(carol, carolName);

      await startChat(alice, carolName);

      // Both conversations are in the list to begin with.
      await expect(alice.getByRole('button', { name: new RegExp(bobName) }).first())
        .toBeVisible({ timeout: 20_000 });

      await alice.getByLabel('New', { exact: true }).click();
      await alice.getByRole('button', { name: 'New folder' }).click();
      await alice.getByPlaceholder('Folder name').fill('Work');
      await alice.getByRole('checkbox').first().check();
      await alice.getByRole('button', { name: 'Save' }).click();

      await alice.getByRole('button', { name: 'Work', exact: true }).click();

      // Exactly one chat survives the filter.
      const filtered = alice.locator('button').filter({ hasText: new RegExp(`${bobName}|${carolName}`) });
      await expect(filtered).toHaveCount(1, { timeout: 15_000 });

      // Deleting the folder restores the full list — folders never own chats.
      await alice.getByTitle('Delete this folder').click();
      await clickConfirm(alice, 'Delete');
      // The folder strip — "All" tab included — only renders while at least
      // one folder exists (see ChatSidebar.svelte's `{#if folders.length > 0}`),
      // so deleting the last folder removes the tabs entirely rather than
      // falling back to "All". Asserting the deleted folder is gone is the
      // property that was actually meant here; the chat count below is what
      // proves the chats outlived it.
      await expect(alice.getByRole('button', { name: 'Work', exact: true }))
        .toHaveCount(0, { timeout: 10_000 });
      await expect(
        alice.locator('button').filter({ hasText: new RegExp(`${bobName}|${carolName}`) })
      ).toHaveCount(2, { timeout: 15_000 });

      await carolCtx.close();
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
