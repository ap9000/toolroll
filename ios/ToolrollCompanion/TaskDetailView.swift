import SwiftUI
import ToolrollCompanionCore

struct TaskDetailView: View {
    let appState: CompanionAppState
    let row: CompanionWorkRow
    @State private var showLiveWatch = false

    private var steps: [CompanionStepCard] { appState.steps(for: row.id) }
    private var approval: CompanionApprovalTerms? { appState.approvalTerms(for: row.id) }
    private var diffFiles: [CompanionDiffFile] { appState.diffFiles(for: row.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        StatusPill(label: row.badgeLabel, tint: row.status == .needsYou ? ToolrollTheme.vermilion : ToolrollTheme.forest)
                        Text(row.project)
                            .font(.caption.monospaced().weight(.medium))
                            .foregroundStyle(ToolrollTheme.muted)
                        Spacer()
                        Text(row.id)
                            .font(.caption2.monospaced())
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                    Text(row.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(ToolrollTheme.ink)
                    Text(row.detail)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                }

                // Read-Only Approval Terms Card (`task.approval.read` — pure read, zero nonce minted)
                if let approval {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label(approval.summary, systemImage: "doc.badge.gearshape")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.ink)
                            Spacer()
                            Text(approval.digest.prefix(8))
                                .font(.caption2.monospaced())
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                        ForEach(approval.lines, id: \.self) { line in
                            Text("• \(line)")
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.ink.opacity(0.88))
                        }
                        HStack(spacing: 8) {
                            Image(systemName: "key.viewfinder")
                                .foregroundStyle(ToolrollTheme.muted)
                            Text("Gate 1 Read-Only Pilot — approve on your Mac today; WebAuthn Passkey approval unlocks in Gate 2.")
                                .font(.caption2)
                                .foregroundStyle(ToolrollTheme.muted)
                        }
                        .padding(.top, 4)
                    }
                    .padding(16)
                    .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(ToolrollTheme.vermilion.opacity(0.35), lineWidth: 1)
                    )
                }

                // Live watch button for running tasks
                if row.status == .running {
                    Button {
                        showLiveWatch = true
                    } label: {
                        HStack {
                            Image(systemName: "waveform.path.ecg")
                            Text("Watch live run output")
                                .fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                        }
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.cobalt)
                        .padding(14)
                        .background(ToolrollTheme.cobalt.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }

                // Step cards
                VStack(alignment: .leading, spacing: 10) {
                    Text("Steps")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.muted)
                        .textCase(.uppercase)

                    ForEach(steps) { step in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Image(systemName: iconForStep(step.state))
                                    .foregroundStyle(colorForStep(step.state))
                                Text(step.label)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(ToolrollTheme.ink)
                                Spacer()
                                if let age = step.age {
                                    Text(age)
                                        .font(.caption2)
                                        .foregroundStyle(ToolrollTheme.muted)
                                }
                            }
                            Text(step.sentence)
                                .font(.footnote)
                                .foregroundStyle(ToolrollTheme.ink.opacity(0.85))
                            if let agent = step.agentLabel {
                                HStack {
                                    Text(agent)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(ToolrollTheme.muted)
                                    if let cost = step.costUsd {
                                        Text(String(format: "· $%.2f", cost))
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(ToolrollTheme.muted)
                                    }
                                }
                            }
                        }
                        .padding(14)
                        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(ToolrollTheme.hairline, lineWidth: 1)
                        )
                    }
                }

                // Paginated Diff Files
                if !diffFiles.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Changed Files")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.muted)
                            .textCase(.uppercase)

                        VStack(spacing: 0) {
                            ForEach(Array(diffFiles.enumerated()), id: \.element.id) { index, file in
                                NavigationLink {
                                    DiffFileDetailView(file: file)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: "doc.plaintext")
                                            .font(.caption)
                                            .foregroundStyle(ToolrollTheme.muted)
                                        Text(file.path)
                                            .font(.caption.monospaced())
                                            .foregroundStyle(ToolrollTheme.ink)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        Spacer()
                                        HStack(spacing: 4) {
                                            Text("+\(file.added)").foregroundStyle(ToolrollTheme.forest)
                                            Text("-\(file.removed)").foregroundStyle(ToolrollTheme.vermilion)
                                        }
                                        .font(.caption2.monospacedDigit().weight(.semibold))
                                        Image(systemName: "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(ToolrollTheme.muted)
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                                }
                                .buttonStyle(.plain)
                                if index < diffFiles.count - 1 {
                                    Divider().padding(.leading, 36)
                                }
                            }
                        }
                        .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(ToolrollTheme.hairline, lineWidth: 1)
                        )
                    }
                }
            }
            .padding(16)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showLiveWatch) {
            LiveRunWatchSheet(records: appState.liveRecords(for: row.id), taskTitle: row.title)
        }
    }

    private func iconForStep(_ state: String) -> String {
        switch state {
        case "done": return "checkmark.circle.fill"
        case "needs_you": return "exclamationmark.circle.fill"
        case "running": return "arrow.triangle.2.circlepath.circle.fill"
        default: return "circle.dashed"
        }
    }

    private func colorForStep(_ state: String) -> Color {
        switch state {
        case "done": return ToolrollTheme.forest
        case "needs_you": return ToolrollTheme.vermilion
        case "running": return ToolrollTheme.cobalt
        default: return ToolrollTheme.muted
        }
    }
}

struct DiffFileDetailView: View {
    let file: CompanionDiffFile

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(file.lines) { line in
                    HStack(spacing: 8) {
                        Text(line.oldLine.map(String.init) ?? "")
                            .frame(width: 28, alignment: .trailing)
                            .foregroundStyle(ToolrollTheme.muted.opacity(0.7))
                        Text(line.newLine.map(String.init) ?? "")
                            .frame(width: 28, alignment: .trailing)
                            .foregroundStyle(ToolrollTheme.muted.opacity(0.7))
                        Text(prefixFor(line.kind) + line.text)
                            .foregroundStyle(textColorFor(line.kind))
                        Spacer(minLength: 24)
                    }
                    .font(.system(size: 12, design: .monospaced))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(bgFor(line.kind))
                }
            }
            .frame(minWidth: UIScreen.main.bounds.width, alignment: .leading)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func prefixFor(_ kind: CompanionDiffLine.Kind) -> String {
        switch kind {
        case .addition: return "+"
        case .deletion: return "-"
        case .context: return " "
        case .header: return ""
        }
    }

    private func textColorFor(_ kind: CompanionDiffLine.Kind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.forest
        case .deletion: return ToolrollTheme.vermilion
        case .header: return ToolrollTheme.cobalt
        case .context: return ToolrollTheme.ink
        }
    }

    private func bgFor(_ kind: CompanionDiffLine.Kind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.forest.opacity(0.10)
        case .deletion: return ToolrollTheme.vermilion.opacity(0.10)
        case .header: return ToolrollTheme.cobalt.opacity(0.08)
        case .context: return .clear
        }
    }
}

private struct LiveRunWatchSheet: View {
    let records: [CompanionLiveRecord]
    let taskTitle: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(records) { rec in
                        HStack(alignment: .top, spacing: 8) {
                            Text(rec.timestamp)
                                .font(.caption2.monospaced())
                                .foregroundStyle(ToolrollTheme.muted)
                            Text(rec.text)
                                .font(.caption.monospaced())
                                .foregroundStyle(rec.kind == "tool" ? ToolrollTheme.cobalt : ToolrollTheme.ink)
                        }
                    }
                } header: {
                    Text(taskTitle)
                } footer: {
                    Text("Closing this view stops watching only (`CANCEL`) — it never stops the running build on your Mac.")
                }
            }
            .navigationTitle("Live Output")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Stop Watching") { dismiss() }
                }
            }
        }
    }
}
