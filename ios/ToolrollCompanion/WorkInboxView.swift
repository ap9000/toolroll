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

    /// Shorter label for the compact segmented track so four tabs fit cleanly on 375–393pt screens.
    var compactTitle: String {
        switch self {
        case .needsYou: return "Needs"
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    private var page: Loadable<InboxPage> { appState.inbox(filter.view) }

    /// The active building task to highlight in the dark live-working strip.
    private var activeRunningRow: WorkRow? {
        if let row = appState.inbox(.running).value?.rows.first(where: { $0.kind == .running }) {
            return row
        }
        return appState.inbox(.all).value?.rows.first(where: { $0.kind == .running })
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    topHeader
                    if case .unreachable(let hint) = appState.connection {
                        if appState.localNetworkDenied {
                            LocalNetworkCard()
                        } else {
                            hintLine(hint)
                        }
                    }
                    if appState.isTerminal {
                        terminalCard
                    } else {
                        if appState.isOffline, page.value != nil {
                            StaleDataBanner(lastUpdated: appState.lastUpdated)
                        }
                        filterControl
                        if filter != .running, let running = activeRunningRow {
                            NavigationLink(value: Route.task(running.id)) {
                                LiveAgentBanner(row: running, reduceMotion: reduceMotion)
                            }
                            .buttonStyle(.plain)
                        }
                        content
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 28)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .environment(\.showsStaleData, appState.isOffline)
            .refreshable {
                guard !appState.isTerminal else { return }
                await appState.loadInbox(filter.view)
                if filter != .running { await appState.loadInbox(.running, quiet: true) }
                if page.phase == .loaded { refreshed += 1 }
            }
            .sensoryFeedback(.success, trigger: refreshed)
            .toolbar(.hidden, for: .navigationBar)
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
                if filter != .running {
                    await appState.loadInbox(.running, quiet: true)
                }
            }
            .task(id: "\(filter.rawValue)#\(appState.isDemoMode)") {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled else { return }
                    if appState.canAutoRefresh {
                        await appState.loadInbox(filter.view, quiet: true)
                        if filter != .running { await appState.loadInbox(.running, quiet: true) }
                    }
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

    // MARK: C-Style Brand + Connection Header

    private var topHeader: some View {
        HStack(spacing: 10) {
            BrandMark(size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(headerTitle)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    if appState.isReconnecting {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityHidden(true)
                    } else if !dynamicTypeSize.isAccessibilitySize {
                        Circle()
                            .fill(statusDot)
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                    }
                    Text(statusText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(statusTextColor)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 8)
            if appState.connection.isUnreachable && !appState.isReconnecting {
                Button("Retry") { Task { await appState.retry() } }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 34)
                    .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
                    .accessibilityHint("Tries to reach your Mac again.")
            }
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(width: 34, height: 34)
                    .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(ToolrollTheme.hairline, lineWidth: 1)
                    )
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
    }

    private var headerTitle: String {
        if appState.isDemoMode { return "Toolroll" }
        return appState.workspaceLabel
    }

    private var statusText: String {
        if appState.isReconnecting, !appState.isDemoMode { return "Reconnecting…" }
        switch appState.connection {
        case .demo:
            return "Demo · local sample"
        case .connecting:
            return "Connecting…"
        case .connected:
            if let path = appState.connectedPath {
                switch path.kind {
                case .direct: return "Direct · local network"
                case .hosted: return path.host.map { "Relay · \($0)" } ?? "Connected · relay"
                }
            }
            return "Connected"
        case .unreachable:
            return "Unavailable · can't reach Mac"
        case .refused, .damaged:
            return "Not connected"
        case .unpaired:
            return "Not paired"
        }
    }

    private var statusDot: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .demo: return ToolrollTheme.info
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
    }

    private var statusTextColor: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
    }

    private func hintLine(_ hint: CompanionUnreachableHint) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(CompanionConnectionPolicy.hintMessage(hint))
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if hint == .differentMachine {
                Button("Pair again") { showScanner = true }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 36)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

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
                .foregroundStyle(ToolrollTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair again") { showScanner = true }
                .buttonStyle(InkButtonStyle(compact: true))
            Button("Remove from this iPhone") { confirmRemove = true }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.danger)
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .padding(16)
        .card()
    }

    // MARK: B-Style Compact Segmented Filter Track

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
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .card()
            }
            .accessibilityLabel("Show \(label(for: filter))")
        } else {
            HStack(spacing: 2) {
                ForEach(WorkFilter.allCases) { item in
                    segment(item)
                }
            }
            .padding(3)
            .background(ToolrollTheme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(ToolrollTheme.hairline, lineWidth: 1)
            )
        }
    }

    private func label(for item: WorkFilter) -> String {
        if item == .needsYou, let count = appState.needsCount, count > 0 {
            return "\(item.title) (\(count))"
        }
        return item.title
    }

    private func segment(_ item: WorkFilter) -> some View {
        let selected = filter == item
        return Button {
            withAnimation(.snappy(duration: 0.18)) { filter = item }
        } label: {
            HStack(spacing: 4) {
                Text(item.compactTitle)
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
                if item == .needsYou, let count = appState.needsCount, count > 0 {
                    Text("\(count)")
                        .font(.caption2.monospacedDigit().weight(.bold))
                        .foregroundStyle(ToolrollTheme.onInk)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(ToolrollTheme.ink, in: Capsule())
                }
            }
            .font(.footnote.weight(selected ? .semibold : .medium))
            .foregroundStyle(selected ? ToolrollTheme.ink : ToolrollTheme.muted)
            .frame(maxWidth: .infinity, minHeight: 34)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(ToolrollTheme.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .strokeBorder(colorScheme == .dark ? ToolrollTheme.controlLine : ToolrollTheme.hairline, lineWidth: 0.75)
                        )
                        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.35 : 0.06), radius: 2, y: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(for: item))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: B-Style Grouped Paper Sections

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
                let needsRows = value.rows.filter { $0.kind.isNeedsYou }
                let otherRows = value.rows.filter { !$0.kind.isNeedsYou }

                if !needsRows.isEmpty || !value.otherNeeds.isEmpty {
                    sectionHeader("Needs you", count: needsRows.count + value.otherNeeds.count)
                    VStack(spacing: 0) {
                        ForEach(Array(needsRows.enumerated()), id: \.element.id) { index, row in
                            NavigationLink(value: Route.task(row.id)) {
                                WorkRowItem(row: row)
                            }
                            .buttonStyle(.plain)
                            if index < needsRows.count - 1 || !value.otherNeeds.isEmpty {
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                            }
                        }
                        ForEach(Array(value.otherNeeds.enumerated()), id: \.element.id) { index, need in
                            NeedOnlyRow(need: need)
                            if index < value.otherNeeds.count - 1 {
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                            }
                        }
                    }
                    .card(needsYou: true)
                }

                if !otherRows.isEmpty {
                    sectionHeader(otherSectionTitle, count: otherRows.count)
                        .padding(.top, needsRows.isEmpty ? 0 : 4)
                    VStack(spacing: 0) {
                        ForEach(Array(otherRows.enumerated()), id: \.element.id) { index, row in
                            NavigationLink(value: Route.task(row.id)) {
                                WorkRowItem(row: row)
                            }
                            .buttonStyle(.plain)
                            if index < otherRows.count - 1 {
                                Divider().overlay(ToolrollTheme.hairline).padding(.leading, 14)
                            }
                        }
                    }
                    .card()
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

    private var otherSectionTitle: String {
        switch filter {
        case .running: return "Running now"
        case .done: return "Finished"
        default: return "Active and recent"
        }
    }

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(ToolrollTheme.muted)
            Spacer()
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(ToolrollTheme.subtle)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
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
                .font(.system(size: 28))
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
                Button("Show all work") { withAnimation(.snappy(duration: 0.18)) { filter = .all } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .frame(minHeight: 44)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .card()
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
            VStack(spacing: 8) {
                Text("Nothing to show yet")
                    .font(.headline)
                    .foregroundStyle(ToolrollTheme.ink)
                Text("Your work shows up here once this iPhone can reach your Mac.")
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .card()
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
        .padding(24)
        .frame(maxWidth: .infinity)
        .card()
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
                .frame(minHeight: 36)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .card()
    }

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

/// C-style dark live-working strip shown above the inbox whenever an agent is actively running.
private struct LiveAgentBanner: View {
    let row: WorkRow
    let reduceMotion: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(ToolrollTheme.terminalBlue)
                    .frame(width: 6.5, height: 6.5)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .accessibilityHidden(true)
                Text(headerLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.terminalBlue)
                    .lineLimit(1)
                Spacer(minLength: 8)
                HStack(spacing: 3) {
                    Text("Watch")
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                }
                .font(.caption.monospaced().weight(.medium))
                .foregroundStyle(ToolrollTheme.terminalMuted)
            }

            Text(row.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.terminalInk)
                .lineLimit(2)
                .multilineTextAlignment(.leading)

            if let detail = row.askLine, !detail.isEmpty {
                HStack(spacing: 6) {
                    Text("$")
                        .foregroundStyle(ToolrollTheme.terminalBlue)
                    Text(detail)
                        .foregroundStyle(ToolrollTheme.terminalMuted)
                        .lineLimit(1)
                }
                .font(.caption.monospaced())
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollTheme.terminalSurface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollTheme.terminalBg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(ToolrollTheme.terminalBorder, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the running build")
    }

    private var headerLabel: String {
        if let project = row.project, !project.isEmpty {
            return "Building · \(project)"
        }
        return "Building now"
    }
}

/// iOS blocks this app from the local network: say so, and open the app's Settings page to turn it on.
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
            .buttonStyle(OutlineButtonStyle(compact: true))
        }
        .padding(14)
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

/// One row inside a grouped Signal paper section.
struct WorkRowItem: View {
    let row: WorkRow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let kind = row.kind
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                meta(kind)

                Text(row.title)
                    .font(.subheadline.weight(kind.isNeedsYou ? .semibold : .medium))
                    .foregroundStyle(ToolrollTheme.ink)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let ask = row.askLine {
                    Text(ask)
                        .font(.footnote)
                        .foregroundStyle(askColor(ask, kind: kind))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                        .multilineTextAlignment(.leading)
                }

                if let check = row.checkLine {
                    Label(check.text, systemImage: check.symbol)
                        .font(.caption.monospaced())
                        .foregroundStyle(check.tone.hue)
                }
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ToolrollTheme.subtle)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the task")
    }

    private func askColor(_ ask: String, kind: RowKind) -> Color {
        if kind == .review && ask.localizedCaseInsensitiveContains("passed") {
            return ToolrollTheme.success
        }
        return ToolrollTheme.muted
    }

    @ViewBuilder
    private func meta(_ kind: RowKind) -> some View {
        let chip = StateChip(word: kind.word(for: row), tone: kind.tone)
        let detail = [row.project, row.age].compactMap { $0 }.joined(separator: " · ")
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                chip
                Text(detail).font(.caption.monospaced()).foregroundStyle(ToolrollTheme.muted)
            }
        } else {
            HStack(spacing: 7) {
                chip
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
        }
    }
}

/// A waiting ask inside the grouped Needs you card that isn't a task (e.g. held release, flow card).
struct NeedOnlyRow: View {
    let need: NeedRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                StateChip(word: word, tone: .needs)
                Text([need.project, need.age].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption.monospaced())
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(1)
            }
            Text(need.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
            if let line = need.line ?? need.reason {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
            }
            Label("Open Toolroll on your Mac to answer", systemImage: "lock")
                .font(.caption)
                .foregroundStyle(ToolrollTheme.subtle)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
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
