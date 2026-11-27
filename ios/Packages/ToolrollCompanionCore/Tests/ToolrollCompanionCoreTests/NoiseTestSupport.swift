import CryptoKit
import Foundation
@testable import ToolrollCompanionCore

// Test-only Noise pieces (G1): the responder (the fake Mac's side), explicit-nonce helpers for the vectors, a nonce
// setter, and the Mac-side derivations. None of these ship in the app's module.

extension NoiseCipherState {
    func setNonceForTest(_ value: UInt64) {
        nonce = value
    }

    func encryptExplicitNonce(_ explicitNonce: UInt64, ad: Data, plaintext: Data) throws -> Data {
        guard let key else { throw CompanionNoiseError.authenticationFailed }
        return try chachaEncrypt(key: key, nonce: explicitNonce, ad: ad, plaintext: plaintext)
    }

    func decryptExplicitNonce(_ explicitNonce: UInt64, ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { throw CompanionNoiseError.authenticationFailed }
        return try chachaDecrypt(key: key, nonce: explicitNonce, ad: ad, ciphertext: ciphertext)
    }
}

extension NoiseIKpsk2Initiator {
    convenience init(localStatic: X25519KeyPair, remoteStaticPublicKey: Data, psk: Data, prologue: Data, ephemeralForTest: X25519KeyPair?) throws {
        try self.init(localStatic: localStatic, remoteStaticPublicKey: remoteStaticPublicKey, psk: psk, prologue: prologue, fixedEphemeral: ephemeralForTest)
    }
}

final class NoiseIKpsk2Responder {
    private let sym: SymmetricState
    private let s: X25519KeyPair
    private let psk: Data
    private let fixedE: X25519KeyPair?
    private var re: Data?
    private var rsRemote: Data?
    private var step = 0

    init(
        localStatic: X25519KeyPair,
        psk: Data,
        prologue: Data,
        ephemeralForTest: X25519KeyPair? = nil
    ) throws {
        guard psk.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("psk", psk.count)
        }
        self.s = localStatic
        self.psk = psk
        self.fixedE = ephemeralForTest
        self.sym = SymmetricState(protocolName: CompanionNoiseConstants.protocolName)
        self.sym.mixHash(prologue)
        self.sym.mixHash(localStatic.publicKey)
    }

    func readMessage1(_ message: Data) throws -> (payload: Data, remoteStaticPublicKey: Data) {
        guard step == 0 else { throw CompanionNoiseError.outOfOrderHandshake }
        guard message.count >= 32 + 48 + CompanionNoiseConstants.aeadTagBytes,
              message.count <= CompanionNoiseConstants.maxMessageBytes
        else {
            throw CompanionNoiseError.invalidMessageLength(message.count)
        }
        let re = Data(message.prefix(32))
        let encS = Data(message.subdata(in: 32..<80))
        let encPayload = Data(message.dropFirst(80))
        sym.mixHash(re)
        try sym.mixKey(re)
        try sym.mixKey(x25519DH(privateKey: s.privateKey, publicKey: re))
        let rsRemote = try sym.decryptAndHash(encS)
        guard rsRemote.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("remoteStaticPublicKey", rsRemote.count)
        }
        try sym.mixKey(x25519DH(privateKey: s.privateKey, publicKey: rsRemote))
        let payload = try sym.decryptAndHash(encPayload)
        self.re = re
        self.rsRemote = rsRemote
        step = 1
        return (payload, rsRemote)
    }

    func writeMessage2(payload: Data, now: Date = Date()) throws -> (message: Data, session: NoiseTransportSession) {
        guard step == 1, let re, let rsRemote else { throw CompanionNoiseError.outOfOrderHandshake }
        let eph = fixedE ?? X25519KeyPair.generate()
        sym.mixHash(eph.publicKey)
        try sym.mixKey(eph.publicKey)
        try sym.mixKey(x25519DH(privateKey: eph.privateKey, publicKey: re))
        try sym.mixKey(x25519DH(privateKey: eph.privateKey, publicKey: rsRemote))
        try sym.mixKeyAndHash(psk)
        let encPayload = try sym.encryptAndHash(payload)
        var msg = Data(capacity: 32 + encPayload.count)
        msg.append(eph.publicKey)
        msg.append(encPayload)
        guard msg.count <= CompanionNoiseConstants.maxMessageBytes else {
            throw CompanionNoiseError.messageTooLarge(msg.count)
        }
        let (recvCipher, sendCipher) = try sym.split()
        step = 2
        let session = NoiseTransportSession(
            handshakeHash: sym.h,
            remoteStaticPublicKey: rsRemote,
            sendCipher: sendCipher,
            recvCipher: recvCipher,
            createdAt: now
        )
        return (msg, session)
    }
}

extension CompanionDerivations {
    static func deriveMachineId(relayMachinePublicKey: Data) throws -> String {
        guard relayMachinePublicKey.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("relayMachinePublicKey", relayMachinePublicKey.count)
        }
        var input = Data("toolroll-machine-id-v1\0".utf8)
        input.append(relayMachinePublicKey)
        let digest = sha256(input)
        return String(base32Encode(digest, alphabet: rfc4648LowerAlphabet).prefix(26))
    }

    static func derivePasskeyUserHandle(workspaceId: String, accountName: String) throws -> Data {
        guard !workspaceId.isEmpty, !workspaceId.contains("\0"),
              !accountName.isEmpty, !accountName.contains("\0")
        else {
            throw CompanionNoiseError.invalidInput("workspaceId/accountName")
        }
        return sha256(Data("toolroll-passkey-user-v1\0\(workspaceId)\0\(accountName)".utf8))
    }
}
