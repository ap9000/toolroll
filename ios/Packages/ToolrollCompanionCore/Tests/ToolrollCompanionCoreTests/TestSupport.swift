import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// An in-memory phone socket wired to a fake Mac that speaks Noise IKpsk2, the padded msg2, the pairing exchange and the
// 13-byte framing. Placeholder addresses and ids only.

actor Mailbox {
    private var items: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private(set) var closed = false

    func put(_ data: Data) {
        guard !closed else { return }
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: data)
        } else {
            items.append(data)
        }
    }

    func take() async throws -> Data {
        if !items.isEmpty { return items.removeFirst() }
        if closed { throw CompanionConnectionError.closed }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func close() {
        closed = true
        waiter?.resume(throwing: CompanionConnectionError.closed)
        waiter = nil
    }
}

/// Waits until `condition` holds, polling, and fails the test if it doesn't within `timeout`. Every wait in these
/// tests waits on a fact (a frame the fake Mac saw, a flag the client set), never on a fixed sleep.
func waitUntil(
    _ what: String,
    timeout: Duration = .seconds(5),
    _ condition: @Sendable () async -> Bool
) async throws {
    let deadline = ContinuousClock.now + timeout
    while !(await condition()) {
        guard ContinuousClock.now < deadline else {
            Issue.record("Timed out waiting for: \(what)")
            throw CancellationError()
        }
        try await Task.sleep(for: .milliseconds(5))
    }
}

/// A one-shot signal one side awaits and the other fires (also used as a gate the test opens).
actor Signal {
    private var fired = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var isFired: Bool { fired }

    func fire() {
        guard !fired else { return }
        fired = true
        waiters.forEach { $0.resume() }
        waiters = []
    }

    func wait() async {
        if fired { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

/// A clock the test advances by hand: every timer the client starts (ping interval, PONG deadline, call and pairing
/// deadlines, keepalive) sleeps on it, so timing tests never wait on wall time.
final class ManualClock: @unchecked Sendable {
    private struct Sleeper {
        let id: Int
        let deadline: Duration
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var elapsed: Duration = .zero
    private var sleepers: [Sleeper] = []
    private var cancelled: Set<Int> = []
    private var nextId = 0
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    var pending: Int { lock.withLock { sleepers.count } }
    /// The deadlines of the timers waiting now (relative to the clock's start).
    var deadlines: [Duration] { lock.withLock { sleepers.map(\.deadline).sorted() } }

    var date: Date {
        lock.withLock {
            start.addingTimeInterval(Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18)
        }
    }

    func sleep(_ duration: Duration) async throws {
        let id = lock.withLock { () -> Int in
            nextId += 1
            return nextId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let resumeNow: Bool = lock.withLock {
                    if cancelled.remove(id) != nil { return true }
                    sleepers.append(Sleeper(id: id, deadline: elapsed + duration, continuation: continuation))
                    return false
                }
                if resumeNow { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let sleeper: Sleeper? = lock.withLock {
                if let index = sleepers.firstIndex(where: { $0.id == id }) { return sleepers.remove(at: index) }
                cancelled.insert(id)
                return nil
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        let due: [Sleeper] = lock.withLock {
            elapsed += duration
            let ready = sleepers.filter { $0.deadline <= elapsed }
            sleepers.removeAll { $0.deadline <= elapsed }
            return ready
        }
        due.forEach { $0.continuation.resume() }
    }
}

/// How a fake socket behaves on its way to the Mac.
enum SocketMode: Sendable {
    case normal
    /// The relay refuses the upgrade with this status and headers.
    case relayRefusal(CompanionRelayRefusal)
    /// The network fails before the handshake reply arrives.
    case dropBeforeReply
    /// The handshake completes, then the socket dies as `device.hello` goes out.
    case dropOnHello
    /// Something (not the Mac) answers msg1 with bytes that aren't a valid msg2.
    case garbageReply
    /// The socket closes after msg1, before any msg2.
    case closeBeforeReply
    /// msg1 goes nowhere and nothing ever answers.
    case stallBeforeReply
    /// The handshake completes, then `device.hello` is never answered.
    case stallHello
    /// The socket never opens: sending message 1 hangs.
    case stallOpen
}

final class PipeSocket: CompanionSocket, @unchecked Sendable {
    let toPhone = Mailbox()
    let mac: FakeMac
    let mode: SocketMode
    let request: URLRequest
    private let lock = NSLock()
    private var sent = 0
    private var _closed = false

    var isClosed: Bool { lock.withLock { _closed } }

    init(mac: FakeMac, mode: SocketMode, request: URLRequest) {
        self.mac = mac
        self.mode = mode
        self.request = request
    }

    func send(_ data: Data) async throws {
        let index = lock.withLock { () -> Int in
            defer { sent += 1 }
            return sent
        }
        switch mode {
        case .normal:
            break
        case .relayRefusal(let refusal):
            throw refusal
        case .dropBeforeReply:
            close()
            throw CompanionConnectionError.unreachable(.generic)
        case .dropOnHello:
            if index >= 1 {
                close()
                throw CompanionConnectionError.closed
            }
        case .garbageReply:
            await toPhone.put(Data((0..<96).map { _ in UInt8.random(in: 0...255) }))
            return
        case .closeBeforeReply:
            await toPhone.close()
            return
        case .stallBeforeReply:
            return
        case .stallHello:
            if index >= 1 { return }
        case .stallOpen:
            try await Task.sleep(for: .seconds(60))
            throw CompanionConnectionError.closed
        }
        try await mac.receive(data, socket: self)
    }

    func receive() async throws -> Data {
        try await toPhone.take()
    }

    func close() {
        lock.withLock { _closed = true }
        Task { await toPhone.close() }
    }
}

enum Behavior: Sendable {
    case result(String)
    case chunked(String, chunkBytes: Int)
    /// CHUNK frames with these seq numbers and payloads, then END if `end`.
    case rawChunks([(UInt32, String)], end: Bool)
    case error(code: String, message: String)
    case silent
    /// Answers only once the test opens the gate.
    case gated(String, Signal)
    case watch([String])
    case watchEnd([String])
    case watchError([String], code: String)
}

/// How the fake Mac answers `pair.ready`.
enum PairReady: Sendable {
    case success
    case error(String)
    case silent
    case dropSocket
}

/// The pairing side of the fake Mac (when set, every socket is a pairing socket).
struct FakePairing: Sendable {
    let pairPsk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let pskEntropy = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let deviceId = "dev-new"
    let recoveryGeneration = "0123456789abcdef0123456789abcdef"
    var expiresAtMs: Double?
}

actor FakeMac {
    let macStatic = X25519KeyPair.generate()
    let devicePsk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let prologue: Data
    var helloDeviceId = "dev-1"
    /// Raw JSON for the hello's `paths`, or nil for none.
    var helloPaths: String?
    var helloConsoleUrl: String?
    /// The Mac refuses this device at hello.
    var helloError: (code: String, message: String)?
    /// The next hello this many sockets send goes unanswered.
    var helloHolds = 0
    /// Fired when a held hello arrives.
    let helloHeld = Signal()
    var answerPings = true
    var behaviors: [String: Behavior] = [:]
    /// The session msg2: `awaiting_hello`, or `refused` with this reason.
    var refuseWith: String?

    var pairing: FakePairing?
    var pairReady: PairReady = .success
    var answerPairDone = true
    /// Fired when `pair.ready` arrives.
    let pairReadyArrived = Signal()
    /// Gate the test opens to let the pair.ready outcome go out.
    var pairReadyGate: Signal?
    /// msg1's fields as text (`deviceName` present → "deviceName").
    private(set) var pairMsg1: [String: String] = [:]
    private(set) var pairReadyName: String?
    private(set) var pairDoneDeviceId: String?
    private(set) var pairCode: String?
    private(set) var pairHandshakeHash: Data?

    /// One Noise session per socket, so a fallback socket gets its own handshake.
    private var sessions: [ObjectIdentifier: NoiseTransportSession] = [:]
    private(set) var credits: [UInt32: Int] = [:]
    private(set) var creditFrames: [UInt32: Int] = [:]
    private(set) var cancels: [UInt32] = []
    private(set) var pings = 0
    private(set) var methods: [String] = []
    private(set) var events: [String] = []
    private(set) var msg2Sizes: [Int] = []

    init() throws {
        prologue = try CompanionDerivations.sessionPrologue(workspaceId: "ws-1", deviceId: "dev-1", recoveryGeneration: "0123456789abcdef0123456789abcdef")
    }

    func set(_ method: String, _ behavior: Behavior) { behaviors[method] = behavior }
    func setAnswerPings(_ value: Bool) { answerPings = value }
    func setHelloDeviceId(_ id: String) { helloDeviceId = id }
    func setHelloPaths(_ json: String?) { helloPaths = json }
    func setHelloConsoleUrl(_ url: String?) { helloConsoleUrl = url }
    func setHelloError(code: String, message: String) { helloError = (code, message) }
    func holdNextHello() { helloHolds += 1 }
    func setRefuse(_ reason: String?) { refuseWith = reason }
    func setPairing(_ value: FakePairing) { pairing = value }
    func setPairReady(_ value: PairReady) { pairReady = value }
    func setPairReadyGate(_ gate: Signal?) { pairReadyGate = gate }
    func setAnswerPairDone(_ value: Bool) { answerPairDone = value }
    func log(_ event: String) { events.append(event) }

    func receive(_ data: Data, socket: PipeSocket) async throws {
        let key = ObjectIdentifier(socket)
        guard let session = sessions[key] else {
            try await handshake(data, socket: socket)
            return
        }
        let frame = try CompanionFrame.decode(try session.decrypt(data))
        switch frame.type {
        case .ping:
            pings += 1
            if answerPings { await push(CompanionFrame(type: .pong, streamId: 0, seq: frame.seq, payload: frame.payload), socket) }
        case .credit:
            let grant = frame.payload.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
            credits[frame.streamId, default: 0] += Int(grant)
            creditFrames[frame.streamId, default: 0] += 1
        case .cancel:
            cancels.append(frame.streamId)
        case .req:
            let req = try JSONSerialization.jsonObject(with: frame.payload) as! [String: Any]
            let method = req["method"] as! String
            methods.append(method)
            events.append(method)
            if pairing != nil {
                await pairingRequest(method, params: req["params"] as? [String: Any] ?? [:], streamId: frame.streamId, socket: socket)
                return
            }
            if method == "device.hello" {
                if helloHolds > 0 {
                    helloHolds -= 1
                    await helloHeld.fire()
                    return
                }
                if let helloError {
                    await respond(.error(code: helloError.code, message: helloError.message), streamId: frame.streamId, socket: socket)
                    return
                }
                let paths = helloPaths.map { #","paths":\#($0)"# } ?? ""
                let console = helloConsoleUrl.map { #","consoleUrl":"\#($0)""# } ?? ""
                let hello = #"{"ok":true,"result":{"version":1,"workspaceId":"ws-1","workspaceLabel":"Studio Mac","account":"owner","deviceId":"\#(helloDeviceId)","toolroll":"0.9.130"\#(paths)\#(console)}}"#
                await push(CompanionFrame(type: .res, streamId: frame.streamId, seq: 0, payload: Data(hello.utf8)), socket)
                return
            }
            await respond(behaviors[method] ?? .error(code: "route_not_allowed", message: "no"), streamId: frame.streamId, socket: socket)
        default:
            break
        }
    }

    private func handshake(_ data: Data, socket: PipeSocket) async throws {
        let key = ObjectIdentifier(socket)
        if let pairing {
            let prologue = try CompanionDerivations.pairingPrologue(workspaceId: "ws-1", pairSessionId: "ps-1")
            let responder = try NoiseIKpsk2Responder(localStatic: macStatic, psk: pairing.pairPsk, prologue: prologue)
            let (payload, _) = try responder.readMessage1(data)
            let fields = (try JSONSerialization.jsonObject(with: payload) as? [String: Any]) ?? [:]
            pairMsg1 = fields.mapValues { "\($0)" }
            events.append("msg1")
            let reply = try CompanionHandshakeReply.padded(["protocolVersion": 1, "status": "awaiting_ready"])
            msg2Sizes.append(reply.count)
            let (msg2, transport) = try responder.writeMessage2(payload: reply)
            sessions[key] = transport
            pairHandshakeHash = transport.handshakeHash
            pairCode = try CompanionDerivations.confirmationCode(handshakeHash: transport.handshakeHash)
            await socket.toPhone.put(msg2)
            return
        }
        let responder = try NoiseIKpsk2Responder(localStatic: macStatic, psk: devicePsk, prologue: prologue)
        _ = try responder.readMessage1(data)
        var fields: [String: Any] = ["protocolVersion": 1, "status": "awaiting_hello"]
        if let refuseWith {
            fields["status"] = "refused"
            fields["reason"] = refuseWith
        }
        let reply = try CompanionHandshakeReply.padded(fields)
        msg2Sizes.append(reply.count)
        let (msg2, transport) = try responder.writeMessage2(payload: reply)
        sessions[key] = transport
        await socket.toPhone.put(msg2)
    }

    private func pairingRequest(_ method: String, params: [String: Any], streamId: UInt32, socket: PipeSocket) async {
        guard let pairing else { return }
        switch method {
        case "pair.ready":
            pairReadyName = params["deviceName"] as? String
            await pairReadyArrived.fire()
            let behavior = pairReady
            let gate = pairReadyGate
            Task {
                await gate?.wait()
                await self.answerPairReady(behavior, pairing: pairing, streamId: streamId, socket: socket)
            }
        case "pair.done":
            pairDoneDeviceId = params["deviceId"] as? String
            if answerPairDone {
                await push(CompanionFrame(type: .res, streamId: streamId, seq: 0, payload: Data(#"{"ok":true,"result":{"ok":true}}"#.utf8)), socket)
            }
        default:
            break
        }
    }

    private func answerPairReady(_ behavior: PairReady, pairing: FakePairing, streamId: UInt32, socket: PipeSocket) async {
        switch behavior {
        case .success:
            let entropy = CompanionRelayAuth.base64UrlEncode(pairing.pskEntropy)
            let body = #"{"ok":true,"result":{"deviceId":"\#(pairing.deviceId)","recoveryGeneration":"\#(pairing.recoveryGeneration)","pskEntropy":"\#(entropy)"}}"#
            events.append("pair.ready.res")
            await push(CompanionFrame(type: .res, streamId: streamId, seq: 0, payload: Data(body.utf8)), socket)
        case .error(let code):
            await push(CompanionFrame(type: .error, streamId: streamId, seq: 0, payload: Data(#"{"code":"\#(code)","message":"no"}"#.utf8)), socket)
        case .silent:
            break
        case .dropSocket:
            socket.close()
        }
    }

    /// The device PSK the Mac derives for the paired phone.
    func pairedDevicePsk() throws -> Data? {
        guard let pairing, let hash = pairHandshakeHash else { return nil }
        return try CompanionDerivations.deriveDevicePsk(pskEntropy: pairing.pskEntropy, handshakeHash: hash, workspaceId: "ws-1", deviceId: pairing.deviceId)
    }

    private func respond(_ behavior: Behavior, streamId: UInt32, socket: PipeSocket) async {
        switch behavior {
        case .result(let json):
            await push(CompanionFrame(type: .res, streamId: streamId, seq: 0, payload: Data("{\"ok\":true,\"result\":\(json)}".utf8)), socket)
        case .chunked(let json, let size):
            let payload = Data("{\"ok\":true,\"result\":\(json)}".utf8)
            var seq: UInt32 = 0
            var offset = 0
            while offset < payload.count {
                let end = min(offset + size, payload.count)
                await push(CompanionFrame(type: .chunk, streamId: streamId, seq: seq, payload: payload.subdata(in: offset..<end)), socket)
                seq += 1
                offset = end
            }
            await push(CompanionFrame(type: .end, streamId: streamId, seq: seq), socket)
        case .rawChunks(let chunks, let end):
            for (seq, text) in chunks {
                await push(CompanionFrame(type: .chunk, streamId: streamId, seq: seq, payload: Data(text.utf8)), socket)
            }
            if end { await push(CompanionFrame(type: .end, streamId: streamId, seq: UInt32(chunks.count)), socket) }
        case .error(let code, let message):
            await push(CompanionFrame(type: .error, streamId: streamId, seq: 0, payload: Data(#"{"code":"\#(code)","message":"\#(message)"}"#.utf8)), socket)
        case .silent:
            break
        case .gated(let json, let gate):
            Task {
                await gate.wait()
                await self.respond(.result(json), streamId: streamId, socket: socket)
            }
        case .watch(let records), .watchEnd(let records), .watchError(let records, _):
            for (i, record) in records.enumerated() {
                await push(CompanionFrame(type: .chunk, streamId: streamId, seq: UInt32(i), payload: Data(record.utf8)), socket)
            }
            if case .watchEnd = behavior {
                await push(CompanionFrame(type: .end, streamId: streamId, seq: UInt32(records.count)), socket)
            }
            if case .watchError(_, let code) = behavior {
                await push(CompanionFrame(type: .error, streamId: streamId, seq: 0, payload: Data(#"{"code":"\#(code)","message":"stopped"}"#.utf8)), socket)
            }
        }
    }

    func push(_ frame: CompanionFrame, _ socket: PipeSocket) async {
        guard let ct = try? frame.encode() else { return }
        await pushRaw(ct, socket)
    }

    /// A session-level ERROR (stream 0) to the phone.
    func pushStreamZeroError(_ code: String, _ socket: PipeSocket) async {
        await push(CompanionFrame(type: .error, streamId: 0, seq: 0, payload: Data(#"{"code":"\#(code)","message":"bye"}"#.utf8)), socket)
    }

    /// Encrypts any plaintext (a frame this build may not know) and sends it to the phone.
    func pushRaw(_ plaintext: Data, _ socket: PipeSocket) async {
        guard let session = sessions[ObjectIdentifier(socket)], let ct = try? session.encrypt(plaintext) else { return }
        await socket.toPhone.put(ct)
    }

    func record(paths: [CompanionPath] = testPaths) -> PairedWorkspaceRecord {
        PairedWorkspaceRecord(
            workspaceId: "ws-1", workspaceLabel: "Your Mac", machineId: "m-1", paths: paths,
            macStaticPubBase64Url: CompanionRelayAuth.base64UrlEncode(macStatic.publicKey),
            deviceId: "dev-1", recoveryGeneration: "0123456789abcdef0123456789abcdef", pairedAt: Date()
        )
    }

    /// A pairing code for this fake Mac.
    func pairingQR(paths: [[String: String]] = PairingFixtures.defaultPaths, token: String? = "pct-1") -> PairingQRPayload {
        let pairing = self.pairing ?? FakePairing()
        let json = PairingFixtures.json(paths: paths, token: token) { object in
            object["macStaticPub"] = CompanionRelayAuth.base64UrlEncode(self.macStatic.publicKey)
            object["pairPsk"] = CompanionRelayAuth.base64UrlEncode(pairing.pairPsk)
            if let expires = pairing.expiresAtMs { object["expiresAtMs"] = expires }
        }
        // A test that sets an expiry sets it two minutes after its own clock's start (the manual clock).
        let now = pairing.expiresAtMs.map { Date(timeIntervalSince1970: ($0 - 120_000) / 1000) } ?? Date()
        return try! PairingQRPayload.parse(json, now: now)
    }
}

let directLAN = CompanionPath(kind: .direct, url: "ws://192.168.1.20:4199/v1/direct")
let directTailnet = CompanionPath(kind: .direct, url: "ws://100.101.102.103:4199/v1/direct")
let hostedRelay = CompanionPath(kind: .hosted, url: "wss://relay.invalid/v1/connect")
let testPaths = [directLAN, directTailnet, hostedRelay]

/// Every socket the client opened, which Mac each health probe named, and how sockets per kind behave.
final class SocketBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _sockets: [PipeSocket] = []
    private var _requests: [URLRequest] = []
    private var _probed: [String] = []
    private var _healthy: [String: String] = [:]
    private var _modes: [CompanionPath.Kind: SocketMode] = [:]
    private var _queued: [CompanionPath.Kind: [SocketMode]] = [:]

    var socket: PipeSocket? { lock.withLock { _sockets.last } }
    var sockets: [PipeSocket] { lock.withLock { _sockets } }
    var requests: [URLRequest] { lock.withLock { _requests } }
    var probed: [String] { lock.withLock { _probed } }

    /// `host` answers `/v1/health` naming `machineId`.
    func answer(_ host: String, machineId: String) { lock.withLock { _healthy[host] = machineId } }
    func setMode(_ kind: CompanionPath.Kind, _ mode: SocketMode) { lock.withLock { _modes[kind] = mode } }
    /// The next socket of `kind` behaves like `mode` (then the default applies again).
    func queueMode(_ kind: CompanionPath.Kind, _ mode: SocketMode) { lock.withLock { _queued[kind, default: []].append(mode) } }

    func probe(_ url: URL) -> String? {
        lock.withLock {
            _probed.append(url.absoluteString)
            return _healthy[url.host ?? ""]
        }
    }

    func open(_ request: URLRequest, mac: FakeMac) -> PipeSocket {
        lock.withLock {
            let kind: CompanionPath.Kind = request.url?.path == "/v1/direct" ? .direct : .hosted
            let mode: SocketMode
            if var queue = _queued[kind], !queue.isEmpty {
                mode = queue.removeFirst()
                _queued[kind] = queue
            } else {
                mode = _modes[kind] ?? .normal
            }
            let socket = PipeSocket(mac: mac, mode: mode, request: request)
            _requests.append(request)
            _sockets.append(socket)
            return socket
        }
    }
}

struct Harness {
    let mac: FakeMac
    let client: CompanionRelayClient
    let box: SocketBox

    init(
        timing: CompanionRelayClient.Timing = .init(),
        clock: ManualClock? = nil,
        now: CompanionNow? = nil,
        discover: CompanionDirectDiscovery? = nil
    ) throws {
        let mac = try FakeMac()
        let box = SocketBox()
        self.mac = mac
        self.box = box
        let sleep: CompanionSleep
        let nowFn: CompanionNow
        if let clock {
            sleep = { try await clock.sleep($0) }
            nowFn = now ?? { clock.date }
        } else {
            sleep = { try await Task.sleep(for: $0) }
            nowFn = now ?? { Date() }
        }
        client = CompanionRelayClient(
            timing: timing,
            healthProbe: { url, _ in box.probe(url) },
            discover: discover,
            sleep: sleep,
            now: nowFn,
            socketFactory: { box.open($0, mac: mac) }
        )
    }

    func connectResult(paths: [CompanionPath] = testPaths) async throws -> CompanionConnectResult {
        let record = await mac.record(paths: paths)
        return try await client.connect(
            record: record, devicePsk: mac.devicePsk,
            phoneNoisePriv: X25519KeyPair.generate().privateKey,
            deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation
        )
    }

    func connect() async throws -> DeviceHello {
        try await connectResult().hello
    }
}

struct TaskParams: Encodable, Sendable { let task: String }
struct Small: Decodable, Sendable, Equatable { let name: String }

final class Flag<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.withLock { stored } }
    func set(_ value: Value) { lock.withLock { stored = value } }
}

final class EndLog: @unchecked Sendable {
    private let lock = NSLock()
    private var ends: [CompanionSessionEnd] = []
    var all: [CompanionSessionEnd] { lock.withLock { ends } }
    func add(_ end: CompanionSessionEnd) { lock.withLock { ends.append(end) } }
}

/// The JSON claims of a `Bearer <token>` header.
func tokenClaims(_ request: URLRequest?) -> [String: Any]? {
    guard let header = request?.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer "),
          let part = header.dropFirst(7).split(separator: ".").first,
          let data = CompanionRelayAuth.base64UrlDecode(String(part))
    else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

/// Walks up from this file to the repo root and reads `test/fixtures/<name>`.
func repoFixture(_ name: String, file: String = #filePath) throws -> Data {
    var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent("test/fixtures/\(name)")
        if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
}

extension CompanionPathRules {
    /// One path from raw strings (an unknown kind is invalid). Tests only: the shared table names kinds as strings.
    static func validate(kind: String, url: String) throws {
        guard let kind = CompanionPath.Kind(rawValue: kind) else { throw PairingPayloadError.invalid("unknown path kind") }
        try validate(CompanionPath(kind: kind, url: url))
    }
}
