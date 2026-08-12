# Vault → Telegram Parity: where to pick up

Written 2026-08-04. Read this first, then the plan at
`~/.claude/plans/tell-me-what-can-majestic-flurry.md`.

**Nothing is committed.** Everything below is uncommitted working-tree changes
on `main`. Verify before you touch anything:

```bash
cd client && npm run lint && npm run check && npm test && npm run build
cd ../server && npm run lint && npm test
cd .. && npx playwright test
```

All seven gates should pass. **351 tests** (196 server, 151 client, 4 E2E).
If they do not, fix that before writing new code — the suite was built
precisely so a refactor cannot break encryption silently.

---

## The one rule that governs everything

**Every message is deleted 24 hours after it was sent. Cloud chats included.
This is not negotiable by chat, by user, or by tier.**

The user decided this explicitly, overriding the original plan (which dropped
retention limits to match Telegram). It changes what the project is: *Telegram's
feature set and interaction model on a 24-hour window*, not Telegram. Users
cannot scroll back to last week, and that is intended.

It is enforced in five places, and all five must keep holding:

1. `messages.expires_at` and `files.expires_at` are `NOT NULL` — schema tests
   assert this by reading `information_schema`.
2. `chats.default_ttl_secs` and `chat_settings.ttl_secs` carry
   `CHECK (<= 86400)`.
3. `chats.repo.js → resolveTtlSeconds()` is the only place a lifetime is
   decided, and the *shortest* candidate always wins.
4. `files.repo.js → addReference()` clamps with
   `LEAST(..., now() + interval '24 hours')` so a chain of forwards cannot
   manufacture permanent storage.
5. The reaper deletes past-expiry rows and then calls
   `chats.reconcileUnread()`.

There are standing tests for each. **Do not "optimise" any of them away.**

### The companion rule: chats outlive their messages

A chat whose messages have all expired **stays in the list, empty**. Chats are
durable; contents are ephemeral. Without this a conversation vanishes after a
quiet day and the user has to search for the person again — which reads as the
app losing their contacts.

The trap: `chats.repo.js → listForUser()` must **never** `INNER JOIN messages`.
The obvious way to fetch a message preview would make every quiet chat
disappear the moment the reaper runs. It uses `LEFT JOIN LATERAL`. There is a
test named *"a chat whose messages expired stays in the list"* that exists
solely to catch someone changing this.

---

## What is done

### Phase 0 — Foundations (complete)

| Item | Where |
|---|---|
| `buildApp()` factory — no connections, no port, no timers | `server/src/app.js` |
| Real migrations, `initSchemaSQL` deleted | `server/migrations/`, `scripts/migrate.js` |
| Test infrastructure from zero | `server/test/`, `client/test/`, `e2e/` |
| `store.js` split: 819 lines → 166-line facade | `server/src/{repos,cache,realtime}/` |
| Redis pub/sub fanout — replaced 8 hand-rolled delivery loops | `server/src/realtime/` |
| Typed message envelope | `shared/envelope.js` |
| Router with deep links | `client/src/lib/router.js` |
| Component extraction | `client/src/lib/chat/` |
| eslint + svelte-check + CI | `.github/workflows/ci.yml` |

### Phase 1 — Chat model (backend complete, UI wired)

- **0002** `chats`, `chat_members`, `chat_read_state`, `chat_settings`, plus 22
  columns on `messages` (renamed from `encrypted_messages`).
- **0003** backfill. Groups keep their original id so `group-<uuid>` client
  references still resolve. Private chats get deterministic `uuid_v5` ids from
  the participant pair. 19 tests stage the migration properly: baseline →
  seed old-shape data → migrate → assert.
- **0004** `attachments` → `files`, plus `sha256`, dimensions, `ref_count`.
- **Dual-mode fork** — `shared/capabilities.js`, `client/src/lib/chat/send.js`
  (`sendMessage(chat, envelope)`), `client/src/lib/chat/normalize.js`.
- **UI wired** — sidebar reads `/api/chats`, numeric unread badges, sends route
  through the fork.

---

## Read this before writing any feature code

### 1. The dual-mode fork is the load-bearing design

`shared/capabilities.js` decides what each mode supports, and **both client and
server import it**. A capability enforced in only one place is not enforced.

- Cloud-only = things needing the server to *read* content: search, link
  previews, scheduled send, bots, multi-device sync, channels.
- Secret-only = things needing one device to hold keys: per-message TTL,
  burn-on-read, safety numbers.
- **Everything else works in both** — reactions, replies, edits, deletes,
  forwards, pins, drafts, polls, stickers. That is what makes one composer and
  one message list possible.

It **fails closed**: unknown/missing mode is treated as secret. A bug can
withhold a feature; it must never leak plaintext for a chat the user believes
is encrypted.

`POST /api/chats/:chatId/messages` **hard-rejects a secret chat with 400**.
Keep that. A client bug posting there would hand the server plaintext for a
supposedly E2EE conversation — the worst failure this codebase could have.

### 2. Cloud is now the default for new 1:1 chats — decided

The user chose Telegram's model on 2026-08-04. **New one-to-one chats are
cloud** (server-readable, so search / link previews / bots / multi-device sync
become possible). A lock button beside each search result starts a **secret**
chat instead; the two are separate conversations and a pair can have both.

Unchanged and deliberate:

- Migrated chats stay `mode='secret'`. Nobody's existing conversation was
  downgraded.
- **Groups are still `mode='secret'`** — they use Sender Keys, and converting
  them would remove E2EE people already have. Revisit only as an explicit
  decision.

**This is a real reduction in default privacy and deserves a visible product
announcement, not a silent deploy.** Both sides are pinned by E2E tests:
*"a secret chat never gives the server plaintext"* and *"a cloud chat is
readable by the server, by design"*. If the second ever fails, either the
default moved or cloud storage broke.

The UI does not lie about which mode you are in: secret chats show a lock in
the chat list and a "End-to-end encrypted · verify" header; cloud chats say
"Cloud chat · syncs across devices". Fingerprint safety numbers are hidden for
cloud chats via `capabilities()` — offering them there would be misleading,
since there is no ratchet to verify.

### 3. Two membership tables are now kept in step

`groups`/`group_members` (legacy) and `chats`/`chat_members` (new) both exist.
`groups.repo.js` writes to both on create/join/leave. This is deliberate
transitional duplication. **When removing the legacy tables, check every
`getGroup`/`getGroupsForUser` caller first** — the client still addresses
groups as `group-<uuid>`.

---

## Next steps, in order

### A. Cloud default — **DONE** (decided 2026-08-04, see §2)

### B. Finish the UI wiring — **DONE**
- ✅ `normalizeMessage()` wired into `stores/messages.js`, via a `withEnvelope()`
  helper that *overlays* normalized fields onto the raw message rather than
  replacing it. That matters: consumers still read `groupId`/`groupName`/
  `groupMembers` for group fan-out and the transient
  `status`/`optimistic`/`decrypting` flags, none of which `normalize()` models.
  Replacing wholesale silently breaks group rendering.
- ✅ `markChatRead(chatId, maxSeq)` called on chat open, and the `read_history`
  websocket event applies the watermark. **This fixed a dead feature** — see
  bug 6 below.
- ✅ Distinct "Messages have expired" empty state in ChatView, separate from
  "Start a secure conversation". Driven by `conv.isEmpty && conv.lastMessageAt`.

Still open, and genuinely optional:

- `fetchChatMessages(chatId)` — ChatView still loads history via
  `fetchMessages(peerId)`. Works correctly for secret chats (all chats today).
  Switch it when cloud chats go live, since cloud history has no ciphertext to
  decrypt and paginates by `seq` rather than timestamp.

### C. Phase 2 — **in progress**

**Reactions: server done** (migration 0005, `reactions.repo.js`,
`reactions.routes.js`, 16 tests). The pattern every other Phase 2 feature
should copy:

- Cloud chats mutate a table and broadcast a `reaction` event.
- Secret chats are **refused with 400** and instead send a `t:'op'` envelope
  through the ratchet, applied client-side. Recording who reacted to what, in
  the clear, in an E2EE conversation would defeat the point.
- A denormalised `messages.reactions` summary is rewritten in the same
  transaction as the rows, so the message list renders without a join and the
  two cannot drift. There is a test asserting they agree.
- Retention reaches transitively: `ON DELETE CASCADE` on `(chat_id, seq)` means
  a reaction cannot outlive the message it reacted to.

**Reactions: client UI done too.** Pill row + quick picker in MessageBubble,
`lib/chat/reactions.js` forking on mode, `lib/actions/clickOutside.js`. Four
E2E specs cover both transports.

Getting there surfaced a structural gap worth knowing about:

- **Secret messages had no `seq`.** They went through `/api/messages`, which
  never allocated one, so they had no address — and *anything* that references
  a message (reactions, replies, pins, edits) simply could not offer itself.
  `/api/messages` now takes an optional `chatId` and allocates a per-chat seq
  when the sender is a member. **Replies and pins depend on this; do not
  remove it.**
- **`confirmMessage` dropped `chatId`/`seq`**, so a sender's own message was
  unaddressable even once the server had assigned one.
- **Store re-entrancy**: applying an op from inside a `messagesByPeer.update()`
  callback silently lost the write — the outer callback's return value
  overwrites whatever the inner one did. Ops are now collected during the
  update and applied after it commits. Any future op kind must follow that
  pattern.
- **`displayText()` returns `''` for an op envelope** — correct for rendering,
  catastrophic on the send path. `sendSecret` now serialises op envelopes
  instead, or the reaction is encrypted as an empty message and lost while the
  sender still sees their optimistic update.

**Replies: done, both modes.** Reply bar in the composer, quoted preview in
the bubble, tap-to-jump with a flash on the target. The server already had
`reply_to_seq`; the work was on the client.

The rule that makes secret replies work — **worth understanding before adding
edit/forward**: a plain text message is still sent *bare* over the ratchet so
clients predating the envelope can read it. Only a message carrying structure
(`replyTo`, `entities`, `fwd`, or an op) is serialised as an envelope. That
check lives in `sendSecret` as `carriesStructure`. Forget to extend it when
adding a new structured field and the field is silently dropped on the secret
path — the sender sees it, the recipient never does, and nothing errors.

Also note: optimistic messages must carry the new field too. A reply whose
optimistic insert lacked `replyToSeq` rendered without its quote until reload,
which looked like the feature half-working.

**Editing: done, both modes.** PATCH route (author-only, cloud-only), edit op
for secret chats, composer edit mode, "edited" marker.

Two decisions embedded there:

- **No edit window.** The plan copies Telegram's 48 hours, but every message
  is deleted at 24, so a 48h window is code that can never run. A message is
  editable for exactly as long as it exists. A test asserts an edit does not
  extend `expires_at` — editing must never become a way to keep a message
  alive.
- **Authorship is checked twice, for different reasons.** Cloud edits are
  refused server-side with 403. Secret edits have no server to arbitrate, so
  `applyEditIfAuthor()` in the message store drops an edit op whose sender is
  not the author of the target. Without it any group member could silently
  rewrite someone else's words and the recipient would see forged text under
  an innocuous "edited" marker. **Any future op that mutates an existing
  message needs the same check.**

### Phase 2 status

**Server: complete.** Migration 0006 plus `phase2.repo.js` / `phase2.routes.js`
cover delete (both scopes), pins, forwarding, drafts, chat settings
(mute/archive/pin-to-top/per-chat TTL), blocking, presence and global search.
39 tests in `phase2.routes.test.js`, all passing.

**Client: built.**

| Feature | Server | Client |
|---|---|---|
| Reactions, replies, edit | ✅ | ✅ |
| Delete (me / everyone), pin | ✅ | ✅ |
| Forwarding | ✅ | ✅ picker modal |
| Drafts | ✅ | ✅ autosave + restore |
| Mute / archive / pin-to-top | ✅ | ✅ per-chat menu |
| Presence | ✅ | ✅ chat list + header |
| Global search | ✅ | ✅ sidebar |
| Unread badges | ✅ | ✅ |
| Blocking | ✅ | ✅ header menu + banner |

**Blocking was recorded but not enforced** when first built — `isBlockedBetween`
existed and nothing called it. Now enforced on all three paths (secret send,
cloud send, opening a chat) with tests. A block that is recorded but not
enforced is worse than none, because the user believes they are protected.

Two details to preserve:

- **The rejection is deliberately neutral** ("Message could not be
  delivered"). Telling a sender they have been blocked hands them information
  the blocker did not choose to share. There is a test asserting the error
  never says "block".
- **Blocking does not silence a shared group.** One person should not be able
  to mute another globally by blocking them; the check only applies to private
  chats.

Notes on the client work:

- **Drafts fork on mode.** `saveDraftFor()` syncs cloud drafts to the server
  and keeps secret-chat drafts in an in-memory Map. A draft is plaintext, so
  syncing one for an E2EE chat would hand the server what the chat exists to
  withhold. There is an E2E test for the cloud case.
- **Presence is polled only for chats on screen** (45s), not for every
  contact. Polling everyone is how this becomes a request per second for
  information nobody is looking at.
- **The forward picker filters out secret chats** and says why, rather than
  offering a destination that would fail. Forwarding copies the body
  server-side and there is no plaintext body to copy into an encrypted chat.
- **Search states its own limits** — "Searches your last 24 hours. Secret
  chats are not searchable." A search box that quietly returns less than the
  user expects is worse than one that explains.
- **The per-chat menu button sits outside the row button**, not inside it.
  Nested interactive elements are invalid HTML and break keyboard navigation.
- **Header popovers need `relative z-40` on the header itself.** The message
  list below is a later sibling with its own stacking context (`relative`), so
  a popover in the header paints *underneath* it — visible in the DOM and in
  the accessibility tree, but unable to receive clicks. It looks like a dead
  button, not a z-index bug. `document.elementFromPoint()` at the button's
  centre is the fastest way to diagnose this class of failure.

**Link previews: done.** `src/lib/safe-fetch.js` is the security surface and
has 39 dedicated tests in `test/safe-fetch.test.js`. **Treat a failure there
as a live vulnerability, not a broken test.**

What the fetcher defends against, and why each matters:

| Guard | Stops |
|---|---|
| scheme allowlist | `file:`, `data:`, `gopher:` — bypass every other check |
| port allowlist (80/443) | reaching Postgres/Redis on loopback |
| DNS resolve + range check | hostnames pointing into private space |
| **connect to the pinned IP** | DNS rebinding — the one most implementations miss |
| manual redirect handling | a public URL that 302s to `169.254.169.254` |
| 512KB cap, 5s timeout | memory exhaustion, hung sockets |

Two things to preserve:

- **Unfurling happens *after* the reply is sent**, never inline. A slow
  third-party site must not delay messaging. The preview arrives as its own
  `message_preview` event.
- **Previews render as text, never `{@html}`.** Title and description come
  from a third-party page the sender chose, so they are attacker-controlled;
  interpolating them as markup would hand anyone who can post a link a
  scripting primitive in every recipient's client. `og:image` URLs with
  non-HTTP schemes are dropped for the same reason.

Secret chats are never unfurled — that would mean the server reading content
it cannot see, *and* would tell the linked site that a URL was shared in an
encrypted conversation (traffic analysis, not just privacy).

**Not started, and deliberately so:**

- **Stickers / GIFs / animated emoji** — Phase 6 in the plan, not Phase 2.

---

## Phase 3 — server complete, client UI built

Migration 0008, `phase3.repo.js`, `phase3.routes.js`, 34 tests.
Client UI added 2026-08-05: invites, moderation, polls, folders.

### The security fix, and why it mattered

`chats.join_key` was a **permanent, unrevocable bearer secret**. Anyone who had
ever seen it could rejoin forever: no expiry, no usage limit, no revocation, no
record of who used it. A member who left — or was removed — kept working access
indefinitely.

`chat_invites` replaces it with links that expire, can be limited by use count,
can be revoked, and record who redeemed them. Bans are enforced *inside* the
redemption transaction, so removing someone actually removes them rather than
letting them straight back in with a link they still hold.

The `join_key` column still exists for one release so current clients keep
working. **Deleting it is a follow-up, and should happen** — while it exists,
the old unrevocable path is still live.

### Rights model

Capability-based rather than a role enum: `owner`/`admin`/`member` expand into
explicit sets in `ROLE_RIGHTS`, so adding a capability never silently grants it
to a role. Per-member `rights` overrides layer on top. Two deliberate rules:

- **A private chat has no hierarchy.** Both participants get only
  `post`/`pin`; treating one as owner would let them moderate the other.
- **An admin cannot ban the owner**, or promoting someone would hand them the
  ability to take the group.

### Also built

- **Polls** — vote replacement (changing your mind does not leave the old vote
  behind), single vs multi choice, option-range validation, cascade-delete with
  the carrying message.
- **Scheduled messages** — a DB `CHECK` refuses any schedule beyond 24h, since
  such a message would be reaped before it fired. `releaseScheduledMessage()`
  recomputes `expires_at` from *delivery*, not creation, or a message scheduled
  for +23h would die an hour after arriving.
- **Folders** — with the guard that a folder cannot reference a chat you are
  not a member of.

### Client UI — built 2026-08-05

- **Invites** (`ChatView.svelte`) — the old "Group Join Key" panel is gone,
  replaced by link management: create with 24h / single-use / unlimited
  presets, copy, revoke. Members modal gained "Make admin" and "Ban", each
  gated on the caller's actual rights (`loadRights()`), with the server as the
  real gate.
- **Redeeming a link lives in `App.svelte`, not `Chat.svelte`.** The app always
  opens on the landing page, so `Chat.svelte` has not mounted yet when someone
  arrives on `/join/<hash>` — a handler there never runs. `App.svelte` redeems
  it, stashes the chat id in the new `pendingChatId` store, and `Chat.svelte`
  opens that conversation once the chat list loads. The URL is cleared so a
  refresh cannot re-redeem a single-use link.
- **Polls** (`Poll.svelte`, composer in `ChatView.svelte`) — results stay
  hidden until you have voted, single-choice votes fire on click and
  multiple-choice stages then submits. **Cloud only:** the capability table
  lists polls as universal because the envelope can carry one either way, but
  the secret-chat path would have to tally votes client-side through `t:'op'`
  and that is not built — the server refuses it, so the button is not offered
  rather than failing after the user has composed one.
  Poll tallies are **per-viewer** (`mine`), so unlike reactions they cannot be
  denormalized or broadcast: `poll_updated` is a nudge and each client refetches
  its own view. History hydrates polls in `chat-messages.routes.js`, looping
  only over poll-typed messages so an ordinary fetch issues no extra queries.
- **Folders** (`ChatSidebar.svelte`) — explicit chat lists only; Telegram's
  rule-based folders ("all groups", "unread") are not modelled. Tabs appear
  only once a folder exists, so the default sidebar is unchanged.
- E2E: `e2e/invites.spec.js` (3), `e2e/polls-folders.spec.js` (3).

### The Phase 3 tail — built 2026-08-05 (migration 0009)

- **View-once media.** The guarantee is server-side: opening the message
  clears `body`/`media`/`entities` on the row, so the content is gone rather
  than hidden. A client-side-only version is defeated by the network tab.
  Three rules make it behave as people expect — the author viewing their own
  message never consumes it, a group message survives until every *other*
  member has opened it, and the row stays as a tombstone so the transcript
  keeps its shape. **Cloud only**, because a secret chat's server holds only
  ciphertext and has nothing to clear; burn-on-read is the honest equivalent
  there and is already labelled as client-side.
  The consume broadcast **excludes the viewer** — clearing their copy in the
  same instant would mean the one person entitled to see it never does.
- **Albums.** `grouped_id` already existed; the work was client-side. The file
  input is now `multiple`, several files share one id, and the message list
  grids *consecutive* runs of that id. Attachment sends were rerouted from
  `encryptAndSend` through `sendMessage` + `createMediaEnvelope`, so they now
  go through the mode fork like text does. With no groupedId the secret path
  still serialises to the exact legacy `{type:'attachment', …}` payload, so
  older clients are unaffected; `groupedId` was added to `carriesStructure`.
- **Chat themes.** Per-user *and* per-chat (`chat_settings.theme`): picking one
  must not restyle the other participant's client. The stored value is a
  **name from a fixed list**, never a colour — the value round-trips through
  the server to another user's browser, so accepting CSS would be a styling
  primitive in someone else's client. Only the accent family is overridden,
  scoped to the chat pane via `data-chat-theme`, so a theme can never make a
  conversation unreadable. This is the one thing in the codebase deliberately
  exempt from the 24h rule: it is a preference, not content.
- **Live location** — deliberately not built.
- E2E: `e2e/media-and-themes.spec.js` (5), server `phase3-media.routes.test.js` (10).

### What is left in Phase 3

- **Contacts, saved messages, profile photos/bios** — small, no blockers.
- **Video playback, multi-select** — UI-only work.

---

## Phase 4 — devices and multi-device sync (complete)

Migration 0010, `devices.repo.js`, `devices.routes.js`, `ActiveSessions.svelte`,
15 server tests, 5 E2E.

### Why the update log replaces `delivered`

A message carried a `delivered` boolean, which quietly assumes one device per
account. With two, "delivered" has no single answer and starts lying to
whichever device asks second. The replacement is Telegram's: a monotonic `pts`
per user in `user_updates`. Every change appends a row, each device records how
far it has read, and reconnecting is a range scan rather than a diff of
application state — so the server never reasons about what a device knows.

**`user_updates` is the table most likely to quietly break the 24h rule**, so
it is worth being explicit: those rows carry copies of message bodies, and a
log that outlived its messages would be a second, permanent archive of every
conversation. `expires_at` is `NOT NULL`, and the reaper clears it *in the same
pass* as messages rather than in its own job — two schedules would drift, and
then diverge permanently on any failure. Secret chats are never written to it
at all: the payload is plaintext.

A gap the log cannot serve returns `tooLong` rather than a partial replay. A
partial replay would leave a client silently missing messages, which is far
worse than telling it to refetch — and refetching is cheap precisely because
there is only ever a day of it.

### Devices and revocation

`devices` turns a session from an anonymous Redis key into something the owner
can see and revoke. Three details are load-bearing:

- **Revocation is checked on every request**, in the auth plugin, not only at
  sign-out. The revoking user is on a *different* device; the one being
  revoked has no idea it happened. Without this, a lost phone keeps working
  until its 24h token expires.
- **Ownership is enforced inside the `UPDATE`**, not by a check first. A
  read-then-write is a race, and this is the one operation where losing it
  means one account signing out another's device.
- **Sessions are torn down at the same time** via `device:<id>:sessions`.
  Marking the row revoked alone would leave live tokens working.
- A new device starts at the user's *current* pts, not 0 — it is about to load
  the chat list anyway, and replaying a day on top would duplicate all of it.

Secret chats stay per-device, exactly as the plan called for. Do not attempt
MTProto-grade multi-device E2EE.

### What is left in Phase 4

Nothing planned. Session JWTs are not yet device-bound in the token itself
(the binding lives in Redis); moving `deviceId` into the JWT claim would let
the check survive a Redis flush, but nothing depends on it today.

### Patterns every remaining feature should follow

1. **Fork on mode, never assume.** Cloud mutates a table and broadcasts;
   secret sends a `t:'op'` envelope applied client-side. `capabilities()`
   decides, and both sides import it.
2. **Refuse server-side writes for secret chats** wherever the server would
   otherwise read or store content — sends, reactions, edits, deletes, drafts,
   search. Each has a test asserting nothing was written.
3. **Extend `carriesStructure` in `sendSecret`** when adding a structured
   field, or it is silently dropped on the secret path.
4. **Check authorship for any op that mutates an existing message.** There is
   no server to arbitrate in a secret chat — see `applyEditIfAuthor` and
   `applyDeleteIfAuthor`. Pins deliberately skip this: pinning is shared.
5. **Carry new fields into optimistic inserts and `confirmMessage`**, or the
   sender's own copy is wrong until reload. If a new route broadcasts a
   message, echo `clientRandomId` back in the payload — see the duplicate-echo
   bug below for why.
6. **Nothing outlives the 24h rule.** Reactions and pins cascade with their
   message; drafts cascade with their chat; a forwarded copy gets a fresh
   clamped expiry rather than inheriting one. `user_updates` is the sharp
   edge here — it holds copies of message bodies, so it expires in the same
   reaper pass, never on its own schedule.
7. **Anything that stores a value one user picks and another user's browser
   renders must be a name from a fixed list, not a style.** Chat themes are
   the current example; the same applies to anything added later.
8. **Never fan out per subscriber.** Groups deliver per member; channels
   publish once to a live viewer set and let everyone else pull. Anything that
   needs per-subscriber work belongs in a batched worker.
9. **A new body-less message type needs the envelope on its optimistic
   insert**, or the sender sees an empty bubble until a refetch. See the
   sticker bug in Phase 6.
10. **A new message field must be carried on both delivery paths** — the WS
    fanout payload *and* the history query. They deduplicate against each
    other, so whichever arrives first is the copy that renders.
11. **Never edit an applied migration.** An environment that has run it will
    not run it again, so the change reaches fresh databases and silently
    misses every existing one. See `contacts` in 0015.

**Note for migration 0006 onward:** 0005 had to replace the `(chat_id, seq)`
unique index from 0002 because it was *partial*, and Postgres will not let a
foreign key reference a partial index. Anything else keying off
`(chat_id, seq)` — replies, pins, poll votes — can now use a real FK.

---

## Known issues, none blocking

- ~~`deriveSharedBits` ignores its `info` parameter.~~ **FIXED.** It now
  applies HKDF with `info` as the context label, so the same key pair in two
  contexts yields unrelated secrets — which is what `x3dh.js` always assumed.
  **This changed the wire format.** A client on the old derivation and one on
  the new cannot establish a session. The blast radius is small by
  construction: ratchet sessions are volatile (lost on tab close) and messages
  expire in 24h, so the incompatibility clears itself within a day of everyone
  reloading. Still, **deploy client and server together and expect a short
  window where mixed-version clients cannot start new conversations.**
- ~~The WS-level CSWSH check is unreachable.~~ **FIXED.** Websocket upgrades
  now bypass the CORS layer (`app.js` registers CORS as a delegator and passes
  upgrades through), so `ws.routes.js` performs the authoritative origin check
  and closes with 4003. Both share one `fastify.isOriginAllowed` policy so they
  cannot drift. This also removed the root cause of the shutdown hang — a
  bad-Origin upgrade no longer leaves a half-open socket, and SIGTERM now exits
  in ~1s rather than relying on the forced-close fallback. The bounded shutdown
  in `index.js` stays as defence in depth.
- **27 lint warnings**, all deliberate: `svelte/require-each-key` (static
  marketing lists), `infinite-reactive-loop` (heuristic, working code),
  `prefer-svelte-reactivity` (Svelte 5 advice for a Svelte 4 codebase). Real
  signal, not commit blockers. See `client/eslint.config.js`.
- **`checkJs` is off.** With it on, svelte-check reports ~778 errors, nearly all
  inference noise on unannotated JS. Clearing them is a TypeScript migration by
  another name. `npm run check:types` runs the strict pass; the incremental path
  is documented in `client/jsconfig.json`.
- ~~`vps_key.pem` may have been committed.~~ **Checked: it is in `.gitignore`
  and has never been tracked by git.** No rotation needed on this account.

## Bugs found and fixed (do not reintroduce)

0. **The sender's own message could render twice, briefly.** A cloud message is
   inserted optimistically under a temporary id, and the server fans the real
   one back out to *every* member — the sender included, because that broadcast
   is also what syncs the message to their other devices. Under load the socket
   beat the HTTP response back, so the message sat in the list twice until
   `confirmMessage` reconciled it. This was invisible for a long time only
   because `handleIncomingMessage` keyed the echo by `senderId`, which for your
   own message is *you* — the echo went into a phantom bucket nothing rendered.
   Fixing the routing (needed so server-originated messages like polls, which
   have no optimistic copy, land in the right conversation) exposed it.
   Fixed by echoing `clientRandomId` back in the fanout payload and matching on
   it in `addMessage`, with `(chatId, seq)` as a second guard for messages that
   arrive twice by any other route — history overlapping a send still in
   flight, for instance. **Any new route that broadcasts a message must echo
   `clientRandomId`**, or it reintroduces this.

   Worth knowing how it presented: the store was always correct a moment later,
   so it showed up only as Playwright strict-mode violations ("resolved to 2
   elements") that moved between specs from run to run. A transient duplicate
   is invisible to a screenshot taken after the fact.

1. **Group messaging was completely broken.** Sender Keys are distributed over
   the pairwise ratchet, but `decryption.js` only checked for
   `senderkey_distribution` in the *sender-key* branch. Recipients rendered the
   distribution package as raw JSON and never imported the key, so every
   subsequent group message failed. Verified pre-existing by running the group
   E2E against pristine `HEAD`. Fixed in `decryption.js`; `e2e/group.spec.js`
   guards it with three users.
2. **SIGTERM hung forever** after one unauthenticated bad-`Origin` request.
   `fastify.close()` waited on the leaked socket. Fixed with the two-stage
   bounded shutdown in `index.js`.
3. **Push notifications aborted mid-loop.** `push.routes.js` had `sub`
   `const`-scoped inside `try`, referenced in `catch` — a `ReferenceError` on
   every HTTP 410, skipping all remaining subscriptions.
4. **`readHistory` cleared unread on first read.** The `INSERT` path hardcoded
   `unread_count = 0`; only `ON CONFLICT` computed it.
5. **Burn-on-read media resurrected** after the envelope refactor made
   `attachmentData` derived while `burnAndDestroy()` still nulled it.
6. **Read receipts never worked.** `ws.routes.js` handled a per-message
   `type:'read'` ack and `MessageBubble` rendered a read tick, but **no client
   code anywhere sent one** — grep confirmed zero senders. The tick state was
   unreachable and messages never showed as read. Now handled by the watermark
   endpoint (`markChatRead` on chat open + the `read_history` broadcast), which
   is one call per chat open rather than one per message.
   Note the subtlety in `ws.js → markChatReadUpTo()`: the server broadcasts
   `read_history` to **every** member, so the unread badge must only clear when
   `readerId === currentUser.id`. Without that check a peer opening the
   conversation silently clears *your* badge.

---

## Working notes

- **Run the E2E after anything touching crypto, send, or receive.** It is the
  only thing that catches broken encryption end to end; unit tests pass happily
  while messages become unreadable.
- **Test databases**: the harness creates and migrates `vault_test` itself and
  pins Redis to db 15. E2E uses `vault_e2e` (dropped and recreated per run) and
  Redis db 14. Neither touches development data.
- `RATE_LIMIT_DISABLED=1` exists for E2E (7 registrations from one IP would
  trip the 5/min register limit). It is **ignored when
  `NODE_ENV=production`** — verified. Keep that guard.
- **The API server is never reused between E2E runs**
  (`reuseExistingServer: false` in `playwright.config.js`, unlike the client
  entry beside it). `reuseExistingServer` adopts whatever holds the port and
  cannot tell an e2e server from a forgotten `npm run dev`. A full suite once
  ran against a leftover dev server: no `RATE_LIMIT_DISABLED`, so 30 tests
  failed on registration limits unrelated to what they test — and all of them
  were reading and writing the **development** database instead of the
  throwaway one. Both halves are silent, and the run looks like a real result,
  so the failures get investigated as product bugs. If a run ever fails
  broadly on "Too many requests", check what is listening on 3001 before
  reading the failures.
- Migration tests stage deliberately: baseline → seed old-shape data → migrate.
  When adding migration 0005, note `backfill.test.js` counts migrations at or
  above 0003 rather than hardcoding a revert count.


---

## Phase 5 — channels (complete)

Migration 0011, `channels.repo.js`, `channels.routes.js`, `ChannelView.svelte`,
25 server tests, 5 E2E.

### The one rule that must not be broken

**A channel post writes O(1) rows.** One `messages` row, one publish. It does
*not* append a `user_updates` row per subscriber and does *not* iterate the
subscriber list to deliver. For a channel with a million subscribers, either
would turn one post into a million writes.

The mechanism is `fanout.deliverToChannel()` plus a live viewer set in
`registry` (`watch_channel` / `unwatch_channel` over the socket). Connected
readers get the post immediately; everyone else finds it from
`chats.last_message_at` and pulls on open. That asymmetry *is* the O(1)
property. There is a standing test in both the server suite and the E2E suite
asserting a subscriber's `pts` does not move when a channel posts — if a
future feature needs per-subscriber work, it belongs in a batched worker.

`registry.unwatchAll(socket)` runs on close. Without it a socket stays in
every viewer set it ever joined and each post writes to a dead connection.

### Other decisions worth keeping

- **Channels are always cloud mode, never secret.** Not an oversight: sender
  keys assume a membership small enough to rekey when someone leaves, and a
  channel anyone can join would be rekeying constantly while still handing the
  key to every subscriber. Claiming E2EE would be a lie with a padlock on it.
- **Admins live in `chat_members`, subscribers in `channel_subscribers`**
  (hash-partitioned, 16 ways). A consequence to remember: from the rights
  model's point of view **a subscriber is not a member**, so an unauthorised
  subscriber gets 404, not 403 — telling a stranger a private channel exists
  is itself a leak.
- **Views are counted in Redis, not SQL.** A per-view UPDATE on a hot post
  turns one row into a lock queue. The set also deduplicates, and the key TTL
  is set slightly past retention so it expires with the post. `flushViews`
  uses `GREATEST` — the Redis key can expire before the message, and a stale
  zero must not erase a real count.
- **`chat_admin_log` is deliberately exempt from the 24h rule.** An audit
  trail that erased itself daily would not be one. The trade is that
  `details` must **never** carry message content, or it smuggles content past
  the retention ceiling. There is a test asserting the log survives a reap.
- **The empty state is a feature, not copy.** A channel is exactly what people
  expect to be an archive, so an unexplained empty feed reads as data loss.
  `ChannelView` says posts are deleted after 24h, and an E2E test asserts that
  wording. Expect this to be the most common support question in the product.

---

## Phase 6 — stickers (complete)

Migration 0012, `stickers.repo.js`, `stickers.routes.js`,
`StickerPicker.svelte`, 17 server tests, 5 E2E.

**Scope: static, WebP and WebM only.** Lottie/TGS animated stickers are
deliberately out — they need rlottie-wasm (500KB+) and real mobile perf work,
and the format handling rather than the CRUD is what makes them expensive.
`is_animated` / `is_video` are in the schema, so adding them later is a
renderer change, not a migration.

### Retention: sets persist, sticker *messages* do not

This looks like an exception to the 24h rule and is not:

- A **set** is a library the user installed. It persists, and it reveals
  nothing about any conversation.
- A **sticker sent in a chat** is an ordinary message and expires with every
  other one. Messages store a *reference*, so the message expiring leaves the
  set alone — and the set existing tells nobody it was ever used.
- **`recent_stickers` is capped, not expiring** (20, in the repo). That cap is
  a privacy control, not housekeeping: unbounded it becomes a durable record
  of what someone has been sending, which is the metadata this product refuses
  to keep everywhere else.

### Why sending goes through the normal envelope path

A sticker message is `t:'sticker'` carrying a reference, sent through
`sendMessage` like anything else. That is what lets stickers work in **secret**
chats without the server learning one was sent, let alone which — there is an
E2E test asserting the stored ciphertext contains no sticker id. Do not
"simplify" this into a dedicated send endpoint later.

For the same reason `/stickers/:id/use` is called by the *client* after
sending rather than inferred server-side: inferring it would require the
server to watch sticker sends, which in a secret chat it cannot and must not.

### Sticker files are not attachments

Attachments are E2EE and expire in 24h; stickers are public assets in a
persistent library, so they get their own upload/serve pair under
`uploads/stickers/`. Running them through the attachment path would either
make every sticker vanish daily or make the E2EE path lie about what it
protects. The upload uses a **mime allowlist** (webp/png/gif/webm) — SVG is
excluded because it is a script execution vector and these files are served
into other people's browsers. Responses carry `nosniff` and a sandbox CSP.

### Bug this phase surfaced

`MessageBubble` derived its envelope by re-parsing `message.text`. That works
only for secret messages, where the envelope *is* the plaintext; a cloud
message's structure lives in columns and its `text` is just the body — empty
for a sticker, so stickers rendered as empty bubbles. Fixed by preferring
`message.envelope`, which the store already builds, and by carrying the
envelope onto optimistic inserts so the sender's own copy renders the same way
the received one will. **Any future body-less message type would have hit the
same thing.**


---

## Phase 7 — the bot platform (complete)

Migration 0013, `bots.repo.js`, `bot-api.routes.js`, `bots.routes.js`,
`BotManager.svelte`, 29 server tests, 3 E2E.

### The shape of it

A bot is a `users` row with `is_bot = true`. That reuse is what made the phase
affordable — a bot is already a valid chat member, message sender and search
result, so none of those paths learned what a bot is.

There are **two authentication surfaces**, and they are deliberately separate:
`/bot<token>/<method>` (bearer token in the path, Telegram's shape, so existing
bot libraries work) and `/api/bots/…` (session cookie, acting as a person).
Merging them would mean every handler in the product reasoning about which kind
of caller it had, and getting that wrong once means a token acting as a user.

### The five things that are security, not features

1. **Tokens are stored hashed.** The plaintext is returned once at creation and
   never again — the UI has to say so, because there is no way to recover it.
   Rotation takes effect immediately; letting the old token drain would defeat
   the only remedy for a leak.
2. **Privacy mode is the default.** `can_read_all_group_messages` is false, so a
   bot in a group receives only messages addressed to it. **The filter lives in
   the delivery path** (`deliverToBots` in `chat-messages.routes.js`), not in the
   bot client, so a bot author cannot opt out of it.
3. **Bots cannot enter secret chats.** A bot receiving a message means the server
   can read it. Both adding and sending are hard 400s rather than a silent
   downgrade.
4. **Callback data is validated against the stored `reply_markup`.** Without
   that, anyone could hand a bot arbitrary callback data and make it act on a
   button it never offered.
5. **Webhook URLs go through the same SSRF guard as link previews.** Anyone can
   register a bot, so a webhook URL is attacker-chosen by definition. Retries
   back off exponentially — a bot whose endpoint is down must not become an
   unbounded retry loop against someone else's server.

Retention: `bot_updates_queue`, `callback_queries` and `inline_queries` all hold
user content and are reaped in the same pass as messages. Registrations and
declared commands are configuration and persist.

### Deployment note

**The `/bot` prefix needs its own proxy rule.** It lives outside `/api` on
purpose, and a reverse proxy that only forwards `/api` will hand bots the SPA's
HTML instead of a response. This was a real bug in `vite.config.js` and the same
rule is needed in production.

---

## Phase 8 — voice chats, forum topics, stories (complete)

Migrations 0014 and 0015, `phase8.repo.js`, `phase8.routes.js`,
`VoiceChatBar.svelte`, `Stories.svelte`, 23 server tests, 3 E2E.

### Voice chats ship with an honest cap

What is built is the **room**: who is in a call, who is muted, who is speaking,
plus signalling over the existing relay. The media plane is still the 1:1 WebRTC
mesh — O(n²) connections — so a call genuinely does not work past a handful of
people. Scaling further means running an SFU (mediasoup or LiveKit), which is
new *infrastructure*, not new code.

So the participant cap is enforced server-side (in a transaction, so concurrent
joins cannot collectively overfill it) and shown in the UI. **When an SFU is
added, `MAX_VOICE_PARTICIPANTS` in `phase8.repo.js` is the only thing that
moves.** A call that says it holds four is a better experience than one that
quietly falls apart at eight.

Admin mute and self mute are **separate columns**. Collapsing them would let
someone un-mute themselves after a moderator muted them, which is the one thing
moderation muting exists for.

### Forum topics

Nearly free — `chats.is_forum` and `messages.thread_root_seq` already existed.
Closing or pinning a topic needs the `pin` right, not mere membership.

### Stories

The cheapest thing in the plan, because the product is already built around
expiry. Two things worth keeping:

- **A story is not exempt from the 24h ceiling.** Its "24 hours" happens to
  match, which makes it tempting to treat as a special case. The TTL is clamped
  like every other.
- **Privacy is applied in the query, not filtered afterwards.** A
  fetch-then-filter version leaks through any path that forgets the filter.
  `story_views` cascades, so a viewer list cannot outlive its story.

### Migration discipline, learned the hard way

`contacts` was a Phase 2 leftover that stories needed. It was first folded into
0014 — which was **already applied** — so it reached fresh databases and
silently missed every existing one. It now lives in its own migration, 0015.
**Never edit an applied migration.**

---

## Bugs found while building 7 and 8

- **Cloud chat history never loaded.** `ChatView.loadMessagesData` always used
  the legacy pairwise endpoint and marked everything `encrypted: true`, so a
  cloud conversation was empty on every reopen — only live socket messages ever
  appeared. Every earlier E2E passed because they sent within one session. Fixed
  by forking on mode; the same fork was needed in `loadOlderMessages`.
- **A message's structure has to be complete on *both* delivery paths.** The
  bot keyboard arrived through history but not over the socket, and since the
  two are deduplicated against each other, whichever lands first is the copy
  that renders. Anything added to one must be added to the other.
- **`getBySeq` returns a raw row** (snake_case), unlike the other message
  accessors. `message.senderId` there is silently undefined.


---

## Cleanup pass (2026-08-05)

Everything the plan and `PROGRESS.md` listed as outstanding is now closed.

### `join_key` is gone (migration 0016)

It was a **permanent, unrevocable bearer secret**: anyone who had ever seen a
group's join key could rejoin forever, including members who had been removed
or banned. Invite links replaced it in 0008 and the column was kept for one
release; 0016 is the migration that actually closes the hole.

Removed: the `POST /api/groups/join` route, `getGroupByJoinKey`, the client's
`joinGroup()` and the "Join Group with Key" box, and the column from both
`chats` and `groups`. Three tests now assert it stays gone — the route is
unroutable, `information_schema` shows no such column, and creating a group
mints no secret. `down` recreates the column empty on purpose: a rollback must
not bring live bearer credentials back.

### The reaper is observable, and /health fails when it stalls

The reaper is the only thing bounding database size *and* the only thing
enforcing the 24-hour rule, and its failure mode is silent — nothing breaks for
a day, then storage climbs and messages quietly outlive their expiry with no
user-visible symptom.

`/health` now returns `{ reaper: { healthy, lastSuccessAt,
secondsSinceLastSuccess, runs, rowsDeletedTotal, lastError } }` and responds
**503** past a 15-minute stall. The status code matters more than the body: a
monitor reading only the code must not report green through this outage. Boot
counts as the baseline so a restart is not reported unhealthy for one interval,
and an idle pass with nothing to delete still counts as success — otherwise a
quiet night would fire the alarm.

### Channel fanout, verified at scale

`channel-scale.test.js` seeds 10,000 subscribers and asserts a post writes
**exactly one** message row and **zero** update rows. It is a write-count
assertion rather than a stopwatch on purpose: timings on a shared runner are
flaky and prove little, while the write count is exact and catches a
regression at any size.

### A real retention leak in stories

A story's image goes through the **public media path**, not the expiring
attachment path — correctly, because a story is shown to an audience rather
than encrypted to a recipient. But that meant nothing ever deleted the file:
the story row expired and the image stayed on disk, reachable by anyone holding
the URL. The reaper now unlinks a story's file when the story goes, with a test
asserting both that the file disappears and that a **sticker** file does not
(a set is a library the user installed).

That sharing is also why the uploader moved out of `stickers.routes.js` into
`media.routes.js`. One uploader means one mime allowlist to keep correct — and
SVG stays excluded, because it is a script execution vector and these files are
served into other people's browsers.

### Forum topics are wired end to end

`topic_id` is plumbed through send and history, so selecting a topic narrows
the list *and* tags what is sent. Without both halves, topics would be one
interleaved stream with labels on it. The first message in a topic becomes its
root, so a deep link has something to point at, and it does not move to later
messages.

`TopicBar.svelte` only appears on groups that are actually forums — a topic bar
on an ordinary group would imply a structure that does not exist.

---

## The v1.26 stale-server incident (2026-08-12)

v1.26 was published — signed APK, F-Droid index, GitHub release, all verified —
against a server that had never been redeployed. The whole Thoughts client was
live on users' phones calling `/api/posts/*`, and every one of those routes
returned 404 because the process on the VPS predated them.

Nothing in the release path was wrong, individually. There simply was no step
that compared what was being shipped against what was running, and deploying was
a sequence of remembered commands rather than a file. Verifying the APK
thoroughly — versionCode, signature, R8 keeps, byte-for-byte asset match — gave
a strong and entirely misleading impression of a checked release.

Three things came out of it:

- **`/health` reports `build.commit`** (`server/src/build-info.js`), read from
  `.git` at boot with no subprocess. A server that cannot say what it is running
  cannot be checked.
- **`deploy/deploy.sh`** is the deploy, and it verifies itself: after the
  restart it re-reads `/health` and fails if the commit does not match the
  checkout. Note the ordering — migrate, restart, *then* build the client — so
  a newly loaded page never calls routes the running server lacks.
- **`deploy/preflight.sh`** runs locally and exits non-zero when the server is
  behind the commit being released. Run it before an APK, an index update or a
  release.

The generalisable lesson: an artifact can be perfect and still be broken by what
it talks to. Verify the *system*, not the deliverable.

## The media ledger (migration 0020)

`POST /api/media/upload` writes a file and returns a fileId. If nothing ever
references that fileId, no reaper branch deletes it — the reaper walks content
rows, and there is no content row — and `phase8.repo.canViewMediaFile` is
deny-by-exception, so a file no row claims is served to any authenticated user.
An unreferenced upload was therefore a permanent, publicly readable file. That
was tolerable when signup implied someone you had chosen to talk to; a public
feed with anonymous signup turns it into free file hosting on your disk, served
from your domain.

`media_files` records every upload and whether anything claimed it. The reaper
deletes unclaimed rows past an hour's grace, files before rows.

Three properties are load-bearing, and all three have tests:

- **The grace period.** Upload and reference are separate requests — the
  composer uploads when the image is picked and references it when Post is
  tapped, possibly minutes later. Reaping instantly deletes the image out from
  under an open composer.
- **`listOrphans` re-checks the content tables** with `NOT EXISTS`, even though
  `claim()` is what normally clears a row. It means a future content type that
  forgets to claim loses nothing, rather than losing its images an hour after
  upload. A missed claim must be a no-op, not data loss.
- **Files with no ledger row are never touched.** Everything uploaded before
  0020 is in that state. Sweeping by directory listing would catch those too —
  and would delete every sticker on the instance the first time a reference
  check was wrong.

One sharp edge worth remembering: the story media schema is
`additionalProperties: true` with no format check on `fileId`, so a client can
put any string there, and `media_files.file_id` is a `uuid` column. Both
`claim()` and `forget()` filter non-UUIDs. `forget()` matters more — it runs
inside the reaper pass, and an exception there aborts the whole pass, which is a
503 on `/health` after fifteen minutes of them.

## Thoughts phases 6 and 7

### The tick is a nudge, and that is a security property

`watch_feed` reuses `registry.watchChannel` — it keys on an arbitrary string,
so `feed:global` is one more key and the cross-process bus comes along for
free. It has **no authorization check**, unlike `watch_channel` beside it,
because the global feed is public to any authenticated user by definition;
there is no permission to check and a `canRead()` there would be inventing one.
The asymmetry is deliberate and has a comment saying so, because it looks like
an oversight.

What makes it safe is that the socket receives **only a nudge**. The server
cannot filter per viewer at publish time without O(viewers) work, so a pushed
post body would arrive at people who blocked its author — and "the client
received it and hid it" is not blocking. `feed-realtime.test.js` enumerates the
keys `feed_tick` must never grow (`body`, `post`, `authorId`, …), because the
pressure to add one arrives the first time someone finds the refetch wasteful.

The tick is coalesced over 5s. One per post is a thousand socket messages a
minute per viewer at a thousand posts a minute, each carrying what the first
already said.

**Your own post ticks too.** The client suppresses ticks for 6s after posting
rather than the server naming the author in the tick — naming one would tell
every watcher, including people that author has blocked, that they just posted.
The cost is that a genuine tick inside that window is lost, which is a few
seconds of freshness against a banner that points at a post already on screen.

### The mobile tab bug, and why the obvious test would have missed it

v1.26 shipped with the Thoughts tab doing nothing on a phone. Below `md` the
sidebar is a **full-width overlay**, not a column beside the pane, so setting
`activeSection` without closing it swapped the pane underneath a screen that
looked identical. Every server test passed; the feature was entirely
unreachable on the platform it shipped to.

The trap in testing it: during the bug the feed was mounted and **`toBeVisible`
would have passed**. The sidebar covering it is `translate-x-full`, and a
transform does not make an element invisible to Playwright — only `display`,
`visibility` and `opacity` do. So `e2e/thoughts.spec.js` **clicks** the
composer and asserts focus. Playwright refuses to click through an obscuring
element, which is the actual condition that was broken.

Two more things that spec learned the hard way, both worth keeping:

- **Do not `reload()` in a Vault e2e test.** Key material is in volatile memory
  by design, so a reload logs the account out and the assertions end up
  measuring the login screen. Force a refetch through the UI instead —
  switching feed tabs clears the list and calls `load()`.
- **Registration is IP rate limited**, and this spec needs two strangers per
  test. Every worker shares one IP, so the limit is hit on merits. `register()`
  waits it out rather than failing, and the describe block carries a longer
  timeout to fit that.
