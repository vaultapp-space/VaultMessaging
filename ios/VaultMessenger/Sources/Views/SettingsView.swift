import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            settings
        }
        .tint(Vault.Palette.accent(scheme))
    }

    private var settings: some View {
        VaultScreen(title: "Settings") {
            VaultSection(title: "Appearance") {
                HStack(spacing: 6) {
                    ForEach(["system", "dark", "light"], id: \.self) { option in
                        Button {
                            state.appearancePreference = option
                        } label: {
                            Text(option.capitalized)
                                .font(.system(size: 12, weight: .medium))
                                .frame(maxWidth: .infinity, minHeight: 32)
                                .background(
                                    RoundedRectangle(cornerRadius: Vault.Radius.md)
                                        .fill(state.appearancePreference == option
                                              ? Vault.Palette.accent(scheme)
                                              : Vault.Palette.elevated(scheme))
                                )
                                .foregroundStyle(state.appearancePreference == option
                                                 ? Vault.Palette.black(scheme)
                                                 : Vault.Palette.textDim(scheme))
                        }
                    }
                }
                .padding(12)
            }

            VaultSection(
                title: "Active sessions",
                footnote: "Everything signed in to this account. Signing one out takes effect at once."
            ) {
                if state.devices.isEmpty {
                    VaultRow(title: "Loading…", icon: "hourglass")
                } else {
                    ForEach(Array(state.devices.enumerated()), id: \.element.id) { index, device in
                        VaultRow(
                            title: device.displayName,
                            subtitle: device.current ? "This device" : lastSeen(device),
                            icon: device.current ? "iphone" : "desktopcomputer"
                        ) {
                            // The current device is labelled, not actionable:
                            // signing yourself out from a list of others is
                            // how people lock themselves out by accident.
                            if !device.current {
                                Button("Sign out") {
                                    Task { await state.revoke(device) }
                                }
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Vault.Palette.danger)
                            }
                        }
                        if index < state.devices.count - 1 { VaultDivider() }
                    }
                }
            }

            VaultSection(
                title: "Retention",
                footnote: "Not a setting. Every message on every device is deleted 24 hours after it is sent, and there is no tier or toggle that changes it."
            ) {
                VaultRow(
                    title: "Messages delete after 24 hours",
                    subtitle: "Conversations stay in your list; their contents do not.",
                    icon: "clock.arrow.circlepath"
                )
            }

            VaultSection(
                title: "Encryption",
                footnote: "One-to-one chats are end-to-end encrypted. This app cannot read them yet — the ratchet lives in the web client — so they are listed but not opened here."
            ) {
                VaultRow(
                    title: "Secret chats",
                    subtitle: "Open on vaultapp.space to read",
                    icon: "lock.fill"
                )
                VaultDivider()
                VaultRow(
                    title: "Cloud chats and groups",
                    subtitle: "Readable here and synced across your devices",
                    icon: "cloud"
                )
            }
        }
        .task { await state.refreshDevices() }
    }

    private func lastSeen(_ device: Device) -> String {
        guard let date = device.lastActiveAt else { return device.platform ?? "" }
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "Active now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h ago" : "\(hours / 24)d ago"
    }
}
