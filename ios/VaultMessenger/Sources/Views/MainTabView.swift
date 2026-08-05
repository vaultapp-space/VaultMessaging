import SwiftUI

/// Chats, Settings and Profile.
///
/// A tab bar rather than a menu tucked into a header: on a phone the header
/// is the scarcest space on screen, and burying account controls behind an
/// ellipsis is how people fail to find them at all.
struct MainTabView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TabView {
            ChatListView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }

            ProfileView()
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
        .tint(Vault.Palette.accent(scheme))
    }
}

// MARK: - Shared building blocks

/// A titled group of rows, matching the sectioning the web client's settings
/// panel uses.
struct VaultSection<Content: View>: View {
    let title: String
    var footnote: String?
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(Vault.Palette.textDim(scheme))
                .padding(.horizontal, 4)

            VStack(spacing: 0) { content }
                .background(
                    RoundedRectangle(cornerRadius: Vault.Radius.xl)
                        .fill(Vault.Palette.surface(scheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: Vault.Radius.xl)
                                .stroke(Vault.Palette.border(scheme), lineWidth: 1)
                        )
                )

            if let footnote {
                Text(footnote)
                    .font(.system(size: 11))
                    .foregroundStyle(Vault.Palette.muted(scheme))
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct VaultRow<Trailing: View>: View {
    let title: String
    var subtitle: String?
    var icon: String?
    var tint: Color?
    @ViewBuilder let trailing: Trailing

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 11) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundStyle(tint ?? Vault.Palette.textDim(scheme))
                    .frame(width: 20)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(tint ?? Vault.Palette.text(scheme))
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(Vault.Palette.textDim(scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

extension VaultRow where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, icon: String? = nil, tint: Color? = nil) {
        self.init(title: title, subtitle: subtitle, icon: icon, tint: tint) { EmptyView() }
    }
}

struct VaultDivider: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Rectangle()
            .fill(Vault.Palette.border(scheme))
            .frame(height: 1)
            .padding(.leading, 14)
    }
}

/// The screen chrome every tab shares.
struct VaultScreen<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Vault.Palette.black(scheme).ignoresSafeArea()

            VStack(spacing: 0) {
                HStack {
                    Text(title)
                        .font(.system(size: 22, weight: .semibold))
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

                ScrollView {
                    VStack(spacing: 18) { content }
                        .padding(16)
                }
            }
        }
    }
}
