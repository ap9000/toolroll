import SwiftUI
import ToolrollCompanionCore

/// Watches a running build in a dedicated dark terminal sheet: paired command/output blocks,
/// deduplicated timestamps, and a live pulse indicator.
/// Closing the sheet ends the stream (CANCEL), which stops watching only; the agent keeps running.
struct LiveWatchView: View {
    let appState: CompanionAppState
    let run: Int
    let title: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var records: [Entry] = []
    @State private var phase: Phase = .connecting
    @State private var watchGeneration = 0
    @State private var nextId = 0
    @State private var atBottom = true
    @State private var hasUnseen = false
    @State private var wasBackgrounded = false

    struct Entry: Identifiable {
        let id: Int
        let record: LiveRecord
    }

    enum Phase: Equatable {
        case connecting
        case watching
        case finished
        case failed(String)
    }

    private static let keep = 500

    /// Groups consecutive step + output + done records into crisp terminal blocks, and deduplicates minute stamps.
    private var blocks: [DisplayBlock] {
        var result: [DisplayBlock] = []
        var activeStep: CommandBlock?
        var lastMinute: String?

        func flushStep() {
            if let step = activeStep {
                result.append(.command(step))
                activeStep = nil
            }
        }

        func minuteStamp(for iso: String?) -> String? {
            guard let date = RelativeTime.date(iso) else { return nil }
            let formatted = date.formatted(date: .omitted, time: .shortened)
            if formatted == lastMinute { return nil }
            lastMinute = formatted
            return formatted
        }

        for entry in records where entry.record.kind != .other {
            let rec = entry.record
            switch rec.kind {
            case .step:
                flushStep()
                if let stamp = minuteStamp(for: rec.at) {
                    result.append(.timestamp(id: "ts-\(entry.id)", label: stamp))
                }
                activeStep = CommandBlock(
                    id: entry.id,
                    kind: rec.stepKind ?? "step",
                    target: rec.target ?? "",
                    lines: [],
                    status: .running
                )
            case .say where activeStep != nil:
                let lines = (rec.text ?? []).filter { !$0.isEmpty }
                activeStep?.lines.append(contentsOf: lines)
            case .done:
                if var step = activeStep {
                    step.status = rec.ok == false ? .failed : .passed
                    result.append(.command(step))
                    activeStep = nil
                } else {
                    if let stamp = minuteStamp(for: rec.at) {
                        result.append(.timestamp(id: "ts-\(entry.id)", label: stamp))
                    }
                    result.append(.note(NoteBlock(
                        id: entry.id,
                        text: rec.ok == false ? "Step failed" : "Step finished",
                        tone: rec.ok == false ? .failed : .done
                    )))
                }
            default:
                flushStep()
                if let stamp = minuteStamp(for: rec.at) {
                    result.append(.timestamp(id: "ts-\(entry.id)", label: stamp))
                }
                let text = noteText(for: rec)
                if !text.isEmpty {
                    result.append(.note(NoteBlock(id: entry.id, text: text, tone: noteTone(for: rec))))
                }
            }
        }
        flushStep()
        return result
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                streamSubheader
                Divider().overlay(ToolrollTheme.terminalBorder)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(blocks) { block in
                                switch block {
                                case .timestamp(_, let label):
                                    Text(label)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(ToolrollTheme.terminalMuted)
                                        .padding(.top, 4)
                                case .command(let cmd):
                                    TerminalCommandCard(block: cmd)
                                case .note(let note):
                                    TerminalNoteRow(note: note)
                                }
                            }
                            Text("Closing stops watching only. The agent keeps running on your Mac.")
                                .font(.caption)
                                .foregroundStyle(ToolrollTheme.terminalMuted)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 10)
                                .id("end")
                                .onAppear {
                                    atBottom = true
                                    hasUnseen = false
                                }
                                .onDisappear { atBottom = false }
                        }
                        .padding(16)
                    }
                    .background(ToolrollTheme.terminalBg)
                    .onChange(of: records.last?.id) { _, _ in
                        if atBottom {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
                        } else {
                            hasUnseen = true
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if hasUnseen && !atBottom {
                            Button {
                                hasUnseen = false
                                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy.scrollTo("end", anchor: .bottom) }
                            } label: {
                                Label("Jump to latest", systemImage: "arrow.down")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Color.black)
                                    .padding(.horizontal, 14)
                                    .frame(minHeight: 38)
                                    .background(ToolrollTheme.terminalInk, in: Capsule())
                            }
                            .padding(.bottom, 12)
                            .transition(.opacity)
                        }
                    }
                }
            }
            .background(ToolrollTheme.terminalBg.ignoresSafeArea())
            .navigationTitle("Live output")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(ToolrollTheme.terminalBg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .foregroundStyle(ToolrollTheme.terminalInk)
                }
            }
            .task(id: watchGeneration) { await watch() }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .background:
                    wasBackgrounded = true
                case .active:
                    if wasBackgrounded, phase != .finished { watchGeneration += 1 }
                    wasBackgrounded = false
                default:
                    break
                }
            }
            .onChange(of: appState.refreshTick) { _, _ in
                if phase != .watching, phase != .finished { watchGeneration += 1 }
            }
            .discardingLinks()
        }
        .preferredColorScheme(.dark)
    }

    private var streamSubheader: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.terminalInk)
                .lineLimit(2)
            HStack(spacing: 6) {
                switch phase {
                case .connecting:
                    ProgressView().controlSize(.mini)
                    Text("Connecting to run #\(run)…")
                case .watching:
                    LivePulseBars(color: ToolrollTheme.terminalBlue, height: 10, animate: true)
                    Text("Streaming run #\(run)")
                        .foregroundStyle(ToolrollTheme.terminalBlue)
                case .finished:
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(ToolrollTheme.terminalGreen)
                    Text("Run #\(run) finished")
                        .foregroundStyle(ToolrollTheme.terminalGreen)
                case .failed(let message):
                    Text(message)
                        .foregroundStyle(ToolrollTheme.terminalRed)
                    Spacer()
                    Button("Retry") { watchGeneration += 1 }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.terminalInk)
                }
            }
            .font(.caption.monospaced())
            .foregroundStyle(ToolrollTheme.terminalMuted)
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollTheme.terminalSurface)
    }

    private func noteText(for record: LiveRecord) -> String {
        switch record.kind {
        case .say, .you: return (record.text ?? []).joined(separator: "\n")
        case .open, .start: return "Session started"
        case .cut: return record.dropped.map { "\($0) lines skipped to keep up" } ?? "Some lines were skipped"
        case .cap: return "Output limit reached; later lines aren't shown"
        case .child: return record.desc ?? "A helper agent started"
        case .end: return "A helper agent finished"
        case .over: return "The run finished"
        default: return ""
        }
    }

    private func noteTone(for record: LiveRecord) -> NoteTone {
        switch record.kind {
        case .over, .end: return .done
        case .cut, .cap: return .muted
        default: return .plain
        }
    }

    private func watch() async {
        phase = .connecting
        do {
            let opened = try await appState.openWatch(run: run)
            records = opened.records.map(makeEntry)
            phase = .watching
            for try await record in opened.stream {
                records.append(makeEntry(record))
                if records.count > Self.keep { records.removeFirst(records.count - Self.keep) }
                announce(record)
            }
            if !Task.isCancelled {
                phase = .finished
                AccessibilityNotification.Announcement("This run finished").post()
            }
        } catch is CancellationError {
            // Watching stopped; the run continues on the Mac.
        } catch {
            guard !Task.isCancelled else { return }
            if scenePhase != .active || !appState.isActive {
                phase = .connecting
            } else {
                phase = .failed(loadFailureMessage(error))
            }
        }
    }

    private func announce(_ record: LiveRecord) {
        let words: String?
        switch record.kind {
        case .done where record.ok == false: words = "A step failed"
        case .over: words = "The run finished"
        case .child: words = "A helper agent started"
        default: words = nil
        }
        if let words { AccessibilityNotification.Announcement(words).post() }
    }

    private func makeEntry(_ record: LiveRecord) -> Entry {
        defer { nextId += 1 }
        return Entry(id: nextId, record: record)
    }
}

private enum DisplayBlock: Identifiable {
    case timestamp(id: String, label: String)
    case command(CommandBlock)
    case note(NoteBlock)

    var id: String {
        switch self {
        case .timestamp(let id, _): return id
        case .command(let cmd): return "cmd-\(cmd.id)"
        case .note(let note): return "note-\(note.id)"
        }
    }
}

private struct CommandBlock {
    let id: Int
    let kind: String
    let target: String
    var lines: [String]
    var status: Status

    enum Status { case running, passed, failed }
}

private enum NoteTone { case plain, done, failed, muted }

private struct NoteBlock {
    let id: Int
    let text: String
    let tone: NoteTone
}

/// Paired terminal block: `$ command` or `edit file` header, muted output lines, and status indicator.
private struct TerminalCommandCard: View {
    let block: CommandBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(prefix)
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(ToolrollTheme.terminalBlue)
                Text(block.target.isEmpty ? block.kind : block.target)
                    .font(.caption.monospaced().weight(.medium))
                    .foregroundStyle(ToolrollTheme.terminalInk)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                statusBadge
            }

            if !block.lines.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(block.lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.caption.monospaced())
                            .foregroundStyle(ToolrollTheme.terminalMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollTheme.terminalSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(ToolrollTheme.terminalBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var prefix: String {
        switch block.kind.lowercased() {
        case "command", "shell", "bash": return "$"
        default: return block.kind
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch block.status {
        case .running:
            ProgressView().controlSize(.mini)
        case .passed:
            Image(systemName: "checkmark")
                .font(.caption2.weight(.bold))
                .foregroundStyle(ToolrollTheme.terminalGreen)
        case .failed:
            Image(systemName: "xmark")
                .font(.caption2.weight(.bold))
                .foregroundStyle(ToolrollTheme.terminalRed)
        }
    }
}

private struct TerminalNoteRow: View {
    let note: NoteBlock

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if note.tone == .done {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.terminalGreen)
            } else if note.tone == .failed {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.terminalRed)
            }
            Text(note.text)
                .font(.subheadline)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch note.tone {
        case .done: return ToolrollTheme.terminalGreen
        case .failed: return ToolrollTheme.terminalRed
        case .muted: return ToolrollTheme.terminalMuted
        case .plain: return ToolrollTheme.terminalInk
        }
    }
}
