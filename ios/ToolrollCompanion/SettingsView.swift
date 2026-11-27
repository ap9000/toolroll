import SwiftUI
import ToolrollCompanionCore

struct SettingsView: View {
    @Bindable var appState: CompanionAppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @State private var removing = false

    var body: some View {
        NavigationStack {
            List {
                if appState.isDemoMode {
                    Section {
                        Text("You're looking at sample work. Nothing leaves this iPhone.")
                            .foregroundStyle(ToolrollTheme.ink)
                        Button("Exit the demo") {
                            appState.exitDemoMode()
                            dismiss()
                        }
                        .foregroundStyle(ToolrollTheme.ink)
                        .fontWeight(.semibold)
                    } header: {
                        Text("Demo")
                    }
                } else if appState.pairedRecord != nil {
                    Section {
                        LabeledContent("Mac", value: appState.workspaceLabel)
                        LabeledContent("Status", value: statusText)
                    } header: {
                        Text("Paired Mac")
                    }
                }

                Section {
                    DisclosureGroup("How it's secured") {
                        HowItsSecured()
                            .padding(.vertical, 4)
                    }
                    .foregroundStyle(ToolrollTheme.ink)

                    if let record = appState.pairedRecord, !appState.isDemoMode {
                        DisclosureGroup("Device details") {
                            detail("Paired", record.pairedAt.formatted(date: .abbreviated, time: .shortened))
                            detail("This iPhone", record.deviceId)
                            detail("Workspace", record.workspaceId)
                            detail("Machine", record.machineId)
                            if let connectionText {
                                detail("Connection", connectionText)
                            }
                        }
                        .foregroundStyle(ToolrollTheme.ink)
                    }
                } header: {
                    Text("Privacy")
                }

                if !appState.isDemoMode && appState.pairedRecord != nil {
                    Section {
                        Button(role: .destructive) {
                            confirmUnpair = true
                        } label: {
                            HStack {
                                Text(appState.isTerminal ? "Remove from this iPhone" : "Remove this iPhone")
                                    .foregroundStyle(ToolrollTheme.danger)
                                if removing {
                                    Spacer()
                                    ProgressView()
                                        .accessibilityLabel("Removing")
                                }
                            }
                        }
                        .disabled(removing)
                    } footer: {
                        Text(appState.isTerminal
                            ? "Removes the pairing and its keys from this iPhone. Your Mac already removed it."
                            : "Removes the keys from this iPhone and asks your Mac to forget it.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
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

    /// "Connected directly" or "Connected through <the hosted relay's host>", while connected.
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
                .font(.footnote.monospaced())
                .foregroundStyle(ToolrollTheme.ink)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What protects the connection, in plain words first (Settings and Welcome's "Is this safe?").
struct HowItsSecured: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Everything between this iPhone and your Mac is end-to-end encrypted, whether it goes straight over your network or through the relay. The relay can't read it and can't act for you.")
            Text("This iPhone can only read. Approving and accepting still happen on your Mac.")
            Text("Keys stay in this iPhone's keychain and are never backed up to iCloud.")
            Text("Technical details: Noise_IKpsk2_25519_ChaChaPoly_SHA256 with a per-device pre-shared key from pairing, a six-character transcript code to confirm the pairing, and Ed25519-signed relay tokens. The relay sees IP addresses, timing and message sizes only.")
                .foregroundStyle(ToolrollTheme.muted)
        }
        .font(.subheadline)
        .foregroundStyle(ToolrollTheme.ink)
        .fixedSize(horizontal: false, vertical: true)
    }
}
