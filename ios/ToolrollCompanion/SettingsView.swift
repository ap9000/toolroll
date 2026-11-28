import SwiftUI
import ToolrollCompanionCore

/// Settings, approvals first: Paired Mac → Passkey approvals → Security and details → Appearance → Remove.
struct SettingsView: View {
    @Bindable var appState: CompanionAppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.toolrollAppearance) private var appearance
    @State private var confirmUnpair = false
    @State private var removing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if appState.isDemoMode {
                        section("Demo") {
                            VStack(spacing: 0) {
                                Text("You're looking at sample work. Nothing leaves this iPhone.")
                                    .font(.subheadline)
                                    .foregroundStyle(ToolrollTheme.muted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(16)
                                divider
                                Button {
                                    appState.exitDemoMode()
                                    dismiss()
                                } label: {
                                    HStack {
                                        Text("Exit demo").font(.system(size: 15, weight: .medium)).foregroundStyle(ToolrollTheme.ink)
                                        Spacer()
                                        Image(systemName: "rectangle.portrait.and.arrow.right").font(.footnote).foregroundStyle(ToolrollTheme.muted)
                                    }
                                    .padding(16)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    } else if appState.pairedRecord != nil {
                        section("Paired Mac") {
                            HStack(spacing: 12) {
                                Image(systemName: "laptopcomputer").font(.title3).foregroundStyle(ToolrollTheme.ink).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(appState.workspaceLabel).font(.system(size: 16, weight: .medium)).foregroundStyle(ToolrollTheme.ink)
                                    Text(statusText).font(.footnote).foregroundStyle(statusColor)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 14)
                            .accessibilityElement(children: .combine)
                        }
                    }

                    if appState.isDemoMode || appState.pairedRecord != nil {
                        passkeySection
                        Text("Shipping, landing, protected work and exceptions always ask for your passkey.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                            .padding(.horizontal, 6)
                            .padding(.top, 2)
                    }

                    section("Security and details") {
                        VStack(spacing: 0) {
                            NavigationLink {
                                ScrollView { HowItsSecured().padding(20) }
                                    .background(ToolrollTheme.paper.ignoresSafeArea())
                                    .navigationTitle("How it's secured")
                                    .navigationBarTitleDisplayMode(.inline)
                            } label: {
                                linkRow("How it's secured")
                            }
                            if let record = appState.pairedRecord, !appState.isDemoMode {
                                divider
                                NavigationLink {
                                    deviceDetails(record)
                                } label: {
                                    linkRow("Device details")
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }

                    section("Appearance") {
                        HStack {
                            Text("Theme").font(.system(size: 15)).foregroundStyle(ToolrollTheme.ink)
                            Spacer(minLength: 12)
                            HStack(spacing: 0) {
                                ForEach(AppearanceScheme.allCases) { item in
                                    let selected = appearance.scheme == item
                                    Button {
                                        withAnimation(.easeOut(duration: 0.16)) { appearance.scheme = item }
                                    } label: {
                                        Text(item.title)
                                            .font(.footnote.weight(selected ? .semibold : .medium))
                                            .foregroundStyle(selected ? ToolrollTheme.ink : ToolrollTheme.body)
                                            .padding(.horizontal, 12)
                                            .frame(minHeight: 32)
                                            .background {
                                                if selected { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(ToolrollTheme.surface) }
                                            }
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityAddTraits(selected ? .isSelected : [])
                                }
                            }
                            .padding(3)
                            .background(ToolrollTheme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }

                    if !appState.isDemoMode && appState.pairedRecord != nil {
                        Button(role: .destructive) {
                            confirmUnpair = true
                        } label: {
                            HStack(spacing: 8) {
                                Text(appState.isTerminal ? "Remove from this iPhone…" : "Remove this iPhone…")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(ToolrollTheme.danger)
                                if removing { ProgressView().accessibilityLabel("Removing") }
                            }
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(removing)
                        .card()
                        .padding(.top, 26)
                        Text(appState.isTerminal
                            ? "Removes the pairing and its keys from this iPhone. Your Mac already removed it."
                            : "Removes the keys from this iPhone and asks your Mac to forget it.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                            .padding(.horizontal, 6)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .buttonStyle(.borderedProminent)
                        .tint(ToolrollTheme.ink)
                        .foregroundStyle(ToolrollTheme.onInk)
                }
            }
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

    // MARK: Passkey approvals

    private var registered: Bool { appState.isDemoMode || appState.passkeyStatus?.registered == true }
    private var macWindow: Int? { appState.passkeyStatus?.windowMinutes }

    private var passkeySection: some View {
        section("Passkey approvals") {
            VStack(spacing: 0) {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    unlockRow(now: context.date)
                }
                divider
                HStack(spacing: 12) {
                    labelStack("Passkey prompt", "Set on your Mac in Settings → Phone")
                    Spacer(minLength: 8)
                    Text(windowText).font(.system(size: 15)).foregroundStyle(ToolrollTheme.body)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .accessibilityElement(children: .combine)
                divider
                Toggle(isOn: $appState.unlockOnOpen) {
                    labelStack("Unlock approvals when I open Toolroll", "One \(DeviceUnlockName.current) when you open the app covers routine approvals")
                }
                .tint(ToolrollTheme.toggleOn)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                if appState.unlockOnOpen, let macWindow, macWindow > 0 {
                    divider
                    HStack(spacing: 12) {
                        labelStack("Unlock lasts", "Up to \(macWindow) min, the most your Mac allows")
                        Spacer(minLength: 8)
                        Picker("Unlock lasts", selection: Binding(
                            get: { AppLockPolicy.minutes(chosen: appState.unlockMinutes, macWindow: macWindow) },
                            set: { appState.unlockMinutes = $0 }
                        )) {
                            ForEach(AppLockPolicy.lengths(macWindow: macWindow), id: \.self) { minutes in
                                Text("\(minutes) min").tag(minutes)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(ToolrollTheme.ink)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                divider
                Toggle(isOn: $appState.alwaysAsk) {
                    labelStack("Always ask on this iPhone", "\(DeviceUnlockName.current) for every approval, whatever the Mac allows")
                }
                .tint(ToolrollTheme.toggleOn)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                divider
                passkeyRows
                if !appState.isDemoMode {
                    divider
                    Button {
                        Task { _ = await appState.enrollPasskey() }
                    } label: {
                        HStack {
                            Text(registered ? "Add another passkey" : "Set up passkey")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(appState.canRunActions ? ToolrollTheme.ink : ToolrollTheme.subtle)
                            Spacer()
                            if appState.actionInFlight { ProgressView() }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!appState.canRunActions || appState.actionInFlight)
                }
                if let message = appState.passkeyMessage {
                    divider
                    Text(message.text)
                        .font(.footnote)
                        .foregroundStyle(message.isError ? ToolrollTheme.danger : ToolrollTheme.success)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
            }
        }
    }

    @ViewBuilder
    private func unlockRow(now: Date) -> some View {
        if let until = appState.approvalsUnlockedUntil(now: now) {
            HStack(spacing: 12) {
                Image(systemName: "lock.open").font(.body).foregroundStyle(ToolrollTheme.ink).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Approvals unlocked").font(.system(size: 15, weight: .medium)).foregroundStyle(ToolrollTheme.ink)
                    (Text("until ") + Text(until.formatted(date: .omitted, time: .shortened)).font(.footnote.monospaced()) + Text(" on this iPhone"))
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                }
                Spacer(minLength: 8)
                Button("Lock now") { Task { _ = await appState.lockPasskeyApprovals() } }
                    .buttonStyle(PillButtonStyle(filled: true))
                    .disabled(appState.actionInFlight)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        } else {
            HStack(spacing: 12) {
                Image(systemName: "lock").font(.body).foregroundStyle(ToolrollTheme.ink).accessibilityHidden(true)
                labelStack(registered ? "Approvals locked" : "No passkey yet", lockedDetail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityElement(children: .combine)
        }
    }

    private var lockedDetail: String {
        if !registered {
            return appState.passkeyStatus?.enrollmentOpen == true
                ? "Your Mac is ready: set up a passkey below."
                : "On your Mac, open Settings → Phone and choose Enable passkey on iPhone."
        }
        if appState.isOffline { return "Approvals are paused until your Mac is back." }
        if appState.alwaysAsk { return "Each approval asks for your passkey (Always ask is on)." }
        if macWindow == 0 { return "Each approval asks for your passkey (set on your Mac)." }
        return "The next approval asks for your passkey."
    }

    @ViewBuilder
    private var passkeyRows: some View {
        if let list = appState.passkeyStatus?.passkeys, !list.isEmpty {
            ForEach(Array(list.enumerated()), id: \.offset) { index, key in
                if index > 0 { divider }
                HStack(spacing: 12) {
                    labelStack(key.label, addedText(key.createdAt))
                    Spacer(minLength: 8)
                    Text("Active").font(.subheadline).foregroundStyle(ToolrollTheme.success)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .accessibilityElement(children: .combine)
            }
        } else {
            HStack(spacing: 12) {
                labelStack("Passkeys", passkeyCountText)
                Spacer(minLength: 8)
                Text(registered ? "Active" : (appState.passkeyStatus == nil ? "" : "Not set up"))
                    .font(.subheadline)
                    .foregroundStyle(registered ? ToolrollTheme.success : ToolrollTheme.muted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityElement(children: .combine)
        }
    }

    private func addedText(_ iso: String?) -> String {
        guard let date = RelativeTime.date(iso) else { return "iCloud Keychain" }
        return "Added \(date.formatted(.dateTime.month(.abbreviated).day())) · iCloud Keychain"
    }

    private var passkeyCountText: String {
        guard let status = appState.passkeyStatus else { return appState.isOffline ? "Unavailable offline" : "Checking…" }
        if status.count == 0 { return "None on your account yet" }
        return status.count == 1 ? "1 on your account" : "\(status.count) on your account"
    }

    private var windowText: String {
        guard let mins = macWindow else { return appState.isOffline ? "—" : "Checking…" }
        switch mins {
        case 0: return "Every approval"
        case 60: return "Once per hour"
        default: return "Once per \(mins) min"
        }
    }

    // MARK: Bits

    private var divider: some View {
        Divider().overlay(ToolrollTheme.hairline)
    }

    private func labelStack(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 15)).foregroundStyle(ToolrollTheme.ink)
            Text(detail).font(.footnote).foregroundStyle(ToolrollTheme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func linkRow(_ title: String) -> some View {
        HStack {
            Text(title).font(.system(size: 15)).foregroundStyle(ToolrollTheme.ink)
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(ToolrollTheme.ink).accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(title)
                .padding(.horizontal, 4)
                .padding(.top, 12)
            content()
                .card()
        }
    }

    private func deviceDetails(_ record: PairedWorkspaceRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                detail("Paired", record.pairedAt.formatted(date: .abbreviated, time: .shortened))
                detail("This iPhone", record.deviceId)
                detail("Workspace", record.workspaceId)
                detail("Machine", record.machineId)
                if let connectionText { detail("Connection", connectionText) }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
            .padding(16)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .navigationTitle("Device details")
        .navigationBarTitleDisplayMode(.inline)
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
        case .direct: return "Connected · same Wi‑Fi"
        case .hosted: return path.host.map { "Connected through \($0)" } ?? "Connected through the relay"
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(ToolrollTheme.muted)
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
