import SwiftUI
import ToolrollCompanionCore

enum WorkFilter: String, CaseIterable, Identifiable {
    case needsYou
    case running
    case done
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .all: return "All"
        case .running: return "Running"
        case .done: return "Done"
        }
    }

    var compactTitle: String {
        switch self {
        case .needsYou: return "Needs"
        case .all: return "All"
        case .running: return "Running"
        case .done: return "Done"
        }
    }

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
    @State private var pairedFromHere = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var page: Loadable<InboxPage> { appState.inbox(filter.view) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    topHeader
                        .padding(.bottom, 6)
                    if case .unreachable(let hint) = appState.connection {
                        if appState.localNetworkDenied {
                            LocalNetworkCard()
                        } else {
                            OfflineCard(appState: appState, hint: hint) { showScanner = true }
                        }
                    }
                    if appState.isTerminal {
                        terminalCard
                    } else {
                        if !appState.isOffline { filterControl.padding(.bottom, 6) }
                        content
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
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
            .sensoryFeedback(.selection, trigger: filter)
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
                await prefetchRowDetails()
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
                    // Only while a new scan from this screen is the context (not over an unrelated inbox later).
                    get: { appState.pairingError != nil && appState.isPaired && (showScanner || appState.isTerminal || pairedFromHere) },
                    set: { if !$0 { appState.pairingError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { appState.pairingError = nil }
            } message: {
                Text(appState.pairingError ?? "")
            }
            .onChange(of: showScanner) { _, shown in if shown { pairedFromHere = true } }
        }
        .discardingLinks()
        .onAppear(perform: applyDebugScreen)
    }

    /// Loads the step cards (and a review's file list) of the rows on screen that don't have them yet, so a row can
    /// say files and budget, or a running task's progress, from data the Mac already sends.
    private func prefetchRowDetails() async {
        guard !appState.isOffline else { return }
        let rows = (page.value?.rows ?? []) + (appState.inbox(.running).value?.rows ?? [])
        let wanted = rows.filter { $0.kind.isNeedsYou || $0.kind == .running }.prefix(6)
        for row in wanted where appState.steps(row.id).value == nil {
            await appState.loadSteps(row.id, quiet: true)
        }
        for row in wanted where row.kind == .review && appState.diff(row.id).value == nil {
            await appState.loadDiff(row.id, quiet: true)
        }
    }

    // MARK: Header

    private var topHeader: some View {
        HStack(spacing: 12) {
            BrandMark(size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text("Toolroll")
                    .font(.system(size: 20, weight: .semibold))
                    .tracking(-0.3)
                    .foregroundStyle(ToolrollTheme.ink)
                HStack(spacing: 6) {
                    if appState.isReconnecting {
                        ProgressView().controlSize(.mini).accessibilityHidden(true)
                    } else {
                        Circle().fill(statusDot).frame(width: 7, height: 7).accessibilityHidden(true)
                    }
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(statusTextColor)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 8)
            Button {
                showSettings = true
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .buttonStyle(RoundIconButtonStyle())
            .accessibilityLabel("Settings")
        }
    }

    private var macName: String { appState.isDemoMode ? "Demo workspace" : appState.workspaceLabel }

    private var statusText: String {
        if appState.isReconnecting, !appState.isDemoMode { return "\(macName) · Reconnecting…" }
        switch appState.connection {
        case .demo: return "Demo workspace · Sample data"
        case .connecting: return "\(macName) · Connecting…"
        case .connected:
            if let path = appState.connectedPath, path.kind == .hosted { return "\(macName) · Connected through the relay" }
            return "\(macName) · Connected"
        case .unreachable: return "\(macName) · Can't reach"
        case .refused, .damaged: return "\(macName) · Not connected"
        case .unpaired: return "Not paired"
        }
    }

    private var statusDot: Color {
        switch appState.connection {
        case .connected: return ToolrollTheme.success
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.subtle
        }
    }

    private var statusTextColor: Color {
        switch appState.connection {
        case .unreachable, .refused, .damaged: return ToolrollTheme.danger
        default: return ToolrollTheme.muted
        }
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
                .foregroundStyle(ToolrollTheme.body)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair again") { showScanner = true }
                .buttonStyle(SignalButtonStyle(compact: true))
            Button("Remove from this iPhone") { confirmRemove = true }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.danger)
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .padding(16)
        .card()
    }

    // MARK: Filter pills

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
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.up.chevron.down").font(.subheadline)
                }
                .foregroundStyle(ToolrollTheme.ink)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .card()
            }
            .accessibilityLabel("Show \(label(for: filter))")
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(WorkFilter.allCases) { item in pill(item) }
                }
            }
            .scrollClipDisabled()
        }
    }

    private func label(for item: WorkFilter) -> String {
        if let count = count(for: item), count > 0 { return "\(item.title) (\(count))" }
        return item.title
    }

    private func count(for item: WorkFilter) -> Int? {
        switch item {
        case .needsYou: return appState.needsCount
        case .running: return appState.inbox(.running).value?.rows.count
        default: return nil
        }
    }

    private func pill(_ item: WorkFilter) -> some View {
        let selected = filter == item
        return Button {
            withAnimation(.easeOut(duration: 0.16)) { filter = item }
        } label: {
            HStack(spacing: 6) {
                Text(item.title).lineLimit(1).fixedSize()
                if let count = count(for: item), count > 0 {
                    Text("\(count)")
                        .font(.caption.monospaced().weight(.medium))
                        .foregroundStyle(selected ? ToolrollTheme.ink : ToolrollTheme.muted)
                        .padding(.horizontal, selected ? 6 : 0)
                        .padding(.vertical, 1)
                        .background { if selected { Capsule().fill(ToolrollTheme.onInk) } }
                }
            }
            .font(.subheadline.weight(selected ? .semibold : .medium))
            .foregroundStyle(selected ? ToolrollTheme.onInk : ToolrollTheme.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(Capsule().fill(selected ? ToolrollTheme.ink : ToolrollTheme.surface))
            .overlay { if !selected { Capsule().strokeBorder(ToolrollTheme.border, lineWidth: 1) } }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(for: item))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Rows

    @ViewBuilder
    private var content: some View {
        if let value = page.value {
            if value.rows.isEmpty && value.otherNeeds.isEmpty && runningRows.isEmpty {
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
                if appState.isOffline, let saved = appState.lastUpdated {
                    SectionLabel("Saved · \(saved.formatted(date: .omitted, time: .shortened))")
                        .padding(.top, 8)
                        .padding(.horizontal, 2)
                }
                let rows = filter == .needsYou ? value.rows.filter { $0.kind.isNeedsYou } : value.rows
                Group {
                    ForEach(rows) { row in
                        NavigationLink(value: Route.task(row.id)) {
                            WorkRowCard(row: row, steps: appState.steps(row.id).value, diff: appState.diff(row.id).value, offline: appState.isOffline)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(value.otherNeeds) { need in
                        NeedOnlyRow(need: need)
                    }
                }
                .opacity(appState.isOffline ? 0.72 : 1)

                if filter == .needsYou && !runningRows.isEmpty {
                    SectionLabel("Running")
                        .padding(.top, 14)
                        .padding(.horizontal, 2)
                    ForEach(runningRows) { row in
                        NavigationLink(value: Route.task(row.id)) {
                            WorkRowCard(row: row, steps: appState.steps(row.id).value, diff: nil, offline: appState.isOffline)
                        }
                        .buttonStyle(.plain)
                    }
                    .opacity(appState.isOffline ? 0.72 : 1)
                }

                if filter == .needsYou && !appState.isOffline {
                    HStack {
                        Text(doneLine).font(.subheadline).foregroundStyle(ToolrollTheme.muted)
                        Spacer()
                        Button("Show") { withAnimation(.easeOut(duration: 0.16)) { filter = .done } }
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(ToolrollTheme.ink)
                            .frame(minHeight: 44)
                    }
                    .padding(.top, 8)
                    .padding(.horizontal, 2)
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

    private var runningRows: [WorkRow] {
        guard filter == .needsYou else { return [] }
        return (appState.inbox(.running).value?.rows ?? []).filter { $0.kind == .running }
    }

    private var doneLine: String {
        if let count = appState.inbox(.completed).value?.rows.count, count > 0 {
            return count == 1 ? "Done · 1 task" : "Done · \(count) tasks"
        }
        return "Finished work"
    }

    private var loadingState: some View {
        HStack {
            Spacer()
            ProgressView().padding(.vertical, 48)
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
                Button("Show all work") { withAnimation(.easeOut(duration: 0.16)) { filter = .all } }
                    .buttonStyle(PillButtonStyle())
                    .padding(.top, 4)
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
            // The offline card above already says what's wrong and what to do.
            EmptyView()
        } else {
            VStack(spacing: 12) {
                Text("Couldn't load your work")
                    .font(.headline)
                    .foregroundStyle(ToolrollTheme.ink)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await appState.loadInbox(filter.view) } }
                    .buttonStyle(PillButtonStyle(filled: true))
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .card()
        }
    }

    private func inlineFailure(_ message: String) -> some View {
        HStack(spacing: 8) {
            Text("Couldn't refresh. \(message)")
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.ink)
            Spacer(minLength: 8)
            Button("Retry") { Task { await appState.loadInbox(filter.view) } }
                .buttonStyle(PillButtonStyle())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .card()
    }

    private func loadMore(failure: String?) -> some View {
        VStack(spacing: 4) {
            if page.isLoading {
                ProgressView().frame(minHeight: 44)
            } else {
                Button(failure == nil ? "Load more" : "Try loading more") { Task { await appState.loadMore(filter.view) } }
                    .buttonStyle(PillButtonStyle())
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
        case "exception" where parts.count >= 2:
            path = [.task(parts[1])]
            appState.debugScreen = "exception"
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

struct LocalNetworkCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
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

/// One Work row as a card: an ink chip for what waits on you (or a blue live dot while running), the project and age,
/// the title, and one line of facts.
struct WorkRowCard: View {
    let row: WorkRow
    let steps: StepCards?
    let diff: ResultDiff?
    var offline = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let kind = row.kind
        VStack(alignment: .leading, spacing: kind == .running ? 8 : 6) {
            HStack(spacing: 8) {
                if kind == .running {
                    LiveDot()
                    Text(progress?.label ?? "Running")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.info)
                        .lineLimit(1)
                } else if let chip = kind.chip(for: row) {
                    InkChip(text: chip)
                } else {
                    StatusDotLabel(word: kind.word(for: row), tone: kind.tone, size: .footnote)
                }
                if let project = row.project, !project.isEmpty {
                    Text(project)
                        .font(.footnote.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if !row.age.isEmpty, !offline {
                    Text(row.age.replacingOccurrences(of: " ago", with: ""))
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }

            Text(row.title)
                .font(.system(size: kind.isNeedsYou ? 17 : 16, weight: kind.isNeedsYou ? .semibold : .medium))
                .tracking(kind.isNeedsYou ? -0.2 : 0)
                .foregroundStyle(ToolrollTheme.ink)
                .multilineTextAlignment(.leading)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if kind == .running, let progress {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(ToolrollTheme.raised)
                        Capsule().fill(ToolrollTheme.info)
                            .frame(width: geo.size.width * CGFloat(Double(progress.done) + 0.5) / CGFloat(max(progress.total, 1)))
                    }
                }
                .frame(height: 4)
                .accessibilityLabel("Step \(progress.done + 1) of \(progress.total)")
            } else if let meta {
                HStack(spacing: 6) {
                    if meta.passed { Image(systemName: "checkmark.circle").accessibilityHidden(true) }
                    Text(meta.text).lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                }
                .font(.subheadline)
                .foregroundStyle(meta.passed ? ToolrollTheme.success : ToolrollTheme.muted)
            }

            if let check = row.checkLine {
                Label(check.text, systemImage: check.symbol)
                    .font(.caption.monospaced())
                    .foregroundStyle(check.tone.hue)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the task")
    }

    private var progress: (label: String, done: Int, total: Int)? {
        steps.flatMap(PlanSteps.progress)
    }

    /// One line of facts from data the phone has: files and budget for a plan, checks and changes for a result.
    private var meta: (text: String, passed: Bool)? {
        let kind = row.kind
        if offline, kind == .decide { return ("You can read it now and approve when your Mac is back", false) }
        if offline { return nil }
        var parts: [String] = []
        var passed = false
        if kind == .decide, let terms = steps?.waitingTerms {
            if let files = terms.rows.first(where: { $0.label.lowercased() == "files" }), !files.lines.isEmpty {
                parts.append(files.lines.count == 1 ? "1 file" : "\(files.lines.count) files")
            }
            if let cost = terms.rows.first(where: { ["may cost", "budget", "cost"].contains($0.label.lowercased()) }),
               let range = cost.words.range(of: #"\$[0-9]+(?:\.[0-9]+)?"#, options: .regularExpression) {
                parts.append("≤ \(cost.words[range])")
            }
            parts.append("Build starts when you approve")
        } else if kind == .review {
            if let ask = row.askLine?.replacingOccurrences(of: "The result is ready. ", with: "").trimmingTrailingPeriod, !ask.isEmpty {
                parts.append(ask.replacingOccurrences(of: "All ", with: ""))
                passed = ask.localizedCaseInsensitiveContains("passed")
            }
            if let diff, !diff.files.isEmpty {
                let added = diff.files.reduce(0) { $0 + max($1.additions, 0) }
                let removed = diff.files.reduce(0) { $0 + max($1.deletions, 0) }
                parts.append(diff.files.count == 1 ? "1 file" : "\(diff.files.count) files")
                parts.append("+\(added) −\(removed)")
            }
        } else if let ask = row.askLine?.trimmingTrailingPeriod, !ask.isEmpty {
            parts.append(ask)
        }
        return parts.isEmpty ? nil : (parts.joined(separator: " · "), passed)
    }
}

/// Mac unreachable: what's shown is saved, approvals are paused, nothing is queued — and the one useful act.
private struct OfflineCard: View {
    let appState: CompanionAppState
    let hint: CompanionUnreachableHint
    let pairAgain: () -> Void
    @State private var showDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Can't reach \(appState.workspaceLabel)")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .accessibilityAddTraits(.isHeader)
                savedLine
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(hints, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(ToolrollTheme.muted)
                        Text(line).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.footnote)
            .foregroundStyle(ToolrollTheme.body)
            if showDetails {
                Text(CompanionConnectionPolicy.hintMessage(hint))
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                if appState.isReconnecting {
                    HStack(spacing: 8) { ProgressView(); Text("Trying…") }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 46)
                } else if hint == .differentMachine {
                    Button("Pair again", action: pairAgain)
                        .buttonStyle(SignalButtonStyle(compact: true))
                } else {
                    Button("Try again") { Task { await appState.retry() } }
                        .buttonStyle(SignalButtonStyle(compact: true))
                        .accessibilityHint("Tries to reach your Mac again.")
                }
                Button(showDetails ? "Hide" : "Details") { withAnimation(.easeOut(duration: 0.16)) { showDetails.toggle() } }
                    .buttonStyle(PillButtonStyle())
                    .frame(minHeight: 44)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var savedLine: Text {
        let tail = "Approvals are paused until your Mac is back. Nothing is queued."
        guard let saved = appState.lastUpdated else { return Text(tail) }
        return Text("Showing what you last saw at ")
            + Text(saved.formatted(date: .omitted, time: .shortened)).font(.subheadline.monospaced())
            + Text(". " + tail)
    }

    private var hints: [String] {
        switch hint {
        case .generic, .macOffline, .noPath:
            return [
                "Is your Mac awake and Toolroll open?",
                "Away from its Wi‑Fi? Turn on the hosted relay on your Mac, or use Tailscale.",
            ]
        default:
            return [CompanionConnectionPolicy.hintMessage(hint)]
        }
    }
}

/// A waiting ask inside the grouped Needs you card that isn't a task.
struct NeedOnlyRow: View {
    let need: NeedRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                InkChip(text: word)
                if let project = need.project, !project.isEmpty {
                    Text(project)
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if !need.age.isEmpty {
                    Text(need.age)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(ToolrollTheme.subtle)
                }
            }
            Text(need.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
            if let line = (need.line ?? need.reason)?.trimmingTrailingPeriod {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(2)
            }
            Label("Open Toolroll on your Mac to answer", systemImage: "lock")
                .font(.caption)
                .foregroundStyle(ToolrollTheme.subtle)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
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

