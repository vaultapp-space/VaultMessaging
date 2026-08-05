import CommonCrypto
import CryptoKit
import Foundation

/// Opening and resealing the encrypted identity vault.
///
/// The vault holds the account's private keys, ratchet sessions and group
/// sender keys, sealed under a key stretched from the master key. This app
/// cannot *use* any of that yet — the Double Ratchet lives in the web client —
/// but it has to be able to move it from one password to another, because a
/// password change that leaves the vault sealed under the old key produces an
/// account that logs in perfectly and can never read a secret chat again.
///
/// So this deliberately treats the contents as opaque bytes: decrypt, re-encrypt,
/// never parse. Nothing here needs to understand a JWK, and anything that tried
/// would be a second place for the two clients' key formats to drift apart.
///
/// Format, from `encryptIdentityVault` in `client/src/lib/crypto/keys.js`:
///
///     JSON { salt, iv, ciphertext }  — all base64
///     key = PBKDF2-HMAC-SHA256(masterKeyBase64, salt, 100_000, 256 bits)
///     AES-256-GCM, 12-byte IV, 16-byte tag appended to the ciphertext
///
/// Note the iteration count is 100,000 here and 600,000 for the master key.
/// They are different derivations with different inputs; do not "harmonise" them.
enum IdentityVault {

    private static let iterations: UInt32 = 100_000
    private static let keyLength = 32

    enum Failure: Error, LocalizedError {
        case malformed
        case wrongPassword

        var errorDescription: String? {
            switch self {
            case .malformed:
                return "Your encrypted keys are stored in a format this app does not recognise."
            case .wrongPassword:
                return "That password did not unlock your encrypted keys."
            }
        }
    }

    private struct Envelope: Codable {
        let salt: String
        let iv: String
        let ciphertext: String
    }

    /// Decrypts the vault to its raw payload bytes. The payload is JSON, but
    /// nothing here looks inside it.
    static func open(_ encryptedJSON: String, masterKeyBase64: String) throws -> Data {
        guard
            let data = encryptedJSON.data(using: .utf8),
            let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
            let salt = Data(base64Encoded: envelope.salt),
            let iv = Data(base64Encoded: envelope.iv),
            let ciphertext = Data(base64Encoded: envelope.ciphertext)
        else { throw Failure.malformed }

        let key = try derive(masterKeyBase64: masterKeyBase64, salt: salt)

        // WebCrypto appends the 16-byte GCM tag to the ciphertext; CryptoKit
        // wants it separately.
        guard ciphertext.count > 16 else { throw Failure.malformed }
        let tag = ciphertext.suffix(16)
        let body = ciphertext.prefix(ciphertext.count - 16)

        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: iv), ciphertext: body, tag: tag
            )
            return try AES.GCM.open(box, using: key)
        } catch {
            // GCM authentication failing is not an error the user can act on
            // as such — it means the key was wrong, which means the password was.
            throw Failure.wrongPassword
        }
    }

    /// Reseals a payload under a different master key, with a fresh salt and
    /// nonce. Produces exactly the JSON the web client expects to read back.
    static func seal(_ payload: Data, masterKeyBase64: String) throws -> String {
        var saltBytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, saltBytes.count, &saltBytes)
        let salt = Data(saltBytes)

        let key = try derive(masterKeyBase64: masterKeyBase64, salt: salt)
        let nonce = AES.GCM.Nonce()
        let box = try AES.GCM.seal(payload, using: key, nonce: nonce)

        let envelope = Envelope(
            salt: salt.base64EncodedString(),
            iv: Data(nonce).base64EncodedString(),
            // Tag appended, matching WebCrypto's single-buffer output.
            ciphertext: (box.ciphertext + box.tag).base64EncodedString()
        )
        let encoded = try JSONEncoder().encode(envelope)
        guard let json = String(data: encoded, encoding: .utf8) else { throw Failure.malformed }
        return json
    }

    /// Open under one key and reseal under another, in one step.
    static func rekey(
        _ encryptedJSON: String, from oldMasterKeyBase64: String, to newMasterKeyBase64: String
    ) throws -> String {
        let payload = try open(encryptedJSON, masterKeyBase64: oldMasterKeyBase64)
        return try seal(payload, masterKeyBase64: newMasterKeyBase64)
    }

    // MARK: - Plumbing

    /// The passphrase is the base64 *text* of the master key, not its bytes —
    /// that is what the web client passes, and PBKDF2 over the decoded bytes
    /// would produce a different key that fails only at the GCM tag check.
    private static func derive(masterKeyBase64: String, salt: Data) throws -> SymmetricKey {
        var derived = [UInt8](repeating: 0, count: keyLength)

        let status = salt.withUnsafeBytes { saltBuffer -> Int32 in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                masterKeyBase64, Array(masterKeyBase64.utf8).count,
                saltBuffer.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                iterations,
                &derived, derived.count
            )
        }

        guard status == kCCSuccess else { throw Failure.malformed }
        return SymmetricKey(data: Data(derived))
    }
}
