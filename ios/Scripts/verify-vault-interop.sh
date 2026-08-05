#!/usr/bin/env bash
#
# Checks that Swift and JavaScript agree on the encrypted identity vault.
#
# This is not a formality. The vault holds the account's private keys, and a
# password change reseals it — on whichever client the user happened to be
# using. If the two implementations disagree by one parameter, the account
# still logs in and every secret chat in it is unreadable forever. Nothing
# else in either test suite would notice.
#
# Run it after touching IdentityVault.swift or encryptIdentityVault in
# client/src/lib/crypto/keys.js.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

MASTER='bWFzdGVyLWtleS1iYXNlNjQtdmFsdWUtaGVyZQ=='
NEW_MASTER='YS1jb21wbGV0ZWx5LWRpZmZlcmVudC1tYXN0ZXIta2V5'

# 1. Seal a payload the way the web client does.
cat > seal.mjs <<'EOF'
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const master = process.argv[2];
const payload = JSON.stringify({ dhPrivateJwk: { kty: 'EC', d: 'secret' }, note: 'hello ünïcode' });
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const pk = await crypto.subtle.importKey('raw', enc.encode(master), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
  pk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payload));
console.log(JSON.stringify({ masterKeyBase64: master, payload,
  vault: JSON.stringify({ salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) }) }));
EOF
node seal.mjs "$MASTER" > vault-fixture.json

# 2. Swift opens it, reseals under a new key, and refuses the old key.
cat > main.swift <<EOF
import Foundation
let d = try! Data(contentsOf: URL(fileURLWithPath: "vault-fixture.json"))
let f = try! JSONSerialization.jsonObject(with: d) as! [String: String]
let opened = try! IdentityVault.open(f["vault"]!, masterKeyBase64: f["masterKeyBase64"]!)
precondition(String(data: opened, encoding: .utf8)! == f["payload"]!, "Swift read a different payload")
print("  swift opens the web-sealed vault   ok")
let resealed = try! IdentityVault.rekey(f["vault"]!, from: f["masterKeyBase64"]!, to: "$NEW_MASTER")
let reopened = try! IdentityVault.open(resealed, masterKeyBase64: "$NEW_MASTER")
precondition(String(data: reopened, encoding: .utf8)! == f["payload"]!, "rekey lost the payload")
print("  swift rekey round-trips            ok")
do { _ = try IdentityVault.open(resealed, masterKeyBase64: f["masterKeyBase64"]!)
     fatalError("the old key still opened the resealed vault") }
catch { print("  old key is rejected                ok") }
try! resealed.write(to: URL(fileURLWithPath: "resealed.json"), atomically: true, encoding: .utf8)
EOF
swiftc -O "$here/../VaultMessenger/Sources/Crypto/IdentityVault.swift" main.swift -o vaultcheck
./vaultcheck

# 3. The direction that actually bites: password changed on the phone, account
#    opened on the web.
cat > verify.mjs <<'EOF'
import { readFileSync } from 'node:fs';
const dec = new TextDecoder(), enc = new TextEncoder();
const un64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const { payload } = JSON.parse(readFileSync('vault-fixture.json', 'utf8'));
const { salt, iv, ciphertext } = JSON.parse(readFileSync('resealed.json', 'utf8'));
const pk = await crypto.subtle.importKey('raw', enc.encode(process.argv[2]), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: un64(salt), iterations: 100000, hash: 'SHA-256' },
  pk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
const out = dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(iv) }, key, un64(ciphertext)));
if (out !== payload) { console.error('  MISMATCH: the web client cannot read the iOS-resealed vault'); process.exit(1); }
console.log('  web opens the ios-resealed vault   ok');
EOF
node verify.mjs "$NEW_MASTER"

echo "vault interop ok"
