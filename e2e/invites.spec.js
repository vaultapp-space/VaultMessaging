import { test, expect } from './fixtures.js';

// ============================================================
// Invite links
// ============================================================
// These replace `chats.join_key`, a permanent unrevocable bearer secret:
// anyone who ever saw it could rejoin forever, with no expiry, no usage limit
// and no way to withdraw it.
//
// The property worth proving end to end is revocation — that an admin can
// actually take access away after handing a link out.

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

// Creates a group through the API using the page's own session — the group
// creation UI is a multi-step modal and is not what this spec is testing.
async function createGroup(page, name, memberIds) {
  return page.evaluate(async ([groupName, members]) => {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: groupName, members }),
    });
    return res.json();
  }, [name, memberIds]);
}

async function userId(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    return (await res.json()).id;
  });
}

async function apiCreateInvite(page, chatId, options = {}) {
  return page.evaluate(async ([id, opts]) => {
    const res = await fetch(`/api/chats/${id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(opts),
    });
    return res.json();
  }, [chatId, options]);
}

test.describe('invite links', () => {
  test('a link lets someone join, and revoking it stops the next person', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const firstCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const secondCtx = await browser.newContext({ ignoreHTTPSErrors: true });

    const owner = await ownerCtx.newPage();
    const first = await firstCtx.newPage();
    const second = await secondCtx.newPage();

    try {
      await register(owner, uniqueUsername('iva'));
      await register(first, uniqueUsername('ivb'));
      await register(second, uniqueUsername('ivc'));

      const group = await createGroup(owner, `grp${Date.now()}`, [await userId(first)]);
      const invite = await apiCreateInvite(owner, group.id);
      expect(invite.hash).toBeTruthy();

      // The second user joins by opening the link.
      await second.goto(`/join/${invite.hash}`);
      await expect(second.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 30_000 });

      // The owner revokes it.
      await owner.evaluate(async ([chatId, hash]) => {
        await fetch(`/api/chats/${chatId}/invites/${hash}`, {
          method: 'DELETE', credentials: 'include',
        });
      }, [group.id, invite.hash]);

      // A third person with the same link is now refused — the thing the old
      // join key could never do.
      const thirdCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const third = await thirdCtx.newPage();
      await register(third, uniqueUsername('ivd'));

      third.once('dialog', (d) => d.accept());
      await third.goto(`/join/${invite.hash}`);
      await third.waitForTimeout(2500);

      const joined = await third.evaluate(async () => {
        const res = await fetch('/api/chats', { credentials: 'include' });
        return (await res.json()).chats.length;
      });
      expect(joined).toBe(0);

      await thirdCtx.close();
    } finally {
      await ownerCtx.close();
      await firstCtx.close();
      await secondCtx.close();
    }
  });

  test('a single-use link admits exactly one person', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const aCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const bCtx = await browser.newContext({ ignoreHTTPSErrors: true });

    const owner = await ownerCtx.newPage();
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();

    try {
      await register(owner, uniqueUsername('sua'));
      await register(a, uniqueUsername('sub'));
      await register(b, uniqueUsername('suc'));

      const group = await createGroup(owner, `grp${Date.now()}`, [await userId(a)]);
      const invite = await apiCreateInvite(owner, group.id, { usageLimit: 1 });

      await b.goto(`/join/${invite.hash}`);
      await expect(b.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 30_000 });

      const cCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const c = await cCtx.newPage();
      await register(c, uniqueUsername('sud'));

      c.once('dialog', (d) => d.accept());
      await c.goto(`/join/${invite.hash}`);
      await c.waitForTimeout(2500);

      const joined = await c.evaluate(async () => {
        const res = await fetch('/api/chats', { credentials: 'include' });
        return (await res.json()).chats.length;
      });
      expect(joined).toBe(0);

      await cCtx.close();
    } finally {
      await ownerCtx.close();
      await aCtx.close();
      await bCtx.close();
    }
  });

  test('an ordinary member is not offered invite management', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const memberCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const owner = await ownerCtx.newPage();
    const member = await memberCtx.newPage();

    try {
      await register(owner, uniqueUsername('rma'));
      const memberName = uniqueUsername('rmb');
      await register(member, memberName);

      const group = await createGroup(owner, `grp${Date.now()}`, [await userId(member)]);

      // The server is the real gate; this asserts it.
      const status = await member.evaluate(async (chatId) => {
        const res = await fetch(`/api/chats/${chatId}/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        return res.status;
      }, group.id);

      expect(status).toBe(403);
    } finally {
      await ownerCtx.close();
      await memberCtx.close();
    }
  });
});
