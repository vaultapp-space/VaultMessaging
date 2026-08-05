import CommonCrypto
import CryptoKit
import Foundation

/// Password-to-credential derivation.
///
/// **This has to match `client/src/lib/crypto/keys.js` exactly.** The real
/// password never leaves the device on either platform: what the server sees
/// is a one-way derivation of it, so if iOS derives the value differently the
/// server simply rejects the login with no clue as to why. There is no
/// negotiation and no error message that would point here — a single wrong
/// iteration count looks identical to a wrong password.
///
/// The web implementation, for reference:
///
///     masterKeyBits = PBKDF2-HMAC-SHA256(password, salt, 600_000, 256 bits)
///     authSecret    = base64(HMAC-SHA256(masterKeyBits, "vault-server-auth-v1"))
///
/// `CryptoKit` has no PBKDF2, hence CommonCrypto for that step only.
enum KeyDerivation {

    /// The label the HMAC is taken over. Domain separation: the same master
    /// key also derives the vault key and the history key, and those must
    /// never collide with the value handed to the server.
    private static let serverAuthLabel = "vault-server-auth-v1"

    private static let iterations: UInt32 = 600_000
    private static let derivedKeyLength = 32   // 256 bits

    enum Failure: Error, LocalizedError {
        case badSalt
        case derivationFailed

        var errorDescription: String? {
            switch self {
            case .badSalt: return "The server returned a salt that could not be decoded."
            case .derivationFailed: return "Could not derive a key from that password."
            }
        }
    }

    /// The root secret everything else hangs off. Never sent anywhere.
    ///
    /// 600,000 iterations is deliberate and takes a noticeable moment on a
    /// phone — call it off the main thread.
    static func masterKeyBits(password: String, saltBase64: String) throws -> Data {
        guard let salt = Data(base64Encoded: saltBase64) else { throw Failure.badSalt }

        let passwordBytes = Array(password.utf8)
        var derived = [UInt8](repeating: 0, count: derivedKeyLength)

        let status = salt.withUnsafeBytes { saltBuffer -> Int32 in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                password, passwordBytes.count,
                saltBuffer.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                iterations,
                &derived, derived.count
            )
        }

        guard status == kCCSuccess else { throw Failure.derivationFailed }
        return Data(derived)
    }

    /// What is actually sent as the "password" field.
    ///
    /// One-way: the server, and anyone who takes a copy of its database,
    /// only ever holds this. It cannot be turned back into the master key, so
    /// it cannot decrypt the vault or anything else derived from it.
    static func serverAuthSecret(masterKeyBits: Data) -> String {
        let key = SymmetricKey(data: masterKeyBits)
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(serverAuthLabel.utf8), using: key
        )
        return Data(mac).base64EncodedString()
    }

    /// Both steps, as the login flow uses them.
    static func loginCredential(password: String, saltBase64: String) throws -> String {
        let master = try masterKeyBits(password: password, saltBase64: saltBase64)
        return serverAuthSecret(masterKeyBits: master)
    }
}
