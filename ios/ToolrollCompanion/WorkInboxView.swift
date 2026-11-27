import SwiftUI
import ToolrollCompanionCore

enum WorkFilter: String, CaseIterable, Identifiable {
    case needsYou
    case all
    case running
    case done

    var id: String { rawValue }

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .all: return "All"
        case .running: return "Running"
        case .done: return "Done"
        }
    }

    /// The server's Work view for this filter.
    var view: WorkView {
        switch self {
        case .needsYou: return .needsYou
        case .all: return .all
        case .running: return .running
        case .done: return .completed
        }
    }
}

struct WorkInboxView: View {
    @Bindable var appState: CompanionAppState
    @State private var filter: WorkFilter = .needsYou
    @State private var showSettings = false
    @State private var showScanner = false
    @State private var path: [Route] = []
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var page: Loadable<InboxPage> { appState.inbox(filter.view) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    statusLine
                        .padding(.bottom, 2)
                    if appState.connection == .notRecognized {
                        notRecognizedCard
                    }
                    filterControl
                        .padding(.bottom, 4)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .refreshable { await appState.loadInbox(filter.view) }
            .navigationTitle("Work")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .task(let id):
                    TaskDetailView(appState: appState, taskId: id)
                case .diff(let diff):
                    DiffFileView(appState: appState, route: diff)
                }
            }
            .task(id: "\(filter.rawValue)#\(appState.refreshTick)#\(appState.isDemoMode)") {
                await appState.loadInbox(filter.view)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(appState: appState)
            }
            .sheet(isPresented: $showScanner) {
                PairingScannerSheet { payload in
                    showScanner = false
                    appState.startPairing(payload: payload)
                }
            }
            .alert(
                "Pairing didn't finish",
                isPresented: Binding(
                    get: { appState.pairingError != nil && appState.isPaired },
                    set: { if !$0 { appState.pairingError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { appState.pairingError = nil }
            } message: {
                Text(appState.pairingError ?? "")
            }
        }
        .discardingLinks()
        .onAppear(perform: applyDebugScreen)
    }

    // MARK: Status

    /// Connection or demo status as one line under the title.
    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            if !dynamicTypeSize.isAccessibilitySize {
                Circle()
                    .fill(statusDot)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
            }
            Text(statusText)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
            if appState.connection.isUnreachable {
                Spacer(minLength: 8)
                Button("Retry") { Task { await appState.retry() } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
        }
        .frame(minHeight: 24)
        .accessibilityElement(children: .combine)
    }

    private var macName: String {
        appState.workspaceLabel == "Your Mac" ? "your Mac" : appState.workspaceLabel
    }

    private var statusText: String {
        switch appState.connection {
        case .demo:
            return "Demo · sample work, nothing leaves this iPhone"
        case .connecting:
            return "Connecting to \(macName)…"
        case .connected:
            return "Connected to \(macName)"
        case .unreachable(let lastUpdated):
            if let lastUpdated {
                return "Can't reach your Mac · last updated \(RelativeTime.ago(lastUpdated))"
            }
            return "Can't reach your Mac"
        case .notRecognized:
            return "Your Mac didn't accept this iPhone"
        case .unpaired:
            return "Not paired"
        }
    }

    private var statusDot: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .unreachable, .notRecognized: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
    }

    private var notRecognizedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("If this iPhone was removed on your Mac, pair it again. Otherwise, try again.")
                .font(.callout)
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { notRecognizedButtons }
                VStack(spacing: 10) { notRecognizedButtons }
            }
        }
        .padding(16)
        .card()
    }

    @ViewBuilder
    private var notRecognizedButtons: some View {
        Button("Try again") { Task { await appState.retry() } }
            .buttonStyle(OutlineButtonStyle())
        Button("Pair again") { showScanner = true }
            .buttonStyle(InkButtonStyle())
    }

    // MARK: Filters

    @ViewBuilder
    private var filterControl: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Menu {
                Picker("Show", selection: $filter) {
                    ForEach(WorkFilter.allCases) { item in
                        Text(label(for: item)).tag(item)
                    }
                }
            } label: {
                HStack {
                    Text("Show: \(label(for: filter))")
                        .font(.headline)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.subheadline)
                }
                .foregroundStyle(ToolrollTheme.ink)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .card(radius: 12)
            }
            .accessibilityLabel("Show \(label(for: filter))")
        } else {
            HStack(spacing: 6) {
                ForEach(WorkFilter.allCases) { item in
                    chip(item)
                }
            }
        }
    }

    private func label(for item: WorkFilter) -> String {
        if item == .needsYou, let count = appState.needsCount, count > 0 {
            return "\(item.title) (\(count))"
        }
        return item.title
    }

    private func chip(_ item: WorkFilter) -> some View {
        let selected = filter == item
        return Button {
            withAnimation(.snappy(duration: 0.2)) { filter = item }
        } label: {
            HStack(spacing: 5) {
                Text(item.title)
                    .lineLimit(1)
                if item == .needsYou, let count = appState.needsCount, count > 0 {
                    Text("\(count)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(selected ? ToolrollTheme.ink : ToolrollTheme.onInk)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(selected ? ToolrollTheme.onInk : ToolrollTheme.ink, in: Capsule())
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? ToolrollTheme.onInk : ToolrollTheme.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(selected ? ToolrollTheme.ink : ToolrollTheme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollTheme.hairline, lineWidth: selected ? 0 : 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(for: item))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let value = page.value {
            if value.rows.isEmpty && value.otherNeeds.isEmpty {
                if let failure = page.failure {
                    failedState(failure)
                } else if page.phase == .loaded {
                    emptyState
                } else {
                    loadingState
                }
            } else {
                if let failure = page.failure, !appState.isOffline {
                    inlineFailure(failure)
                }
                ForEach(value.rows) { row in
                    NavigationLink(value: Route.task(row.id)) {
                        WorkRowCard(row: row)
                    }
                    .buttonStyle(.plain)
                    .opacity(appState.isOffline ? 0.55 : 1)
                }
                ForEach(value.otherNeeds) { need in
                    NeedOnlyCard(need: need)
                        .opacity(appState.isOffline ? 0.55 : 1)
                }
                if value.next != nil {
                    loadMore
                }
            }
        } else if let failure = page.failure {
            failedState(failure)
        } else {
            loadingState
        }
    }

    private var loadingState: some View {
        HStack {
            Spacer()
            ProgressView()
                .padding(.vertical, 48)
            Spacer()
        }
        .accessibilityLabel("Loading")
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: filter == .needsYou ? "checkmark.circle" : "tray")
                .font(.system(size: 30))
                .foregroundStyle(filter == .needsYou ? ToolrollTheme.success : ToolrollTheme.muted)
                .accessibilityHidden(true)
            Text(emptyTitle)
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text(emptySubtitle)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    private var emptyTitle: String {
        switch filter {
        case .needsYou: return "Nothing waiting on you"
        case .all: return "No tasks yet"
        case .running: return "Nothing running"
        case .done: return "Nothing finished yet"
        }
    }

    private var emptySubtitle: String {
        switch filter {
        case .needsYou: return "When an agent needs a decision or a review, it shows up here."
        case .all: return "Tasks you start on your Mac show up here."
        case .running: return "Builds in progress show up here."
        case .done: return "Finished work shows up here."
        }
    }

    @ViewBuilder
    private func failedState(_ message: String) -> some View {
        if appState.isOffline {
            // The status line already says the Mac can't be reached and offers Retry.
            VStack(spacing: 8) {
                Text("Nothing to show yet")
                    .font(.headline)
                    .foregroundStyle(ToolrollTheme.ink)
                Text("Your work shows up here once this iPhone can reach your Mac.")
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else {
            failedCard(message)
        }
    }

    private func failedCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Text("Couldn't load your work")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .multilineTextAlignment(.center)
            Button("Try again") { Task { await appState.loadInbox(filter.view) } }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private func inlineFailure(_ message: String) -> some View {
        HStack(spacing: 8) {
            Text("Couldn't refresh. \(message)")
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.ink)
            Spacer(minLength: 8)
            Button("Retry") { Task { await appState.loadInbox(filter.view) } }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, 14)
        .background(ToolrollTheme.neutralSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var loadMore: some View {
        HStack {
            Spacer()
            if page.isLoading {
                ProgressView()
            } else {
                Button("Load more") { Task { await appState.loadMore(filter.view) } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
            Spacer()
        }
        .onAppear { Task { await appState.loadMore(filter.view) } }
    }

    private func applyDebugScreen() {
        #if DEBUG
        guard let screen = appState.debugScreen else { return }
        appState.debugScreen = nil
        let parts = screen.split(separator: ":").map(String.init)
        switch parts.first {
        case "settings":
            showSettings = true
        case "all":
            filter = .all
        case "task" where parts.count >= 2:
            path = [.task(parts[1])]
        case "live" where parts.count >= 2:
            path = [.task(parts[1])]
            appState.debugScreen = "openLive"
        case "diff" where parts.count >= 3:
            let task = parts[1], file = Int(parts[2]) ?? 0
            Task {
                await appState.loadDiff(task)
                if let diff = appState.diff(task).value, let run = diff.run,
                   let entry = diff.files.first(where: { $0.file == file }) {
                    path = [.task(task), .diff(DiffRoute(task: task, run: run, file: entry.file, path: entry.path,
                                                        additions: entry.additions, deletions: entry.deletions))]
                }
            }
        default:
            break
        }
        #endif
    }
}

extension CompanionConnectionState {
    var isUnreachable: Bool {
        if case .unreachable = self { return true }
        return false
    }
}

/// One Work row: one state word, the title, one line of what it asks, one check result.
struct WorkRowCard: View {
    let row: WorkRow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let kind = row.kind
        VStack(alignment: .leading, spacing: 8) {
            meta(kind)

            Text(row.title)
                .font(.body.weight(kind.isNeedsYou ? .semibold : .medium))
                .foregroundStyle(ToolrollTheme.ink)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let ask = row.askLine {
                Text(ask)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                    .multilineTextAlignment(.leading)
            }

            if let check = row.checkLine {
                Label(check.text, systemImage: check.symbol)
                    .font(.footnote)
                    .foregroundStyle(check.tone.hue)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(needsYou: kind.isNeedsYou)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the task")
    }

    @ViewBuilder
    private func meta(_ kind: RowKind) -> some View {
        let chip = StateChip(word: kind.word(for: row), tone: kind.tone)
        let detail = [row.project, row.age].compactMap { $0 }.joined(separator: " · ")
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                chip
                Text(detail).font(.caption).foregroundStyle(ToolrollTheme.muted)
            }
        } else {
            HStack(spacing: 8) {
                chip
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
        }
    }
}

/// A waiting ask that isn't a task (a held release, a flow card, a setup step): answered on the Mac.
struct NeedOnlyCard: View {
    let need: NeedRow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StateChip(word: word, tone: .needs)
                Text([need.project, need.age].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(1)
            }
            Text(need.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
            if let line = need.line ?? need.reason {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
            }
            Label("Open Toolroll on your Mac to answer", systemImage: "lock")
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(needsYou: true)
        .accessibilityElement(children: .combine)
    }

    private var word: String {
        switch need.group {
        case .review: return "Review"
        case .unblock: return "Unblock"
        default: return "Decide"
        }
    }
}
