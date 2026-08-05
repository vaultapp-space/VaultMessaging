import SwiftUI

@main
struct VaultApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .task { await state.restoreSession() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        if state.isSignedIn {
            ChatListView()
        } else {
            SignInView()
        }
    }
}
