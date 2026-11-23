import Foundation
import Testing
@testable import ToolrollCore

/// SB1 (client side): every status a Work row can carry lands in the right sidebar section.
///
/// What the server sends (src/work-index.ts itemOf, src/server/render-pages.ts rowOf, src/task-status.ts workToneOf):
/// - token: `assignment-<state>` with state complete | ready-to-check | cancelled | needs-decision | working, or `archived`
///   (only in `?view=archived`, which the app lists apart).
/// - tone: workToneOf(headline): Needs you → attention, Failed → problem, Building/Planning → live, Ready → ready,
///   Complete → done, Queued/Waiting/Stopped → muted. `neutral` is in WORK_STATUS_TONES but workToneOf never returns it.
/// Sections (WorkbenchStore): .needs → Needs you, .running → Running, .queued → Queued, .finished/.unknown → Settled,
/// .failed → Settled (failed).
@Suite("Work row status → sidebar section")
struct WorkRowStatusTests {
    static let tones = ["attention", "problem", "live", "ready", "done", "muted", "neutral"]
    static let tokens = ["assignment-working", "assignment-needs-decision", "assignment-ready-to-check", "assignment-complete", "assignment-cancelled"]

    struct Case: Sendable, CustomTestStringConvertible {
        let what: String
        let tone: String
        let token: String
        let expected: TaskStatusTone
        var testDescription: String { "\(what): \(tone)/\(token) → \(expected)" }
    }

    /// The rows the server actually produces, and the section the requirement puts each in.
    static let agreed: [Case] = [
        Case(what: "needs you", tone: "attention", token: "assignment-needs-decision", expected: .needs),
        Case(what: "result with an open ask", tone: "attention", token: "assignment-ready-to-check", expected: .needs),
        Case(what: "building / planning", tone: "live", token: "assignment-working", expected: .running),
        Case(what: "queued / waiting / retrying", tone: "muted", token: "assignment-working", expected: .queued),
        Case(what: "on hold / stopped by a person", tone: "muted", token: "assignment-needs-decision", expected: .queued),
        Case(what: "neutral (in the enum, never sent)", tone: "neutral", token: "assignment-working", expected: .queued),
        Case(what: "done (complete)", tone: "done", token: "assignment-complete", expected: .finished),
        Case(what: "failed task", tone: "problem", token: "assignment-needs-decision", expected: .failed),
        Case(what: "result whose checks failed", tone: "problem", token: "assignment-ready-to-check", expected: .failed),
        Case(what: "failed, any other token", tone: "problem", token: "assignment-working", expected: .failed),
    ]

    @Test("Each server row lands in its section", arguments: agreed)
    func mapping(_ c: Case) throws {
        #expect(TaskStatusTone(workTone: c.tone, token: c.token) == c.expected)
        #expect(try Self.decodedStatus(tone: c.tone, token: c.token) == c.expected)
    }

    /// FINDING: the server's cancelled row is `assignment-cancelled` (headline Stopped → tone muted), but the client only
    /// special-cases the bare token "cancelled", so a cancelled task falls through to the tone and lands in Queued.
    @Test("A cancelled row (and a replaced one) lands in Settled")
    func cancelledIsSettled() throws {
        let decoded = try Self.decodedStatus(tone: "muted", token: "assignment-cancelled")
        #expect(TaskStatusTone(workTone: "muted", token: "assignment-cancelled") == .finished)
        #expect(decoded == .finished)
    }

    /// FINDING: a Ready result (code ready-to-check, headline Ready, tone ready) is a person code on the server (rank 0,
    /// listed under Needs you and Ready), but the client maps tone "ready" to Queued. The requirement table doesn't name
    /// Ready; it is asserted here against the server's own view.
    @Test("A Ready result lands where the server lists it (Needs you), not Queued")
    func readyResultIsNotQueued() throws {
        #expect(TaskStatusTone(workTone: "ready", token: "assignment-ready-to-check") == .needs)
    }

    @Test("Every tone × token pair the contract allows lands in some section (never .unknown)")
    func everyPairHasASection() {
        for tone in Self.tones {
            for token in Self.tokens + ["archived", "some-new-token"] {
                #expect(TaskStatusTone(workTone: tone, token: token) != .unknown, "\(tone)/\(token)")
            }
        }
    }

    @Test("The token wins over a shared tone only for an ended task")
    func tokenOverridesTone() {
        // Complete with any tone is finished; a token that names nothing leaves the tone in charge.
        for tone in Self.tones {
            #expect(TaskStatusTone(workTone: tone, token: "assignment-complete") == .finished)
        }
        #expect(TaskStatusTone(workTone: "attention", token: "assignment-working") == .needs)
        #expect(TaskStatusTone(workTone: "live", token: "assignment-needs-decision") == .running)
    }

    @Test("A full /work/rows answer in the server's shape decodes (word object, need null, waiting, group enum)")
    func decodesServerShapedRows() throws {
        let body = """
        {"version":1,"project":null,"projectName":"All projects","needsCount":1,"groups":[],
         "rows":[\(Self.rowJSON(id: "t-1", tone: "attention", token: "assignment-needs-decision", label: "Needs you", group: "decide", rank: 0)),
                 \(Self.rowJSON(id: "t-2", tone: "live", token: "assignment-working", label: "Building", group: "building", rank: 1)),
                 \(Self.rowJSON(id: "t-3", tone: "muted", token: "archived", label: "Archived", group: "rest", rank: 4))],
         "needs":[],"next":null,"room":"workspace","spend":null}
        """
        let rows = try JSONDecoder().decode(WorkRowsResponse.self, from: Data(body.utf8))
        #expect(rows.rows.map(\.id) == ["t-1", "t-2", "t-3"])
        #expect(rows.rows.prefix(2).map(\.status) == [.needs, .running])
        #expect(rows.needsCount == 1)
        #expect(rows.rows[0].word == "Needs you")
        #expect(rows.rows[0].group == "decide")
        #expect(rows.rows[1].need == nil)
    }

    // MARK: helpers

    static func rowJSON(id: String, tone: String, token: String, label: String, group: String, rank: Int) -> String {
        """
        {"id":"\(id)","title":"Task \(id)","href":"/t/\(id)","project":null,"age":"3m",
         "status":{"label":"\(label)","tone":"\(tone)","token":"\(token)"},"word":{"word":"\(label)","tone":""},
         "ask":null,"chip":null,"group":"\(group)","rank":\(rank),"detail":null,"problem":null,"need":null,"waiting":null}
        """
    }

    static func decodedStatus(tone: String, token: String) throws -> TaskStatusTone {
        let row = rowJSON(id: "t-x", tone: tone, token: token, label: "L", group: "rest", rank: 2)
        return try JSONDecoder().decode(WorkRow.self, from: Data(row.utf8)).status
    }
}
