import SwiftUI

/// Mirrors the web client's unlock screen: shield mark, wordmark, the
/// "End-to-end encrypted messaging" line, then the form.
///
/// Sign-in only, deliberately. Registering generates the identity key, signed
/// prekey and one-time prekeys other people use to start an encrypted
/// conversation with you; this app cannot hold up that side yet, so an account
/// created here would look fine and then fail for anyone who messaged it
/// privately.
struct SignInView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme

    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        ZStack {
            Vault.Palette.black(scheme).ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                VaultShield(lineWidth: 1.6, color: Vault.Palette.text(scheme))
                    .frame(width: 40, height: 40)
                    .padding(14)
                    .background(
                        RoundedRectangle(cornerRadius: Vault.Radius.xl)
                            .fill(Vault.Palette.surface(scheme))
                            .overlay(
                                RoundedRectangle(cornerRadius: Vault.Radius.xl)
                                    .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                            )
                    )

                Text("Vault")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Vault.Palette.text(scheme))
                    .padding(.top, 14)

                Text("End-to-end encrypted messaging")
                    .font(.system(size: 13))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
                    .padding(.top, 4)

                // The card, as on the web: a surface panel with a subtle
                // border rather than free-floating fields.
                VStack(spacing: 14) {
                    HStack(spacing: 6) {
                        Circle().fill(Vault.Palette.accent(scheme)).frame(width: 6, height: 6)
                        Text("ENCRYPTED SESSION")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(Vault.Palette.accent(scheme))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Capsule().fill(Vault.Palette.accent(scheme).opacity(0.12)))

                    field(label: "USERNAME") {
                        TextField("", text: $username, prompt: prompt("Enter username"))
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .username)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                            // Explicit rather than inferred from the "USERNAME"
                            // label above it. SwiftUI's inference changed when
                            // this screen gained a transition, and a UI test
                            // that cannot find the field looks exactly like a
                            // rejected password.
                            .accessibilityIdentifier("Username")
                    }

                    field(label: "PASSWORD") {
                        SecureField("", text: $password, prompt: prompt("Enter password"))
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit(submit)
                            .accessibilityIdentifier("Password")
                    }

                    if let error = state.errorMessage {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(Vault.Palette.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button(action: submit) {
                        Group {
                            if state.isLoading {
                                ProgressView().tint(Vault.Palette.black(scheme))
                            } else {
                                Text("Unlock Vault").font(.system(size: 15, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(
                            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                .fill(Vault.Palette.accent(scheme))
                        )
                        .foregroundStyle(Vault.Palette.black(scheme))
                    }
                    .disabled(state.isLoading || username.isEmpty || password.isEmpty)
                    .opacity(username.isEmpty || password.isEmpty ? 0.5 : 1)

                    Text("New accounts are created on vaultapp.space")
                        .font(.system(size: 11))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                }
                .padding(20)
                .background(
                    RoundedRectangle(cornerRadius: Vault.Radius.xxl)
                        .fill(Vault.Palette.surface(scheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: Vault.Radius.xxl)
                                .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                        )
                )
                .padding(.top, 28)
                .padding(.horizontal, 22)

                Spacer()

                // The footer strip from the web landing.
                HStack(spacing: 18) {
                    footnote("E2E ENCRYPTED")
                    footnote("ZERO PII")
                    footnote("24H AUTO-DELETE")
                }
                .padding(.bottom, 18)
            }
        }
    }

    private func prompt(_ text: String) -> Text {
        Text(text).foregroundColor(Vault.Palette.muted(scheme))
    }

    private func field<Content: View>(
        label: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(Vault.Palette.textDim(scheme))
            content()
                .font(.system(size: 15))
                .foregroundStyle(Vault.Palette.text(scheme))
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: Vault.Radius.lg)
                        .fill(Vault.Palette.elevated(scheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                        )
                )
        }
    }

    private func footnote(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .tracking(0.5)
            .foregroundStyle(Vault.Palette.muted(scheme))
    }

    private func submit() {
        focus = nil
        Task { await state.signIn(username: username, password: password) }
    }
}
