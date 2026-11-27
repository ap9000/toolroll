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
    @State private var refreshed = 0
    @State private var confirmRemove = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var page: Loadable<InboxPage> { appState.inbox(filter.view) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    statusLine
                        .padding(.bottom, 2)
                    if case .unreachable(let hint) = appState.connection {
                        if appState.localNetworkDenied {
                            LocalNetworkCard()
                        } else {
                            hintLine(hint)
                        }
                    }
                    if appState.isTerminal {
                        // The Mac removed this iPhone, or its pairing data is damaged: nothing else on this screen
                        // applies (U10).
                        terminalCard
                    } else {
                        if appState.isOffline, page.value != nil {
                            StaleDataBanner(lastUpdated: appState.lastUpdated)
                        }
                        filterControl
                            .padding(.bottom, 4)
                        content
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .environment(\.showsStaleData, appState.isOffline)
            .refreshable {
                guard !appState.isTerminal else { return }
                await appState.loadInbox(filter.view)
                if page.phase == .loaded { refreshed += 1 }
            }
            .sensoryFeedback(.success, trigger: refreshed)
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
            .task(id: "\(filter.rawValue)#\(appState.isDemoMode)") {
                // While this list is on screen and connected, keep it current.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled else { return }
                    if appState.canAutoRefresh { await appState.loadInbox(filter.view, quiet: true) }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(appState: appState)
            }
            .sheet(isPresented: $showScanner) {
                PairingScannerSheet(deviceName: $appState.deviceName) { payload in
                    showScanner = false
                    appState.startPairing(payload: payload)
                }
            }
            .onChange(of: showScanner) { _, shown in appState.presentingSystemUI = shown }
            .confirmationDialog("Remove from this iPhone?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await appState.unpairThisPhone() } }
            } message: {
                Text("This iPhone forgets the pairing and its keys. Your Mac already removed it.")
            }
            .alert(
                appState.pairingErrorTitle,
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

    /// Connection or demo status as one line under the title. The status words and Retry are separate VoiceOver
    /// elements (U20).
    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                if !dynamicTypeSize.isAccessibilitySize {
                    Circle()
                        .fill(statusDot)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                if appState.isReconnecting {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityHidden(true)
                }
                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
            }
            .accessibilityElement(children: .combine)
            if appState.connection.isUnreachable && !appState.isReconnecting {
                Spacer(minLength: 8)
                Button("Retry") { Task { await appState.retry() } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
                    .accessibilityHint("Tries to reach your Mac again.")
            }
        }
        .frame(minHeight: 24)
    }

    private var macName: String {
        appState.workspaceLabel == "Your Mac" ? "your Mac" : appState.workspaceLabel
    }

    private var statusText: String {
        if appState.isReconnecting, !appState.isDemoMode { return "Reconnecting…" }
        switch appState.connection {
        case .demo:
            return "Demo · sample work, nothing leaves this iPhone"
        case .connecting:
            return "Connecting to \(macName)…"
        case .connected:
            return "Connected to \(macName)"
        case .unreachable:
            // How old the shown data is goes in the banner below; what to do, in the hint line.
            return "Can't reach your Mac"
        case .refused, .damaged:
            // The card below says why; the status line only says where things stand.
            return "Not connected"
        case .unpaired:
            return "Not paired"
        }
    }

    private var statusDot: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
    }

    /// What the person can do while the Mac can't be reached (U9). "Reset or restored" also offers Pair again.
    private func hintLine(_ hint: CompanionUnreachableHint) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(CompanionConnectionPolicy.hintMessage(hint))
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if hint == .differentMachine {
                Button("Pair again") { showScanner = true }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Refused or damaged: why, Pair again, and a quiet way to clean up this iPhone (U10).
    private var terminalCard: some View {
        let copy: (title: String, body: String)
        if case .refused(let reason) = appState.connection {
            copy = CompanionConnectionPolicy.refusedMessage(reason: reason)
        } else {
            copy = CompanionConnectionPolicy.damagedMessage
        }
        return VStack(alignment: .leading, spacing: 12) {
            Text(copy.title)
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
                .accessibilityAddTraits(.isHeader)
            Text(copy.body)
                .font(.callout)
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair again") { showScanner = true }
                .buttonStyle(InkButtonStyle())
            Button("Remove from this iPhone") { confirmRemove = true }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.danger)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .padding(16)
        .card()
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
                }
                ForEach(value.otherNeeds) { need in
                    NeedOnlyCard(need: need)
                }
                if value.next != nil {
                    loadMore(failure: value.moreFailure)
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
            if filter == .needsYou {
                // A first launch lands here: a way to the work that does exist (U22).
                Button("Show all work") { withAnimation(.snappy(duration: 0.2)) { filter = .all } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
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
        case .running: return "Tasks agents are working on show up here."
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

    /// The next page: loads as it scrolls into view; after a failure the button stays, with the reason beside it.
    private func loadMore(failure: String?) -> some View {
        VStack(spacing: 4) {
            if page.isLoading {
                ProgressView()
                    .frame(minHeight: 44)
            } else {
                Button(failure == nil ? "Load more" : "Try loading more") { Task { await appState.loadMore(filter.view) } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
            if let failure, !page.isLoading {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .onAppear {
            guard failure == nil else { return }
            Task { await appState.loadMore(filter.view) }
        }
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

/// iOS blocks this app from the local network: say so, and open the app's Settings page to turn it on.
/// (Opened with UIApplication: screens showing agent text discard `openURL`.)
struct LocalNetworkCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Allow Local Network for Toolroll")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text("This iPhone can't reach your Mac on your Wi-Fi until Local Network is on for Toolroll.")
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(OutlineButtonStyle())
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
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
