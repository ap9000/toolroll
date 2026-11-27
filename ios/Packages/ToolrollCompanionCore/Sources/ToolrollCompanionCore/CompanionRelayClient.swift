import CryptoKit
import Foundation

// MARK: - Errors

/// A typed RPC failure: the ERROR frame's `{ code, message }`.
public struct CompanionRPCError: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public static let notFound = "not_found"
    public static let invalidCursor = "invalid_cursor"
    public static let deadlineExceeded = "deadline_exceeded"
    public static let responseTooLarge = "response_too_large"
    public static let invalidResponse = "invalid_response"
}

/// Set once, read from another task.
private final class SentFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.withLock { flag } }
    func set() { lock.withLock { flag = true } }
}

// MARK: - Socket

/// One WebSocket carrying Noise messages as binary frames. Abstracted so the client can be tested in memory.
///
/// A refused upgrade throws `CompanionRelayRefusal` (status, `Toolroll-Relay-Error`, `Date`, `Retry-After`); a network
/// failure `CompanionConnectionError.unreachable(.generic)`; a close `CompanionConnectionError.closed`.
public protocol CompanionSocket: AnyObject, Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func close()
}

public typealias CompanionSocketFactory = @Sendable (URLRequest) -> any CompanionSocket

/// Waits for a duration (injected so tests drive every timer by hand).
public typealias CompanionSleep = @Sendable (Duration) async throws -> Void
/// This iPhone's clock (injected for the token time window tests).
public typealias CompanionNow = @Sendable () -> Date

/// `URLSessionWebSocketTask` as a `CompanionSocket`.
public final class URLSessionCompanionSocket: CompanionSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    public init(request: URLRequest, session: URLSession = .shared) {
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = CompanionNoiseConstants.maxMessageBytes + 1024
        task.resume()
    }

    public func send(_ data: Data) async throws {
        do {
            try await task.send(.data(data))
        } catch {
            throw mapped(error)
        }
    }

    public func receive() async throws -> Data {
        let message: URLSessionWebSocketTask.Message
        do {
            message = try await task.receive()
        } catch {
            throw mapped(error)
        }
        switch message {
        case .data(let d): return d
        case .string: throw CompanionConnectionError.closed
        @unknown default: throw CompanionConnectionError.closed
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func mapped(_ error: Error) -> Error {
        if let http = task.response as? HTTPURLResponse, http.statusCode != 101 {
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            return CompanionRelayRefusal(status: http.statusCode, headers: headers)
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled: return CompanionConnectionError.closed
            default: return CompanionConnectionError.unreachable(.generic)
            }
        }
        return CompanionConnectionError.closed
    }
}

// MARK: - Results

/// A connection that passed `device.hello`.
public struct CompanionConnectResult: Equatable, Sendable {
    public let hello: DeviceHello
    /// The path this session runs over.
    public let path: CompanionPath
    /// The stored record, with `paths` replaced by the hello's when it sent a valid list. Persist it if it changed.
    public let record: PairedWorkspaceRecord
}

/// Everything a finished pairing gives the phone to store.
public struct CompanionPairingKeys: Sendable {
    public let record: PairedWorkspaceRecord
    public let devicePsk: Data
    public let phoneNoisePriv: Data
    public let deviceRelayPriv: Data
}

/// How a pairing ended once the keys were stored.
public enum CompanionPairingCompletion: Equatable, Sendable {
    /// The Mac answered `pair.done`: the phone is active.
    case activated
    /// The keys are stored but `pair.done` wasn't answered (a drop, a cancel): the first successful hello activates
    /// the phone. The app shows the final screen only after that hello.
    case pendingActivation
}

// MARK: - Client

/// The Noise IKpsk2 relay client.
///
/// One connection at a time. All Noise state lives on this actor: frames are encrypted here and handed, in order,
/// to a single writer task (so the nonce order matches the send order); one reader task receives ciphertexts and hands
/// them back here to decrypt and dispatch by `streamId`. A generation number fences every task and timer of an older
/// connection, so nothing from it can publish after a reconnect.
public actor CompanionRelayClient {
    public struct Timing: Sendable {
        public var connect: Duration
        public var call: Duration
        public var ping: Duration
        /// A PING not answered within this ends the session (spec: 10 s).
        public var pongDeadline: Duration
        /// Each direct path's `/v1/health` probe.
        public var probe: Duration
        /// The whole direct attempt (handshake and `device.hello`; for pairing, msg1 → msg2), so a LAN device that
        /// answers the probe and then stalls can't hold up the hosted fallback. Hosted keeps `connect`.
        public var directHandshake: Duration
        /// `device.hello`'s own deadline (a direct hello also has to land inside `directHandshake`).
        public var hello: Duration
        /// How long the phone waits for the Mac's answer to `pair.done`.
        public var pairDone: Duration
        /// Bounds on the wait for the owner's confirmation (the QR's `expiresAtMs`, clamped into this range).
        public var pairingWaitMin: Duration
        public var pairingWaitMax: Duration

        public init(
            connect: Duration = .seconds(15), call: Duration = .seconds(30), ping: Duration = .seconds(25),
            pongDeadline: Duration = .seconds(10), probe: Duration = .milliseconds(1200),
            directHandshake: Duration = .seconds(4), hello: Duration = .seconds(10), pairDone: Duration = .seconds(10),
            pairingWaitMin: Duration = .seconds(60), pairingWaitMax: Duration = .seconds(600)
        ) {
            self.connect = connect
            self.call = call
            self.ping = ping
            self.pongDeadline = pongDeadline
            self.probe = probe
            self.directHandshake = directHandshake
            self.hello = hello
            self.pairDone = pairDone
            self.pairingWaitMin = pairingWaitMin
            self.pairingWaitMax = pairingWaitMax
        }
    }

    private struct PendingCall {
        let continuation: CheckedContinuation<Data, Error>
        var assembled = Data()
        var nextSeq: UInt32 = 0
        let deadline: Task<Void, Never>
    }

    private struct WatchState {
        let continuation: AsyncThrowingStream<Data, Error>.Continuation
        var nextSeq: UInt32 = 0
    }

    private struct RPCRequest<P: Encodable>: Encodable {
        let method: String
        let params: P
    }

    private struct EmptyParams: Encodable, Sendable {}

    private let socketFactory: CompanionSocketFactory
    private let healthProbe: CompanionHealthProbe
    private let discover: CompanionDirectDiscovery?
    private let sleep: CompanionSleep
    private let now: CompanionNow
    private let timing: Timing

    private var generation: UInt64 = 0
    /// The generation whose `device.hello` passed: only then is the session "connected" (A8).
    private var confirmedGeneration: UInt64?
    private var socket: (any CompanionSocket)?
    private var session: NoiseTransportSession?
    private var outbox: AsyncStream<Data>.Continuation?
    private var readerTask: Task<Void, Never>?
    private var writerTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var pongDeadlineTask: Task<Void, Never>?
    /// The PING whose PONG is awaited, if any.
    private var awaitingPong: UInt32?
    private var pingSeq: UInt32 = 0
    private var nextStreamId: UInt32 = 1
    private var pending: [UInt32: PendingCall] = [:]
    private var watches: [UInt32: WatchState] = [:]
    /// Chunks taken but not yet credited back, per stream (B1).
    private var ungranted: [UInt32: UInt32] = [:]
    /// Calls waiting for one of the Mac's 8 stream slots (B2).
    private var slotWaiters: [(id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
    private var nextWaiterId: UInt64 = 0
    private var onSessionEnd: (@Sendable (CompanionSessionEnd) -> Void)?
    private var pairingSocket: (any CompanionSocket)?
    /// The socket of a session attempt still dialing, so `disconnect()` can close it (A9).
    private var dialSocket: (any CompanionSocket)?
    /// Bumped by every `connect()` and `disconnect()`. A dial that sees it change (while probing, or before falling
    /// back to hosted) stops: a newer connect or a disconnect owns the client now.
    private var dialEpoch: UInt64 = 0
    /// Bumped by every pairing start and `cancelPairing()`: a cancelled pairing never falls back to hosted.
    private var pairingEpoch: UInt64 = 0
    /// The generation whose direct `device.hello` is still inside its deadline, if any.
    private var directHelloPending: UInt64?
    /// The last generation whose direct hello ran out of time (its failure counts as a network one).
    private var directHelloExpired: UInt64?
    /// The largest clock correction taken from a relay's `Date` header (one day).
    static let maxClockOffset: TimeInterval = 86_400
    /// Seconds to add to this iPhone's clock for relay tokens, learned once from a relay's `Date` header.
    public private(set) var clockOffset: TimeInterval = 0

    public init(
        timing: Timing = Timing(),
        healthProbe: @escaping CompanionHealthProbe = URLSessionHealthProbe.probe,
        discover: CompanionDirectDiscovery? = nil,
        sleep: @escaping CompanionSleep = { try await Task.sleep(for: $0) },
        now: @escaping CompanionNow = { Date() },
        socketFactory: @escaping CompanionSocketFactory = { URLSessionCompanionSocket(request: $0) }
    ) {
        self.timing = timing
        self.healthProbe = healthProbe
        self.discover = discover
        self.sleep = sleep
        self.now = now
        self.socketFactory = socketFactory
    }

    /// Called once per confirmed session when it ends on its own (not for `disconnect()`): lost, rekey or refused.
    public func setSessionEndHandler(_ handler: (@Sendable (CompanionSessionEnd) -> Void)?) {
        onSessionEnd = handler
    }

    /// A live session that passed `device.hello` and whose Noise keys are still usable.
    public var isConnected: Bool {
        guard let session, confirmedGeneration == generation else { return false }
        return !session.isExpired()
    }

    // MARK: Pairing (contract §1)

    /// Pairs with the Mac that showed `qr`.
    ///
    /// msg1 → msg2 (`awaiting_ready`) → `pair.ready {deviceName}` on stream 1; the code goes to `onCodeReady` (the Mac
    /// shows the same code once `pair.ready` lands). While the owner compares codes the phone pings every 20 s and waits
    /// at most until the QR's `expiresAtMs`. The Mac's RES to `pair.ready` is the outcome; an ERROR names why it ended.
    /// On success the keys go to `persist` (stored before anything else is sent), then `pair.done {deviceId}` on
    /// stream 3. A `persist` failure ends the pairing (the Mac's pending row expires on its own).
    public func pair(
        qr: PairingQRPayload,
        deviceName: String,
        onCodeReady: @Sendable (String) async -> Void,
        persist: @Sendable (CompanionPairingKeys) async throws -> Void
    ) async throws -> CompanionPairingCompletion {
        try qr.validate(now: now())
        guard let macStaticPub = CompanionRelayAuth.base64UrlDecode(qr.macStaticPub),
              let pairPsk = CompanionRelayAuth.base64UrlDecode(qr.pairPsk)
        else {
            throw CompanionNoiseError.invalidInput("Malformed pairing QR payload")
        }
        let name = CompanionDeviceName.sanitized(deviceName) ?? "iPhone"

        let phoneNoise = X25519KeyPair.generate()
        let deviceRelay = Curve25519.Signing.PrivateKey()
        let prologue = try CompanionDerivations.pairingPrologue(workspaceId: qr.workspaceId, pairSessionId: qr.pairSessionId)
        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": CompanionWire.protocolVersion,
            "mode": "pair",
            "deviceRelayPub": CompanionRelayAuth.base64UrlEncode(deviceRelay.publicKey.rawRepresentation),
        ], options: [.sortedKeys])
        let makeInitiator = {
            try NoiseIKpsk2Initiator(localStatic: phoneNoise, remoteStaticPublicKey: macStaticPub, psk: pairPsk, prologue: prologue)
        }

        pairingEpoch &+= 1
        let epoch = pairingEpoch
        var directReq: URLRequest?
        let probed = await firstHealthyDirect(qr.paths, machineId: qr.machineId)
        if let direct = probed.path,
           let url = CompanionPathRules.directSocketURL(direct.url, role: "pair", id: qr.pairSessionId) {
            directReq = URLRequest(url: url)
        }
        var hostedReq: URLRequest?
        if let hosted = qr.hostedPath, let token = qr.pairConnToken, let url = URL(string: hosted.url) {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            hostedReq = req
        }
        try Task.checkCancellation()
        guard epoch == pairingEpoch else { throw CompanionConnectionError.closed }

        // A healthy direct address first, else the hosted relay. Hosted gets one try only if the direct socket failed
        // before message 1 was sent; after that the outcome is uncertain and the person starts again on the Mac.
        let ws: any CompanionSocket
        let pairSession: NoiseTransportSession
        if let directReq {
            do {
                (ws, pairSession) = try await openPairing(directReq, direct: true, msg1Payload: msg1Payload, initiator: makeInitiator())
            } catch CompanionConnectionError.unreachable(let hint) {
                guard let hostedReq else { throw CompanionConnectionError.unreachable(hint) }
                try Task.checkCancellation()
                guard epoch == pairingEpoch else { throw CompanionConnectionError.closed }
                (ws, pairSession) = try await openPairing(hostedReq, direct: false, msg1Payload: msg1Payload, initiator: makeInitiator())
            }
        } else if let hostedReq {
            (ws, pairSession) = try await openPairing(hostedReq, direct: false, msg1Payload: msg1Payload, initiator: makeInitiator())
        } else {
            throw CompanionConnectionError.unreachable(probed.sawOtherMachine ? .differentMachine : .noPath)
        }

        let link = PairingLink(socket: ws, session: pairSession)
        defer {
            link.stop()
            ws.close()
            if pairingSocket === ws { pairingSocket = nil }
        }

        let waitLimit = pairingWait(expiresAtMs: qr.expiresAtMs)
        let keys: CompanionPairingKeys
        do {
            try link.send(CompanionFrame(type: .req, streamId: CompanionWire.pairReadyStream, seq: 0, payload: try JSONEncoder().encode(
                RPCRequest(method: "pair.ready", params: ["deviceName": name])
            )))
            let code = try CompanionDerivations.confirmationCode(handshakeHash: pairSession.handshakeHash)
            await onCodeReady(code)
            link.startKeepalive(every: CompanionWire.pairingKeepalive, sleep: sleep)

            let timedOut = SentFlag()
            let sleeper = sleep
            let outcome: Data
            do {
                outcome = try await Self.withDeadline(waitLimit, sleep: sleeper, onTimeout: { timedOut.set(); ws.close() }) {
                    try await link.awaitAnswer(on: CompanionWire.pairReadyStream)
                }
            } catch {
                if timedOut.value { throw CompanionPairingError.expired }
                throw error
            }
            keys = try Self.pairingKeys(
                outcome: outcome, qr: qr, handshakeHash: pairSession.handshakeHash,
                phoneNoise: phoneNoise, deviceRelay: deviceRelay
            )
        } catch let error as CompanionPairingError {
            throw error
        } catch {
            // Cancelled by the person (or replaced by a newer scan): quiet.
            if error is CancellationError || epoch != pairingEpoch { throw CompanionConnectionError.closed }
            // Anything else after message 2: the pairing on the Mac is gone with this socket (A4).
            throw CompanionPairingError.interrupted
        }

        // The Mac keeps this device from here on (the RES was its linearization point): store the keys first.
        try await persist(keys)

        do {
            try link.send(CompanionFrame(type: .req, streamId: CompanionWire.pairDoneStream, seq: 0, payload: try JSONEncoder().encode(
                RPCRequest(method: "pair.done", params: ["deviceId": keys.record.deviceId])
            )))
            let done = try await Self.withDeadline(timing.pairDone, sleep: sleep, onTimeout: { ws.close() }) {
                try await link.awaitAnswer(on: CompanionWire.pairDoneStream)
            }
            let ok = (try? JSONSerialization.jsonObject(with: done) as? [String: Any]).flatMap { object in
                ((object["result"] as? [String: Any]) ?? object)["ok"] as? Bool
            } ?? false
            return ok ? .activated : .pendingActivation
        } catch {
            return .pendingActivation
        }
    }

    /// The wait for the owner's confirmation: until the QR's `expiresAtMs` by this iPhone's clock, clamped so a wrong
    /// clock can neither end it at once nor hold the socket for long.
    private func pairingWait(expiresAtMs: Double?) -> Duration {
        guard let expiresAtMs else { return timing.pairingWaitMax }
        // Clamp in floating point first: `expiresAtMs` comes from a scanned or pasted code, and Int64(_:) traps on a
        // value out of range.
        func milliseconds(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }
        let minMs = milliseconds(timing.pairingWaitMin), maxMs = milliseconds(timing.pairingWaitMax)
        let ms = expiresAtMs - now().timeIntervalSince1970 * 1000
        let clamped = ms.isFinite ? min(max(ms, minMs), maxMs) : maxMs
        return .milliseconds(Int64(clamped))
    }

    /// The RES to `pair.ready`: `{ ok, result: { deviceId, recoveryGeneration, pskEntropy } }`.
    private static func pairingKeys(
        outcome: Data, qr: PairingQRPayload, handshakeHash: Data, phoneNoise: X25519KeyPair,
        deviceRelay: Curve25519.Signing.PrivateKey
    ) throws -> CompanionPairingKeys {
        guard let object = try JSONSerialization.jsonObject(with: outcome) as? [String: Any] else {
            throw CompanionNoiseError.authenticationFailed
        }
        let result = (object["result"] as? [String: Any]) ?? object
        guard let deviceId = result["deviceId"] as? String, !deviceId.isEmpty, !deviceId.contains("\0"),
              let recoveryGeneration = result["recoveryGeneration"] as? String,
              let entropyB64 = result["pskEntropy"] as? String,
              let pskEntropy = CompanionRelayAuth.base64UrlDecode(entropyB64), pskEntropy.count == 32
        else {
            throw CompanionNoiseError.authenticationFailed
        }
        // The session prologue must be buildable from what the Mac sent, or every later connect would fail.
        _ = try CompanionDerivations.sessionPrologue(workspaceId: qr.workspaceId, deviceId: deviceId, recoveryGeneration: recoveryGeneration)
        let devicePsk = try CompanionDerivations.deriveDevicePsk(
            pskEntropy: pskEntropy, handshakeHash: handshakeHash, workspaceId: qr.workspaceId, deviceId: deviceId
        )
        let record = PairedWorkspaceRecord(
            workspaceId: qr.workspaceId,
            workspaceLabel: "Your Mac",
            machineId: qr.machineId,
            paths: qr.paths,
            macStaticPubBase64Url: qr.macStaticPub,
            deviceId: deviceId,
            recoveryGeneration: recoveryGeneration,
            pairedAt: Date()
        )
        return CompanionPairingKeys(
            record: record, devicePsk: devicePsk, phoneNoisePriv: phoneNoise.privateKey,
            deviceRelayPriv: deviceRelay.rawRepresentation
        )
    }

    /// Opens one pairing socket and runs msg1 → msg2 (which must say `awaiting_ready`).
    ///
    /// A failure before message 1 was sent (connect error, DNS, timeout before open) is `unreachable`: on a direct path
    /// hosted may be tried. A hosted upgrade refusal is the relay's verdict on the pairing token (401: the code expired or
    /// was used up; 503/404: the Mac isn't connected). Once message 1 may have reached the Mac, any failure is
    /// `CompanionPairingError.interrupted`: the person starts again on the Mac.
    private func openPairing(
        _ req: URLRequest,
        direct: Bool,
        msg1Payload: Data,
        initiator: NoiseIKpsk2Initiator
    ) async throws -> (any CompanionSocket, NoiseTransportSession) {
        let ws = socketFactory(req)
        pairingSocket?.close()
        pairingSocket = ws
        let msg1Sent = SentFlag()
        do {
            let msg1 = try initiator.writeMessage1(payload: msg1Payload)
            let limit = direct ? timing.directHandshake : timing.connect
            let msg2 = try await Self.withDeadline(limit, sleep: sleep, onTimeout: { ws.close() }) {
                try await ws.send(msg1)
                msg1Sent.set()
                return try await ws.receive()
            }
            let (payload, session) = try initiator.readMessage2(msg2)
            guard (try? CompanionHandshakeReply.parse(payload, mode: .pair)) == .awaitingReady else {
                throw CompanionPairingError.interrupted
            }
            return (ws, session)
        } catch {
            ws.close()
            if pairingSocket === ws { pairingSocket = nil }
            if !direct, let refusal = error as? CompanionRelayRefusal {
                if refusal.status == 401 { throw CompanionPairingError.expired }
                throw CompanionConnectionError.unreachable(refusal.hint)
            }
            if msg1Sent.value { throw CompanionPairingError.interrupted }
            throw CompanionConnectionError.unreachable(.generic)
        }
    }

    /// Closes an in-flight pairing socket (Cancel pairing, entering the demo).
    public func cancelPairing() {
        pairingEpoch &+= 1
        pairingSocket?.close()
        pairingSocket = nil
    }

    // MARK: Session

    /// Dials the Mac and runs the 1-RTT Noise IKpsk2 reconnect followed by the mandatory `device.hello` key
    /// confirmation. The hello must name the stored workspace and device.
    ///
    /// One handshake at a time, never two in parallel: probe every direct path's `/v1/health` at once (and, when none
    /// answers, browse Bonjour for this Mac); handshake on the first that answers with this Mac's `machineId`, else on
    /// the hosted relay. A direct attempt that fails for a network reason falls back to hosted exactly once. On a direct
    /// path everything before Noise succeeds counts as a network failure (it is unauthenticated). A refusal comes only
    /// from an authenticated source (msg2 `refused`, an encrypted `standing_revoked`) or the relay's 403
    /// `device_revoked`.
    @discardableResult
    public func connect(
        record: PairedWorkspaceRecord,
        devicePsk: Data,
        phoneNoisePriv: Data,
        deviceRelayPriv: Data
    ) async throws -> CompanionConnectResult {
        teardown(CompanionConnectionError.closed)
        dialEpoch &+= 1
        let epoch = dialEpoch

        guard let macStaticPub = CompanionRelayAuth.base64UrlDecode(record.macStaticPubBase64Url), macStaticPub.count == 32 else {
            throw CompanionConnectionError.damaged("invalid stored record")
        }
        // A stored list that no longer validates as a whole (rules tightened by an update) keeps whatever paths still
        // pass on their own, so a hosted path stays usable (A3).
        let paths: [CompanionPath]
        if (try? CompanionPathRules.validate(record.paths)) != nil {
            paths = record.paths
        } else {
            paths = record.paths.filter { (try? CompanionPathRules.validate($0)) != nil }
            guard !paths.isEmpty else { throw CompanionConnectionError.damaged("invalid stored paths") }
        }
        let keys: SessionKeys
        do {
            keys = SessionKeys(
                phoneNoise: try X25519KeyPair(privateKey: phoneNoisePriv),
                relayKey: try Curve25519.Signing.PrivateKey(rawRepresentation: deviceRelayPriv),
                macStaticPub: macStaticPub,
                devicePsk: devicePsk,
                prologue: try CompanionDerivations.sessionPrologue(
                    workspaceId: record.workspaceId,
                    deviceId: record.deviceId,
                    recoveryGeneration: record.recoveryGeneration
                )
            )
            _ = try keys.initiator()
        } catch {
            throw CompanionConnectionError.damaged("invalid stored keys")
        }

        let hosted = paths.last { $0.kind == .hosted }
        var probed = await firstHealthyDirect(paths, machineId: record.machineId)
        guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
        if probed.path == nil, paths.contains(where: { $0.kind == .direct }), let discover {
            // The stored addresses are stale: look for this Mac on the local network, for this dial only.
            let found = await discover(record.machineId).filter { !paths.contains($0) }
            guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
            if !found.isEmpty {
                let again = await firstHealthyDirect(found, machineId: record.machineId)
                guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
                probed = (again.path, probed.sawOtherMachine || again.sawOtherMachine)
            }
        }
        let fallbackHint: CompanionUnreachableHint = probed.sawOtherMachine ? .differentMachine : .generic

        if let direct = probed.path {
            do {
                return try await attempt(direct, record: record, keys: keys, epoch: epoch)
            } catch CompanionConnectionError.unreachable {
                guard let hosted else { throw CompanionConnectionError.unreachable(.generic) }
                guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
                return try await attemptHosted(hosted, record: record, keys: keys, epoch: epoch, fallbackHint: .generic)
            }
        }
        if let hosted {
            return try await attemptHosted(hosted, record: record, keys: keys, epoch: epoch, fallbackHint: fallbackHint)
        }
        throw CompanionConnectionError.unreachable(probed.sawOtherMachine ? .differentMachine : .noPath)
    }

    /// The hosted attempt, with one retry after learning the relay's clock (contract §2.7 `clockSkew`).
    private func attemptHosted(
        _ hosted: CompanionPath, record: PairedWorkspaceRecord, keys: SessionKeys, epoch: UInt64,
        fallbackHint: CompanionUnreachableHint
    ) async throws -> CompanionConnectResult {
        var corrected = false
        while true {
            do {
                return try await attempt(hosted, record: record, keys: keys, epoch: epoch)
            } catch let refusal as CompanionRelayRefusal {
                if refusal.isTerminal { throw CompanionConnectionError.refused(CompanionStreamZeroCode.deviceRevoked) }
                if refusal.isClockSkew {
                    guard !corrected, let serverDate = refusal.serverDate else {
                        throw CompanionConnectionError.unreachable(.clockSkew)
                    }
                    // The relay's Date header is unauthenticated: an offset past a day is not a clock to adopt.
                    let offset = serverDate.timeIntervalSince(now())
                    guard offset.isFinite, abs(offset) <= Self.maxClockOffset else {
                        throw CompanionConnectionError.unreachable(.clockSkew)
                    }
                    corrected = true
                    clockOffset = offset
                    guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
                    continue
                }
                throw CompanionConnectionError.unreachable(refusal.hint)
            } catch CompanionConnectionError.unreachable(.generic) where fallbackHint != .generic {
                throw CompanionConnectionError.unreachable(fallbackHint)
            }
        }
    }

    /// Everything one session handshake needs, checked once before dialing. A fresh initiator per attempt.
    private struct SessionKeys: Sendable {
        let phoneNoise: X25519KeyPair
        let relayKey: Curve25519.Signing.PrivateKey
        let macStaticPub: Data
        let devicePsk: Data
        let prologue: Data

        func initiator() throws -> NoiseIKpsk2Initiator {
            try NoiseIKpsk2Initiator(localStatic: phoneNoise, remoteStaticPublicKey: macStaticPub, psk: devicePsk, prologue: prologue)
        }
    }

    /// One socket, one handshake, one hello, on one path. A hosted upgrade refusal is thrown as `CompanionRelayRefusal`
    /// (the caller decides); everything else as `CompanionConnectionError`.
    private func attempt(
        _ path: CompanionPath,
        record: PairedWorkspaceRecord,
        keys: SessionKeys,
        epoch: UInt64
    ) async throws -> CompanionConnectResult {
        let gen = generation
        let started = ContinuousClock.now
        let budget = path.kind == .direct ? timing.directHandshake : timing.connect
        let initiator: NoiseIKpsk2Initiator
        var req: URLRequest
        do {
            initiator = try keys.initiator()
            switch path.kind {
            case .direct:
                // Straight into the Mac's engine: Noise from the first byte, no relay token.
                guard let url = CompanionPathRules.directSocketURL(path.url, role: "device", id: record.deviceId) else {
                    throw CompanionConnectionError.damaged("invalid stored record")
                }
                req = URLRequest(url: url)
            case .hosted:
                // A token goes only to the hosted URL the Mac gave us, for that relay's audience.
                guard let url = URL(string: path.url), let audience = CompanionRelayAuth.audience(forHostedURL: path.url) else {
                    throw CompanionConnectionError.damaged("invalid stored record")
                }
                let token = try CompanionRelayAuth.signDeviceToken(
                    privateKey: keys.relayKey,
                    machineId: record.machineId,
                    deviceId: record.deviceId,
                    audience: audience,
                    now: now().addingTimeInterval(clockOffset)
                )
                req = URLRequest(url: url)
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        } catch let error as CompanionConnectionError {
            throw error
        } catch {
            throw CompanionConnectionError.damaged("invalid stored keys")
        }
        let ws = socketFactory(req)
        dialSocket?.close()
        dialSocket = ws
        defer { if dialSocket === ws { dialSocket = nil } }

        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": CompanionWire.protocolVersion,
            "mode": "session",
            "deviceId": record.deviceId,
        ], options: [.sortedKeys])
        let msg1 = try initiator.writeMessage1(payload: msg1Payload)

        let msg2: Data
        do {
            msg2 = try await Self.withDeadline(budget, sleep: sleep, onTimeout: { ws.close() }) {
                try await ws.send(msg1)
                return try await ws.receive()
            }
        } catch let refusal as CompanionRelayRefusal {
            ws.close()
            // Unauthenticated on a direct path (any LAN device can refuse an upgrade): a network failure.
            if path.kind == .direct { throw CompanionConnectionError.unreachable(.generic) }
            throw refusal
        } catch {
            ws.close()
            throw CompanionConnectionError.unreachable(.generic)
        }

        guard gen == generation, epoch == dialEpoch else {
            ws.close()
            throw CompanionConnectionError.closed
        }

        let transport: NoiseTransportSession
        let status: CompanionHandshakeStatus
        do {
            let (payload, session) = try initiator.readMessage2(msg2)
            transport = session
            do {
                status = try CompanionHandshakeReply.parse(payload, mode: .session)
            } catch {
                ws.close()
                throw CompanionConnectionError.unreachable(.protocolMismatch)
            }
        } catch let error as CompanionConnectionError {
            throw error
        } catch {
            ws.close()
            // A msg2 that doesn't decrypt proves nothing about the Mac (whoever holds that address, or the relay, can
            // send garbage): a network failure, so hosted still gets its try.
            throw CompanionConnectionError.unreachable(.generic)
        }
        if case .refused(let reason) = status {
            // Authenticated: the Mac completed the handshake only to say this iPhone no longer belongs. Terminal.
            ws.close()
            throw CompanionConnectionError.refused(reason)
        }

        install(socket: ws, session: transport, generation: gen)

        // Everything from here tears down only this attempt's own session: a newer connect that started while hello
        // was in flight (actor reentrancy) keeps its socket.
        // A direct hello must also land inside the attempt's budget; past it, this session is torn down and the
        // failure counts as a network one (hosted gets its try).
        var helloDeadline: Task<Void, Never>?
        if path.kind == .direct {
            let remaining = budget - (ContinuousClock.now - started)
            directHelloPending = gen
            let sleeper = sleep
            helloDeadline = Task { [weak self] in
                try? await sleeper(max(remaining, .zero))
                guard !Task.isCancelled else { return }
                await self?.expireDirectHello(generation: gen)
            }
        }
        defer {
            helloDeadline?.cancel()
            if directHelloPending == gen { directHelloPending = nil }
        }
        let hello: DeviceHello
        do {
            hello = try await call("device.hello", params: EmptyParams(), as: DeviceHello.self, timeout: timing.hello, requireConfirmed: false)
            if directHelloPending == gen { directHelloPending = nil }
        } catch {
            teardown(CompanionConnectionError.closed, ifGeneration: gen)
            // A newer connect (or a disconnect) took over while the hello was in flight: it owns the client now.
            guard epoch == dialEpoch else { throw CompanionConnectionError.closed }
            if case CompanionConnectionError.refused = error { throw error }
            // Only an encrypted refusal of this device's standing is terminal. A timeout, the Mac's own failure or an
            // unreadable answer means the Mac couldn't answer: a network-class failure.
            if let rpc = error as? CompanionRPCError {
                switch rpc.code {
                case CompanionRPCError.standingRevoked, CompanionStreamZeroCode.accountRevoked:
                    throw CompanionConnectionError.refused(CompanionStreamZeroCode.accountRevoked)
                case CompanionStreamZeroCode.deviceRevoked:
                    throw CompanionConnectionError.refused(CompanionStreamZeroCode.deviceRevoked)
                default:
                    throw CompanionConnectionError.unreachable(.generic)
                }
            }
            throw CompanionConnectionError.unreachable(.generic)
        }
        guard gen == generation, epoch == dialEpoch else { throw CompanionConnectionError.closed }
        guard hello.workspaceId == record.workspaceId, hello.deviceId == record.deviceId else {
            teardown(CompanionConnectionError.closed, ifGeneration: gen)
            throw CompanionConnectionError.damaged("identity mismatch")
        }
        confirmedGeneration = gen
        // Only a hello that passed the identity checks may change where we dial next time.
        let refreshed = hello.validPaths.map { record.with(paths: $0) } ?? record
        return CompanionConnectResult(hello: hello, path: path, record: refreshed)
    }

    /// A direct hello still unanswered at the deadline: end that session (its pending hello fails with `.closed`).
    private func expireDirectHello(generation gen: UInt64) {
        guard directHelloPending == gen, gen == generation else { return }
        directHelloPending = nil
        directHelloExpired = gen
        teardown(CompanionConnectionError.closed, ifGeneration: gen)
    }

    /// Probes every direct path's `/v1/health` in parallel (each bounded by `timing.probe`) and returns the first to
    /// answer with `machineId`, and whether any answered for a different machine (stale DHCP, or a reset Mac).
    private func firstHealthyDirect(_ paths: [CompanionPath], machineId: String) async -> (path: CompanionPath?, sawOtherMachine: Bool) {
        let directs = paths.filter { $0.kind == .direct }
        guard !directs.isEmpty else { return (nil, false) }
        let probe = healthProbe
        let timeout = timing.probe
        let sleeper = sleep
        return await withTaskGroup(of: (CompanionPath, String?).self) { group in
            for path in directs {
                guard let health = CompanionPathRules.healthURL(forDirect: path.url) else { continue }
                group.addTask {
                    let answered = await withTaskGroup(of: String?.self) { race in
                        race.addTask { await probe(health, timeout) }
                        race.addTask {
                            try? await sleeper(timeout)
                            return nil
                        }
                        let first = await race.next() ?? nil
                        race.cancelAll()
                        return first
                    }
                    return (path, answered)
                }
            }
            var sawOther = false
            for await (path, answered) in group {
                if answered == machineId {
                    group.cancelAll()
                    return (path, sawOther)
                }
                if let answered, !answered.isEmpty { sawOther = true }
            }
            return (nil, sawOther)
        }
    }

    /// Ends the session, closes any dial in flight, and fails every pending call with `.closed`.
    public func disconnect() {
        dialEpoch &+= 1
        dialSocket?.close()
        dialSocket = nil
        teardown(CompanionConnectionError.closed)
    }

    /// Sends a PING now (the app came to the foreground, the network changed): a dead socket is found within the PONG
    /// deadline instead of on the next read.
    public func checkAlive() {
        guard confirmedGeneration == generation, session != nil else { return }
        sendPing(generation: generation)
    }

    // MARK: Calls

    /// One unary RPC, decoded from its `{ ok, result }` envelope.
    public func call<R: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as type: R.Type = R.self,
        timeout: Duration? = nil
    ) async throws -> R {
        try await call(method, params: params, as: type, timeout: timeout, requireConfirmed: true)
    }

    private func call<R: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as type: R.Type,
        timeout: Duration?,
        requireConfirmed: Bool
    ) async throws -> R {
        let raw = try await callRaw(method, params: params, timeout: timeout, requireConfirmed: requireConfirmed)
        do {
            let envelope = try JSONDecoder().decode(CompanionRPCEnvelope<R>.self, from: raw)
            guard envelope.ok else {
                throw CompanionRPCError(code: CompanionRPCError.invalidResponse, message: "Response was not ok")
            }
            return envelope.result
        } catch let error as CompanionRPCError {
            throw error
        } catch {
            throw CompanionRPCError(code: CompanionRPCError.invalidResponse, message: String(describing: error))
        }
    }

    /// One unary RPC; returns the reassembled response payload (the raw `{ ok, result }` JSON). `timeout` defaults to
    /// `timing.call`. Waits for a free stream slot when 8 are open (B2).
    public func callRaw(_ method: String, params: some Encodable & Sendable, timeout: Duration? = nil) async throws -> Data {
        try await callRaw(method, params: params, timeout: timeout, requireConfirmed: true)
    }

    private func callRaw(
        _ method: String, params: some Encodable & Sendable, timeout: Duration?, requireConfirmed: Bool
    ) async throws -> Data {
        let gen = generation
        guard session != nil, !requireConfirmed || confirmedGeneration == gen else { throw CompanionConnectionError.closed }
        let payload = try JSONEncoder().encode(RPCRequest(method: method, params: params))
        try await acquireSlot(generation: gen)
        let streamId = allocateStreamId()
        let frames = try CompanionFrame.splitRequest(streamId: streamId, payload: payload)
        let callTimeout = timeout ?? timing.call
        let sleeper = sleep

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                let deadline = Task { [weak self] in
                    try? await sleeper(callTimeout)
                    guard !Task.isCancelled else { return }
                    await self?.expireCall(streamId, generation: gen, after: callTimeout)
                }
                pending[streamId] = PendingCall(continuation: continuation, deadline: deadline)
                do {
                    for frame in frames { try enqueue(frame) }
                } catch {
                    finishCall(streamId, with: .failure(error))
                }
            }
        } onCancel: {
            Task { await self.cancelCall(streamId, generation: gen) }
        }
    }

    /// A streaming RPC. Each CHUNK payload is yielded as one element; END finishes the stream; ERROR throws.
    /// Terminating the stream early (the consumer stops iterating) sends CANCEL, which stops watching only.
    ///
    /// The returned stream is pulled, not pushed: credit goes back to the Mac as the consumer takes chunks (in batches
    /// of 8), so the Mac's pacing holds and what waits here is bounded by the credit the Mac was given. At most two
    /// watches at once (the Mac's cap); a third is refused here with `too_many_streams`.
    public func watch(method: String, params: some Encodable & Sendable) throws -> AsyncThrowingStream<Data, Error> {
        let gen = generation
        guard session != nil, confirmedGeneration == gen else { throw CompanionConnectionError.closed }
        guard watches.count < CompanionWire.maxWatches, openStreams < CompanionWire.maxStreams else {
            throw CompanionRPCError(code: CompanionRPCError.tooManyStreams, message: "Two live views are already open")
        }
        let streamId = allocateStreamId()
        let payload = try JSONEncoder().encode(RPCRequest(method: method, params: params))
        let frames = try CompanionFrame.splitRequest(streamId: streamId, payload: payload)

        let (arrived, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .unbounded)
        watches[streamId] = WatchState(continuation: continuation)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.endWatch(streamId, generation: gen) }
        }
        do {
            for frame in frames { try enqueue(frame) }
        } catch {
            removeWatch(streamId)?.continuation.finish(throwing: error)
        }
        let pull = WatchPull(arrived) { [weak self] in
            await self?.watchChunkTaken(streamId, generation: gen)
        }
        return AsyncThrowingStream { try await pull.next() }
    }

    /// The consumer took one chunk: credit it back once a batch has been taken.
    private func watchChunkTaken(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, watches[sid] != nil else { return }
        chunkTaken(sid)
    }

    // MARK: Internals

    private var openStreams: Int { pending.count + watches.count }

    /// Calls queued behind the 8-stream cap (for tests).
    var callsWaitingForSlot: Int { slotWaiters.count }

    private func allocateStreamId() -> UInt32 {
        let id = nextStreamId
        nextStreamId &+= 2
        return id
    }

    /// Returns once fewer than 8 streams are open on this generation's session; throws `.closed` if it ends first.
    private func acquireSlot(generation gen: UInt64) async throws {
        while openStreams >= CompanionWire.maxStreams {
            nextWaiterId &+= 1
            let id = nextWaiterId
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    slotWaiters.append((id, continuation))
                }
            } onCancel: {
                Task { await self.cancelWaiter(id) }
            }
            guard gen == generation, session != nil else { throw CompanionConnectionError.closed }
        }
    }

    private func cancelWaiter(_ id: UInt64) {
        guard let index = slotWaiters.firstIndex(where: { $0.id == id }) else { return }
        slotWaiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }

    /// A stream closed: let the oldest waiting call try for its slot.
    private func slotFreed() {
        guard !slotWaiters.isEmpty, openStreams < CompanionWire.maxStreams else { return }
        slotWaiters.removeFirst().continuation.resume()
    }

    private func removeWatch(_ sid: UInt32) -> WatchState? {
        guard let watch = watches.removeValue(forKey: sid) else { return nil }
        ungranted.removeValue(forKey: sid)
        slotFreed()
        return watch
    }

    private func install(socket ws: any CompanionSocket, session transport: NoiseTransportSession, generation gen: UInt64) {
        socket = ws
        session = transport
        nextStreamId = 1
        awaitingPong = nil

        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        outbox = continuation
        writerTask = Task { [weak self] in
            for await ciphertext in stream {
                do {
                    try await ws.send(ciphertext)
                } catch {
                    await self?.connectionLost(generation: gen, end: .lost)
                    return
                }
            }
        }
        readerTask = Task { [weak self] in
            while !Task.isCancelled {
                let ciphertext: Data
                do {
                    ciphertext = try await ws.receive()
                } catch {
                    await self?.connectionLost(generation: gen, end: .lost)
                    return
                }
                guard let self else { return }
                await self.ingest(ciphertext, generation: gen)
            }
        }
        let interval = timing.ping
        let sleeper = sleep
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await sleeper(interval) } catch { return }
                guard !Task.isCancelled, let self else { return }
                await self.sendPing(generation: gen)
            }
        }
    }

    /// Encrypts and queues one frame. Runs on the actor without suspending, so queue order is nonce order.
    /// A Noise session that can't encrypt any more (expired, closed, at its message limit) is a lost connection.
    private func enqueue(_ frame: CompanionFrame) throws {
        guard let session, let outbox else { throw CompanionConnectionError.closed }
        let plaintext = try frame.encode()
        let ciphertext: Data
        do {
            ciphertext = try session.encrypt(plaintext)
        } catch {
            connectionLost(generation: generation, end: .lost)
            throw CompanionConnectionError.closed
        }
        outbox.yield(ciphertext)
    }

    /// One PING with a PONG deadline (A6). A ping already awaiting its PONG isn't doubled.
    private func sendPing(generation gen: UInt64) {
        guard gen == generation, session != nil, awaitingPong == nil else { return }
        var bytes = [UInt8](repeating: 0, count: 8)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        pingSeq &+= 1
        let seq = pingSeq
        do {
            try enqueue(CompanionFrame(type: .ping, streamId: 0, seq: seq, payload: Data(bytes)))
        } catch {
            return
        }
        awaitingPong = seq
        let limit = timing.pongDeadline
        let sleeper = sleep
        pongDeadlineTask?.cancel()
        pongDeadlineTask = Task { [weak self] in
            do { try await sleeper(limit) } catch { return }
            guard !Task.isCancelled else { return }
            await self?.pongDeadlinePassed(seq: seq, generation: gen)
        }
    }

    private func pongDeadlinePassed(seq: UInt32, generation gen: UInt64) {
        guard gen == generation, awaitingPong == seq else { return }
        connectionLost(generation: gen, end: .lost)
    }

    private func ingest(_ ciphertext: Data, generation gen: UInt64) {
        guard gen == generation, let session else { return }
        let plaintext: Data
        do {
            plaintext = try session.decrypt(ciphertext)
        } catch {
            connectionLost(generation: gen, end: .lost)
            return
        }
        let frame: CompanionFrame
        do {
            frame = try CompanionFrame.decode(plaintext)
        } catch CompanionFramingError.unknownFrameType {
            // Authenticated, just from a newer Mac: skip the frame, keep the session.
            return
        } catch {
            connectionLost(generation: gen, end: .lost)
            return
        }
        dispatch(frame, generation: gen)
    }

    private func dispatch(_ frame: CompanionFrame, generation gen: UInt64) {
        let sid = frame.streamId
        switch frame.type {
        case .pong:
            awaitingPong = nil
            pongDeadlineTask?.cancel()
            pongDeadlineTask = nil
        case .ping:
            try? enqueue(CompanionFrame(type: .pong, streamId: 0, seq: frame.seq, payload: frame.payload))
        case .res:
            if pending[sid] != nil {
                finishCall(sid, with: .success(frame.payload))
            }
        case .chunk:
            if var call = pending[sid] {
                guard frame.seq == call.nextSeq else {
                    finishCall(sid, with: .failure(CompanionRPCError(code: CompanionRPCError.invalidResponse, message: "Chunk out of order")))
                    sendCancel(sid)
                    return
                }
                guard call.assembled.count + frame.payload.count <= CompanionFramingConstants.maxLogicalUnaryResponseBytes else {
                    finishCall(sid, with: .failure(CompanionRPCError(code: CompanionRPCError.responseTooLarge, message: "Response is larger than 1 MiB")))
                    sendCancel(sid)
                    return
                }
                call.assembled.append(frame.payload)
                call.nextSeq &+= 1
                pending[sid] = call
                chunkTaken(sid)
            } else if var watch = watches[sid] {
                // B3: a watch's chunks arrive in order; a gap means something was lost, so the watch ends.
                guard frame.seq == watch.nextSeq else {
                    removeWatch(sid)?.continuation.finish(throwing: CompanionRPCError(
                        code: CompanionRPCError.invalidResponse, message: "Live records out of order"
                    ))
                    sendCancel(sid)
                    return
                }
                watch.nextSeq &+= 1
                watches[sid] = watch
                // Credit goes back as the consumer takes chunks (watchChunkTaken), not on arrival.
                watch.continuation.yield(frame.payload)
            }
        case .end:
            if let call = pending[sid] {
                finishCall(sid, with: .success(call.assembled))
            } else if let watch = removeWatch(sid) {
                watch.continuation.finish()
            }
        case .error:
            let error = Self.decodeError(frame.payload)
            if sid == 0 {
                // Session-level: the Mac ends this session (contract §2.2).
                switch error.code {
                case CompanionStreamZeroCode.deviceRevoked, CompanionStreamZeroCode.accountRevoked:
                    connectionLost(generation: gen, end: .refused(reason: error.code))
                case CompanionStreamZeroCode.rekey:
                    connectionLost(generation: gen, end: .rekey)
                default:
                    connectionLost(generation: gen, end: .lost)
                }
                return
            }
            if pending[sid] != nil {
                finishCall(sid, with: .failure(error))
            } else if let watch = removeWatch(sid) {
                watch.continuation.finish(throwing: error)
            }
            // An encrypted `standing_revoked` is the Mac's verdict on this account: the session is over (A7).
            if error.code == CompanionRPCError.standingRevoked {
                connectionLost(generation: gen, end: .refused(reason: CompanionStreamZeroCode.accountRevoked))
            }
        case .req, .reqChunk, .credit, .cancel:
            break
        }
    }

    /// One chunk taken on `sid`: a CREDIT for the batch once 8 are owed (B1).
    private func chunkTaken(_ sid: UInt32) {
        let owed = (ungranted[sid] ?? 0) + 1
        guard owed >= CompanionWire.creditBatch else {
            ungranted[sid] = owed
            return
        }
        ungranted[sid] = 0
        guard let credit = try? CompanionFrame.creditFrame(streamId: sid, grant: owed) else { return }
        try? enqueue(credit)
    }

    private func sendCancel(_ sid: UInt32) {
        try? enqueue(CompanionFrame(type: .cancel, streamId: sid, seq: 0))
    }

    /// Resumes a pending call exactly once: it is removed before it is resumed.
    private func finishCall(_ sid: UInt32, with result: Result<Data, Error>) {
        guard let call = pending.removeValue(forKey: sid) else { return }
        ungranted.removeValue(forKey: sid)
        call.deadline.cancel()
        call.continuation.resume(with: result)
        slotFreed()
    }

    private func expireCall(_ sid: UInt32, generation gen: UInt64, after limit: Duration) {
        guard gen == generation, pending[sid] != nil else { return }
        let seconds = max(1, Int(limit.components.seconds))
        finishCall(sid, with: .failure(CompanionRPCError(
            code: CompanionRPCError.deadlineExceeded, message: "No answer within \(seconds) second\(seconds == 1 ? "" : "s")"
        )))
        sendCancel(sid)
    }

    private func cancelCall(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, pending[sid] != nil else { return }
        finishCall(sid, with: .failure(CancellationError()))
        sendCancel(sid)
    }

    private func endWatch(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, removeWatch(sid) != nil else { return }
        sendCancel(sid)
    }

    private func connectionLost(generation gen: UInt64, end: CompanionSessionEnd) {
        guard gen == generation, session != nil else { return }
        let confirmed = confirmedGeneration == gen
        let error: Error
        if case .refused(let reason) = end {
            error = CompanionConnectionError.refused(reason)
        } else {
            error = CompanionConnectionError.closed
        }
        teardown(error)
        if confirmed { onSessionEnd?(end) }
    }

    /// Bumps the generation, stops every task, and fails every pending call and watch exactly once.
    /// Tears down only if the current session is still the one made at `gen` (a stale attempt never closes a newer one).
    private func teardown(_ error: Error, ifGeneration gen: UInt64) {
        guard gen == generation else { return }
        teardown(error)
    }

    private func teardown(_ error: Error) {
        generation &+= 1
        confirmedGeneration = nil
        readerTask?.cancel()
        writerTask?.cancel()
        pingTask?.cancel()
        pongDeadlineTask?.cancel()
        readerTask = nil
        writerTask = nil
        pingTask = nil
        pongDeadlineTask = nil
        awaitingPong = nil
        outbox?.finish()
        outbox = nil
        socket?.close()
        socket = nil
        session?.close()
        session = nil
        ungranted = [:]

        let calls = pending
        pending = [:]
        for (_, call) in calls {
            call.deadline.cancel()
            call.continuation.resume(throwing: error)
        }
        let streams = watches
        watches = [:]
        for (_, stream) in streams {
            stream.continuation.finish(throwing: error)
        }
        let waiters = slotWaiters
        slotWaiters = []
        for waiter in waiters {
            waiter.continuation.resume(throwing: CompanionConnectionError.closed)
        }
    }

    static func decodeError(_ payload: Data) -> CompanionRPCError {
        struct Body: Decodable {
            let code: String?
            let message: String?
        }
        let body = try? JSONDecoder().decode(Body.self, from: payload)
        return CompanionRPCError(code: body?.code ?? "unknown", message: body?.message ?? "")
    }

    private static func withDeadline<T: Sendable>(
        _ limit: Duration,
        sleep: @escaping CompanionSleep,
        onTimeout: @escaping @Sendable () -> Void,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await sleep(limit)
                onTimeout()
                throw CompanionConnectionError.unreachable(.generic)
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw CompanionConnectionError.closed }
            return first
        }
    }
}

// MARK: - Pairing link

/// The encrypted channel of one pairing socket after msg2: frames out through one ordered writer, frames in read
/// until the answer on a given stream. Pings keep relay and Mac from seeing silence while the owner compares codes.
private final class PairingLink: @unchecked Sendable {
    private let socket: any CompanionSocket
    private let session: NoiseTransportSession
    private let lock = NSLock()
    private let outbox: AsyncStream<Data>.Continuation
    private let writer: Task<Void, Never>
    private var keepalive: Task<Void, Never>?
    private var pingSeq: UInt32 = 0
    /// Answers that arrived for a stream nobody is awaiting yet.
    private var parked: [UInt32: Result<Data, Error>] = [:]

    init(socket: any CompanionSocket, session: NoiseTransportSession) {
        self.socket = socket
        self.session = session
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        outbox = continuation
        writer = Task {
            for await ciphertext in stream {
                do { try await socket.send(ciphertext) } catch { socket.close(); return }
            }
        }
    }

    /// Encrypts under the lock (nonce order = queue order) and queues.
    func send(_ frame: CompanionFrame) throws {
        let plaintext = try frame.encode()
        let ciphertext = try lock.withLock { try session.encrypt(plaintext) }
        outbox.yield(ciphertext)
    }

    func startKeepalive(every interval: Duration, sleep: @escaping CompanionSleep) {
        let task = Task { [weak self] in
            while !Task.isCancelled {
                do { try await sleep(interval) } catch { return }
                guard !Task.isCancelled, let self else { return }
                self.ping()
            }
        }
        lock.withLock { keepalive = task }
    }

    private func ping() {
        let seq = lock.withLock { () -> UInt32 in
            pingSeq &+= 1
            return pingSeq
        }
        try? send(CompanionFrame(type: .ping, streamId: 0, seq: seq, payload: Data(count: 8)))
    }

    /// Reads frames until `stream` gets its RES (returned) or ERROR (thrown as a pairing error). PINGs are answered,
    /// PONGs and frames of unknown types skipped. Anything else (a bad frame, a close) throws.
    func awaitAnswer(on stream: UInt32) async throws -> Data {
        if let early = lock.withLock({ parked.removeValue(forKey: stream) }) { return try early.get() }
        while true {
            let ciphertext = try await socket.receive()
            let plaintext = try lock.withLock { try session.decrypt(ciphertext) }
            let frame: CompanionFrame
            do {
                frame = try CompanionFrame.decode(plaintext)
            } catch CompanionFramingError.unknownFrameType {
                continue
            }
            switch frame.type {
            case .ping:
                try? send(CompanionFrame(type: .pong, streamId: 0, seq: frame.seq, payload: frame.payload))
            case .res where frame.streamId == stream:
                return frame.payload
            case .error where frame.streamId == stream || frame.streamId == 0:
                throw CompanionPairingError(code: CompanionRelayClient.decodeError(frame.payload).code)
            case .res:
                lock.withLock { parked[frame.streamId] = .success(frame.payload) }
            default:
                continue
            }
        }
    }

    func stop() {
        lock.withLock { keepalive?.cancel() }
        outbox.finish()
    }
}

/// Pulls one watch's arrived chunks for its consumer, reporting each one taken (which grants the Mac its credit).
/// Only ever iterated by one consumer at a time (the returned stream's), so the iterator is never shared.
private final class WatchPull: @unchecked Sendable {
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator
    private let taken: @Sendable () async -> Void

    init(_ arrived: AsyncThrowingStream<Data, Error>, taken: @escaping @Sendable () async -> Void) {
        iterator = arrived.makeAsyncIterator()
        self.taken = taken
    }

    func next() async throws -> Data? {
        guard let chunk = try await iterator.next() else { return nil }
        await taken()
        return chunk
    }
}
