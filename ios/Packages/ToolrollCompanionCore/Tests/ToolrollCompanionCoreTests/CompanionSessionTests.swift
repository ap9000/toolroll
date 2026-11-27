import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// Refusals, session ends, relay errors, the token, timers on a manual clock, stream caps and chunk ordering.

// MARK: - msg2 refusals and session ends

@Test("A padded msg2 `refused` on the direct path is terminal: no hosted fallback, no session", arguments: ["device_revoked", "account_revoked"])
func msg2RefusedIsTerminal(_ reason: String) async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    await h.mac.setRefuse(reason)
    await #expect(throws: CompanionConnectionError.refused(reason)) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 1)
    #expect(await h.mac.methods.isEmpty)
    #expect(await h.mac.msg2Sizes == [CompanionWire.paddedMsg2Bytes])
    #expect(await h.client.isConnected == false)
}

@Test("A stream-0 ERROR device_revoked/account_revoked ends the session as refused and fails pending calls", arguments: [
    "device_revoked", "account_revoked",
])
func streamZeroRefusal(_ code: String) async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let ends = EndLog()
    await h.client.setSessionEndHandler { ends.add($0) }
    await h.mac.set("never", .silent)
    let client = h.client
    let pending = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await waitUntil("the call reached the Mac") { await h.mac.methods.contains("never") }
    await h.mac.pushStreamZeroError(code, h.box.socket!)
    await #expect(throws: CompanionConnectionError.refused(code)) { _ = try await pending.value }
    try await waitUntil("the end was reported") { ends.all == [.refused(reason: code)] }
    #expect(await h.client.isConnected == false)
}

@Test("A stream-0 ERROR rekey ends the session as rekey (the app reconnects silently)")
func streamZeroRekey() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let ends = EndLog()
    await h.client.setSessionEndHandler { ends.add($0) }
    await h.mac.pushStreamZeroError("rekey", h.box.socket!)
    try await waitUntil("rekey reported") { ends.all == [.rekey] }
    // A fresh connect works straight away.
    _ = try await h.connectResult(paths: [hostedRelay])
    #expect(await h.client.isConnected)
}

@Test("An RPC answered standing_revoked fails that call and ends the session as an account refusal")
func standingRevokedEndsSession() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let ends = EndLog()
    await h.client.setSessionEndHandler { ends.add($0) }
    await h.mac.set("work.rows", .error(code: "standing_revoked", message: "no"))
    await #expect(throws: CompanionRPCError(code: "standing_revoked", message: "no")) {
        _ = try await h.client.call("work.rows", params: TaskParams(task: "x"), as: Small.self)
    }
    try await waitUntil("refusal reported") { ends.all == [.refused(reason: "account_revoked")] }
    #expect(await h.client.isConnected == false)
}

@Test("Until device.hello passes the session isn't connected and public calls are refused (A8)")
func notConnectedBeforeHello() async throws {
    let h = try Harness()
    await h.mac.holdNextHello()
    let connecting = Task { try await h.connectResult(paths: [hostedRelay]) }
    await h.mac.helloHeld.wait()
    #expect(await h.client.isConnected == false)
    await #expect(throws: CompanionConnectionError.closed) {
        _ = try await h.client.call("work.rows", params: TaskParams(task: "x"), as: Small.self)
    }
    await h.client.disconnect()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await connecting.value }
}

@Test("Disconnect closes a dial still waiting for msg2 (A9)")
func disconnectClosesDial() async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .stallBeforeReply)
    let connecting = Task { try await h.connectResult(paths: [hostedRelay]) }
    try await waitUntil("the socket opened") { h.box.sockets.count == 1 }
    await h.client.disconnect()
    try await waitUntil("the dial socket was closed") { h.box.socket?.isClosed == true }
    await #expect(throws: CompanionConnectionError.self) { _ = try await connecting.value }
}

// MARK: - Relay refusals

fileprivate struct RefusalCase: Sendable, CustomTestStringConvertible {
    let status: Int
    let code: String?
    let expected: CompanionConnectionError
    var testDescription: String { "\(status) \(code ?? "-")" }
}

@Test("Hosted refusals map by their Toolroll-Relay-Error code; only 403 device_revoked is terminal", arguments: [
    RefusalCase(status: 403, code: "device_revoked", expected: .refused("device_revoked")),
    RefusalCase(status: 403, code: nil, expected: .unreachable(.relayRefused("http_403"))),
    RefusalCase(status: 401, code: "token_invalid", expected: .unreachable(.relayRefused("token_invalid"))),
    RefusalCase(status: 404, code: "machine_unknown", expected: .unreachable(.macOffline)),
    RefusalCase(status: 404, code: "device_unknown", expected: .unreachable(.relayRefused("device_unknown"))),
    RefusalCase(status: 429, code: "rate_limited", expected: .unreachable(.rateLimited)),
    RefusalCase(status: 503, code: "daemon_unavailable", expected: .unreachable(.macOffline)),
    RefusalCase(status: 400, code: "bad_request", expected: .unreachable(.relayRefused("bad_request"))),
])
fileprivate func relayRefusalMapping(_ c: RefusalCase) async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: c.status, code: c.code)))
    await #expect(throws: c.expected) { _ = try await h.connectResult(paths: [hostedRelay]) }
    #expect(h.box.requests.count == 1)
}

@Test("The refusal is read from the response headers, case-insensitively, with Date and Retry-After")
func refusalHeaderParsing() throws {
    let refusal = CompanionRelayRefusal(status: 401, headers: [
        "toolroll-relay-error": "token_expired",
        "date": "Wed, 27 Nov 2030 12:00:00 GMT",
        "Retry-After": "7",
    ])
    #expect(refusal.code == "token_expired")
    #expect(refusal.isClockSkew)
    #expect(refusal.retryAfter == 7)
    #expect(refusal.serverDate == Date(timeIntervalSince1970: 1_922_011_200))
    // A header that isn't a code is ignored.
    #expect(CompanionRelayRefusal(status: 403, headers: ["Toolroll-Relay-Error": "Device Revoked!"]).code == nil)
}

@Test("A token_expired with a Date header corrects the clock once and retries; the retry's token uses the relay's time")
func clockSkewCorrectedOnce() async throws {
    let phoneNow = Date(timeIntervalSince1970: 1_900_000_000)
    let relayNow = phoneNow.addingTimeInterval(3600)
    let h = try Harness(now: { phoneNow })
    h.box.queueMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: 401, code: "token_not_yet_valid", serverDate: relayNow)))
    let result = try await h.connectResult(paths: [hostedRelay])
    #expect(result.path == hostedRelay)
    #expect(h.box.requests.count == 2)
    let first = tokenClaims(h.box.requests[0])?["iat"] as? Int
    let second = tokenClaims(h.box.requests[1])?["iat"] as? Int
    #expect(first == 1_900_000_000)
    #expect(second == 1_900_003_600)
    #expect(await h.client.clockOffset == 3600)
}

@Test("A second skew refusal after the correction is the clockSkew hint, with no third attempt")
func clockSkewTwiceIsHint() async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: 401, code: "token_expired", serverDate: Date().addingTimeInterval(-900))))
    await #expect(throws: CompanionConnectionError.unreachable(.clockSkew)) { _ = try await h.connectResult(paths: [hostedRelay]) }
    #expect(h.box.requests.count == 2)
}

@Test("The device token carries exactly the contract's claims, with aud = the relay host")
func deviceTokenClaims() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let claims = try #require(tokenClaims(h.box.requests.first))
    #expect(Set(claims.keys) == ["v", "role", "machineId", "deviceId", "aud", "jti", "iat", "exp"])
    #expect(claims["aud"] as? String == "relay.invalid")
    #expect(claims["role"] as? String == "device")
    let jti = try #require(claims["jti"] as? String)
    #expect(jti.range(of: #"^[A-Za-z0-9_-]{16,64}$"#, options: .regularExpression) != nil)
    let iat = try #require(claims["iat"] as? Int), exp = try #require(claims["exp"] as? Int)
    #expect(exp - iat > 0 && exp - iat <= 300)
    #expect(CompanionRelayAuth.audience(forHostedURL: "wss://Relay.Example.invalid:8443/v1/connect") == "relay.example.invalid:8443")
}

// MARK: - Timers on a manual clock

@Test("PING every interval; no PONG within 10 s ends the session (A6)")
func pongDeadlineOnManualClock() async throws {
    let clock = ManualClock()
    let h = try Harness(timing: .init(ping: .seconds(25), pongDeadline: .seconds(10)), clock: clock)
    _ = try await h.connectResult(paths: [hostedRelay])
    let ends = EndLog()
    await h.client.setSessionEndHandler { ends.add($0) }
    await h.mac.setAnswerPings(false)
    try await waitUntil("the ping timer is armed") { clock.deadlines.contains(.seconds(25)) }
    clock.advance(by: .seconds(25))
    try await waitUntil("the Mac saw the ping") { await h.mac.pings == 1 }
    try await waitUntil("the pong deadline is armed") { clock.deadlines.contains(.seconds(35)) }
    clock.advance(by: .seconds(9))
    #expect(await h.client.isConnected)
    clock.advance(by: .seconds(1))
    try await waitUntil("the loss was reported") { ends.all == [.lost] }
    #expect(await h.client.isConnected == false)
}

@Test("checkAlive pings at once; an answered PONG keeps the session (foreground / network change)")
func checkAlivePings() async throws {
    let clock = ManualClock()
    let h = try Harness(clock: clock)
    _ = try await h.connectResult(paths: [hostedRelay])
    await h.client.checkAlive()
    try await waitUntil("the Mac saw the ping") { await h.mac.pings == 1 }
    try await waitUntil("the PONG cleared the deadline") { !clock.deadlines.contains(.seconds(10)) }
    clock.advance(by: .seconds(11))
    #expect(await h.client.isConnected)
}

// MARK: - Streams, chunks, cancellation

@Test("A ninth concurrent call waits for a free stream instead of exceeding the Mac's 8 (B2)")
func ninthCallWaitsForSlot() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let gate = Signal()
    await h.mac.set("slow", .gated(#"{"name":"slow"}"#, gate))
    await h.mac.set("ninth", .result(#"{"name":"ninth"}"#))
    let client = h.client
    let slow = (0..<8).map { i in Task { try await client.call("slow", params: TaskParams(task: "\(i)"), as: Small.self) } }
    try await waitUntil("eight calls on the Mac") { await h.mac.methods.filter { $0 == "slow" }.count == 8 }
    let ninth = Task { try await client.call("ninth", params: TaskParams(task: "9"), as: Small.self) }
    try await waitUntil("the ninth waits for a slot") { await h.client.callsWaitingForSlot == 1 }
    #expect(!(await h.mac.methods.contains("ninth")))
    await gate.fire()
    #expect(try await ninth.value.name == "ninth")
    for task in slow { _ = try await task.value }
}

@Test("A third watch is refused locally with too_many_streams (the Mac allows 2)")
func thirdWatchRefused() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    await h.mac.set("run.watch.subscribe", .watch([]))
    struct RunParams: Encodable, Sendable { let run: String }
    let a = try await h.client.watch(method: "run.watch.subscribe", params: RunParams(run: "1"))
    let b = try await h.client.watch(method: "run.watch.subscribe", params: RunParams(run: "2"))
    await #expect(throws: CompanionRPCError.self) {
        _ = try await h.client.watch(method: "run.watch.subscribe", params: RunParams(run: "3"))
    }
    _ = (a, b)
}

@Test("A unary CHUNK out of order fails the call with invalid_response and CANCELs the stream")
func unaryChunkOutOfOrder() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    await h.mac.set("big", .rawChunks([(0, #"{"ok":true,"#), (2, #""result":{}}"#)], end: true))
    await #expect(throws: CompanionRPCError(code: "invalid_response", message: "Chunk out of order")) {
        _ = try await h.client.call("big", params: TaskParams(task: "t"), as: Small.self)
    }
    try await waitUntil("CANCEL for stream 3") { await h.mac.cancels == [3] }
}

@Test("A unary response over 1 MiB fails with response_too_large and CANCELs the stream")
func unaryOverOneMiB() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let big = String(repeating: "y", count: 1_100_000)
    await h.mac.set("big", .chunked(#"{"name":"\#(big)"}"#, chunkBytes: 60_000))
    await #expect(throws: CompanionRPCError(code: "response_too_large", message: "Response is larger than 1 MiB")) {
        _ = try await h.client.call("big", params: TaskParams(task: "t"), as: Small.self)
    }
    try await waitUntil("CANCEL for stream 3") { await h.mac.cancels.contains(3) }
    // Two batches of 8 chunks were credited before the cap.
    #expect(await h.mac.creditFrames[3] == 2)
}

@Test("Cancelling the task of a call sends CANCEL and resumes it once with CancellationError")
func cancelSendsCancel() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    await h.mac.set("never", .silent)
    let client = h.client
    let call = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await waitUntil("the call reached the Mac") { await h.mac.methods.contains("never") }
    call.cancel()
    await #expect(throws: CancellationError.self) { _ = try await call.value }
    try await waitUntil("CANCEL for stream 3") { await h.mac.cancels == [3] }
    #expect(await h.client.isConnected)
}

@Test("A watch ends cleanly on END, throws the Mac's code on ERROR, and ends on a seq gap (B3)")
func watchEndErrorAndGap() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    let source = LiveCompanionSource(client: h.client)
    let say = { (t: String) in #"{"k":"say","at":"t","t":["\#(t)"]}"# }

    await h.mac.set("run.watch.subscribe", .watchEnd([say("a"), say("b")]))
    var seen: [String] = []
    for try await record in try await source.watchRun(run: 1, cursor: nil) { seen.append(record.text?.first ?? "") }
    #expect(seen == ["a", "b"])

    await h.mac.set("run.watch.subscribe", .watchError([say("c")], code: "idle_timeout"))
    seen = []
    await #expect(throws: CompanionRPCError(code: "idle_timeout", message: "stopped")) {
        for try await record in try await source.watchRun(run: 1, cursor: nil) { seen.append(record.text?.first ?? "") }
    }
    #expect(seen == ["c"])

    await h.mac.set("run.watch.subscribe", .rawChunks([(UInt32(0), say("d")), (UInt32(2), say("e"))], end: false))
    seen = []
    await #expect(throws: CompanionRPCError.self) {
        for try await record in try await source.watchRun(run: 1, cursor: nil) { seen.append(record.text?.first ?? "") }
    }
    #expect(seen == ["d"])
    try await waitUntil("CANCEL for the gapped watch") { await h.mac.cancels.count >= 1 }
}

@Test("Records of a kind this build doesn't know are skipped")
func unknownRecordKindSkipped() async throws {
    let h = try Harness()
    _ = try await h.connectResult(paths: [hostedRelay])
    await h.mac.set("run.watch.subscribe", .watchEnd([
        #"{"k":"say","at":"t","t":["known"]}"#,
        #"{"k":"hologram","at":"t"}"#,
        #"{"k":"over","at":"t"}"#,
    ]))
    var kinds: [LiveRecordKind] = []
    for try await record in try await LiveCompanionSource(client: h.client).watchRun(run: 1, cursor: nil) { kinds.append(record.kind) }
    #expect(kinds == [.say, .over])
}

// MARK: - Bonjour fallback, hints, stored-state checks

@Test("When no stored direct path answers, a Bonjour-found address is health-checked and used for that dial only (C3)")
func bonjourFallback() async throws {
    let found = CompanionPath(kind: .direct, url: "ws://192.168.7.9:4199/v1/direct")
    let asked = Flag<[String]>([])
    let h = try Harness(discover: { machineId in
        asked.set(asked.value + [machineId])
        return [found]
    })
    h.box.answer("192.168.7.9", machineId: "m-1")
    let result = try await h.connectResult()
    #expect(asked.value == ["m-1"])
    #expect(result.path == found)
    #expect(result.record.paths == testPaths)
    #expect(h.box.requests.first?.url?.host == "192.168.7.9")
}

@Test("A stored direct path that answers means no Bonjour browse")
func noBonjourWhenStoredAnswers() async throws {
    let asked = Flag(0)
    let h = try Harness(discover: { _ in
        asked.set(asked.value + 1)
        return []
    })
    h.box.answer("192.168.1.20", machineId: "m-1")
    _ = try await h.connectResult()
    #expect(asked.value == 0)
}

@Test("A direct address answering for a different machine, and nothing else reachable: the reset/restored hint (§2.6)")
func differentMachineHint() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-other")
    await #expect(throws: CompanionConnectionError.unreachable(.differentMachine)) {
        _ = try await h.connectResult(paths: [directLAN])
    }
    h.box.setMode(.hosted, .dropBeforeReply)
    await #expect(throws: CompanionConnectionError.unreachable(.differentMachine)) {
        _ = try await h.connectResult(paths: [directLAN, hostedRelay])
    }
}

@Test("Stored keys or records that can't be used are damaged, not a refusal")
func damagedStoredState() async throws {
    let h = try Harness()
    let record = await h.mac.record()
    await #expect(throws: CompanionConnectionError.damaged("invalid stored keys")) {
        _ = try await h.client.connect(record: record, devicePsk: Data(count: 5), phoneNoisePriv: Data(count: 32), deviceRelayPriv: Data(count: 32))
    }
    let broken = PairedWorkspaceRecord(
        workspaceId: "ws-1", workspaceLabel: "x", machineId: "m-1", paths: [CompanionPath(kind: .direct, url: "ws://8.8.8.8:1/v1/direct")],
        macStaticPubBase64Url: record.macStaticPubBase64Url, deviceId: "dev-1",
        recoveryGeneration: record.recoveryGeneration, pairedAt: Date()
    )
    await #expect(throws: CompanionConnectionError.damaged("invalid stored paths")) {
        _ = try await h.client.connect(record: broken, devicePsk: h.mac.devicePsk, phoneNoisePriv: X25519KeyPair.generate().privateKey,
                                       deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation)
    }
}

@Test("A stored list that no longer validates as a whole still dials its valid hosted path (A3)")
func partlyInvalidPathsKeepHosted() async throws {
    let h = try Harness()
    let bad = CompanionPath(kind: .direct, url: "ws://8.8.8.8:4199/v1/direct")
    let result = try await h.connectResult(paths: [bad, hostedRelay])
    #expect(result.path == hostedRelay)
}

@Test("The hello's consoleUrl is passed through")
func helloConsoleUrl() async throws {
    let h = try Harness()
    await h.mac.setHelloConsoleUrl("http://127.0.0.1:4180")
    let hello = try await h.connectResult(paths: [hostedRelay]).hello
    #expect(hello.consoleUrl == "http://127.0.0.1:4180")
}
