import SwiftUI

/// The conversation, styled like the web client's: a header carrying the
/// mode, bubbles in accent-tinted / elevated surfaces, and the retention
/// line under the composer.
struct ConversationView: View {
    let chat: Chat
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    private var messages: [Message] { state.messagesByChat[chat.id] ?? [] }

    var body: some View {
        ZStack {
            Vault.Palette.black(scheme).ignoresSafeArea()

            VStack(spacing: 0) {
                header
                transcript
                composer
            }
        }
        .navigationBarBackButtonHidden(true)
        .task { await state.loadMessages(for: chat) }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
            }
            .accessibilityLabel("Back")

            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                .fill(Vault.avatarGradient(for: chat.displayName))
                .frame(width: 36, height: 36)
                .overlay {
                    Text(String(chat.displayName.prefix(1)).uppercased())
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 1) {
                Text(chat.displayName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))
                HStack(spacing: 4) {
                    Image(systemName: chat.mode == .cloud ? "cloud" : "lock.fill")
                        .font(.system(size: 8))
                    Text(chat.mode == .cloud
                         ? "Cloud chat · syncs across devices"
                         : "End-to-end encrypted")
                        .font(.system(size: 10))
                }
                .foregroundStyle(Vault.Palette.textDim(scheme))
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Vault.Palette.surface(scheme).opacity(0.6)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Vault.Palette.border(scheme)).frame(height: 1)
                }
        )
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(messages) { message in
                        Bubble(message: message, isOwn: message.senderId == state.user?.id)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
            }
            .onChange(of: messages.count) {
                if let last = messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .overlay {
                if messages.isEmpty { emptyState }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            RoundedRectangle(cornerRadius: Vault.Radius.xl)
                .fill(Vault.Palette.elevated(scheme))
                .frame(width: 46, height: 46)
                .overlay {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 18, weight: .light))
                        .foregroundStyle(Vault.Palette.muted(scheme))
                }
            // "Expired" and "never used" are different things and the chat
            // list already knows which, so the copy follows it.
            Text(chat.isEmpty ? "Messages expired" : "Start a secure conversation")
                .font(.system(size: 13))
                .foregroundStyle(Vault.Palette.textDim(scheme))
            Text(chat.isEmpty
                 ? "Everything here was deleted after 24 hours."
                 : "Messages are deleted 24 hours after they are sent.")
                .font(.system(size: 11))
                .foregroundStyle(Vault.Palette.muted(scheme))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                TextField("", text: $draft, prompt:
                    Text("Type a message...").foregroundColor(Vault.Palette.muted(scheme)),
                    axis: .vertical)
                    .font(.system(size: 15))
                    .foregroundStyle(Vault.Palette.text(scheme))
                    .lineLimit(1...5)
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .background(
                        RoundedRectangle(cornerRadius: Vault.Radius.xl)
                            .fill(Vault.Palette.elevated(scheme))
                            .overlay(
                                RoundedRectangle(cornerRadius: Vault.Radius.xl)
                                    .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                            )
                    )

                Button {
                    let text = draft
                    draft = ""
                    Task { await state.send(text, to: chat) }
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(Vault.Palette.black(scheme))
                        .frame(width: 40, height: 40)
                        .background(
                            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                .fill(Vault.Palette.accent(scheme))
                        )
                }
                .accessibilityLabel("Send")
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)

            // The claim has to match the chat. Saying "end-to-end encrypted"
            // under a cloud chat, which the server can read, is the one piece
            // of copy in the app that would be a lie.
            HStack(spacing: 4) {
                Image(systemName: chat.mode == .secret ? "lock.fill" : "cloud.fill")
                    .font(.system(size: 8))
                Text(chat.mode == .secret
                     ? "End-to-end encrypted · Auto-deletes in 24h"
                     : "Stored on the server · Auto-deletes in 24h")
                    .font(.system(size: 10))
            }
            .foregroundStyle(Vault.Palette.textDim(scheme))
            .padding(.bottom, 8)
        }
        .background(
            Vault.Palette.surface(scheme).opacity(0.6)
                .overlay(alignment: .top) {
                    Rectangle().fill(Vault.Palette.border(scheme)).frame(height: 1)
                }
        )
    }
}

private struct Bubble: View {
    let message: Message
    let isOwn: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack {
            if isOwn { Spacer(minLength: 50) }

            VStack(alignment: .trailing, spacing: 3) {
                Text(message.body ?? "Encrypted message")
                    .font(.system(size: 15))
                    .foregroundStyle(message.body == nil
                                     ? Vault.Palette.textDim(scheme)
                                     : Vault.Palette.text(scheme))
                    .italic(message.body == nil)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let sentAt = message.sentAt {
                    Text(sentAt, style: .time)
                        .font(.system(size: 9))
                        .foregroundStyle(Vault.Palette.textDim(scheme).opacity(0.7))
                }
            }
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: Vault.Radius.xxl)
                    .fill(isOwn
                          ? Vault.Palette.accent(scheme).opacity(0.15)
                          : Vault.Palette.elevated(scheme))
                    .overlay(
                        RoundedRectangle(cornerRadius: Vault.Radius.xxl)
                            .stroke(isOwn
                                    ? Vault.Palette.accent(scheme).opacity(0.25)
                                    : Vault.Palette.border(scheme),
                                    lineWidth: 1)
                    )
            )
            .fixedSize(horizontal: false, vertical: true)

            if !isOwn { Spacer(minLength: 50) }
        }
    }
}
