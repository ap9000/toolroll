import Foundation

public enum LiveStepStatus: String, Sendable, Equatable {
    case running
    case succeeded
    case failed
    case completed
}

public enum LiveActivityItem: Identifiable, Sendable, Equatable {
    case message(id: String, text: String)
    case step(id: String, kind: String, summary: String, status: LiveStepStatus, outputPreview: [String])
    case hiddenSteps(id: String, kind: String, count: Int, failedCount: Int, runningCount: Int)
    case output(id: String, ok: Bool, lines: [String])

    public var id: String {
        switch self {
        case .message(let id, _): return id
        case .step(let id, _, _, _, _): return id
        case .hiddenSteps(let id, _, _, _, _): return id
        case .output(let id, _, _): return id
        }
    }

    public static func hiddenStepLabel(kind: String, count: Int, failedCount: Int, runningCount: Int) -> String {
        let base: String
        if kind == "command" {
            if runningCount > 0 {
                let finished = max(0, count - runningCount)
                if finished == 0 {
                    base = runningCount == 1 ? "Running shell command…" : "Running \(runningCount) shell commands…"
                } else {
                    let noun = finished == 1 ? "command" : "commands"
                    base = "Ran \(finished) shell \(noun), running \(runningCount)…"
                }
            } else {
                base = count == 1 ? "Ran 1 shell command" : "Ran \(count) shell commands"
            }
        } else {
            if runningCount > 0 {
                base = count == 1 ? "Running \(kind)…" : "\(count) \(kind) steps (running)…"
            } else {
                base = count == 1 ? "1 \(kind) step" : "\(count) \(kind) steps"
            }
        }
        if failedCount > 0 {
            return "\(base) · \(failedCount) failed"
        }
        return base
    }
}

public struct LiveActivityTimeline: Sendable, Equatable {
    public let items: [LiveActivityItem]
    public let hasHiddenCommands: Bool

    public init(items: [LiveActivityItem], hasHiddenCommands: Bool) {
        self.items = items
        self.hasHiddenCommands = hasHiddenCommands
    }

    public static func build(from records: [LiveAgentRecord], isLive: Bool = false) -> LiveActivityTimeline {
        var doneByStepId: [String: LiveAgentRecord] = [:]
        var runEnded = false
        for rec in records {
            if rec.k == "end" || rec.k == "over" {
                runEnded = true
            } else if rec.k == "done", let sid = rec.stepId, !sid.isEmpty {
                doneByStepId[sid] = rec
            }
        }

        let runActive = isLive && !runEnded
        var items: [LiveActivityItem] = []
        var consumedDoneIds: Set<String> = []
        var hasHiddenCommands = false

        struct PendingHidden {
            let id: String
            let kind: String
            var count: Int
            var failedCount: Int
            var runningCount: Int
        }
        var pending: PendingHidden?

        func flushPending() {
            guard let p = pending else { return }
            items.append(.hiddenSteps(
                id: p.id,
                kind: p.kind,
                count: p.count,
                failedCount: p.failedCount,
                runningCount: p.runningCount
            ))
            pending = nil
        }

        for (idx, rec) in records.enumerated() {
            switch rec.k {
            case "open":
                if rec.detail?.lowercased() == "base" {
                    continue
                }
            case "say":
                let text = rec.textLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                flushPending()
                items.append(.message(id: "msg-\(idx)-\(rec.id.uuidString)", text: text))

            case "step":
                let rawKind = (rec.kind ?? "tool").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let kind = rawKind.isEmpty ? "tool" : rawKind
                let summary = [rec.target, rec.detail, rec.desc]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .first(where: { !$0.isEmpty }) ?? ""

                let doneRec: LiveAgentRecord?
                if let sid = rec.stepId, !sid.isEmpty, let matched = doneByStepId[sid] {
                    doneRec = matched
                    consumedDoneIds.insert(sid)
                } else {
                    doneRec = nil
                }

                let status: LiveStepStatus
                if let doneRec {
                    status = (doneRec.ok == false) ? .failed : .succeeded
                } else {
                    status = runActive ? .running : .completed
                }

                if !summary.isEmpty {
                    flushPending()
                    let preview = (doneRec?.out ?? [])
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    items.append(.step(
                        id: "step-\(rec.stepId ?? "\(idx)")-\(rec.id.uuidString)",
                        kind: kind,
                        summary: summary,
                        status: status,
                        outputPreview: Array(preview.prefix(2))
                    ))
                } else {
                    if kind == "command" {
                        hasHiddenCommands = true
                    }
                    if var current = pending, current.kind == kind {
                        current.count += 1
                        if status == .failed { current.failedCount += 1 }
                        if status == .running { current.runningCount += 1 }
                        pending = current
                    } else {
                        flushPending()
                        pending = PendingHidden(
                            id: "hidden-\(kind)-\(idx)-\(rec.id.uuidString)",
                            kind: kind,
                            count: 1,
                            failedCount: status == .failed ? 1 : 0,
                            runningCount: status == .running ? 1 : 0
                        )
                    }
                }

            case "done":
                if let sid = rec.stepId, consumedDoneIds.contains(sid) {
                    continue
                }
                let lines = rec.out
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                guard !lines.isEmpty else { continue }
                flushPending()
                items.append(.output(
                    id: "out-\(rec.stepId ?? "\(idx)")-\(rec.id.uuidString)",
                    ok: rec.ok != false,
                    lines: Array(lines.prefix(2))
                ))

            default:
                continue
            }
        }

        flushPending()
        return LiveActivityTimeline(items: items, hasHiddenCommands: hasHiddenCommands)
    }
}
