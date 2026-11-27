import Foundation

/// Where the app's Work, task, diff and live data come from. Demo and live share the Engine API shapes,
/// so every screen has one decode path and one rendering path.
public protocol CompanionDataSource: Sendable {
    func workRows(view: WorkView, cursor: String?) async throws -> WorkRows
    func taskSteps(task: String) async throws -> StepCards
    /// The result's changed files (`run` nil: the task's current result).
    func taskDiff(task: String, run: Int?) async throws -> ResultDiff
    /// One file's hunks; `file` is the entry's index from `ResultDiff.files`.
    func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile
    func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow
    /// Live records as they happen. Ending the stream stops watching only; the run keeps going.
    func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error>
}

// MARK: - Live (RPCs over the relay)

public struct LiveCompanionSource: CompanionDataSource {
    private let client: CompanionRelayClient

    public init(client: CompanionRelayClient) {
        self.client = client
    }

    private struct WorkParams: Encodable, Sendable {
        let view: String
        let cursor: String?
    }

    private struct TaskParams: Encodable, Sendable {
        let task: String
    }

    private struct DiffParams: Encodable, Sendable {
        let task: String
        let run: String?
    }

    private struct DiffFileParams: Encodable, Sendable {
        let task: String
        let run: String
        let file: Int
    }

    private struct RunParams: Encodable, Sendable {
        let run: String
        let cursor: String?
    }

    public func workRows(view: WorkView, cursor: String?) async throws -> WorkRows {
        try await client.call("work.rows", params: WorkParams(view: view.rawValue, cursor: cursor))
    }

    public func taskSteps(task: String) async throws -> StepCards {
        try await client.call("task.steps", params: TaskParams(task: task))
    }

    public func taskDiff(task: String, run: Int?) async throws -> ResultDiff {
        try await client.call("task.diff", params: DiffParams(task: task, run: run.map(String.init)))
    }

    public func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile {
        try await client.call("task.diff", params: DiffFileParams(task: task, run: String(run), file: file))
    }

    public func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow {
        try await client.call("run.window.read", params: RunParams(run: String(run), cursor: cursor))
    }

    public func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error> {
        let raw = try await client.watch(method: "run.watch.subscribe", params: RunParams(run: String(run), cursor: cursor))
        return Self.decodeRecords(raw)
    }

    /// Maps a stream of CHUNK payloads to live records. A record this build can't read is skipped, never fatal.
    /// Pulled on demand (nothing reads ahead of the consumer), so the watch's credit tracks what's actually been
    /// taken. Dropping the returned stream drops the inner one, which sends CANCEL.
    static func decodeRecords(_ raw: AsyncThrowingStream<Data, Error>) -> AsyncThrowingStream<LiveRecord, Error> {
        let pull = RecordPull(raw)
        return AsyncThrowingStream { try await pull.next() }
    }
}

/// One consumer's pull through a watch's payloads, decoding as it goes.
private final class RecordPull: @unchecked Sendable {
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator
    private let decoder = JSONDecoder()

    init(_ raw: AsyncThrowingStream<Data, Error>) {
        iterator = raw.makeAsyncIterator()
    }

    func next() async throws -> LiveRecord? {
        while let payload = try await iterator.next() {
            if let record = try? decoder.decode(LiveRecord.self, from: payload) { return record }
        }
        return nil
    }
}

// MARK: - Demo (zero network)

/// The built-in demo workspace: fixed fixtures in the Engine API shapes, a simulated live watch.
public struct DemoCompanionSource: CompanionDataSource {
    /// Simulated latency, so loading states are real in the demo too.
    private let latency: Duration
    private let recordInterval: Duration

    public init(latency: Duration = .milliseconds(150), recordInterval: Duration = .milliseconds(1400)) {
        self.latency = latency
        self.recordInterval = recordInterval
    }

    public func workRows(view: WorkView, cursor: String?) async throws -> WorkRows {
        try await Task.sleep(for: latency)
        let all = try CompanionDemoFixtures.workRows()
        let rows: [WorkRow]
        switch view {
        case .all: rows = all.rows
        case .needsYou: rows = all.rows.filter { $0.rank == 0 }
        case .running: rows = all.rows.filter { $0.group == .building }
        case .completed: rows = all.rows.filter { $0.rank == 3 }
        }
        return WorkRows(
            version: all.version, project: all.project, projectName: all.projectName, needsCount: all.needsCount,
            groups: nil, rows: rows, needs: all.needs, next: nil, room: all.room
        )
    }

    public func taskSteps(task: String) async throws -> StepCards {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.steps(task: task)
    }

    public func taskDiff(task: String, run: Int?) async throws -> ResultDiff {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.diff(task: task)
    }

    public func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.diffFile(task: task, file: file)
    }

    public func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow {
        try await Task.sleep(for: latency)
        let window = try CompanionDemoFixtures.liveWindow(run: run)
        // Rebase the sample records onto the last couple of minutes, so they read as live.
        let records = window.window.records ?? []
        let formatter = ISO8601DateFormatter()
        let now = Date()
        let rebased = records.enumerated().map { index, record in
            LiveRecord(
                kind: record.kind, at: formatter.string(from: now.addingTimeInterval(Double(index - records.count) * 20)),
                text: record.text, stepId: record.stepId, stepKind: record.stepKind, target: record.target,
                ok: record.ok, out: record.out, stream: record.stream, detail: record.detail, desc: record.desc,
                dropped: record.dropped
            )
        }
        let w = window.window
        return LiveSessionWindow(
            version: window.version, session: window.session, room: window.room, live: window.live, file: window.file,
            window: LiveWindow(
                ok: w.ok, records: rebased, cursor: w.cursor, restarted: w.restarted, earlier: w.earlier,
                quarantined: w.quarantined, skipped: w.skipped, more: w.more, reason: w.reason
            )
        )
    }

    public func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error> {
        let script = CompanionDemoFixtures.liveScript
        let interval = recordInterval
        let (stream, continuation) = AsyncThrowingStream<LiveRecord, Error>.makeStream()
        let task = Task {
            var index = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                if Task.isCancelled { break }
                let now = ISO8601DateFormatter().string(from: Date())
                let next = script[index % script.count]
                continuation.yield(LiveRecord(
                    kind: next.kind, at: now, text: next.text, stepId: next.stepId, stepKind: next.stepKind,
                    target: next.target, ok: next.ok
                ))
                index += 1
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}
