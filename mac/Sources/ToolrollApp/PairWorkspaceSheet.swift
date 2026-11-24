import AppKit
import SwiftUI
import ToolrollCore

public struct PairWorkspaceSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var origin: String = ""
    @State private var pairCode: String?
    @State private var statusText: String?
    @State private var errorText: String?
    @State private var isWorking: Bool = false
    @State private var pollTask: Task<Void, Never>?

    @State private var showManualToken: Bool = false
    @State private var manualToken: String = ""
    @State private var manualAccount: String = ""

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect Remote Workspace")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("Pair with a team server or another machine running Toolroll.")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                Button {
                    pollTask?.cancel()
                    store.isPairSheetOpen = false
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(6)
                }
                .buttonStyle(.plain)
            }

            if store.isLocalSession {
                HStack(spacing: 7) {
                    Circle().fill(ToolrollPalette.success).frame(width: 6, height: 6)
                    Text("Already connected to this Mac (\(store.activeProfile.origin.replacingOccurrences(of: "http://", with: ""))). You only need this for a remote or team server.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 5) {
                Text("Workspace URL")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("https://toolroll.yourteam.com", text: $origin)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                    .onSubmit {
                        if !showManualToken { startPairing() }
                    }
            }

            if let code = pairCode {
                VStack(spacing: 6) {
                    Text("Confirm this code in your browser")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text(code)
                        .font(.system(size: 26, weight: .bold, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(ToolrollPalette.ink)
                        .textSelection(.enabled)
                    Text("Waiting for approval — this window closes automatically once confirmed.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(.easeInOut(duration: 0.14)) {
                        showManualToken.toggle()
                        errorText = nil
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: showManualToken ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                        Text("Advanced: connect with an API token instead")
                            .font(.system(size: 11.5))
                    }
                    .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)

                if showManualToken {
                    VStack(spacing: 8) {
                        SecureField("Bearer token (tr_tok_…)", text: $manualToken)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12.5, design: .monospaced))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 7)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

                        TextField("Account name (optional)", text: $manualAccount)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12.5, design: .monospaced))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 7)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                    }
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
                Spacer()
                if showManualToken {
                    Button("Connect with Token") {
                        saveManualProfile()
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                    .disabled(origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || manualToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else {
                    Button {
                        startPairing()
                    } label: {
                        HStack(spacing: 5) {
                            Text(isWorking ? "Waiting for Browser…" : "Continue")
                            if !isWorking {
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 10.5, weight: .semibold))
                            }
                        }
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                    .disabled(isWorking || origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(22)
        .frame(width: 440)
        .background(ToolrollPalette.paper)
        .onDisappear {
            pollTask?.cancel()
        }
    }

    private func normalizedTargetOrigin() -> String {
        let raw = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") { return raw }
        if raw.hasPrefix("127.0.0.1") || raw.hasPrefix("localhost") { return "http://\(raw)" }
        return "https://\(raw)"
    }

    private func derivedProfileName(from urlStr: String) -> String {
        if let host = URL(string: urlStr)?.host, !host.isEmpty {
            return host.replacingOccurrences(of: ".", with: "-")
        }
        return "remote"
    }

    private func startPairing() {
        pollTask?.cancel()
        isWorking = true
        errorText = nil
        statusText = nil

        let targetOrigin = normalizedTargetOrigin()
        let targetName = derivedProfileName(from: targetOrigin)

        pollTask = Task {
            do {
                let started = try await ToolrollClient.startDevicePairing(origin: targetOrigin, label: Host.current().localizedName ?? "Toolroll Mac")
                pairCode = started.userCode
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
                        errorText = "Pairing \(polled.status). Try again."
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
        let targetOrigin = normalizedTargetOrigin()
        let targetName = derivedProfileName(from: targetOrigin)
        do {
            _ = try ToolrollClient.normalizedOrigin(targetOrigin)
            let prof = ConnectionProfile(
                name: targetName,
                origin: targetOrigin,
                account: manualAccount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "member" : manualAccount.trimmingCharacters(in: .whitespacesAndNewlines),
                token: manualToken.trimmingCharacters(in: .whitespacesAndNewlines),
                label: targetName,
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
