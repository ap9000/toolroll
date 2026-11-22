import AppKit
import SwiftUI
import ToolrollCore

/// Password onboarding (docs/plans/password-onboarding.md): set a first password here; reset a forgotten one in Terminal.

/// Set your first password. Same words and rules as the browser's page (render-people.ts passwordSetPage).
public struct SetPasswordSheet: View {
    @Bindable var store: WorkbenchStore
    @State private var password = ""
    @State private var again = ""

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
        Task {
            if await store.setFirstPassword(typed, again: repeated) {
                password = ""
                again = ""
            }
        }
    }
}

/// The one-line nudge while the account has no password (Not now hides it for a week).
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

/// "Forgot password?" under a password box. A forgotten password is reset only in Terminal on this Mac (operate.ts
/// `password reset`: the trust boundary is this computer's account), so this shows the command to copy and opens
/// Terminal. It never writes or runs anything itself.
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
