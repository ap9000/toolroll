import SwiftUI
import ToolrollCompanionCore

/// Unified Signal Settings: Appearance (theme + customizable accent matching Web & Desktop),
/// paired Mac status, and quiet grouped paper sheets.
struct SettingsView: View {
    @Bindable var appState: CompanionAppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.toolrollAppearance) private var appearance
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmUnpair = false
    @State private var removing = false
    @State private var showSecured = false
    @State private var showDetails = false

    private var customColorBinding: Binding<Color> {
        Binding(
            get: { appearance.swiftUIColor },
            set: { appearance.setCustomColor($0) }
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
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

                    section("Appearance") {
                        VStack(spacing: 0) {
                            // Theme segmented control
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Theme")
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(ToolrollTheme.muted)
                                HStack(spacing: 2) {
                                    ForEach(AppearanceScheme.allCases) { item in
                                        let selected = appearance.scheme == item
                                        Button {
                                            withAnimation(.easeOut(duration: 0.16)) {
                                                appearance.scheme = item
                                            }
                                        } label: {
                                            Text(item.title)
                                                .font(.footnote.weight(selected ? .semibold : .medium))
                                                .foregroundStyle(selected ? ToolrollTheme.ink : ToolrollTheme.muted)
                                                .frame(maxWidth: .infinity, minHeight: 34)
                                                .background {
                                                    if selected {
                                                        RoundedRectangle(cornerRadius: 7.5, style: .continuous)
                                                            .fill(ToolrollTheme.surface)
                                                            .overlay(
                                                                RoundedRectangle(cornerRadius: 7.5, style: .continuous)
                                                                    .strokeBorder(ToolrollTheme.hairline, lineWidth: 0.75)
                                                            )
                                                    }
                                                }
                                                .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityAddTraits(selected ? .isSelected : [])
                                    }
                                }
                                .padding(3)
                                .background(ToolrollTheme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .strokeBorder(ToolrollTheme.hairline, lineWidth: 1)
                                )
                            }
                            .padding(14)

                            Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)

                            // Accent presets + custom color picker
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text("Accent")
                                        .font(.footnote.weight(.medium))
                                        .foregroundStyle(ToolrollTheme.muted)
                                    Spacer()
                                    Text(activeAccentLabel)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(ToolrollTheme.subtle)
                                }

                                HStack(spacing: 12) {
                                    ForEach(AccentPreset.all) { preset in
                                        accentSwatch(preset)
                                    }
                                    Spacer(minLength: 4)
                                    ColorPicker("", selection: customColorBinding, supportsOpacity: false)
                                        .labelsHidden()
                                        .frame(width: 32, height: 32)
                                        .accessibilityLabel("Pick a custom accent colour")
                                }
                            }
                            .padding(14)
                        }
                    }

                    if appState.isDemoMode || appState.pairedRecord != nil {
                        VStack(alignment: .leading, spacing: 6) {
                            section("Passkey approvals") {
                                VStack(spacing: 0) {
                                    keyValueRow("Passkey", value: passkeyStatusText, valueColor: passkeyStatusColor)

                                    if let windowText = passkeyWindowText {
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        keyValueRow("Prompt window", value: windowText)
                                    }

                                    if let unlockedText = passkeyUnlockedText {
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        keyValueRow("Session", value: unlockedText, valueColor: ToolrollTheme.success)
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        Button {
                                            Task { _ = await appState.lockPasskeyApprovals() }
                                        } label: {
                                            HStack {
                                                Label("Lock approvals now", systemImage: "lock.fill")
                                                    .font(.subheadline.weight(.semibold))
                                                    .foregroundStyle(ToolrollTheme.ink)
                                                Spacer()
                                                if appState.actionInFlight {
                                                    ProgressView()
                                                }
                                            }
                                            .padding(14)
                                            .frame(minHeight: 44)
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(!appState.canRunActions || appState.actionInFlight)
                                    }

                                    if !appState.isDemoMode {
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        Button {
                                            Task { _ = await appState.enrollPasskey() }
                                        } label: {
                                            HStack {
                                                Label(
                                                    appState.passkeyStatus?.registered == true ? "Add another passkey" : "Set up passkey",
                                                    systemImage: "person.badge.key.fill"
                                                )
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(appState.canRunActions ? appearance.signalText : ToolrollTheme.subtle)
                                                Spacer()
                                                if appState.actionInFlight {
                                                    ProgressView()
                                                }
                                            }
                                            .padding(14)
                                            .frame(minHeight: 44)
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(!appState.canRunActions || appState.actionInFlight)
                                    }

                                    if let feedback = appState.actionFeedback {
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        Text(feedback)
                                            .font(.footnote)
                                            .foregroundStyle(ToolrollTheme.success)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(14)
                                    } else if let error = appState.actionError {
                                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                                        Text(error)
                                            .font(.footnote)
                                            .foregroundStyle(ToolrollTheme.danger)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(14)
                                    }
                                }
                            }

                            Text("Verified locally on your Mac using Passkey user verification. Shipping PRs, landing locally, protected scopes, and exceptions always prompt your passkey.")
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.muted)
                                .padding(.horizontal, 4)
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
                            .tint(ToolrollTheme.subtle)
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
                                .tint(ToolrollTheme.subtle)
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
                        .foregroundStyle(appearance.signalText)
                }
            }
            .sensoryFeedback(.selection, trigger: appearance.accentHex)
            .sensoryFeedback(.selection, trigger: appearance.scheme)
            .task {
                await appState.refreshPasskeyStatus()
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

    private var activeAccentLabel: String {
        if let preset = AccentPreset.all.first(where: { $0.hex.uppercased() == appearance.accentHex.uppercased() }) {
            return preset.name
        }
        return appearance.accentHex
    }

    private func accentSwatch(_ preset: AccentPreset) -> some View {
        let selected = appearance.accentHex.uppercased() == preset.hex.uppercased()
        let fill: Color = preset.id == "ink"
            ? ToolrollTheme.ink
            : Color(uiColor: ToolrollAppearance.uiColor(hex: preset.hex) ?? .systemBlue)

        return Button {
            withAnimation(.easeOut(duration: 0.16)) {
                appearance.accentHex = preset.hex
            }
        } label: {
            ZStack {
                Circle()
                    .fill(fill)
                    .frame(width: 28, height: 28)
                    .overlay(
                        Circle()
                            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.22 : 0.12), lineWidth: 1)
                    )
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(preset.id == "ink" ? ToolrollTheme.onInk : Color.white)
                }
            }
            .padding(3)
            .overlay(
                Circle()
                    .strokeBorder(selected ? ToolrollTheme.ink : Color.clear, lineWidth: 1.5)
            )
            .frame(minWidth: 36, minHeight: 36)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(preset.name)
        .accessibilityAddTraits(selected ? .isSelected : [])
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

    private var passkeyStatusText: String {
        if appState.isDemoMode { return "Active · Demo passkey" }
        guard let status = appState.passkeyStatus else {
            return appState.isOffline ? "Unavailable offline" : "Checking…"
        }
        if status.registered {
            let n = status.count
            return n == 1 ? "Active · 1 passkey" : "Active · \(n) passkeys"
        }
        return status.enrollmentOpen ? "Ready to set up" : "Not set up"
    }

    private var passkeyStatusColor: Color {
        if appState.isDemoMode || appState.passkeyStatus?.registered == true {
            return ToolrollTheme.success
        }
        if appState.passkeyStatus?.enrollmentOpen == true {
            return appearance.signalText
        }
        return ToolrollTheme.muted
    }

    private var passkeyWindowText: String? {
        guard appState.isDemoMode || appState.passkeyStatus?.registered == true,
              let mins = appState.passkeyStatus?.windowMinutes else { return nil }
        switch mins {
        case 0: return "Every time"
        case 15: return "Once per 15 min"
        case 60: return "Once per hour"
        default: return "Once per \(mins) min"
        }
    }

    private var passkeyUnlockedText: String? {
        guard let until = RelativeTime.date(appState.passkeyStatus?.freshUntil), until > Date() else { return nil }
        return "Unlocked until \(until.formatted(date: .omitted, time: .shortened))"
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
