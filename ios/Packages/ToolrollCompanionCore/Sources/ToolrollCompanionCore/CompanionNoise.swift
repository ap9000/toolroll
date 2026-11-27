import CryptoKit
import Foundation

/// Noise Protocol Framework (Revision 34) — `Noise_IKpsk2_25519_ChaChaPoly_SHA256`
/// plus Toolroll companion key/ID derivations and RFC 8291 `aes128gcm` push decryption.
///
/// Built over Apple `CryptoKit` primitives with strict `UInt64` nonces and verified byte-for-byte
/// against independent Revision 34 `snow` test vectors in `test/fixtures/companion-noise/vectors.json`.
public enum CompanionNoiseConstants {
    public static let protocolName = "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
    public static let maxMessageBytes = 65_535
    public static let aeadTagBytes = 16
    public static let maxPlaintextBytes = maxMessageBytes - aeadTagBytes // 65_519
    public static let reservedMaxNonce: UInt64 = UInt64.max
    public static let maxSessionMessages: UInt64 = 1 << 20 // 1_048_576
    public static let maxSessionAgeSeconds: TimeInterval = 24 * 60 * 60
}

public enum CompanionNoiseError: Error, Equatable, Sendable {
    case invalidKeyLength(String, Int)
    case lowOrderPublicKey
    case nonceExhaustedOrReserved
    case sessionLimitReached
    case sessionExpired
    case sessionClosed
    case messageTooLarge(Int)
    case invalidMessageLength(Int)
    case outOfOrderHandshake
    case authenticationFailed
    case invalidInput(String)
}

public struct X25519KeyPair: Sendable {
    public let privateKey: Data // 32 raw bytes
    public let publicKey: Data // 32 raw bytes

    public init(privateKey: Data) throws {
        guard privateKey.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("privateKey", privateKey.count)
        }
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        self.privateKey = priv.rawRepresentation
        self.publicKey = priv.publicKey.rawRepresentation
    }

    public static func generate() -> X25519KeyPair {
        let priv = Curve25519.KeyAgreement.PrivateKey()
        return try! X25519KeyPair(privateKey: priv.rawRepresentation)
    }
}

private func x25519DH(privateKey: Data, publicKey: Data) throws -> Data {
    guard privateKey.count == 32 else {
        throw CompanionNoiseError.invalidKeyLength("privateKey", privateKey.count)
    }
    guard publicKey.count == 32 else {
        throw CompanionNoiseError.invalidKeyLength("publicKey", publicKey.count)
    }
    let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
    let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
    let raw = shared.withUnsafeBytes { Data($0) }
    // RFC 7748 §6.1: reject all-zero shared secret from low-order points.
    if raw.allSatisfy({ $0 == 0 }) {
        throw CompanionNoiseError.lowOrderPublicKey
    }
    return raw
}

private func sha256(_ data: Data) -> Data {
    Data(SHA256.hash(data: data))
}

private func hmacSHA256(key: Data, data: Data) -> Data {
    let sym = SymmetricKey(data: key)
    return Data(HMAC<SHA256>.authenticationCode(for: data, using: sym))
}

/// Noise Protocol Framework Rev 34 §4.3 HKDF(ck, ikm, 2 or 3).
private func noiseHKDF2(ck: Data, ikm: Data) -> (Data, Data) {
    let tempKey = hmacSHA256(key: ck, data: ikm)
    let out1 = hmacSHA256(key: tempKey, data: Data([0x01]))
    var d2 = out1
    d2.append(0x02)
    let out2 = hmacSHA256(key: tempKey, data: d2)
    return (out1, out2)
}

private func noiseHKDF3(ck: Data, ikm: Data) -> (Data, Data, Data) {
    let tempKey = hmacSHA256(key: ck, data: ikm)
    let out1 = hmacSHA256(key: tempKey, data: Data([0x01]))
    var d2 = out1
    d2.append(0x02)
    let out2 = hmacSHA256(key: tempKey, data: d2)
    var d3 = out2
    d3.append(0x03)
    let out3 = hmacSHA256(key: tempKey, data: d3)
    return (out1, out2, out3)
}

/// 12-byte Noise ChaChaPoly nonce: 4 zero bytes || uint64_le(n).
public func encodeNoiseNonce(_ n: UInt64) throws -> ChaChaPoly.Nonce {
    guard n < CompanionNoiseConstants.reservedMaxNonce else {
        throw CompanionNoiseError.nonceExhaustedOrReserved
    }
    var bytes = Data(count: 12)
    var le = n.littleEndian
    withUnsafeBytes(of: &le) { src in
        bytes.replaceSubrange(4..<12, with: src)
    }
    return try ChaChaPoly.Nonce(data: bytes)
}

private func chachaEncrypt(key: Data, nonce: UInt64, ad: Data, plaintext: Data) throws -> Data {
    guard plaintext.count <= CompanionNoiseConstants.maxPlaintextBytes else {
        throw CompanionNoiseError.messageTooLarge(plaintext.count)
    }
    let iv = try encodeNoiseNonce(nonce)
    let sym = SymmetricKey(data: key)
    let sealed = try ChaChaPoly.seal(plaintext, using: sym, nonce: iv, authenticating: ad)
    var out = Data(capacity: sealed.ciphertext.count + sealed.tag.count)
    out.append(sealed.ciphertext)
    out.append(sealed.tag)
    return out
}

private func chachaDecrypt(key: Data, nonce: UInt64, ad: Data, ciphertext: Data) throws -> Data {
    guard ciphertext.count >= CompanionNoiseConstants.aeadTagBytes,
          ciphertext.count <= CompanionNoiseConstants.maxMessageBytes
    else {
        throw CompanionNoiseError.invalidMessageLength(ciphertext.count)
    }
    let iv = try encodeNoiseNonce(nonce)
    let body = ciphertext.prefix(ciphertext.count - CompanionNoiseConstants.aeadTagBytes)
    let tag = ciphertext.suffix(CompanionNoiseConstants.aeadTagBytes)
    let box = try ChaChaPoly.SealedBox(nonce: iv, ciphertext: body, tag: tag)
    do {
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
    } catch {
        throw CompanionNoiseError.authenticationFailed
    }
}

public final class NoiseCipherState: @unchecked Sendable {
    private var key: Data?
    public private(set) var nonce: UInt64 = 0
    private let maxMessages: UInt64

    public init(key: Data? = nil, maxMessages: UInt64 = CompanionNoiseConstants.maxSessionMessages) throws {
        if let key {
            guard key.count == 32 else {
                throw CompanionNoiseError.invalidKeyLength("cipherKey", key.count)
            }
            self.key = key
        }
        self.maxMessages = maxMessages
    }

    public func initializeKey(_ newKey: Data) throws {
        guard newKey.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("cipherKey", newKey.count)
        }
        self.key = newKey
        self.nonce = 0
    }

    public func setNonceForTest(_ value: UInt64) {
        self.nonce = value
    }

    public func encryptWithAd(_ ad: Data, plaintext: Data, enforceSessionCap: Bool = false) throws -> Data {
        guard let key else { return plaintext }
        guard nonce < CompanionNoiseConstants.reservedMaxNonce else {
            throw CompanionNoiseError.nonceExhaustedOrReserved
        }
        if enforceSessionCap && nonce >= maxMessages {
            throw CompanionNoiseError.sessionLimitReached
        }
        let ct = try chachaEncrypt(key: key, nonce: nonce, ad: ad, plaintext: plaintext)
        nonce += 1
        return ct
    }

    public func decryptWithAd(_ ad: Data, ciphertext: Data, enforceSessionCap: Bool = false) throws -> Data {
        guard let key else { return ciphertext }
        guard nonce < CompanionNoiseConstants.reservedMaxNonce else {
            throw CompanionNoiseError.nonceExhaustedOrReserved
        }
        if enforceSessionCap && nonce >= maxMessages {
            throw CompanionNoiseError.sessionLimitReached
        }
        let pt = try chachaDecrypt(key: key, nonce: nonce, ad: ad, ciphertext: ciphertext)
        nonce += 1
        return pt
    }

    public func encryptExplicitNonce(_ explicitNonce: UInt64, ad: Data, plaintext: Data) throws -> Data {
        guard let key else { throw CompanionNoiseError.authenticationFailed }
        return try chachaEncrypt(key: key, nonce: explicitNonce, ad: ad, plaintext: plaintext)
    }

    public func decryptExplicitNonce(_ explicitNonce: UInt64, ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { throw CompanionNoiseError.authenticationFailed }
        return try chachaDecrypt(key: key, nonce: explicitNonce, ad: ad, ciphertext: ciphertext)
    }
}

private final class SymmetricState {
    let cipher: NoiseCipherState
    var ck: Data
    var h: Data

    init(protocolName: String) {
        let nameBytes = Data(protocolName.utf8)
        if nameBytes.count <= 32 {
            var padded = nameBytes
            padded.append(Data(count: 32 - nameBytes.count))
            self.h = padded
        } else {
            self.h = sha256(nameBytes)
        }
        self.ck = self.h
        self.cipher = try! NoiseCipherState(key: nil)
    }

    func mixHash(_ data: Data) {
        var combined = Data(capacity: h.count + data.count)
        combined.append(h)
        combined.append(data)
        h = sha256(combined)
    }

    func mixKey(_ ikm: Data) throws {
        let (newCk, tempK) = noiseHKDF2(ck: ck, ikm: ikm)
        ck = newCk
        try cipher.initializeKey(tempK)
    }

    func mixKeyAndHash(_ ikm: Data) throws {
        let (newCk, tempH, tempK) = noiseHKDF3(ck: ck, ikm: ikm)
        ck = newCk
        mixHash(tempH)
        try cipher.initializeKey(tempK)
    }

    func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ct = try cipher.encryptWithAd(h, plaintext: plaintext)
        mixHash(ct)
        return ct
    }

    func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let pt = try cipher.decryptWithAd(h, ciphertext: ciphertext)
        mixHash(ciphertext)
        return pt
    }

    func split() throws -> (NoiseCipherState, NoiseCipherState) {
        let (k1, k2) = noiseHKDF2(ck: ck, ikm: Data())
        return (try NoiseCipherState(key: k1), try NoiseCipherState(key: k2))
    }
}

public final class NoiseTransportSession: @unchecked Sendable {
    public let handshakeHash: Data
    public let remoteStaticPublicKey: Data
    public let sendCipher: NoiseCipherState
    public let recvCipher: NoiseCipherState
    public let createdAt: Date
    private var closed = false

    public init(
        handshakeHash: Data,
        remoteStaticPublicKey: Data,
        sendCipher: NoiseCipherState,
        recvCipher: NoiseCipherState,
        createdAt: Date = Date()
    ) {
        self.handshakeHash = handshakeHash
        self.remoteStaticPublicKey = remoteStaticPublicKey
        self.sendCipher = sendCipher
        self.recvCipher = recvCipher
        self.createdAt = createdAt
    }

    public func isExpired(now: Date = Date()) -> Bool {
        closed
            || now.timeIntervalSince(createdAt) >= CompanionNoiseConstants.maxSessionAgeSeconds
            || sendCipher.nonce >= CompanionNoiseConstants.maxSessionMessages
            || recvCipher.nonce >= CompanionNoiseConstants.maxSessionMessages
    }

    public func close() {
        closed = true
    }

    public func encrypt(_ plaintext: Data, now: Date = Date()) throws -> Data {
        guard !closed else { throw CompanionNoiseError.sessionClosed }
        if now.timeIntervalSince(createdAt) >= CompanionNoiseConstants.maxSessionAgeSeconds {
            closed = true
            throw CompanionNoiseError.sessionExpired
        }
        guard plaintext.count <= CompanionNoiseConstants.maxPlaintextBytes else {
            throw CompanionNoiseError.messageTooLarge(plaintext.count)
        }
        do {
            return try sendCipher.encryptWithAd(Data(), plaintext: plaintext, enforceSessionCap: true)
        } catch {
            closed = true
            throw error
        }
    }

    public func decrypt(_ ciphertext: Data, now: Date = Date()) throws -> Data {
        guard !closed else { throw CompanionNoiseError.sessionClosed }
        if now.timeIntervalSince(createdAt) >= CompanionNoiseConstants.maxSessionAgeSeconds {
            closed = true
            throw CompanionNoiseError.sessionExpired
        }
        guard ciphertext.count <= CompanionNoiseConstants.maxMessageBytes else {
            closed = true
            throw CompanionNoiseError.messageTooLarge(ciphertext.count)
        }
        do {
            return try recvCipher.decryptWithAd(Data(), ciphertext: ciphertext, enforceSessionCap: true)
        } catch {
            closed = true
            throw error
        }
    }
}

public final class NoiseIKpsk2Initiator {
    private let sym: SymmetricState
    private let s: X25519KeyPair
    private let rs: Data
    private let psk: Data
    private let fixedE: X25519KeyPair?
    private var e: X25519KeyPair?
    private var step = 0

    public init(
        localStatic: X25519KeyPair,
        remoteStaticPublicKey: Data,
        psk: Data,
        prologue: Data,
        ephemeralForTest: X25519KeyPair? = nil
    ) throws {
        guard remoteStaticPublicKey.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("remoteStaticPublicKey", remoteStaticPublicKey.count)
        }
        guard psk.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("psk", psk.count)
        }
        self.s = localStatic
        self.rs = remoteStaticPublicKey
        self.psk = psk
        self.fixedE = ephemeralForTest
        self.sym = SymmetricState(protocolName: CompanionNoiseConstants.protocolName)
        self.sym.mixHash(prologue)
        self.sym.mixHash(rs)
    }

    /// Message 1: `-> e, es, s, ss`
    public func writeMessage1(payload: Data) throws -> Data {
        guard step == 0 else { throw CompanionNoiseError.outOfOrderHandshake }
        let eph = fixedE ?? X25519KeyPair.generate()
        self.e = eph
        // e (PSK handshake §9.2: MixHash then MixKey)
        sym.mixHash(eph.publicKey)
        try sym.mixKey(eph.publicKey)
        // es
        try sym.mixKey(x25519DH(privateKey: eph.privateKey, publicKey: rs))
        // s
        let encS = try sym.encryptAndHash(s.publicKey)
        // ss
        try sym.mixKey(x25519DH(privateKey: s.privateKey, publicKey: rs))
        // payload
        let encPayload = try sym.encryptAndHash(payload)
        var msg = Data(capacity: 32 + encS.count + encPayload.count)
        msg.append(eph.publicKey)
        msg.append(encS)
        msg.append(encPayload)
        guard msg.count <= CompanionNoiseConstants.maxMessageBytes else {
            throw CompanionNoiseError.messageTooLarge(msg.count)
        }
        step = 1
        return msg
    }

    /// Message 2: `<- e, ee, se, psk`
    public func readMessage2(_ message: Data, now: Date = Date()) throws -> (payload: Data, session: NoiseTransportSession) {
        guard step == 1, let eph = e else { throw CompanionNoiseError.outOfOrderHandshake }
        guard message.count >= 32 + CompanionNoiseConstants.aeadTagBytes,
              message.count <= CompanionNoiseConstants.maxMessageBytes
        else {
            throw CompanionNoiseError.invalidMessageLength(message.count)
        }
        let re = Data(message.prefix(32))
        let encPayload = Data(message.dropFirst(32))
        // e (PSK handshake §9.2)
        sym.mixHash(re)
        try sym.mixKey(re)
        // ee
        try sym.mixKey(x25519DH(privateKey: eph.privateKey, publicKey: re))
        // se
        try sym.mixKey(x25519DH(privateKey: s.privateKey, publicKey: re))
        // psk
        try sym.mixKeyAndHash(psk)
        // payload
        let payload = try sym.decryptAndHash(encPayload)
        let (sendCipher, recvCipher) = try sym.split()
        step = 2
        let session = NoiseTransportSession(
            handshakeHash: sym.h,
            remoteStaticPublicKey: rs,
            sendCipher: sendCipher,
            recvCipher: recvCipher,
            createdAt: now
        )
        return (payload, session)
    }
}

public final class NoiseIKpsk2Responder {
    private let sym: SymmetricState
    private let s: X25519KeyPair
    private let psk: Data
    private let fixedE: X25519KeyPair?
    private var re: Data?
    private var rsRemote: Data?
    private var step = 0

    public init(
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

    public func readMessage1(_ message: Data) throws -> (payload: Data, remoteStaticPublicKey: Data) {
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

    public func writeMessage2(payload: Data, now: Date = Date()) throws -> (message: Data, session: NoiseTransportSession) {
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

// MARK: - Prologues & Companion Key/ID Derivations

public enum CompanionDerivations {
    private static let crockfordAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    private static let rfc4648LowerAlphabet = Array("abcdefghijklmnopqrstuvwxyz234567")

    public static func base32Encode(_ data: Data, alphabet: [Character]) -> String {
        var out = ""
        var acc: UInt32 = 0
        var bits: UInt32 = 0
        for byte in data {
            acc = (acc << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                let idx = Int((acc >> bits) & 0x1f)
                out.append(alphabet[idx])
            }
        }
        if bits > 0 {
            let idx = Int((acc << (5 - bits)) & 0x1f)
            out.append(alphabet[idx])
        }
        return out
    }

    public static func pairingPrologue(workspaceId: String, pairSessionId: String) throws -> Data {
        guard !workspaceId.isEmpty, !workspaceId.contains("\0"),
              !pairSessionId.isEmpty, !pairSessionId.contains("\0")
        else {
            throw CompanionNoiseError.invalidInput("workspaceId/pairSessionId")
        }
        return Data("toolroll-noise-v1\0pair\0\(workspaceId)\0\(pairSessionId)".utf8)
    }

    public static func sessionPrologue(workspaceId: String, deviceId: String, recoveryGeneration: String) throws -> Data {
        guard !workspaceId.isEmpty, !workspaceId.contains("\0"),
              !deviceId.isEmpty, !deviceId.contains("\0"),
              recoveryGeneration.count == 32,
              recoveryGeneration.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) })
        else {
            throw CompanionNoiseError.invalidInput("workspaceId/deviceId/recoveryGeneration")
        }
        return Data("toolroll-noise-v1\0session\0\(workspaceId)\0\(deviceId)\0\(recoveryGeneration)".utf8)
    }

    public static func confirmationCode(handshakeHash: Data) throws -> String {
        guard handshakeHash.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("handshakeHash", handshakeHash.count)
        }
        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: handshakeHash),
            salt: Data(),
            info: Data("toolroll-pair-confirm-v1".utf8),
            outputByteCount: 8
        )
        let raw = base32Encode(okm.withUnsafeBytes { Data($0) }, alphabet: crockfordAlphabet)
        let prefix = raw.prefix(3)
        let suffix = raw.dropFirst(3).prefix(3)
        return "\(prefix)-\(suffix)"
    }

    public static func deriveDevicePsk(
        pskEntropy: Data,
        handshakeHash: Data,
        workspaceId: String,
        deviceId: String
    ) throws -> Data {
        guard pskEntropy.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("pskEntropy", pskEntropy.count)
        }
        guard handshakeHash.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("handshakeHash", handshakeHash.count)
        }
        let info = Data("toolroll-device-psk-v1:\(workspaceId):\(deviceId)".utf8)
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: pskEntropy),
            salt: handshakeHash,
            info: info,
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    public static func deriveMachineId(relayMachinePublicKey: Data) throws -> String {
        guard relayMachinePublicKey.count == 32 else {
            throw CompanionNoiseError.invalidKeyLength("relayMachinePublicKey", relayMachinePublicKey.count)
        }
        var input = Data("toolroll-machine-id-v1\0".utf8)
        input.append(relayMachinePublicKey)
        let digest = sha256(input)
        return String(base32Encode(digest, alphabet: rfc4648LowerAlphabet).prefix(26))
    }

    public static func derivePasskeyUserHandle(workspaceId: String, accountName: String) throws -> Data {
        guard !workspaceId.isEmpty, !workspaceId.contains("\0"),
              !accountName.isEmpty, !accountName.contains("\0")
        else {
            throw CompanionNoiseError.invalidInput("workspaceId/accountName")
        }
        return sha256(Data("toolroll-passkey-user-v1\0\(workspaceId)\0\(accountName)".utf8))
    }
}

// MARK: - RFC 8291 aes128gcm Push Decryption (for iOS Notification Service Extension)

public enum RFC8291PushCrypto {
    /// Decrypts a single-record RFC 8291 `aes128gcm` push payload produced by `src/push.ts:encryptPushPayload`.
    public static func decrypt(
        ciphertextBody: Data,
        uaPrivateKey: P256.KeyAgreement.PrivateKey,
        authSecret: Data
    ) throws -> Data {
        guard authSecret.count == 16 else {
            throw CompanionNoiseError.invalidKeyLength("authSecret", authSecret.count)
        }
        // Header: 16B salt + 4B rs + 1B idlen(65) + 65B asPublic = 86B, plus >= 17B (delimiter + 16B tag)
        guard ciphertextBody.count >= 86 + 17 else {
            throw CompanionNoiseError.invalidMessageLength(ciphertextBody.count)
        }
        let salt = Data(ciphertextBody.subdata(in: 0..<16))
        let idLen = Int(ciphertextBody[20])
        guard idLen == 65 else {
            throw CompanionNoiseError.invalidInput("RFC 8291 idlen must be 65")
        }
        let asPublicBytes = Data(ciphertextBody.subdata(in: 21..<86))
        guard asPublicBytes.first == 0x04 else {
            throw CompanionNoiseError.invalidInput("RFC 8291 asPublic must be uncompressed P-256")
        }
        let asPublic = try P256.KeyAgreement.PublicKey(x963Representation: asPublicBytes)
        let uaPublicBytes = uaPrivateKey.publicKey.x963Representation
        let ecdhSecret = try uaPrivateKey.sharedSecretFromKeyAgreement(with: asPublic)

        var keyInfo = Data("WebPush: info\0".utf8)
        keyInfo.append(uaPublicBytes)
        keyInfo.append(asPublicBytes)

        let ikm = ecdhSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: authSecret,
            sharedInfo: keyInfo,
            outputByteCount: 32
        )
        let cek = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: salt,
            info: Data("Content-Encoding: aes128gcm\0".utf8),
            outputByteCount: 16
        )
        let nonceKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: salt,
            info: Data("Content-Encoding: nonce\0".utf8),
            outputByteCount: 12
        )
        let nonceData = nonceKey.withUnsafeBytes { Data($0) }
        let gcmNonce = try AES.GCM.Nonce(data: nonceData)
        let encryptedRecord = Data(ciphertextBody.dropFirst(86))
        let body = encryptedRecord.prefix(encryptedRecord.count - 16)
        let tag = encryptedRecord.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: body, tag: tag)
        let record: Data
        do {
            record = try AES.GCM.open(box, using: cek)
        } catch {
            throw CompanionNoiseError.authenticationFailed
        }
        // Strip trailing zero padding and verify 0x02 final-record delimiter (RFC 8188 §2).
        var end = record.count
        while end > 0 && record[end - 1] == 0x00 {
            end -= 1
        }
        guard end > 0 && record[end - 1] == 0x02 else {
            throw CompanionNoiseError.authenticationFailed
        }
        return Data(record.prefix(end - 1))
    }
}
