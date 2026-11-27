import Foundation
import Security
import Testing
@testable import ToolrollCompanionCore

// The pure decisions the app runs on: connection policy, copy, inbox merge, the offline snapshot, keychain read
// classes, device names, Handoff URLs and Bonjour matching.

// MARK: - Connection policy

@Test("Each error class maps to its verdict; only unreachable retries; refused and damaged drop the snapshot")
func policyVerdicts() {
    let cases: [(Error, CompanionConnectionPolicy.Verdict)] = [
        (CompanionConnectionError.unreachable(.macOffline), .unreachable(.macOffline)),
        (CompanionConnectionError.refused("device_revoked"), .refused(reason: "device_revoked")),
        (CompanionConnectionError.damaged("identity mismatch"), .damaged),
        (CompanionConnectionError.closed, .superseded),
        (CompanionRPCError(code: "standing_revoked", message: ""), .refused(reason: "account_revoked")),
        (CancellationError(), .superseded),
        (URLError(.timedOut), .unreachable(.generic)),
    ]
    for (error, expected) in cases {
        let verdict = CompanionConnectionPolicy.verdict(for: error)
        #expect(verdict == expected, "\(error)")
        #expect(verdict.retries == { if case .unreachable = expected { return true } else { return false } }())
        #expect(verdict.dropsSnapshot == (expected == .damaged || { if case .refused = expected { return true } else { return false } }()))
    }
}

@Test("Backoff: 2, 5, 15, then every 30 seconds")
func policyBackoff() {
    #expect((0...5).map(CompanionConnectionPolicy.retryDelay(attempt:)) == [.seconds(2), .seconds(5), .seconds(15), .seconds(30), .seconds(30), .seconds(30)])
}

@Test("Every hint has its own, non-empty line (U9)")
func policyHints() {
    let hints: [CompanionUnreachableHint] = [
        .generic, .noPath, .differentMachine, .macOffline, .clockSkew, .rateLimited, .relayRefused("x"), .keychainUnavailable, .protocolMismatch,
    ]
    let lines = hints.map(CompanionConnectionPolicy.hintMessage)
    #expect(Set(lines).count == hints.count)
    #expect(lines.allSatisfy { !$0.isEmpty })
    #expect(CompanionConnectionPolicy.hintMessage(.generic).contains("awake"))
    #expect(CompanionConnectionPolicy.hintMessage(.differentMachine).contains("reset or restored"))
    #expect(CompanionConnectionPolicy.hintMessage(.clockSkew).contains("date & time"))
}

@Test("The refused card names the removal; account and device reasons read differently")
func policyRefusedCopy() {
    let device = CompanionConnectionPolicy.refusedMessage(reason: "device_revoked")
    let account = CompanionConnectionPolicy.refusedMessage(reason: "account_revoked")
    #expect(device.title == "Your Mac removed this iPhone")
    #expect(device.body != account.body)
}

@Test("Every RPC code the Mac sends has useful copy, not the generic fallback (A7)")
func rpcCopy() {
    let generic = CompanionCopy.loadFailure(code: "never-heard-of-it")
    let codes = [
        "not_found", "deadline_exceeded", "invalid_response", "response_too_large", "standing_revoked", "too_many_streams",
        "memory_limit", "idle_timeout", "unavailable", "unsupported", "route_not_allowed", "invalid_params", "invalid_cursor",
        "handler_error", "protocol_error", "invalid_json", "hello_required",
    ]
    for code in codes {
        #expect(CompanionCopy.loadFailure(code: code) != generic, "\(code)")
    }
    #expect(CompanionCopy.loadFailure(CompanionConnectionError.unreachable(.generic)) == "Can't reach your Mac.")
}

// MARK: - Inbox merge (C2)

private func row(_ id: String) -> WorkRow {
    let json = #"{"id":"\#(id)","title":"\#(id)","href":"/t/\#(id)","age":"1m","status":{"label":"Ready","tone":"ready","token":"x"},"word":{"word":"","tone":""},"group":"rest","rank":3}"#
    return try! JSONDecoder().decode(WorkRow.self, from: Data(json.utf8))
}

private func page(_ ids: [String], next: String?) -> WorkRows {
    WorkRows(version: 1, project: nil, projectName: "p", needsCount: 0, groups: nil, rows: ids.map(row), needs: [], next: next, room: nil)
}

@Test("With only page 1 loaded a refresh replaces it")
func mergeRefreshSinglePage() {
    let current = InboxPage(rows: ["a", "b"].map(row), otherNeeds: [], next: "c1")
    let merged = InboxMerge.refreshed(current: current, firstPage: page(["z", "a"], next: "c2"))
    #expect(merged.rows.map(\.id) == ["z", "a"])
    #expect(merged.next == "c2")
}

@Test("With more pages loaded a refresh keeps the tail and its cursor; page 1's rows are replaced")
func mergeRefreshKeepsTail() throws {
    var current = InboxPage(rows: ["a", "b"].map(row), otherNeeds: [], next: "c1")
    current = try #require(InboxMerge.appended(current: current, cursor: "c1", page: page(["c", "d"], next: "c2")))
    #expect(current.hasLoadedMore)
    // b left page 1 (finished); c moved up into it.
    let merged = InboxMerge.refreshed(current: current, firstPage: page(["new", "a", "c"], next: "p2"))
    #expect(merged.rows.map(\.id) == ["new", "a", "c", "d"])
    #expect(merged.next == "c2")
    #expect(merged.firstPageIds == ["new", "a", "c"])
}

@Test("A refresh whose page 1 is now everything drops the old tail")
func mergeRefreshNoNext() throws {
    var current = InboxPage(rows: ["a"].map(row), otherNeeds: [], next: "c1")
    current = try #require(InboxMerge.appended(current: current, cursor: "c1", page: page(["b"], next: nil)))
    let merged = InboxMerge.refreshed(current: current, firstPage: page(["a"], next: nil))
    #expect(merged.rows.map(\.id) == ["a"])
    #expect(merged.next == nil)
}

@Test("A stale Load more (the screen moved on) never overwrites; a current one appends without duplicates")
func mergeStaleLoadMore() {
    let current = InboxPage(rows: ["a", "b"].map(row), otherNeeds: [], next: "c1")
    let refreshed = InboxMerge.refreshed(current: current, firstPage: page(["a", "b"], next: "c9"))
    #expect(InboxMerge.appended(current: refreshed, cursor: "c1", page: page(["c"], next: nil)) == nil)
    let appended = InboxMerge.appended(current: current, cursor: "c1", page: page(["b", "c"], next: nil))
    #expect(appended?.rows.map(\.id) == ["a", "b", "c"])
    #expect(appended?.next == nil)
}

// MARK: - Snapshot (U11)

@Test("The snapshot round-trips for its pairing only, and deleteAll removes it")
func snapshotStore() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = CompanionSnapshotStore(directory: dir)
    var snapshot = CompanionSnapshot(
        machineId: "m-1", deviceId: "dev-1", savedAt: Date(timeIntervalSince1970: 1_800_000_000), workspaceLabel: "Studio Mac",
        consoleUrl: "http://127.0.0.1:4180", needsCount: 2,
        inbox: ["needs-you": InboxPage(rows: ["a"].map(row), otherNeeds: [], next: nil)]
    )
    snapshot.tasks["a"] = .init(row: row("a"), steps: nil, diff: nil, openedAt: Date(timeIntervalSince1970: 1_800_000_000))
    try store.save(snapshot)
    #expect(store.load(machineId: "m-1", deviceId: "dev-1") == snapshot)
    #expect(store.load(machineId: "m-1", deviceId: "dev-2") == nil)
    #expect(store.load(machineId: "m-2", deviceId: "dev-1") == nil)
    store.deleteAll()
    #expect(store.load(machineId: "m-1", deviceId: "dev-1") == nil)
}

@Test("A snapshot keeps the newest opened tasks only")
func snapshotTrim() {
    var snapshot = CompanionSnapshot(machineId: "m", deviceId: "d", savedAt: Date(), workspaceLabel: "x")
    for i in 0..<12 {
        snapshot.tasks["t\(i)"] = .init(row: nil, steps: nil, diff: nil, openedAt: Date(timeIntervalSince1970: Double(i)))
    }
    snapshot.trimTasks()
    #expect(snapshot.tasks.count == CompanionSnapshot.maxTasks)
    #expect(snapshot.tasks["t11"] != nil && snapshot.tasks["t0"] == nil)
}

// MARK: - Keychain read classes (C1)

@Test("Only errSecItemNotFound on every item means missing; any other status is unavailable, never a wipe")
func keychainClassify() {
    let data = Data([1])
    let notFound = CompanionKeychain.ItemRead.failure(.init(errSecItemNotFound))
    let locked = CompanionKeychain.ItemRead.failure(.init(errSecInteractionNotAllowed))
    #expect(CompanionKeychain.classify([.success(data), .success(data), .success(data)]) == .present([data, data, data]))
    #expect(CompanionKeychain.classify([notFound, notFound, notFound]) == .missing)
    #expect(CompanionKeychain.classify([.success(data), notFound, .success(data)]) == .partial)
    #expect(CompanionKeychain.classify([notFound, locked, notFound]) == .unavailable(errSecInteractionNotAllowed))
    #expect(CompanionKeychain.classify([.success(data), .failure(.init(-34018)), .success(data)]) == .unavailable(-34018))
}

// MARK: - Device name (U4)

@Test("The default name is the marketing model; unknown hardware falls back; names are sanitized")
func deviceNames() {
    #expect(CompanionDeviceName.defaultName(identifier: "iPhone17,1", fallback: "iPhone") == "iPhone 16 Pro")
    #expect(CompanionDeviceName.defaultName(identifier: "iPhone18,4", fallback: "iPhone") == "iPhone Air")
    #expect(CompanionDeviceName.defaultName(identifier: "iPhone99,9", fallback: "iPhone") == "iPhone")
    #expect(CompanionDeviceName.defaultName(identifier: nil, fallback: "  ") == "iPhone")
    #expect(CompanionDeviceName.sanitized("  Studio\u{202E} phone\n") == "Studio phone")
    #expect(CompanionDeviceName.sanitized(String(repeating: "é", count: 60))?.count == 48)
    #expect(CompanionDeviceName.sanitized("\n\t") == nil)
}

// MARK: - Handoff (U12)

@Test("Handoff URLs are built only from a plain http(s) origin and a safe task id")
func handoffURLs() {
    #expect(CompanionHandoff.taskURL(consoleUrl: "http://127.0.0.1:4180", taskId: "t-123")?.absoluteString == "http://127.0.0.1:4180/t/t-123")
    #expect(CompanionHandoff.taskURL(consoleUrl: "https://studio.example.invalid/", taskId: "t_1")?.absoluteString == "https://studio.example.invalid/t/t_1")
    #expect(CompanionHandoff.taskURL(consoleUrl: nil, taskId: "t-1") == nil)
    #expect(CompanionHandoff.taskURL(consoleUrl: "javascript:alert(1)", taskId: "t-1") == nil)
    #expect(CompanionHandoff.taskURL(consoleUrl: "http://user:pw@host:1", taskId: "t-1") == nil)
    #expect(CompanionHandoff.taskURL(consoleUrl: "http://host:1/base", taskId: "t-1") == nil)
    #expect(CompanionHandoff.taskURL(consoleUrl: "http://host:1?x=1", taskId: "t-1") == nil)
    #expect(CompanionHandoff.taskURL(consoleUrl: "http://host:1", taskId: "../etc") == nil)
}

// MARK: - Bonjour (C3)

@Test("Bonjour: TXT m must equal the stored machineId; found addresses must pass the direct path rules")
func bonjourRules() {
    #expect(CompanionBonjour.matches(txt: ["m": "abc"], machineId: "abc"))
    #expect(!CompanionBonjour.matches(txt: ["m": "abd"], machineId: "abc"))
    #expect(!CompanionBonjour.matches(txt: [:], machineId: "abc"))
    #expect(!CompanionBonjour.matches(txt: ["m": ""], machineId: ""))
    #expect(CompanionBonjour.directPath(host: "192.168.1.30", port: 4200)?.url == "ws://192.168.1.30:4200/v1/direct")
    #expect(CompanionBonjour.directPath(host: "192.168.1.30%en0", port: 4200)?.url == "ws://192.168.1.30:4200/v1/direct")
    #expect(CompanionBonjour.directPath(host: "8.8.8.8", port: 4200) == nil)
}

// MARK: - Path rules (E5)

@Test("A loopback hosted path is accepted only in DEBUG builds (release refuses it)")
func loopbackHostedIsDebugOnly() {
    let loopback = CompanionPath(kind: .hosted, url: "ws://127.0.0.1:8799/v1/connect")
    #if DEBUG
    #expect((try? CompanionPathRules.validate(loopback)) != nil)
    #else
    #expect((try? CompanionPathRules.validate(loopback)) == nil)
    #endif
}

@Test("Every Engine API shape the snapshot keeps survives encode → decode unchanged")
func snapshotPayloadRoundTrip() throws {
    let rows = try CompanionDemoFixtures.workRows()
    var snapshot = CompanionSnapshot(machineId: "m", deviceId: "d", savedAt: Date(timeIntervalSince1970: 1_800_000_000), workspaceLabel: "x")
    snapshot.inbox["all"] = InboxPage(rows: rows.rows, otherNeeds: rows.needs.flatMap(\.rows), next: "c1")
    for row in rows.rows {
        snapshot.tasks[row.id] = .init(
            row: row, steps: try? CompanionDemoFixtures.steps(task: row.id), diff: try? CompanionDemoFixtures.diff(task: row.id),
            openedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }
    #expect(snapshot.tasks.values.contains { $0.steps != nil && $0.diff != nil })
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    let back = try decoder.decode(CompanionSnapshot.self, from: encoder.encode(snapshot))
    #expect(back == snapshot)
}
