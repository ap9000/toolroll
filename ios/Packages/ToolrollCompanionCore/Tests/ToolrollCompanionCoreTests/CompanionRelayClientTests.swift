import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// Session behaviour against the in-memory fake Mac (TestSupport.swift).

@Test("Connect runs the handshake and device.hello, then validates the hello's identity")
func connectAndHello() async throws {
    let h = try Harness()
    let hello = try await h.connect()
    #expect(hello.workspaceLabel == "Studio Mac")
    #expect(await h.mac.methods == ["device.hello"])
    #expect(await h.client.isConnected)
}

@Test("A hello naming another device is damaged pairing data (terminal), not a refusal")
func helloIdentityMismatch() async throws {
    let h = try Harness()
    await h.mac.setHelloDeviceId("someone-else")
    await #expect(throws: CompanionConnectionError.damaged("identity mismatch")) {
        _ = try await h.connect()
    }
    #expect(await h.client.isConnected == false)
}

@Test("Concurrent calls each get their own reply, whatever order the Mac answers in")
func concurrentCallsDispatchByStream() async throws {
    let h = try Harness()
    _ = try await h.connect()
    let gate = Signal()
    await h.mac.set("slow", .gated(#"{"name":"slow"}"#, gate))
    await h.mac.set("fast", .result(#"{"name":"fast"}"#))
    let client = h.client
    let slow = Task { try await client.call("slow", params: TaskParams(task: "a"), as: Small.self) }
    try await waitUntil("the slow call reached the Mac") { await h.mac.methods.contains("slow") }
    // The fast call is answered while the slow one is still held on the Mac.
    let fast = try await client.call("fast", params: TaskParams(task: "b"), as: Small.self)
    #expect(fast.name == "fast")
    await gate.fire()
    #expect(try await slow.value.name == "slow")
}

@Test("Chunked replies are reassembled in order; credit goes back in batches of 8")
func chunkReassembly() async throws {
    let h = try Harness()
    _ = try await h.connect()
    let big = String(repeating: "x", count: 150_000)
    await h.mac.set("big", .chunked(#"{"name":"\#(big)"}"#, chunkBytes: 50_000))
    let result = try await h.client.call("big", params: TaskParams(task: "t"), as: Small.self)
    #expect(result.name.count == 150_000)
    // stream 1 was hello; 150 KB + envelope = 4 chunks: fewer than a batch, so no CREDIT frame at all (the Mac's window
    // of 16 covers it).
    await h.mac.set("flush", .result(#"{"name":"f"}"#))
    _ = try await h.client.call("flush", params: TaskParams(task: "f"), as: Small.self)
    #expect(await h.mac.creditFrames[3] == nil)
}

@Test("An ERROR frame becomes a typed CompanionRPCError")
func errorFrame() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("task.steps", .error(code: "not_found", message: "No such task"))
    await #expect(throws: CompanionRPCError(code: "not_found", message: "No such task")) {
        _ = try await h.client.call("task.steps", params: TaskParams(task: "t-x"), as: Small.self)
    }
}

@Test("Disconnect fails every pending call exactly once")
func disconnectFailsPending() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    let client = h.client
    let pending = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await waitUntil("the call reached the Mac") { await h.mac.methods.contains("never") }
    await client.disconnect()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await pending.value }
    #expect(await client.isConnected == false)
}

@Test("The Mac closing the socket fails pending calls and reports the loss")
func socketClosedReportsLoss() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    let lost = Flag(false)
    await h.client.setSessionEndHandler { _ in lost.set(true) }
    let client = h.client
    let pending = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await waitUntil("the call reached the Mac") { await h.mac.methods.contains("never") }
    h.box.socket?.close()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await pending.value }
    try await waitUntil("the loss was reported") { lost.value }
}

@Test("A call with no answer times out and is cancelled on the Mac")
func callDeadline() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .milliseconds(100), ping: .seconds(60)))
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    await #expect(throws: CompanionRPCError(code: "deadline_exceeded", message: "No answer within 1 second")) {
        _ = try await h.client.call("never", params: TaskParams(task: "t"), as: Small.self)
    }
    try await waitUntil("the Mac saw CANCEL for stream 3") { await h.mac.cancels == [3] }
}

@Test("A watch yields each CHUNK and sends CANCEL when the consumer stops")
func watchCancelsOnTermination() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("run.watch.subscribe", .watch([
        #"{"k":"say","at":"t","t":["one"]}"#,
        #"{"k":"say","at":"t","t":["two"]}"#,
        #"{"k":"say","at":"t","t":["three"]}"#,
    ]))
    // The watch sheet's task owns the stream; dismissing the sheet cancels that task.
    let source = LiveCompanionSource(client: h.client)
    let consumer = Task {
        var seen: [String] = []
        let stream = try await source.watchRun(run: 41, cursor: nil)
        for try await record in stream {
            seen.append(record.text?.first ?? "")
            if seen.count == 2 { return seen }
        }
        return seen
    }
    let seen = try await consumer.value
    #expect(seen == ["one", "two"])
    try await waitUntil("the Mac saw CANCEL for stream 3") { await h.mac.cancels == [3] }
    #expect(await h.mac.creditFrames[3] == nil)
    #expect(await h.client.isConnected)
}

@Test("A PING with no PONG drops the connection at the PONG deadline")
func missedPongsDisconnect() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .seconds(5), ping: .milliseconds(40), pongDeadline: .milliseconds(40)))
    _ = try await h.connect()
    await h.mac.setAnswerPings(false)
    let lost = Flag(false)
    await h.client.setSessionEndHandler { _ in lost.set(true) }
    try await waitUntil("the loss was reported") { lost.value }
    #expect(await h.client.isConnected == false)
    #expect(await h.mac.pings >= 1)
}

@Test("Answered pings keep the connection up")
func answeredPingsKeepAlive() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .seconds(5), ping: .milliseconds(30)))
    let lost = Flag(false)
    await h.client.setSessionEndHandler { _ in lost.set(true) }
    _ = try await h.connect()
    try await waitUntil("three pings answered") { await h.mac.pings >= 3 }
    #expect(await h.client.isConnected)
    #expect(!lost.value)
}

// MARK: - Dialing: direct first, hosted as the fallback

@Test("All probes fail: the hosted relay is used with its Bearer token")
func dialFallsToHostedWhenNoProbeAnswers() async throws {
    let h = try Harness()
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(Set(h.box.probed) == ["http://192.168.1.20:4199/v1/health", "http://100.101.102.103:4199/v1/health"])
    let requests = h.box.requests
    #expect(requests.count == 1)
    #expect(requests.first?.url?.absoluteString == "wss://relay.invalid/v1/connect")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
}

@Test("A healthy direct path is dialed once, with no Authorization header")
func dialPicksHealthyDirect() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    let result = try await h.connectResult()
    #expect(result.path == directLAN)
    #expect(await h.client.isConnected)
    let requests = h.box.requests
    #expect(requests.count == 1)
    #expect(requests.first?.url?.absoluteString == "ws://192.168.1.20:4199/v1/direct?role=device&id=dev-1")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.first?.allHTTPHeaderFields?.isEmpty ?? true)
}

@Test("An address answering for a different machine is skipped")
func dialSkipsWrongMachine() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-someone-else")
    h.box.answer("100.101.102.103", machineId: "m-1")
    let result = try await h.connectResult()
    #expect(result.path == directTailnet)
    #expect(h.box.requests.map { $0.url?.host } == ["100.101.102.103"])
}

@Test("A wrong machine on the only direct path falls through to hosted")
func dialWrongMachineOnlyDirect() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-someone-else")
    let result = try await h.connectResult(paths: [directLAN, hostedRelay])
    #expect(result.path == hostedRelay)
    #expect(h.box.requests.count == 1)
}

@Test("A direct socket failure mid-handshake falls back to hosted exactly once", arguments: [SocketModeArg.dropBeforeReply, .dropOnHello])
fileprivate func dialFallsBackOnce(_ mode: SocketModeArg) async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(await h.client.isConnected)
    let requests = h.box.requests
    #expect(requests.count == 2)
    #expect(requests.first?.url?.path == "/v1/direct")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.last?.url?.absoluteString == "wss://relay.invalid/v1/connect")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
}

@Test("If hosted also fails after the fallback, there is no third attempt")
func dialFallbackOnlyOnce() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, .dropBeforeReply)
    h.box.setMode(.hosted, .dropBeforeReply)
    await #expect(throws: CompanionConnectionError.self) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 2)
}

@Test("An encrypted standing_revoked at hello on the direct path stands: no fallback to hosted")
func dialHelloRefusalDoesNotFallBack() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    await h.mac.setHelloError(code: "standing_revoked", message: "This account no longer stands")
    await #expect(throws: CompanionConnectionError.refused("account_revoked")) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 1)
    #expect(h.box.requests.first?.url?.path == "/v1/direct")
    #expect(await h.client.isConnected == false)
}

@Test("The hosted relay's 403 device_revoked stands (no retry)")
func dialHostedRefusalStands() async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: 403, code: "device_revoked")))
    await #expect(throws: CompanionConnectionError.refused("device_revoked")) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 1)
}

@Test("Anything unauthenticated going wrong on direct falls back to hosted and succeeds", arguments: [
    SocketModeArg.garbageReply, .closeBeforeReply, .refused, .refusedRevoked, .stallBeforeReply, .stallHello,
])
fileprivate func dialUnauthenticatedDirectFailureFallsBack(_ mode: SocketModeArg) async throws {
    let h = try Harness(timing: .init(directHandshake: .milliseconds(150)))
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    let started = ContinuousClock.now
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(await h.client.isConnected)
    #expect(ContinuousClock.now - started < .seconds(3))
    let requests = h.box.requests
    #expect(requests.count == 2)
    #expect(requests.first?.url?.path == "/v1/direct")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
    // The stalled direct session must not come back to life and tear down the hosted one: a round trip on the hosted
    // session still works.
    await h.mac.set("ping.me", .result(#"{"name":"still here"}"#))
    #expect(try await h.client.call("ping.me", params: TaskParams(task: "t"), as: Small.self).name == "still here")
    #expect(await h.client.isConnected)
}

@Test("Without a hosted path, a broken direct handshake is unreachable, not \"not recognized\"")
func dialGarbageDirectNoHosted() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, .garbageReply)
    do {
        _ = try await h.connectResult(paths: [directLAN])
        Issue.record("expected a failure")
    } catch let error as CompanionConnectionError {
        guard case .unreachable = error else {
            Issue.record("expected unreachable, got \(error)")
            return
        }
    }
    #expect(h.box.requests.count == 1)
}

@Test("No direct path answers and there is no hosted path: the no-path hint, no socket")
func dialNothingReachable() async throws {
    let h = try Harness()
    await #expect(throws: CompanionConnectionError.unreachable(.noPath)) {
        _ = try await h.connectResult(paths: [directLAN, directTailnet])
    }
    #expect(h.box.requests.isEmpty)
    #expect(CompanionConnectionPolicy.hintMessage(.noPath)
        == "Can't reach your Mac. Connect to the same Wi-Fi as your Mac (or Tailscale), or turn on 'Connect from anywhere' in Toolroll → Settings → Phone.")
}

@Test("A hello's valid paths replace the stored ones")
func helloPathsReplaceStored() async throws {
    let h = try Harness()
    await h.mac.setHelloPaths(#"[{"kind":"direct","url":"ws://10.0.0.7:4199/v1/direct"},{"kind":"hosted","url":"wss://relay.invalid/v1/connect"}]"#)
    let result = try await h.connectResult()
    #expect(result.record.paths == [
        CompanionPath(kind: .direct, url: "ws://10.0.0.7:4199/v1/direct"),
        hostedRelay,
    ])
    #expect(result.record.deviceId == "dev-1")
}

@Test("A hello with invalid or no paths keeps the stored ones", arguments: [
    #"[{"kind":"direct","url":"ws://8.8.8.8:4199/v1/direct"}]"#,
    #"[{"kind":"carrier-pigeon","url":"ws://10.0.0.7:4199/v1/direct"}]"#,
    "[]",
    nil,
])
func helloInvalidPathsKeepStored(_ json: String?) async throws {
    let h = try Harness()
    await h.mac.setHelloPaths(json)
    let result = try await h.connectResult()
    #expect(result.record.paths == testPaths)
    #expect(await h.client.isConnected)
}

@Test("A probe that doesn't answer within its timeout counts as unreachable")
func slowProbeTimesOut() async throws {
    let mac = try FakeMac()
    let box = SocketBox()
    let client = CompanionRelayClient(
        timing: .init(probe: .milliseconds(50)),
        healthProbe: { _, _ in
            try? await Task.sleep(for: .seconds(10))
            return "m-1"
        },
        socketFactory: { box.open($0, mac: mac) }
    )
    let started = ContinuousClock.now
    let result = try await client.connect(
        record: await mac.record(), devicePsk: mac.devicePsk,
        phoneNoisePriv: X25519KeyPair.generate().privateKey,
        deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation
    )
    #expect(result.path == hostedRelay)
    #expect(ContinuousClock.now - started < .seconds(5))
}

// MARK: - Hello outcomes, re-entry, unknown frames, watch credit

fileprivate struct HelloCase: Sendable, CustomTestStringConvertible {
    let code: String
    let refused: Bool
    var testDescription: String { code }
}

@Test("Only a hello refusing this device's standing is a refusal; any other hello error is unreachable", arguments: [
    HelloCase(code: "standing_revoked", refused: true),
    HelloCase(code: "device_revoked", refused: true),
    HelloCase(code: "not_found", refused: false),
    HelloCase(code: "deadline_exceeded", refused: false),
    HelloCase(code: "handler_error", refused: false),
    HelloCase(code: "invalid_response", refused: false),
    HelloCase(code: "memory_limit", refused: false),
])
fileprivate func helloErrorMapping(_ c: HelloCase) async throws {
    let h = try Harness()
    await h.mac.setHelloError(code: c.code, message: "no")
    do {
        _ = try await h.connectResult(paths: [hostedRelay])
        Issue.record("expected a failure")
    } catch let error as CompanionConnectionError {
        switch error {
        case .refused(let reason):
            #expect(c.refused)
            #expect(reason == (c.code == "standing_revoked" ? "account_revoked" : c.code))
        case .unreachable: #expect(!c.refused)
        case .closed, .damaged: Issue.record("expected a verdict, got \(error)")
        }
    }
    #expect(await h.client.isConnected == false)
}

@Test("A hello the Mac never answers runs out on its own deadline as unreachable")
func helloOwnDeadline() async throws {
    let h = try Harness(timing: .init(connect: .seconds(5), call: .seconds(30), hello: .milliseconds(100)))
    await h.mac.holdNextHello()
    let started = ContinuousClock.now
    await #expect(throws: CompanionConnectionError.unreachable(.generic)) {
        _ = try await h.connectResult(paths: [hostedRelay])
    }
    #expect(ContinuousClock.now - started < .seconds(5))
    #expect(await h.client.isConnected == false)
}

@Test("A connect started while an older one waits on its hello wins; the older one ends as closed")
func connectReenteredDuringHello() async throws {
    let h = try Harness()
    await h.mac.holdNextHello()
    let first = Task { try await h.connectResult(paths: [hostedRelay]) }
    await h.mac.helloHeld.wait()
    let second = try await h.connectResult(paths: [hostedRelay])
    #expect(second.hello.deviceId == "dev-1")
    await #expect(throws: CompanionConnectionError.closed) { _ = try await first.value }
    #expect(await h.client.isConnected)
    #expect(h.box.requests.count == 2)
    // The winner's session still carries calls.
    await h.mac.set("ping.me", .result(#"{"name":"ok"}"#))
    #expect(try await h.client.call("ping.me", params: TaskParams(task: "t"), as: Small.self).name == "ok")
}

@Test("Disconnect while the direct paths are being probed ends the connect with no socket opened")
func disconnectDuringProbing() async throws {
    let mac = try FakeMac()
    let box = SocketBox()
    let probing = Signal()
    let release = Signal()
    let client = CompanionRelayClient(
        timing: .init(probe: .seconds(30)),
        healthProbe: { _, _ in
            await probing.fire()
            await release.wait()
            return "m-1"
        },
        socketFactory: { box.open($0, mac: mac) }
    )
    let record = await mac.record()
    let psk = mac.devicePsk
    let connecting = Task {
        try await client.connect(
            record: record, devicePsk: psk,
            phoneNoisePriv: X25519KeyPair.generate().privateKey,
            deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation
        )
    }
    await probing.wait()
    await client.disconnect()
    await release.fire()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await connecting.value }
    #expect(box.requests.isEmpty)
    #expect(await client.isConnected == false)
}

@Test("A frame of a type this build doesn't know is skipped; the session carries on")
func unknownFrameTypeIgnored() async throws {
    let h = try Harness()
    _ = try await h.connect()
    let lost = Flag(false)
    await h.client.setSessionEndHandler { _ in lost.set(true) }
    guard let socket = h.box.socket else { Issue.record("no socket"); return }
    var unknown = Data([0x7f])
    unknown.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
    unknown.append(contentsOf: [0xAB, 0xCD])
    await h.mac.pushRaw(unknown, socket)
    await h.mac.set("ping.me", .result(#"{"name":"ok"}"#))
    #expect(try await h.client.call("ping.me", params: TaskParams(task: "t"), as: Small.self).name == "ok")
    #expect(await h.client.isConnected)
    #expect(!lost.value)
}

@Test("A watch grants CREDIT only as its consumer takes chunks, one frame per batch of 8")
func watchCreditsOnConsumption() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("run.watch.subscribe", .watch((1...9).map { #"{"k":"say","at":"t","t":["r\#($0)"]}"# }))
    await h.mac.set("flush", .result(#"{"name":"flushed"}"#))
    struct RunParams: Encodable, Sendable { let run: String }
    let stream = try await h.client.watch(method: "run.watch.subscribe", params: RunParams(run: "41"))
    // Two round trips: the first lands after all nine chunks (same socket, in order); the second carries anything
    // the phone queued on their arrival to the Mac ahead of it.
    _ = try await h.client.call("flush", params: TaskParams(task: "a"), as: Small.self)
    _ = try await h.client.call("flush", params: TaskParams(task: "b"), as: Small.self)
    #expect(await h.mac.creditFrames[3] == nil)

    var iterator = stream.makeAsyncIterator()
    for _ in 0..<7 { #expect(try await iterator.next() != nil) }
    _ = try await h.client.call("flush", params: TaskParams(task: "c"), as: Small.self)
    #expect(await h.mac.creditFrames[3] == nil)

    #expect(try await iterator.next() != nil)
    #expect(try await iterator.next() != nil)
    _ = try await h.client.call("flush", params: TaskParams(task: "d"), as: Small.self)
    #expect(await h.mac.creditFrames[3] == 1)
    #expect(await h.mac.credits[3] == 8)
}

enum SocketModeArg: String, CaseIterable, Sendable, CustomTestStringConvertible {
    case dropBeforeReply, dropOnHello, garbageReply, closeBeforeReply, refused, refusedRevoked, stallBeforeReply, stallHello, stallOpen
    var mode: SocketMode {
        switch self {
        case .dropBeforeReply: return .dropBeforeReply
        case .dropOnHello: return .dropOnHello
        case .garbageReply: return .garbageReply
        case .closeBeforeReply: return .closeBeforeReply
        case .refused: return .relayRefusal(CompanionRelayRefusal(status: 401, code: "token_invalid"))
        case .refusedRevoked: return .relayRefusal(CompanionRelayRefusal(status: 403, code: "device_revoked"))
        case .stallBeforeReply: return .stallBeforeReply
        case .stallHello: return .stallHello
        case .stallOpen: return .stallOpen
        }
    }
    var testDescription: String { rawValue }
}
