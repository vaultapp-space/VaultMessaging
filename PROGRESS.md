# Vault → Telegram parity: progress

Status as of **2026-08-05**. Companion to `HANDOFF.md`, which carries the
reasoning; this file is the inventory and the at-a-glance state.

**All nine phases of the plan are built.** Gate is green:

| Suite | Count |
|---|---|
| Server (`node:test` + real PG/Redis) | **463 passing** |
| Client (`vitest`) | **175 passing** |
| E2E (`playwright`, 16 specs) | **74 passing** |
| Lint / `svelte-check` / build | clean |
| Migrations `down` → `up` | clean |

Reproduce with:

```bash
cd server && npm run lint && npm test
cd ../client && npm run lint && npm run check && npx vitest run && npm run build
cd ../server && npm run migrate:down && npm run migrate:up
cd .. && npx playwright test
```

---

## The rule that governs everything

**Every message is deleted 24 hours after it was sent — cloud chats included.**
Not negotiable by chat, user, or tier. Chats are durable; their contents are
not, so an emptied conversation stays in the list rather than vanishing.

Five standing guards enforce it, and they should never be deleted:

1. `expires_at` is `NOT NULL` on `messages` and `files`.
2. The send path clamps any requested TTL to the ceiling.
3. The reaper deletes expired rows *and* their on-disk chunks.
4. The same assertions run against `mode='cloud'`.
5. A chat survives its messages expiring, with `last_message_at` intact.

Every table that copies message content expires on the **same reaper pass** —
never on its own schedule, because two schedules drift and then diverge
permanently on any failure. That covers `user_updates`, `bot_updates_queue`,
`callback_queries`, `inline_queries` and `stories`.

**Deliberate exemptions**, each for a stated reason: `chat_settings.theme` (a
preference, not content), `sticker_sets` (a library the user installed),
`chat_admin_log` (an audit trail that erased itself daily would not be one),
and bot registrations/commands (configuration).

---

## Phase status

| Phase | State | Where it lives |
|---|---|---|
| 0 — Foundations, tests, migrations | done | `app.js`, `repos/`, `realtime/`, `shared/` |
| 1 — Chat model + cloud backbone | done | 0002–0004, `chats.repo.js` |
| 2 — Reactions, replies, edit, search… | done | 0005–0007, `phase2.*` |
| 3 — Folders, polls, invites, roles | done | 0008, `phase3.*` |
| 3-tail — Albums, themes, view-once | done | 0009 |
| 4 — Devices + `pts` sync | done | 0010, `devices.*` |
| 5 — Channels | done | 0011, `channels.*` |
| 6 — Stickers | done | 0012, `stickers.*` |
| 7 — Bot platform | **removed** | dropped in 0017; see below |
| 8 — Voice chats, topics, stories | done | 0014–0015, `phase8.*` |

**Removed, by decision:** the bot platform. A bot receiving a message means
the server can read it, which sits badly with a product whose one-to-one chats
are end-to-end encrypted by default — the honest version was always "works
everywhere except the chats most people use". Migration 0017 drops it.

**Not built, by decision:** live location; Lottie/TGS animated stickers (needs
rlottie-wasm and mobile perf work — the schema carries `is_animated` so it is a
renderer change later); MTProto-grade multi-device E2EE (secret chats stay
single-device, as Telegram's do).

---

## Migrations

```
0001_baseline            0006_phase2              0011_channels
0002_chat_model          0007_link_previews       0012_stickers
0003_backfill_chats      0008_phase3              0013_bots
0004_files               0009_phase3_media        0014_phase8
0005_reactions_replies   0010_devices             0015_contacts
                                                  0016_drop_join_key
```

**Never edit an applied migration.** An environment that has run it will not
run it again, so the change reaches fresh databases and silently misses every
existing one. `0015_contacts` exists because that mistake was made and undone.

---

## The load-bearing design decisions

**Dual mode, and which way the defaults point.** `cloud` (server-readable,
syncs, searchable) vs `secret` (E2EE), forked through
`shared/capabilities.js` and imported by both sides.

- **One-to-one chats are secret by default.** This is the conversation people
  assume is private, so the safe mode is the one you get without asking. Cloud
  is a deliberate second tap.
- **Groups are cloud.** Sender keys still work, but every cloud-only group
  feature — polls, scheduled sends, server-side search, channel discussion —
  is unreachable when a group cannot be one, and a feature that exists but can
  never be used is worse than no feature.

The Signal Sender Keys implementation remains for groups created before that
change; new groups do not exercise it.
`t:'op'` envelopes carry reactions/edits/deletes/pins either way — an HTTP call
in cloud, a ratcheted message applied client-side in secret — so one composer
and one message list serve both.

**Channels write O(1) rows per post.** One `messages` row plus one publish to a
live viewer set; offline subscribers pull on open. Never per-subscriber fanout —
that turns one post to a large channel into hundreds of thousands of writes.
Standing tests in both suites assert a subscriber's `pts` does not move.

**`pts` replaced the `delivered` boolean**, which assumed one device per
account. A gap the log cannot serve returns `tooLong` rather than a partial
replay — silently missing messages is far worse than being told to refetch.

**Bots have their own auth surface** (`/bot<token>/…`) and cannot enter secret
chats. Privacy mode is on by default and enforced in the *delivery path*, so a
bot author cannot opt out of it.

**Voice chats are capped honestly.** The media plane is still a 1:1 mesh, so
`MAX_VOICE_PARTICIPANTS` in `phase8.repo.js` is a real limit shown in the UI.
When an SFU lands, that constant is the only thing that moves.

---

## Patterns any new feature must follow

1. **Fork on mode, never assume.** `capabilities()` decides; both sides import it.
2. **Refuse server-side writes for secret chats** wherever the server would
   otherwise read or store content. Each has a test asserting nothing was written.
3. **Extend `carriesStructure` in `sendSecret`** for any new structured field,
   or it is silently dropped on the secret path.
4. **Check authorship for ops that mutate an existing message.** No server
   arbitrates in a secret chat. Pins deliberately skip this — pinning is shared.
5. **Carry new fields into optimistic inserts and `confirmMessage`.** If a route
   broadcasts a message, echo `clientRandomId` back.
6. **Nothing outlives the 24h rule.** `user_updates` and `bot_updates_queue` are
   the sharp edges — they hold message bodies.
7. **A value one user picks and another user's browser renders must be a name
   from a fixed list, not a style.** Chat themes are the example.
8. **Never fan out per subscriber.** Batched worker, not the request path.
9. **A body-less message type needs its envelope on the optimistic insert**, or
   the sender sees an empty bubble until a refetch.
10. **A new message field must be carried on both delivery paths** — the WS
    payload *and* the history query. They deduplicate against each other, so
    whichever arrives first is the copy that renders.
11. **Never edit an applied migration.**

---

## Closed since the first pass

- **`chats.join_key` is gone** (0016). The route, the client UI, the API
  function and the column are all removed, and three tests assert it stays
  gone — the route is unroutable, the column is absent from both tables, and
  creating a group mints no secret. While that column existed the old
  unrevocable bearer path was still live.
- **Reaper monitoring is wired.** `/health` now reports `lastSuccessAt`,
  `runs`, `rowsDeletedTotal` and `lastError`, and returns **503** when no
  successful pass has landed in 15 minutes. A flag alone would let an uptime
  check report green through exactly the outage that matters — the reaper is
  the only thing enforcing the 24-hour rule, and it fails silently.
- **Channel fanout is verified at 10,000 subscribers.** `channel-scale.test.js`
  asserts a post writes exactly one message row and **zero** update rows at
  that size, plus that subscriber lookup pages rather than materialising the
  whole list. Deliberately a write-count assertion, not a stopwatch: timings on
  a shared runner are flaky and prove little.
- **Stories have a working uploader**, and a story's image is now deleted from
  disk when the story expires. That was a real retention leak — story files go
  through the *public* media path, so nothing else would ever have removed
  them, and the image would have outlived the row and stayed reachable by
  anyone holding the URL.
- **Forum topics have a UI.** `TopicBar.svelte`, with `topic_id` plumbed
  through send and history so topics are genuinely separate conversations
  rather than one stream with labels.
- **Public media has its own route.** `media.routes.js` replaces the
  sticker-specific uploader now that stories share it; the old naming had
  become a lie.

## Known gaps and follow-ups

- **E2E flakiness is fixed** (leaked browser contexts, see `e2e/fixtures.js`).
  Three consecutive clean runs at 5.7 / 5.7 / 5.3 minutes. If it returns, the
  first thing to check is whether a new spec creates a context outside the
  fixture's reach — not whether a timeout needs raising.

- **`/bot` needs a production proxy rule.** It sits outside `/api` on purpose;
  a proxy forwarding only `/api` hands bots the SPA's HTML. Fixed in
  `vite.config.js`; production needs the same.
- **Alert on the `/health` 503.** The signal exists now; nothing consumes it
  yet. Point an uptime check at `/health` and page on non-2xx.
- **Voice chat is capped at 4** by the mesh topology. An SFU is the unlock;
  `MAX_VOICE_PARTICIPANTS` is the only constant that moves.
- **Lottie/TGS animated stickers** remain out of scope; `is_animated` is in the
  schema so it is a renderer change, not a migration.
- `svelte-check --strict` reports pre-existing inference noise on unannotated
  JS. Clearing it is a TypeScript migration by another name.

---

## Where things are

```
server/src/
  app.js                 buildApp({store, config}) — everything registers here
  repos/                 17 modules; one per domain, factories taking a pool
  routes/                20 modules
  realtime/              registry (sockets + channel viewers), bus, fanout, calls
  lib/safe-fetch.js      SSRF guard — link previews and bot webhooks both use it
  migrations/            0001–0015

client/src/
  components/            ChatView, ChatSidebar, ChannelView, StickerPicker,
                         BotManager, Stories, VoiceChatBar, ActiveSessions, Poll
  lib/chat/send.js       the dual-mode fork
  lib/stores/messages.js the message store, dedupe, op application
  lib/api/http.js        120 endpoints

shared/
  envelope.js            the v1 message envelope and op kinds
  capabilities.js        what each mode supports
```
