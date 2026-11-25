import SwiftUI
import ToolrollCore

public struct InboxSidebarView: View {
    @Bindable var store: WorkbenchStore
    @State private var isSearchOpen: Bool = false
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var hasActiveFilter: Bool {
        store.selectedProject != nil || store.teamFilter != .everyone
    }

    private var showSearchBar: Bool {
        isSearchOpen || !store.sidebarSearch.isEmpty
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                WorkspaceMenu(store: store)

                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        if showSearchBar && store.sidebarSearch.isEmpty {
                            isSearchOpen = false
                            searchFocused = false
                        } else {
                            isSearchOpen = true
                            searchFocused = true
                        }
                    }
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(showSearchBar ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .frame(width: 24, height: 24)
                        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain)
                .toolrollHoverSurface(cornerRadius: 6, isSelected: showSearchBar)
                .help("Search threads")

                filterMenuButton
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .padding(.bottom, 6)

            if showSearchBar {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)

                    TextField("Filter threads…", text: $store.sidebarSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.ink)
                        .focused($searchFocused)
                        .onExitCommand {
                            store.sidebarSearch = ""
                            isSearchOpen = false
                        }

                    Button {
                        store.sidebarSearch = ""
                        isSearchOpen = false
                        searchFocused = false
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 9)
                .frame(height: 28)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(searchFocused ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
                )
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }

            if let proj = store.selectedProject {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.system(size: 9.5))
                    Text(proj)
                        .font(.system(size: 11, weight: .medium))
                        .tracking(-0.1)
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
                .frame(height: 24)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                )
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }

            VStack(spacing: 1) {
                workNavRow
                canvasNavRow
                automationsNavRow
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)

            HairlineDivider()
                .padding(.horizontal, 12)
                .padding(.bottom, 4)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if !store.needsRows.isEmpty {
                        activeSection(title: "Needs you", count: store.needsRows.count, solidBadge: true, rows: store.needsRows)
                    }

                    let activeTasks = store.runningRows + store.queuedRows
                    let activeChats = store.filteredChatThreads
                    if store.sidebarGrouping == .project {
                        let taskGroups = Dictionary(grouping: activeTasks) { ($0.project?.isEmpty == false ? $0.project! : "Workspace") }
                        let chatGroups = Dictionary(grouping: activeChats) { ($0.projectName.isEmpty ? "Workspace" : $0.projectName) }
                        let keys = Set(taskGroups.keys).union(chatGroups.keys).sorted()
                        ForEach(keys, id: \.self) { projKey in
                            let projTasks = taskGroups[projKey] ?? []
                            let projChats = chatGroups[projKey] ?? []
                            if !projTasks.isEmpty || !projChats.isEmpty {
                                unifiedThreadsSection(title: projKey, tasks: projTasks, chats: projChats)
                            }
                        }
                    } else if !activeTasks.isEmpty || !activeChats.isEmpty {
                        unifiedThreadsSection(title: "Threads", tasks: activeTasks, chats: activeChats)
                    }

                    if !store.settledRows.isEmpty {
                        historySection
                    } else if !store.archivedRows.isEmpty {
                        archivedGroup(indented: false)
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: .infinity)

            HairlineDivider()
                .padding(.horizontal, 12)

            sidebarUtilityFooter
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

    private var filterMenuButton: some View {
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
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(hasActiveFilter ? ToolrollPalette.live : ToolrollPalette.muted)
                .frame(width: 24, height: 24)
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .toolrollHoverSurface(cornerRadius: 6, isSelected: hasActiveFilter)
        .help(store.selectedProject.map { "Filtered: \($0)" } ?? "Filter by project or grouping")
    }

    private var workNavRow: some View {
        let isHomeActive = store.workspaceMode == .workbench && store.isShowingWorkHome
        let pending = store.leadChat.pendingProposals
        return Button {
            store.openWorkHome()
            Task { await store.refreshLeadChat() }
        } label: {
            HStack(spacing: 8) {
                if store.leadChat.busy {
                    ToolrollKineticLoader(provider: "lead", height: 11)
                        .frame(width: 16, height: 16)
                } else {
                    Image(systemName: isHomeActive ? "house.fill" : "house")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(isHomeActive ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .frame(width: 16)
                }
                Text("Home")
                    .font(.system(size: 12.5, weight: isHomeActive ? .semibold : .medium))
                    .tracking(-0.15)
                    .foregroundStyle(isHomeActive ? ToolrollPalette.ink : ToolrollPalette.ink.opacity(0.85))
                Spacer()
                if pending > 0 {
                    Text("\(pending)")
                        .font(.system(size: 10.5, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .padding(.horizontal, 5.5)
                        .padding(.vertical, 1)
                        .background(ToolrollPalette.ink, in: Capsule())
                } else {
                    Text("⌘N")
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(
                isHomeActive ? Color.white.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pending > 0 ? "Home, \(pending) proposals" : "Home")
        .help("Home — Lead canvas and unified Lead, Chat, or Task launcher (⌘N)")
    }

    private var canvasNavRow: some View {
        let isCanvasActive = store.workspaceMode == .canvas
        return Button {
            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                store.workspaceMode = isCanvasActive ? .workbench : .canvas
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(isCanvasActive ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .frame(width: 16)
                Text("Canvas")
                    .font(.system(size: 12.5, weight: isCanvasActive ? .semibold : .medium))
                    .tracking(-0.15)
                    .foregroundStyle(isCanvasActive ? ToolrollPalette.ink : ToolrollPalette.ink.opacity(0.85))
                Spacer()
                Text("⌘3")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(
                isCanvasActive ? Color.white.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Canvas")
        .help("Canvas (⌘3)")
    }

    private var automationsNavRow: some View {
        let isAutoActive = store.workspaceMode == .automations
        let waiting = store.automations?.automations.filter { $0.group == "needs" }.count ?? 0
        return Button {
            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                store.workspaceMode = isAutoActive ? .workbench : .automations
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(isAutoActive ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .frame(width: 16)
                Text("Automations")
                    .font(.system(size: 12.5, weight: isAutoActive ? .semibold : .medium))
                    .tracking(-0.15)
                    .foregroundStyle(isAutoActive ? ToolrollPalette.ink : ToolrollPalette.ink.opacity(0.85))
                Spacer()
                if waiting > 0 {
                    Text("\(waiting)")
                        .font(.system(size: 10.5, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .padding(.horizontal, 5.5)
                        .padding(.vertical, 1)
                        .background(ToolrollPalette.ink, in: Capsule())
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(
                isAutoActive ? Color.white.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(waiting > 0 ? "Automations, \(waiting) waiting" : "Automations")
    }

    private var historySection: some View {
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
                    Text("History")
                        .font(.system(size: 11.5, weight: .medium))
                        .tracking(-0.1)
                    Spacer()
                    Text("\(store.settledRows.count)")
                        .font(.system(size: 11))
                        .monospacedDigit()
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
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
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }
                if !store.archivedRows.isEmpty {
                    archivedGroup(indented: true)
                }
            }
        }
    }

    private func unifiedThreadsSection(title: String, tasks: [WorkRow], chats: [AgentChatThread]) -> some View {
        let total = tasks.count + chats.count
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 11.5, weight: .medium))
                    .tracking(-0.1)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Text("\(total)")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 2)

            ForEach(tasks) { row in
                activeRow(row)
            }
            ForEach(chats) { thread in
                chatThreadRow(thread)
            }
        }
    }

    private var sidebarUtilityFooter: some View {
        HStack(spacing: 6) {
            Menu {
                if let spend = store.workRowsResponse.spend, spend.todayUsd > 0.004 {
                    Text(String(format: "Today's spend: $%.2f", spend.todayUsd))
                    Divider()
                }
                Button("Project Settings…") {
                    store.openProjectSettings()
                }
                Button("Setup & Agents…") {
                    store.isSetupOpen = true
                }
                Button("Appearance & Themes…") {
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
                HStack(spacing: 7) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 16)
                    Text("Settings")
                        .font(.system(size: 12, weight: .medium))
                        .tracking(-0.1)
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 8)
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .help("Settings, Projects & Appearance")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func activeSection(title: String, count: Int, solidBadge: Bool, rows: [WorkRow]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 11.5, weight: .medium))
                    .tracking(-0.1)
                    .foregroundStyle(solidBadge ? ToolrollPalette.ink : ToolrollPalette.muted)
                Spacer()
                Text("\(count)")
                    .font(.system(size: 10.5, weight: solidBadge ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(solidBadge ? ToolrollPalette.inverseInk : ToolrollPalette.muted)
                    .padding(.horizontal, solidBadge ? 5.5 : 0)
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
        let isSelected = (!store.isComposingNewWork && store.selectedTaskId == row.id) || store.bulkSelection.contains(row.id)
        let pres = store.presence.tasks[row.id]

        return Button {
            Task { await store.handleRowClick(row) }
        } label: {
            VStack(alignment: .leading, spacing: 2.5) {
                HStack(alignment: .top, spacing: 7) {
                    statusDot(for: row.status)
                        .padding(.top, 5)
                    Text(row.title)
                        .font(.system(size: 12.5, weight: isSelected ? .semibold : .regular))
                        .tracking(-0.1)
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Text(row.age)
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }

                if let project = row.project, !project.isEmpty {
                    HStack(spacing: 5) {
                        Text(project)
                            .font(.system(size: 10.5))
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
            .padding(.horizontal, 9)
            .padding(.vertical, WorkspaceThemeEngine.shared.config.isCompact ? 5 : 6.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected ? Color.white.opacity(0.09) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .accessibilityLabel("\(row.title), \(row.word)")
        .accessibilityHint("Opens the task. More actions in its context menu.")
        .contextMenu { TaskRowMenuItems(store: store, row: row) }
    }

    private func archivedGroup(indented: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) { store.isArchivedExpanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: store.isArchivedExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8.5, weight: .semibold))
                        .frame(width: 10)
                    Text("Archived")
                        .font(.system(size: 11.5, weight: .medium))
                        .tracking(-0.1)
                    Spacer()
                    Text("\(store.archivedRows.count)")
                        .font(.system(size: 11))
                        .monospacedDigit()
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.leading, indented ? 20 : 12)
                .padding(.trailing, 12)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if store.isArchivedExpanded {
                ForEach(store.archivedRows) { row in settledRow(row, archived: true) }
            }
        }
    }

    private func settledRow(_ row: WorkRow, archived: Bool = false) -> some View {
        let isSelected = (!store.isComposingNewWork && store.selectedTaskId == row.id) || store.bulkSelection.contains(row.id)

        return Button {
            Task { await store.handleRowClick(row) }
        } label: {
            HStack(spacing: 7) {
                Circle()
                    .fill(row.status == .failed ? ToolrollPalette.danger : ToolrollPalette.muted.opacity(0.55))
                    .frame(width: 5, height: 5)

                Text(row.title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .tracking(-0.1)
                    .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 6)

                Text(row.age)
                    .font(.system(size: 10.5))
                    .monospacedDigit()
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, WorkspaceThemeEngine.shared.config.isCompact ? 4 : 5)
            .background(
                isSelected ? Color.white.opacity(0.09) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .accessibilityLabel(archived ? "\(row.title), archived" : "\(row.title), \(row.word)")
        .contextMenu {
            if archived { ArchivedRowMenuItems(store: store, row: row) } else { TaskRowMenuItems(store: store, row: row) }
        }
    }

    private func chatThreadRow(_ thread: AgentChatThread) -> some View {
        let isSelected = store.selectedChatThreadId == thread.id
        let isRunning = store.runningChatThreadIds.contains(thread.id)
        let changedCount = store.chatThreadDiffs[thread.id]?.changedFiles.count ?? 0

        return Button {
            store.selectChatThread(thread.id)
        } label: {
            HStack(alignment: .center, spacing: 7) {
                if isRunning {
                    ToolrollKineticLoader(provider: thread.provider.rawValue, height: 11)
                        .frame(width: 15, height: 15)
                } else {
                    ProviderBrandGlyph(provider: thread.provider.rawValue, size: 13, tinted: true, inTile: false)
                        .frame(width: 15, height: 15)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title)
                        .font(.system(size: 12.5, weight: isSelected ? .semibold : .regular))
                        .tracking(-0.1)
                        .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.ink.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    HStack(spacing: 5) {
                        Text("\(thread.projectName) · \(thread.provider.displayName)")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                        if changedCount > 0 {
                            Text("+\(changedCount)")
                                .font(.system(size: 10, weight: .medium))
                                .monospacedDigit()
                                .foregroundStyle(ToolrollPalette.success)
                        }
                    }
                }
                Spacer(minLength: 4)
                Text(thread.relativeAge)
                    .font(.system(size: 10.5))
                    .monospacedDigit()
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5.5)
            .background(
                isSelected ? Color.white.opacity(0.09) : Color.clear,
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .contextMenu {
            Button("Ship as Toolroll Task") {
                Task { await store.promoteChatToTask(threadId: thread.id) }
            }
            Divider()
            Button("Delete Chat", role: .destructive) {
                store.deleteChatThread(id: thread.id)
            }
        }
    }

    @ViewBuilder
    private func statusDot(for tone: TaskStatusTone) -> some View {
        switch tone {
        case .needs:
            Circle().fill(ToolrollPalette.warning).frame(width: 6, height: 6)
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

struct ToolrollBrandMark: View {
    var height: CGFloat = 17

    var body: some View {
        let scale = height / 20
        HStack(alignment: .center, spacing: 3 * scale) {
            ForEach(0..<3, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1 * scale)
                    .fill(ToolrollPalette.ink)
                    .frame(width: 3.5 * scale, height: (index == 1 ? 20 : 13) * scale)
            }
        }
        .frame(width: 16 * scale, height: height)
        .transformEffect(CGAffineTransform(a: 1, b: tan(-10 * .pi / 180), c: 0, d: 1, tx: 0, ty: 8 * scale * tan(10 * .pi / 180)))
        .accessibilityHidden(true)
    }
}

struct WorkspaceMenu: View {
    @Bindable var store: WorkbenchStore

    var body: some View {
        Menu {
            Section("Workspace") {
                ForEach(store.profiles) { profile in
                    Button {
                        Task { await store.switchProfile(name: profile.name) }
                    } label: {
                        if profile.name == store.activeProfile.name {
                            Label(profile.displayTitle, systemImage: "checkmark")
                        } else {
                            Text(profile.displayTitle)
                        }
                    }
                }
            }
            Divider()
            Button("Setup & Agents…") { store.isSetupOpen = true }
            Button("Add Project…") { store.isAddProjectSheetOpen = true }
            Button("Reconnect Local Toolroll") {
                Task { _ = await store.connectToLocalConsoleIfAvailable(silent: false) }
            }
            Button("Connect Remote Workspace…") { store.isPairSheetOpen = true }
            Button("Pair Phone for Push Alerts…") { store.isPhonePairSheetOpen = true }
            Button("Appearance & Themes…") { store.isAppearanceSheetOpen = true }
            if !store.activeProfile.isDemo {
                Divider()
                Button("Preview Demo Workspace") {
                    Task { await store.switchProfile(name: "demo") }
                }
            }
        } label: {
            HStack(spacing: 7) {
                ToolrollBrandMark(height: 16)
                Text("Toolroll")
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(ToolrollPalette.ink)
                Circle()
                    .fill(store.sseConnected ? ToolrollPalette.success : ToolrollPalette.muted)
                    .frame(width: 5.5, height: 5.5)
                    .help(store.sseConnected ? "Connected" : "Not connected")
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .toolrollHoverSurface(cornerRadius: 7, isSelected: false)
        .help("Workspace: \(store.activeProfile.displayTitle)")
        .accessibilityLabel("Toolroll workspace menu, \(store.activeProfile.displayTitle), \(store.sseConnected ? "connected" : "not connected")")
    }
}
