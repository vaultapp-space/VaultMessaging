import { test, expect } from '@playwright/test';

// ============================================================
// Channels
// ============================================================
// The two things worth proving end to end are that a broadcast actually
// reaches a subscriber live, and that the empty state explains itself. The
// second matters more than it sounds: a channel is exactly what people expect
// to be an archive, so an unexplained empty feed reads as data loss.

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

async function makeChannel(page, title, username) {
  await page.getByText(/create a channel/i).click();
  await page.getByPlaceholder('Channel name').fill(title);
  await page.getByPlaceholder(/public username/i).fill(username);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByPlaceholder('Broadcast to subscribers...')).toBeVisible({ timeout: 20_000 });
}

async function publish(page, text) {
  const composer = page.getByPlaceholder('Broadcast to subscribers...');
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('channels', () => {
  test('an admin posts and a subscriber sees it live', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const readerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const reader = await readerCtx.newPage();

    try {
      await register(owner, uniqueUsername('cha'));
      await register(reader, uniqueUsername('chb'));

      const handle = uniqueUsername('news');
      await makeChannel(owner, 'Daily News', handle);

      // The reader finds it through the directory and subscribes.
      await reader.getByPlaceholder('Search users...').fill(handle);
      await reader.getByText('Daily News').first().click({ timeout: 20_000 });
      await expect(reader.getByText(/Only admins can post/)).toBeVisible({ timeout: 20_000 });

      // Published after the reader is already watching, so this exercises the
      // live socket path rather than a reload.
      const text = `broadcast ${Date.now()}`;
      await publish(owner, text);

      await expect(reader.getByText(text)).toBeVisible({ timeout: 30_000 });
    } finally {
      await ownerCtx.close();
      await readerCtx.close();
    }
  });

  test('a subscriber gets no composer', async ({ browser }) => {
    // The difference between a channel and a group is exactly that
    // subscribers do not get to write.
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const readerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const reader = await readerCtx.newPage();

    try {
      await register(owner, uniqueUsername('cca'));
      await register(reader, uniqueUsername('ccb'));

      const handle = uniqueUsername('quiet');
      await makeChannel(owner, 'Read Only', handle);

      await reader.getByPlaceholder('Search users...').fill(handle);
      await reader.getByText('Read Only').first().click({ timeout: 20_000 });

      await expect(reader.getByPlaceholder('Broadcast to subscribers...')).toHaveCount(0);
      await expect(reader.getByText(/Only admins can post/)).toBeVisible({ timeout: 20_000 });
    } finally {
      await ownerCtx.close();
      await readerCtx.close();
    }
  });

  test('an empty channel says posts expired, not that nothing was posted', async ({ browser }) => {
    // The most surprising consequence of the 24h rule in the product. Getting
    // this copy wrong is the difference between "working as designed" and
    // "the app lost my channel".
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('cea'));
      await makeChannel(page, 'Silent', uniqueUsername('silent'));

      await expect(page.getByText(/deleted 24 hours after they are published/))
        .toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.close();
    }
  });

  test('a post carries a view count', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const readerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const reader = await readerCtx.newPage();

    try {
      await register(owner, uniqueUsername('cva'));
      await register(reader, uniqueUsername('cvb'));

      const handle = uniqueUsername('views');
      await makeChannel(owner, 'Viewed', handle);
      const text = `counted ${Date.now()}`;
      await publish(owner, text);
      await expect(owner.getByText(text)).toBeVisible({ timeout: 20_000 });

      await reader.getByPlaceholder('Search users...').fill(handle);
      await reader.getByText('Viewed').first().click({ timeout: 20_000 });
      await expect(reader.getByText(text)).toBeVisible({ timeout: 20_000 });

      // The reader's view is recorded server-side and deduplicated.
      const views = await reader.evaluate(async (handleName) => {
        const found = await (await fetch(
          `/api/channels/by-username/${handleName}`, { credentials: 'include' }
        )).json();
        const res = await fetch(`/api/channels/${found.id}/posts`, { credentials: 'include' });
        return (await res.json()).posts[0].views;
      }, handle);
      expect(views).toBeGreaterThanOrEqual(1);
    } finally {
      await ownerCtx.close();
      await readerCtx.close();
    }
  });

  test('a channel post writes no per-subscriber update rows', async ({ browser }) => {
    // The scaling property the design rests on, checked from the outside: a
    // subscriber's update log must not grow when a channel posts, or one post
    // to a large channel becomes hundreds of thousands of writes.
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const readerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const reader = await readerCtx.newPage();

    try {
      await register(owner, uniqueUsername('cua'));
      await register(reader, uniqueUsername('cub'));

      const handle = uniqueUsername('scale');
      await makeChannel(owner, 'Scaled', handle);

      await reader.getByPlaceholder('Search users...').fill(handle);
      await reader.getByText('Scaled').first().click({ timeout: 20_000 });

      const before = await reader.evaluate(async () => {
        const res = await fetch('/api/updates?pts=0', { credentials: 'include' });
        return (await res.json()).pts;
      });

      await publish(owner, `scaling ${Date.now()}`);
      await reader.waitForTimeout(2500);

      const after = await reader.evaluate(async () => {
        const res = await fetch('/api/updates?pts=0', { credentials: 'include' });
        return (await res.json()).pts;
      });

      expect(after).toBe(before);
    } finally {
      await ownerCtx.close();
      await readerCtx.close();
    }
  });
});
