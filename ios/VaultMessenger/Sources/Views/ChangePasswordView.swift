import SwiftUI

/// Changing the account password from the phone.
///
/// Worth being blunt in the copy here rather than reassuring. Two facts make
/// this different from a password change anywhere else, and both are things a
/// user can only find out the hard way otherwise: there is no reset if they
/// forget the new one, and every other signed-in device is signed out.
struct ChangePasswordView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    private static let minimumLength = 12

    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?
    @State private var done: String?

    var body: some View {
        ZStack {
            Vault.Palette.black(scheme).ignoresSafeArea()

            VStack(spacing: 0) {
                header

                ScrollView {
                    VStack(spacing: 18) {
                        VaultSection(
                            title: "Current password",
                            footnote: "Checked on the server against a one-way derivation. It never sees the password itself."
                        ) {
                            field("Current password", text: $current)
                        }

                        VaultSection(
                            title: "New password",
                            footnote: strengthNote
                        ) {
                            field("New password", text: $next)
                            VaultDivider()
                            field("Confirm new password", text: $confirm)
                        }

                        warning

                        if let error {
                            Text(error)
                                .font(.system(size: 12))
                                .foregroundStyle(Vault.Palette.danger)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let done {
                            Text(done)
                                .font(.system(size: 12))
                                .foregroundStyle(Vault.Palette.accent(scheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button(action: submit) {
                            Text(busy ? "Changing…" : "Change password")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity, minHeight: 46)
                                .background(
                                    RoundedRectangle(cornerRadius: Vault.Radius.lg)
                                        .fill(Vault.Palette.accent(scheme))
                                )
                                .foregroundStyle(Vault.Palette.black(scheme))
                        }
                        .disabled(!canSubmit)
                        .opacity(canSubmit ? 1 : 0.4)
                    }
                    .padding(16)
                }
            }
        }
        .navigationBarHidden(true)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Vault.Palette.textDim(scheme))
            }
            .accessibilityLabel("Back")

            Text("Change password")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Vault.Palette.text(scheme))
            Spacer()
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

    private var warning: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundStyle(Vault.Palette.warning)
            Text("Your other devices will be signed out. There is no password reset — if you forget this one, the account and everything in it is gone.")
                .font(.system(size: 11))
                .foregroundStyle(Vault.Palette.textDim(scheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Vault.Radius.lg)
                .fill(Vault.Palette.warning.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: Vault.Radius.lg)
                        .stroke(Vault.Palette.warning.opacity(0.25), lineWidth: 1)
                )
        )
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        SecureField("", text: text, prompt: Text(placeholder)
            .foregroundColor(Vault.Palette.muted(scheme)))
            .textContentType(.password)
            .autocorrectionDisabled()
            .foregroundStyle(Vault.Palette.text(scheme))
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            // Explicit, not inferred. SwiftUI derives a field's accessibility
            // label from whatever text happens to sit near it, which changes
            // as the layout does and takes the UI tests with it.
            .accessibilityIdentifier(placeholder)
    }

    private var strengthNote: String {
        if next.isEmpty { return "At least \(Self.minimumLength) characters." }
        if next.count < Self.minimumLength {
            return "\(Self.minimumLength - next.count) more characters needed."
        }
        if !confirm.isEmpty && next != confirm { return "The two new passwords do not match." }
        if next == current { return "That is your current password." }
        return next.count < 16 ? "Acceptable." : (next.count < 24 ? "Strong." : "Very strong.")
    }

    private var canSubmit: Bool {
        !busy && !current.isEmpty && next.count >= Self.minimumLength
            && next == confirm && next != current
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        done = nil

        Task {
            do {
                let revoked = try await state.changePassword(current: current, new: next)
                done = revoked > 0
                    ? "Password changed. \(revoked) other \(revoked == 1 ? "device was" : "devices were") signed out."
                    : "Password changed."
                current = ""; next = ""; confirm = ""
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription
                    ?? "Could not change your password."
            }
            busy = false
        }
    }
}
