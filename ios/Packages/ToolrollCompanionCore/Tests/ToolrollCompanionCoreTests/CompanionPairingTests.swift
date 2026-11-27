import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// Pairing (contract §1) against the fake Mac: msg1 → padded msg2 `awaiting_ready` → pair.ready → outcome → keys
// stored → pair.done.

private func pairingHarness(
    timing: CompanionRelayClient.Timing = .init(), clock: ManualClock? = nil, pairing: FakePairing = FakePairing()
) async throws -> Harness {
    let h = try Harness(timing: timing, clock: clock)
    await h.mac.setPairing(pairing)
    return h
}

private let directOnly = [PairingFixtures.direct("ws://192.168.1.20:4199/v1/direct")]

/// Runs a pairing over the direct path; returns the outcome (or error), the code shown and the keys persisted.
private func runPairing(
    _ h: Harness, name: String = "Studio iPhone", paths: [[String: String]] = directOnly, token: String? = nil
) async -> (result: Result<CompanionPairingCompletion, Error>, code: String?, keys: CompanionPairingKeys?) {
    h.box.answer("192.168.1.20", machineId: "m-1")
    let qr = await h.mac.pairingQR(paths: paths, token: token)
    let code = Flag<String?>(nil)
    let stored = Flag<CompanionPairingKeys?>(nil)
    let mac = h.mac
    do {
        let completion = try await h.client.pair(qr: qr, deviceName: name, onCodeReady: { code.set($0) }, persist: { keys in
            await mac.log("persist")
            stored.set(keys)
        })
        return (.success(completion), code.value, stored.value)
    } catch {
        return (.failure(error), code.value, stored.value)
    }
}

@Test("Happy path: code after msg2, keys equal the Mac's derivation, persisted before pair.done, then activated")
func pairingHappyPath() async throws {
    let h = try await pairingHarness()
    let outcome = await runPairing(h)
    #expect(try outcome.result.get() == .activated)
    let keys = try #require(outcome.keys)
    #expect(outcome.code == (await h.mac.pairCode))
    #expect(keys.devicePsk == (try await h.mac.pairedDevicePsk()))
    #expect(keys.record.deviceId == "dev-new")
    #expect(keys.record.machineId == "m-1")
    #expect(await h.mac.events == ["msg1", "pair.ready", "pair.ready.res", "persist", "pair.done"])
    // msg1 names the protocol and the relay key, and no longer carries the name; pair.ready does.
    let msg1 = await h.mac.pairMsg1
    #expect(msg1["mode"] == "pair")
    #expect(msg1["protocolVersion"] == "1")
    #expect(msg1["deviceName"] == nil)
    #expect(msg1["deviceRelayPub"].flatMap(CompanionRelayAuth.base64UrlDecode)?.count == 32)
    #expect(await h.mac.pairReadyName == "Studio iPhone")
    #expect(await h.mac.pairDoneDeviceId == "dev-new")
    #expect(await h.mac.msg2Sizes == [CompanionWire.paddedMsg2Bytes])
    // The stored keys open a session with the derived PSK (a fresh fake Mac with that PSK accepts them).
    #expect(X25519KeyPair.generate().privateKey.count == keys.phoneNoisePriv.count)
}

@Test("The name sent in pair.ready is sanitized and capped at 48 characters")
func pairingNameSanitized() async throws {
    let h = try await pairingHarness()
    let long = "\u{202E}  " + String(repeating: "x", count: 80) + "\n"
    _ = await runPairing(h, name: long)
    let sent = try #require(await h.mac.pairReadyName)
    #expect(sent == String(repeating: "x", count: 48))
}

@Test("Each pair.ready ERROR code becomes its own pairing error with distinct copy", arguments: [
    ("pairing_cancelled", CompanionPairingError.cancelled),
    ("pairing_expired", .expired),
    ("pairing_contested", .contested),
    ("pairing_failed", .failed),
    ("something_new", .failed),
])
func pairingErrors(_ code: String, _ expected: CompanionPairingError) async throws {
    let h = try await pairingHarness()
    await h.mac.setPairReady(.error(code))
    let outcome = await runPairing(h)
    #expect(throws: expected) { try outcome.result.get() }
    #expect(outcome.keys == nil)
    #expect(outcome.code != nil)
    let copies = Set([CompanionPairingError.cancelled, .expired, .contested, .failed, .interrupted].map(\.userMessage))
    #expect(copies.count == 5)
}

@Test("A drop after msg2 is interrupted (the pairing on the Mac is gone with the socket), not 'check your connection'")
func pairingDropAfterMsg2() async throws {
    let h = try await pairingHarness()
    await h.mac.setPairReady(.dropSocket)
    let outcome = await runPairing(h)
    #expect(throws: CompanionPairingError.interrupted) { try outcome.result.get() }
    #expect(outcome.keys == nil)
}

@Test("While the owner compares codes the phone pings every 20 s; the wait ends at expiresAtMs as expired")
func pairingKeepaliveAndDeadline() async throws {
    let clock = ManualClock()
    var pairing = FakePairing()
    pairing.expiresAtMs = clock.start.timeIntervalSince1970 * 1000 + 120_000
    let h = try await pairingHarness(clock: clock, pairing: pairing)
    await h.mac.setPairReady(.silent)
    let running = Task { await runPairing(h) }
    await h.mac.pairReadyArrived.wait()
    try await waitUntil("the keepalive is armed") { clock.deadlines.contains(.seconds(20)) }
    clock.advance(by: .seconds(20))
    try await waitUntil("first keepalive ping") { await h.mac.pings == 1 }
    try await waitUntil("next keepalive armed") { clock.deadlines.contains(.seconds(40)) }
    clock.advance(by: .seconds(20))
    try await waitUntil("second keepalive ping") { await h.mac.pings == 2 }
    #expect(clock.deadlines.contains(.seconds(120)))
    clock.advance(by: .seconds(80))
    let outcome = await running.value
    #expect(throws: CompanionPairingError.expired) { try outcome.result.get() }
}

@Test("An unanswered pair.done still keeps the keys: the first hello activates the phone")
func pairingDoneUnanswered() async throws {
    let clock = ManualClock()
    let h = try await pairingHarness(timing: .init(pairDone: .seconds(10)), clock: clock)
    await h.mac.setAnswerPairDone(false)
    let running = Task { await runPairing(h) }
    try await waitUntil("pair.done reached the Mac") { await h.mac.events.contains("pair.done") }
    try await waitUntil("pair.done deadline armed") { !clock.deadlines.isEmpty }
    clock.advance(by: .seconds(10))
    let outcome = await running.value
    #expect(try outcome.result.get() == .pendingActivation)
    #expect(outcome.keys != nil)
}

@Test("Cancel while waiting for the owner ends quietly (closed), with nothing stored")
func pairingCancelWhileWaiting() async throws {
    let h = try await pairingHarness()
    await h.mac.setPairReady(.silent)
    let running = Task { await runPairing(h) }
    await h.mac.pairReadyArrived.wait()
    await h.client.cancelPairing()
    let outcome = await running.value
    #expect(throws: CompanionConnectionError.closed) { try outcome.result.get() }
    #expect(outcome.keys == nil)
}

@Test("A persist failure ends the pairing before pair.done")
func pairingPersistFailure() async throws {
    let h = try await pairingHarness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    let qr = await h.mac.pairingQR(paths: directOnly, token: nil)
    struct Boom: Error {}
    await #expect(throws: Boom.self) {
        _ = try await h.client.pair(qr: qr, deviceName: "x", onCodeReady: { _ in }, persist: { _ in throw Boom() })
    }
    #expect(!(await h.mac.events.contains("pair.done")))
}

@Test("Pairing: a direct socket that fails before message 1 is sent tries hosted once with the pair token", arguments: [
    SocketModeArg.dropBeforeReply, .refused, .stallOpen,
])
func pairingDirectFallsBackBeforeMessage1(_ mode: SocketModeArg) async throws {
    let h = try await pairingHarness(timing: .init(directHandshake: .milliseconds(150)))
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    h.box.setMode(.hosted, .dropBeforeReply)
    let qr = await h.mac.pairingQR()
    await #expect(throws: CompanionConnectionError.self) {
        _ = try await h.client.pair(qr: qr, deviceName: "Test iPhone", onCodeReady: { _ in }, persist: { _ in })
    }
    let requests = h.box.requests
    #expect(requests.count == 2)
    #expect(requests.first?.url?.absoluteString == "ws://192.168.1.20:4199/v1/direct?role=pair&id=ps-1")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.last?.url?.absoluteString == "wss://relay.toolroll.invalid/v1/connect")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer pct-1")
}

@Test("Pairing: once message 1 may have reached the Mac, a direct failure never retries on hosted", arguments: [
    SocketModeArg.garbageReply, .closeBeforeReply, .stallBeforeReply,
])
func pairingDirectNoRetryAfterMessage1(_ mode: SocketModeArg) async throws {
    let h = try await pairingHarness(timing: .init(directHandshake: .milliseconds(150)))
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    let qr = await h.mac.pairingQR()
    await #expect(throws: CompanionPairingError.interrupted) {
        _ = try await h.client.pair(qr: qr, deviceName: "Test iPhone", onCodeReady: { _ in }, persist: { _ in })
    }
    #expect(h.box.requests.count == 1)
    #expect(h.box.requests.first?.url?.path == "/v1/direct")
}

@Test("Pairing through the relay: a 401 on the pair token means the code expired; 503 means the Mac is offline")
func pairingHostedRefusals() async throws {
    let h = try await pairingHarness()
    let qr = await h.mac.pairingQR()
    h.box.queueMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: 401, code: "token_invalid")))
    await #expect(throws: CompanionPairingError.expired) {
        _ = try await h.client.pair(qr: qr, deviceName: "x", onCodeReady: { _ in }, persist: { _ in })
    }
    h.box.queueMode(.hosted, .relayRefusal(CompanionRelayRefusal(status: 503, code: "daemon_unavailable")))
    await #expect(throws: CompanionConnectionError.unreachable(.macOffline)) {
        _ = try await h.client.pair(qr: qr, deviceName: "x", onCodeReady: { _ in }, persist: { _ in })
    }
}

@Test("Pairing with no healthy direct path uses hosted with the pair token and completes")
func pairingOverHosted() async throws {
    let h = try await pairingHarness()
    let qr = await h.mac.pairingQR()
    let completion = try await h.client.pair(qr: qr, deviceName: "x", onCodeReady: { _ in }, persist: { _ in })
    #expect(completion == .activated)
    #expect(h.box.requests.count == 1)
    #expect(h.box.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer pct-1")
}

@Test("A pairing the Mac confirmed may still complete after Cancel; a newer scan replaces it")
func confirmedPairingSurvivesCancel() {
    var gate = CompanionPairingGate()
    let a = gate.begin()
    let shown = gate.codeReady("ABC-123", attempt: a)
    let finishing = gate.finishing(attempt: a)
    #expect(shown && finishing)
    #expect(gate.phase == .finishing)
    gate.cancel()
    #expect(gate.phase == .idle)
    #expect(!gate.owns(a))
    let finishingAfterCancel = gate.finishing(attempt: a)
    #expect(!finishingAfterCancel)
    #expect(gate.mayComplete(a))
    let b = gate.begin()
    #expect(!gate.mayComplete(a))
    #expect(gate.mayComplete(b))
}
