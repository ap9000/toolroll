import AppKit
import SwiftUI
import ToolrollCore

/// Center Task Cockpit (--so-paper) — approval ceremony handoff, Candidates strip, Steps timeline, and bottom composer.
public struct TaskCockpitView: View {
    @Bindable var store: WorkbenchStore
    @State private var steerDraft: String = ""
    @State private var expandedSteps: Set<String> = []

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let row = store.selectedRow {
                taskHeader(row)
                HairlineDivider()

                // In-place notice / refusal banner (never toasts!)
                if let notice = store.notice {
                    inPlaceNoticeBar(notice)
                    HairlineDivider()
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let ask = approvalSummary(for: row) {
                            approvalCeremonyCard(taskId: row.id, summary: ask)
                        }

                        if let cands = store.candidatesResponse?.candidates, !cands.isEmpty {
                            candidatesSection(taskId: row.id, candidates: cands)
                        }

                        stepsSection()
                    }
                    .padding(20)
                }

                HairlineDivider()
                composerBar(taskId: row.id)
            } else {
                emptyState
            }
        }
        .background(ToolrollPalette.paper)
    }

    // MARK: - Header

    private func taskHeader(_ row: WorkRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(row.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(2)
                Spacer(minLength: 8)
                StatusChip(tone: row.status, label: row.word)
            }

            HStack(spacing: 10) {
                if let project = row.project, !project.isEmpty {
                    Text(project)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }

                Text(row.id)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)

                // Owner & Task Handoff menu
                Menu {
                    ForEach(store.presence.accounts, id: \.self) { person in
                        Button {
                            Task { await store.handOffTask(taskId: row.id, to: person) }
                        } label: {
                            HStack {
                                Text(person == store.presence.me ? "@\(person) (me)" : "@\(person)")
                                if store.selectedTaskOwner == person {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "person")
                            .font(.system(size: 10.5))
                        Text(store.selectedTaskOwner.map { "@\($0)" } ?? "Unassigned")
                            .font(.system(size: 11.5, weight: .medium))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                    }
                    .foregroundStyle(ToolrollPalette.ink)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3.5)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()

                if let presSummary = store.selectedTaskPresence?.summary {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(ToolrollPalette.live)
                            .frame(width: 6, height: 6)
                        Text(presSummary)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }

                Spacer()

                if let busy = store.busyLabel {
                    Text(busy)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                Button {
                    Task { await store.attachOrStartTerminal(taskId: row.id, program: "shell") }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "terminal")
                            .font(.system(size: 11))
                        Text("Live Terminal")
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                Button {
                    store.openTaskInBrowser(taskId: row.id)
                } label: {
                    HStack(spacing: 4) {
                        Text("Browser")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 10))
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: - In-Place Notice (No Toasts)

    private func inPlaceNoticeBar(_ notice: WorkbenchNotice) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.live)
                .frame(width: 6, height: 6)
            Text(notice.message)
                .font(.system(size: 12))
                .foregroundStyle(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.ink)
                .textSelection(.enabled)
            Spacer()
            Button {
                store.notice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(notice.kind == .refusal ? ToolrollPalette.danger.opacity(0.06) : ToolrollPalette.raised)
    }

    // MARK: - High-Trust Approval Ceremony Card

    private func approvalSummary(for row: WorkRow) -> String? {
        if let ask = row.ask, !ask.isEmpty { return ask }
        if let needsStep = store.stepCards?.cards.first(where: \.needsYou) {
            return needsStep.terms?.summary ?? needsStep.sentence
        }
        if row.status == .needs {
            return "High-trust approval required in Browser before the central Run proceeds."
        }
        return nil
    }

    private func approvalCeremonyCard(taskId: String, summary: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .needs, label: "Needs your approval")
                Text("Digest-bound ceremony")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
            }

            Text(summary)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Button {
                    store.openTaskInBrowser(taskId: taskId)
                } label: {
                    HStack(spacing: 5) {
                        Text("Approve in Browser")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 10.5, weight: .semibold))
                    }
                }
                .buttonStyle(KitButtonStyle(.primary))

                Button {
                    Task { await store.pingApproval(taskId: taskId) }
                } label: {
                    Text("Ping Phone / Browser")
                }
                .buttonStyle(KitButtonStyle(.ghost))
            }
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Candidates Strip

    private func candidatesSection(taskId: String, candidates: [HandoffCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Candidates")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if let base = store.candidatesResponse?.currentBaseCommit {
                    Text("base \(base.prefix(8))")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }

            VStack(spacing: 8) {
                ForEach(candidates) { cand in
                    candidateCard(taskId: taskId, candidate: cand)
                }
            }
        }
    }

    private func candidateCard(taskId: String, candidate: HandoffCandidate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(String(candidate.id.prefix(10)))
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)

                Text("by @\(candidate.author)")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)

                Text("· \(candidate.files.count) \(candidate.files.count == 1 ? "file" : "files")")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)

                Spacer()

                candidateBadge(candidate)
            }

            if !candidate.note.isEmpty {
                Text(candidate.note)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
            }

            HStack(spacing: 8) {
                if candidate.stale {
                    let cmd = "toolroll handoff rebase \(taskId)"
                    HStack(spacing: 6) {
                        Text(cmd)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.warning)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                        Button("Copy rebase command") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(cmd, forType: .string)
                            store.notice = WorkbenchNotice(kind: .info, message: "Copied `\(cmd)` to clipboard.")
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    }
                } else if candidate.promotedAt == nil {
                    Button("Promote to Run") {
                        Task { await store.promoteCandidate(taskId: taskId, candidateId: candidate.id) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                if candidate.canOpenPr {
                    Button("Open PR") {
                        Task { await store.openCandidatePr(taskId: taskId, candidateId: candidate.id) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                }

                if let pub = candidate.publication, let prNum = pub.prNumber {
                    Button {
                        if let url = pub.prUrl { store.openExternalURL(url) }
                    } label: {
                        HStack(spacing: 4) {
                            Text("PR #\(prNum)")
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9.5))
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                if let runId = candidate.runId {
                    Button("View Diff (Run #\(runId))") {
                        store.isInspectorVisible = true
                        store.inspectorTab = .diff
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                Spacer()
            }
        }
        .padding(12)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.line, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func candidateBadge(_ cand: HandoffCandidate) -> some View {
        if let prNum = cand.publication?.prNumber {
            pill("PR #\(prNum)", color: ToolrollPalette.success)
        } else if let state = cand.publication?.state {
            pill("PR \(state)", color: ToolrollPalette.live)
        } else if cand.stale {
            pill("Stale", color: ToolrollPalette.warning)
        } else if let runId = cand.runId {
            let check = cand.liveCheckState ?? cand.checkStatus ?? "promoted"
            let c: Color = (check == "passed") ? ToolrollPalette.success : (check == "failed" ? ToolrollPalette.danger : ToolrollPalette.live)
            pill("Run #\(runId) · \(check)", color: c)
        } else {
            pill("Unverified", color: ToolrollPalette.muted)
        }
    }

    private func pill(_ text: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text(text)
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    // MARK: - Steps Timeline

    private func stepsSection() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Steps")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if let headline = store.stepCards?.headline, !headline.isEmpty {
                    Text(headline)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
            }

            if let cards = store.stepCards?.cards, !cards.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(cards.enumerated()), id: \.element.id) { idx, card in
                        stepRow(card)
                        if idx < cards.count - 1 {
                            HairlineDivider()
                        }
                    }
                }
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                )
            } else {
                Text("No step timeline recorded yet.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.vertical, 10)
            }
        }
    }

    private func stepRow(_ card: StepCard) -> some View {
        let isExpanded = expandedSteps.contains(card.id) || card.needsYou
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                if expandedSteps.contains(card.id) {
                    expandedSteps.remove(card.id)
                } else {
                    expandedSteps.insert(card.id)
                }
            } label: {
                HStack(spacing: 10) {
                    Text(card.mark.isEmpty ? "·" : card.mark)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(card.needsYou ? ToolrollPalette.ink : (card.state == "done" ? ToolrollPalette.success : ToolrollPalette.muted))
                        .frame(width: 14)

                    Text(card.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)

                    if let agent = card.agent {
                        Text("\(agent.provider)\(agent.model.map { " · \($0)" } ?? "")")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }

                    Spacer()

                    if let cost = card.costUsd, cost > 0 {
                        Text(String(format: "$%.2f", cost))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    if let at = card.at {
                        Text(at)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !card.sentence.isEmpty {
                Text(card.sentence)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(isExpanded ? nil : 2)
                    .padding(.leading, 24)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    // MARK: - Composer Bar

    private func composerBar(taskId: String) -> some View {
        HStack(spacing: 8) {
            TextField("Steer task or leave a note for the next run…", text: $steerDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .foregroundStyle(ToolrollPalette.ink)
                .onSubmit {
                    submitSteer(taskId: taskId)
                }

            Button("Send") {
                submitSteer(taskId: taskId)
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(steerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(ToolrollPalette.composer, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func submitSteer(taskId: String) {
        let note = steerDraft
        steerDraft = ""
        Task { await store.steerTask(taskId: taskId, note: note) }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("Select a task from the inbox")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Press ⌘K to jump across tasks, promote Candidates, or attach a Live Terminal.")
                .font(.system(size: 12.5))
                .foregroundStyle(ToolrollPalette.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
