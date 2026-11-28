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
    @State private var actionSuccessCount = 0
    @State private var showOpenOnMac = false
    @State private var showPasskeySetup = false
    @State private var exceptionTarget: ExceptionTarget?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    static let handoffActivity = "dev.toolroll.ios.task"

    struct LiveSheet: Identifiable {
        let run: Int
        var id: Int { run }
    }

    /// The result an exception sheet was opened for (Codex C3: it never submits for another one).
    struct ExceptionTarget: Identifiable {
        let pin: PinnedResult
        var id: String { "\(pin.run):\(pin.receipt)" }
    }

    private var row: WorkRow? { appState.row(taskId) }
    private var steps: Loadable<StepCards> { appState.steps(taskId) }
    private var diff: Loadable<ResultDiff> { appState.diff(taskId) }
    private var next: NextStep { NextStep(row: row, steps: steps.value, diff: diff.value) }
    private var notice: TaskNotice? { appState.notice(for: taskId) }
    private var isDemoDone: Bool { appState.demoDoneTasks.contains(taskId) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    statusLine
                    Text(title)
                        .font(.system(size: 26, weight: .semibold))
                        .tracking(-0.5)
                        .foregroundStyle(ToolrollTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)

                    if let failure = steps.failure, steps.value == nil {
                        loadFailure(failure)
                    } else if steps.value == nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                            .padding(.vertical, 32)
                    }
                    if appState.isOffline, steps.value != nil {
                        StaleDataBanner(lastUpdated: appState.lastUpdated)
                    }

                    if let cards = steps.value, let terms = cards.waitingTerms {
                        decideContent(terms: terms, cards: cards)
                    } else if let cards = steps.value, next == .reviewChanges {
                        reviewContent(cards)
                        changesSection.id("changes")
                        historySection(cards)
                    } else if let cards = steps.value {
                        subtitleLine
                        nowSection(cards)
                        if case .watchLive = next { stepsCard(cards) }
                        changesSection.id("changes")
                        historySection(cards)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .environment(\.showsStaleData, appState.isOffline)
            .refreshable {
                await appState.loadTask(taskId)
                if steps.phase == .loaded { refreshed += 1 }
            }
            .sensoryFeedback(.success, trigger: refreshed)
            .sensoryFeedback(.success, trigger: actionSuccessCount)
            .safeAreaInset(edge: .bottom) {
                dock(proxy: proxy)
            }
        }
        .overlay(alignment: .top) { SigningBanner(wording: appState.signingWording) }
        .discardingLinks()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(headerMeta)
                    .font(.subheadline.monospaced().weight(.medium))
                    .foregroundStyle(ToolrollTheme.muted)
                    .lineLimit(1)
            }
            if handoffURL != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showOpenOnMac = true } label: { Image(systemName: "laptopcomputer") }
                        .accessibilityLabel("Open on Mac")
                }
            }
        }
        .task(id: appState.refreshTick) {
            await appState.loadTask(taskId)
            if appState.passkeyStatus == nil {
                await appState.refreshPasskeyStatus()
            }
            #if DEBUG
            if appState.debugScreen == "openLive" {
                appState.debugScreen = nil
                if case .watchLive(let run) = next { liveSheet = LiveSheet(run: run) }
            }
            if appState.debugScreen == "exception", let review = steps.value?.review {
                appState.debugScreen = nil
                exceptionTarget = ExceptionTarget(pin: PinnedResult(review))
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
        .onChange(of: steps.value?.review) { _, review in
            // The exception sheet is pinned to the result it showed: a new result closes it, nothing is submitted.
            if let target = exceptionTarget, !target.pin.isCurrent(review) {
                exceptionTarget = nil
                appState.noteResultChanged(task: taskId)
            }
        }
        .onChange(of: steps.value?.waitingTerms?.key) { old, new in
            // A confirmation or failure belongs to the plan it was about; a newer plan clears it (a stale notice
            // stays: it explains the change).
            if old != nil, new != old, notice?.kind != .changed { appState.clearNotice(for: taskId) }
        }
        .onDisappear {
            if notice?.kind == .confirmed { appState.clearNotice(for: taskId) }
        }
        .sheet(item: $liveSheet) { sheet in
            LiveWatchView(appState: appState, run: sheet.run, title: title)
        }
        .sheet(isPresented: $showPasskeySetup) {
            SettingsView(appState: appState)
        }
        .sheet(item: $exceptionTarget) { target in
            ExceptionAcceptSheet(
                title: title,
                pin: target.pin,
                blockers: steps.value?.review?.accept?.blockers ?? [],
                inFlight: appState.actionInFlight
            ) { note in
                // Only for the pinned result, and only while it's still the task's current result.
                guard target.pin.isCurrent(steps.value?.review) else {
                    exceptionTarget = nil
                    appState.noteResultChanged(task: taskId)
                    return
                }
                exceptionTarget = nil
                Task {
                    let intent = ApprovalIntent.accept(task: taskId, runId: target.pin.run, receiptDigest: target.pin.receipt, note: note, publish: false)
                    if await appState.perform(intent) { actionSuccessCount += 1 }
                }
            }
        }
        .alert("Check this task", isPresented: Binding(
            get: { appState.outcomeUnknownMessage != nil },
            set: { if !$0 { appState.outcomeUnknownMessage = nil } }
        )) {
            Button("Refresh") {
                appState.outcomeUnknownMessage = nil
                Task { await appState.loadTask(taskId) }
            }
            Button("OK", role: .cancel) { appState.outcomeUnknownMessage = nil }
        } message: {
            Text(appState.outcomeUnknownMessage ?? "")
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

    /// "api-gateway · #36": the project and the latest run.
    private var headerMeta: String {
        var parts: [String] = []
        if let project = row?.project ?? steps.value?.task.project.map(projectName), !project.isEmpty { parts.append(project) }
        if let run = steps.value?.latestRun { parts.append("#\(run)") }
        return parts.isEmpty ? "Task" : parts.joined(separator: " · ")
    }

    // MARK: Status line

    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            if let cards = steps.value, case .watchLive = next {
                LiveDot()
                Text(PlanSteps.progress(cards)?.label ?? "Running")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.info)
            } else if next == .approvePlan, steps.value?.waitingTerms != nil {
                InkChip(text: "Needs your approval")
                ageText(prefix: notice?.kind == .changed ? "Plan updated" : "Planned")
            } else if next == .reviewChanges {
                InkChip(text: "Ready for your review")
                ageText(prefix: "Finished")
            } else if let row {
                if let chip = row.kind.chip(for: row) { InkChip(text: chip) } else {
                    StatusDotLabel(word: row.kind.word(for: row), tone: row.kind.tone, size: .footnote)
                }
                ageText(prefix: nil)
            } else if let chip = next.chip {
                StatusDotLabel(word: chip.word, tone: chip.tone, size: .footnote)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func ageText(prefix: String?) -> some View {
        if notice?.kind == .changed, prefix == "Plan updated" {
            Text("Plan updated just now").font(.footnote).foregroundStyle(ToolrollTheme.muted)
        } else if let age = row?.age, !age.isEmpty {
            Text(prefix.map { "\($0) \(age)" } ?? age)
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .lineLimit(1)
        }
    }

    // MARK: Decide

    @ViewBuilder
    private func decideContent(terms: ApprovalTerms, cards: StepCards) -> some View {
        let goalRow = terms.rows.first { matches($0.label, ["goal"]) }
        let doneRow = terms.rows.first { matches($0.label, ["done when", "done", "verify"]) }
        let filesRow = terms.rows.first { matches($0.label, ["files"]) }
        let costRow = terms.rows.first { matches($0.label, ["may cost", "budget", "cost"]) }
        let networkRow = terms.rows.first { matches($0.label, ["network"]) }
        let shown = Set([doneRow, filesRow, costRow, networkRow].compactMap { $0?.label.lowercased() })
        let detailRows = terms.rows.filter { !shown.contains($0.label.lowercased()) && !(doneRow == nil && $0.label == goalRow?.label) }
        let changed = changedLabels(terms)
        let plan = PlanSteps.after(approvalIn: cards)

        if let reason = cards.approveAlwaysAsks {
            RiskBanner(reason: reason, paths: cards.passkey?.protectedPaths ?? [], verb: "Approving")
        }

        if !terms.warnings.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(terms.warnings.enumerated()), id: \.offset) { _, warning in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.dangerInk)
                            .accessibilityHidden(true)
                        Text(verbatim: warning)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(ToolrollTheme.dangerInk)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ToolrollTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }

        if let criterion = doneRow ?? goalRow {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(doneRow != nil ? "Done when" : "Goal")
                Text(verbatim: sentenceCased(criterion.words).trimmingTrailingPeriod + ".")
                    .font(.system(size: 15))
                    .lineSpacing(3)
                    .foregroundStyle(ToolrollTheme.ink)
                    .padding(.horizontal, changed.contains(criterion.label.lowercased()) ? 3 : 0)
                    .background(changed.contains(criterion.label.lowercased()) ? ToolrollTheme.changedMark : .clear, in: RoundedRectangle(cornerRadius: 3))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }

        if !plan.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel("Plan")
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                ForEach(Array(plan.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(step.number)")
                            .font(.caption.monospaced().weight(.medium))
                            .foregroundStyle(ToolrollTheme.ink)
                            .frame(width: 20, height: 20)
                            .overlay(Circle().strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.title)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(ToolrollTheme.ink)
                            if let detail = step.detail {
                                markdownText(detail.trimmingTrailingPeriod)
                                    .font(.footnote)
                                    .foregroundStyle(ToolrollTheme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }
                Spacer().frame(height: 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }

        VStack(spacing: 0) {
            if let costRow {
                factRow("Budget", changed: changed.contains(costRow.label.lowercased())) {
                    Text(verbatim: compactCost(costRow.words))
                        .font(.subheadline.monospaced())
                }
            }
            if let filesRow {
                if costRow != nil { rowDivider }
                DisclosureGroup(isExpanded: $showFiles) {
                    filesList(filesRow)
                } label: {
                    HStack {
                        Text("Files").font(.system(size: 15)).foregroundStyle(ToolrollTheme.muted)
                        Spacer(minLength: 8)
                        Text(filesCountLabel(filesRow))
                            .font(.system(size: 15))
                            .foregroundStyle(ToolrollTheme.ink)
                            .padding(.horizontal, changed.contains(filesRow.label.lowercased()) ? 3 : 0)
                            .background(changed.contains(filesRow.label.lowercased()) ? ToolrollTheme.changedMark : .clear, in: RoundedRectangle(cornerRadius: 3))
                    }
                }
                .tint(ToolrollTheme.muted)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
            }
            if let networkRow {
                if costRow != nil || filesRow != nil { rowDivider }
                factRow("Network", changed: changed.contains(networkRow.label.lowercased())) {
                    Text(verbatim: sentenceCased(networkRow.words))
                        .font(.system(size: 15))
                        .multilineTextAlignment(.trailing)
                }
            }
            if !detailRows.isEmpty || !terms.usual.isEmpty || terms.revision != nil {
                rowDivider
                DisclosureGroup(isExpanded: $showDetails) {
                    VStack(alignment: .leading, spacing: 12) {
                        if let revision = terms.revision {
                            Text(verbatim: revision).font(.caption).foregroundStyle(ToolrollTheme.muted)
                        }
                        ForEach(Array(detailRows.enumerated()), id: \.offset) { _, item in
                            compactDetailRow(item.label, sentenceCased(item.words), changed: changed.contains(item.label.lowercased()))
                        }
                        if !terms.usual.isEmpty {
                            Divider().overlay(ToolrollTheme.hairline)
                            ForEach(Array(terms.usual.enumerated()), id: \.offset) { _, item in
                                compactDetailRow(item.label, item.words, changed: false)
                            }
                        }
                        detailsBlock(cards)
                    }
                    .padding(.top, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Text("Details").font(.system(size: 15)).foregroundStyle(ToolrollTheme.muted)
                }
                .tint(ToolrollTheme.muted)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
            }
        }
        .card()
    }

    /// The rows that changed since the plan the person was reading (after a stale-plan refusal).
    private func changedLabels(_ terms: ApprovalTerms) -> Set<String> {
        guard let notice, notice.kind == .changed, let shown = notice.shownTerms, shown.key != terms.key || shown != terms else { return [] }
        return ApprovalTermsChange.changedLabels(old: shown, new: terms)
    }

    private var rowDivider: some View {
        Divider().overlay(ToolrollTheme.hairline)
    }

    private func factRow<Value: View>(_ label: String, changed: Bool, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.system(size: 15)).foregroundStyle(ToolrollTheme.muted)
            Spacer(minLength: 8)
            value()
                .foregroundStyle(ToolrollTheme.ink)
                .padding(.horizontal, changed ? 3 : 0)
                .background(changed ? ToolrollTheme.changedMark : .clear, in: RoundedRectangle(cornerRadius: 3))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func filesList(_ filesRow: ApprovalTerms.Row) -> some View {
        if !filesRow.lines.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(filesRow.lines.enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line)
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.ink)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 10)
        } else if !filesRow.words.isEmpty {
            Text(verbatim: sentenceCased(filesRow.words))
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
        }
    }

    private func compactCost(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // "Up to $2.00 · stops after 20 min without progress" reads as "≤ $2.00 · 20m".
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
        if !row.lines.isEmpty { return "\(row.lines.count) in scope" }
        return row.words.isEmpty ? "In scope" : sentenceCased(row.words)
    }

    private func compactDetailRow(_ label: String, _ value: String, changed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: label).font(.caption).foregroundStyle(ToolrollTheme.muted)
            Text(verbatim: value)
                .font(.footnote)
                .foregroundStyle(ToolrollTheme.ink)
                .padding(.horizontal, changed ? 3 : 0)
                .background(changed ? ToolrollTheme.changedMark : .clear, in: RoundedRectangle(cornerRadius: 3))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func sentenceCased(_ raw: String) -> String {
        guard let first = raw.first, first.isLowercase else { return raw }
        return first.uppercased() + raw.dropFirst()
    }

    // MARK: Review

    @ViewBuilder
    private func reviewContent(_ cards: StepCards) -> some View {
        if let reason = cards.acceptAlwaysAsks, reason == .protectedWork {
            RiskBanner(reason: reason, paths: cards.passkey?.protectedPaths ?? [], verb: "Accepting")
        }
        let blockers = cards.review?.accept?.blockers ?? []
        if !blockers.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Label(blockers.count == 1 ? "1 problem to know about" : "\(blockers.count) problems to know about", systemImage: "exclamationmark.circle")
                    .font(.subheadline.weight(.semibold))
                ForEach(Array(blockers.enumerated()), id: \.offset) { _, line in
                    markdownText(line).font(.footnote.monospaced())
                }
            }
            .foregroundStyle(ToolrollTheme.dangerInk)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else if let checks = checksLine(cards) {
            Label(checks, systemImage: "checkmark.circle")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ToolrollTheme.success)
        }
        if let changed = whatChanged(cards) {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("What changed")
                markdownText(changed.trimmingTrailingPeriod + ".")
                    .font(.system(size: 15))
                    .lineSpacing(3)
                    .foregroundStyle(ToolrollTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }

    /// "All 42 checks passed", from the Checks step the Mac sent.
    private func checksLine(_ cards: StepCards) -> String? {
        let sentence = cards.cards?.first(where: { $0.key == .checks && $0.state == .done })?.sentence
        guard let sentence, sentence.localizedCaseInsensitiveContains("passed") else { return nil }
        return sentence.trimmingTrailingPeriod
    }

    /// The build step's own summary of the result, when it wrote one.
    private func whatChanged(_ cards: StepCards) -> String? {
        guard let build = cards.cards?.last(where: { $0.key == .build && $0.state == .done }), !build.sentence.isEmpty,
              !build.sentence.localizedCaseInsensitiveContains("build finished") else { return nil }
        return build.sentence
    }

    private var subtitleLine: some View {
        Group {
            if let line = headerLine {
                markdownText(line.trimmingTrailingPeriod)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var headerLine: String? {
        let line: String?
        if let question = row?.need?.question { line = question.text }
        else if let need = row?.need?.line ?? row?.need?.reason { line = need }
        else if let landing = steps.value?.landing { line = landing.words }
        else { line = row?.problem ?? row?.detail }
        guard let line, !repeats(line, next.headline) else { return nil }
        return line
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
        keys.contains(label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    // MARK: Now / steps (running)

    @ViewBuilder
    private func nowSection(_ cards: StepCards) -> some View {
        let notes = problemNotes(cards)
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
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
        return notes
    }

    /// The steps after the approval with where each stands (running tasks).
    @ViewBuilder
    private func stepsCard(_ cards: StepCards) -> some View {
        let plan = PlanSteps.after(approvalIn: cards)
        if !plan.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(plan.enumerated()), id: \.offset) { index, step in
                    let live = step.state == .current || step.mark == .live
                    let done = step.state == .done
                    HStack(spacing: 12) {
                        Group {
                            if live {
                                Circle().fill(ToolrollTheme.info)
                            } else if done {
                                Image(systemName: "checkmark.circle.fill").resizable().foregroundStyle(ToolrollTheme.success)
                            } else {
                                Circle().strokeBorder(ToolrollTheme.controlLine, lineWidth: 1)
                            }
                        }
                        .frame(width: 20, height: 20)
                        .accessibilityHidden(true)
                        Text(step.title)
                            .font(.system(size: 15, weight: live ? .medium : .regular))
                            .foregroundStyle(live || done ? ToolrollTheme.ink : ToolrollTheme.muted)
                        Spacer(minLength: 8)
                        if live {
                            Text("Running").font(.footnote).foregroundStyle(ToolrollTheme.info)
                        } else if !done, index == (plan.firstIndex { $0.state == .current || $0.mark == .live } ?? -2) + 1 {
                            Text("Next").font(.footnote).foregroundStyle(ToolrollTheme.muted)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .accessibilityElement(children: .combine)
                    if index < plan.count - 1 { rowDivider }
                }
            }
            .card()
        }
    }

    // MARK: Changes

    @ViewBuilder
    private var changesSection: some View {
        if let value = diff.value, !value.files.isEmpty, let run = value.run {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel("Files")
                    Spacer()
                    filesSummary(value)
                        .font(.footnote.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                }
                .padding(.horizontal, 2)

                VStack(spacing: 0) {
                    ForEach(Array(value.files.enumerated()), id: \.element.file) { index, entry in
                        NavigationLink(value: Route.diff(DiffRoute(
                            task: taskId, run: run, file: entry.file, path: entry.path,
                            additions: entry.additions, deletions: entry.deletions
                        ))) {
                            FileRow(entry: entry, protectedPaths: steps.value?.passkey?.protectedPaths ?? [])
                        }
                        .buttonStyle(.plain)
                        .disabled(entry.binary)
                        if index < value.files.count - 1 { rowDivider }
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

    private func filesSummary(_ diff: ResultDiff) -> Text {
        let shown = diff.files.count
        let added = diff.files.reduce(0) { $0.addingReportingOverflow(max($1.additions, 0)).partialValue }
        let removed = diff.files.reduce(0) { $0.addingReportingOverflow(max($1.deletions, 0)).partialValue }
        let files: String
        if let total = diff.totals?.files, total > shown { files = "\(shown) of \(total) files" } else { files = shown == 1 ? "1 file" : "\(shown) files" }
        return Text("\(files) · ") + Text("+\(added)").foregroundColor(ToolrollTheme.success) + Text(" ") + Text("−\(removed)").foregroundColor(ToolrollTheme.danger)
    }

    // MARK: History

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
        .tint(ToolrollTheme.muted)
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .card()
    }

    private func historyRow(_ card: StepCard, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Circle()
                    .fill(tone(card.mark).hue)
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
        if let agent = card.agent { parts.append(ModelName.display(provider: agent.provider, model: agent.model)) }
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
            Text(label).font(.caption).foregroundStyle(ToolrollTheme.muted)
            Spacer()
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(ToolrollTheme.ink)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Dock

    @ViewBuilder
    private func dock(proxy: ScrollViewProxy) -> some View {
        if next != .none || notice != nil {
            VStack(spacing: 10) {
                if let notice { NoticeView(notice: notice, verb: next == .reviewChanges ? .accept : .approve) }
                switch next {
                case .approvePlan:
                    approveDock
                case .answerOnMac:
                    handoffBar("Answer on your Mac")
                case .unblockOnMac:
                    handoffBar("Unblock on your Mac")
                case .reviewChanges:
                    reviewDock(proxy: proxy)
                case .viewChanges:
                    Button("View changes") { jumpToChanges(proxy) }
                        .buttonStyle(OutlineButtonStyle())
                case .watchLive(let run):
                    Button {
                        liveSheet = LiveSheet(run: run)
                    } label: {
                        HStack(spacing: 10) {
                            LivePulseBars(color: ToolrollTheme.info, height: 11)
                            Text("Watch live output")
                        }
                    }
                    .buttonStyle(OutlineButtonStyle())
                case .none:
                    EmptyView()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .background {
                ToolrollTheme.paper
                    .overlay(alignment: .top) { Divider().overlay(ToolrollTheme.border) }
                    .ignoresSafeArea(edges: .bottom)
            }
        }
    }

    /// Unlocked, eligible, and not overridden by "Always ask": the tap won't prompt.
    private func unlockedUntil(alwaysAsks: AlwaysAsksReason?) -> Date? {
        guard alwaysAsks == nil, !appState.isOffline else { return nil }
        return appState.approvalsUnlockedUntil(now: Date())
    }

    @ViewBuilder
    private var approveDock: some View {
        if isDemoDone {
            EmptyView()
        } else if let terms = steps.value?.waitingTerms {
            let alwaysAsks = steps.value?.approveAlwaysAsks
            let until = unlockedUntil(alwaysAsks: alwaysAsks)
            if appState.isOffline {
                pausedBar
            } else if needsPasskeySetup {
                setupPasskeyButton
                caption("Your Mac needs a passkey from this iPhone before you can approve here.")
            } else {
                if let until { UnlockedLine(until: until, appState: appState) }
                Button {
                    Task {
                        if await appState.perform(.approve(task: taskId, digest: terms.key), shownTerms: terms) {
                            actionSuccessCount += 1
                        }
                    }
                } label: {
                    actionLabel(
                        notice?.kind == .changed ? "Approve the new plan" : (until == nil ? "Approve with passkey" : "Approve plan"),
                        glyph: until == nil
                    )
                }
                .modifier(PrimaryStyle(deliberate: alwaysAsks != nil))
                .disabled(appState.actionInFlight || !appState.canRunActions)
                if notice?.kind != .changed {
                    caption(approveCaption(alwaysAsks: alwaysAsks, unlocked: until != nil))
                }
            }
        } else {
            handoffBar("Approve on your Mac")
        }
    }

    private func approveCaption(alwaysAsks: AlwaysAsksReason?, unlocked: Bool) -> String {
        if let alwaysAsks { return alwaysAsks.caption }
        if unlocked { return "No passkey prompt while approvals are unlocked." }
        if case .viewingOnly(let reason) = appState.approvalsAccess, reason == .macAsksEveryTime || reason == .alwaysAsk {
            return AppLockPolicy.viewingOnlyMessage(reason)
        }
        return "\(DeviceUnlockName.current) confirms it's you. The build starts right after."
    }

    @ViewBuilder
    private func reviewDock(proxy: ScrollViewProxy) -> some View {
        let alwaysAsks = steps.value?.acceptAlwaysAsks
        let until = unlockedUntil(alwaysAsks: alwaysAsks)
        if !isDemoDone, steps.value?.review != nil, !appState.isOffline, !needsPasskeySetup, let until {
            UnlockedLine(until: until, appState: appState)
        }
        HStack(spacing: 10) {
            Group {
                if let first = firstFileRoute {
                    NavigationLink(value: Route.diff(first)) { Text("Review diff") }
                        .buttonStyle(OutlineButtonStyle())
                } else {
                    Button("Review diff") { jumpToChanges(proxy) }
                        .buttonStyle(OutlineButtonStyle())
                        .disabled(diff.value?.files.isEmpty ?? true)
                }
            }
            .frame(maxWidth: isDemoDone || steps.value?.review == nil ? .infinity : 150)
            if isDemoDone {
                EmptyView()
            } else if let review = steps.value?.review {
                if appState.isOffline {
                    pausedBar
                } else if needsPasskeySetup {
                    setupPasskeyButton
                } else {
                    Button {
                        if alwaysAsks == .exception {
                            exceptionTarget = ExceptionTarget(pin: PinnedResult(review))
                        } else {
                            Task {
                                let intent = ApprovalIntent.accept(task: taskId, runId: review.run, receiptDigest: review.receipt, note: nil, publish: false)
                                if await appState.perform(intent) { actionSuccessCount += 1 }
                            }
                        }
                    } label: {
                        actionLabel(alwaysAsks != nil ? "Accept with passkey" : "Accept result", glyph: until == nil)
                    }
                    .modifier(PrimaryStyle(deliberate: alwaysAsks != nil))
                    .disabled(appState.actionInFlight || !appState.canRunActions)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        if !isDemoDone, steps.value?.review != nil, !appState.isOffline {
            caption(alwaysAsks?.caption ?? "Marks the task Complete. Landing and shipping stay on your Mac.")
        }
    }

    private var needsPasskeySetup: Bool {
        !appState.isDemoMode && appState.passkeyStatus?.registered == false
    }

    private var setupPasskeyButton: some View {
        Button {
            showPasskeySetup = true
        } label: {
            Label("Set up passkey to approve", systemImage: "person.badge.key")
        }
        .buttonStyle(SignalButtonStyle())
    }

    @ViewBuilder
    private func actionLabel(_ text: String, glyph: Bool) -> some View {
        if appState.actionInFlight {
            ProgressView().tint(ToolrollTheme.muted)
        } else if glyph {
            Label(text, systemImage: "faceid").lineLimit(1).minimumScaleFactor(0.85)
        } else {
            Text(text).lineLimit(1).minimumScaleFactor(0.85)
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12.5))
            .foregroundStyle(ToolrollTheme.muted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var pausedBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash").font(.footnote).accessibilityHidden(true)
            Text("Paused · your Mac is offline").font(.subheadline.weight(.medium))
        }
        .foregroundStyle(ToolrollTheme.muted)
        .frame(maxWidth: .infinity, minHeight: 52)
        .card(radius: 12)
        .accessibilityElement(children: .combine)
    }

    private func handoffBar(_ label: String) -> some View {
        Group {
            if handoffURL != nil {
                Button { showOpenOnMac = true } label: { Label(label, systemImage: "arrow.up.right") }
                    .buttonStyle(SignalButtonStyle())
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "laptopcomputer").font(.footnote).accessibilityHidden(true)
                    Text(label).font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(ToolrollTheme.ink)
                .frame(maxWidth: .infinity, minHeight: 52)
                .card(radius: 12)
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

    private func loadFailure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Couldn't load this task")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
            Button("Try again") { Task { await appState.loadTask(taskId) } }
                .buttonStyle(PillButtonStyle(filled: true))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
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

/// Ink fill for routine acts; an ink outline for acts that always ask for the passkey.
private struct PrimaryStyle: ViewModifier {
    let deliberate: Bool

    func body(content: Content) -> some View {
        if deliberate {
            content.buttonStyle(DeliberateButtonStyle())
        } else {
            content.buttonStyle(SignalButtonStyle())
        }
    }
}

/// "Approvals unlocked until 10:58 · Lock now", right where the tap happens.
private struct UnlockedLine: View {
    let until: Date
    let appState: CompanionAppState

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.open").font(.footnote).accessibilityHidden(true)
            (Text("Approvals unlocked until ") + Text(until.formatted(date: .omitted, time: .shortened)).font(.footnote.monospaced()))
                .font(.footnote)
            Spacer(minLength: 8)
            Button("Lock now") { Task { await appState.lockPasskeyApprovals() } }
                .buttonStyle(PillButtonStyle())
                .disabled(appState.actionInFlight)
        }
        .foregroundStyle(ToolrollTheme.body)
        .padding(.horizontal, 2)
    }
}

/// A protected or release plan / result: outlined in ink, saying it always asks.
private struct RiskBanner: View {
    let reason: AlwaysAsksReason
    let paths: [String]
    let verb: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.shield")
                .font(.title3)
                .foregroundStyle(ToolrollTheme.ink)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(reason == .release ? "Release" : "Protected work")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(ToolrollTheme.ink, lineWidth: 1.5))
        .accessibilityElement(children: .combine)
    }

    private var detail: AttributedString {
        let tail = "\(verb) always asks for your passkey, even when approvals are unlocked."
        if reason == .release { return AttributedString("This is a release. " + tail) }
        guard !paths.isEmpty else { return AttributedString("This task touches protected paths. " + tail) }
        var text = AttributedString("Changes ")
        var list = AttributedString(paths.prefix(3).joined(separator: ", "))
        list.font = .footnote.monospaced()
        text += list
        text += AttributedString(paths.count == 1 ? ", a protected path. " : ", protected paths. ")
        text += AttributedString(tail)
        return text
    }
}

/// The task's one notice: a confirmation (green), a changed plan/result (outlined), or why nothing happened.
private struct NoticeView: View {
    let notice: TaskNotice
    let verb: PasskeyApprovalVerb

    var body: some View {
        switch notice.kind {
        case .confirmed:
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle").accessibilityHidden(true)
                Text(notice.text).font(.subheadline.weight(.medium))
                Spacer(minLength: 8)
                if let at = notice.at {
                    Text(at.formatted(date: .omitted, time: .shortened)).font(.caption.monospaced()).opacity(0.85)
                }
            }
            .foregroundStyle(ToolrollTheme.successInk)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(ToolrollTheme.successSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
        case .changed, .failed:
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(notice.kind == .failed ? ToolrollTheme.danger : ToolrollTheme.ink)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(heading).font(.subheadline.weight(.semibold)).foregroundStyle(ToolrollTheme.ink)
                    Text(notice.text)
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
            .accessibilityElement(children: .combine)
        }
    }

    private var heading: String {
        switch notice.kind {
        case .changed: return verb == .approve ? "The plan changed while you were reading" : "The result changed while you were reading"
        case .failed: return verb == .approve ? "Not approved" : "Not accepted"
        case .confirmed: return ""
        }
    }
}

/// Shown above the system passkey sheet: what this assertion signs, in the Mac's words (ADR 0005).
struct SigningBanner: View {
    let wording: String?

    var body: some View {
        if let wording {
            VStack(alignment: .leading, spacing: 4) {
                Text("Confirming with your passkey")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                Text(wording)
                    .font(.caption.monospaced())
                    .foregroundStyle(ToolrollTheme.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
            .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityElement(children: .combine)
        }
    }
}

/// Accept with exception: failed checks first, the pinned result, then why it's OK.
private struct ExceptionAcceptSheet: View {
    let title: String
    let pin: PinnedResult
    let blockers: [String]
    let inFlight: Bool
    let onAccept: (String) -> Void
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var trimmed: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !blockers.isEmpty {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(blockers.count == 1 ? "1 check failed" : "\(blockers.count) checks failed")
                                    .font(.system(size: 15, weight: .semibold))
                                ForEach(Array(blockers.enumerated()), id: \.offset) { _, line in
                                    markdownText(line).font(.footnote.monospaced())
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(ToolrollTheme.dangerInk)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .background(ToolrollTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }

                    VStack(spacing: 0) {
                        row("You're accepting", Text(title).font(.subheadline.weight(.medium)))
                        Divider().overlay(ToolrollTheme.hairline)
                        row("Result", Text("run \(pin.run) · \(String(pin.receipt.prefix(7)))").font(.footnote.monospaced().weight(.medium)))
                    }
                    .card()

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Why is it OK to accept?")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.ink)
                        TextField(
                            "For example: the e2e failure is the known flaky login test; tracked in #212.",
                            text: $note, axis: .vertical
                        )
                        .lineLimit(4...8)
                        .focused($focused)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
                        .accessibilityLabel("Why is it OK to accept?")
                        Text("Your note is saved with the approval and shown to your team.")
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button {
                        onAccept(trimmed)
                    } label: {
                        Label("Accept with passkey", systemImage: "faceid")
                    }
                    .buttonStyle(DeliberateButtonStyle())
                    .disabled(trimmed.isEmpty || inFlight)
                    Text(trimmed.isEmpty
                         ? "Write why it's OK to accept first. Always asks for your passkey."
                         : "Always asks for your passkey · exception. If the result changes, this sheet closes.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(ToolrollTheme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(ToolrollTheme.paper)
            }
            .navigationTitle("Accept with exception")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func row(_ label: String, _ value: Text) -> some View {
        HStack {
            Text(label).font(.subheadline).foregroundStyle(ToolrollTheme.muted)
            Spacer(minLength: 12)
            value.foregroundStyle(ToolrollTheme.ink).lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

private struct FileRow: View {
    let entry: ResultDiffEntry
    var protectedPaths: [String] = []
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text((entry.path as NSString).lastPathComponent)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ToolrollTheme.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                let folder = (entry.path as NSString).deletingLastPathComponent
                if !folder.isEmpty || isProtected {
                    Text(folder + (isProtected ? (folder.isEmpty ? "protected" : " · protected") : ""))
                        .font(.caption.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            if entry.binary {
                Text("binary").font(.caption.monospaced()).foregroundStyle(ToolrollTheme.muted)
            } else {
                HStack(spacing: 5) {
                    Text("+\(entry.additions)").foregroundStyle(ToolrollTheme.success)
                    Text("−\(entry.deletions)").foregroundStyle(ToolrollTheme.danger)
                }
                .font(.footnote.monospaced().weight(.medium))
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.path)\(isProtected ? ", protected" : ""), \(entry.additions) added, \(entry.deletions) removed")
    }

    private var isProtected: Bool { protectedPaths.contains(entry.path) }
}

extension String {
    var trimmingTrailingPeriod: String {
        if hasSuffix(".") && !hasSuffix("..") {
            return String(dropLast())
        }
        return self
    }
}
