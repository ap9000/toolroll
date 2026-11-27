import SwiftUI
import ToolrollCompanionCore

enum WorkFilter: String, CaseIterable, Identifiable {
    case needsYou = "Needs you"
    case all = "All"
    case running = "Running"
    case done = "Done"
    var id: String { rawValue }
}

struct WorkInboxView: View {
    @Bindable var appState: CompanionAppState
    @State private var filter: WorkFilter = .needsYou
    @State private var showSettings = false

    private var filteredRows: [CompanionWorkRow] {
        switch filter {
        case .needsYou: return appState.workRows.filter { $0.status == .needsYou }
        case .all: return appState.workRows
        case .running: return appState.workRows.filter { $0.status == .running || $0.status == .queued }
        case .done: return appState.workRows.filter { $0.status == .finished }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    connectionBanner

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(WorkFilter.allCases) { item in
                                let count = countFor(item)
                                Button {
                                    withAnimation(.snappy(duration: 0.2)) { filter = item }
                                } label: {
                                    HStack(spacing: 6) {
                                        Text(item.rawValue)
                                        if count > 0 {
                                            Text("\(count)")
                                                .font(.caption2.monospacedDigit().weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 1)
                                                .background(filter == item ? ToolrollTheme.paper.opacity(0.2) : ToolrollTheme.hairline, in: Capsule())
                                        }
                                    }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(filter == item ? ToolrollTheme.paper : ToolrollTheme.ink)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .background(filter == item ? ToolrollTheme.ink : ToolrollTheme.surface, in: Capsule())
                                    .overlay(
                                        Capsule().stroke(ToolrollTheme.hairline, lineWidth: filter == item ? 0 : 1)
                                    )
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                    }

                    if filteredRows.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "checkmark.circle")
                                .font(.system(size: 30))
                                .foregroundStyle(ToolrollTheme.forest)
                            Text(filter == .needsYou ? "Nothing waiting on you" : "No tasks here")
                                .font(.headline)
                                .foregroundStyle(ToolrollTheme.ink)
                            Text("Pull down to refresh from your Mac.")
                                .font(.footnote)
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                    } else {
                        LazyVStack(spacing: 12) {
                            ForEach(filteredRows) { row in
                                NavigationLink {
                                    TaskDetailView(appState: appState, row: row)
                                } label: {
                                    WorkRowCard(row: row, isStale: appState.isStaleCache)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                .padding(.vertical, 12)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .refreshable {
                await appState.refreshWork()
            }
            .navigationTitle("Work")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(appState: appState)
            }
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusDotColor)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusHeadline)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                if appState.isStaleCache {
                    Text("Showing cached data · approvals disabled while unavailable")
                        .font(.caption2)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
            Spacer()
            if case .unavailable = appState.connection {
                Button("Retry") {
                    Task { await appState.reconnectIfPaired() }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(ToolrollTheme.cobalt)
            } else if appState.isDemoMode {
                StatusPill(label: "Demo", tint: ToolrollTheme.cobalt)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ToolrollTheme.hairline, lineWidth: 1)
        )
        .padding(.horizontal, 16)
    }

    private var statusDotColor: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.forest
        case .demo: return ToolrollTheme.cobalt
        case .connecting: return ToolrollTheme.amber
        case .unavailable, .restoredRequiresRePair: return ToolrollTheme.vermilion
        default: return ToolrollTheme.muted
        }
    }

    private var statusHeadline: String {
        switch appState.connection {
        case .demo:
            return "Demo Workspace · Read-Only Preview"
        case .connecting:
            return "Connecting over Noise IKpsk2…"
        case .connected(let label, _):
            return "Connected · \(label)"
        case .unavailable(let lastSeen, _):
            if let lastSeen {
                let rel = RelativeDateTimeFormatter().localizedString(for: lastSeen, relativeTo: Date())
                return "Unavailable · last seen \(rel)"
            }
            return "Unavailable"
        default:
            return "Not paired"
        }
    }

    private func countFor(_ item: WorkFilter) -> Int {
        switch item {
        case .needsYou: return appState.workRows.filter { $0.status == .needsYou }.count
        case .all: return appState.workRows.count
        case .running: return appState.workRows.filter { $0.status == .running || $0.status == .queued }.count
        case .done: return appState.workRows.filter { $0.status == .finished }.count
        }
    }
}

private struct WorkRowCard: View {
    let row: CompanionWorkRow
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                StatusPill(label: row.badgeLabel, tint: badgeTint)
                Text(row.project)
                    .font(.caption.monospaced().weight(.medium))
                    .foregroundStyle(ToolrollTheme.muted)
                Spacer()
                Text(row.age)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(ToolrollTheme.muted)
            }

            Text(row.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .multilineTextAlignment(.leading)

            if let ask = row.ask {
                Text(ask)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.ink.opacity(0.86))
                    .multilineTextAlignment(.leading)
            }

            HStack(spacing: 10) {
                if let checks = row.checksSummary {
                    Label(checks, systemImage: row.status == .finished || checks.contains("passed") ? "checkmark.seal.fill" : "clock")
                        .font(.caption)
                        .foregroundStyle(checks.contains("passed") || checks.contains("green") ? ToolrollTheme.forest : ToolrollTheme.muted)
                }
                Spacer()
                if row.addedLines > 0 || row.removedLines > 0 {
                    HStack(spacing: 4) {
                        Text("+\(row.addedLines)")
                            .foregroundStyle(ToolrollTheme.forest)
                        Text("-\(row.removedLines)")
                            .foregroundStyle(ToolrollTheme.vermilion)
                    }
                    .font(.caption.monospacedDigit().weight(.medium))
                }
            }
        }
        .padding(16)
        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(row.status == .needsYou ? ToolrollTheme.vermilion.opacity(0.32) : ToolrollTheme.hairline, lineWidth: 1)
        )
        .opacity(isStale ? 0.72 : 1.0)
    }

    private var badgeTint: Color {
        switch row.status {
        case .needsYou: return row.needGroup == "Review" ? ToolrollTheme.forest : ToolrollTheme.vermilion
        case .running: return ToolrollTheme.cobalt
        case .queued: return ToolrollTheme.amber
        case .finished: return ToolrollTheme.forest
        case .failed: return ToolrollTheme.vermilion
        }
    }
}
