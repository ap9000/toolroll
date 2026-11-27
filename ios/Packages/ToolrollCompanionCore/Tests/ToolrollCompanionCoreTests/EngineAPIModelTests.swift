import Foundation
import Testing
@testable import ToolrollCompanionCore

private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

private func decode<T: Decodable>(_ name: String, as: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: try fixture(name))
}

@Test("work-rows.json decodes: rows, needs, groups, next cursor")
func decodesWorkRows() throws {
    let rows = try decode("work-rows", as: WorkRows.self)
    #expect(rows.version == 1)
    #expect(rows.needsCount == 1)
    #expect(rows.rows.count == 3)
    #expect(rows.next == nil)
    let first = try #require(rows.rows.first)
    #expect(first.group == .review)
    #expect(first.status.tone == .attention)
    #expect(first.word.tone == .ask)
    #expect(first.need?.ask == .review)
    #expect(first.need?.action?.label == "Open result")
    #expect(rows.rows[1].group == .building)
    #expect(rows.needs.first?.key == .review)
}

@Test("work-rows-every-kind.json decodes every row kind, including empty word tones and waiting")
func decodesEveryKindOfWorkRow() throws {
    let rows = try decode("work-rows-every-kind", as: WorkRows.self)
    #expect(rows.rows.map(\.rank) == [0, 2, 2, 3, 4])
    #expect(rows.rows[0].word.tone == .failed)
    #expect(rows.rows[0].group == .unblock)
    #expect(rows.rows[1].word.tone == WorkWordTone.none)
    #expect(rows.rows[1].waiting?.attempt == "build")
    #expect(rows.rows[2].status.label == "Queued")
    #expect(rows.rows[3].status.tone == .done)
}

@Test("Every step-cards fixture decodes", arguments: [
    "step-cards-just-code", "step-cards-plan-first", "step-cards-plan-stopped", "step-cards-sent-back",
])
func decodesStepCards(name: String) throws {
    let steps = try decode(name, as: StepCards.self)
    #expect(steps.version == 1)
    #expect(steps.cards?.isEmpty == false)
}

@Test("A waiting approval's terms come from the Approval card")
func approvalTermsFromStepCards() throws {
    let steps = try decode("step-cards-sent-back", as: StepCards.self)
    let terms = try #require(steps.waitingTerms)
    #expect(terms.rows.first?.label == "Goal")
    #expect(terms.usualLabel == "Your usual project settings")
    #expect(steps.cards?.first(where: { $0.key == .approve })?.needsYou == true)

    let justCode = try decode("step-cards-just-code", as: StepCards.self)
    #expect(justCode.waitingTerms == nil)
    #expect(justCode.review?.run == 2)
    #expect(justCode.chain == .justCode)

    let stopped = try decode("step-cards-plan-stopped", as: StepCards.self)
    #expect(stopped.planStopped?.problems?.count == 2)
}

@Test("Result diff fixtures decode: file list, no result, one file's hunks")
func decodesResultDiff() throws {
    let diff = try decode("result-diff", as: ResultDiff.self)
    #expect(diff.run == 2)
    #expect(diff.files.map(\.file) == [0, 1])
    #expect(diff.problem == nil)

    let none = try decode("result-diff-no-result", as: ResultDiff.self)
    #expect(none.files.isEmpty)
    #expect(none.run == nil)
    #expect(none.problem == "No result yet.")

    let file = try decode("result-diff-file", as: ResultDiffFile.self)
    #expect(file.file.hunks.count == 1)
    #expect(file.file.hunks[0].lines.map(\.kind) == [.context, .deletion, .addition, .context])
    #expect(file.file.hunks[0].lines[1].newLine == nil)
}

@Test("Live session windows decode: records, a missing file, a thread's window")
func decodesLiveWindows() throws {
    let window = try decode("live-session-window", as: LiveSessionWindow.self)
    #expect(window.session.id == .run(1))
    #expect(window.window.ok)
    let records = try #require(window.window.records)
    #expect(records.map(\.kind) == [.open, .say, .step, .done])
    #expect(records[1].text == ["reading the totals"])
    #expect(records[2].stepKind == "delegate")
    #expect(records[3].ok == nil)

    let missing = try decode("live-session-window-sub-missing", as: LiveSessionWindow.self)
    #expect(missing.window.ok == false)
    #expect(missing.window.reason == "missing")

    let thread = try decode("live-session-window-thread", as: LiveSessionWindow.self)
    if case .thread = thread.session.id {} else { Issue.record("thread id should decode as a string") }
}

@Test("The { ok, result } envelope unwraps")
func decodesEnvelope() throws {
    let inner = String(decoding: try fixture("result-diff"), as: UTF8.self)
    let envelope = Data("{\"ok\": true, \"result\": \(inner)}".utf8)
    let decoded = try JSONDecoder().decode(CompanionRPCEnvelope<ResultDiff>.self, from: envelope)
    #expect(decoded.ok)
    #expect(decoded.result.files.count == 2)
}

@Test("Unknown enum values decode as .other instead of failing")
func tolerantEnums() throws {
    var json = String(decoding: try fixture("work-rows"), as: UTF8.self)
    json = json.replacingOccurrences(of: "\"tone\": \"attention\"", with: "\"tone\": \"brand-new-tone\"")
    json = json.replacingOccurrences(of: "\"group\": \"building\"", with: "\"group\": \"someday\"")
    let rows = try JSONDecoder().decode(WorkRows.self, from: Data(json.utf8))
    #expect(rows.rows[0].status.tone == .other)
    #expect(rows.rows[1].group == .other)

    let record = try JSONDecoder().decode(LiveRecord.self, from: Data(#"{"k":"hologram","at":"x"}"#.utf8))
    #expect(record.kind == .other)
    let cut = try JSONDecoder().decode(LiveRecord.self, from: Data(#"{"k":"cut","dropped":3}"#.utf8))
    #expect(cut.kind == .cut)
    #expect(cut.dropped == 3)
}

@Test("Demo fixtures are valid Engine API bodies and agree with each other")
func demoFixturesDecode() throws {
    let rows = try CompanionDemoFixtures.workRows()
    #expect(rows.rows.count == 4)
    #expect(rows.needsCount == rows.rows.filter { $0.rank == 0 }.count)
    for row in rows.rows {
        let steps = try CompanionDemoFixtures.steps(task: row.id)
        #expect(steps.task.id == row.id)
        let diff = try CompanionDemoFixtures.diff(task: row.id)
        if let totals = diff.totals {
            #expect(totals.files == diff.files.count, "file count must match files listed")
        }
        for entry in diff.files {
            let file = try CompanionDemoFixtures.diffFile(task: row.id, file: entry.file)
            #expect(file.file.path == entry.path)
            let added = file.file.hunks.flatMap(\.lines).filter { $0.kind == .addition }.count
            let removed = file.file.hunks.flatMap(\.lines).filter { $0.kind == .deletion }.count
            #expect(added == entry.additions, "\(entry.path) additions")
            #expect(removed == entry.deletions, "\(entry.path) deletions")
        }
    }
    let decide = try CompanionDemoFixtures.steps(task: CompanionDemoFixtures.decideTask)
    #expect(decide.waitingTerms != nil)
    #expect(try CompanionDemoFixtures.liveWindow(run: CompanionDemoFixtures.runningRun).window.ok)
}

@Test("Demo source filters views like the server")
func demoViews() async throws {
    let source = DemoCompanionSource(latency: .zero)
    #expect(try await source.workRows(view: .needsYou, cursor: nil).rows.count == 2)
    #expect(try await source.workRows(view: .running, cursor: nil).rows.map(\.id) == [CompanionDemoFixtures.runningTask])
    #expect(try await source.workRows(view: .completed, cursor: nil).rows.map(\.id) == [CompanionDemoFixtures.doneTask])
    #expect(try await source.workRows(view: .all, cursor: nil).rows.count == 4)
}
