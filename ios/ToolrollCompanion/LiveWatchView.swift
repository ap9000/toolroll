import SwiftUI
import ToolrollCompanionCore

/// Watches a running build: the recent window, then `run.watch.subscribe` live.
/// Closing the sheet ends the stream (CANCEL), which stops watching only; the agent keeps running.
struct LiveWatchView: View {
    let appState: CompanionAppState
    let run: Int
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var records: [Entry] = []
    @State private var phase: Phase = .connecting

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

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(ToolrollTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        statusLine
                            .padding(.bottom, 4)
                        ForEach(records) { entry in
                            LiveRecordRow(record: entry.record)
                                .id(entry.id)
                        }
                        Text("Closing only stops watching — the agent keeps running.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                            .padding(.top, 8)
                            .id("end")
                    }
                    .padding(16)
                }
                .background(ToolrollTheme.paper.ignoresSafeArea())
                .onChange(of: records.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
            .navigationTitle("Live output")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Stop watching") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .task { await watch() }
            .discardingLinks()
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            switch phase {
            case .connecting:
                ProgressView().controlSize(.small)
                Text("Connecting…")
            case .watching:
                Circle().fill(ToolrollTheme.info).frame(width: 8, height: 8)
                Text("Watching live")
            case .finished:
                Image(systemName: "checkmark.circle").foregroundStyle(ToolrollTheme.success)
                Text("This run finished")
            case .failed(let message):
                Text(message)
                Button("Try again") { Task { await watch() } }
                    .fontWeight(.semibold)
                    .foregroundStyle(ToolrollTheme.ink)
            }
        }
        .font(.subheadline)
        .foregroundStyle(ToolrollTheme.muted)
        .accessibilityElement(children: .combine)
    }

    private func watch() async {
        phase = .connecting
        do {
            let opened = try await appState.openWatch(run: run)
            records = opened.records.enumerated().map { Entry(id: $0.offset, record: $0.element) }
            phase = .watching
            var nextId = records.count
            for try await record in opened.stream {
                records.append(Entry(id: nextId, record: record))
                nextId += 1
                if records.count > 500 { records.removeFirst(records.count - 500) }
            }
            if !Task.isCancelled { phase = .finished }
        } catch is CancellationError {
            // The sheet closed: watching stopped, the run goes on.
        } catch {
            if !Task.isCancelled { phase = .failed(loadFailureMessage(error)) }
        }
    }
}

private struct LiveRecordRow: View {
    let record: LiveRecord

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .font(.footnote)
                .foregroundStyle(tint)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(record.kind == .step ? .footnote.monospaced() : .subheadline)
                    .foregroundStyle(ToolrollTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let at = RelativeTime.date(record.at) {
                    Text(at, style: .time)
                        .font(.caption2)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var text: String {
        switch record.kind {
        case .say, .you: return (record.text ?? []).joined(separator: "\n")
        case .step: return [record.stepKind, record.target].compactMap { $0 }.joined(separator: " · ")
        case .done:
            switch record.ok {
            case .some(true): return "Step finished"
            case .some(false): return "Step failed"
            case .none: return "Step ended"
            }
        case .open, .start: return "Session started"
        case .cut: return record.dropped.map { "\($0) lines skipped to keep up" } ?? "Some lines were skipped"
        case .cap: return "Output limit reached; later lines aren't shown"
        case .child: return record.desc ?? "A helper agent started"
        case .end: return "A helper agent finished"
        case .over: return "The run finished"
        case .other: return "…"
        }
    }

    private var symbol: String {
        switch record.kind {
        case .say, .you: return "text.bubble"
        case .step: return "terminal"
        case .done: return record.ok == false ? "xmark.circle" : "checkmark.circle"
        case .cut, .cap: return "scissors"
        case .over, .end: return "flag.checkered"
        default: return "circle"
        }
    }

    private var tint: Color {
        switch record.kind {
        case .done: return record.ok == false ? ToolrollTheme.danger : ToolrollTheme.success
        case .step: return ToolrollTheme.info
        default: return ToolrollTheme.muted
        }
    }
}
