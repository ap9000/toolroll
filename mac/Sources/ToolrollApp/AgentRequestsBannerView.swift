import SwiftUI
import ToolrollCore

public struct AgentRequestsBannerView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        if !store.pendingAgentRequests.isEmpty {
            VStack(spacing: 6) {
                ForEach(store.pendingAgentRequests) { request in
                    AgentRequestRowCard(store: store, request: request)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 6)
        }
    }
}

private struct AgentRequestRowCard: View {
    @Bindable var store: WorkbenchStore
    let request: AgentRequest

    @State private var useTypedPassword: Bool = false
    @State private var passwordDraft: String = ""
    @State private var rememberWithTouchID: Bool = true
    @State private var errorMessage: String? = nil

    private var isBusy: Bool {
        store.resolvingAgentRequestId == request.id
    }

    private var kindIcon: String {
        switch request.kind {
        case .network: return "network"
        case .worktreeSetup: return "wrench.and.screwdriver"
        case .liveView: return "terminal"
        }
    }

    private var kindLabel: String {
        switch request.kind {
        case .network: return "Network"
        case .worktreeSetup: return "Worktree Setup"
        case .liveView: return "Live View"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: kindIcon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 22, height: 22)
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(request.requester) asks to change \(kindLabel)")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text(request.projectName)
                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(ToolrollPalette.paper, in: Capsule())
                            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                    Text(request.summary)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                    if !request.why.isEmpty {
                        Text("Why: \(request.why)")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 10)

                if store.isTouchIDEnabled && !useTypedPassword {
                    HStack(spacing: 6) {
                        Button {
                            Task { await submit(withTouchID: true) }
                        } label: {
                            HStack(spacing: 5) {
                                if isBusy {
                                    ProgressView().controlSize(.mini)
                                } else {
                                    Image(systemName: store.touchIDSystemImage)
                                        .font(.system(size: 11.5, weight: .semibold))
                                }
                                Text(isBusy ? "Approving…" : "Approve with \(store.touchIDLabel)")
                            }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                        .disabled(isBusy)

                        Button("Password") {
                            useTypedPassword = true
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(isBusy)

                        Button("Decline") {
                            store.declineAgentRequest(request)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(isBusy)
                    }
                } else {
                    HStack(spacing: 6) {
                        SecureField("Toolroll password…", text: $passwordDraft)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11.5))
                            .frame(width: 170)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                            .onSubmit {
                                guard !passwordDraft.isEmpty && !isBusy else { return }
                                Task { await submit(withTouchID: false) }
                            }

                        ForgotPasswordLink()

                        Button(isBusy ? "Approving…" : "Approve") {
                            Task { await submit(withTouchID: false) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                        .disabled(passwordDraft.isEmpty || isBusy)

                        if store.isTouchIDEnabled {
                            Button(store.touchIDLabel) {
                                useTypedPassword = false
                                passwordDraft = ""
                            }
                            .buttonStyle(KitButtonStyle(.ghost, compact: true))
                            .disabled(isBusy)
                        }

                        Button("Decline") {
                            store.declineAgentRequest(request)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(isBusy)
                    }
                }
            }

            if !store.isTouchIDEnabled && store.isTouchIDAvailable && !passwordDraft.isEmpty {
                Toggle(isOn: $rememberWithTouchID) {
                    Text("Save verified password in Keychain for 1-tap \(store.touchIDLabel) approvals")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .toggleStyle(.checkbox)
                .controlSize(.small)
                .padding(.leading, 32)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.danger)
                    .padding(.leading, 32)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
    }

    private func submit(withTouchID: Bool) async {
        errorMessage = nil
        let typed = withTouchID ? nil : passwordDraft
        if !withTouchID { passwordDraft = "" }
        let res = await store.approveAgentRequest(request, typedPassword: typed)
        if res.ok {
            if let typed, !typed.isEmpty, rememberWithTouchID, !store.isTouchIDEnabled, store.isTouchIDAvailable {
                _ = store.enableTouchID(password: typed)
            }
        } else if res.message != "Cancelled." {
            errorMessage = res.message
        }
    }
}
