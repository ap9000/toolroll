import AppKit
import SwiftUI
import ToolrollCore

public struct NewWorkCanvasView: View {
    @Bindable var store: WorkbenchStore

    enum ComposeMode: String, CaseIterable, Identifiable {
        case chat = "Chat"
        case planFirst = "Plan first"
        case justCode = "Just code"
        case askLead = "Ask Lead"
        var id: String { rawValue }
    }

    @State private var promptText: String = ""
    @State private var attachments: [ComposerAttachment] = []
    @State private var mode: ComposeMode = .chat
    @State private var isWorkspaceWide: Bool = false
    @State private var isModelPickerOpen: Bool = false
    @State private var isDropTargeted: Bool = false
    @State private var isComposerDropTargeted: Bool = false
    @FocusState private var promptFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var resolvedProject: String? {
        if isWorkspaceWide { return nil }
        return store.activeProject ?? store.selectedProject ?? store.allProjects.first
    }

    private var activeProjectLabel: String {
        resolvedProject ?? "Workspace"
    }

    private var activeModelBadge: String {
        if mode == .chat { return store.defaultChatProvider.label(for: store.defaultChatModelId) }
        if mode == .askLead { return "Central Lead" }
        let key = (mode == .planFirst) ? "plan" : "build"
        if let role = store.modelsRead.roles.first(where: { $0.key == key }), !role.words.isEmpty {
            return role.words
        }
        return store.agentsRead.firstTask?.name ?? "Default agent"
    }

    private var workspacePulse: (dot: Color, label: String, actionTaskId: String?) {
        if let firstNeed = store.needsRows.first {
            let count = store.needsRows.count
            return (
                ToolrollPalette.warning,
                count == 1 ? "1 task waiting on you" : "\(count) tasks waiting on you",
                firstNeed.id
            )
        }
        if !store.runningRows.isEmpty {
            let count = store.runningRows.count
            return (
                ToolrollPalette.live,
                count == 1 ? "1 agent run active" : "\(count) agent runs active",
                store.runningRows.first?.id
            )
        }
        if let proj = resolvedProject {
            let repoCount = store.allProjects.count
            return (
                ToolrollPalette.success,
                repoCount > 1 ? "\(proj) · \(repoCount) repos connected" : "\(proj) ready",
                nil
            )
        }
        return (ToolrollPalette.success, "Workspace ready", nil)
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let notice = store.notice {
                HStack(spacing: 8) {
                    Circle()
                        .fill(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(notice.message)
                        .font(.system(size: 12))
                        .foregroundStyle(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.ink)
                    NoticeActionButton(store: store, notice: notice)
                    Spacer()
                    Button {
                        store.notice = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(ToolrollPalette.raised)
                HairlineDivider()
            }

            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 48)

                    VStack(spacing: 16) {
                        VStack(spacing: 10) {
                            let pulse = workspacePulse
                            Button {
                                if let taskId = pulse.actionTaskId {
                                    Task { await store.selectTask(taskId) }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(pulse.dot)
                                        .frame(width: 6, height: 6)
                                    Text(pulse.label)
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .lineLimit(1)
                                    if pulse.actionTaskId != nil {
                                        Image(systemName: "arrow.right")
                                            .font(.system(size: 9, weight: .semibold))
                                            .foregroundStyle(ToolrollPalette.muted)
                                    }
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .toolrollGlassCapsule(interactive: pulse.actionTaskId != nil)
                            }
                            .buttonStyle(.plain)
                            .disabled(pulse.actionTaskId == nil)

                            Text(resolvedProject.map { "Direct \($0)" } ?? "Direct your workspace")
                                .font(.system(size: 25, weight: .semibold))
                                .tracking(-0.3)
                                .foregroundStyle(ToolrollPalette.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            if !attachments.isEmpty {
                                ComposerAttachmentStrip(attachments: attachments) { removedId in
                                    attachments.removeAll { $0.id == removedId }
                                }
                            }

                            TextField(
                                promptPlaceholder,
                                text: $promptText,
                                axis: .vertical
                            )
                            .textFieldStyle(.plain)
                            .font(.system(size: 14))
                            .foregroundStyle(ToolrollPalette.ink)
                            .lineLimit(3...8)
                            .focused($promptFocused)
                            .onSubmit {
                                submit()
                            }
                            .padding(.horizontal, 4)
                            .padding(.top, attachments.isEmpty ? 4 : 0)

                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 8) {
                                    attachButton
                                    modeGlassPicker
                                    Spacer(minLength: 8)
                                    modelPickerButton
                                    sendButton
                                }

                                VStack(spacing: 8) {
                                    HStack(spacing: 8) {
                                        attachButton
                                        modeGlassPicker
                                        Spacer()
                                    }
                                    HStack {
                                        modelPickerButton
                                        Spacer()
                                        sendButton
                                    }
                                }
                            }
                        }
                        .padding(14)
                        .toolrollGlassPanel(cornerRadius: 18, interactive: true)
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(
                                    isComposerDropTargeted ? ToolrollPalette.live : Color.clear,
                                    style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
                                )
                        )
                        .shadow(color: Color.black.opacity(0.24), radius: 14, y: 4)
                        .onComposerPaste(isActive: promptFocused) { incoming in
                            appendUniqueAttachments(incoming, to: &attachments)
                        }
                        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
                            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                                appendUniqueAttachments(incoming, to: &attachments)
                            }
                        }

                        HStack(spacing: 10) {
                            projectFolderMenu
                            Spacer(minLength: 8)
                            Text(modeHint)
                                .font(.system(size: 11.5))
                                .foregroundStyle(ToolrollPalette.muted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .padding(.horizontal, 4)

                        if let waiting = store.needsRows.first {
                            needsYouResumeCard(waiting)
                                .padding(.top, 4)
                        }

                        launchEntryPointsStrip
                            .padding(.top, 6)
                    }
                    .frame(maxWidth: 620)
                    .padding(.horizontal, 28)

                    Spacer(minLength: 60)
                }
                .frame(maxWidth: .infinity, minHeight: 480)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ToolrollPalette.ground)
        .overlay {
            if isDropTargeted {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(ToolrollPalette.live, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(ToolrollPalette.live.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    .overlay {
                        VStack(spacing: 6) {
                            Image(systemName: "folder.badge.plus")
                                .font(.system(size: 24))
                                .foregroundStyle(ToolrollPalette.live)
                            Text("Drop folder to add & switch project")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.ink)
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .toolrollGlassPanel(cornerRadius: 12)
                    }
                    .padding(10)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, url.hasDirectoryPath else { return }
                    Task { @MainActor in
                        isWorkspaceWide = false
                        await store.addLocalProject(path: url.path)
                    }
                }
            }
            return true
        }
        .onAppear {
            if store.activeProject == nil {
                store.activeProject = store.selectedProject ?? store.allProjects.first
            }
            if let draft = store.pendingComposerDraft, !draft.isEmpty {
                promptText = draft
                store.pendingComposerDraft = nil
            }
            promptFocused = true
        }
        .onChange(of: store.pendingComposerDraft) { _, draft in
            if let draft, !draft.isEmpty {
                promptText = draft
                store.pendingComposerDraft = nil
                promptFocused = true
            }
        }
    }

    private var promptPlaceholder: String {
        switch mode {
        case .chat:
            return "Chat interactively with \(store.defaultChatProvider.displayName) in \(activeProjectLabel)…"
        case .planFirst:
            return "Describe the outcome, constraints, or visual change to plan…"
        case .justCode:
            return "Describe the change to build straight in an isolated worktree…"
        case .askLead:
            return "Ask Lead to coordinate across repos, review work, or restyle your workspace…"
        }
    }

    private var modeGlassPicker: some View {
        HStack(spacing: 2) {
            ForEach(ComposeMode.allCases) { item in
                let selected = mode == item
                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        mode = item
                    }
                } label: {
                    Text(item.rawValue)
                        .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
                        .foregroundStyle(selected ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(selected ? Color.white.opacity(0.14) : Color.clear, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Color.white.opacity(0.05), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .fixedSize()
    }

    private var modelPickerButton: some View {
        Button {
            isModelPickerOpen.toggle()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                    .font(.system(size: 10))
                Text(activeModelBadge)
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7.5, weight: .semibold))
            }
            .foregroundStyle(ToolrollPalette.ink)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .frame(maxWidth: 175)
            .background(Color.white.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .fixedSize()
        .popover(isPresented: $isModelPickerOpen, arrowEdge: .top) {
            ModelPickerPopover(
                store: store,
                initialRoleKey: mode == .planFirst ? "plan" : "build",
                onDismiss: { isModelPickerOpen = false }
            )
        }
    }

    private var attachButton: some View {
        ComposerAttachMenuButton(
            compact: false,
            onAddAttachments: { incoming in
                appendUniqueAttachments(incoming, to: &attachments)
            },
            onNoClipboardImage: {
                store.notice = WorkbenchNotice(kind: .info, message: "No image found on the clipboard — copy a screenshot (⌘⌃⇧4) or image first.")
            }
        )
    }

    private var canSubmit: Bool {
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var sendButton: some View {
        Button {
            submit()
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ToolrollPalette.inverseInk)
                .frame(width: 28, height: 28)
                .background(
                    canSubmit
                        ? ToolrollPalette.ink
                        : ToolrollPalette.muted.opacity(0.32),
                    in: Circle()
                )
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
    }

    private var projectFolderMenu: some View {
        Menu {
            Section("Switch Project") {
                ForEach(store.allProjects, id: \.self) { proj in
                    Button {
                        isWorkspaceWide = false
                        store.activeProject = proj
                    } label: {
                        HStack {
                            Text(proj)
                            if !isWorkspaceWide && resolvedProject == proj {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
                Button {
                    isWorkspaceWide = true
                } label: {
                    HStack {
                        Text("Workspace-wide")
                        if isWorkspaceWide {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }

            if !store.unconnectedGitRepos.isEmpty {
                Section("Discovered Git Repos") {
                    ForEach(store.unconnectedGitRepos.prefix(12)) { repo in
                        Button {
                            isWorkspaceWide = false
                            Task { await store.addLocalProject(path: repo.path) }
                        } label: {
                            Text(repo.branch.map { "\(repo.name) (\($0))" } ?? repo.name)
                        }
                    }
                }
            }

            Divider()

            Button("Add Local Folder…") {
                isWorkspaceWide = false
                store.pickAndAddLocalFolder()
            }

            if let proj = resolvedProject, let path = store.localFolderPath(for: proj) {
                Button("Reveal \(proj) in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: isWorkspaceWide ? "square.grid.2x2" : "folder")
                    .font(.system(size: 11))
                Text(activeProjectLabel)
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
            }
            .foregroundStyle(ToolrollPalette.ink.opacity(0.88))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .toolrollHoverSurface(cornerRadius: 6)
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(ToolrollPalette.line, lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Switch active project or add a local folder (⌘⇧O)")
    }

    private func needsYouResumeCard(_ row: WorkRow) -> some View {
        Button {
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(ToolrollPalette.ink)
                    .frame(width: 6, height: 6)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(row.word.isEmpty ? "Needs approval" : row.word)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.85))
                        if let proj = row.project, !proj.isEmpty {
                            Text("· \(proj)")
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                    Text(row.title)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: 8)

                HStack(spacing: 4) {
                    Text("Review")
                        .font(.system(size: 11.5, weight: .semibold))
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.white.opacity(0.08), in: Capsule())
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var launchEntryPointsStrip: some View {
        ViewThatFits(in: .horizontal) {
            ToolrollGlassGroup(spacing: 8) {
                canvasEntryPill(compact: false)
                terminalEntryMenu(compact: false)
                leadEntryPill(compact: false)
            }

            ToolrollGlassGroup(spacing: 6) {
                canvasEntryPill(compact: true)
                terminalEntryMenu(compact: true)
                leadEntryPill(compact: true)
            }
        }
    }

    private func canvasEntryPill(compact: Bool) -> some View {
        Button {
            if let proj = resolvedProject {
                store.activeProject = proj
            }
            store.workspaceMode = .canvas
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "macwindow.on.rectangle")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.live)
                Text(compact ? "Canvas" : "Visual Canvas")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if !compact {
                    Text("⌘3")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Inspect live screens, tweak elements, and pin UI tasks for \(activeProjectLabel)")
    }

    private func terminalEntryMenu(compact: Bool) -> some View {
        Menu {
            Button("Start Shell in \(activeProjectLabel)") {
                Task { await store.startProjectTerminal(project: resolvedProject, program: "shell") }
            }
            Button("Start Claude in \(activeProjectLabel)") {
                Task { await store.startProjectTerminal(project: resolvedProject, program: "claude") }
            }
            Button("Start Codex in \(activeProjectLabel)") {
                Task { await store.startProjectTerminal(project: resolvedProject, program: "codex") }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "terminal")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(compact ? "Terminal" : "Live Terminal")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .padding(.horizontal, 12)
        .frame(height: 32)
        .contentShape(Capsule())
        .toolrollGlassCapsule(interactive: true)
        .help("Launch an interactive Shell, Claude, or Codex PTY on \(activeProjectLabel)")
    }

    private func leadEntryPill(compact: Bool) -> some View {
        Button {
            store.isInspectorVisible = true
            store.inspectorTab = .lead
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "text.bubble")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(compact ? "Lead" : "Ask Lead")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if !compact {
                    Text("⌘L")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Open Central Lead to coordinate across repos or customize your workspace (⌘L)")
    }

    private var modeHint: String {
        switch mode {
        case .chat: return "Interactive back-and-forth thread (promote to Task anytime)"
        case .planFirst: return "Review plan & checks in-app before building"
        case .justCode: return "Starts straight in an isolated worktree"
        case .askLead: return "Opens in Lead Thread"
        }
    }

    private func submit() {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: attachments)
        promptText = ""
        attachments = []
        let cleanProj = resolvedProject

        if mode == .chat {
            Task { await store.startChatThread(prompt: composed.combinedMessage, project: cleanProj) }
            return
        }

        if mode == .askLead {
            store.isInspectorVisible = true
            store.inspectorTab = .lead
            Task { await store.sendLeadMessage(composed.combinedMessage) }
            return
        }

        Task {
            await store.createTask(
                title: composed.title,
                project: cleanProj,
                body: composed.goal,
                planFirst: mode == .planFirst
            )
        }
    }
}
