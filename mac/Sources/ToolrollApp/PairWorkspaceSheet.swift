import AppKit
import SwiftUI
import ToolrollCore

/// Native Browser-Assisted Device Pairing & Manual Token Sheet.
/// Writes directly to `~/.config/toolroll/remote/profiles.json` (chmod 0600) so CLI, Rust TUI, and Mac app share profiles.
public struct PairWorkspaceSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    enum Mode: String, CaseIterable, Identifiable {
        case pair = "Browser Pairing"
        case token = "API Token"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .pair
    @State private var origin: String = "http://127.0.0.1:4180"
    @State private var profileName: String = "central"
    @State private var account: String = ""
    @State private var token: String = ""
    @State private var workspaceId: String = ""
    @State private var recoveryGeneration: String = ""
    @State private var statusText: String?
    @State private var errorText: String?
    @State private var pairCode: String?
    @State private var isWorking: Bool = false
    @State private var pollTask: Task<Void, Never>?

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Connect Remote Workspace")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button("Close") {
                    pollTask?.cancel()
                    store.isPairSheetOpen = false
                    dismiss()
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            HStack(spacing: 4) {
                ForEach(Mode.allCases) { m in
                    let active = mode == m
                    Button {
                        mode = m
                        errorText = nil
                    } label: {
                        Text(m.rawValue)
                            .font(.system(size: 12, weight: active ? .semibold : .medium))
                            .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 6))

            labeledField("Workspace Origin (HTTPS or loopback HTTP)", text: $origin, placeholder: "https://toolroll.team.internal")
            labeledField("Profile Name", text: $profileName, placeholder: "central")

            if mode == .pair {
                if let code = pairCode {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Approve this code in your browser:")
                            .font(.system(size: 12))
                            .foregroundStyle(ToolrollPalette.muted)
                        Text(code)
                            .font(.system(size: 24, weight: .bold, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                            .textSelection(.enabled)
                        Text("Waiting for approval… profile saves automatically once confirmed.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
            } else {
                labeledField("Account", text: $account, placeholder: "alex")
                labeledField("Bearer Token", text: $token, placeholder: "tr_tok_…", secure: true)
                HStack(spacing: 10) {
                    labeledField("Workspace ID (optional)", text: $workspaceId, placeholder: "ws-…")
                    labeledField("Recovery Generation (optional)", text: $recoveryGeneration, placeholder: "gen-…")
                }
            }

            if let statusText {
                Text(statusText)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.live)
            }
            if let errorText {
                Text(errorText)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.danger)
            }

            HStack {
                Text("Shared with CLI & TUI at ~/.config/toolroll/remote/profiles.json")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if mode == .pair {
                    Button(isWorking ? "Waiting for Browser…" : "Start Browser Pairing") {
                        startPairing()
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                    .disabled(isWorking || origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else {
                    Button("Save & Connect") {
                        saveManualProfile()
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                    .disabled(origin.isEmpty || token.isEmpty || profileName.isEmpty)
                }
            }
        }
        .padding(20)
        .frame(width: 480)
        .background(ToolrollPalette.paper)
        .onDisappear {
            pollTask?.cancel()
        }
    }

    private func labeledField(_ label: String, text: Binding<String>, placeholder: String, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ToolrollPalette.muted)
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(ToolrollPalette.ink)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
        }
    }

    private func startPairing() {
        pollTask?.cancel()
        isWorking = true
        errorText = nil
        statusText = "Requesting pairing code…"

        let targetOrigin = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetName = profileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "central" : profileName.trimmingCharacters(in: .whitespacesAndNewlines)

        pollTask = Task {
            do {
                let started = try await ToolrollClient.startDevicePairing(origin: targetOrigin, label: "Toolroll Mac")
                pairCode = started.userCode
                statusText = "Opened browser verification page."
                if let base = try? ToolrollClient.normalizedOrigin(targetOrigin),
                   let verifyURL = URL(string: started.verifyPath, relativeTo: base) {
                    NSWorkspace.shared.open(verifyURL)
                }

                for _ in 0..<120 {
                    if Task.isCancelled { return }
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    let polled = try await ToolrollClient.pollDevicePairing(
                        origin: targetOrigin,
                        pairId: started.pairId,
                        pollSecret: started.pollSecret
                    )
                    if polled.status == "approved", let tok = polled.token, !tok.isEmpty {
                        let prof = ConnectionProfile(
                            name: targetName,
                            origin: targetOrigin,
                            account: polled.account ?? "member",
                            token: tok,
                            workspaceId: polled.workspaceId,
                            recoveryGeneration: polled.recoveryGeneration,
                            label: polled.label ?? targetName,
                            isDemo: false
                        )
                        isWorking = false
                        await store.savePairedProfile(prof)
                        dismiss()
                        return
                    }
                    if polled.status == "expired" || polled.status == "denied" {
                        errorText = "Pairing \(polled.status). Start a new pairing request."
                        isWorking = false
                        return
                    }
                }
                errorText = "Pairing timed out. Try again."
                isWorking = false
            } catch {
                errorText = error.localizedDescription
                isWorking = false
            }
        }
    }

    private func saveManualProfile() {
        do {
            _ = try ToolrollClient.normalizedOrigin(origin)
            let prof = ConnectionProfile(
                name: profileName.trimmingCharacters(in: .whitespacesAndNewlines),
                origin: origin.trimmingCharacters(in: .whitespacesAndNewlines),
                account: account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "member" : account.trimmingCharacters(in: .whitespacesAndNewlines),
                token: token.trimmingCharacters(in: .whitespacesAndNewlines),
                workspaceId: workspaceId.isEmpty ? nil : workspaceId,
                recoveryGeneration: recoveryGeneration.isEmpty ? nil : recoveryGeneration,
                label: profileName.trimmingCharacters(in: .whitespacesAndNewlines),
                isDemo: false
            )
            Task {
                await store.savePairedProfile(prof)
                dismiss()
            }
        } catch {
            errorText = error.localizedDescription
        }
    }
}
