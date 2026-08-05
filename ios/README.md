# Vault for iOS

A native SwiftUI client. **Cloud chats only** — see the limitation below, which
is the first thing to understand about this app.

## Running it

The `.xcodeproj` is generated, not committed — a pbxproj is a merge-conflict
machine and nobody can review a diff of one. Regenerate it after pulling:

```bash
brew install xcodegen        # once
cd ios && xcodegen generate
open VaultMessenger.xcodeproj
```

A simulator build points at `http://127.0.0.1:3001`, a device build at
`https://vaultapp.space` (`AppState.defaultServer`). Start the backend first
if you are on the simulator.

## What it does, and what it deliberately does not

Works: signing in, the chat list, reading and sending in cloud chats and
groups, live updates over the websocket, unread counts, read receipts.

**Secret chats are listed but not readable here.** One-to-one chats are
end-to-end encrypted by default, and that stack — X3DH, the Double Ratchet,
Sender Keys — exists only in the web client's JavaScript. Rather than show an
empty conversation that looks like data loss, those rows carry a lock and
*"Encrypted — open on the web to read"*, and do not open.

**There is no account creation.** Registering generates the identity key,
signed prekey and one-time prekeys other people use to start an encrypted
conversation with you. This app cannot yet hold up that side, so an account
created here would look fine and then fail for anyone who messaged it
privately. Sign-up stays on the web until the ratchet is ported.

## The part most likely to break

`Crypto/KeyDerivation.swift` must match `client/src/lib/crypto/keys.js`
exactly:

```
masterKeyBits = PBKDF2-HMAC-SHA256(password, salt, 600_000, 256 bits)
authSecret    = base64(HMAC-SHA256(masterKeyBits, "vault-server-auth-v1"))
```

The password never leaves the device on either platform — the server only ever
sees `authSecret`. So if Swift derives it differently the server rejects the
login with exactly the same response as a wrong password, and nothing points
at the cause. A single wrong iteration count is indistinguishable from a typo.

That is why `VaultMessengerUITests` signs in against a real server rather than
a mock: it is the only thing that catches a derivation drift.

```bash
TEST_RUNNER_VAULT_TEST_USERNAME=someone \
TEST_RUNNER_VAULT_TEST_PASSWORD=their-password \
xcodebuild test -project VaultMessenger.xcodeproj -scheme VaultMessenger \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

The credentials come from the environment so no account is baked into the
repository. Without them the test skips rather than failing.

## Next, in order of value

1. **Port the ratchet** (CryptoKit has X25519, HKDF and AES-GCM). It needs
   cross-language test vectors — a ratchet that is 99% right does not fail
   loudly, it silently stops decrypting.
2. **Push notifications** — the server already has a web-push path; APNs is a
   separate registration.
3. **Attachments and voice notes.** The files are AES-GCM encrypted with a key
   carried in the message, so cloud-chat media is reachable without the ratchet.
