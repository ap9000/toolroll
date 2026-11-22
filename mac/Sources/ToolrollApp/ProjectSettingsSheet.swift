import AppKit
import SwiftUI
import ToolrollCore

/// Native in-app Project Settings sheet — Live View (show/hide shell commands),
/// Worktree Setup (dependencies for offline Codex), Network & Localhost (`listen EPERM`),
/// and Parallel Builds — zero web browser redirects needed.
public struct ProjectSettingsSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedProjectName: String = ""
    @State private var isLoading: Bool = false
    @State private var feedback: (isError: Bool, text: String)? = nil

    // Live view password
    @State private var liveViewPassword: String = ""

    // Worktree setup
    @State private var setupCommand: String = ""
    @State private var setupPassword: String = ""

    // Network & localhost
    @State private var networkLocalAny: Bool = false
    @State private var networkOpen: Bool = false
    @State private var networkHosts: String = ""
    @State private var networkPassword: String = ""

    // Concurrency
    @State private var concurrency: Int = 1

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var activeRepoPath: String? {
        store.localFolderPath(for: selectedProjectName)
            ?? store.terminalsResponse?.projects?.first(where: {
                $0.name.caseInsensitiveCompare(selectedProjectName) == .orderedSame
            })?.path
            ?? store.terminalsResponse?.projects?.first?.path
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("Project Settings")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)

                if !store.allProjects.isEmpty {
                    Menu {
                        ForEach(store.allProjects, id: \.self) { proj in
                            Button {
                                selectedProjectName = proj
                                Task { await loadSettings() }
                            } label: {
                                HStack {
                                    Text(proj)
                                    if proj == selectedProjectName { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(selectedProjectName.isEmpty ? "Select project" : selectedProjectName)
                                .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 8.5, weight: .semibold))
                        }
                        .foregroundStyle(ToolrollPalette.ink)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(ToolrollPalette.raised, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                }

                Spacer()

                if isLoading {
                    ProgressView().controlSize(.small)
                }

                Button {
                    store.isProjectSettingsOpen = false
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)

            HairlineDivider()

            if let fb = feedback {
                HStack(spacing: 8) {
                    Circle()
                        .fill(fb.isError ? ToolrollPalette.danger : ToolrollPalette.success)
                        .frame(width: 6, height: 6)
                    Text(fb.text)
                        .font(.system(size: 12))
                        .foregroundStyle(fb.isError ? ToolrollPalette.danger : ToolrollPalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button {
                        feedback = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 9)
                .background(ToolrollPalette.raised)
                HairlineDivider()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let snap = store.projectSettingsSnapshot {
                        liveViewSection(snap)
                        networkSection(snap)
                        worktreeSetupSection(snap)
                        concurrencySection(snap)
                    } else if isLoading {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Loading settings for \(selectedProjectName)…")
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.vertical, 24)
                    } else {
                        Text("Select a connected project above to manage its settings in-app.")
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.vertical, 16)
                    }
                }
                .padding(18)
            }
        }
        .frame(width: 560, height: 590)
        .background(ToolrollPalette.paper)
        .onAppear {
            selectedProjectName = store.projectSettingsTargetName
                ?? store.selectedRow?.project
                ?? store.activeProject
                ?? store.selectedProject
                ?? store.allProjects.first
                ?? ""
            Task { await loadSettings() }
        }
    }

    // MARK: - Section 1: Live View (Show Shell Commands)

    private func liveViewSection(_ snap: ToolrollClient.ProjectSettingsSnapshot) -> some View {
        settingsCard(
            title: "Live View · Shell Commands",
            badge: snap.liveCommandsShown ? "Commands shown" : "Commands hidden",
            badgeActive: snap.liveCommandsShown,
            subtitle: snap.liveCommandsShown
                ? "Shell commands and stdout appear in Agent Activity from the next run."
                : "Shell commands are hidden by default so secrets aren't logged. Turn this on to see exact commands and output on future runs."
        ) {
            if snap.liveCommandsShown {
                HStack {
                    Button("Hide Commands") {
                        Task { await toggleLiveCommands(snap: snap, show: false) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    Spacer()
                }
            } else {
                HStack(spacing: 8) {
                    SecureField("Toolroll password to enable…", text: $liveViewPassword)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        .onSubmit {
                            Task { await toggleLiveCommands(snap: snap, show: true) }
                        }

                    Button("Show Commands") {
                        Task { await toggleLiveCommands(snap: snap, show: true) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(liveViewPassword.isEmpty)
                }
            }
        }
    }

    // MARK: - Section 2: Network & Local Services (Fixes `listen EPERM`)

    private func networkSection(_ snap: ToolrollClient.ProjectSettingsSnapshot) -> some View {
        settingsCard(
            title: "Network & Local Services",
            badge: snap.networkLocalAny ? "Localhost allowed" : "Localhost blocked",
            badgeActive: snap.networkLocalAny,
            subtitle: "Allowing local services lets Vite/Nitro prerendering and local test servers bind localhost ports on Mac. Applies to newly scoped tasks."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: $networkLocalAny) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Allow this Mac's local services (localhost / ::1)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text("Required for prerender servers (`vite build`) and local test servers.")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.small)

                Toggle(isOn: $networkOpen) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Open outbound network")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text("Off = agent provider + package registries + extra hosts below.")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.small)

                if !networkOpen {
                    TextField("Extra allowed hosts (comma or space separated, e.g. api.stripe.com)", text: $networkHosts)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11.5, design: .monospaced))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                }

                HStack(spacing: 8) {
                    SecureField("Toolroll password to save network…", text: $networkPassword)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        .onSubmit {
                            Task { await saveNetwork(snap: snap) }
                        }

                    Button("Save Network") {
                        Task { await saveNetwork(snap: snap) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(networkPassword.isEmpty)
                }
            }
        }
    }

    // MARK: - Section 3: Worktree Setup Command

    private func worktreeSetupSection(_ snap: ToolrollClient.ProjectSettingsSnapshot) -> some View {
        settingsCard(
            title: "Worktree Setup",
            badge: nil,
            badgeActive: false,
            subtitle: "Runs once in every fresh worktree before offline agents (like Codex) start so `node_modules` and CLI tools are ready."
        ) {
            VStack(alignment: .leading, spacing: 8) {
                TextField("e.g. pnpm install --frozen-lockfile", text: $setupCommand)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11.5, design: .monospaced))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

                HStack(spacing: 8) {
                    SecureField("Toolroll password to approve setup…", text: $setupPassword)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        .onSubmit {
                            Task { await saveSetup(snap: snap) }
                        }

                    Button("Approve Setup") {
                        Task { await saveSetup(snap: snap) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(setupCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || setupPassword.isEmpty)
                }
            }
        }
    }

    // MARK: - Section 4: Parallel Builds

    private func concurrencySection(_ snap: ToolrollClient.ProjectSettingsSnapshot) -> some View {
        settingsCard(
            title: "Parallel Builds",
            badge: "Up to \(concurrency)",
            badgeActive: false,
            subtitle: "How many agent builds can run simultaneously in this project."
        ) {
            HStack(spacing: 10) {
                Stepper(value: $concurrency, in: 1...8) {
                    Text("\(concurrency) \(concurrency == 1 ? "build" : "builds") at once")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                }
                Spacer()
                Button("Save") {
                    Task { await saveConcurrency(snap: snap) }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
    }

    // MARK: - Card Container

    private func settingsCard<Content: View>(
        title: String,
        badge: String?,
        badgeActive: Bool,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                if let badge {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(badgeActive ? ToolrollPalette.success : ToolrollPalette.muted.opacity(0.6))
                            .frame(width: 5.5, height: 5.5)
                        Text(badge)
                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(badgeActive ? ToolrollPalette.ink : ToolrollPalette.muted)
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(ToolrollPalette.paper, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
            }
            Text(subtitle)
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    // MARK: - Actions

    private func loadSettings() async {
        guard let repoPath = activeRepoPath else { return }
        isLoading = true
        defer { isLoading = false }
        if let snap = await store.loadProjectSettings(repoPath: repoPath) {
            networkLocalAny = snap.networkLocalAny
            networkOpen = snap.networkOpen
            networkHosts = snap.networkHosts
            concurrency = snap.concurrency
            if setupCommand.isEmpty {
                setupCommand = snap.suggestedSetupCommand
            }
        }
    }

    private func toggleLiveCommands(snap: ToolrollClient.ProjectSettingsSnapshot, show: Bool) async {
        let pw = liveViewPassword
        liveViewPassword = ""
        isLoading = true
        defer { isLoading = false }
        let res = await store.updateProjectLiveCommands(
            repoPath: snap.repoPath,
            show: show,
            nonce: snap.liveViewNonce,
            password: pw
        )
        feedback = (res.ok == false, res.message)
        if res.ok {
            await loadSettings()
        }
    }

    private func saveNetwork(snap: ToolrollClient.ProjectSettingsSnapshot) async {
        let pw = networkPassword
        networkPassword = ""
        isLoading = true
        defer { isLoading = false }
        let res = await store.updateProjectNetwork(
            repoPath: snap.repoPath,
            open: networkOpen,
            localAny: networkLocalAny,
            hosts: networkHosts,
            password: pw
        )
        feedback = (res.ok == false, res.message)
        if res.ok {
            await loadSettings()
        }
    }

    private func saveSetup(snap: ToolrollClient.ProjectSettingsSnapshot) async {
        let pw = setupPassword
        setupPassword = ""
        isLoading = true
        defer { isLoading = false }
        let ok = await store.approveProjectWorktreeSetup(
            repoPath: snap.repoPath,
            command: setupCommand,
            password: pw
        )
        feedback = (!ok, store.notice?.message ?? (ok ? "Saved worktree setup." : "Could not approve setup."))
    }

    private func saveConcurrency(snap: ToolrollClient.ProjectSettingsSnapshot) async {
        isLoading = true
        defer { isLoading = false }
        let res = await store.updateProjectConcurrency(repoPath: snap.repoPath, concurrency: concurrency)
        feedback = (res.ok == false, res.message)
        if res.ok {
            await loadSettings()
        }
    }
}
