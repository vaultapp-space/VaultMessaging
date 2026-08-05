import SwiftUI

/// The first screen, before sign-in.
///
/// Launching straight into a username field asks someone to authenticate to a
/// thing they have not been told anything about — and the things worth telling
/// them are exactly the ones that make this app different from the messenger
/// they already have. So: the mark, one sentence, three claims, one button.
///
/// The claims are load-bearing rather than marketing. "24-hour auto-delete" in
/// particular is the property people are most surprised by later; saying it
/// here is cheaper than the support question, and honest about what they are
/// signing up for.
struct WelcomeView: View {
    @Environment(\.colorScheme) private var scheme
    let onContinue: () -> Void

    /// Deliberately gentle and one-shot. A login screen is not the place for
    /// motion that keeps drawing the eye.
    @State private var appeared = false

    var body: some View {
        ZStack {
            background

            VStack(spacing: 0) {
                Spacer(minLength: 24)

                mark
                    .opacity(appeared ? 1 : 0)
                    .scaleEffect(appeared ? 1 : 0.92)

                Text("Vault")
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))
                    .padding(.top, 20)

                Text("Messages that do not stay behind.")
                    .font(.system(size: 15))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
                    .padding(.horizontal, 32)

                VStack(spacing: 10) {
                    claim(
                        icon: "lock.fill",
                        title: "End-to-end encrypted",
                        detail: "One-to-one chats are sealed on your device. Nobody else can read them — including us."
                    )
                    claim(
                        icon: "clock.arrow.circlepath",
                        title: "Everything deletes in 24 hours",
                        detail: "Every message, on every device. Not a setting, and not a tier."
                    )
                    claim(
                        icon: "person.crop.circle.badge.xmark",
                        title: "No phone number, no email",
                        detail: "An account is a username and a password. There is nothing else to leak."
                    )
                }
                .padding(.top, 30)
                .padding(.horizontal, 22)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 12)

                Spacer(minLength: 24)

                VStack(spacing: 12) {
                    Button(action: onContinue) {
                        HStack(spacing: 7) {
                            Text("Start messaging")
                                .font(.system(size: 16, weight: .semibold))
                            Image(systemName: "arrow.right")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(
                            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                .fill(Vault.Palette.accent(scheme))
                        )
                        .foregroundStyle(Vault.Palette.black(scheme))
                    }
                    .accessibilityIdentifier("start-messaging")

                    Text("New accounts are created on vaultapp.space")
                        .font(.system(size: 11))
                        .foregroundStyle(Vault.Palette.muted(scheme))
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 22)
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) { appeared = true }
        }
    }

    // MARK: - Pieces

    /// A single soft wash of the accent behind the mark. The web landing has a
    /// gradient here; a flat black screen with a logo on it reads as a splash
    /// that failed to load.
    private var background: some View {
        ZStack {
            Vault.Palette.black(scheme).ignoresSafeArea()
            RadialGradient(
                colors: [Vault.Palette.accent(scheme).opacity(scheme == .dark ? 0.16 : 0.10), .clear],
                center: .init(x: 0.5, y: 0.22),
                startRadius: 0, endRadius: 420
            )
            .ignoresSafeArea()
        }
    }

    private var mark: some View {
        VaultShield(lineWidth: 1.8, color: Vault.Palette.text(scheme))
            .frame(width: 60, height: 60)
            .padding(22)
            .background(
                RoundedRectangle(cornerRadius: 28)
                    .fill(Vault.Palette.surface(scheme))
                    .overlay(
                        RoundedRectangle(cornerRadius: 28)
                            .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                    )
                    .shadow(color: Vault.Palette.accent(scheme).opacity(0.18), radius: 30, y: 8)
            )
    }

    private func claim(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(Vault.Palette.accent(scheme))
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: Vault.Radius.xl)
                .fill(Vault.Palette.surface(scheme).opacity(0.75))
                .overlay(
                    RoundedRectangle(cornerRadius: Vault.Radius.xl)
                        .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                )
        )
    }
}
