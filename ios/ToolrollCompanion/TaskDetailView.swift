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
                VStack(alignment: .leading, spacing: 14) {
                    statusHeaderCard
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
                            decideScopeLayout(terms)
                        }
                        nowSection(cards)
                    }
                    changesSection
                        .id("changes")
                    if let cards = steps.value {
                        upcomingSection(cards)
                        historySection(cards)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 16)
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

    static let needsYouDetail = "It's at the top of Toolroll's Needs you list."

    private var title: String {
        row?.title ?? steps.value?.task.title ?? "Task"
    }

    private var isWaitingOnPerson: Bool {
        if let row { return row.kind.isNeedsYou }
        return next.isOnMac || next == .reviewChanges
    }

    // MARK: Compact Signal Status Header Card

    private var statusHeaderCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let row {
                    StateChip(word: row.kind.word(for: row), tone: row.kind.tone)
                } else if let chip = next.chip {
                    StateChip(word: chip.word, tone: chip.tone)
                } else if let cards = steps.value, let word = cards.headline, !word.isEmpty {
                    StateChip(word: word, tone: cards.liveRun != nil ? .live : .neutral)
                }
                if let meta = headerMeta {
                    Text(meta)
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if let subtitle = compactSubtitle {
                if next == .reviewChanges && subtitle.localizedCaseInsensitiveContains("passed") {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.success)
                        Text(subtitle)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(ToolrollTheme.success)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(ToolrollTheme.successSoft, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else {
                    markdownText(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(needsYou: isWaitingOnPerson)
    }

    private var headerMeta: String? {
        var parts: [String] = []
        if let age = row?.age, !age.isEmpty { parts.append(age) }
        if let run = steps.value?.latestRun { parts.append("run #\(run)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var compactSubtitle: String? {
        if let agentRow = steps.value?.waitingTerms?.rows.first(where: { $0.label.lowercased() == "agent" }) {
            return agentRow.words
        }
        return headerLine
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

    // MARK: C-Style Decide Scope Layout (Guardrails + Contract + Dark File Manifest)

    @ViewBuilder
    private func decideScopeLayout(_ terms: ApprovalTerms) -> some View {
        let budgetRow = terms.rows.first { matches($0.label, ["may cost", "budget", "cost"]) }
        let networkRow = terms.rows.first { matches($0.label, ["network", "sandbox"]) }
        let goalRow = terms.rows.first { matches($0.label, ["goal"]) }
        let doneRow = terms.rows.first { matches($0.label, ["done when", "done", "verify"]) }
        let filesRow = terms.rows.first { matches($0.label, ["files"]) }
        let agentRow = terms.rows.first { matches($0.label, ["agent"]) }

        let handledLabels = Set([budgetRow, networkRow, goalRow, doneRow, filesRow, agentRow].compactMap { $0?.label.lowercased() })
        let remainingRows = terms.rows.filter { !handledLabels.contains($0.label.lowercased()) }

        VStack(alignment: .leading, spacing: 12) {
            // Revision note & warnings first if present
            if let revision = terms.revision {
                Text(verbatim: revision)
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
            }
            ForEach(Array(terms.warnings.enumerated()), id: \.offset) { _, warning in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.ink)
                    Text(verbatim: warning)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(ToolrollTheme.ink)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollTheme.neutralSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
            }

            // 2-up Guardrail Tiles (Budget + Sandbox/Network)
            if budgetRow != nil || networkRow != nil {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 8) {
                        if let budgetRow { guardrailTile(icon: "dollarsign.circle", title: budgetRow.label, value: budgetRow.words, mono: true) }
                        if let networkRow { guardrailTile(icon: "network", title: networkRow.label, value: networkRow.words, mono: false) }
                    }
                } else {
                    HStack(alignment: .top, spacing: 10) {
                        if let budgetRow {
                            guardrailTile(icon: "dollarsign.circle", title: "Guardrail", value: budgetRow.words, mono: true)
                        }
                        if let networkRow {
                            guardrailTile(icon: "lock.shield", title: networkRow.label, value: networkRow.words, mono: false)
                        }
                    }
                }
            }

            // Verification Contract Card (Goal + Done when)
            if goalRow != nil || doneRow != nil {
                VStack(alignment: .leading, spacing: 0) {
                    if let goalRow {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Goal")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.muted)
                            Text(verbatim: goalRow.words)
                                .font(.subheadline)
                                .foregroundStyle(ToolrollTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                    if goalRow != nil && doneRow != nil {
                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 13)
                    }
                    if let doneRow {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Done when")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.muted)
                            Text(verbatim: doneRow.words)
                                .font(.subheadline)
                                .foregroundStyle(ToolrollTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
                .card()
            }

            // Dark Monospace File Manifest (Direction C)
            if let filesRow {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Files in scope")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.terminalMuted)
                        Spacer()
                        if !filesRow.lines.isEmpty {
                            Text("\(filesRow.lines.count) \(filesRow.lines.count == 1 ? "file" : "files")")
                                .font(.caption2.monospaced().weight(.semibold))
                                .foregroundStyle(ToolrollTheme.terminalInk)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(ToolrollTheme.terminalSurface, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        }
                    }
                    if !filesRow.words.isEmpty {
                        Text(verbatim: filesRow.words)
                            .font(.caption)
                            .foregroundStyle(ToolrollTheme.terminalMuted)
                    }
                    if !filesRow.lines.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(filesRow.lines.enumerated()), id: \.offset) { _, line in
                                HStack(spacing: 8) {
                                    Text(line.contains("test") ? "A" : "M")
                                        .font(.caption2.monospaced().weight(.bold))
                                        .foregroundStyle(line.contains("test") ? ToolrollTheme.terminalGreen : ToolrollTheme.terminalBlue)
                                        .frame(width: 12)
                                    Text(verbatim: line)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(ToolrollTheme.terminalInk)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollTheme.terminalSurface, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                }
                .padding(13)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollTheme.terminalBg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(ToolrollTheme.terminalBorder, lineWidth: 1)
                )
            }

            // Remaining scope rules (Tools, etc.) in quiet hairline key-value rows
            if !remainingRows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(remainingRows.enumerated()), id: \.offset) { index, row in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: row.label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.muted)
                            Text(verbatim: row.words)
                                .font(.footnote)
                                .foregroundStyle(ToolrollTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
                                Text(verbatim: line)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(ToolrollTheme.ink)
                            }
                        }
                        .padding(13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                        if index < remainingRows.count - 1 {
                            Divider().overlay(ToolrollTheme.hairline).padding(.leading, 13)
                        }
                    }
                }
                .card()
            }

            // Project defaults fold
            if !terms.usual.isEmpty {
                DisclosureGroup(isExpanded: $showUsual) {
                    VStack(alignment: .leading, spacing: 10) {
                        Divider().overlay(ToolrollTheme.hairline)
                        ForEach(Array(terms.usual.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline) {
                                Text(verbatim: item.label)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(ToolrollTheme.muted)
                                Spacer(minLength: 8)
                                Text(verbatim: item.words)
                                    .font(.footnote)
                                    .foregroundStyle(ToolrollTheme.ink)
                                    .multilineTextAlignment(.trailing)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Text(verbatim: terms.usualLabel)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .card()
            }
        }
    }

    private func guardrailTile(icon: String, title: String, value: String, mono: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.muted)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(ToolrollTheme.muted)
            }
            Text(verbatim: value)
                .font(mono ? .footnote.monospaced().weight(.semibold) : .footnote.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .card()
        .accessibilityElement(children: .combine)
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
                VStack(alignment: .leading, spacing: 10) {
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
                .padding(14)
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
                            Divider().overlay(ToolrollTheme.hairline).padding(.leading, 40)
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

    // MARK: Upcoming + History (Vertical Timeline Rail)

    @ViewBuilder
    private func upcomingSection(_ cards: StepCards) -> some View {
        let upcoming = (cards.cards ?? []).filter { $0.inChain && $0.state == .todo }
        if !upcoming.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Next:")
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
            .padding(.top, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(finished.isEmpty ? "Details" : "History · \(finished.count) finished")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .card()
    }

    private func historyRow(_ card: StepCard, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Circle()
                    .fill(tone(card.mark).hue)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
                if !isLast {
                    Rectangle()
                        .fill(ToolrollTheme.hairline)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.vertical, 3)
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
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
        VStack(alignment: .leading, spacing: 5) {
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

    // MARK: Slim Single-Row Bottom Action Bar

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
                        compactHandoffBar("Approve on Mac")
                    case .answerOnMac:
                        compactHandoffBar("Answer on Mac")
                    case .unblockOnMac:
                        compactHandoffBar("Unblock on Mac")
                    case .reviewChanges:
                        HStack(spacing: 8) {
                            if let first = firstFileRoute {
                                NavigationLink(value: Route.diff(first)) {
                                    Text("Review diff")
                                }
                                .buttonStyle(InkButtonStyle(compact: true))
                            } else {
                                Button("Review diff") { jumpToChanges(proxy) }
                                    .buttonStyle(InkButtonStyle(compact: true))
                                    .disabled(diff.value?.files.isEmpty ?? true)
                            }
                            if handoffURL != nil {
                                Button {
                                    showOpenOnMac = true
                                } label: {
                                    Label("Mac", systemImage: "laptopcomputer.and.arrow.down")
                                }
                                .buttonStyle(OutlineButtonStyle(compact: true))
                                .frame(maxWidth: 112)
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
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(ToolrollTheme.terminalBlue)
                                    .frame(width: 7, height: 7)
                                Text("Watch live output")
                            }
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(ToolrollTheme.terminalInk)
                            .background(ToolrollTheme.terminalBg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollTheme.terminalBorder, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    case .none:
                        EmptyView()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .background(ToolrollTheme.surface)
        }
    }

    private func compactHandoffBar(_ label: String) -> some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                    Text("Passkey approvals coming next")
                        .font(.caption2)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if handoffURL != nil {
                Button {
                    showOpenOnMac = true
                } label: {
                    Label("Open", systemImage: "arrow.up.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.onInk)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 38)
                        .background(ToolrollTheme.ink, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open on Mac")
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
                .foregroundStyle(ToolrollTheme.ink)
                .frame(minHeight: 44)
        }
        .padding(14)
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
            Image(systemName: entry.binary ? "doc.zipper" : "doc.text")
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .frame(width: 18)
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
                HStack(spacing: 5) {
                    Text("+\(entry.additions)").foregroundStyle(ToolrollTheme.success)
                    Text("−\(entry.deletions)").foregroundStyle(ToolrollTheme.danger)
                }
                .font(.caption.monospacedDigit().weight(.semibold))
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.subtle)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.path), \(entry.additions) added, \(entry.deletions) removed")
    }
}
