import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme
    @State private var confirmingSignOut = false

    var body: some View {
        VaultScreen(title: "Profile") {
            VStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 22)
                    .fill(Vault.avatarGradient(for: state.user?.username))
                    .frame(width: 76, height: 76)
                    .overlay {
                        Text(String((state.user?.username ?? "?").prefix(1)).uppercased())
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(.white)
                    }

                Text(state.user?.username ?? "—")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))

                HStack(spacing: 5) {
                    Circle()
                        .fill(state.socket.isConnected
                              ? Vault.Palette.accent(scheme) : Vault.Palette.warning)
                        .frame(width: 6, height: 6)
                    Text(state.socket.isConnected ? "Connected" : "Reconnecting…")
                        .font(.system(size: 11))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)

            VaultSection(
                title: "Account",
                footnote: "Vault holds no email, phone number or real name — an account is a username and a password, and nothing else."
            ) {
                VaultRow(title: "Username", icon: "at") {
                    Text(state.user?.username ?? "—")
                        .font(.system(size: 13))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                }
                VaultDivider()
                VaultRow(title: "This device", icon: "iphone") {
                    Text(thisDevice)
                        .font(.system(size: 13))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                }
            }

            VaultSection(
                title: "Password",
                footnote: "Your password never leaves this device. The server only ever receives a one-way derivation of it, so it cannot be reversed — which also means a forgotten password cannot be recovered."
            ) {
                VaultRow(
                    title: "There is no password recovery",
                    subtitle: "Lose it and the account is gone",
                    icon: "exclamationmark.triangle",
                    tint: Vault.Palette.warning
                )
            }

            VaultSection(title: "Session") {
                Button {
                    confirmingSignOut = true
                } label: {
                    VaultRow(
                        title: "Sign out",
                        icon: "rectangle.portrait.and.arrow.right",
                        tint: Vault.Palette.danger
                    )
                }
            }
        }
        .confirmationDialog(
            "Sign out of Vault?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task { await state.signOut() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("You will need your password to sign back in, and it cannot be reset.")
        }
    }

    private var thisDevice: String {
        #if targetEnvironment(simulator)
        return "iOS Simulator"
        #else
        return UIDevice.current.model
        #endif
    }
}
