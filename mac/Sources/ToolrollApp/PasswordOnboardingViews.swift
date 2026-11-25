import AppKit
import SwiftUI
import ToolrollCore

public struct SetPasswordSheet: View {
    @Bindable var store: WorkbenchStore
    @State private var password = ""
    @State private var again = ""
    @State private var saveToTouchID = true

    public init(store: WorkbenchStore) { self.store = store }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Set a password")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
            }
            Text("Agents can work on their own, merge and release only after you set a password. Toolroll asks for it before it approves work or changes what builds may reach.")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
                .fixedSize(horizontal: false, vertical: true)

            HairlineDivider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Password").font(.system(size: 12, weight: .medium)).foregroundStyle(ToolrollPalette.ink)
                SecureField("At least 8 characters", text: $password)
                    .textFieldStyle(.roundedBorder)
                Text("Type it again").font(.system(size: 12, weight: .medium)).foregroundStyle(ToolrollPalette.ink)
                SecureField("", text: $again)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { submit() }
            }

            if let problem = store.setPasswordProblem {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Keep it in your password manager. Setting it signs out Toolroll's open browser tabs; this window reconnects by itself.")
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
                .fixedSize(horizontal: false, vertical: true)

            if store.isTouchIDAvailable {
                Toggle(isOn: $saveToTouchID) {
                    Text("Save in macOS Keychain for 1-tap \(store.touchIDLabel) approvals")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.ink)
                }
                .toggleStyle(.checkbox)
                .controlSize(.small)
            }

            HStack {
                Spacer()
                Button("Not now") {
                    store.snoozePasswordNudge()
                    store.isSetPasswordOpen = false
                }
                .keyboardShortcut(.cancelAction)
                Button(store.setPasswordBusy ? "Setting…" : "Set password") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(store.setPasswordBusy || password.isEmpty || again.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func submit() {
        guard !store.setPasswordBusy else { return }
        let typed = password, repeated = again
        let enableBiometry = saveToTouchID
        Task {
            if await store.setFirstPassword(typed, again: repeated, saveToTouchID: enableBiometry) {
                password = ""
                again = ""
            }
        }
    }
}

public struct SetPasswordBanner: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) { self.store = store }

    public var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "key")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            Text("Set a password to approve work and change settings.")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.ink)
            Spacer()
            Button("Not now") { store.snoozePasswordNudge() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
            Button("Set a password") { store.openSetPassword() }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised)
    }
}

public struct ForgotPasswordLink: View {
    @State private var isOpen = false
    @State private var copied = false
    static let command = "toolroll password reset"

    public init() {}

    public var body: some View {
        Button("Forgot password?") { isOpen = true }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            .foregroundStyle(ToolrollPalette.muted)
            .popover(isPresented: $isOpen, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Reset it in Terminal on this Mac")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Paste this in Terminal and type a new password twice. It signs out your other Toolroll sessions.")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(Self.command)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollPalette.raised)
                    HStack {
                        Button(copied ? "Copied" : "Copy command") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(Self.command, forType: .string)
                            copied = true
                        }
                        Button("Open Terminal") {
                            if let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") {
                                NSWorkspace.shared.openApplication(at: terminal, configuration: NSWorkspace.OpenConfiguration())
                            }
                        }
                    }
                }
                .padding(14)
                .frame(width: 320)
            }
    }
}

public struct SignInPasswordSheet: View {
    @Bindable var store: WorkbenchStore
    @State private var password = ""
    @State private var saveToTouchID = true

    public init(store: WorkbenchStore) { self.store = store }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("Sign in with your password")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
            }

            Text("This action requires a password-verified session for \(store.activeProfile.account). Your password stays on this Mac.")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
                .fixedSize(horizontal: false, vertical: true)

            HairlineDivider()

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Password")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                    Spacer()
                    ForgotPasswordLink()
                }
                SecureField("Enter your Toolroll password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { submit() }
            }

            if let problem = store.signInProblem {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if store.isTouchIDAvailable && !store.isTouchIDEnabled {
                Toggle(isOn: $saveToTouchID) {
                    Text("Save in macOS Keychain for 1-tap \(store.touchIDLabel) approvals")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.ink)
                }
                .toggleStyle(.checkbox)
                .controlSize(.small)
            }

            HStack(spacing: 8) {
                if store.isTouchIDEnabled {
                    Button {
                        Task {
                            if await store.signInWithTouchID() {
                                password = ""
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: store.touchIDSystemImage)
                                .font(.system(size: 11.5))
                            Text(store.touchIDLabel)
                        }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(store.signInBusy)
                }

                Spacer()

                Button("Cancel") {
                    store.isSignInSheetOpen = false
                    store.signInProblem = nil
                }
                .keyboardShortcut(.cancelAction)

                Button(store.signInBusy ? "Signing in…" : "Sign in") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(store.signInBusy || password.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func submit() {
        guard !store.signInBusy, !password.isEmpty else { return }
        let typed = password
        let enableBiometry = saveToTouchID && !store.isTouchIDEnabled
        Task {
            if await store.signInWithPassword(typed, saveToTouchID: enableBiometry) {
                password = ""
            }
        }
    }
}
