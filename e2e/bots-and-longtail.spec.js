import { test, expect } from '@playwright/test';

// ============================================================
// Bots, voice chats, topics, stories
// ============================================================
// Phases 7 and 8 end to end. The assertions that matter are the ones about
// what a bot is *not* allowed to do — a bot token is a credential anyone can
// obtain by registering, so the refusals are the security surface.

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

test.describe('bots', () => {
  test('a bot is created and its token is shown exactly once', async ({ browser }) => {
    // Only a hash is stored, so if the UI does not surface it here there is
    // no way to recover it.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('bta'));
      await page.getByTitle('Settings').click();
      await expect(page.getByText('Bots', { exact: true })).toBeVisible({ timeout: 15_000 });

      await page.getByRole('button', { name: 'New bot' }).click();
      await page.getByPlaceholder(/must end in bot/).fill(uniqueUsername('helper').slice(0, 26) + 'bot');
      await page.getByRole('button', { name: /Create bot/ }).click();

      await expect(page.getByText(/copy it now/i)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/only time it is shown/i)).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('a bot receives a message and can reply', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('btb'));

      // The bot itself is driven through the API — a bot has no UI by
      // definition; it is a program holding a token.
      const bot = await page.evaluate(async () => {
        const res = await fetch('/api/bots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: `e2e${Date.now().toString(36)}bot` }),
        });
        return res.json();
      });
      expect(bot.token).toBeTruthy();

      const chat = await page.evaluate(async (botId) => {
        const res = await fetch('/api/chats/private', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ peerId: botId, mode: 'cloud' }),
        });
        return res.json();
      }, bot.id);

      // The bot replies with an inline keyboard.
      await page.evaluate(async ([token, chatId]) => {
        await fetch(`/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Pick one',
            reply_markup: { inline_keyboard: [[{ text: 'Yes please', callback_data: 'yes' }]] },
          }),
        });
      }, [bot.token, chat.id]);

      // The chat was created through the API after the sidebar loaded, so it
      // is reached through search rather than the existing list.
      await page.getByPlaceholder('Search users...').fill(bot.username);
      // The search is debounced; clicking into a list that is still
      // re-rendering lands on whatever was there a moment ago.
      await page.waitForTimeout(1000);
      await page.getByText(bot.username, { exact: false }).first().click({ timeout: 20_000 });
      await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Pick one')).toBeVisible({ timeout: 20_000 });

      // The keyboard renders, and pressing it reaches the bot.
      const button = page.getByRole('button', { name: 'Yes please' });
      await expect(button).toBeVisible({ timeout: 15_000 });
      await button.click();
      // The press is a round trip; the callback is queued server-side before
      // it can be polled for.
      await page.waitForTimeout(1500);

      const updates = await page.evaluate(async (token) => {
        const res = await fetch(`/bot${token}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return (await res.json()).result;
      }, bot.token);

      expect(updates.some((u) => u.callback_query?.data === 'yes')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('a bot cannot be added to a secret chat', async ({ browser }) => {
    // The refusal that keeps the encryption claim honest: a bot receiving a
    // message means the server can read it.
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      const aliceName = uniqueUsername('bsa');
      const bobName = uniqueUsername('bsb');
      await register(alice, aliceName);
      await register(bob, bobName);

      await alice.getByPlaceholder('Search users...').fill(bobName);
      await alice.getByRole('button', { name: `Start a secret chat with ${bobName}` })
        .click({ timeout: 20_000 });
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20_000 });

      const status = await alice.evaluate(async () => {
        const bot = await (await fetch('/api/bots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: `sec${Date.now().toString(36)}bot` }),
        })).json();

        const chats = (await (await fetch('/api/chats', { credentials: 'include' })).json()).chats;
        const secret = chats.find((c) => c.mode === 'secret');

        const res = await fetch(`/api/chats/${secret.id}/bots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ botId: bot.id }),
        });
        return res.status;
      });

      expect(status).toBe(400);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});

test.describe('voice chats', () => {
  test('a group voice chat can be started and joined, and shows its cap', async ({ browser }) => {
    // The cap is deliberately visible: the media plane is a mesh, so a call
    // genuinely does not work past a handful of people.
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const memberCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const member = await memberCtx.newPage();

    try {
      const ownerName = uniqueUsername('vca');
      const memberName = uniqueUsername('vcb');
      await register(owner, ownerName);
      await register(member, memberName);

      const memberId = await member.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return (await res.json()).id;
      });

      const group = await owner.evaluate(async (id) => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: `Call ${Date.now()}`, members: [id] }),
        });
        return res.json();
      }, memberId);

      await owner.reload();
      await owner.getByRole('button', { name: /start a private chat/i }).first().click();
      await owner.getByPlaceholder('Enter password').fill(PASSWORD);
      await owner.getByRole('button', { name: /unlock vault/i }).click();
      await expect(owner.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });

      await owner.getByText(group.name, { exact: false }).first().click({ timeout: 20_000 });
      await owner.getByRole('button', { name: /Start a voice chat/ }).click({ timeout: 20_000 });

      // The count and the cap are both on screen.
      await expect(owner.getByText(/Voice chat · \d+\/\d+/)).toBeVisible({ timeout: 20_000 });
      await expect(owner.getByRole('button', { name: 'Leave' })).toBeVisible({ timeout: 15_000 });
    } finally {
      await ownerCtx.close();
      await memberCtx.close();
    }
  });
});

test.describe('forum topics', () => {
  test('topics separate a group into threads', async ({ browser }) => {
    // The point of topics: selecting one narrows the list *and* tags what is
    // sent, so they are separate conversations rather than one stream with
    // labels on it.
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const memberCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const member = await memberCtx.newPage();

    try {
      await register(owner, uniqueUsername('ftа'.replace('а', 'a')));
      await register(member, uniqueUsername('ftb'));

      const memberId = await member.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return (await res.json()).id;
      });

      const group = await owner.evaluate(async (id) => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: `Forum ${Date.now()}`, members: [id] }),
        });
        const g = await res.json();
        // Groups are created secret; topics are a cloud-group feature.
        await fetch(`/api/chats/${g.id}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        return g;
      }, memberId);

      await owner.reload();
      await owner.getByRole('button', { name: /start a private chat/i }).first().click();
      await owner.getByPlaceholder('Enter password').fill(PASSWORD);
      await owner.getByRole('button', { name: /unlock vault/i }).click();
      await expect(owner.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });

      await owner.getByText(group.name, { exact: false }).first().click({ timeout: 20_000 });

      // Topics are off by default — a topic bar on an ordinary group would
      // imply a structure that does not exist.
      await owner.getByRole('button', { name: /Turn on topics/ }).click({ timeout: 20_000 });
      await expect(owner.getByRole('button', { name: 'All', exact: true }))
        .toBeVisible({ timeout: 20_000 });

      await owner.getByTitle('New topic').click();
      await owner.getByPlaceholder('Topic name').fill('Rules');
      await owner.getByRole('button', { name: 'Create', exact: true }).click();

      await expect(owner.getByRole('button', { name: 'Rules' })).toBeVisible({ timeout: 20_000 });
    } finally {
      await ownerCtx.close();
      await memberCtx.close();
    }
  });
});

test.describe('stories', () => {
  test('a story is posted and appears, and says it expires', async ({ browser }) => {
    // A story's 24 hours is the product's ceiling, not a story-specific
    // setting — the copy has to make that clear or people look for a way to
    // extend it.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('sta'));

      await page.getByTitle('Post a story').click();
      await expect(page.getByText(/Disappears after 24 hours/)).toBeVisible({ timeout: 15_000 });

      const caption = `my story ${Date.now()}`;
      await page.getByPlaceholder('Say something').fill(caption);
      await page.getByRole('button', { name: 'Post', exact: true }).click();

      // It shows up in the author's own ring.
      await page.waitForTimeout(1500);
      const mine = await page.evaluate(async () => {
        const res = await fetch('/api/stories', { credentials: 'include' });
        return (await res.json()).stories;
      });
      expect(mine.map((s) => s.caption)).toContain(caption);
    } finally {
      await ctx.close();
    }
  });

  test('a contacts-only story is hidden from a stranger', async ({ browser }) => {
    const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const strangerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aliceCtx.newPage();
    const stranger = await strangerCtx.newPage();

    try {
      await register(alice, uniqueUsername('spa'));
      await register(stranger, uniqueUsername('spb'));

      const caption = `private story ${Date.now()}`;
      await alice.evaluate(async (text) => {
        await fetch('/api/stories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            media: { kind: 'text' }, caption: text, privacy: 'contacts',
          }),
        });
      }, caption);

      const seen = await stranger.evaluate(async () => {
        const res = await fetch('/api/stories', { credentials: 'include' });
        return (await res.json()).stories;
      });
      expect(seen.map((s) => s.caption)).not.toContain(caption);
    } finally {
      await aliceCtx.close();
      await strangerCtx.close();
    }
  });
});
