import SwiftUI
import ToolrollCore

/// Left rail (260px, --so-ground) — attention-first vertical inbox inspired by T3 Code & Rex.
public struct InboxSidebarView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Search & filter bar
            VStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
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
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
                )

                // Compact team filter segmented pills
                HStack(spacing: 4) {
                    ForEach(TeamFilter.allCases) { filter in
                        let active = store.teamFilter == filter
                        Button {
                            store.teamFilter = filter
                        } label: {
                            Text(filter.rawValue)
                                .font(.system(size: 10.5, weight: active ? .semibold : .regular))
                                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .frame(maxWidth: .infinity)
                                .background(
                                    active ? ToolrollPalette.paper : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 4, style: .continuous)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(10)

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
                                .padding(.horizontal, 10)
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
                        VStack(alignment: .leading, spacing: 6) {
                            Text("No tasks match this filter.")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                            if store.teamFilter != .everyone || !store.sidebarSearch.isEmpty || store.selectedProject != nil {
                                Button("Reset filters") {
                                    store.teamFilter = .everyone
                                    store.sidebarSearch = ""
                                    store.selectedProject = nil
                                }
                                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                            }
                        }
                        .padding(14)
                    }
                }
                .padding(.vertical, 10)
            }

            HairlineDivider()

            // Footer: Lead Thread, Live Terminals, SSE status & Spend
            VStack(spacing: 6) {
                HStack(spacing: 6) {
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
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))

                    Button {
                        store.isInspectorVisible = true
                        store.inspectorTab = .terminal
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "terminal")
                                .font(.system(size: 11))
                            Text("Terminals (\(store.activeTerminalCount))")
                                .font(.system(size: 11.5, weight: .medium))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                HStack(spacing: 6) {
                    Circle()
                        .fill(store.sseConnected ? ToolrollPalette.live : ToolrollPalette.muted)
                        .frame(width: 6, height: 6)
                    Text(store.activeProfile.isDemo ? "Demo preview" : (store.sseConnected ? "Live SSE" : "Reconnecting"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                    if let spend = store.workRowsResponse.spend {
                        Text(String(format: "$%.2f today", spend.todayUsd))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
            }
            .padding(10)
        }
        .background(ToolrollPalette.ground)
    }

    private func inboxSection(title: String, count: Int, solidBadge: Bool, rows: [WorkRow]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(solidBadge ? ToolrollPalette.ink : ToolrollPalette.muted)
                Spacer()
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(solidBadge ? ToolrollPalette.inverseInk : ToolrollPalette.muted)
                    .padding(.horizontal, solidBadge ? 6 : 2)
                    .padding(.vertical, solidBadge ? 1.5 : 0)
                    .background(
                        solidBadge ? ToolrollPalette.ink : Color.clear,
                        in: RoundedRectangle(cornerRadius: 3, style: .continuous)
                    )
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 2)

            ForEach(rows) { row in
                inboxRow(row)
            }
        }
    }

    private func inboxRow(_ row: WorkRow) -> some View {
        let isSelected = store.selectedTaskId == row.id
        let pres = store.presence.tasks[row.id]
        let owner = store.presence.owners[row.id] ?? nil

        return Button {
            Task { await store.selectTask(row.id) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top, spacing: 6) {
                    statusDot(for: row.status)
                        .padding(.top, 5)
                    Text(row.title)
                        .font(.system(size: 12.5, weight: isSelected ? .semibold : .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Text(row.age)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                HStack(spacing: 6) {
                    if let project = row.project, !project.isEmpty {
                        Text(project)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    if let owner, !owner.isEmpty {
                        Text("· @\(owner)")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    Spacer()
                    if let chip = row.chip, !chip.isEmpty {
                        Text(chip)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                }
                .padding(.leading, 12)

                if let summary = pres?.summary {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(pres?.terminalController != nil ? ToolrollPalette.live : ToolrollPalette.muted)
                            .frame(width: 5, height: 5)
                        Text(summary)
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                    .padding(.leading, 12)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected ? ToolrollPalette.paper : Color.clear,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(isSelected ? ToolrollPalette.line : Color.clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
    }

    @ViewBuilder
    private func statusDot(for tone: TaskStatusTone) -> some View {
        switch tone {
        case .needs:
            RoundedRectangle(cornerRadius: 1.5)
                .fill(ToolrollPalette.ink)
                .frame(width: 6, height: 6)
        case .running:
            Circle()
                .fill(ToolrollPalette.live)
                .frame(width: 6, height: 6)
        case .finished:
            Circle()
                .fill(ToolrollPalette.success)
                .frame(width: 6, height: 6)
        case .failed:
            Circle()
                .fill(ToolrollPalette.danger)
                .frame(width: 6, height: 6)
        case .queued, .unknown:
            Circle()
                .strokeBorder(ToolrollPalette.muted, lineWidth: 1)
                .frame(width: 6, height: 6)
        }
    }
}
