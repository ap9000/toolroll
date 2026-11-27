import CryptoKit
import Foundation
import Security

/// Keychain storage for `ThisDeviceOnly` secrets (Noise static key, `devicePsk`,
/// Ed25519 `deviceRelayPriv`, and App Group shared P-256 push decryption key + `authSecret`).
public enum CompanionKeychain {
    public static let appGroupAccessGroup = "group.dev.toolroll.ios"
    private static let service = "dev.toolroll.ios.companion"

    public static func save(_ data: Data, account: String, sharedAppGroup: Bool = false) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if sharedAppGroup {
            query[kSecAttrAccessGroup as String] = appGroupAccessGroup
        }
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    public static func load(account: String, sharedAppGroup: Bool = false) -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if sharedAppGroup {
            query[kSecAttrAccessGroup as String] = appGroupAccessGroup
        }
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess else { return nil }
        return out as? Data
    }

    public static func delete(account: String, sharedAppGroup: Bool = false) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if sharedAppGroup {
            query[kSecAttrAccessGroup as String] = appGroupAccessGroup
        }
        SecItemDelete(query as CFDictionary)
    }
}

/// Ed25519 relay token signer matching `src/companion/relay-auth.ts` (`tr-relay-v1.<b64url>`).
public enum CompanionRelayAuth {
    public static func base64UrlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func base64UrlDecode(_ string: String) -> Data? {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem > 0 {
            s += String(repeating: "=", count: 4 - rem)
        }
        return Data(base64Encoded: s)
    }

    public static func signDeviceToken(
        privateKey: Curve25519.Signing.PrivateKey,
        machineId: String,
        deviceId: String,
        ttlSec: Int = 300
    ) throws -> String {
        let nowSec = Int(Date().timeIntervalSince1970)
        let payload: [String: Any] = [
            "v": 1,
            "role": "device",
            "machineId": machineId,
            "deviceId": deviceId,
            "jti": UUID().uuidString.lowercased(),
            "iat": nowSec,
            "exp": nowSec + min(max(1, ttlSec), 300),
        ]
        let jsonData = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let encoded = base64UrlEncode(jsonData)
        let signingInput = Data("tr-relay-v1.\(encoded)".utf8)
        let sig = try privateKey.signature(for: signingInput)
        return "\(encoded).\(base64UrlEncode(sig))"
    }
}

/// Native Noise IKpsk2 WebSocket transport client for Gate 1 Read-Only Companion Pilot.
public actor CompanionRelayClient {
    private var wsTask: URLSessionWebSocketTask?
    private var session: NoiseTransportSession?
    private var nextStreamId: UInt32 = 1

    public init() {}

    /// Runs Step 2–4 of the two-step pairing ceremony, returning the 6-char transcript confirmation code
    /// and holding the socket open until the Mac sends encrypted `pair.confirmed` (or aborts).
    public func beginPairing(
        qr: PairingQRPayload,
        deviceName: String,
        onCodeReady: @Sendable (String) async -> Void
    ) async throws -> (record: PairedWorkspaceRecord, devicePsk: Data, phoneNoisePriv: Data, deviceRelayPriv: Data) {
        guard let url = URL(string: qr.relayUrl),
              let macStaticPub = CompanionRelayAuth.base64UrlDecode(qr.macStaticPub),
              let pairPsk = CompanionRelayAuth.base64UrlDecode(qr.pairPsk)
        else {
            throw CompanionNoiseError.invalidInput("Malformed pairing QR payload")
        }

        let phoneNoise = X25519KeyPair.generate()
        let deviceRelay = Curve25519.Signing.PrivateKey()
        let prologue = try CompanionDerivations.pairingPrologue(
            workspaceId: qr.workspaceId,
            pairSessionId: qr.pairSessionId
        )
        let initiator = try NoiseIKpsk2Initiator(
            localStatic: phoneNoise,
            remoteStaticPublicKey: macStaticPub,
            psk: pairPsk,
            prologue: prologue
        )

        var req = URLRequest(url: url)
        req.setValue("Bearer \(qr.pairConnToken)", forHTTPHeaderField: "Authorization")
        let ws = URLSession.shared.webSocketTask(with: req)
        self.wsTask = ws
        ws.resume()

        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "mode": "pair",
            "deviceName": deviceName,
            "deviceRelayPub": CompanionRelayAuth.base64UrlEncode(deviceRelay.publicKey.rawRepresentation),
        ])
        let msg1 = try initiator.writeMessage1(payload: msg1Payload)
        try await ws.send(.data(msg1))

        let msg2Raw = try await receiveBinary(ws)
        let (_, pairSession) = try initiator.readMessage2(msg2Raw)
        let code = try CompanionDerivations.confirmationCode(handshakeHash: pairSession.handshakeHash)
        await onCodeReady(code)

        // Wait for Mac owner to click Confirm match -> Mac sends encrypted `pair.confirmed`
        let finCt = try await receiveBinary(ws)
        let finPlain = try pairSession.decrypt(finCt)
        guard let fin = try JSONSerialization.jsonObject(with: finPlain) as? [String: Any],
              fin["type"] as? String == "pair.confirmed",
              let deviceId = fin["deviceId"] as? String,
              let recoveryGeneration = fin["recoveryGeneration"] as? String,
              let entropyB64 = fin["pskEntropy"] as? String,
              let pskEntropy = CompanionRelayAuth.base64UrlDecode(entropyB64)
        else {
            ws.cancel(with: .normalClosure, reason: nil)
            throw CompanionNoiseError.authenticationFailed
        }

        let devicePsk = try CompanionDerivations.deriveDevicePsk(
            pskEntropy: pskEntropy,
            handshakeHash: pairSession.handshakeHash,
            workspaceId: qr.workspaceId,
            deviceId: deviceId
        )
        ws.cancel(with: .normalClosure, reason: nil)
        self.wsTask = nil

        let record = PairedWorkspaceRecord(
            workspaceId: qr.workspaceId,
            workspaceLabel: "Paired Mac",
            machineId: qr.machineId,
            relayUrl: qr.relayUrl,
            macStaticPubBase64Url: qr.macStaticPub,
            deviceId: deviceId,
            recoveryGeneration: recoveryGeneration,
            pairedAt: Date()
        )
        return (record, devicePsk, phoneNoise.privateKey, deviceRelay.rawRepresentation)
    }

    /// 1-RTT Noise IKpsk2 reconnect followed by mandatory `device.hello` key confirmation.
    public func connect(
        record: PairedWorkspaceRecord,
        devicePsk: Data,
        phoneNoisePriv: Data,
        deviceRelayPriv: Data
    ) async throws -> Data {
        disconnect()
        guard let url = URL(string: record.relayUrl),
              let macStaticPub = CompanionRelayAuth.base64UrlDecode(record.macStaticPubBase64Url)
        else {
            throw CompanionNoiseError.invalidInput("Invalid stored workspace record")
        }
        let phoneNoise = try X25519KeyPair(privateKey: phoneNoisePriv)
        let relayKey = try Curve25519.Signing.PrivateKey(rawRepresentation: deviceRelayPriv)
        let token = try CompanionRelayAuth.signDeviceToken(
            privateKey: relayKey,
            machineId: record.machineId,
            deviceId: record.deviceId
        )
        let prologue = try CompanionDerivations.sessionPrologue(
            workspaceId: record.workspaceId,
            deviceId: record.deviceId,
            recoveryGeneration: record.recoveryGeneration
        )
        let initiator = try NoiseIKpsk2Initiator(
            localStatic: phoneNoise,
            remoteStaticPublicKey: macStaticPub,
            psk: devicePsk,
            prologue: prologue
        )

        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let ws = URLSession.shared.webSocketTask(with: req)
        self.wsTask = ws
        ws.resume()

        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "mode": "session",
            "deviceId": record.deviceId,
        ])
        try await ws.send(.data(try initiator.writeMessage1(payload: msg1Payload)))

        let msg2Raw = try await receiveBinary(ws)
        let (_, transport) = try initiator.readMessage2(msg2Raw)
        self.session = transport
        self.nextStreamId = 1

        // Mandatory key confirmation: first transport RPC MUST be `device.hello`
        return try await callUnary(method: "device.hello")
    }

    public func callUnary(method: String, paramsJson: Data = Data("{}".utf8)) async throws -> Data {
        guard let ws = wsTask, let session else {
            throw CompanionNoiseError.sessionClosed
        }
        let streamId = nextStreamId
        nextStreamId += 2
        let paramsObj = (try? JSONSerialization.jsonObject(with: paramsJson)) ?? [:]
        let reqData = try JSONSerialization.data(withJSONObject: ["method": method, "params": paramsObj])
        let frames = try CompanionFrame.splitRequest(streamId: streamId, payload: reqData)
        for frame in frames {
            let ct = try session.encrypt(try frame.encode())
            try await ws.send(.data(ct))
        }

        var assembled = Data()
        while true {
            let ct = try await receiveBinary(ws)
            let frame = try CompanionFrame.decode(try session.decrypt(ct))
            guard frame.streamId == streamId else { continue }
            switch frame.type {
            case .res:
                return frame.payload
            case .chunk:
                assembled.append(frame.payload)
                let credit = try CompanionFrame.creditFrame(streamId: streamId, grant: 1)
                try await ws.send(.data(try session.encrypt(try credit.encode())))
            case .end:
                return assembled
            case .error:
                let err = (try? JSONSerialization.jsonObject(with: frame.payload) as? [String: Any]) ?? [:]
                let msg = err["message"] as? String ?? "RPC error"
                throw CompanionNoiseError.invalidInput(msg)
            default:
                continue
            }
        }
    }

    public func disconnect() {
        wsTask?.cancel(with: .normalClosure, reason: nil)
        wsTask = nil
        session?.close()
        session = nil
    }

    private func receiveBinary(_ ws: URLSessionWebSocketTask) async throws -> Data {
        let msg = try await ws.receive()
        switch msg {
        case .data(let d): return d
        case .string: throw CompanionNoiseError.authenticationFailed
        @unknown default: throw CompanionNoiseError.authenticationFailed
        }
    }
}
