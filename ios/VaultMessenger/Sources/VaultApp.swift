import SwiftUI

@main
struct VaultApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var state: AppState

    /// The welcome screen is shown once, not every launch. It exists to
    /// explain the app to someone who has not seen it; showing it again to
    /// someone who signs out and back in is a door they have to open twice.
    @AppStorage("hasSeenWelcome") private var hasSeenWelcome = false

    /// Nothing is decided until `restoreSession` has answered. Without this,
    /// a returning user gets a frame of the welcome screen before their chat
    /// list appears, which looks like being signed out.
    @State private var checkedSession = false

    var body: some View {
        Group {
            if !checkedSession {
                splash
            } else if state.isSignedIn {
                MainTabView()
            } else if !hasSeenWelcome {
                WelcomeView { hasSeenWelcome = true }
                    .transition(.opacity)
            } else {
                SignInView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: hasSeenWelcome)
        .task {
            await state.restoreSession()
            checkedSession = true
        }
        // The web client ships an explicit dark/light toggle, so the same
        // control exists here rather than only following the system.
        .preferredColorScheme(preferredScheme)
    }

    /// The mark on the app's own background, so the launch screen and the
    /// first rendered frame are the same picture.
    private var splash: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VaultShield(lineWidth: 1.8, color: .primary)
                .frame(width: 56, height: 56)
        }
    }

    private var preferredScheme: ColorScheme? {
        switch state.appearancePreference {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }
}
