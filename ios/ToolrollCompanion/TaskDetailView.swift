import SwiftUI
import ToolrollCompanionCore

struct TaskDetailView: View {
    let appState: CompanionAppState
    let taskId: String
    @State private var liveSheet: LiveSheet?
    @State private var showFiles = false
    @State private var showDetails = false
    @State private var showHistory = false
    @State private var refreshed = 0
    @State private var showOpenOnMac = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.toolrollAppearance) private var appearance

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
                    if let cards = steps.value, let terms = cards.waitingTerms {
                        decideMinimalView(terms: terms, cards: cards)
                    } else {
                        editorialHeader
                    }

                    if let failure = steps.failure, steps.value == nil {
                        loadFailure(failure)
                    } else if steps.value == nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                            .padding(.vertical, 32)
                    }
                    if appState.isOffline, steps.value != nil {
                        StaleDataBanner(lastUpdated: appState.lastUpdated)
                    }
                    if let cards = steps.value, cards.waitingTerms == nil {
                        nowSection(cards)
                    }
                    changesSection
                        .id("changes")
                    if let cards = steps.value, cards.waitingTerms == nil {
                        upcomingSection(cards)
                        historySection(cards)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 24)
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
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                if appState.canAutoRefresh { await appState.loadTask(taskId, quiet: true) }
            }
        }
        .sheet(item: $liveSheet) { sheet in
            LiveWatchView(appState: appState, run: sheet.run, title: title)
        }
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
            Text("Your Mac shows this task in its Dock as a Handoff icon. Click it to open the task in Toolroll, or copy the link.")
        }
    }

    private var handoffURL: URL? { appState.handoffURL(task: taskId) }

    private var title: String {
        row?.title ?? steps.value?.task.title ?? "Task"
    }

    // MARK: Borderless Editorial Decide View (Necessary Information Only)

    @ViewBuilder
    private func decideMinimalView(terms: ApprovalTerms, cards: StepCards) -> some View {
        let agentRow = terms.rows.first { matches($0.label, ["agent"]) }
        let goalRow = terms.rows.first { matches($0.label, ["goal"]) }
        let doneRow = terms.rows.first { matches($0.label, ["done when", "done", "verify"]) }
        let filesRow = terms.rows.first { matches($0.label, ["files"]) }
        let costRow = terms.rows.first { matches($0.label, ["may cost", "budget", "cost"]) }

        let primaryLabels = Set([goalRow, doneRow, filesRow, costRow].compactMap { $0?.label.lowercased() })
        let detailRows = terms.rows.filter { !primaryLabels.contains($0.label.lowercased()) }
        let showGoal = goalRow.map { !repeats($0.words, title) } ?? false

        // 1. Borderless editorial header directly on the canvas (no outer wireframe box, no sticker badge).
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                StatusDotLabel(word: "Needs approval", tone: .needs)
                if let meta = headerMeta {
                    Text("· \(meta)")
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.subtle)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            Text(title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if let done = doneRow?.words, !done.isEmpty {
                Text(verbatim: done.trimmingTrailingPeriod)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else if showGoal, let goal = goalRow?.words {
                Text(verbatim: goal.trimmingTrailingPeriod)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !terms.warnings.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(terms.warnings.enumerated()), id: \.offset) { _, warning in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.danger)
                            Text(verbatim: warning)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(ToolrollTheme.ink)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 2)

        // 2. One compact machined surface holding only essential summary rows + progressive disclosure for everything else.
        VStack(spacing: 0) {
            if let costRow {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Budget")
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                    Spacer(minLength: 8)
                    Text(verbatim: compactCost(costRow.words))
                        .font(.footnote.monospacedDigit().weight(.medium))
                        .foregroundStyle(ToolrollTheme.ink)
                        .multilineTextAlignment(.trailing)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .accessibilityElement(children: .combine)
            }

            if let filesRow {
                if costRow != nil {
                    Divider().overlay(ToolrollTheme.hairline).padding(.leading, 16)
                }
                DisclosureGroup(isExpanded: $showFiles) {
                    if !filesRow.lines.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(Array(filesRow.lines.enumerated()), id: \.offset) { _, line in
                                HStack(spacing: 8) {
                                    Image(systemName: "doc.text")
                                        .font(.caption2)
                                        .foregroundStyle(ToolrollTheme.terminalMuted)
                                        .accessibilityHidden(true)
                                    Text(verbatim: line)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(ToolrollTheme.terminalInk)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .terminalCard(radius: 8)
                        .padding(.top, 10)
                    } else if !filesRow.words.isEmpty {
                        Text(verbatim: filesRow.words)
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 8)
                    }
                } label: {
                    HStack {
                        Text("Files")
                            .font(.subheadline)
                            .foregroundStyle(ToolrollTheme.muted)
                        Spacer(minLength: 8)
                        Text(filesCountLabel(filesRow))
                            .font(.footnote.monospacedDigit().weight(.medium))
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                }
                .tint(ToolrollTheme.subtle)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
            }

            if !detailRows.isEmpty || !terms.usual.isEmpty || terms.revision != nil {
                if costRow != nil || filesRow != nil {
                    Divider().overlay(ToolrollTheme.hairline).padding(.leading, 16)
                }
                DisclosureGroup(isExpanded: $showDetails) {
                    VStack(alignment: .leading, spacing: 12) {
                        if let revision = terms.revision {
                            Text(verbatim: revision)
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                        if let agent = agentRow?.words, !agent.isEmpty {
                            compactDetailRow("Agent", agent)
                        }
                        ForEach(Array(detailRows.filter { !matches($0.label, ["agent"]) }.enumerated()), id: \.offset) { _, item in
                            compactDetailRow(item.label, sentenceCased(item.words))
                        }
                        if !terms.usual.isEmpty {
                            Divider().overlay(ToolrollTheme.hairline)
                            ForEach(Array(terms.usual.enumerated()), id: \.offset) { _, item in
                                compactDetailRow(item.label, item.words)
                            }
                        }
                        detailsBlock(cards)
                    }
                    .padding(.top, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    HStack {
                        Text("Details")
                            .font(.subheadline)
                            .foregroundStyle(ToolrollTheme.muted)
                        Spacer(minLength: 8)
                        Text("Model, rules, network")
                            .font(.caption)
                            .foregroundStyle(ToolrollTheme.subtle)
                    }
                }
                .tint(ToolrollTheme.subtle)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
            }
        }
        .card()
    }

    private func compactCost(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Compress verbose "Up to $2.00 · stops after 20 min without progress" into clean "≤ $2.00 · 20m" when recognizable.
        if let dollarRange = trimmed.range(of: #"\$[0-9]+(?:\.[0-9]+)?"#, options: .regularExpression) {
            let price = String(trimmed[dollarRange])
            if let minMatch = trimmed.range(of: #"([0-9]+)\s*min"#, options: .regularExpression) {
                let digits = trimmed[minMatch].filter(\.isNumber)
                if !digits.isEmpty { return "≤ \(price) · \(digits)m" }
            }
            return "≤ \(price)"
        }
        return trimmed
    }

    private func filesCountLabel(_ row: ApprovalTerms.Row) -> String {
        if !row.lines.isEmpty {
            return "\(row.lines.count) in scope"
        }
        return row.words.isEmpty ? "In scope" : row.words
    }

    private func compactDetailRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: label)
                .font(.caption)
                .foregroundStyle(ToolrollTheme.muted)
            Text(verbatim: value)
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func sentenceCased(_ raw: String) -> String {
        guard let first = raw.first, first.isLowercase else { return raw }
        return first.uppercased() + raw.dropFirst()
    }

    // MARK: Borderless Editorial Header (Review / Running / Done / Unblock)

    private var editorialHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                if case .watchLive = next {
                    LivePulseBars(color: ToolrollTheme.info, height: 10)
                    Text("Running")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(ToolrollTheme.info)
                } else if let row {
                    StatusDotLabel(word: editorialStatusWord(row: row), tone: row.kind.tone)
                } else if let chip = next.chip {
                    StatusDotLabel(word: chip.word, tone: chip.tone)
                } else if let cards = steps.value, let word = cards.headline, !word.isEmpty {
                    StatusDotLabel(word: word, tone: cards.liveRun != nil ? .live : .neutral)
                }
                if let meta = headerMeta {
                    Text("· \(meta)")
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.subtle)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            Text(title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if let subtitle = cleanedHeaderSubtitle {
                if next == .reviewChanges && subtitle.localizedCaseInsensitiveContains("passed") {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.success)
                        Text(subtitle)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(ToolrollTheme.success)
                    }
                } else {
                    markdownText(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func editorialStatusWord(row: WorkRow) -> String {
        switch row.kind {
        case .review: return "Ready to review"
        case .decide: return row.need?.ask == .answer ? "Needs answer" : "Needs approval"
        case .unblock: return "Needs unblock"
        default: return row.kind.word(for: row)
        }
    }

    private var headerMeta: String? {
        var parts: [String] = []
        if let age = row?.age, !age.isEmpty { parts.append(age) }
        if let run = steps.value?.latestRun { parts.append("#\(run)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var cleanedHeaderSubtitle: String? {
        guard var line = headerLine else { return nil }
        if line.hasSuffix(".") && !line.hasSuffix("..") { line = String(line.dropLast()) }
        if next == .reviewChanges, line.hasPrefix("The result is ready. ") {
            return String(line.dropFirst("The result is ready. ".count))
        }
        return line
    }

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

    private func repeats(_ a: String, _ b: String) -> Bool {
        func words(_ s: String) -> String {
            s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
        }
        let x = words(a), y = words(b)
        guard !x.isEmpty, !y.isEmpty else { return false }
        if x == y { return true }
        return min(x.count, y.count) >= 10 && (x.hasPrefix(y) || y.hasPrefix(x))
    }

    private func matches(_ label: String, _ keys: [String]) -> Bool {
        let lower = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return keys.contains(lower)
    }

    // MARK: Now

    @ViewBuilder
    private func nowSection(_ cards: StepCards) -> some View {
        let current = (cards.cards ?? []).filter {
            $0.inChain && ($0.state == .current || $0.state == .stuck) && !$0.sentence.isEmpty
                && !(next == .reviewChanges && $0.key == .ready)
                && !repeats($0.sentence, next.headline)
        }
        let notes = problemNotes(cards)
        if !current.isEmpty || !notes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle("Now")
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(current.enumerated()), id: \.offset) { _, card in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: symbol(card.mark))
                                .foregroundStyle(tone(card.mark).hue(appearance: appearance))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(card.label)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(ToolrollTheme.ink)
                                markdownText(card.sentence)
                                    .font(.footnote)
                                    .foregroundStyle(ToolrollTheme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        markdownText(note)
                            .font(.footnote)
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
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    sectionTitle("Changes")
                    Spacer()
                    Text(filesSummary(value))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(ToolrollTheme.muted)
                }
                .padding(.horizontal, 4)

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
                            Divider().overlay(ToolrollTheme.hairline).padding(.leading, 44)
                        }
                    }
                }
                .card()

                if value.patchTruncated || value.totals?.filesTruncated == true {
                    Text("Some changes are too large to show here. Open the result on your Mac for all of it.")
                        .font(.caption)
                        .foregroundStyle(ToolrollTheme.muted)
                        .padding(.horizontal, 4)
                }
            }
        } else if let failure = diff.failure, next == .reviewChanges || next == .viewChanges {
            loadFailure(failure)
        }
    }

    private func filesSummary(_ diff: ResultDiff) -> String {
        let shown = diff.files.count
        let added = diff.files.reduce(0) { $0.addingReportingOverflow(max($1.additions, 0)).partialValue }
        let removed = diff.files.reduce(0) { $0.addingReportingOverflow(max($1.deletions, 0)).partialValue }
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
                Text("Next")
                    .font(.caption.weight(.semibold))
                Text(upcoming.map(\.label).joined(separator: " → "))
                    .font(.caption)
            }
            .foregroundStyle(ToolrollTheme.muted)
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func historySection(_ cards: StepCards) -> some View {
        let finished = (cards.cards ?? []).filter { $0.inChain && ($0.state == .done || $0.state == .skipped) }
        DisclosureGroup(isExpanded: $showHistory) {
            VStack(alignment: .leading, spacing: 0) {
                Divider().overlay(ToolrollTheme.hairline).padding(.bottom, 12)
                ForEach(Array(finished.enumerated()), id: \.offset) { index, card in
                    historyRow(card, isLast: index == finished.count - 1)
                }
                detailsBlock(cards)
            }
            .padding(.top, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(finished.isEmpty ? "Details" : "History · \(finished.count) finished")
                .font(.footnote.weight(.medium))
                .foregroundStyle(ToolrollTheme.ink)
        }
        .tint(ToolrollTheme.subtle)
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .card()
    }

    private func historyRow(_ card: StepCard, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Circle()
                    .fill(tone(card.mark).hue(appearance: appearance))
                    .frame(width: 7, height: 7)
                    .padding(.top, 4)
                if !isLast {
                    Rectangle()
                        .fill(ToolrollTheme.hairline)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.vertical, 4)
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                    Spacer()
                    if let at = RelativeTime.date(card.finishedAt ?? card.at) {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            Text(RelativeTime.ago(at, now: context.date))
                                .font(.caption2.monospaced())
                                .foregroundStyle(ToolrollTheme.subtle)
                        }
                    }
                }
                if !card.sentence.isEmpty {
                    markdownText(card.sentence)
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let facts = stepFacts(card)
                if !facts.isEmpty {
                    Text(facts)
                        .font(.caption2.monospaced())
                        .foregroundStyle(ToolrollTheme.subtle)
                }
            }
            .padding(.bottom, isLast ? 4 : 12)
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
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(ToolrollTheme.hairline).padding(.vertical, 8)
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

    // MARK: Sticky Bottom Action Dock

    @ViewBuilder
    private func bottomBar(proxy: ScrollViewProxy) -> some View {
        switch next {
        case .none:
            EmptyView()
        default:
            VStack(spacing: 0) {
                Divider().overlay(ToolrollTheme.hairline)
                Group {
                    switch next {
                    case .approveOnMac:
                        compactHandoffBar("Approve on your Mac")
                    case .answerOnMac:
                        compactHandoffBar("Answer on your Mac")
                    case .unblockOnMac:
                        compactHandoffBar("Unblock on your Mac")
                    case .reviewChanges:
                        HStack(spacing: 8) {
                            if let first = firstFileRoute {
                                NavigationLink(value: Route.diff(first)) {
                                    Text("Review diff")
                                }
                                .buttonStyle(SignalButtonStyle(compact: true))
                            } else {
                                Button("Review diff") { jumpToChanges(proxy) }
                                    .buttonStyle(SignalButtonStyle(compact: true))
                                    .disabled(diff.value?.files.isEmpty ?? true)
                            }
                            if handoffURL != nil {
                                Button {
                                    showOpenOnMac = true
                                } label: {
                                    Label("Mac", systemImage: "laptopcomputer.and.arrow.down")
                                }
                                .buttonStyle(OutlineButtonStyle(compact: true))
                                .frame(maxWidth: 108)
                                .accessibilityLabel("Open on Mac")
                            }
                        }
                    case .viewChanges:
                        Button("View changes") { jumpToChanges(proxy) }
                            .buttonStyle(OutlineButtonStyle(compact: true))
                    case .watchLive(let run):
                        Button {
                            liveSheet = LiveSheet(run: run)
                        } label: {
                            HStack(spacing: 10) {
                                LivePulseBars(color: ToolrollTheme.terminalBlue, height: 11)
                                Text("Watch live output")
                            }
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(ToolrollTheme.terminalInk)
                            .terminalCard(radius: 10)
                        }
                        .buttonStyle(.plain)
                    case .none:
                        EmptyView()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(ToolrollTheme.surface)
        }
    }

    private func compactHandoffBar(_ label: String) -> some View {
        HStack(spacing: 12) {
            if handoffURL != nil {
                Button {
                    showOpenOnMac = true
                } label: {
                    Label(label, systemImage: "arrow.up.right")
                }
                .buttonStyle(SignalButtonStyle(compact: true))
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                        .accessibilityHidden(true)
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                .card(radius: 10)
                .accessibilityElement(children: .combine)
            }
        }
    }

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
            .font(.footnote.weight(.medium))
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
                .foregroundStyle(appearance.signalText)
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
        HStack(spacing: 12) {
            Image(systemName: entry.binary ? "doc.zipper" : "doc.text")
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .frame(width: 16)
                .accessibilityHidden(true)

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
                    .font(.caption.monospaced())
                    .foregroundStyle(ToolrollTheme.muted)
            } else {
                HStack(spacing: 8) {
                    HStack(spacing: 5) {
                        Text("+\(entry.additions)").foregroundStyle(ToolrollTheme.success)
                        Text("−\(entry.deletions)").foregroundStyle(ToolrollTheme.danger)
                    }
                    .font(.caption.monospacedDigit().weight(.semibold))
                    if !dynamicTypeSize.isAccessibilitySize {
                        DiffStatPips(additions: entry.additions, deletions: entry.deletions)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.subtle)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.path), \(entry.additions) added, \(entry.deletions) removed")
    }
}

private extension String {
    var trimmingTrailingPeriod: String {
        if hasSuffix(".") && !hasSuffix("..") {
            return String(dropLast())
        }
        return self
    }
}
