import Foundation
import SwiftUI

/// Everything the views read from.
///
/// One observable object rather than a store per screen: the app is small,
/// and a chat list that disagrees with the open conversation about whether a
/// message arrived is a worse problem than a slightly broad object.
@MainActor
final class AppState: ObservableObject {

    // Where the server lives. The simulator reaches a machine-local server on
    // localhost; a device build points at production.
    nonisolated static let defaultServer: URL = {
        #if targetEnvironment(simulator)
        return URL(string: "http://127.0.0.1:3001")!
        #else
        return URL(string: "https://vaultapp.space")!
        #endif
    }()

    @Published var user: CurrentUser?
    @Published var chats: [Chat] = []
    @Published var messagesByChat: [String: [Message]] = [:]
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var retentionNotice: String?
    @Published var devices: [Device] = []
    /// nil follows the system; the web client has an explicit toggle and
    /// people expect the same control here.
    @AppStorage("appearance") var appearancePreference: String = "system"

    let api: APIClient
    let socket: SocketClient

    private var knownMessageIds = Set<String>()

    init(baseURL: URL = AppState.defaultServer) {
        self.api = APIClient(baseURL: baseURL)
        self.socket = SocketClient(baseURL: baseURL)
        socket.onEvent = { [weak self] type, payload in
            self?.handleSocketEvent(type: type, payload: payload)
        }
    }

    var isSignedIn: Bool { user != nil }

    // MARK: - Session

    /// Restores a session on launch if the cookie is still good.
    func restoreSession() async {
        do {
            user = try await api.currentUser()
            socket.connect()
            await refreshChats()
        } catch {
            // Not an error worth showing: "not signed in" is the ordinary
            // state for a first launch.
            user = nil
        }
    }

    func signIn(username: String, password: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            user = try await api.logIn(username: username, password: password)
            socket.connect()
            await refreshChats()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not sign in."
        }
    }

    func signOut() async {
        socket.disconnect()
        try? await api.logOut()
        user = nil
        chats = []
        messagesByChat = [:]
        knownMessageIds.removeAll()
    }

    // MARK: - Chats

    func refreshChats() async {
        do {
            chats = try await api.chats()
        } catch APIClient.Failure.unauthorized {
            await signOut()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not load your chats."
        }
    }

    func loadMessages(for chat: Chat) async {
        // Secret chats need the Double Ratchet, which is not on iOS yet.
        // Fetching them would return ciphertext this app cannot read and
        // render as an empty conversation, which looks like data loss.
        guard chat.isReadable else { return }

        do {
            let response = try await api.messages(chatId: chat.id)
            for message in response.messages { knownMessageIds.insert(message.id) }
            messagesByChat[chat.id] = response.messages

            if let seconds = response.retentionSeconds {
                retentionNotice = "Messages are deleted after \(seconds / 3600) hours."
            }
            if let last = response.messages.last?.seq {
                try? await api.markRead(chatId: chat.id, upTo: last)
                clearUnread(for: chat.id)
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not load this conversation."
        }
    }

    func send(_ text: String, to chat: Chat) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, chat.isReadable else { return }

        do {
            let sent = try await api.send(chatId: chat.id, body: trimmed)
            // The socket echoes this back to every member including the
            // sender, so it is inserted here and deduplicated by id — without
            // that, a fast echo shows the message twice.
            insert(Message(
                id: sent.id, chatId: chat.id, seq: sent.seq,
                senderId: user?.id, senderUsername: user?.username,
                body: sent.body, sentAt: sent.sentAt ?? Date(),
                expiresAt: nil, mode: .cloud, ciphertext: nil
            ))
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not send that message."
        }
    }

    // MARK: - Devices

    func refreshDevices() async {
        do {
            devices = try await api.devices()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not load your sessions."
        }
    }

    func revoke(_ device: Device) async {
        // Signing out the device you are holding is just a logout, and
        // offering it in a list of others is how someone does it by accident.
        guard !device.current else { return }
        do {
            try await api.revokeDevice(id: device.id)
            devices.removeAll { $0.id == device.id }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Could not sign that device out."
        }
    }

    // MARK: - Password

    /// Changes the account password, then refreshes the session so the app is
    /// holding the new salt and resealed vault rather than the ones it started
    /// with.
    ///
    /// - Returns: how many other devices were signed out.
    func changePassword(current: String, new: String) async throws -> Int {
        guard let user else { throw APIClient.Failure.unauthorized }

        let revoked = try await api.changePassword(
            username: user.username,
            currentPassword: current,
            newPassword: new,
            encryptedVault: user.encryptedVault
        )

        self.user = try? await api.currentUser()
        await refreshDevices()
        return revoked
    }

    // MARK: - Live updates

    private func handleSocketEvent(type: String, payload: [String: Any]) {
        switch type {
        case "message":
            guard
                let id = payload["id"] as? String,
                let chatId = payload["chatId"] as? String
            else { return }

            insert(Message(
                id: id,
                chatId: chatId,
                seq: payload["seq"] as? Int,
                senderId: payload["senderId"] as? String,
                senderUsername: payload["senderUsername"] as? String,
                body: payload["body"] as? String,
                sentAt: Date(),
                expiresAt: nil,
                mode: (payload["mode"] as? String) == "secret" ? .secret : .cloud,
                ciphertext: payload["ciphertext"] as? String
            ))
            Task { await refreshChats() }

        case "group_updated", "group_removed", "channel_post":
            Task { await refreshChats() }

        default:
            break
        }
    }

    private func insert(_ message: Message) {
        guard let chatId = message.chatId else { return }
        // Deduplicated by id because the same message can arrive twice: once
        // from the send response and once from the socket echo, whichever
        // wins the race.
        guard !knownMessageIds.contains(message.id) else { return }
        knownMessageIds.insert(message.id)

        var existing = messagesByChat[chatId] ?? []
        existing.append(message)
        existing.sort { ($0.seq ?? 0) < ($1.seq ?? 0) }
        messagesByChat[chatId] = existing
    }

    private func clearUnread(for chatId: String) {
        guard let index = chats.firstIndex(where: { $0.id == chatId }), chats[index].unreadCount > 0
        else { return }
        let c = chats[index]
        chats[index] = Chat(
            id: c.id, type: c.type, mode: c.mode, title: c.title,
            peerId: c.peerId, peerUsername: c.peerUsername,
            unreadCount: 0, lastMessageAt: c.lastMessageAt, isEmpty: c.isEmpty
        )
    }
}
