import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// test/fixtures/companion-wire.json is the frozen contract Node and Swift both read: a change on one side that the
// other doesn't follow fails here.

private struct Wire: Decodable {
    struct Msg2: Decodable {
        let paddedPlaintextBytes: Int
        let padField: String
        let statuses: [String: [String]]
        let refusedReasons: [String]
    }
    struct Stream: Decodable {
        let stream: UInt32
        let method: String
    }
    struct Pairing: Decodable {
        let keepalivePingMs: Int
        let ready: Stream
        let readyErrors: [String]
        let done: Stream
    }
    struct Session: Decodable {
        let stream0Errors: [String]
    }
    struct Refusal: Decodable {
        let status: Int
        let code: String
    }
    struct Token: Decodable {
        let claims: [String]
        let maxTtlSec: Int
        let jtiPattern: String
    }
    struct Relay: Decodable {
        let errorHeader: String
        let refusals: [Refusal]
        let phoneTerminalCodes: [String]
        let token: Token
    }
    struct Mac: Decodable {
        let bonjourService: String
        let bonjourMachineIdTxtKey: String
    }
    let protocolVersion: Int
    let msg2: Msg2
    let pairing: Pairing
    let session: Session
    let relay: Relay
    let mac: Mac
}

private func wire() throws -> Wire {
    try JSONDecoder().decode(Wire.self, from: repoFixture("companion-wire.json"))
}

@Test("msg2: the padded size, pad field and every status/reason parse as the fixture says")
func wireMsg2() throws {
    let w = try wire()
    #expect(w.protocolVersion == CompanionWire.protocolVersion)
    #expect(w.msg2.paddedPlaintextBytes == CompanionWire.paddedMsg2Bytes)
    #expect(w.msg2.padField == CompanionWire.padField)
    for status in w.msg2.statuses["pair"] ?? [] {
        let payload = try CompanionHandshakeReply.padded(["protocolVersion": 1, "status": status])
        #expect(payload.count == w.msg2.paddedPlaintextBytes)
        #expect(try CompanionHandshakeReply.parse(payload, mode: .pair) == .awaitingReady)
    }
    for status in w.msg2.statuses["session"] ?? [] {
        for reason in status == "refused" ? w.msg2.refusedReasons : [""] {
            var fields: [String: Any] = ["protocolVersion": 1, "status": status]
            if !reason.isEmpty { fields["reason"] = reason }
            let payload = try CompanionHandshakeReply.padded(fields)
            #expect(payload.count == w.msg2.paddedPlaintextBytes)
            let parsed = try CompanionHandshakeReply.parse(payload, mode: .session)
            #expect(parsed == (status == "refused" ? .refused(reason: reason) : .awaitingHello))
        }
    }
    // A status from the other mode, or another protocol version, is a mismatch.
    #expect(throws: CompanionHandshakeReply.Mismatch.self) {
        _ = try CompanionHandshakeReply.parse(Data(#"{"protocolVersion":1,"status":"awaiting_hello"}"#.utf8), mode: .pair)
    }
    #expect(throws: CompanionHandshakeReply.Mismatch.self) {
        _ = try CompanionHandshakeReply.parse(Data(#"{"protocolVersion":2,"status":"awaiting_hello"}"#.utf8), mode: .session)
    }
}

@Test("Pairing: streams, methods, keepalive and every ready error have a home")
func wirePairing() throws {
    let w = try wire()
    #expect(w.pairing.ready.stream == CompanionWire.pairReadyStream)
    #expect(w.pairing.ready.method == "pair.ready")
    #expect(w.pairing.done.stream == CompanionWire.pairDoneStream)
    #expect(w.pairing.done.method == "pair.done")
    #expect(Duration.milliseconds(w.pairing.keepalivePingMs) == CompanionWire.pairingKeepalive)
    let mapped = w.pairing.readyErrors.map(CompanionPairingError.init(code:))
    #expect(mapped == [.cancelled, .expired, .contested, .failed])
}

@Test("Session: every stream-0 code is one the client handles")
func wireSession() throws {
    let w = try wire()
    #expect(Set(w.session.stream0Errors) == [
        CompanionStreamZeroCode.deviceRevoked, CompanionStreamZeroCode.accountRevoked, CompanionStreamZeroCode.rekey,
    ])
}

@Test("Relay: the header name, and only the fixture's terminal codes are terminal")
func wireRelay() throws {
    let w = try wire()
    #expect(w.relay.errorHeader == CompanionWire.relayErrorHeader)
    for refusal in w.relay.refusals {
        let parsed = CompanionRelayRefusal(status: refusal.status, headers: [w.relay.errorHeader: refusal.code])
        #expect(parsed.code == refusal.code)
        #expect(parsed.isTerminal == w.relay.phoneTerminalCodes.contains(refusal.code), "\(refusal.code)")
        #expect(parsed.isClockSkew == (refusal.code == "token_expired" || refusal.code == "token_not_yet_valid"))
    }
}

@Test("Relay token: the phone's claims are a subset of the contract's, within its TTL")
func wireToken() throws {
    let w = try wire()
    let key = Curve25519.Signing.PrivateKey()
    let token = try CompanionRelayAuth.signDeviceToken(
        privateKey: key, machineId: "abcdefghijklmnopqrstuvwxyz", deviceId: "dev-1", audience: "relay.invalid"
    )
    var request = URLRequest(url: URL(string: "wss://relay.invalid/v1/connect")!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let claims = try #require(tokenClaims(request))
    #expect(Set(claims.keys).isSubset(of: Set(w.relay.token.claims)))
    #expect(claims["htm"] == nil && claims["htu"] == nil)
    let iat = try #require(claims["iat"] as? Int), exp = try #require(claims["exp"] as? Int)
    #expect(exp - iat <= w.relay.token.maxTtlSec)
    let jti = try #require(claims["jti"] as? String)
    #expect(jti.range(of: w.relay.token.jtiPattern, options: .regularExpression) != nil)
}

@Test("Bonjour: service type and TXT key match the Mac's")
func wireBonjour() throws {
    let w = try wire()
    #expect(w.mac.bonjourService == CompanionWire.bonjourService)
    #expect(w.mac.bonjourMachineIdTxtKey == CompanionWire.bonjourMachineIdKey)
}
