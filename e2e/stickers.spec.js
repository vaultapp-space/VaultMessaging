import { test, expect } from './fixtures.js';

// ============================================================
// Stickers
// ============================================================
// The property worth proving is that a sticker works in a **secret** chat.
// A sticker message carries only a reference and travels through the ratchet
// like any other envelope, so the server never learns one was sent — which is
// exactly what would break if someone later "simplified" the picker into a
// direct server-side send.

const PASSWORD = 'a-sufficiently-long-test-password';

// A 1x1 PNG. Enough to prove the upload/serve path without a fixture file.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

// Builds a set through the API — the creation UI is not what this spec tests.
async function seedStickerSet(page, emoji = '🎈') {
  return page.evaluate(async ([png, glyph]) => {
    const upload = await (await fetch('/api/media/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ mimeType: 'image/png', data: png }),
    })).json();

    const set = await (await fetch('/api/stickers/sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        shortName: `pack${Date.now().toString(36)}`,
        title: 'Test Pack',
      }),
    })).json();

    const sticker = await (await fetch(`/api/stickers/sets/${set.id}/stickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ fileId: upload.fileId, emoji: glyph, width: 64, height: 64 }),
    })).json();

    return { set, sticker };
  }, [TINY_PNG, emoji]);
}

async function setup(browser, mode = 'cloud') {
  const aliceCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  const aliceName = uniqueUsername('sta');
  const bobName = uniqueUsername('stb');

  await register(alice, aliceName);
  await register(bob, bobName);
  await startChat(alice, bobName, mode);

  return { aliceCtx, bobCtx, alice, bob, aliceName, bobName };
}

test.describe('stickers', () => {
  for (const mode of ['cloud', 'secret']) {
    test(`a sticker sends and renders in a ${mode} chat`, async ({ browser }) => {
      const ctx = await setup(browser, mode);
      const { alice, bob, aliceName } = ctx;

      try {
        await seedStickerSet(alice);
        await alice.reload();
        await alice.getByRole('button', { name: /start a private chat/i }).first().click();
        await alice.getByPlaceholder('Enter password').fill(PASSWORD);
        await alice.getByRole('button', { name: /unlock vault/i }).click();
        await expect(alice.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
        await startChat(alice, ctx.bobName, mode);

        await alice.getByTitle('Stickers').click();
        await alice.getByRole('button', { name: '🎈' }).first().click({ timeout: 20_000 });

        // It renders for the sender as a bare image, not a file card.
        await expect(alice.locator('img[alt="🎈"]').first()).toBeVisible({ timeout: 20_000 });

        // And it decrypts and renders for the recipient — the part that
        // proves it travelled as an ordinary envelope through the ratchet.
        await bob.getByText(aliceName, { exact: false }).first().click({ timeout: 20_000 });
        await expect(bob.locator('img[alt="🎈"]').first()).toBeVisible({ timeout: 30_000 });
      } finally {
        await ctx.aliceCtx.close();
        await ctx.bobCtx.close();
      }
    });
  }

  test('the server never sees which sticker was sent in a secret chat', async ({ browser }) => {
    // The whole reason sending goes through the normal envelope path rather
    // than a dedicated endpoint.
    const ctx = await setup(browser, 'secret');
    const { alice } = ctx;

    try {
      const { sticker } = await seedStickerSet(alice, '🔒');
      await alice.reload();
      await alice.getByRole('button', { name: /start a private chat/i }).first().click();
      await alice.getByPlaceholder('Enter password').fill(PASSWORD);
      await alice.getByRole('button', { name: /unlock vault/i }).click();
      await expect(alice.getByPlaceholder('Search users...')).toBeVisible({ timeout: 45_000 });
      await startChat(alice, ctx.bobName, 'secret');

      await alice.getByTitle('Stickers').click();
      await alice.getByRole('button', { name: '🔒' }).first().click({ timeout: 20_000 });
      await expect(alice.locator('img[alt="🔒"]').first()).toBeVisible({ timeout: 20_000 });

      // The message the server stored carries no readable sticker reference.
      const stored = await alice.evaluate(async () => {
        const chats = (await (await fetch('/api/chats', { credentials: 'include' })).json()).chats;
        const res = await fetch(`/api/chats/${chats[0].id}/messages`, { credentials: 'include' });
        return JSON.stringify((await res.json()).messages);
      });
      expect(stored).not.toContain(sticker.id);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('the picker explains itself when empty', async ({ browser }) => {
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      await alice.getByTitle('Stickers').click();
      await expect(alice.getByText('No sticker packs yet')).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });

  test('an unsupported sticker format is refused', async ({ browser }) => {
    // SVG especially: it is a script execution vector, and these files are
    // served to other people's browsers.
    const ctx = await setup(browser);
    const { alice } = ctx;

    try {
      const status = await alice.evaluate(async () => {
        const res = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' }),
        });
        return res.status;
      });
      expect(status).toBe(415);
    } finally {
      await ctx.aliceCtx.close();
      await ctx.bobCtx.close();
    }
  });
});
