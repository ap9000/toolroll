import SwiftUI
import ToolrollCore

/// Left rail (255px, --so-ground) — calm, pared-down vertical inbox with solo-aware progressive disclosure.
public struct InboxSidebarView: View {
    @Bindable var store: WorkbenchStore
    @State private var searchExpanded: Bool = false

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Minimal header row (search expands only when clicked; team pills appear only in multi-dev workspaces)
            VStack(spacing: 8) {
                HStack(spacing: 6) {
                    Text("Tasks")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                    if !store.sidebarSearch.isEmpty || store.selectedProject != nil {
                        Button("Clear") {
                            store.sidebarSearch = ""
                            store.selectedProject = nil
                            searchExpanded = false
                        }
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .buttonStyle(.plain)
                    }
                    Button {
                        withAnimation(.easeInOut(duration: 0.12)) {
                            searchExpanded.toggle()
                            if !searchExpanded { store.sidebarSearch = "" }
                        }
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11))
                            .foregroundStyle(searchExpanded ? ToolrollPalette.ink : ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                    .help("Filter tasks")
                }

                if searchExpanded {
                    HStack(spacing: 6) {
                        TextField("Filter tasks…", text: $store.sidebarSearch)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12))
                            .foregroundStyle(ToolrollPalette.ink)
                        if !store.sidebarSearch.isEmpty {
                            Button {
                                store.sidebarSearch = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(ToolrollPalette.muted)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                }

                // Team filter appears ONLY in multi-developer workspaces — zero clutter for solo builders!
                if store.isTeamWorkspace {
                    HStack(spacing: 4) {
                        ForEach(TeamFilter.allCases) { filter in
                            let active = store.teamFilter == filter
                            Button {
                                store.teamFilter = filter
                            } label: {
                                Text(filter.rawValue)
                                    .font(.system(size: 10.5, weight: active ? .semibold : .regular))
                                    .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .frame(maxWidth: .infinity)
                                    .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            HairlineDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if !store.needsRows.isEmpty {
                        inboxSection(title: "Needs you", count: store.needsRows.count, solidBadge: true, rows: store.needsRows)
                    }
                    if !store.runningRows.isEmpty {
                        inboxSection(title: "Running", count: store.runningRows.count, solidBadge: false, rows: store.runningRows)
                    }
                    if !store.queuedRows.isEmpty {
                        inboxSection(title: "Queued", count: store.queuedRows.count, solidBadge: false, rows: store.queuedRows)
                    }
                    if !store.failedRows.isEmpty {
                        inboxSection(title: "Failed", count: store.failedRows.count, solidBadge: false, rows: store.failedRows)
                    }

                    if !store.finishedRows.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Button {
                                store.isFinishedDrawerOpen.toggle()
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: store.isFinishedDrawerOpen ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundStyle(ToolrollPalette.muted)
                                    Text("Finished")
                                        .font(.system(size: 10.5, weight: .semibold))
                                        .textCase(.uppercase)
                                        .tracking(0.6)
                                        .foregroundStyle(ToolrollPalette.muted)
                                    Spacer()
                                    Text("\(store.finishedRows.count)")
                                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.muted)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 3)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if store.isFinishedDrawerOpen {
                                ForEach(store.finishedRows) { row in
                                    inboxRow(row)
                                }
                            }
                        }
                    }

                    if store.filteredRows.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("All clear.")
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                            Button("+ New Task") {
                                store.isNewTaskSheetOpen = true
                            }
                            .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        }
                        .padding(14)
                    }
                }
                .padding(.vertical, 10)
            }

            HairlineDivider()

            // Quiet 2-action footer (Lead + Terminals)
            HStack(spacing: 12) {
                Button {
                    store.isInspectorVisible = true
                    store.inspectorTab = .lead
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "text.bubble")
                            .font(.system(size: 11))
                        Text("Lead")
                            .font(.system(size: 11.5, weight: .medium))
                    }
                    .foregroundStyle(store.isInspectorVisible && store.inspectorTab == .lead ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(.plain)

                Button {
                    store.isInspectorVisible = true
                    store.inspectorTab = .terminal
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "terminal")
                            .font(.system(size: 11))
                        Text(store.activeTerminalCount > 0 ? "Terminal (\(store.activeTerminalCount))" : "Terminal")
                            .font(.system(size: 11.5, weight: .medium))
                    }
                    .foregroundStyle(store.isInspectorVisible && store.inspectorTab == .terminal ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(.plain)

                Spacer()

                if let spend = store.workRowsResponse.spend {
                    Text(String(format: "$%.2f", spend.todayUsd))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
        .background(ToolrollPalette.ground)
    }

    private func inboxSection(title: String, count: Int, solidBadge: Bool, rows: [WorkRow]) -> some View {
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
            .padding(.bottom, 3)

            ForEach(rows) { row in
                inboxRow(row)
            }
        }
    }

    private func inboxRow(_ row: WorkRow) -> some View {
        let isSelected = store.selectedTaskId == row.id
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

                HStack(spacing: 6) {
                    if let project = row.project, !project.isEmpty {
                        Text(project)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
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
