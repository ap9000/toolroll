import SwiftUI
import ToolrollCompanionCore

/// What a Work row is, in the phone's words. One mapping for every screen, so a state keeps its word and colour.
enum RowKind: Equatable {
    case decide
    case review
    case unblock
    case running
    case queued
    case done
    case failed
    case stopped(String)

    init(row: WorkRow) {
        if row.rank == 0 || row.need != nil {
            switch row.group {
            case .decide: self = .decide
            case .review: self = .review
            case .unblock: self = .unblock
            default:
                switch row.need?.group {
                case .review: self = .review
                case .unblock: self = .unblock
                default: self = .decide
                }
            }
            return
        }
        if row.group == .building || row.status.tone == .live {
            self = .running
        } else if row.word.tone == .failed || row.status.tone == .problem {
            self = .failed
        } else if row.rank == 3 || row.status.tone == .done {
            self = .done
        } else if row.rank == 2 {
            self = .queued
        } else {
            self = .stopped(row.status.label)
        }
    }

    var isNeedsYou: Bool {
        switch self {
        case .decide, .review, .unblock: return true
        default: return false
        }
    }

    var tone: StateTone {
        switch self {
        case .decide, .review, .unblock: return .needs
        case .running: return .live
        case .done: return .done
        case .failed: return .failed
        case .queued, .stopped: return .neutral
        }
    }

    func word(for row: WorkRow? = nil) -> String {
        switch self {
        case .decide: return row?.need?.ask == .answer ? "Answer" : "Decide"
        case .review: return "Review"
        case .unblock: return "Unblock"
        case .running: return "Running"
        case .queued: return row?.waiting != nil ? "Retrying" : "Queued"
        case .done: return "Done"
        case .failed: return "Failed"
        case .stopped(let label): return label
        }
    }
}

extension WorkRow {
    var kind: RowKind { RowKind(row: self) }

    /// The one line that says what the row asks or where it stands.
    var askLine: String? {
        need?.line ?? need?.reason ?? problem ?? detail
    }

    /// The one check result a row shows, with its tone.
    var checkLine: (text: String, tone: StateTone, symbol: String)? {
        switch check {
        case .failed: return ("Checks failed after it was accepted", .failed, "xmark.circle")
        case .stale: return ("Checks are out of date", .neutral, "clock.arrow.circlepath")
        case .unreadable: return ("Checks couldn't be read", .neutral, "questionmark.circle")
        case .other, .none: break
        }
        if let landed { return (landed, .done, "checkmark.circle") }
        if let failure = waiting?.lastFailure { return ("Last try: \(failure)", .neutral, "arrow.clockwise") }
        return nil
    }
}

/// The one next step a task screen offers.
enum NextStep: Equatable {
    case approveOnMac
    case answerOnMac
    case reviewChanges
    case watchLive(run: Int)
    case viewChanges
    case unblockOnMac
    case none

    init(row: WorkRow?, steps: StepCards?, diff: ResultDiff?) {
        let kind = row?.kind
        let hasFiles = !(diff?.files.isEmpty ?? true)
        if steps?.waitingTerms != nil || steps?.cards?.contains(where: { $0.key == .approve && $0.needsYou }) == true {
            self = .approveOnMac
        } else if kind == .decide && row?.need?.ask == .answer {
            self = .answerOnMac
        } else if kind == .decide {
            self = .approveOnMac
        } else if steps?.review != nil || kind == .review
                    || steps?.cards?.contains(where: { $0.key == .ready && $0.needsYou }) == true {
            self = .reviewChanges
        } else if let run = steps?.liveRun {
            self = .watchLive(run: run)
        } else if kind == .unblock || kind == .failed || steps?.failure != nil {
            self = .unblockOnMac
        } else if hasFiles {
            self = .viewChanges
        } else {
            self = .none
        }
    }

    /// Answered on the Mac (approve, answer, unblock).
    var isOnMac: Bool {
        switch self {
        case .approveOnMac, .answerOnMac, .unblockOnMac: return true
        default: return false
        }
    }

    /// The state word when the task's Work row isn't loaded (opened from a link).
    var chip: (word: String, tone: StateTone)? {
        switch self {
        case .approveOnMac, .answerOnMac: return ("Decide", .needs)
        case .reviewChanges: return ("Review", .needs)
        case .watchLive: return ("Running", .live)
        case .viewChanges: return ("Done", .done)
        case .unblockOnMac: return ("Unblock", .needs)
        case .none: return nil
        }
    }

    /// The ask in plain words: what the header leads with.
    var headline: String {
        switch self {
        case .approveOnMac: return "Waiting for your approval"
        case .answerOnMac: return "Waiting for your answer"
        case .reviewChanges: return "Waiting for your review"
        case .watchLive: return "An agent is working on it"
        case .viewChanges: return "Done"
        case .unblockOnMac: return "This task is stuck"
        case .none: return "Nothing needs you"
        }
    }
}

/// User-facing words for a failed load (the copy lives in Core, where every code is tested).
func loadFailureMessage(_ error: Error) -> String {
    if error is OfflineError { return "Can't reach your Mac." }
    return CompanionCopy.loadFailure(error)
}

struct OfflineError: Error {}
