import SwiftUI
import ToolrollCore

/// Left rail (--so-ground) — active work up top, expandable `Settled` pinned cleanly to the bottom,
/// and a quiet utility icon strip. Zero clutter, maximum focus on what's live.
public struct InboxSidebarView: View {
    @Bindable var store: WorkbenchStore
    @State private var searchExpanded: Bool = false
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Top bar: Search + Filter + Add Project + New Task
            HStack(spacing: 8) {
                if searchExpanded {
                    HStack(spacing: 5) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                        TextField("Search", text: $store.sidebarSearch)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12))
                            .foregroundStyle(ToolrollPalette.ink)
                            .focused($searchFocused)
                        Button {
                            store.sidebarSearch = ""
                            searchExpanded = false
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                } else {
                    Button {
                        searchExpanded = true
                        searchFocused = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 11))
                            Text("Search")
                                .font(.system(size: 12))
                            Spacer()
                        }
                        .foregroundStyle(ToolrollPalette.muted)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }

                // Filter popover (Project + Team when multi-dev)
                Menu {
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
                    Image(systemName: "line.3.horizontal.decrease")
                        .font(.system(size: 11.5))
                        .foregroundStyle(store.selectedProject != nil || store.teamFilter != .everyone ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Filter by project or owner")

                // Add local project folder (⌘⇧O)
                Button {
                    store.pickAndAddLocalFolder()
                } label: {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("Add Local Project Folder (⌘⇧O)")

                // New task inline canvas (⌘N)
                Button {
                    store.openNewWorkCanvas()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12))
                        .foregroundStyle(store.isComposingNewWork ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("New Task (⌘N)")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            // Active work list (Needs you, Running, Queued)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if !store.needsRows.isEmpty {
                        activeSection(title: "Needs you", count: store.needsRows.count, solidBadge: true, rows: store.needsRows)
                    }
                    if !store.runningRows.isEmpty {
                        activeSection(title: "Running", count: store.runningRows.count, solidBadge: false, rows: store.runningRows)
                    }
                    if !store.queuedRows.isEmpty {
                        activeSection(title: "Queued", count: store.queuedRows.count, solidBadge: false, rows: store.queuedRows)
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
                        .padding(.top, 10)
                    }
                }
                .padding(.vertical, 8)
            }
            .frame(maxHeight: .infinity)

            // Bottom-pinned expandable Settled section (Finished + Failed)
            if !store.settledRows.isEmpty {
                HairlineDivider()

                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            store.isSettledExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text("Settled")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Text("\(store.settledRows.count)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                            Image(systemName: store.isSettledExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if store.isSettledExpanded {
                        let visibleSettled = Array(store.settledRows.prefix(store.settledDisplayLimit))
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 1) {
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
                                                .font(.system(size: 11.5))
                                        }
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.bottom, 6)
                        }
                        .frame(maxHeight: 280)
                    }
                }
            }

            HairlineDivider()

            // Minimal bottom utility icon bar
            HStack(spacing: 14) {
                Button {
                    store.isSetupOpen = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("Setup & Agents (⌘,)")

                Button {
                    store.toggleInspector(tab: .terminal)
                } label: {
                    Image(systemName: "terminal")
                        .font(.system(size: 12))
                        .foregroundStyle(store.isInspectorVisible && store.inspectorTab == .terminal ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("Live Terminal (⌘1)")

                Button {
                    store.toggleInspector(tab: .lead)
                } label: {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 12))
                        .foregroundStyle(store.isInspectorVisible && store.inspectorTab == .lead ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("Lead Thread (⌘L)")

                Spacer()

                if let spend = store.workRowsResponse.spend {
                    Text(String(format: "$%.2f", spend.todayUsd))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                Button {
                    Task { await store.refreshAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
                .help("Refresh (⌘R)")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
        .background(ToolrollPalette.ground)
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
                    .background(solidBadge ? ToolrollPalette.ink : Color.clear, in: RoundedRectangle(cornerRadius: 3))
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
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(isSelected ? ToolrollPalette.line : Color.clear, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
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
                    .background(ToolrollPalette.raised, in: Circle())
                    .overlay(Circle().strokeBorder(ToolrollPalette.line, lineWidth: 1))

                Text(row.title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 6)

                Text(row.age)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5.5)
            .background(isSelected ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
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
