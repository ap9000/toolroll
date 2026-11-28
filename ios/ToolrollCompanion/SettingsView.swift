import SwiftUI
import ToolrollCompanionCore

/// Signal-styled Settings: sentence-case section titles, grouped paper sheets on frame grey,
/// zero uppercase system List chrome.
struct SettingsView: View {
    @Bindable var appState: CompanionAppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @State private var removing = false
    @State private var showSecured = false
    @State private var showDetails = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if appState.isDemoMode {
                        section("Demo") {
                            VStack(spacing: 0) {
                                Text("You're looking at sample work. Nothing leaves this iPhone.")
                                    .font(.subheadline)
                                    .foregroundStyle(ToolrollTheme.muted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                Button {
                                    appState.exitDemoMode()
                                    dismiss()
                                } label: {
                                    HStack {
                                        Text("Exit demo")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(ToolrollTheme.ink)
                                        Spacer()
                                        Image(systemName: "rectangle.portrait.and.arrow.right")
                                            .font(.footnote)
                                            .foregroundStyle(ToolrollTheme.muted)
                                    }
                                    .padding(14)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    } else if appState.pairedRecord != nil {
                        section("Paired Mac") {
                            VStack(spacing: 0) {
                                keyValueRow("Mac", value: appState.workspaceLabel)
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                keyValueRow("Status", value: statusText, valueColor: statusColor)
                            }
                        }
                    }

                    section("Security and details") {
                        VStack(spacing: 0) {
                            DisclosureGroup(isExpanded: $showSecured) {
                                HowItsSecured()
                                    .padding(.top, 10)
                            } label: {
                                Text("How it's secured")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(ToolrollTheme.ink)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)

                            if let record = appState.pairedRecord, !appState.isDemoMode {
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                DisclosureGroup(isExpanded: $showDetails) {
                                    VStack(alignment: .leading, spacing: 10) {
                                        detail("Paired", record.pairedAt.formatted(date: .abbreviated, time: .shortened))
                                        detail("This iPhone", record.deviceId)
                                        detail("Workspace", record.workspaceId)
                                        detail("Machine", record.machineId)
                                        if let connectionText {
                                            detail("Connection", connectionText)
                                        }
                                    }
                                    .padding(.top, 10)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                } label: {
                                    Text("Device details")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(ToolrollTheme.ink)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                            }
                        }
                    }

                    if !appState.isDemoMode && appState.pairedRecord != nil {
                        VStack(alignment: .leading, spacing: 6) {
                            Button(role: .destructive) {
                                confirmUnpair = true
                            } label: {
                                HStack {
                                    Text(appState.isTerminal ? "Remove from this iPhone" : "Remove this iPhone")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(ToolrollTheme.danger)
                                    Spacer()
                                    if removing {
                                        ProgressView()
                                            .accessibilityLabel("Removing")
                                    }
                                }
                                .padding(14)
                                .frame(minHeight: 46)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(removing)
                            .card()

                            Text(appState.isTerminal
                                ? "Removes the pairing and its keys from this iPhone. Your Mac already removed it."
                                : "Removes the keys from this iPhone and asks your Mac to forget it.")
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.muted)
                                .padding(.horizontal, 4)
                        }
                    }
                }
                .padding(16)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .foregroundStyle(ToolrollTheme.ink)
                }
            }
            .confirmationDialog("Remove this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    removing = true
                    Task {
                        await appState.unpairThisPhone()
                        removing = false
                        dismiss()
                    }
                }
            } message: {
                Text("You'll need to pair again to see your work on this iPhone.")
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(ToolrollTheme.muted)
                .padding(.horizontal, 4)
                .accessibilityAddTraits(.isHeader)
            content()
                .card()
        }
    }

    private func keyValueRow(_ label: String, value: String, valueColor: Color = ToolrollTheme.muted) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.ink)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        switch appState.connection {
        case .connected: return connectionText ?? "Connected"
        case .connecting: return "Connecting…"
        case .unreachable: return "Can't reach your Mac"
        case .refused: return "Removed by your Mac"
        case .damaged: return "Pairing data is damaged"
        default: return "Not connected"
        }
    }

    private var statusColor: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
    }

    private var connectionText: String? {
        guard case .connected = appState.connection, let path = appState.connectedPath else { return nil }
        switch path.kind {
        case .direct: return "Connected directly"
        case .hosted: return path.host.map { "Connected through \($0)" } ?? "Connected through the relay"
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(ToolrollTheme.muted)
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(ToolrollTheme.ink)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What protects the connection, in plain words first (Settings and Welcome's "How it's secured").
struct HowItsSecured: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Everything between this iPhone and your Mac is end-to-end encrypted, whether it goes straight over your network or through the relay. The relay can't read it and can't act for you.")
            Text("Keys stay in this iPhone's keychain and are never backed up to iCloud.")
            Text("Technical details: Noise_IKpsk2_25519_ChaChaPoly_SHA256 with a per-device pre-shared key from pairing, a six-character transcript code to confirm the pairing, and Ed25519-signed relay tokens. The relay sees IP addresses, timing and message sizes only.")
                .foregroundStyle(ToolrollTheme.muted)
        }
        .font(.footnote)
        .foregroundStyle(ToolrollTheme.ink)
        .fixedSize(horizontal: false, vertical: true)
    }
}
