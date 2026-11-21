import AppKit
import SwiftUI
import ToolrollCore

/// Distinctively Toolroll Setup & Agents Studio (Signal 1.0.0 monochrome hairlines).
/// Calm, minimal, zero cryptic buttons: shows Ready agents up front, tucks unavailable CLIs cleanly
/// with explicit commands, lets you pick models right inline via `ModelPickerPopover`, and keeps remote pairing subtle.
public struct SetupWorkbenchView: View {
    @Bindable var store: WorkbenchStore
    @State private var showMoreAgents: Bool = false
    @State private var isModelPickerOpen: Bool = false
    @State private var copiedHint: String?

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
                    // Header
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

                    // Card 1: Agents & Interactive Model Routing
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
                            HStack(spacing: 10) {
                                Text("No signed-in coding agents detected yet. Expand below to see sign-in commands.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                                Spacer()
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

                        if !otherAgents.isEmpty {
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

                        // Clickable live role routing bar (Planner · Builder · Reviewer)
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

                    // Card 2: Repositories (with 1-click native Finder Add Folder)
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

                        HStack(spacing: 8) {
                            if !store.allProjects.isEmpty {
                                ForEach(store.allProjects, id: \.self) { project in
                                    Text(project)
                                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                                }
                            } else {
                                Text("Add a local Git repository folder to start building.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                            }
                            Spacer()
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

                    // Bottom bar: Subtle remote option + Solid-Ink Enter CTA
                    HStack(spacing: 10) {
                        Button("Connect Team / Remote Server…") {
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
                                Text("Start Building")
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 11, weight: .semibold))
                            }
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .keyboardShortcut(.return, modifiers: [])
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
                 ? "Local Engine · \(store.activeProfile.origin.replacingOccurrences(of: "http://", with: ""))"
                 : store.activeProfile.displayTitle)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func readyAgentTile(_ agent: AgentRow) -> some View {
        HStack(spacing: 10) {
            Circle().fill(ToolrollPalette.success).frame(width: 7, height: 7)
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
            Text("Ready")
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(ToolrollPalette.success)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func setupAgentRow(_ agent: AgentRow) -> some View {
        let cmd = agent.setup.signIn ?? agent.setup.install
        let isSignIn = agent.state == "signed-out"
        return HStack(spacing: 10) {
            Circle()
                .fill(isSignIn ? ToolrollPalette.warning : ToolrollPalette.muted.opacity(0.4))
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(agent.name)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text(isSignIn ? "Needs sign-in" : "Not installed")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                if let cmd, !cmd.isEmpty {
                    Text("Run in terminal: \(cmd)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
            }

            Spacer()

            if let cmd, !cmd.isEmpty {
                Button(isSignIn ? "Copy sign-in" : "Copy install") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cmd, forType: .string)
                    copiedHint = "Copied `\(cmd)` — paste into your terminal to \(isSignIn ? "sign in" : "install") \(agent.name)."
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }
}
