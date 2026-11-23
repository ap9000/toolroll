import SwiftUI
import ToolrollCore

/// The Work screen (version A, "Quiet list"), built from widgets: a summary, limits, and the grouped list.
/// Rows group by the server's own `rank`, never by tone, so a row can't land in the wrong section.
struct WorkHomeView: View {
    @Bindable var store: WorkbenchStore
    @State private var layout = WorkLayout.load()
    @State private var isCustomizing = false
    @State private var showsAllSettled = false

    private static let settledPreview = 6

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ForEach(layout.widgets.filter { !$0.isHidden }) { widget in
                    switch widget.kind {
                    case .header: header
                    case .limits: limits
                    case .list: list
                    }
                }
            }
            .padding(.horizontal, 44)
            .padding(.vertical, 32)
            .frame(maxWidth: 1040, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(ToolrollPalette.ground)
        .sheet(isPresented: $isCustomizing) {
            WorkCustomizeSheet(layout: $layout) { isCustomizing = false }
        }
        .onChange(of: layout) { _, saved in saved.save() }
    }

    // MARK: Groups by rank (0 waits on a person, 1 runs, 2 queued/waiting, 3 finished, 4 stopped or put away)

    private var rows: [WorkRow] { store.filteredRows }
    private var waiting: [WorkRow] { rows.filter { $0.rank == 0 } }
    private var running: [WorkRow] { rows.filter { $0.rank == 1 } }
    private var queued: [WorkRow] { rows.filter { $0.rank == 2 } }
    private var settled: [WorkRow] { rows.filter { $0.rank >= 3 } }
    private var asks: [NeedRow] { store.workRowsResponse.needs.flatMap(\.rows) }

    // MARK: Summary

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("Work")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text(summaryLine)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.muted)
            Spacer()
            Button { isCustomizing = true } label: {
                Label("Customize", systemImage: "slider.horizontal.3")
                    .font(.system(size: 12.5, weight: .medium))
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Reorder or hide what Work shows")
            Button { store.openNewWorkCanvas() } label: {
                Label("New task", systemImage: "plus")
                    .font(.system(size: 12.5, weight: .medium))
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("New task (⌘N)")
        }
    }

    private var summaryLine: String {
        let waitingCount = waiting.count + asks.count
        return "\(waitingCount) waiting on you · \(running.count) running · \(settled.count) settled"
    }

    // MARK: Limits (only what /work/rows `spend` supplies; its audience is the owner, so it's absent for others)

    @ViewBuilder private var limits: some View {
        if let spend = store.workRowsResponse.spend {
            HStack(spacing: 28) {
                if let percent = spend.planPercent {
                    HStack(spacing: 10) {
                        Text("Plan")
                            .foregroundStyle(ToolrollPalette.muted)
                        meter(percent)
                        Text(percent >= 100 ? "Limit reached" : "\(percent)%")
                            .foregroundStyle(percent >= 100 ? ToolrollPalette.danger : ToolrollPalette.ink)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(percent >= 100 ? "Plan limit reached" : "Plan \(percent) percent used")
                }
                HStack(spacing: 6) {
                    Text(spend.todayUsd, format: .currency(code: "USD"))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("today").foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
            }
            .font(.system(size: 12.5))
            .padding(.horizontal, 16)
            .frame(height: 44)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func meter(_ percent: Int) -> some View {
        let clamped = Double(max(0, min(100, percent))) / 100
        return ZStack(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.10))
            Capsule()
                .fill(percent >= 100 ? ToolrollPalette.danger : ToolrollPalette.ink)
                .frame(width: 84 * clamped)
        }
        .frame(width: 84, height: 4)
    }

    // MARK: Work list

    @ViewBuilder private var list: some View {
        if rows.isEmpty && asks.isEmpty {
            allClear
        } else {
            VStack(alignment: .leading, spacing: 18) {
                if !waiting.isEmpty || !asks.isEmpty {
                    group("Waiting on you", count: waiting.count + asks.count, dot: ToolrollPalette.ink) {
                        ForEach(waiting) { taskRow($0) }
                        ForEach(asks, id: \.id) { askRow($0) }
                    }
                }
                if !running.isEmpty {
                    group("Running", count: running.count, dot: ToolrollPalette.live) { ForEach(running) { taskRow($0) } }
                }
                if !queued.isEmpty {
                    group("Queued", count: queued.count, dot: ToolrollPalette.muted) { ForEach(queued) { taskRow($0) } }
                }
                if !settled.isEmpty {
                    let shown = showsAllSettled ? settled : Array(settled.prefix(Self.settledPreview))
                    group("Settled", count: settled.count, dot: nil) {
                        ForEach(shown) { taskRow($0, quiet: true) }
                        if settled.count > Self.settledPreview {
                            Button(showsAllSettled ? "Show fewer" : "Show all \(settled.count)") { showsAllSettled.toggle() }
                                .buttonStyle(.plain)
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.leading, 16)
                                .padding(.top, 4)
                        }
                    }
                }
            }
        }
    }

    private var allClear: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("All clear")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Nothing is waiting on you or running.")
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.muted)
            Button("New task") { store.openNewWorkCanvas() }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
        }
        .padding(.top, 24)
    }

    private func group<Content: View>(_ title: String, count: Int, dot: Color?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                if let dot {
                    Circle().fill(dot).frame(width: 7, height: 7)
                } else {
                    Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1).frame(width: 7, height: 7)
                }
                Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(ToolrollPalette.ink)
                Text("\(count)").font(.system(size: 12.5)).foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func taskRow(_ row: WorkRow, quiet: Bool = false) -> some View {
        Button {
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(spacing: 12) {
                statusDot(row.status)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.system(size: 14))
                        .foregroundStyle(quiet ? ToolrollPalette.muted : ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(subtitle(row))
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 12)
                if let chip = row.chip, !chip.isEmpty {
                    Text(chip)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 9)
                        .frame(height: 22)
                        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                Text(row.age)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(minWidth: 34, alignment: .trailing)
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .contentShape(Rectangle())
            .toolrollHoverSurface(cornerRadius: 10, isSelected: false)
        }
        .buttonStyle(.plain)
        .contextMenu { TaskRowMenuItems(store: store, row: row) }
        .accessibilityLabel("\(row.title), \(row.word)\(row.project.map { ", \($0)" } ?? ""), \(row.age)")
    }

    private func askRow(_ need: NeedRow) -> some View {
        HStack(spacing: 12) {
            Circle().fill(ToolrollPalette.ink).frame(width: 7, height: 7)
            Text(need.line ?? need.ask ?? need.reason ?? "Waiting on you")
                .font(.system(size: 14))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 16)
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
}

/// Customize Work: reorder and hide widgets. Saved on this Mac; "Reset" returns to the standard layout.
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
