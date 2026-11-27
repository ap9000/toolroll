import SwiftUI
import ToolrollCompanionCore

struct TaskDetailView: View {
    let appState: CompanionAppState
    let taskId: String
    /// The run the Live sheet watches, fixed when it opens (the task's next step may change underneath it).
    @State private var liveSheet: LiveSheet?
    @State private var showUsual = false
    @State private var showHistory = false
    @State private var refreshed = 0
    @State private var showOpenOnMac = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Handoff type for "this task, on the Mac" (Info.plist NSUserActivityTypes).
    static let handoffActivity = "dev.toolroll.ios.task"

    struct LiveSheet: Identifiable {
        let run: Int
        var id: Int { run }
    }

    private var row: WorkRow? { appState.row(taskId) }
    private var steps: Loadable<StepCards> { appState.steps(taskId) }
    private var diff: Loadable<ResultDiff> { appState.diff(taskId) }
    private var next: NextStep { NextStep(row: row, steps: steps.value, diff: diff.value) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    if let failure = steps.failure, steps.value == nil {
                        loadFailure(failure)
                    } else if steps.value == nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                            .padding(.vertical, 32)
                    }
                    if appState.isOffline, steps.value != nil {
                        StaleDataBanner(lastUpdated: appState.lastUpdated)
                    }
                    if let cards = steps.value {
                        if let terms = cards.waitingTerms {
                            termsSection(terms)
                        }
                        nowSection(cards)
                    }
                    changesSection
                        .id("changes")
                    if let cards = steps.value {
                        upcomingSection(cards)
                        historySection(cards)
                    }
                    if dynamicTypeSize.isAccessibilitySize, next.isOnMac || next == .reviewChanges {
                        // At accessibility sizes the bottom bar keeps one line or one button; the rest moves here so
                        // the bar doesn't cover a third of the screen (U21).
                        VStack(alignment: .leading, spacing: 10) {
                            if next == .reviewChanges { onMacRow("Accept on your Mac", detail: nil) }
                            Text(Self.needsYouDetail)
                                .font(.footnote)
                                .foregroundStyle(ToolrollTheme.muted)
                            openOnMacButton
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 8)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .environment(\.showsStaleData, appState.isOffline)
            .refreshable {
                await appState.loadTask(taskId)
                if steps.phase == .loaded { refreshed += 1 }
            }
            .sensoryFeedback(.success, trigger: refreshed)
            .safeAreaInset(edge: .bottom) {
                bottomBar(proxy: proxy)
            }
        }
        .discardingLinks()
        .navigationTitle(row?.project ?? steps.value?.task.project.map(projectName) ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: appState.refreshTick) {
            await appState.loadTask(taskId)
            #if DEBUG
            if appState.debugScreen == "openLive" {
                appState.debugScreen = nil
                if case .watchLive(let run) = next { liveSheet = LiveSheet(run: run) }
            }
            #endif
        }
        .task(id: taskId) {
            // While this task is on screen and connected, keep it current.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                if appState.canAutoRefresh { await appState.loadTask(taskId, quiet: true) }
            }
        }
        .sheet(item: $liveSheet) { sheet in
            LiveWatchView(appState: appState, run: sheet.run, title: title)
        }
        // Handoff (U12): the Mac's Dock offers this task's console page, one click from the approval.
        .userActivity(Self.handoffActivity, isActive: handoffURL != nil) { activity in
            activity.title = title
            activity.webpageURL = handoffURL
            activity.isEligibleForHandoff = true
            activity.isEligibleForSearch = false
            activity.isEligibleForPublicIndexing = false
        }
        .confirmationDialog("Open on your Mac", isPresented: $showOpenOnMac, titleVisibility: .visible) {
            if let url = handoffURL {
                Button("Copy link") { UIPasteboard.general.url = url }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text("Your Mac shows this task in its Dock as a Handoff icon (on the left, or in the app switcher). Click it to open the task in Toolroll. Or copy the link and paste it in a browser on your Mac.")
        }
    }

    private var handoffURL: URL? { appState.handoffURL(task: taskId) }

    static let needsYouDetail = "It's at the top of Toolroll's Needs you list."

    private var title: String {
        row?.title ?? steps.value?.task.title ?? "Task"
    }

    // MARK: Header — the ask first

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let row {
                StateChip(word: row.kind.word(for: row), tone: row.kind.tone)
            } else if let chip = next.chip {
                StateChip(word: chip.word, tone: chip.tone)
            } else if let cards = steps.value, let word = cards.headline, !word.isEmpty {
                // No Work row and no next step (a build between steps): the task's own state word.
                StateChip(word: word, tone: cards.liveRun != nil ? .live : .neutral)
            }
            Text(next.headline)
                .font(.title2.weight(.bold))
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(title)
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let line = headerLine {
                markdownText(line)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The line under the title, unless it only says the headline again.
    private var headerLine: String? {
        guard let line = rawHeaderLine, !repeats(line, next.headline) else { return nil }
        return line
    }

    private var rawHeaderLine: String? {
        if let question = row?.need?.question { return question.text }
        if let line = row?.need?.line ?? row?.need?.reason { return line }
        if let landing = steps.value?.landing { return landing.words }
        return row?.problem ?? row?.detail
    }

    /// Two lines say the same thing (case and punctuation aside, or one is the other plus a tail).
    private func repeats(_ a: String, _ b: String) -> Bool {
        func words(_ s: String) -> String {
            s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
        }
        let x = words(a), y = words(b)
        guard !x.isEmpty, !y.isEmpty else { return false }
        if x == y { return true }
        // One starting with the other counts only when the shorter is a real phrase, not a word like "Done".
        return min(x.count, y.count) >= 10 && (x.hasPrefix(y) || y.hasPrefix(x))
    }

    // MARK: Approval terms

    private func termsSection(_ terms: ApprovalTerms) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("What you'd approve")
            VStack(alignment: .leading, spacing: 14) {
                if let revision = terms.revision {
                    Text(verbatim: revision)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                }
                ForEach(Array(terms.warnings.enumerated()), id: \.offset) { _, warning in
                    Label { Text(verbatim: warning) } icon: { Image(systemName: "exclamationmark.triangle") }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(ToolrollTheme.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollTheme.neutralSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                ForEach(Array(terms.rows.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: row.label)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.muted)
                        Text(verbatim: row.words)
                            .font(.subheadline)
                            .foregroundStyle(ToolrollTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
                            Text(verbatim: line)
                                .font(.footnote.monospaced())
                                .foregroundStyle(ToolrollTheme.ink)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if !terms.usual.isEmpty {
                    DisclosureGroup(isExpanded: $showUsual) {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(terms.usual.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: item.label)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(ToolrollTheme.muted)
                                    Text(verbatim: item.words)
                                        .font(.subheadline)
                                        .foregroundStyle(ToolrollTheme.ink)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .padding(.top, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Text(verbatim: terms.usualLabel)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(needsYou: true)
        }
    }

    // MARK: Now

    @ViewBuilder
    private func nowSection(_ cards: StepCards) -> some View {
        // A card that only restates the headline (the review step's "A result for you to review") is left out.
        let current = (cards.cards ?? []).filter {
            $0.inChain && ($0.state == .current || $0.state == .stuck) && !$0.sentence.isEmpty
                && !(next == .reviewChanges && $0.key == .ready)
                && !repeats($0.sentence, next.headline)
        }
        let notes = problemNotes(cards)
        if !current.isEmpty || !notes.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle("Now")
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(current.enumerated()), id: \.offset) { _, card in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: symbol(card.mark))
                                .foregroundStyle(tone(card.mark).hue)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(card.label)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(ToolrollTheme.ink)
                                markdownText(card.sentence)
                                    .font(.subheadline)
                                    .foregroundStyle(ToolrollTheme.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        markdownText(note)
                            .font(.subheadline)
                            .foregroundStyle(ToolrollTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            }
        }
    }

    private func problemNotes(_ cards: StepCards) -> [String] {
        var notes: [String] = []
        if let failure = cards.failure {
            notes.append(failure.line)
            if let suggestion = failure.suggestion { notes.append(suggestion) }
        }
        if let stopped = cards.planStopped {
            notes.append(stopped.line)
            notes.append(contentsOf: stopped.problems ?? [])
        }
        if let held = cards.held { notes.append("On hold: \(held.reason)") }
        if let waiting = cards.waiting, let last = waiting.lastFailure { notes.append("Trying again. Last try: \(last)") }
        if let blockers = cards.review?.accept?.blockers { notes.append(contentsOf: blockers) }
        return notes
    }

    // MARK: Changes

    @ViewBuilder
    private var changesSection: some View {
        if let value = diff.value, !value.files.isEmpty, let run = value.run {
            VStack(alignment: .leading, spacing: 10) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        sectionTitle("Changes")
                        Spacer()
                        Text(filesSummary(value))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(ToolrollTheme.muted)
                            .fixedSize()
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        sectionTitle("Changes")
                        Text(filesSummary(value))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                }
                VStack(spacing: 0) {
                    ForEach(Array(value.files.enumerated()), id: \.element.file) { index, entry in
                        NavigationLink(value: Route.diff(DiffRoute(
                            task: taskId, run: run, file: entry.file, path: entry.path,
                            additions: entry.additions, deletions: entry.deletions
                        ))) {
                            FileRow(entry: entry)
                        }
                        .buttonStyle(.plain)
                        .disabled(entry.binary)
                        if index < value.files.count - 1 {
                            Divider().padding(.leading, 16)
                        }
                    }
                }
                .card()
                if value.patchTruncated || value.totals?.filesTruncated == true {
                    Text("Some changes are too large to show here. Open the result on your Mac for all of it.")
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
        } else if let failure = diff.failure, next == .reviewChanges || next == .viewChanges {
            loadFailure(failure)
        }
    }

    /// The count always matches the files listed; a truncated list says so.
    private func filesSummary(_ diff: ResultDiff) -> String {
        let shown = diff.files.count
        let added = diff.files.reduce(0) { $0 + $1.additions }
        let removed = diff.files.reduce(0) { $0 + $1.deletions }
        let files = shown == 1 ? "1 file" : "\(shown) files"
        if let total = diff.totals?.files, total > shown {
            return "\(shown) of \(total) files · +\(added) −\(removed)"
        }
        return "\(files) · +\(added) −\(removed)"
    }

    // MARK: Upcoming + History

    @ViewBuilder
    private func upcomingSection(_ cards: StepCards) -> some View {
        let upcoming = (cards.cards ?? []).filter { $0.inChain && $0.state == .todo }
        if !upcoming.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Next:")
                    .font(.subheadline.weight(.semibold))
                Text(upcoming.map(\.label).joined(separator: " → "))
                    .font(.subheadline)
            }
            .foregroundStyle(ToolrollTheme.muted)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func historySection(_ cards: StepCards) -> some View {
        let finished = (cards.cards ?? []).filter { $0.inChain && ($0.state == .done || $0.state == .skipped) }
        DisclosureGroup(isExpanded: $showHistory) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(finished.enumerated()), id: \.offset) { _, card in
                    historyRow(card)
                }
                detailsBlock(cards)
            }
            .padding(.top, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(finished.isEmpty ? "Details" : "History · \(finished.count) finished")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
        }
        .padding(16)
        .card()
    }

    private func historyRow(_ card: StepCard) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol(card.mark))
                .foregroundStyle(tone(card.mark).hue)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                    Spacer()
                    if let at = RelativeTime.date(card.finishedAt ?? card.at) {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            Text(RelativeTime.ago(at, now: context.date))
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                    }
                }
                if !card.sentence.isEmpty {
                    markdownText(card.sentence)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let facts = stepFacts(card)
                if !facts.isEmpty {
                    Text(facts)
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func stepFacts(_ card: StepCard) -> String {
        var parts: [String] = []
        if let agent = card.agent { parts.append(agent.model ?? agent.provider) }
        if let cost = card.costUsd { parts.append(String(format: "$%.2f", cost)) }
        if !card.runs.isEmpty { parts.append("run " + card.runs.map { "#\($0)" }.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }

    private func detailsBlock(_ cards: StepCards) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().padding(.bottom, 6)
            fact("Task", cards.task.id)
            if let run = cards.latestRun { fact("Latest run", "#\(run)") }
            if let approval = cards.approval {
                fact("Approved by", approval.automatic ? "a rule" : (approval.you ? "you" : approval.by))
            }
            if let review = cards.review { fact("Result", String(review.receipt.prefix(12))) }
            if let terms = cards.waitingTerms { fact("Terms", String(terms.key.prefix(12))) }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundStyle(ToolrollTheme.muted)
            Spacer()
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(ToolrollTheme.ink)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Bottom bar — one next step

    @ViewBuilder
    private func bottomBar(proxy: ScrollViewProxy) -> some View {
        switch next {
        case .none:
            EmptyView()
        default:
            VStack(spacing: 0) {
                Divider()
                Group {
                    switch next {
                    case .approveOnMac:
                        onMacBar("Approve on your Mac")
                    case .answerOnMac:
                        onMacBar("Answer on your Mac")
                    case .unblockOnMac:
                        onMacBar("Retry or unblock it on your Mac")
                    case .reviewChanges:
                        VStack(spacing: 10) {
                            if let first = firstFileRoute {
                                NavigationLink(value: Route.diff(first)) {
                                    Text("Review changes")
                                }
                                .buttonStyle(InkButtonStyle())
                            } else {
                                Button("Review changes") { jumpToChanges(proxy) }
                                    .buttonStyle(InkButtonStyle())
                                    .disabled(diff.value?.files.isEmpty ?? true)
                            }
                            if !dynamicTypeSize.isAccessibilitySize {
                                onMacRow("Accept on your Mac", detail: Self.needsYouDetail)
                                openOnMacButton
                            }
                        }
                    case .viewChanges:
                        Button("View changes") { jumpToChanges(proxy) }
                            .buttonStyle(OutlineButtonStyle())
                    case .watchLive(let run):
                        Button {
                            liveSheet = LiveSheet(run: run)
                        } label: {
                            Label("Watch live", systemImage: "dot.radiowaves.left.and.right")
                        }
                        .buttonStyle(OutlineButtonStyle())
                    case .none:
                        EmptyView()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(ToolrollTheme.paper)
        }
    }

    /// The "on your Mac" line and, when the Mac gave its console address, a way across (Handoff / copy link).
    @ViewBuilder
    private func onMacBar(_ text: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            onMacRow(text, detail: nil)
        } else {
            VStack(spacing: 8) {
                onMacRow(text, detail: Self.needsYouDetail)
                openOnMacButton
            }
        }
    }

    @ViewBuilder
    private var openOnMacButton: some View {
        if handoffURL != nil {
            Button {
                showOpenOnMac = true
            } label: {
                Label("Open on Mac", systemImage: "laptopcomputer.and.arrow.down")
            }
            .buttonStyle(OutlineButtonStyle())
            .accessibilityHint("Shows how to open this task on your Mac.")
        }
    }

    /// Gate 1: approvals happen on the Mac. Plain text with a lock, never a disabled button.
    private func onMacRow(_ text: String, detail: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "lock.fill")
                .foregroundStyle(ToolrollTheme.ink)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(.headline)
                    .foregroundStyle(ToolrollTheme.ink)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    /// The first file that can be opened (binary files can't), where "Review changes" starts.
    private var firstFileRoute: DiffRoute? {
        guard let value = diff.value, let run = value.run,
              let entry = value.files.first(where: { !$0.binary }) else { return nil }
        return DiffRoute(task: taskId, run: run, file: entry.file, path: entry.path,
                         additions: entry.additions, deletions: entry.deletions)
    }

    private func jumpToChanges(_ proxy: ScrollViewProxy) {
        withAnimation(.snappy) { proxy.scrollTo("changes", anchor: .top) }
    }

    // MARK: Bits

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ToolrollTheme.muted)
            .accessibilityAddTraits(.isHeader)
    }

    private func loadFailure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Couldn't load this task")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
            Button("Try again") { Task { await appState.loadTask(taskId) } }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .frame(minHeight: 44)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func symbol(_ mark: StepMark) -> String {
        switch mark {
        case .done: return "checkmark.circle.fill"
        case .needs: return "circle.inset.filled"
        case .live: return "circle.dotted.circle"
        case .wait: return "clock"
        case .stuck: return "exclamationmark.circle.fill"
        case .skipped: return "minus.circle"
        case .todo, .other: return "circle"
        }
    }

    private func tone(_ mark: StepMark) -> StateTone {
        switch mark {
        case .done: return .done
        case .needs: return .needs
        case .live: return .live
        case .stuck: return .failed
        default: return .neutral
        }
    }

    private func projectName(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }
}

private struct FileRow: View {
    let entry: ResultDiffEntry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text((entry.path as NSString).lastPathComponent)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ToolrollTheme.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                let folder = (entry.path as NSString).deletingLastPathComponent
                if !folder.isEmpty {
                    Text(folder)
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            if entry.binary {
                Text("binary")
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.muted)
            } else {
                HStack(spacing: 6) {
                    Text("+\(entry.additions)").foregroundStyle(ToolrollTheme.success)
                    Text("−\(entry.deletions)").foregroundStyle(ToolrollTheme.danger)
                }
                .font(.footnote.monospacedDigit().weight(.semibold))
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.muted)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.path), \(entry.additions) added, \(entry.deletions) removed")
    }
}
