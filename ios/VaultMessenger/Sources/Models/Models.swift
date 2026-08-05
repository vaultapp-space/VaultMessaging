import Foundation

/// Which guarantees a conversation carries.
///
/// The distinction is the whole product, so it is an enum rather than a
/// string: `cloud` means the server can read the messages (and therefore
/// search, sync and unfurl them), `secret` means it holds only ciphertext.
/// An unrecognised value decodes as `.secret`, the more restrictive of the
/// two — a bug can then only ever hide a conversation, never show plaintext
/// the user believed was encrypted.
enum ChatMode: String, Codable {
    case cloud
    case secret

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ChatMode(rawValue: raw) ?? .secret
    }
}

enum ChatKind: String, Codable {
    case privateChat = "private"
    case group
    case channel
    case saved

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ChatKind(rawValue: raw) ?? .privateChat
    }
}

struct Chat: Identifiable, Codable, Hashable {
    let id: String
    let type: ChatKind
    let mode: ChatMode
    let title: String?
    let peerId: String?
    let peerUsername: String?
    let unreadCount: Int
    let lastMessageAt: Date?
    /// True when the conversation has outlived its messages. Chats are
    /// durable, their contents are not — so this is "everything expired",
    /// not "nothing was ever sent", and the UI must not conflate them.
    let isEmpty: Bool

    var displayName: String {
        title ?? peerUsername ?? "Conversation"
    }

    /// Cloud chats are the ones this app can actually read. Secret chats are
    /// listed so they do not silently vanish, but their contents need the
    /// ratchet, which lives only in the web client for now.
    var isReadable: Bool { mode == .cloud }
}

struct Message: Identifiable, Codable, Equatable {
    let id: String
    let chatId: String?
    let seq: Int?
    let senderId: String?
    let senderUsername: String?
    let body: String?
    let sentAt: Date?
    let expiresAt: Date?
    let mode: ChatMode?

    /// Present only on secret messages, and unreadable here.
    let ciphertext: String?

    var isEncrypted: Bool { (ciphertext?.isEmpty == false) && (body?.isEmpty != false) }
}

struct CurrentUser: Codable, Equatable {
    let id: String
    let username: String
    let deviceId: String?
}

// MARK: - Wire envelopes

struct ChatListResponse: Codable { let chats: [Chat] }

struct MessagesResponse: Codable {
    let messages: [Message]
    let hasMore: Bool
    /// The server states the retention window rather than letting the client
    /// assume one, so "why is this empty" is answerable without guessing.
    let retentionSeconds: Int?
}

struct SaltResponse: Codable { let salt: String }

struct SentMessage: Codable {
    let id: String
    let chatId: String
    let seq: Int
    let body: String?
    let sentAt: Date?
}
