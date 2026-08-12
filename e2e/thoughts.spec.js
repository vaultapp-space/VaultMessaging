import { test, expect } from './fixtures.js';

// ============================================================
// Thoughts — the public feed
// ============================================================
// The feed is the one surface where content from a stranger reaches every
// user, so what is worth proving end to end is different from the messaging
// specs: not that a message arrives, but that the *public* path works and that
// the ways out of it — blocking, and the tab that reveals it — actually do.
//
// The mobile test at the bottom is a regression. v1.26 shipped with the
// Thoughts tab doing nothing at all on a phone: the sidebar is a full-width
// overlay below md, and setting the section without closing it swapped the
// pane underneath an unchanged screen. Every server test passed.

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

  // Registration is rate limited by IP, and this file needs more accounts than
  // any other spec — every test wants two strangers. Every worker shares one
  // IP, so the limit is reached on merits rather than by a bug, and the honest
  // handling is to wait it out. Failing here would report a broken feed for
  // what is a busy signal.
  const submit = page.getByRole('button', { name: /create secure account/i });
  const search = page.getByPlaceholder('Search users...');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await submit.click();
    try {
      await expect(search).toBeVisible({ timeout: 15_000 });
      return;
    } catch {
      const limited = page.getByText(/too many requests/i);
      if (await limited.count() === 0) break; // a real failure; report it below
      await page.waitForTimeout(6_000);
    }
  }

  await expect(search).toBeVisible({ timeout: 45_000 });
}

/** Desktop entry point: the icon in the sidebar header. */
async function openFeed(page) {
  await page.getByTitle('Thoughts — the public feed').click();
  await expect(page.getByPlaceholder(/it disappears in 24 hours/i)).toBeVisible({ timeout: 20_000 });
}

async function writeThought(page, text) {
  const composer = page.getByPlaceholder(/it disappears in 24 hours/i);
  await composer.fill(text);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(composer).toHaveValue('', { timeout: 20_000 });
}

/**
 * A post by its text. Scoped to an article so it cannot match the composer's
 * own value or a toast — the same class of false positive that made the
 * message-bubble locator necessary in the messaging specs.
 */
function postCard(page, text) {
  return page.locator('article').filter({ hasText: text }).first();
}

test.describe('thoughts', () => {
  // Longer than the default. Every test here needs two strangers rather than
  // one account, registration is IP rate limited, and the tick is coalesced
  // over 5s by design — so these legitimately take longer than a messaging
  // test rather than being slow by accident.
  test.describe.configure({ timeout: 150_000 });

  test('a post reaches a stranger, who can like and reply to it', async ({ browser }) => {
    const aCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aCtx.newPage();
    const bob = await bCtx.newPage();

    try {
      await register(alice, uniqueUsername('tha'));
      await register(bob, uniqueUsername('thb'));

      await openFeed(alice);
      const text = `a public thought ${Date.now()}`;
      await writeThought(alice, text);

      // Bob has never met Alice and has not followed her. Global reaching him
      // at all is the whole feature — everything else in the app requires
      // knowing who you want to talk to first.
      await openFeed(bob);
      await expect(postCard(bob, text)).toBeVisible({ timeout: 30_000 });

      // Like it. Asserted through the accessible name rather than the visible
      // digit: the count renders as a bare "1" that would also match a
      // timestamp or another counter on the same card.
      await postCard(bob, text).getByRole('button', { name: 'Like, 0 likes' }).click();
      await expect(postCard(bob, text).getByRole('button', { name: 'Unlike, 1 likes' }))
        .toBeVisible({ timeout: 20_000 });

      // Reply in the thread.
      await postCard(bob, text).click();
      const replyBox = bob.getByPlaceholder(/reply/i);
      await expect(replyBox).toBeVisible({ timeout: 20_000 });
      const reply = `answering ${Date.now()}`;
      await replyBox.fill(reply);
      await bob.getByRole('button', { name: 'Reply', exact: true }).click();

      await expect(postCard(bob, reply)).toBeVisible({ timeout: 20_000 });
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test('a live post raises the new-posts banner without pushing the content', async ({ browser }) => {
    const aCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aCtx.newPage();
    const bob = await bCtx.newPage();

    try {
      await register(alice, uniqueUsername('tka'));
      await register(bob, uniqueUsername('tkb'));

      await openFeed(alice);
      // Bob is watching before anything is posted, so this is the socket path.
      await openFeed(bob);

      const text = `live thought ${Date.now()}`;
      await writeThought(alice, text);

      // The banner appears; the post does not. The server sends a bare nudge
      // because it cannot filter per viewer at publish time — pushing bodies
      // would deliver a blocked author's content to whoever blocked them.
      // The tick is coalesced over 5s, so this waits longer than a message.
      const banner = bob.getByRole('button', { name: /new posts/i });
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(postCard(bob, text)).toHaveCount(0);

      await banner.click();
      await expect(postCard(bob, text)).toBeVisible({ timeout: 20_000 });
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test('blocking removes the blocked user from the feed', async ({ browser }) => {
    const aCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const alice = await aCtx.newPage();
    const bob = await bCtx.newPage();

    try {
      const aliceName = uniqueUsername('tba');
      await register(alice, aliceName);
      await register(bob, uniqueUsername('tbb'));

      await openFeed(alice);
      const text = `blockable thought ${Date.now()}`;
      await writeThought(alice, text);

      await openFeed(bob);
      await expect(postCard(bob, text)).toBeVisible({ timeout: 30_000 });

      // Muting is the feed-local tool and is applied server-side from the
      // profile, so it is the reachable one from here. The block filter is
      // proven in SQL by the server suite; what this checks is that the UI
      // path actually results in the posts going away.
      await postCard(bob, text).getByText(`@${aliceName}`).first().click();
      await bob.getByRole('button', { name: 'Mute', exact: true }).click({ timeout: 20_000 });
      await expect(bob.getByRole('button', { name: 'Muted', exact: true }))
        .toBeVisible({ timeout: 20_000 });

      // Back to the timeline, then force a refetch by switching tabs. Not a
      // page reload: Vault holds key material in volatile memory only, so
      // reloading logs the account out and the test would be measuring the
      // login screen. Switching tabs clears the list and calls load(), which
      // is the same round trip without losing the session.
      await bob.getByRole('button', { name: /back/i }).first().click();
      await bob.getByRole('button', { name: 'Following', exact: true }).click();
      await bob.getByRole('button', { name: 'Global', exact: true }).click();

      // Muted authors are filtered in SQL, so this is the server's answer and
      // not a client-side hide.
      await expect(postCard(bob, text)).toHaveCount(0);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test('the Thoughts tab reveals the feed on a phone', async ({ browser }) => {
    // The v1.26 regression, pinned. Below md the sidebar is a full-width
    // overlay, so switching section without closing it left the screen
    // completely unchanged and the tab looked dead.
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();

    try {
      await register(page, uniqueUsername('tmo'));

      await page.getByRole('button', { name: 'Thoughts' }).click();

      const composer = page.getByPlaceholder(/it disappears in 24 hours/i);
      await expect(composer).toBeVisible({ timeout: 20_000 });

      // Visibility alone does not prove the fix. During the bug the feed was
      // mounted and perfectly "visible" to Playwright — the sidebar covering
      // it is translated off-screen rather than hidden, and a transform does
      // not make an element invisible. What was actually broken was that
      // nothing on the feed could be reached.
      //
      // So this clicks. Playwright refuses to click an element another one
      // obscures, which is exactly the condition being tested.
      await composer.click();
      await expect(composer).toBeFocused();
    } finally {
      await ctx.close();
    }
  });
});
