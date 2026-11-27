import Foundation
import Testing
@testable import ToolrollCompanionCore

/// Builds pairing codes for tests. Placeholder addresses and ids only.
enum PairingFixtures {
    static let key32 = CompanionRelayAuth.base64UrlEncode(Data(repeating: 7, count: 32))

    static let defaultPaths: [[String: String]] = [
        ["kind": "direct", "url": "ws://192.168.1.20:4199/v1/direct"],
        ["kind": "direct", "url": "ws://100.101.102.103:4199/v1/direct"],
        ["kind": "hosted", "url": "wss://relay.toolroll.invalid/v1/connect"],
    ]

    static func json(
        v: Int = 2,
        paths: [[String: String]] = defaultPaths,
        token: String? = "pct-1",
        edit: (inout [String: Any]) -> Void = { _ in }
    ) -> String {
        var object: [String: Any] = [
            "v": v, "paths": paths, "machineId": "m-1", "workspaceId": "ws-1",
            "macStaticPub": key32, "pairSessionId": "ps-1", "pairPsk": key32,
        ]
        if let token { object["pairConnToken"] = token }
        edit(&object)
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    static func direct(_ url: String) -> [String: String] { ["kind": "direct", "url": url] }
    static func hosted(_ url: String = "wss://relay.toolroll.invalid/v1/connect") -> [String: String] { ["kind": "hosted", "url": url] }
}

private func rejected(_ text: String) -> PairingPayloadError? {
    do {
        _ = try PairingQRPayload.parse(text)
        return nil
    } catch let error as PairingPayloadError {
        return error
    } catch {
        return .invalid("unexpected \(error)")
    }
}

private func isInvalid(_ text: String) -> Bool {
    if case .invalid = rejected(text) { return true }
    return false
}

@Test("A good v2 code parses, keeping the Mac's path order")
func goodPayload() throws {
    let qr = try PairingQRPayload.parse(PairingFixtures.json())
    #expect(qr.v == 2)
    #expect(qr.paths.map(\.kind) == [.direct, .direct, .hosted])
    #expect(qr.hostedPath?.host == "relay.toolroll.invalid")
    #expect(qr.pairConnToken == "pct-1")
}

@Test("A direct-only code needs no token, and may not carry one")
func directOnlyPayload() throws {
    let paths = [PairingFixtures.direct("ws://10.1.2.3:4199/v1/direct")]
    let qr = try PairingQRPayload.parse(PairingFixtures.json(paths: paths, token: nil))
    #expect(qr.hostedPath == nil)
    #expect(isInvalid(PairingFixtures.json(paths: paths, token: "pct-1")))
}

@Test("A v1 code says to update Toolroll on the Mac")
func v1Rejected() {
    let v1 = #"{"v":1,"relayUrl":"wss://relay.toolroll.invalid/v1/connect","machineId":"m-1","workspaceId":"ws-1","macStaticPub":"x","pairSessionId":"p","pairPsk":"y","pairConnToken":"t"}"#
    #expect(rejected(v1) == .olderToolroll)
    #expect(PairingPayloadError.olderToolroll.userMessage == "This QR code is from an older Toolroll — update Toolroll on your Mac.")
    #expect(rejected(PairingFixtures.json(v: 3)) == .newerToolroll)
    #expect(isInvalid("hello"))
}

@Test("Direct hosts must be private or Tailscale IPv4 literals", arguments: [
    "ws://8.8.8.8:4199/v1/direct",               // public
    "ws://172.32.0.1:4199/v1/direct",            // just outside 172.16/12
    "ws://100.128.0.1:4199/v1/direct",           // just outside 100.64/10
    "ws://my-mac.tailnet-name.ts.net:4199/v1/direct", // MagicDNS name
    "ws://studio.local:4199/v1/direct",          // mDNS name
    "ws://[fd7a:115c:a1e0::1]:4199/v1/direct",   // IPv6
    "ws://192.168.01.20:4199/v1/direct",         // leading zero
    "ws://192.168.1.20/v1/direct",               // no port
    "wss://192.168.1.20:4199/v1/direct",         // wrong scheme
    "ws://192.168.1.20:4199/v1/connect",         // wrong path
    "ws://192.168.1.20:4199/v1/direct?role=device", // query
    "ws://user@192.168.1.20:4199/v1/direct",     // userinfo
])
func badDirectRejected(_ url: String) {
    #expect(isInvalid(PairingFixtures.json(paths: [PairingFixtures.direct(url), PairingFixtures.hosted()])))
}

@Test("Private ranges at their edges are accepted", arguments: [
    "ws://10.0.0.1:4199/v1/direct", "ws://172.16.0.1:4199/v1/direct", "ws://172.31.255.254:4199/v1/direct",
    "ws://192.168.0.1:4199/v1/direct", "ws://100.64.0.1:4199/v1/direct", "ws://100.127.255.254:4199/v1/direct",
])
func privateEdgesAccepted(_ url: String) throws {
    _ = try PairingQRPayload.parse(PairingFixtures.json(paths: [PairingFixtures.direct(url)], token: nil))
}

@Test("Hosted must be last")
func hostedNotLastRejected() {
    let paths = [PairingFixtures.hosted(), PairingFixtures.direct("ws://192.168.1.20:4199/v1/direct")]
    #expect(isInvalid(PairingFixtures.json(paths: paths)))
}

@Test("At most four direct paths, five in all, one hosted, no duplicates, at least one")
func pathCountsEnforced() throws {
    let five = (1...5).map { PairingFixtures.direct("ws://10.0.0.\($0):4199/v1/direct") }
    #expect(isInvalid(PairingFixtures.json(paths: five, token: nil)))
    let four = Array(five.prefix(4))
    _ = try PairingQRPayload.parse(PairingFixtures.json(paths: four + [PairingFixtures.hosted()]))
    #expect(isInvalid(PairingFixtures.json(paths: [PairingFixtures.hosted(), PairingFixtures.hosted("wss://other.invalid/v1/connect")])))
    #expect(isInvalid(PairingFixtures.json(paths: [five[0], five[0], PairingFixtures.hosted()])))
    #expect(isInvalid(PairingFixtures.json(paths: [], token: nil)))
}

@Test("A hosted path needs the pair token")
func missingTokenRejected() {
    #expect(isInvalid(PairingFixtures.json(token: nil)))
    #expect(isInvalid(PairingFixtures.json(token: "")))
}

@Test("Hosted URLs: wss, or ws only to localhost; path /v1/connect", arguments: [
    ("wss://relay.toolroll.invalid/v1/connect", true),
    ("ws://127.0.0.1:8787/v1/connect", true),
    ("ws://localhost:8787/v1/connect", true),
    ("ws://relay.toolroll.invalid/v1/connect", false),
    ("wss://relay.toolroll.invalid/v1/direct", false),
    ("https://relay.toolroll.invalid/v1/connect", false),
])
func hostedRules(_ url: String, _ ok: Bool) {
    let text = PairingFixtures.json(paths: [PairingFixtures.hosted(url)])
    #expect((rejected(text) == nil) == ok)
}

@Test("Over-long URLs, unknown kinds and short keys are rejected")
func otherRules() {
    let long = "wss://" + String(repeating: "a", count: 190) + ".invalid/v1/connect"
    #expect(isInvalid(PairingFixtures.json(paths: [PairingFixtures.hosted(long)])))
    #expect(isInvalid(PairingFixtures.json(paths: [["kind": "carrier-pigeon", "url": "ws://10.0.0.1:4199/v1/direct"]], token: nil)))
    #expect(isInvalid(PairingFixtures.json { $0["pairPsk"] = CompanionRelayAuth.base64UrlEncode(Data(repeating: 1, count: 16)) }))
    #expect(isInvalid(PairingFixtures.json { $0.removeValue(forKey: "machineId") }))
}

@Test("Health and socket URLs are derived from the direct URL")
func derivedURLs() {
    #expect(CompanionPathRules.healthURL(forDirect: "ws://192.168.1.20:4199/v1/direct")?.absoluteString == "http://192.168.1.20:4199/v1/health")
    #expect(CompanionPathRules.directSocketURL("ws://192.168.1.20:4199/v1/direct", role: "device", id: "dev-1")?.absoluteString
        == "ws://192.168.1.20:4199/v1/direct?role=device&id=dev-1")
}

// MARK: - Pairing ownership

@Test("A late code or failure from scan A never touches scan B's pairing state")
func lateCallbacksFromOlderScanAreDropped() {
    var gate = CompanionPairingGate()
    let a = gate.begin()
    let b = gate.begin()
    #expect(gate.phase == .contacting)

    let lateCodeA = gate.codeReady("AAAAAA", attempt: a)
    let lateFailureA = gate.end(a)
    #expect(!lateCodeA && !lateFailureA)
    #expect(gate.phase == .contacting)
    #expect(gate.owns(b))

    let codeB = gate.codeReady("BBBBBB", attempt: b)
    #expect(codeB)
    let laterCodeA = gate.codeReady("AAAAAA", attempt: a)
    let laterEndA = gate.end(a)
    #expect(!laterCodeA && !laterEndA)
    #expect(gate.phase == .awaitingMacConfirm(code: "BBBBBB"))

    let endB = gate.end(b)
    let endBAgain = gate.end(b)
    #expect(endB && !endBAgain)
    #expect(gate.phase == .idle)
}

@Test("After Cancel, the cancelled scan's late code and failure are dropped")
func cancelledScanIsDropped() {
    var gate = CompanionPairingGate()
    let a = gate.begin()
    gate.cancel()
    let code = gate.codeReady("AAAAAA", attempt: a)
    let end = gate.end(a)
    #expect(!code && !end)
    #expect(gate.phase == .idle)
}

@Test("An out-of-range expiry in a scanned code is refused, never converted", arguments: [-1.0, 0.0, 1e15, 1e300])
func absurdExpiryRejected(expiresAtMs: Double) {
    #expect(isInvalid(PairingFixtures.json { $0["expiresAtMs"] = expiresAtMs }))
}

@Test("A plausible expiry parses")
func plausibleExpiryParses() throws {
    let qr = try PairingQRPayload.parse(PairingFixtures.json { $0["expiresAtMs"] = 1_800_000_000_000.0 })
    #expect(qr.expiresAtMs == 1_800_000_000_000)
}
