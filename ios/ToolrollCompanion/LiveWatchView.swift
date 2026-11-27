import SwiftUI
import ToolrollCompanionCore

/// Watches a running build: the recent window, then `run.watch.subscribe` live.
/// Closing the sheet ends the stream (CANCEL), which stops watching only; the agent keeps running.
/// Going to the background closes the connection; coming back starts the watch again from the run's latest window.
struct LiveWatchView: View {
    let appState: CompanionAppState
    let run: Int
    let title: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var records: [Entry] = []
    @State private var phase: Phase = .connecting
    /// Bumped to (re)start the watch: Try again, the app coming back, a reconnect.
    @State private var watchGeneration = 0
    @State private var nextId = 0
    /// The end of the list is on screen: new records scroll into view. Scrolled up, they wait behind a pill.
    @State private var atBottom = true
    @State private var hasUnseen = false
    /// The scene really went to the background (not just Notification Center or a system alert): only then was the
    /// socket closed and the watch needs restarting (C4).
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
                            if entry.record.kind != .other {
                                LiveRecordRow(record: entry.record)
                                    .id(entry.id)
                            }
                        }
                        Text("Closing only stops watching — the agent keeps running.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
                            .padding(.top, 8)
                            .id("end")
                            .onAppear {
                                atBottom = true
                                hasUnseen = false
                            }
                            .onDisappear { atBottom = false }
                    }
                    .padding(16)
                }
                .background(ToolrollTheme.paper.ignoresSafeArea())
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
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.onInk)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 44)
                                .background(ToolrollTheme.ink, in: Capsule())
                        }
                        .padding(.bottom, 12)
                        .transition(.opacity)
                    }
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
            .task(id: watchGeneration) { await watch() }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .background:
                    wasBackgrounded = true
                case .active:
                    // Back from the background: the socket was closed there, so watch again. A trip through
                    // .inactive alone leaves a healthy watch alone.
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
    }

    @ViewBuilder
    private var statusLine: some View {
        HStack(spacing: 8) {
            switch phase {
            case .connecting:
                ProgressView().controlSize(.small)
                Text("Connecting…")
            case .watching:
                Image(systemName: "circle.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(ToolrollTheme.info)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .accessibilityHidden(true)
                Text("Watching live")
            case .finished:
                Image(systemName: "checkmark.circle").foregroundStyle(ToolrollTheme.success)
                Text("This run finished")
            case .failed(let message):
                Text(message)
                Button("Try again") { watchGeneration += 1 }
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
            // A fresh window replaces what was shown (it is the run's latest), so a restart never repeats records.
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
            // The sheet closed or the watch restarted: watching stopped, the run goes on.
        } catch {
            guard !Task.isCancelled else { return }
            if scenePhase != .active || !appState.isActive {
                // Closed because the app left the foreground: quiet. Coming back restarts the watch.
                phase = .connecting
            } else {
                phase = .failed(loadFailureMessage(error))
            }
        }
    }

    /// VoiceOver hears the moments that matter, not every line (U20).
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
        case .other: return ""
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
