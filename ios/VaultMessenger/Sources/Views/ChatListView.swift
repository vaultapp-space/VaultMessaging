import SwiftUI

struct ChatListView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        NavigationStack {
            List {
                ForEach(state.chats) { chat in
                    if chat.isReadable {
                        NavigationLink(value: chat) {
                            ChatRow(chat: chat)
                        }
                    } else {
                        // Not a link: tapping through to an empty screen is
                        // worse than not offering the tap. The row still
                        // appears so the conversation does not seem missing.
                        ChatRow(chat: chat)
                    }
                }
            }
            .navigationDestination(for: Chat.self) { ConversationView(chat: $0) }
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Sign out", role: .destructive) {
                            Task { await state.signOut() }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .refreshable { await state.refreshChats() }
            .overlay {
                if state.chats.isEmpty {
                    ContentUnavailableView(
                        "No conversations",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start one on vaultapp.space and it will appear here.")
                    )
                }
            }
        }
    }
}

private struct ChatRow: View {
    let chat: Chat

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(.tint.opacity(0.15))
                .frame(width: 42, height: 42)
                .overlay {
                    Text(String(chat.displayName.prefix(1)).uppercased())
                        .font(.headline)
                        .foregroundStyle(.tint)
                }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(chat.displayName).font(.body.weight(.medium)).lineLimit(1)
                    if chat.mode == .secret {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("End-to-end encrypted")
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if chat.unreadCount > 0 {
                Text("\(min(chat.unreadCount, 99))")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(.tint, in: Capsule())
                    .foregroundStyle(.white)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        if chat.mode == .secret {
            // The honest version. A blank row would read as a broken app;
            // "no messages" would be a lie about a conversation this client
            // simply cannot decrypt.
            return "Encrypted — open on the web to read"
        }
        if chat.isEmpty {
            // Chats outlive their messages, so this is expiry, not emptiness.
            return "Messages expired"
        }
        return chat.type == .group ? "Group" : "Cloud chat"
    }
}
