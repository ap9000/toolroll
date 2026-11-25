import AppKit
import SwiftUI
import ToolrollCore

public struct SetupWorkbenchView: View {
    @Bindable var store: WorkbenchStore
    @State private var showMoreAgents: Bool = false
    @State private var showMoreOptions: Bool = false
    @State private var showAllDiscoveredRepos: Bool = false
    @State private var connectingRepoPath: String? = nil
    @State private var isModelPickerOpen: Bool = false
    @State private var confirmingInstallAgent: AgentRow? = nil

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var machineName: String {
        Host.current().localizedName ?? "this Mac"
    }

    private var readyAgents: [AgentRow] {
        store.agentsRead.agents.filter(\.ready)
    }

    private var otherAgents: [AgentRow] {
        store.agentsRead.agents.filter { !$0.ready }
    }

    public var body: some View {
        ZStack {
            ToolrollPalette.ground.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(ToolrollPalette.ink)
                                .frame(width: 11, height: 11)
                            Text("TOOLROLL")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .tracking(1.4)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            engineStatusBadge
                        }

                        Text("Ready on \(machineName)")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)

                        Text(subtitleText)
                            .font(.system(size: 13.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .padding(.top, 12)

                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("AGENTS & MODELS")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Button {
                                isModelPickerOpen.toggle()
                            } label: {
                                HStack(spacing: 4) {
                                    Text("Change models")
                                        .font(.system(size: 11.5, weight: .medium))
                                    Image(systemName: "chevron.down")
                                        .font(.system(size: 8.5, weight: .semibold))
                                }
                                .foregroundStyle(ToolrollPalette.ink)
                            }
                            .buttonStyle(.plain)
                            .popover(isPresented: $isModelPickerOpen, arrowEdge: .bottom) {
                                ModelPickerPopover(store: store, initialRoleKey: "all", onDismiss: { isModelPickerOpen = false })
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)

                        HairlineDivider()

                        if readyAgents.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("No signed-in coding agents detected yet. Sign in to any agent below to start.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                                if !otherAgents.isEmpty {
                                    VStack(spacing: 8) {
                                        ForEach(otherAgents) { agent in
                                            setupAgentRow(agent)
                                        }
                                    }
                                }
                            }
                            .padding(16)
                        } else {
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                                ForEach(readyAgents) { agent in
                                    readyAgentTile(agent)
                                }
                            }
                            .padding(14)
                        }

                        if !readyAgents.isEmpty && !otherAgents.isEmpty {
                            HairlineDivider()
                            VStack(alignment: .leading, spacing: 8) {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.14)) {
                                        showMoreAgents.toggle()
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: showMoreAgents ? "chevron.down" : "plus")
                                            .font(.system(size: 10, weight: .semibold))
                                        Text(showMoreAgents ? "Hide other agents" : "Add another agent (\(otherAgents.count) available)")
                                            .font(.system(size: 12, weight: .medium))
                                        Spacer()
                                    }
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                if showMoreAgents {
                                    VStack(spacing: 8) {
                                        ForEach(otherAgents) { agent in
                                            setupAgentRow(agent)
                                        }
                                    }
                                    .padding(.top, 4)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                        }

                        if !store.modelsRead.roles.isEmpty {
                            HairlineDivider()
                            Button {
                                isModelPickerOpen.toggle()
                            } label: {
                                HStack(spacing: 16) {
                                    ForEach(store.modelsRead.roles) { role in
                                        HStack(spacing: 5) {
                                            Text(role.label)
                                                .font(.system(size: 11, weight: .semibold))
                                                .foregroundStyle(ToolrollPalette.muted)
                                            Text(role.words)
                                                .font(.system(size: 11, design: .monospaced))
                                                .foregroundStyle(ToolrollPalette.ink)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "slider.horizontal.3")
                                        .font(.system(size: 11))
                                        .foregroundStyle(ToolrollPalette.muted)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .background(ToolrollPalette.raised)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("PROJECTS")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Button {
                                store.pickAndAddLocalFolder()
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "folder.badge.plus")
                                        .font(.system(size: 11))
                                    Text("Add folder…")
                                        .font(.system(size: 11.5, weight: .medium))
                                }
                                .foregroundStyle(ToolrollPalette.ink)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)

                        HairlineDivider()

                        VStack(alignment: .leading, spacing: 12) {
                            if !store.allProjects.isEmpty {
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading, spacing: 8) {
                                    ForEach(store.allProjects, id: \.self) { project in
                                        HStack(spacing: 6) {
                                            Circle()
                                                .fill(ToolrollPalette.success)
                                                .frame(width: 6, height: 6)
                                            Text(project)
                                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                                .foregroundStyle(ToolrollPalette.ink)
                                                .lineLimit(1)
                                                .truncationMode(.tail)
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
                                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                                    }
                                }
                            } else if store.unconnectedGitRepos.isEmpty {
                                Text("Add a local Git repository folder to start building.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                            }

                            if !store.unconnectedGitRepos.isEmpty {
                                let discovered = store.unconnectedGitRepos
                                let visible = showAllDiscoveredRepos ? discovered : Array(discovered.prefix(6))
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Text(store.allProjects.isEmpty ? "FOUND ON THIS MAC — CLICK TO CONNECT" : "MORE REPOSITORIES ON THIS MAC")
                                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                            .tracking(0.6)
                                            .foregroundStyle(ToolrollPalette.muted)
                                        Spacer()
                                        if discovered.count > 6 {
                                            Button(showAllDiscoveredRepos ? "Show fewer" : "Show all \(discovered.count)") {
                                                withAnimation(.easeInOut(duration: 0.14)) {
                                                    showAllDiscoveredRepos.toggle()
                                                }
                                            }
                                            .buttonStyle(.plain)
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundStyle(ToolrollPalette.muted)
                                        }
                                    }

                                    VStack(spacing: 6) {
                                        ForEach(visible) { repo in
                                            discoveredRepoRow(repo)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(14)
                    }
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                    if let setupTitle = store.activeAgentSetupTitle {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Circle().fill(ToolrollPalette.live).frame(width: 6, height: 6)
                                Text(setupTitle)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundStyle(ToolrollPalette.ink)
                                Spacer()
                                Button("Done — Check Status") {
                                    Task { await store.finishAgentSetupAndRecheck() }
                                }
                                .buttonStyle(KitButtonStyle(.primary, compact: true))
                            }
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 2) {
                                    ForEach(store.terminalSession.renderLines) { line in
                                        Text(line.plainText)
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.ink)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                                .padding(10)
                            }
                            .frame(height: 150)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                        }
                        .padding(14)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1))
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            if !store.isLocalSession && store.activeProfile.isDemo {
                                Button("Start Local Engine") {
                                    Task { await store.startLocalEngine() }
                                }
                                .buttonStyle(KitButtonStyle(.ghost))
                            }

                            Button {
                                withAnimation(.easeInOut(duration: 0.14)) {
                                    showMoreOptions.toggle()
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: showMoreOptions ? "chevron.down" : "ellipsis")
                                        .font(.system(size: 10.5, weight: .semibold))
                                    Text("More options")
                                        .font(.system(size: 12, weight: .medium))
                                }
                                .foregroundStyle(ToolrollPalette.muted)
                            }
                            .buttonStyle(.plain)

                            Spacer()

                            if let firstProject = store.allProjects.first {
                                Button("Start chat in \(firstProject)") {
                                    store.startFirstChatFromSetup(in: firstProject)
                                }
                                .buttonStyle(KitButtonStyle(.ghost))
                            }

                            Button {
                                store.completeSetup()
                            } label: {
                                HStack(spacing: 6) {
                                    Text("Start working")
                                    Image(systemName: "arrow.right")
                                        .font(.system(size: 11, weight: .semibold))
                                }
                            }
                            .buttonStyle(KitButtonStyle(.primary))
                            .keyboardShortcut(.return, modifiers: [])
                        }

                        if showMoreOptions {
                            HStack(spacing: 10) {
                                Button("Connect Remote Server…") {
                                    store.isPairSheetOpen = true
                                }
                                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                                Button("Pair Phone (QR)…") {
                                    store.isPhonePairSheetOpen = true
                                }
                                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                                Button("Rescan") {
                                    Task { await store.refreshSetupState() }
                                }
                                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                                Spacer()
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .frame(maxWidth: 660)
                .padding(.horizontal, 28)
                .padding(.vertical, 36)
                .frame(maxWidth: .infinity)
            }
        }
        .task {
            await store.refreshSetupState()
        }
    }

    private var subtitleText: String {
        if let firstLine = store.agentsRead.lines.first, !firstLine.isEmpty {
            return firstLine
        }
        if store.isLocalSession {
            return "\(readyAgents.count) agent\(readyAgents.count == 1 ? "" : "s") ready on this Mac."
        }
        return "Connected to \(store.activeProfile.displayTitle)."
    }

    private var engineStatusBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(store.isLocalSession || !store.activeProfile.isDemo ? ToolrollPalette.success : ToolrollPalette.muted)
                .frame(width: 6, height: 6)
            Text(store.isLocalSession
                 ? "Running locally"
                 : store.activeProfile.displayTitle)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func readyAgentTile(_ agent: AgentRow) -> some View {
        HStack(spacing: 10) {
            ProviderBrandGlyph(provider: agent.id, size: 18, tinted: false, inTile: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                if let how = agent.how, !how.isEmpty {
                    Text(how)
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
            }
            Spacer()
            HStack(spacing: 4) {
                Circle().fill(ToolrollPalette.success).frame(width: 6, height: 6)
                Text("Ready")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.success)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func discoveredRepoRow(_ repo: DiscoveredGitRepo) -> some View {
        let isBusy = connectingRepoPath == repo.path
        let displayPath = repo.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~")
        return HStack(spacing: 10) {
            Image(systemName: "folder")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(repo.name)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    if let branch = repo.branch, !branch.isEmpty {
                        Text(branch)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                }
                Text(displayPath)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            Button(isBusy ? "Connecting…" : "Connect") {
                guard connectingRepoPath == nil else { return }
                connectingRepoPath = repo.path
                Task {
                    await store.addLocalProject(path: repo.path)
                    connectingRepoPath = nil
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(connectingRepoPath != nil)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func setupAgentRow(_ agent: AgentRow) -> some View {
        let isSignIn = agent.state == "signed-out"
        let confirming = confirmingInstallAgent?.id == agent.id

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(isSignIn ? ToolrollPalette.warning : ToolrollPalette.muted.opacity(0.4))
                    .frame(width: 6, height: 6)

                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text(isSignIn ? "Installed on this Mac — sign in to enable" : (agent.setup.note ?? "Available to install"))
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }

                Spacer()

                if isSignIn && agent.setup.canSignIn {
                    Button("Sign in") {
                        Task { await store.runAgentSetup(kind: "sign-in", agent: agent) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                } else if !isSignIn && agent.setup.canInstall {
                    Button(confirming ? "Cancel" : "Install") {
                        confirmingInstallAgent = confirming ? nil : agent
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                } else if isSignIn {
                    Button("Sign in") {
                        Task { await store.runAgentSetup(kind: "sign-in", agent: agent) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                } else {
                    Text("External install")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }

            if confirming, let installCmd = agent.setup.install {
                HStack(spacing: 8) {
                    Text("Install \(agent.name)? (\(installCmd))")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                    Spacer()
                    Button("Confirm Install") {
                        confirmingInstallAgent = nil
                        Task { await store.runAgentSetup(kind: "install", agent: agent) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }
}
