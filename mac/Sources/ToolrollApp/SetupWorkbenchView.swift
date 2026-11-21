import AppKit
import SwiftUI
import ToolrollCore

/// Distinctively Toolroll first-run & setup studio (Signal 1.0.0 monochrome hairlines).
/// Shows live Engine connection, detected coding agents + role routing (`GET /engine/agents` & `/engine/models`),
/// active repositories, a concise 3-step builder orientation, and optional remote team pairing.
public struct SetupWorkbenchView: View {
    @Bindable var store: WorkbenchStore
    @State private var showMoreAgents: Bool = false
    @State private var copiedHint: String?

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var machineName: String {
        Host.current().localizedName ?? "this Mac"
    }

    private var primaryAgents: [AgentRow] {
        let all = store.agentsRead.agents
        let active = all.filter { $0.ready || $0.state == "signed-in" || $0.state == "signed-out" }
        return active.isEmpty ? Array(all.prefix(4)) : active
    }

    private var otherAgents: [AgentRow] {
        let primaryIds = Set(primaryAgents.map(\.id))
        return store.agentsRead.agents.filter { !primaryIds.contains($0.id) }
    }

    private var readyCount: Int {
        store.agentsRead.agents.filter(\.ready).count
    }

    public var body: some View {
        ZStack {
            ToolrollPalette.ground.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Editorial header
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(ToolrollPalette.ink)
                                .frame(width: 12, height: 12)
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

                    // 1. Coding Agents & Role Routing
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("AGENTS ON THIS MAC")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            if let first = store.agentsRead.firstTask {
                                Text("Default · \(first.name)")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)

                        HairlineDivider()

                        if primaryAgents.isEmpty {
                            HStack(spacing: 10) {
                                Text("Start your local engine to inspect installed agents, or connect a remote workspace.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                                Spacer()
                                Button("Copy `toolroll up`") {
                                    copyCommand("toolroll up")
                                }
                                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                            }
                            .padding(16)
                        } else {
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                                ForEach(primaryAgents) { agent in
                                    agentTile(agent)
                                }
                            }
                            .padding(14)
                        }

                        if !otherAgents.isEmpty {
                            HairlineDivider()
                            VStack(alignment: .leading, spacing: 8) {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.15)) {
                                        showMoreAgents.toggle()
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: showMoreAgents ? "chevron.down" : "plus")
                                            .font(.system(size: 10, weight: .semibold))
                                        Text(showMoreAgents ? "Hide other supported agents" : "More supported agents (\(otherAgents.count))")
                                            .font(.system(size: 12, weight: .medium))
                                        Spacer()
                                    }
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                if showMoreAgents {
                                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 8) {
                                        ForEach(otherAgents) { agent in
                                            agentTile(agent)
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
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(ToolrollPalette.raised)
                        }
                    }
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                    // 2. Projects & How Toolroll Flows
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("REPOSITORIES & WORKFLOW")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Text("\(store.workRowsResponse.rows.count) active task\(store.workRowsResponse.rows.count == 1 ? "" : "s")")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)

                        HairlineDivider()

                        VStack(alignment: .leading, spacing: 12) {
                            if !store.allProjects.isEmpty {
                                HStack(spacing: 6) {
                                    ForEach(store.allProjects, id: \.self) { project in
                                        Text(project)
                                            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.ink)
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 4)
                                            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                                    }
                                    Spacer()
                                }
                            } else {
                                HStack {
                                    Text("Add any repository with `toolroll init` inside your project folder.")
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(ToolrollPalette.muted)
                                    Spacer()
                                    Button("Copy `toolroll init`") {
                                        copyCommand("toolroll init")
                                    }
                                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                                }
                            }

                            // Crisp 3-step Toolroll orientation
                            HStack(spacing: 10) {
                                workflowPill(step: "01", title: "File (⌘N)", detail: "Plan first or jump straight to code")
                                workflowPill(step: "02", title: "Approve In-App", detail: "Review digest-bound terms & diffs")
                                workflowPill(step: "03", title: "Ship / Hand Off", detail: "Open PR or share Live Terminal (⌘K)")
                            }
                        }
                        .padding(14)
                    }
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                    if let copiedHint {
                        Text(copiedHint)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.live)
                    }

                    // Bottom bar: Remote option + Solid-Ink CTA
                    HStack(spacing: 10) {
                        Button("Connect Remote Team Workspace…") {
                            store.isPairSheetOpen = true
                        }
                        .buttonStyle(KitButtonStyle(.ghost))

                        Button("Rescan") {
                            Task { await store.refreshSetupState() }
                        }
                        .buttonStyle(KitButtonStyle(.ghost))

                        Spacer()

                        Button {
                            store.completeSetup()
                        } label: {
                            HStack(spacing: 6) {
                                Text("Enter Workbench")
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 11, weight: .semibold))
                            }
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .keyboardShortcut(.return, modifiers: [])
                    }
                    .padding(.top, 4)
                }
                .frame(maxWidth: 680)
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
            return "\(readyCount) coding agent\(readyCount == 1 ? "" : "s") ready · connected directly to your local Toolroll engine."
        }
        if !store.activeProfile.isDemo {
            return "Connected to \(store.activeProfile.displayTitle) as @\(store.activeProfile.account)."
        }
        return "Previewing locally — start `toolroll up` or connect a remote workspace anytime."
    }

    private var engineStatusBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(store.isLocalSession || !store.activeProfile.isDemo ? ToolrollPalette.success : ToolrollPalette.muted)
                .frame(width: 6, height: 6)
            Text(store.isLocalSession
                 ? "Local Engine · \(store.activeProfile.origin.replacingOccurrences(of: "http://", with: ""))"
                 : (store.activeProfile.isDemo ? "Demo Preview" : store.activeProfile.displayTitle))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func agentTile(_ agent: AgentRow) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(agent.ready ? ToolrollPalette.success : (agent.state == "signed-out" ? ToolrollPalette.warning : ToolrollPalette.muted.opacity(0.45)))
                .frame(width: 7, height: 7)

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text(agentSubtitle(agent))
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if agent.ready {
                Text("Ready")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.success)
            } else if let cmd = agent.setup.signIn ?? agent.setup.install, !cmd.isEmpty {
                Button("Copy cmd") {
                    copyCommand(cmd)
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            } else {
                Text(agent.state.replacingOccurrences(of: "-", with: " "))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func agentSubtitle(_ agent: AgentRow) -> String {
        if let how = agent.how, !how.isEmpty { return how }
        if let next = agent.next, !next.isEmpty { return next }
        if agent.state == "signed-out" { return "Installed · sign in to enable" }
        if agent.state == "not-installed" { return agent.setup.install ?? "Not installed" }
        return agent.state
    }

    private func workflowPill(step: String, title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Text(step)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
            }
            Text(detail)
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func copyCommand(_ cmd: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
        copiedHint = "Copied `\(cmd)` to clipboard."
    }
}
