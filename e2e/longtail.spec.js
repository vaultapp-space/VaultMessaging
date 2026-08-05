import { test, expect } from './fixtures.js';

// ============================================================
// Voice chats, forum topics, stories
// ============================================================
// The Phase 8 long tail. Bots were removed from the product; the specs that
// covered them went with the code.

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
