import SwiftUI

/// Sign-in only, deliberately — there is no "create account" here.
///
/// Registering generates the identity keys, signed prekey and one-time
/// prekeys that other people use to start an encrypted conversation with you.
/// This app cannot yet hold up that side, so an account created here would
/// look normal and then fail for anyone who tried to message it privately.
/// Better to send people to the web to sign up than to mint accounts that are
/// quietly broken.
struct SignInView: View {
    @EnvironmentObject private var state: AppState

    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 8) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(.tint)
                Text("Vault")
                    .font(.largeTitle.weight(.semibold))
                Text("End-to-end encrypted messaging")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 12) {
                TextField("Username", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .username)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }

                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submit() }
            }
            .textFieldStyle(.roundedBorder)

            if let error = state.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: submit) {
                if state.isLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("Sign in").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(state.isLoading || username.isEmpty || password.isEmpty)

            // Said plainly rather than discovered after a failed attempt.
            Text("New accounts are created on vaultapp.space.")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            Spacer()
        }
        .padding(28)
    }

    private func submit() {
        focus = nil
        Task { await state.signIn(username: username, password: password) }
    }
}
