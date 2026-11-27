import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

private struct VectorFile: Decodable {
    let schema_version: Int
    let generator: String
    let protocol_name: String
    let handshakes: [HandshakeVector]
    let derivations: DerivationVectors
}

private struct HandshakeVector: Decodable {
    let name: String
    let protocolName: String
    let mode: String
    let workspace_id: String
    let pair_session_id: String?
    let device_id: String?
    let recovery_generation: String?
    let prologue_hex: String
    let init_static_priv_hex: String
    let init_static_pub_hex: String
    let init_ephemeral_priv_hex: String
    let resp_static_priv_hex: String
    let resp_static_pub_hex: String
    let resp_ephemeral_priv_hex: String
    let psk_hex: String
    let msg1_plaintext_utf8: String
    let msg1_hex: String
    let msg2_plaintext_utf8: String
    let msg2_hex: String
    let handshake_hash_hex: String
    let confirm_code: String?
    let psk_entropy_hex: String?
    let derived_device_psk_hex: String?
    let transport: [TransportMsg]

    enum CodingKeys: String, CodingKey {
        case name, mode, workspace_id, pair_session_id, device_id, recovery_generation
        case prologue_hex, init_static_priv_hex, init_static_pub_hex, init_ephemeral_priv_hex
        case resp_static_priv_hex, resp_static_pub_hex, resp_ephemeral_priv_hex
        case psk_hex, msg1_plaintext_utf8, msg1_hex, msg2_plaintext_utf8, msg2_hex
        case handshake_hash_hex, confirm_code, psk_entropy_hex, derived_device_psk_hex, transport
        case protocolName = "protocol"
    }
}

private struct TransportMsg: Decodable {
    let direction: String
    let nonce: String
    let plaintext_utf8: String
    let ciphertext_hex: String
}

private struct DerivationVectors: Decodable {
    let relay_machine_pub_hex: String
    let machine_id: String
    let workspace_id: String
    let account_name: String
    let passkey_user_handle_hex: String
}

private func hexToData(_ hex: String) -> Data {
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        let byte = UInt8(hex[index..<next], radix: 16)!
        data.append(byte)
        index = next
    }
    return data
}

private func dataToHex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func loadVectors() throws -> VectorFile {
    // Walk up from this test file to repository root.
    let fileURL = URL(fileURLWithPath: #filePath)
    let repoRoot = fileURL
        .deletingLastPathComponent() // ToolrollCompanionCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ToolrollCompanionCore
        .deletingLastPathComponent() // Packages
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repo root
    let vectorsURL = repoRoot.appendingPathComponent("test/fixtures/companion-noise/vectors.json")
    let raw = try Data(contentsOf: vectorsURL)
    return try JSONDecoder().decode(VectorFile.self, from: raw)
}

@Test("Swift Noise_IKpsk2_25519_ChaChaPoly_SHA256 matches canonical snow Revision 34 vectors byte-for-byte")
func matchesSnowVectors() throws {
    let vectors = try loadVectors()
    #expect(vectors.protocol_name == CompanionNoiseConstants.protocolName)

    for v in vectors.handshakes {
        let prologue: Data
        if v.mode == "pair" {
            prologue = try CompanionDerivations.pairingPrologue(
                workspaceId: v.workspace_id,
                pairSessionId: v.pair_session_id!
            )
        } else {
            prologue = try CompanionDerivations.sessionPrologue(
                workspaceId: v.workspace_id,
                deviceId: v.device_id!,
                recoveryGeneration: v.recovery_generation!
            )
        }
        #expect(dataToHex(prologue) == v.prologue_hex)

        let initStatic = try X25519KeyPair(privateKey: hexToData(v.init_static_priv_hex))
        #expect(dataToHex(initStatic.publicKey) == v.init_static_pub_hex)
        let respStatic = try X25519KeyPair(privateKey: hexToData(v.resp_static_priv_hex))
        #expect(dataToHex(respStatic.publicKey) == v.resp_static_pub_hex)

        let initEph = try X25519KeyPair(privateKey: hexToData(v.init_ephemeral_priv_hex))
        let respEph = try X25519KeyPair(privateKey: hexToData(v.resp_ephemeral_priv_hex))
        let psk = hexToData(v.psk_hex)

        let initiator = try NoiseIKpsk2Initiator(
            localStatic: initStatic,
            remoteStaticPublicKey: respStatic.publicKey,
            psk: psk,
            prologue: prologue,
            ephemeralForTest: initEph
        )
        let responder = try NoiseIKpsk2Responder(
            localStatic: respStatic,
            psk: psk,
            prologue: prologue,
            ephemeralForTest: respEph
        )

        let msg1 = try initiator.writeMessage1(payload: Data(v.msg1_plaintext_utf8.utf8))
        #expect(dataToHex(msg1) == v.msg1_hex)

        let r1 = try responder.readMessage1(msg1)
        #expect(String(data: r1.payload, encoding: .utf8) == v.msg1_plaintext_utf8)
        #expect(dataToHex(r1.remoteStaticPublicKey) == v.init_static_pub_hex)

        let (msg2, respSession) = try responder.writeMessage2(payload: Data(v.msg2_plaintext_utf8.utf8))
        #expect(dataToHex(msg2) == v.msg2_hex)

        let (p2, initSession) = try initiator.readMessage2(msg2)
        #expect(String(data: p2, encoding: .utf8) == v.msg2_plaintext_utf8)
        #expect(dataToHex(initSession.handshakeHash) == v.handshake_hash_hex)
        #expect(dataToHex(respSession.handshakeHash) == v.handshake_hash_hex)

        if let expectedCode = v.confirm_code {
            #expect(try CompanionDerivations.confirmationCode(handshakeHash: initSession.handshakeHash) == expectedCode)
        }
        if let entHex = v.psk_entropy_hex, let expectedPskHex = v.derived_device_psk_hex {
            let derived = try CompanionDerivations.deriveDevicePsk(
                pskEntropy: hexToData(entHex),
                handshakeHash: initSession.handshakeHash,
                workspaceId: v.workspace_id,
                deviceId: "dev_11223344"
            )
            #expect(dataToHex(derived) == expectedPskHex)
        }

        for tm in v.transport {
            let nonce = UInt64(tm.nonce)!
            let pt = Data(tm.plaintext_utf8.utf8)
            let expectedCt = hexToData(tm.ciphertext_hex)
            if tm.direction == "i2r" {
                let ct = try initSession.sendCipher.encryptExplicitNonce(nonce, ad: Data(), plaintext: pt)
                #expect(dataToHex(ct) == tm.ciphertext_hex)
                let dec = try respSession.recvCipher.decryptExplicitNonce(nonce, ad: Data(), ciphertext: expectedCt)
                #expect(String(data: dec, encoding: .utf8) == tm.plaintext_utf8)
            } else {
                let ct = try respSession.sendCipher.encryptExplicitNonce(nonce, ad: Data(), plaintext: pt)
                #expect(dataToHex(ct) == tm.ciphertext_hex)
                let dec = try initSession.recvCipher.decryptExplicitNonce(nonce, ad: Data(), ciphertext: expectedCt)
                #expect(String(data: dec, encoding: .utf8) == tm.plaintext_utf8)
            }
        }
    }

    // Derivation vectors
    #expect(try CompanionDerivations.deriveMachineId(relayMachinePublicKey: hexToData(vectors.derivations.relay_machine_pub_hex)) == vectors.derivations.machine_id)
    #expect(dataToHex(try CompanionDerivations.derivePasskeyUserHandle(workspaceId: vectors.derivations.workspace_id, accountName: vectors.derivations.account_name)) == vectors.derivations.passkey_user_handle_hex)
}

@Test("Swift enforces reserved nonce 2^64-1, 65,535 B ceiling, 2^20 rekey, and framing split/round-trip")
func enforcesSecurityBounds() throws {
    #expect(throws: CompanionNoiseError.nonceExhaustedOrReserved) {
        _ = try encodeNoiseNonce(UInt64.max)
    }

    let initStatic = X25519KeyPair.generate()
    let respStatic = X25519KeyPair.generate()
    let psk = Data(repeating: 0x33, count: 32)
    let p1 = try CompanionDerivations.sessionPrologue(workspaceId: "ws_1", deviceId: "dev_1", recoveryGeneration: String(repeating: "a", count: 32))
    let p2 = try CompanionDerivations.sessionPrologue(workspaceId: "ws_1", deviceId: "dev_1", recoveryGeneration: String(repeating: "b", count: 32))

    // Recovery generation mismatch rejected
    let iBad = try NoiseIKpsk2Initiator(localStatic: initStatic, remoteStaticPublicKey: respStatic.publicKey, psk: psk, prologue: p1)
    let rBad = try NoiseIKpsk2Responder(localStatic: respStatic, psk: psk, prologue: p2)
    let m1Bad = try iBad.writeMessage1(payload: Data("hi".utf8))
    #expect(throws: CompanionNoiseError.authenticationFailed) {
        _ = try rBad.readMessage1(m1Bad)
    }

    // Oversized message & rekey cap
    let i = try NoiseIKpsk2Initiator(localStatic: initStatic, remoteStaticPublicKey: respStatic.publicKey, psk: psk, prologue: p1)
    let r = try NoiseIKpsk2Responder(localStatic: respStatic, psk: psk, prologue: p1)
    _ = try r.readMessage1(try i.writeMessage1(payload: Data("hi".utf8)))
    let (m2, _) = try r.writeMessage2(payload: Data("ok".utf8))
    let (_, session) = try i.readMessage2(m2)
    #expect(throws: CompanionNoiseError.messageTooLarge(CompanionNoiseConstants.maxPlaintextBytes + 1)) {
        _ = try session.encrypt(Data(count: CompanionNoiseConstants.maxPlaintextBytes + 1))
    }
    session.sendCipher.setNonceForTest(CompanionNoiseConstants.maxSessionMessages)
    #expect(session.isExpired())

    // Framing 256 KiB split & round-trip
    let big = Data(repeating: 0x5a, count: CompanionFramingConstants.maxLogicalRequestBytes)
    let frames = try CompanionFrame.splitRequest(streamId: 1, payload: big)
    #expect(frames.count == 6)
    var reassembled = Data()
    for f in frames {
        let encoded = try f.encode()
        #expect(encoded.count <= CompanionNoiseConstants.maxPlaintextBytes)
        let decoded = try CompanionFrame.decode(encoded)
        #expect(decoded == f)
        if decoded.type == .reqChunk {
            reassembled.append(decoded.payload)
        }
    }
    #expect(reassembled == big)
}
