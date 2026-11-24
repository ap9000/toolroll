import SwiftUI
import ToolrollCore

struct WorkHomeView: View {
    @Bindable var store: WorkbenchStore
    @State private var layout = WorkLayout.load()
    @State private var isCustomizing = false
    @State private var showsAllSettled = false
    @State private var quickPrompt = ""
    @State private var quickPlanFirst = true
    @State private var quickAskLead = false
    @FocusState private var quickPromptFocused: Bool

    private static let settledPreview = 6
    private static let automationsPreview = 3

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(layout.widgets.filter { !$0.isHidden }) { widget in
                    switch widget.kind {
                    case .header: header
                    case .limits: telemetryStrip
                    case .list: workSection
                    case .automations: automations
                    }
                }
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(ToolrollPalette.ground)
        .sheet(isPresented: $isCustomizing) {
            WorkCustomizeSheet(layout: $layout) { isCustomizing = false }
        }
        .onChange(of: layout) { _, saved in saved.save() }
    }

    private var rows: [WorkRow] { store.filteredRows }
    private var waiting: [WorkRow] { rows.filter { $0.rank == 0 } }
    private var running: [WorkRow] { rows.filter { $0.rank == 1 } }
    private var queued: [WorkRow] { rows.filter { $0.rank == 2 } }
    private var settled: [WorkRow] { rows.filter { $0.rank >= 3 } }
    private var asks: [NeedRow] { store.workRowsResponse.needs.flatMap(\.rows) }
    private var isIdle: Bool { rows.isEmpty && asks.isEmpty }

    private var activeProject: String? {
        store.activeProject ?? store.selectedProject ?? store.allProjects.first
    }

    private var header: some View {
        ScreenHeader(title: "Work", detail: summaryLine) {
            Button { isCustomizing = true } label: {
                Label("Customize", systemImage: "slider.horizontal.3")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Reorder or hide what Work shows")

            if !isIdle {
                Button { store.openNewWorkCanvas() } label: {
                    Label("New task", systemImage: "plus")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .help("New task (⌘N)")
            }
        }
    }

    private var summaryLine: String {
        if isIdle { return "All clear" }
        var parts: [String] = []
        let waitingCount = waiting.count + asks.count
        if waitingCount > 0 { parts.append("\(waitingCount) waiting") }
        if !running.isEmpty { parts.append("\(running.count) running") }
        if !queued.isEmpty { parts.append("\(queued.count) queued") }
        if !settled.isEmpty { parts.append("\(settled.count) settled") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var telemetryStrip: some View {
        let perProvider = ProviderLimit.tightestPerProvider(store.workRowsResponse.limits ?? [])
        let spend = store.workRowsResponse.spend
        let showSpend = (spend?.todayUsd ?? 0) > 0.004
        let gemini = store.geminiSubscription
        let hasAny = !perProvider.isEmpty || gemini != nil || showSpend

        if hasAny {
            HStack(spacing: 0) {
                ForEach(Array(perProvider.enumerated()), id: \.element.provider) { idx, limit in
                    if idx > 0 {
                        HairlineDivider(vertical: true)
                            .padding(.vertical, 10)
                    }
                    LimitTile(limit: limit)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let gemini {
                    if !perProvider.isEmpty {
                        HairlineDivider(vertical: true)
                            .padding(.vertical, 10)
                    }
                    GeminiSubscriptionTile(status: gemini)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if showSpend, let spend {
                    if !perProvider.isEmpty || gemini != nil {
                        HairlineDivider(vertical: true)
                            .padding(.vertical, 10)
                    }
                    SpendTile(spend: spend)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                HairlineDivider(vertical: true)
                    .padding(.vertical, 10)

                Button {
                    Task { await store.refreshSubscriptionUsage(silent: false) }
                } label: {
                    Group {
                        if store.isRefreshingUsage {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.isRefreshingUsage)
                .padding(.horizontal, 6)
                .help(refreshTooltip)
                .accessibilityLabel("Refresh subscription usage")
            }
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private var refreshTooltip: String {
        if store.isRefreshingUsage { return "Checking Claude, Codex, and Gemini…" }
        if let at = store.lastUsageRefreshAt {
            let mins = max(0, Int(Date().timeIntervalSince(at) / 60))
            return mins == 0 ? "Refresh usage (updated just now)" : "Refresh usage (updated \(mins)m ago)"
        }
        return "Refresh Claude, Codex, and Gemini usage"
    }

    @ViewBuilder private var workSection: some View {
        if isIdle {
            idleWorkspace
        } else {
            VStack(alignment: .leading, spacing: 18) {
                compactQuickInput
                if !waiting.isEmpty || !asks.isEmpty {
                    group("Waiting on you", count: waiting.count + asks.count, dot: ToolrollPalette.ink) {
                        ForEach(waiting) { taskRow($0) }
                        ForEach(asks, id: \.id) { askRow($0) }
                    }
                }
                if !running.isEmpty {
                    group("Running", count: running.count, dot: ToolrollPalette.live) {
                        ForEach(running) { taskRow($0) }
                    }
                }
                if !queued.isEmpty {
                    group("Queued", count: queued.count, dot: ToolrollPalette.muted) {
                        ForEach(queued) { taskRow($0) }
                    }
                }
                if !settled.isEmpty {
                    let shown = showsAllSettled ? settled : Array(settled.prefix(Self.settledPreview))
                    group("Settled", count: settled.count, dot: nil) {
                        ForEach(shown) { taskRow($0, quiet: true) }
                        if settled.count > Self.settledPreview {
                            Button(showsAllSettled ? "Show fewer" : "Show all \(settled.count)") {
                                showsAllSettled.toggle()
                            }
                            .buttonStyle(.plain)
                            .font(.system(size: 12))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                        }
                    }
                }
            }
        }
    }

    private var idleWorkspace: some View {
        VStack(alignment: .leading, spacing: 20) {
            heroQuickComposer

            if !store.allProjects.isEmpty {
                projectsGridSection
            }

            let recentThreads = Array(store.localCliThreads.prefix(4))
            if !recentThreads.isEmpty {
                recentCliThreadsSection(recentThreads)
            }
        }
    }

    private var heroQuickComposer: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(
                quickAskLead
                    ? "Ask Lead across your workspace…"
                    : "Describe what you want built in \(activeProject ?? "your workspace")…",
                text: $quickPrompt,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .foregroundStyle(ToolrollPalette.ink)
            .lineLimit(2...6)
            .focused($quickPromptFocused)
            .onSubmit { submitQuickPrompt() }
            .padding(.horizontal, 2)
            .padding(.top, 2)

            HStack(spacing: 8) {
                if !store.allProjects.isEmpty {
                    projectSelectorMenu
                }
                modeTogglePills
                Spacer(minLength: 8)
                Button {
                    submitQuickPrompt()
                } label: {
                    HStack(spacing: 5) {
                        Text(quickAskLead ? "Ask Lead" : (quickPlanFirst ? "Plan task" : "Start build"))
                        Image(systemName: "arrow.up")
                            .font(.system(size: 10.5, weight: .bold))
                    }
                    .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(quickPromptFocused ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
        )
    }

    private var compactQuickInput: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            TextField(
                "Quick task for \(activeProject ?? "workspace")…",
                text: $quickPrompt
            )
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .foregroundStyle(ToolrollPalette.ink)
            .focused($quickPromptFocused)
            .onSubmit { submitQuickPrompt() }

            if !store.allProjects.isEmpty {
                projectSelectorMenu
            }

            Button(quickPlanFirst ? "Plan" : "Build") {
                submitQuickPrompt()
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
            .disabled(quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(quickPromptFocused ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
        )
    }

    private var modeTogglePills: some View {
        HStack(spacing: 4) {
            modeChip(title: "Plan first", active: !quickAskLead && quickPlanFirst) {
                quickAskLead = false
                quickPlanFirst = true
            }
            modeChip(title: "Just code", active: !quickAskLead && !quickPlanFirst) {
                quickAskLead = false
                quickPlanFirst = false
            }
            modeChip(title: "Ask Lead", active: quickAskLead) {
                quickAskLead = true
            }
        }
        .padding(3)
        .background(ToolrollPalette.ground, in: Capsule())
        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func modeChip(title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: active ? .semibold : .medium))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(active ? ToolrollPalette.raised : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var projectSelectorMenu: some View {
        Menu {
            ForEach(store.allProjects, id: \.self) { project in
                Button {
                    store.activeProject = project
                } label: {
                    HStack {
                        Text(project)
                        if project == activeProject {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "folder")
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(activeProject ?? "Workspace")
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var projectsGridSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Projects")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("\(store.allProjects.count)")
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Button("Add project") { store.isAddProjectSheetOpen = true }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 4)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 260, maximum: 480), spacing: 10)],
                spacing: 10
            ) {
                ForEach(store.allProjects, id: \.self) { project in
                    projectCard(project)
                }
            }
        }
    }

    private func projectCard(_ project: String) -> some View {
        let isSelected = project == activeProject
        return HStack(spacing: 10) {
            Image(systemName: "folder.fill")
                .font(.system(size: 12))
                .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                .frame(width: 28, height: 28)
                .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

            VStack(alignment: .leading, spacing: 2) {
                Text(project)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                if let path = store.localFolderPath(for: project) {
                    Text(abbreviateHome(path))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 8)

            HStack(spacing: 4) {
                Button {
                    store.activeProject = project
                    store.workspaceMode = .canvas
                } label: {
                    Image(systemName: "macwindow.on.rectangle")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .toolrollHoverSurface(cornerRadius: 6, isSelected: false)
                .help("Open \(project) in Canvas")

                Button {
                    store.activeProject = project
                    Task { await store.startProjectTerminal(project: project, program: "shell") }
                } label: {
                    Image(systemName: "terminal")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .toolrollHoverSurface(cornerRadius: 6, isSelected: false)
                .help("Open Shell in \(project)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(isSelected ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            store.activeProject = project
            quickPromptFocused = true
        }
    }

    private func recentCliThreadsSection(_ threads: [LocalCliThread]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Recent CLI sessions")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("\(store.localCliThreads.count)")
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(threads.enumerated()), id: \.element.id) { idx, thread in
                    if idx > 0 {
                        HairlineDivider()
                            .padding(.leading, 44)
                    }
                    Button {
                        store.selectCliThread(thread)
                    } label: {
                        HStack(spacing: 10) {
                            Text(thread.provider.shortBadge)
                                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                                .frame(width: 24, height: 20)
                                .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(thread.title)
                                    .font(.system(size: 13))
                                    .foregroundStyle(ToolrollPalette.ink)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Text("\(thread.provider.displayName) · \(thread.projectName)")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 10)
                            Text(thread.relativeAge)
                                .font(.system(size: 11.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                        .toolrollHoverSurface(cornerRadius: 8, isSelected: false)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    @ViewBuilder private var automations: some View {
        if let response = store.automations, !response.automations.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Runs on its own")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("\(response.automations.count)")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                    Button("All automations") { store.workspaceMode = .automations }
                        .buttonStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 4)

                VStack(spacing: 0) {
                    ForEach(Array(response.automations.prefix(Self.automationsPreview).enumerated()), id: \.element.id) { idx, item in
                        if idx > 0 { HairlineDivider() }
                        AutomationRow(store: store, automation: item, canAct: response.canAct)
                    }
                }
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
    }

    private func group<Content: View>(_ title: String, count: Int, dot: Color?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let dot {
                    Circle().fill(dot).frame(width: 7, height: 7)
                } else {
                    Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1).frame(width: 7, height: 7)
                }
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(ToolrollPalette.ink)
                Text("\(count)").font(.system(size: 12)).foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: 0) {
                content()
            }
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func taskRow(_ row: WorkRow, quiet: Bool = false) -> some View {
        Button {
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(spacing: 12) {
                statusDot(row.status)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 13.5, weight: quiet ? .regular : .medium))
                        .foregroundStyle(quiet ? ToolrollPalette.muted : ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(subtitle(row))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 12)
                if let chip = row.chip, !chip.isEmpty {
                    Text(chip)
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 8)
                        .frame(height: 21)
                        .background(ToolrollPalette.ground, in: Capsule())
                        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                Text(row.age)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(minWidth: 34, alignment: .trailing)
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .contentShape(Rectangle())
            .toolrollHoverSurface(cornerRadius: 8, isSelected: false)
        }
        .buttonStyle(.plain)
        .contextMenu { TaskRowMenuItems(store: store, row: row) }
        .accessibilityLabel("\(row.title), \(row.word)\(row.project.map { ", \($0)" } ?? ""), \(row.age)")
    }

    private func askRow(_ need: NeedRow) -> some View {
        HStack(spacing: 12) {
            Circle().fill(ToolrollPalette.ink).frame(width: 7, height: 7)
            Text(need.line ?? need.ask ?? need.reason ?? "Waiting on you")
                .font(.system(size: 13.5))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .accessibilityElement(children: .combine)
    }

    private func subtitle(_ row: WorkRow) -> String {
        let what = row.detail?.isEmpty == false ? row.detail! : row.word
        guard let project = row.project, !project.isEmpty else { return what }
        return "\(project) · \(what)"
    }

    private func statusDot(_ tone: TaskStatusTone) -> some View {
        Group {
            switch tone {
            case .needs: Circle().fill(ToolrollPalette.ink)
            case .running: Circle().fill(ToolrollPalette.live)
            case .failed: Circle().fill(ToolrollPalette.danger)
            case .queued: Circle().fill(ToolrollPalette.muted)
            case .finished, .unknown: Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1)
            }
        }
        .frame(width: 7, height: 7)
    }

    private func abbreviateHome(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func submitQuickPrompt() {
        let trimmed = quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        quickPrompt = ""
        if quickAskLead {
            store.isInspectorVisible = true
            store.inspectorTab = .lead
            Task { await store.sendLeadMessage(trimmed) }
            return
        }
        let targetProject = activeProject
        let planFirst = quickPlanFirst
        Task {
            await store.createTask(
                title: trimmed,
                project: targetProject,
                body: "",
                planFirst: planFirst
            )
        }
    }
}

struct WorkCustomizeSheet: View {
    @Binding var layout: WorkLayout
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Customize Work")
                .font(.system(size: 15, weight: .semibold))
            VStack(spacing: 6) {
                ForEach(Array(layout.widgets.enumerated()), id: \.element.id) { index, widget in
                    HStack(spacing: 12) {
                        Toggle(isOn: Binding(get: { !widget.isHidden }, set: { _ in layout = layout.togglingHidden(widget.id) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(widget.kind.title).font(.system(size: 13, weight: .medium))
                                Text(widget.kind.detail).font(.system(size: 11.5)).foregroundStyle(ToolrollPalette.muted)
                            }
                        }
                        .toggleStyle(.checkbox)
                        Spacer()
                        Button { layout = layout.moving(widget.id, by: -1) } label: { Image(systemName: "chevron.up") }
                            .disabled(index == 0)
                            .accessibilityLabel("Move \(widget.kind.title) up")
                        Button { layout = layout.moving(widget.id, by: 1) } label: { Image(systemName: "chevron.down") }
                            .disabled(index == layout.widgets.count - 1)
                            .accessibilityLabel("Move \(widget.kind.title) down")
                    }
                    .buttonStyle(.borderless)
                    .padding(10)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            HStack {
                Button("Reset to Default") { layout = .standard }
                Spacer()
                Button("Done", action: onDone).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}

struct LimitTile: View {
    let limit: ProviderLimit
    private var now: Date { Date() }

    var body: some View {
        let percent = Int(limit.usedPercent.rounded())
        let reachedNow = limit.isReachedNow(now: now)
        let state = limit.resetState(now: now)
        let stale: Bool = { if case .passed = state { return true }; return false }()

        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text(limit.providerLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer(minLength: 6)
                Text(resetText(state))
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }

            HStack(spacing: 8) {
                Text(stale ? "—" : "\(percent)%")
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(reachedNow ? ToolrollPalette.danger : ToolrollPalette.ink)

                if stale {
                    Text("Checking…")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                } else {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.08))
                            Capsule()
                                .fill(reachedNow ? ToolrollPalette.danger : ToolrollPalette.ink)
                                .frame(width: proxy.size.width * CGFloat(max(0, min(100, percent))) / 100)
                        }
                    }
                    .frame(height: 4)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility(percent: percent, reachedNow: reachedNow, state: state))
    }

    private func resetText(_ state: ProviderLimit.ResetState) -> String {
        switch state {
        case .upcoming(let date): return "Resets \(Self.when(date))"
        case .passed(let date): return "Reset \(Self.day.string(from: date))"
        case .unknown: return limit.windowLabel
        }
    }

    private func accessibility(percent: Int, reachedNow: Bool, state: ProviderLimit.ResetState) -> String {
        let used = reachedNow ? "limit reached" : "\(percent) percent used"
        return "\(limit.providerLabel): \(used). \(resetText(state))"
    }

    static func when(_ date: Date, now: Date = Date()) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds < 3600 { return "in \(max(1, Int(seconds / 60)))m" }
        if seconds < 86_400 { return "in \(Int(seconds / 3600))h" }
        if seconds < 7 * 86_400 { return weekday.string(from: date) }
        return day.string(from: date)
    }

    private static let weekday: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEE j:mm"); return f }()
    private static let day: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("MMM d"); return f }()
}

struct GeminiSubscriptionTile: View {
    let status: GeminiSubscriptionStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text("Gemini")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer(minLength: 6)
                Text("Antigravity")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }

            HStack(spacing: 6) {
                Circle()
                    .fill(status.connected ? ToolrollPalette.success : ToolrollPalette.muted)
                    .frame(width: 6, height: 6)
                Text(status.connected ? (status.topModel ?? "Ready") : (status.note ?? "Not connected"))
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(status.connected ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }
}

struct SpendTile: View {
    let spend: SpendSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text("Spend")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer(minLength: 6)
                Text("Today")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            Text(spend.todayUsd, format: .currency(code: "USD"))
                .font(.system(size: 15, weight: .semibold).monospacedDigit())
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }
}
