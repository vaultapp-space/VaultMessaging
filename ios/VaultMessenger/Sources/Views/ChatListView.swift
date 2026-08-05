import SwiftUI

/// The web client's sidebar, as a full screen: shield + wordmark + connection
/// line in the header, then the conversation rows.
struct ChatListView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            ZStack {
                Vault.Palette.black(scheme).ignoresSafeArea()

                VStack(spacing: 0) {
                    header

                    if state.chats.isEmpty {
                        emptyState
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                ForEach(state.chats) { chat in
                                    row(for: chat)
                                }
                            }
                            .padding(.horizontal, 8)
                            .padding(.top, 6)
                        }
                        .refreshable { await state.refreshChats() }
                    }
                }
            }
            .navigationBarHidden(true)
            .navigationDestination(for: Chat.self) {
                ConversationView(chat: $0)
                    // A conversation is a full-screen context; leaving the tab
                    // bar under it wastes a row and invites a tap that throws
                    // away what you were typing.
                    .toolbar(.hidden, for: .tabBar)
            }
        }
        .tint(Vault.Palette.accent(scheme))
    }

    private var header: some View {
        HStack(spacing: 10) {
            VaultShield(lineWidth: 1.8, color: Vault.Palette.text(scheme))
                .frame(width: 17, height: 17)
                .padding(7)
                .background(
                    RoundedRectangle(cornerRadius: Vault.Radius.lg)
                        .fill(Vault.Palette.surface(scheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                .stroke(Vault.Palette.border(scheme).opacity(0.5), lineWidth: 1)
                        )
                )

            VStack(alignment: .leading, spacing: 1) {
                Text("Vault")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))
                // Connected is the normal case and says nothing; what matters
                // is being told when it is not.
                if state.socket.isConnected {
                    Text("End-to-end encrypted")
                        .font(.system(size: 10))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                } else {
                    HStack(spacing: 4) {
                        Circle().fill(Vault.Palette.warning).frame(width: 5, height: 5)
                        Text("Reconnecting…")
                            .font(.system(size: 10))
                            .foregroundStyle(Vault.Palette.warning)
                    }
                }
            }

            Spacer()

            Menu {
                Button("Sign out", role: .destructive) {
                    Task { await state.signOut() }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
                    .frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            Vault.Palette.surface(scheme).opacity(0.6)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Vault.Palette.border(scheme)).frame(height: 1)
                }
        )
    }

    @ViewBuilder
    private func row(for chat: Chat) -> some View {
        if chat.isReadable {
            NavigationLink(value: chat) { ChatRow(chat: chat) }
                .buttonStyle(.plain)
                // The list is a ScrollView, not a List, so there are no cells
                // for a UI test to find — this is how it identifies a row.
                .accessibilityIdentifier("chat-row")
        } else {
            // Not a link: tapping through to a screen this client cannot
            // decrypt is worse than not offering the tap.
            ChatRow(chat: chat)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            RoundedRectangle(cornerRadius: Vault.Radius.xl)
                .fill(Vault.Palette.elevated(scheme))
                .frame(width: 48, height: 48)
                .overlay {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 20, weight: .light))
                        .foregroundStyle(Vault.Palette.muted(scheme))
                }
            Text("No conversations yet")
                .font(.system(size: 13))
                .foregroundStyle(Vault.Palette.textDim(scheme))
            Text("Start one on vaultapp.space and it appears here")
                .font(.system(size: 11))
                .foregroundStyle(Vault.Palette.muted(scheme))
            Spacer()
        }
    }
}

private struct ChatRow: View {
    let chat: Chat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                .fill(Vault.avatarGradient(for: chat.displayName))
                .frame(width: 40, height: 40)
                .overlay {
                    Text(String(chat.displayName.prefix(1)).uppercased())
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(chat.displayName)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Vault.Palette.text(scheme))
                        .lineLimit(1)
                    // The exception is marked, not the rule: one-to-one chats
                    // are encrypted by default, so a lock on nearly every row
                    // would carry no information.
                    if chat.mode == .cloud && chat.type == .privateChat {
                        Image(systemName: "cloud")
                            .font(.system(size: 9))
                            .foregroundStyle(Vault.Palette.textDim(scheme))
                    }
                }
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
                    .lineLimit(1)
            }

            Spacer()

            if chat.unreadCount > 0 {
                Text("\(min(chat.unreadCount, 99))")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Vault.Palette.black(scheme))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Vault.Palette.accent(scheme)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: Vault.Radius.xl)
                .fill(Color.clear)
        )
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        if chat.mode == .secret {
            // Honest rather than blank: this client cannot decrypt it, which
            // is different from there being nothing to show.
            return "Encrypted — open on the web to read"
        }
        // Chats outlive their messages, so an empty one has expired rather
        // than never been used.
        if chat.isEmpty { return "Messages expired" }
        return chat.type == .group ? "Group" : "Cloud chat"
    }
}
