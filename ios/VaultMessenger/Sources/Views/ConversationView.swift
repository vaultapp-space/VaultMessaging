import SwiftUI

struct ConversationView: View {
    let chat: Chat
    @EnvironmentObject private var state: AppState
    @State private var draft = ""

    private var messages: [Message] { state.messagesByChat[chat.id] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(messages) { message in
                            MessageBubble(message: message, isOwn: message.senderId == state.user?.id)
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .onChange(of: messages.count) {
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            .overlay {
                if messages.isEmpty {
                    // Distinguishes "expired" from "never used" — the chat
                    // list already knows which, so the copy follows it.
                    ContentUnavailableView(
                        chat.isEmpty ? "Messages expired" : "No messages yet",
                        systemImage: "clock.arrow.circlepath",
                        description: Text(chat.isEmpty
                            ? "Everything here was deleted after 24 hours."
                            : "Say something to start.")
                    )
                }
            }

            Divider()

            HStack(spacing: 8) {
                TextField("Message", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18))

                Button {
                    let text = draft
                    draft = ""
                    Task { await state.send(text, to: chat) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(10)

            Text("Deleted after 24 hours")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 6)
        }
        .navigationTitle(chat.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await state.loadMessages(for: chat) }
    }
}

private struct MessageBubble: View {
    let message: Message
    let isOwn: Bool

    var body: some View {
        HStack {
            if isOwn { Spacer(minLength: 40) }

            VStack(alignment: isOwn ? .trailing : .leading, spacing: 3) {
                Text(message.body ?? "Encrypted message")
                    .font(.body)
                    .foregroundStyle(message.body == nil ? .secondary : .primary)
                    .italic(message.body == nil)

                if let sentAt = message.sentAt {
                    Text(sentAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(
                isOwn ? AnyShapeStyle(.tint.opacity(0.18)) : AnyShapeStyle(.quaternary.opacity(0.5)),
                in: RoundedRectangle(cornerRadius: 16)
            )

            if !isOwn { Spacer(minLength: 40) }
        }
    }
}
