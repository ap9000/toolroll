import CryptoKit
import Foundation

// MARK: - Errors

/// Why a connection to the Mac couldn't be made or was lost.
public enum CompanionConnectionError: Error, Equatable, Sendable {
    /// The relay or the Mac couldn't be reached (network, relay down, Mac offline, timeout).
    case unreachable(String)
    /// The Mac (or the relay on its behalf) refused this iPhone's keys, or `device.hello` failed.
    case handshakeFailed(String)
    /// The session ended (socket closed, missed pings, or this client disconnected).
    case closed
}

/// A typed RPC failure: the ERROR frame's `{ code, message }`.
public struct CompanionRPCError: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public static let notFound = "not_found"
    public static let invalidParams = "invalid_params"
    public static let invalidCursor = "invalid_cursor"
    public static let handlerError = "handler_error"
    public static let routeNotAllowed = "route_not_allowed"
    public static let helloRequired = "hello_required"
    public static let deadlineExceeded = "deadline_exceeded"
    public static let responseTooLarge = "response_too_large"
    public static let invalidResponse = "invalid_response"
}

// MARK: - Socket

/// One WebSocket carrying Noise messages as binary frames. Abstracted so the client can be tested in memory.
public protocol CompanionSocket: AnyObject, Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func close()
}

public typealias CompanionSocketFactory = @Sendable (URLRequest) -> any CompanionSocket

/// `URLSessionWebSocketTask` as a `CompanionSocket`. A 403 on upgrade (the relay's
/// "unknown or revoked device") surfaces as `handshakeFailed`; network failures as `unreachable`.
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
        if let http = task.response as? HTTPURLResponse, http.statusCode == 403 {
            return CompanionConnectionError.handshakeFailed("refused")
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled: return CompanionConnectionError.closed
            default: return CompanionConnectionError.unreachable(urlError.localizedDescription)
            }
        }
        return CompanionConnectionError.closed
    }
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

        public init(connect: Duration = .seconds(15), call: Duration = .seconds(30), ping: Duration = .seconds(25)) {
            self.connect = connect
            self.call = call
            self.ping = ping
        }
    }

    private struct PendingCall {
        let continuation: CheckedContinuation<Data, Error>
        var assembled = Data()
        var nextSeq: UInt32 = 0
        let deadline: Task<Void, Never>
    }

    private struct RPCRequest<P: Encodable>: Encodable {
        let method: String
        let params: P
    }

    private struct EmptyParams: Encodable, Sendable {}

    private let socketFactory: CompanionSocketFactory
    private let timing: Timing

    private var generation: UInt64 = 0
    private var socket: (any CompanionSocket)?
    private var session: NoiseTransportSession?
    private var outbox: AsyncStream<Data>.Continuation?
    private var readerTask: Task<Void, Never>?
    private var writerTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var pingsOutstanding = 0
    private var pingSeq: UInt32 = 0
    private var nextStreamId: UInt32 = 1
    private var pending: [UInt32: PendingCall] = [:]
    private var watches: [UInt32: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var onConnectionLost: (@Sendable (Error) -> Void)?
    private var pairingSocket: (any CompanionSocket)?

    public init(
        timing: Timing = Timing(),
        socketFactory: @escaping CompanionSocketFactory = { URLSessionCompanionSocket(request: $0) }
    ) {
        self.timing = timing
        self.socketFactory = socketFactory
    }

    /// Called (once per connection) when an established connection drops on its own: socket closed, two missed
    /// PONGs, a frame that didn't decrypt. Not called for `disconnect()`.
    public func setConnectionLostHandler(_ handler: (@Sendable (Error) -> Void)?) {
        onConnectionLost = handler
    }

    public var isConnected: Bool { session != nil }

    // MARK: Pairing (ceremony unchanged)

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
        let ws = socketFactory(req)
        pairingSocket?.close()
        pairingSocket = ws
        defer {
            ws.close()
            if pairingSocket === ws { pairingSocket = nil }
        }

        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "mode": "pair",
            "deviceName": deviceName,
            "deviceRelayPub": CompanionRelayAuth.base64UrlEncode(deviceRelay.publicKey.rawRepresentation),
        ])
        let msg1 = try initiator.writeMessage1(payload: msg1Payload)
        try await ws.send(msg1)

        let msg2Raw = try await ws.receive()
        let (_, pairSession) = try initiator.readMessage2(msg2Raw)
        let code = try CompanionDerivations.confirmationCode(handshakeHash: pairSession.handshakeHash)
        await onCodeReady(code)

        // Wait for the Mac owner to confirm the match -> Mac sends encrypted `pair.confirmed`.
        let finCt = try await ws.receive()
        try Task.checkCancellation()
        let finPlain = try pairSession.decrypt(finCt)
        guard let fin = try JSONSerialization.jsonObject(with: finPlain) as? [String: Any],
              fin["type"] as? String == "pair.confirmed",
              let deviceId = fin["deviceId"] as? String,
              let recoveryGeneration = fin["recoveryGeneration"] as? String,
              let entropyB64 = fin["pskEntropy"] as? String,
              let pskEntropy = CompanionRelayAuth.base64UrlDecode(entropyB64)
        else {
            throw CompanionNoiseError.authenticationFailed
        }

        let devicePsk = try CompanionDerivations.deriveDevicePsk(
            pskEntropy: pskEntropy,
            handshakeHash: pairSession.handshakeHash,
            workspaceId: qr.workspaceId,
            deviceId: deviceId
        )

        let record = PairedWorkspaceRecord(
            workspaceId: qr.workspaceId,
            workspaceLabel: "Your Mac",
            machineId: qr.machineId,
            relayUrl: qr.relayUrl,
            macStaticPubBase64Url: qr.macStaticPub,
            deviceId: deviceId,
            recoveryGeneration: recoveryGeneration,
            pairedAt: Date()
        )
        return (record, devicePsk, phoneNoise.privateKey, deviceRelay.rawRepresentation)
    }

    /// Closes an in-flight pairing socket (Cancel pairing, entering the demo).
    public func cancelPairing() {
        pairingSocket?.close()
        pairingSocket = nil
    }

    // MARK: Session

    /// 1-RTT Noise IKpsk2 reconnect followed by the mandatory `device.hello` key confirmation.
    /// The hello must name the stored workspace and device.
    @discardableResult
    public func connect(
        record: PairedWorkspaceRecord,
        devicePsk: Data,
        phoneNoisePriv: Data,
        deviceRelayPriv: Data
    ) async throws -> DeviceHello {
        teardown(CompanionConnectionError.closed)
        let gen = generation

        guard let url = URL(string: record.relayUrl),
              let macStaticPub = CompanionRelayAuth.base64UrlDecode(record.macStaticPubBase64Url)
        else {
            throw CompanionConnectionError.handshakeFailed("invalid stored record")
        }
        let initiator: NoiseIKpsk2Initiator
        let token: String
        do {
            let phoneNoise = try X25519KeyPair(privateKey: phoneNoisePriv)
            let relayKey = try Curve25519.Signing.PrivateKey(rawRepresentation: deviceRelayPriv)
            token = try CompanionRelayAuth.signDeviceToken(
                privateKey: relayKey,
                machineId: record.machineId,
                deviceId: record.deviceId
            )
            let prologue = try CompanionDerivations.sessionPrologue(
                workspaceId: record.workspaceId,
                deviceId: record.deviceId,
                recoveryGeneration: record.recoveryGeneration
            )
            initiator = try NoiseIKpsk2Initiator(
                localStatic: phoneNoise,
                remoteStaticPublicKey: macStaticPub,
                psk: devicePsk,
                prologue: prologue
            )
        } catch {
            throw CompanionConnectionError.handshakeFailed("invalid stored keys")
        }

        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let ws = socketFactory(req)

        let msg1Payload = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "mode": "session",
            "deviceId": record.deviceId,
        ])
        let msg1 = try initiator.writeMessage1(payload: msg1Payload)

        let msg2: Data
        do {
            msg2 = try await Self.withDeadline(timing.connect, onTimeout: { ws.close() }) {
                try await ws.send(msg1)
                return try await ws.receive()
            }
        } catch let error as CompanionConnectionError {
            ws.close()
            if case .closed = error { throw CompanionConnectionError.unreachable("closed before handshake") }
            throw error
        } catch {
            ws.close()
            throw CompanionConnectionError.unreachable(String(describing: error))
        }

        guard gen == generation else {
            ws.close()
            throw CompanionConnectionError.closed
        }

        let transport: NoiseTransportSession
        do {
            (_, transport) = try initiator.readMessage2(msg2)
        } catch {
            ws.close()
            throw CompanionConnectionError.handshakeFailed("noise")
        }

        install(socket: ws, session: transport, generation: gen)

        // Everything from here tears down only this attempt's own session: a newer connect that started while hello
        // was in flight (actor reentrancy) keeps its socket.
        let hello: DeviceHello
        do {
            hello = try await call("device.hello", params: EmptyParams(), as: DeviceHello.self)
        } catch let error as CompanionRPCError {
            teardown(CompanionConnectionError.closed, ifGeneration: gen)
            throw CompanionConnectionError.handshakeFailed(error.code)
        } catch {
            teardown(CompanionConnectionError.closed, ifGeneration: gen)
            throw CompanionConnectionError.unreachable("closed during hello")
        }
        guard gen == generation else { throw CompanionConnectionError.closed }
        guard hello.workspaceId == record.workspaceId, hello.deviceId == record.deviceId else {
            teardown(CompanionConnectionError.closed, ifGeneration: gen)
            throw CompanionConnectionError.handshakeFailed("identity mismatch")
        }
        return hello
    }

    /// Ends the session and fails every pending call with `.closed`.
    public func disconnect() {
        teardown(CompanionConnectionError.closed)
    }

    // MARK: Calls

    /// One unary RPC, decoded from its `{ ok, result }` envelope.
    public func call<R: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as type: R.Type = R.self
    ) async throws -> R {
        let raw = try await callRaw(method, params: params)
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

    /// One unary RPC; returns the reassembled response payload (the raw `{ ok, result }` JSON).
    public func callRaw(_ method: String, params: some Encodable & Sendable) async throws -> Data {
        guard session != nil else { throw CompanionConnectionError.closed }
        let gen = generation
        let streamId = allocateStreamId()
        let payload = try JSONEncoder().encode(RPCRequest(method: method, params: params))
        let frames = try CompanionFrame.splitRequest(streamId: streamId, payload: payload)
        let callTimeout = timing.call

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                let deadline = Task { [weak self] in
                    try? await Task.sleep(for: callTimeout)
                    guard !Task.isCancelled else { return }
                    await self?.expireCall(streamId, generation: gen)
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
    public func watch(method: String, params: some Encodable & Sendable) throws -> AsyncThrowingStream<Data, Error> {
        guard session != nil else { throw CompanionConnectionError.closed }
        let gen = generation
        let streamId = allocateStreamId()
        let payload = try JSONEncoder().encode(RPCRequest(method: method, params: params))
        let frames = try CompanionFrame.splitRequest(streamId: streamId, payload: payload)

        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .unbounded)
        watches[streamId] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.endWatch(streamId, generation: gen) }
        }
        do {
            for frame in frames { try enqueue(frame) }
        } catch {
            watches.removeValue(forKey: streamId)
            continuation.finish(throwing: error)
        }
        return stream
    }

    // MARK: Internals

    private func allocateStreamId() -> UInt32 {
        let id = nextStreamId
        nextStreamId &+= 2
        return id
    }

    private func install(socket ws: any CompanionSocket, session transport: NoiseTransportSession, generation gen: UInt64) {
        socket = ws
        session = transport
        nextStreamId = 1
        pingsOutstanding = 0

        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        outbox = continuation
        writerTask = Task { [weak self] in
            for await ciphertext in stream {
                do {
                    try await ws.send(ciphertext)
                } catch {
                    await self?.connectionLost(generation: gen, error: CompanionConnectionError.closed)
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
                    await self?.connectionLost(generation: gen, error: CompanionConnectionError.closed)
                    return
                }
                guard let self else { return }
                await self.ingest(ciphertext, generation: gen)
            }
        }
        let interval = timing.ping
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.pingTick(generation: gen)
            }
        }
    }

    /// Encrypts and queues one frame. Runs on the actor without suspending, so queue order is nonce order.
    private func enqueue(_ frame: CompanionFrame) throws {
        guard let session, let outbox else { throw CompanionConnectionError.closed }
        let ciphertext = try session.encrypt(try frame.encode())
        outbox.yield(ciphertext)
    }

    private func pingTick(generation gen: UInt64) {
        guard gen == generation, session != nil else { return }
        if pingsOutstanding >= 2 {
            connectionLost(generation: gen, error: CompanionConnectionError.closed)
            return
        }
        var bytes = [UInt8](repeating: 0, count: 8)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        pingSeq &+= 1
        do {
            try enqueue(CompanionFrame(type: .ping, streamId: 0, seq: pingSeq, payload: Data(bytes)))
            pingsOutstanding += 1
        } catch {
            connectionLost(generation: gen, error: CompanionConnectionError.closed)
        }
    }

    private func ingest(_ ciphertext: Data, generation gen: UInt64) {
        guard gen == generation, let session else { return }
        let frame: CompanionFrame
        do {
            frame = try CompanionFrame.decode(try session.decrypt(ciphertext))
        } catch {
            connectionLost(generation: gen, error: CompanionConnectionError.closed)
            return
        }
        dispatch(frame)
    }

    private func dispatch(_ frame: CompanionFrame) {
        let sid = frame.streamId
        switch frame.type {
        case .pong:
            pingsOutstanding = 0
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
                sendCredit(sid)
            } else if let watch = watches[sid] {
                watch.yield(frame.payload)
                sendCredit(sid)
            }
        case .end:
            if let call = pending[sid] {
                finishCall(sid, with: .success(call.assembled))
            } else if let watch = watches.removeValue(forKey: sid) {
                watch.finish()
            }
        case .error:
            let error = Self.decodeError(frame.payload)
            if pending[sid] != nil {
                finishCall(sid, with: .failure(error))
            } else if let watch = watches.removeValue(forKey: sid) {
                watch.finish(throwing: error)
            }
        case .req, .reqChunk, .credit, .cancel:
            break
        }
    }

    private func sendCredit(_ sid: UInt32) {
        guard let credit = try? CompanionFrame.creditFrame(streamId: sid, grant: 1) else { return }
        try? enqueue(credit)
    }

    private func sendCancel(_ sid: UInt32) {
        try? enqueue(CompanionFrame(type: .cancel, streamId: sid, seq: 0))
    }

    /// Resumes a pending call exactly once: it is removed before it is resumed.
    private func finishCall(_ sid: UInt32, with result: Result<Data, Error>) {
        guard let call = pending.removeValue(forKey: sid) else { return }
        call.deadline.cancel()
        call.continuation.resume(with: result)
    }

    private func expireCall(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, pending[sid] != nil else { return }
        finishCall(sid, with: .failure(CompanionRPCError(code: CompanionRPCError.deadlineExceeded, message: "No answer within 30 seconds")))
        sendCancel(sid)
    }

    private func cancelCall(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, pending[sid] != nil else { return }
        finishCall(sid, with: .failure(CancellationError()))
        sendCancel(sid)
    }

    private func endWatch(_ sid: UInt32, generation gen: UInt64) {
        guard gen == generation, watches.removeValue(forKey: sid) != nil else { return }
        sendCancel(sid)
    }

    private func connectionLost(generation gen: UInt64, error: Error) {
        guard gen == generation, session != nil else { return }
        teardown(error)
        onConnectionLost?(error)
    }

    /// Bumps the generation, stops every task, and fails every pending call and watch exactly once.
    /// Tears down only if the current session is still the one made at `gen` (a stale attempt never closes a newer one).
    private func teardown(_ error: Error, ifGeneration gen: UInt64) {
        guard gen == generation else { return }
        teardown(error)
    }

    private func teardown(_ error: Error) {
        generation &+= 1
        readerTask?.cancel()
        writerTask?.cancel()
        pingTask?.cancel()
        readerTask = nil
        writerTask = nil
        pingTask = nil
        outbox?.finish()
        outbox = nil
        socket?.close()
        socket = nil
        session?.close()
        session = nil

        let calls = pending
        pending = [:]
        for (_, call) in calls {
            call.deadline.cancel()
            call.continuation.resume(throwing: error)
        }
        let streams = watches
        watches = [:]
        for (_, stream) in streams {
            stream.finish(throwing: error)
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
        onTimeout: @escaping @Sendable () -> Void,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: limit)
                onTimeout()
                throw CompanionConnectionError.unreachable("timed out")
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw CompanionConnectionError.closed }
            return first
        }
    }
}
