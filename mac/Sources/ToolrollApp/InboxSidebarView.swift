import SwiftUI
import ToolrollCore

/// Left rail — decluttered macOS 26 Liquid Glass sidebar:
/// Top: Search pill (with integrated project/owner filter) + crisp New Task button.
/// Middle: Needs you / Running / Queued + inline collapsible Settled section.
/// Bottom: Single quiet Workspace menu capsule + Appearance trigger (zero multi-row icon clutter).
public struct InboxSidebarView: View {
    @Bindable var store: WorkbenchStore
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var hasActiveFilter: Bool {
        store.selectedProject != nil || store.teamFilter != .everyone
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Top bar: Glass Search pill (with integrated filter) + New Task button
            HStack(spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)

                    TextField("Search", text: $store.sidebarSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.ink)
                        .focused($searchFocused)

                    if !store.sidebarSearch.isEmpty {
                        Button {
                            store.sidebarSearch = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 10.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .buttonStyle(.plain)
                    }

                    // Filter & Grouping menu tucked cleanly inside the search pill
                    Menu {
                        Section("Group by") {
                            ForEach(SidebarGrouping.allCases) { g in
                                Button {
                                    store.sidebarGrouping = g
                                } label: {
                                    HStack {
                                        Text(g.rawValue)
                                        if store.sidebarGrouping == g { Image(systemName: "checkmark") }
                                    }
                                }
                            }
                        }
                        Divider()
                        Section("Project") {
                            Button {
                                store.selectedProject = nil
                            } label: {
                                HStack {
                                    Text("All projects")
                                    if store.selectedProject == nil { Image(systemName: "checkmark") }
                                }
                            }
                            ForEach(store.allProjects, id: \.self) { proj in
                                Button {
                                    store.selectedProject = proj
                                } label: {
                                    HStack {
                                        Text(proj)
                                        if store.selectedProject == proj { Image(systemName: "checkmark") }
                                    }
                                }
                            }
                        }
                        if !store.unconnectedGitRepos.isEmpty {
                            Divider()
                            Menu("Connect Git Repo (\(store.unconnectedGitRepos.count))") {
                                ForEach(store.unconnectedGitRepos.prefix(15)) { repo in
                                    Button(repo.branch.map { "\(repo.name) (\($0))" } ?? repo.name) {
                                        Task { await store.addLocalProject(path: repo.path) }
                                    }
                                }
                            }
                        }
                        Divider()
                        Button("Add Local Project…") {
                            store.isAddProjectSheetOpen = true
                        }
                        if store.isTeamWorkspace {
                            Divider()
                            Section("Owner") {
                                ForEach(TeamFilter.allCases) { f in
                                    Button {
                                        store.teamFilter = f
                                    } label: {
                                        HStack {
                                            Text(f.rawValue)
                                            if store.teamFilter == f { Image(systemName: "checkmark") }
                                        }
                                    }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: hasActiveFilter ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                            .font(.system(size: 11))
                            .foregroundStyle(hasActiveFilter ? ToolrollPalette.live : ToolrollPalette.muted)
                            .frame(width: 20, height: 20)
                            .contentShape(Circle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help(store.selectedProject.map { "Filtered: \($0)" } ?? "Filter by project or owner")
                }
                .padding(.horizontal, 9)
                .frame(height: 28)
                .toolrollGlassCapsule(interactive: false)

                // Crisp New Task glass circle (⌘N)
                Button {
                    store.openNewWorkCanvas()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(store.isComposingNewWork ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .toolrollGlassCapsule(interactive: true)
                .help("New Task (⌘N)")
            }
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 8)

            // Active project filter badge (only shown when filtered)
            if let proj = store.selectedProject {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.system(size: 9.5))
                    Text(proj)
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .lineLimit(1)
                    Spacer()
                    Button {
                        store.selectedProject = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 8.5, weight: .bold))
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(Color.white.opacity(0.08), in: Capsule())
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
            }

            // Unified scrollable task list (Status-first default, or grouped by Project)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if store.sidebarGrouping == .project {
                        let activeAll = store.needsRows + store.runningRows + store.queuedRows
                        let grouped = Dictionary(grouping: activeAll) { ($0.project?.isEmpty == false ? $0.project! : "Workspace") }
                        let keys = grouped.keys.sorted()
                        ForEach(keys, id: \.self) { projKey in
                            if let rows = grouped[projKey], !rows.isEmpty {
                                activeSection(
                                    title: projKey,
                                    count: rows.count,
                                    solidBadge: rows.contains(where: { $0.status == .needs }),
                                    rows: rows
                                )
                            }
                        }
                    } else {
                        if !store.needsRows.isEmpty {
                            activeSection(title: "Needs you", count: store.needsRows.count, solidBadge: true, rows: store.needsRows)
                        }
                        if !store.runningRows.isEmpty {
                            activeSection(title: "Running", count: store.runningRows.count, solidBadge: false, rows: store.runningRows)
                        }
                        if !store.queuedRows.isEmpty {
                            activeSection(title: "Queued", count: store.queuedRows.count, solidBadge: false, rows: store.queuedRows)
                        }
                    }

                    if store.needsRows.isEmpty && store.runningRows.isEmpty && store.queuedRows.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Nothing active")
                                .font(.system(size: 12))
                                .foregroundStyle(ToolrollPalette.muted)
                            Button("Start something new (⌘N)") {
                                store.openNewWorkCanvas()
                            }
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                    }

                    // Inline collapsible Settled section (clean like Linear's Completed/Archive)
                    if !store.settledRows.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Button {
                                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                    store.isSettledExpanded.toggle()
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: store.isSettledExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8.5, weight: .semibold))
                                        .frame(width: 10)
                                    Text("SETTLED")
                                        .font(.system(size: 10, weight: .semibold))
                                        .tracking(0.7)
                                    Spacer()
                                    Text("\(store.settledRows.count)")
                                        .font(.system(size: 10, design: .monospaced))
                                }
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if store.isSettledExpanded {
                                let visibleSettled = Array(store.settledRows.prefix(store.settledDisplayLimit))
                                ForEach(visibleSettled) { row in
                                    settledRow(row)
                                }
                                if store.settledRows.count > store.settledDisplayLimit {
                                    Button {
                                        store.settledDisplayLimit += 15
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "chevron.down")
                                                .font(.system(size: 9))
                                            Text("Show \(store.settledRows.count - store.settledDisplayLimit) more")
                                                .font(.system(size: 11))
                                        }
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 6)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.top, 4)
                    }

                    // Existing local Claude Code, Codex & Gemini CLI threads
                    if !store.filteredCliThreads.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Button {
                                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                    store.isCliThreadsExpanded.toggle()
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: store.isCliThreadsExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8.5, weight: .semibold))
                                    Text("CLI Threads")
                                        .font(.system(size: 10, weight: .semibold))
                                        .textCase(.uppercase)
                                        .tracking(0.6)
                                    Spacer()
                                    Text("\(store.filteredCliThreads.count)")
                                        .font(.system(size: 10, design: .monospaced))
                                }
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if store.isCliThreadsExpanded {
                                let visibleThreads = Array(store.filteredCliThreads.prefix(store.cliThreadsDisplayLimit))
                                ForEach(visibleThreads) { thread in
                                    cliThreadRow(thread)
                                }
                                if store.filteredCliThreads.count > store.cliThreadsDisplayLimit {
                                    Button {
                                        store.cliThreadsDisplayLimit += 12
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "chevron.down")
                                                .font(.system(size: 9))
                                            Text("Show \(store.filteredCliThreads.count - store.cliThreadsDisplayLimit) more")
                                                .font(.system(size: 11))
                                        }
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 6)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: .infinity)

            // Balanced Liquid Glass footer (matched 28pt height controls, no stretched lozenge)
            HStack(spacing: 8) {
                Menu {
                    if let spend = store.workRowsResponse.spend {
                        Text(String(format: "Today's spend: $%.2f", spend.todayUsd))
                        Divider()
                    }
                    Button("Setup & Agents…") {
                        store.isSetupOpen = true
                    }
                    Button("Appearance & Lead Themes…") {
                        store.isAppearanceSheetOpen = true
                    }
                    Button("Add Local Project…") {
                        store.isAddProjectSheetOpen = true
                    }
                    Button("Pair Phone for Push Alerts…") {
                        store.isPhonePairSheetOpen = true
                    }
                    Divider()
                    Button("Refresh Workspace") {
                        Task { await store.refreshAll() }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                        Text("Settings")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                            .lineLimit(1)
                    }
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .padding(.horizontal, 11)
                .frame(height: 28)
                .contentShape(Capsule())
                .toolrollGlassCapsule(interactive: true)
                .help("Workspace Settings, Spend & Projects")

                Spacer(minLength: 4)

                if WorkspaceThemeEngine.shared.config.showCosts, let spend = store.workRowsResponse.spend {
                    Text(String(format: "$%.2f", spend.todayUsd))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                        .help("Today's total spend")
                }

                Button {
                    store.isAppearanceSheetOpen = true
                } label: {
                    Image(systemName: "paintbrush")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .toolrollGlassCapsule(interactive: true)
                .help("Appearance & Lead Themes (⌘⇧T)")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(Color.clear)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, url.hasDirectoryPath else { return }
                    Task { @MainActor in
                        await store.addLocalProject(path: url.path)
                    }
                }
            }
            return true
        }
    }

    private func activeSection(title: String, count: Int, solidBadge: Bool, rows: [WorkRow]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.7)
                    .foregroundStyle(solidBadge ? ToolrollPalette.ink : ToolrollPalette.muted)
                Spacer()
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(solidBadge ? ToolrollPalette.inverseInk : ToolrollPalette.muted)
                    .padding(.horizontal, solidBadge ? 5.5 : 2)
                    .padding(.vertical, solidBadge ? 1 : 0)
                    .background(solidBadge ? ToolrollPalette.ink : Color.clear, in: Capsule())
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 2)

            ForEach(rows) { row in
                activeRow(row)
            }
        }
    }

    private func activeRow(_ row: WorkRow) -> some View {
        let isSelected = !store.isComposingNewWork && store.selectedTaskId == row.id
        let pres = store.presence.tasks[row.id]

        return Button {
            Task { await store.selectTask(row.id) }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .top, spacing: 7) {
                    statusDot(for: row.status)
                        .padding(.top, 5)
                    Text(row.title)
                        .font(.system(size: 12.5, weight: isSelected ? .semibold : .regular))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Text(row.age)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }

                if let project = row.project, !project.isEmpty {
                    HStack(spacing: 5) {
                        Text(project)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                        if let summary = pres?.summary {
                            Text("· \(summary)")
                                .font(.system(size: 10.5))
                                .foregroundStyle(ToolrollPalette.live)
                                .lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(.leading, 13)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, WorkspaceThemeEngine.shared.config.isCompact ? 5 : 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected ? Color.white.opacity(0.11) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 8, isSelected: false)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(isSelected ? Color.white.opacity(0.12) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
    }

    private func settledRow(_ row: WorkRow) -> some View {
        let isSelected = !store.isComposingNewWork && store.selectedTaskId == row.id
        let badgeChar = row.project.flatMap { $0.isEmpty ? nil : String($0.prefix(2)).uppercased() } ?? "•"

        return Button {
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(spacing: 8) {
                Text(badgeChar)
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(row.status == .failed ? ToolrollPalette.danger : ToolrollPalette.muted)
                    .frame(width: 18, height: 18)
                    .background(Color.white.opacity(0.06), in: Circle())
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))

                Text(row.title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 6)

                Text(row.age)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, WorkspaceThemeEngine.shared.config.isCompact ? 4 : 5.5)
            .background(
                isSelected ? Color.white.opacity(0.10) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
    }

    private func cliThreadRow(_ thread: LocalCliThread) -> some View {
        let isSelected = store.selectedCliThreadId == thread.id
        return Button {
            store.selectCliThread(thread)
        } label: {
            HStack(spacing: 8) {
                Text(thread.provider.shortBadge)
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .frame(width: 20, height: 18)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))

                VStack(alignment: .leading, spacing: 1) {
                    Text(thread.title)
                        .font(.system(size: 11.5, weight: isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(thread.projectName)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                Text(thread.relativeAge)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.7))
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, WorkspaceThemeEngine.shared.config.isCompact ? 4 : 5)
            .background(
                isSelected ? Color.white.opacity(0.10) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .help("\(thread.provider.displayName) · \(thread.projectName)\n\(thread.title)")
    }

    @ViewBuilder
    private func statusDot(for tone: TaskStatusTone) -> some View {
        switch tone {
        case .needs:
            RoundedRectangle(cornerRadius: 1.5).fill(ToolrollPalette.ink).frame(width: 6, height: 6)
        case .running:
            Circle().fill(ToolrollPalette.live).frame(width: 6, height: 6)
        case .finished:
            Circle().fill(ToolrollPalette.success).frame(width: 6, height: 6)
        case .failed:
            Circle().fill(ToolrollPalette.danger).frame(width: 6, height: 6)
        case .queued, .unknown:
            Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1).frame(width: 6, height: 6)
        }
    }
}
