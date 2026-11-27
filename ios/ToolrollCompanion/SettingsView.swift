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
                    Text("Notifications are coming soon. For now, open the app to see what needs you.")
                        .foregroundStyle(ToolrollTheme.ink)
                } header: {
                    Text("Notifications")
                }

                Section {
                    DisclosureGroup("How it's secured") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Everything between this iPhone and your Mac is end-to-end encrypted. The relay that carries it can't read it and can't act for you.")
                            Text("This iPhone can only read. Approving and accepting still happen on your Mac.")
                            Text("Keys stay in this iPhone's keychain and are never backed up to iCloud.")
                            Text("Technical details: Noise_IKpsk2_25519_ChaChaPoly_SHA256 with a per-device pre-shared key from pairing, a six-character transcript code to confirm the pairing, and Ed25519-signed relay tokens. The relay sees IP addresses, timing and message sizes only.")
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.ink)
                        .padding(.vertical, 4)
                    }
                    .foregroundStyle(ToolrollTheme.ink)

                    if let record = appState.pairedRecord, !appState.isDemoMode {
                        DisclosureGroup("Device details") {
                            detail("Paired", record.pairedAt.formatted(date: .abbreviated, time: .shortened))
                            detail("This iPhone", record.deviceId)
                            detail("Workspace", record.workspaceId)
                            detail("Machine", record.machineId)
                            detail("Relay", record.relayUrl)
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
                                Text("Remove this iPhone")
                                if removing {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(removing)
                    } footer: {
                        Text("Removes the keys from this iPhone and asks your Mac to forget it.")
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
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .unreachable: return "Can't reach your Mac"
        case .notRecognized: return "Not accepted by your Mac"
        default: return "Not connected"
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
