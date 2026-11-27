import SwiftUI
import ToolrollCompanionCore

struct SettingsView: View {
    @Bindable var appState: CompanionAppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            List {
                if appState.isDemoMode {
                    Section("Demo Workspace") {
                        Text("You are exploring zero-network local demo fixtures matching `toolroll demo`.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                        Button("Exit Demo & Pair Your Mac") {
                            appState.exitDemoMode()
                            dismiss()
                        }
                        .foregroundStyle(ToolrollTheme.cobalt)
                    }
                } else if let record = appState.pairedRecord {
                    Section("Paired Mac") {
                        LabeledContent("Workspace", value: record.workspaceId)
                        LabeledContent("Device ID", value: record.deviceId)
                        LabeledContent("Machine ID", value: record.machineId)
                        LabeledContent("Relay", value: record.relayUrl)
                        LabeledContent("Pinned Mac Key", value: String(record.macStaticPubBase64Url.prefix(16)) + "…")
                    }
                }

                Section("Security & Privacy") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("End-to-End Encrypted Relay")
                            .font(.subheadline.weight(.semibold))
                        Text("Traffic uses Noise_IKpsk2_25519_ChaChaPoly_SHA256. The relay cannot read content or authorize actions; it observes IP addresses, opaque routing IDs, timing, and ciphertext size.")
                            .font(.caption)
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Push Notifications")
                            .font(.subheadline.weight(.semibold))
                        Text("Notification bodies are RFC 8291 encrypted and decrypted locally on-device. Task titles stay on your Mac by default unless you opt in on your Mac.")
                            .font(.caption)
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                }

                if !appState.isDemoMode && appState.pairedRecord != nil {
                    Section {
                        Button("Unpair This iPhone", role: .destructive) {
                            confirmUnpair = true
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this iPhone from your Mac?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    Task {
                        await appState.unpairThisPhone()
                        dismiss()
                    }
                }
            } message: {
                Text("This revokes the device on your Mac and deletes its Noise keys and device PSK from Keychain.")
            }
        }
    }
}
