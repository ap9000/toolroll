import CryptoKit
import Foundation
import Testing
@testable import ToolrollCompanionCore

// An in-memory phone socket wired to a fake Mac that speaks Noise IKpsk2 and the 13-byte framing.

private actor Mailbox {
    private var items: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var closed = false

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

/// How a fake socket behaves on its way to the Mac.
private enum SocketMode: Sendable {
    case normal
    /// The upgrade is refused (the relay's 403 for an unknown or revoked device).
    case refused
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
}

private final class PipeSocket: CompanionSocket, @unchecked Sendable {
    let toPhone = Mailbox()
    let mac: FakeMac
    let mode: SocketMode
    private let lock = NSLock()
    private var sent = 0

    init(mac: FakeMac, mode: SocketMode = .normal) {
        self.mac = mac
        self.mode = mode
    }

    func send(_ data: Data) async throws {
        let index = lock.withLock { () -> Int in
            defer { sent += 1 }
            return sent
        }
        switch mode {
        case .normal:
            break
        case .refused:
            throw CompanionConnectionError.handshakeFailed("refused")
        case .dropBeforeReply:
            close()
            throw CompanionConnectionError.unreachable("network connection was lost")
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
        }
        try await mac.receive(data, socket: self)
    }

    func receive() async throws -> Data {
        try await toPhone.take()
    }

    func close() {
        Task { await toPhone.close() }
    }
}

private enum Behavior: Sendable {
    case result(String)
    case chunked(String, chunkBytes: Int)
    case error(code: String, message: String)
    case silent
    case delayed(String, Duration)
    case watch([String])
}

private actor FakeMac {
    let macStatic = X25519KeyPair.generate()
    let devicePsk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let prologue: Data
    var helloDeviceId = "dev-1"
    /// Raw JSON for the hello's `paths`, or nil for none.
    var helloPaths: String?
    /// The Mac refuses this device at hello.
    var helloError: (code: String, message: String)?
    var answerPings = true
    var behaviors: [String: Behavior] = [:]

    /// One Noise session per socket, so a fallback socket gets its own handshake.
    private var sessions: [ObjectIdentifier: NoiseTransportSession] = [:]
    private(set) var credits: [UInt32: Int] = [:]
    private(set) var cancels: [UInt32] = []
    private(set) var pings = 0
    private(set) var methods: [String] = []

    init() throws {
        prologue = try CompanionDerivations.sessionPrologue(workspaceId: "ws-1", deviceId: "dev-1", recoveryGeneration: "0123456789abcdef0123456789abcdef")
    }

    func set(_ method: String, _ behavior: Behavior) { behaviors[method] = behavior }
    func setAnswerPings(_ value: Bool) { answerPings = value }
    func setHelloDeviceId(_ id: String) { helloDeviceId = id }
    func setHelloPaths(_ json: String?) { helloPaths = json }
    func setHelloError(code: String, message: String) { helloError = (code, message) }

    func receive(_ data: Data, socket: PipeSocket) async throws {
        let key = ObjectIdentifier(socket)
        guard let session = sessions[key] else {
            let responder = try NoiseIKpsk2Responder(localStatic: macStatic, psk: devicePsk, prologue: prologue)
            _ = try responder.readMessage1(data)
            let (msg2, transport) = try responder.writeMessage2(payload: Data())
            sessions[key] = transport
            await socket.toPhone.put(msg2)
            return
        }
        let frame = try CompanionFrame.decode(try session.decrypt(data))
        switch frame.type {
        case .ping:
            pings += 1
            if answerPings { await push(CompanionFrame(type: .pong, streamId: 0, seq: frame.seq, payload: frame.payload), socket) }
        case .credit:
            credits[frame.streamId, default: 0] += 1
        case .cancel:
            cancels.append(frame.streamId)
        case .req:
            let req = try JSONSerialization.jsonObject(with: frame.payload) as! [String: Any]
            let method = req["method"] as! String
            methods.append(method)
            if method == "device.hello" {
                if let helloError {
                    await respond(.error(code: helloError.code, message: helloError.message), streamId: frame.streamId, socket: socket)
                    return
                }
                let paths = helloPaths.map { #","paths":\#($0)"# } ?? ""
                let hello = #"{"ok":true,"result":{"version":1,"workspaceId":"ws-1","workspaceLabel":"Studio Mac","account":"alex","deviceId":"\#(helloDeviceId)","toolroll":"0.9.130"\#(paths)}}"#
                await push(CompanionFrame(type: .res, streamId: frame.streamId, seq: 0, payload: Data(hello.utf8)), socket)
                return
            }
            await respond(behaviors[method] ?? .error(code: "route_not_allowed", message: "no"), streamId: frame.streamId, socket: socket)
        default:
            break
        }
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
        case .error(let code, let message):
            await push(CompanionFrame(type: .error, streamId: streamId, seq: 0, payload: Data(#"{"code":"\#(code)","message":"\#(message)"}"#.utf8)), socket)
        case .silent:
            break
        case .delayed(let json, let delay):
            Task {
                try? await Task.sleep(for: delay)
                await self.respond(.result(json), streamId: streamId, socket: socket)
            }
        case .watch(let records):
            for (i, record) in records.enumerated() {
                await push(CompanionFrame(type: .chunk, streamId: streamId, seq: UInt32(i), payload: Data(record.utf8)), socket)
            }
        }
    }

    func push(_ frame: CompanionFrame, _ socket: PipeSocket) async {
        guard let session = sessions[ObjectIdentifier(socket)], let ct = try? session.encrypt(try frame.encode()) else { return }
        await socket.toPhone.put(ct)
    }

    func record(paths: [CompanionPath] = testPaths) -> PairedWorkspaceRecord {
        PairedWorkspaceRecord(
            workspaceId: "ws-1", workspaceLabel: "Your Mac", machineId: "m-1", paths: paths,
            macStaticPubBase64Url: CompanionRelayAuth.base64UrlEncode(macStatic.publicKey),
            deviceId: "dev-1", recoveryGeneration: "0123456789abcdef0123456789abcdef", pairedAt: Date()
        )
    }
}

private let directLAN = CompanionPath(kind: .direct, url: "ws://192.168.1.20:4199/v1/direct")
private let directTailnet = CompanionPath(kind: .direct, url: "ws://100.101.102.103:4199/v1/direct")
private let hostedRelay = CompanionPath(kind: .hosted, url: "wss://relay.invalid/v1/connect")
private let testPaths = [directLAN, directTailnet, hostedRelay]

/// Every socket the client opened, which Mac each health probe named, and how sockets per kind behave.
private final class SocketBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _socket: PipeSocket?
    private var _requests: [URLRequest] = []
    private var _probed: [String] = []
    private var _healthy: [String: String] = [:]
    private var _modes: [CompanionPath.Kind: SocketMode] = [:]

    var socket: PipeSocket? { lock.withLock { _socket } }
    var requests: [URLRequest] { lock.withLock { _requests } }
    var probed: [String] { lock.withLock { _probed } }

    /// `host` answers `/v1/health` naming `machineId`.
    func answer(_ host: String, machineId: String) { lock.withLock { _healthy[host] = machineId } }
    func setMode(_ kind: CompanionPath.Kind, _ mode: SocketMode) { lock.withLock { _modes[kind] = mode } }

    func probe(_ url: URL) -> String? {
        lock.withLock {
            _probed.append(url.absoluteString)
            return _healthy[url.host ?? ""]
        }
    }

    func open(_ request: URLRequest, mac: FakeMac) -> PipeSocket {
        lock.withLock {
            let kind: CompanionPath.Kind = request.url?.path == "/v1/direct" ? .direct : .hosted
            let socket = PipeSocket(mac: mac, mode: _modes[kind] ?? .normal)
            _requests.append(request)
            _socket = socket
            return socket
        }
    }
}

private struct Harness {
    let mac: FakeMac
    let client: CompanionRelayClient
    let box: SocketBox

    init(timing: CompanionRelayClient.Timing = .init()) throws {
        let mac = try FakeMac()
        let box = SocketBox()
        self.mac = mac
        self.box = box
        client = CompanionRelayClient(
            timing: timing,
            healthProbe: { url, _ in box.probe(url) },
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

private struct TaskParams: Encodable, Sendable { let task: String }
private struct Small: Decodable, Sendable, Equatable { let name: String }

@Test("Connect runs the handshake and device.hello, then validates the hello's identity")
func connectAndHello() async throws {
    let h = try Harness()
    let hello = try await h.connect()
    #expect(hello.workspaceLabel == "Studio Mac")
    #expect(await h.mac.methods == ["device.hello"])
    #expect(await h.client.isConnected)
}

@Test("A hello naming another device is a handshake failure")
func helloIdentityMismatch() async throws {
    let h = try Harness()
    await h.mac.setHelloDeviceId("someone-else")
    await #expect(throws: CompanionConnectionError.handshakeFailed("identity mismatch")) {
        _ = try await h.connect()
    }
    #expect(await h.client.isConnected == false)
}

@Test("Concurrent calls each get their own reply, whatever order the Mac answers in")
func concurrentCallsDispatchByStream() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("slow", .delayed(#"{"name":"slow"}"#, .milliseconds(80)))
    await h.mac.set("fast", .result(#"{"name":"fast"}"#))
    async let slow = h.client.call("slow", params: TaskParams(task: "a"), as: Small.self)
    async let fast = h.client.call("fast", params: TaskParams(task: "b"), as: Small.self)
    let (s, f) = try await (slow, fast)
    #expect(s.name == "slow")
    #expect(f.name == "fast")
}

@Test("Chunked replies are reassembled in order with one CREDIT per chunk")
func chunkReassembly() async throws {
    let h = try Harness()
    _ = try await h.connect()
    let big = String(repeating: "x", count: 150_000)
    await h.mac.set("big", .chunked(#"{"name":"\#(big)"}"#, chunkBytes: 50_000))
    let result = try await h.client.call("big", params: TaskParams(task: "t"), as: Small.self)
    #expect(result.name.count == 150_000)
    try await Task.sleep(for: .milliseconds(50))
    let credits = await h.mac.credits
    #expect(credits[3] == 4) // stream 1 was hello; 150 KB + envelope = 4 chunks
}

@Test("An ERROR frame becomes a typed CompanionRPCError")
func errorFrame() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("task.steps", .error(code: "not_found", message: "No such task"))
    await #expect(throws: CompanionRPCError(code: "not_found", message: "No such task")) {
        _ = try await h.client.call("task.steps", params: TaskParams(task: "t-x"), as: Small.self)
    }
}

@Test("Disconnect fails every pending call exactly once")
func disconnectFailsPending() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    let client = h.client
    let pending = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await Task.sleep(for: .milliseconds(30))
    await client.disconnect()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await pending.value }
    #expect(await client.isConnected == false)
}

@Test("The Mac closing the socket fails pending calls and reports the loss")
func socketClosedReportsLoss() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    let lost = LossFlag()
    await h.client.setConnectionLostHandler { _ in lost.set() }
    let client = h.client
    let pending = Task { try await client.call("never", params: TaskParams(task: "t"), as: Small.self) }
    try await Task.sleep(for: .milliseconds(30))
    h.box.socket?.close()
    await #expect(throws: CompanionConnectionError.closed) { _ = try await pending.value }
    try await Task.sleep(for: .milliseconds(30))
    #expect(lost.value)
}

@Test("A call with no answer times out and is cancelled on the Mac")
func callDeadline() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .milliseconds(100), ping: .seconds(60)))
    _ = try await h.connect()
    await h.mac.set("never", .silent)
    await #expect(throws: CompanionRPCError(code: "deadline_exceeded", message: "No answer within 30 seconds")) {
        _ = try await h.client.call("never", params: TaskParams(task: "t"), as: Small.self)
    }
    try await Task.sleep(for: .milliseconds(30))
    #expect(await h.mac.cancels == [3])
}

@Test("A watch yields each CHUNK, credits it, and sends CANCEL when the consumer stops")
func watchCancelsOnTermination() async throws {
    let h = try Harness()
    _ = try await h.connect()
    await h.mac.set("run.watch.subscribe", .watch([
        #"{"k":"say","at":"t","t":["one"]}"#,
        #"{"k":"say","at":"t","t":["two"]}"#,
        #"{"k":"say","at":"t","t":["three"]}"#,
    ]))
    // The watch sheet's task owns the stream; dismissing the sheet cancels that task.
    let source = LiveCompanionSource(client: h.client)
    let consumer = Task {
        var seen: [String] = []
        let stream = try await source.watchRun(run: 41, cursor: nil)
        for try await record in stream {
            seen.append(record.text?.first ?? "")
            if seen.count == 2 { return seen }
        }
        return seen
    }
    let seen = try await consumer.value
    #expect(seen == ["one", "two"])
    try await Task.sleep(for: .milliseconds(80))
    #expect(await h.mac.cancels == [3])
    #expect((await h.mac.credits[3] ?? 0) >= 2)
    #expect(await h.client.isConnected)
}

@Test("Two missed PONGs drop the connection")
func missedPongsDisconnect() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .seconds(5), ping: .milliseconds(40)))
    _ = try await h.connect()
    await h.mac.setAnswerPings(false)
    let lost = LossFlag()
    await h.client.setConnectionLostHandler { _ in lost.set() }
    try await Task.sleep(for: .milliseconds(300))
    #expect(lost.value)
    #expect(await h.client.isConnected == false)
    #expect(await h.mac.pings >= 2)
}

@Test("Answered pings keep the connection up")
func answeredPingsKeepAlive() async throws {
    let h = try Harness(timing: .init(connect: .seconds(2), call: .seconds(5), ping: .milliseconds(30)))
    _ = try await h.connect()
    try await Task.sleep(for: .milliseconds(250))
    #expect(await h.client.isConnected)
    #expect(await h.mac.pings >= 3)
}

private final class LossFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.withLock { flag } }
    func set() { lock.withLock { flag = true } }
}

// MARK: - Dialing: direct first, hosted as the fallback

@Test("All probes fail: the hosted relay is used with its Bearer token")
func dialFallsToHostedWhenNoProbeAnswers() async throws {
    let h = try Harness()
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(Set(h.box.probed) == ["http://192.168.1.20:4199/v1/health", "http://100.101.102.103:4199/v1/health"])
    let requests = h.box.requests
    #expect(requests.count == 1)
    #expect(requests.first?.url?.absoluteString == "wss://relay.invalid/v1/connect")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
}

@Test("A healthy direct path is dialed once, with no Authorization header")
func dialPicksHealthyDirect() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    let result = try await h.connectResult()
    #expect(result.path == directLAN)
    #expect(await h.client.isConnected)
    let requests = h.box.requests
    #expect(requests.count == 1)
    #expect(requests.first?.url?.absoluteString == "ws://192.168.1.20:4199/v1/direct?role=device&id=dev-1")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.first?.allHTTPHeaderFields?.isEmpty ?? true)
}

@Test("An address answering for a different machine is skipped")
func dialSkipsWrongMachine() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-someone-else")
    h.box.answer("100.101.102.103", machineId: "m-1")
    let result = try await h.connectResult()
    #expect(result.path == directTailnet)
    #expect(h.box.requests.map { $0.url?.host } == ["100.101.102.103"])
}

@Test("A wrong machine on the only direct path falls through to hosted")
func dialWrongMachineOnlyDirect() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-someone-else")
    let result = try await h.connectResult(paths: [directLAN, hostedRelay])
    #expect(result.path == hostedRelay)
    #expect(h.box.requests.count == 1)
}

@Test("A direct socket failure mid-handshake falls back to hosted exactly once", arguments: [SocketModeArg.dropBeforeReply, .dropOnHello])
fileprivate func dialFallsBackOnce(_ mode: SocketModeArg) async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(await h.client.isConnected)
    let requests = h.box.requests
    #expect(requests.count == 2)
    #expect(requests.first?.url?.path == "/v1/direct")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.last?.url?.absoluteString == "wss://relay.invalid/v1/connect")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
}

@Test("If hosted also fails after the fallback, there is no third attempt")
func dialFallbackOnlyOnce() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, .dropBeforeReply)
    h.box.setMode(.hosted, .dropBeforeReply)
    await #expect(throws: CompanionConnectionError.self) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 2)
}

@Test("An encrypted hello refusal on the direct path stands: no fallback to hosted")
func dialHelloRefusalDoesNotFallBack() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    await h.mac.setHelloError(code: "device_revoked", message: "This iPhone was removed")
    await #expect(throws: CompanionConnectionError.handshakeFailed("device_revoked")) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 1)
    #expect(h.box.requests.first?.url?.path == "/v1/direct")
    #expect(await h.client.isConnected == false)
}

@Test("The hosted relay refusing the device stands (no retry)")
func dialHostedRefusalStands() async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .refused)
    await #expect(throws: CompanionConnectionError.handshakeFailed("refused")) { _ = try await h.connectResult() }
    #expect(h.box.requests.count == 1)
}

@Test("Anything unauthenticated going wrong on direct falls back to hosted and succeeds", arguments: [
    SocketModeArg.garbageReply, .closeBeforeReply, .refused, .stallBeforeReply, .stallHello,
])
fileprivate func dialUnauthenticatedDirectFailureFallsBack(_ mode: SocketModeArg) async throws {
    let h = try Harness(timing: .init(directHandshake: .milliseconds(150)))
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    let started = ContinuousClock.now
    let result = try await h.connectResult()
    #expect(result.path == hostedRelay)
    #expect(await h.client.isConnected)
    #expect(ContinuousClock.now - started < .seconds(3))
    let requests = h.box.requests
    #expect(requests.count == 2)
    #expect(requests.first?.url?.path == "/v1/direct")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
    // The stalled direct session must not come back to life and tear down the hosted one.
    try await Task.sleep(for: .milliseconds(250))
    #expect(await h.client.isConnected)
}

@Test("Without a hosted path, a broken direct handshake is unreachable, not \"not recognized\"")
func dialGarbageDirectNoHosted() async throws {
    let h = try Harness()
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, .garbageReply)
    do {
        _ = try await h.connectResult(paths: [directLAN])
        Issue.record("expected a failure")
    } catch let error as CompanionConnectionError {
        guard case .unreachable = error else {
            Issue.record("expected unreachable, got \(error)")
            return
        }
    }
    #expect(h.box.requests.count == 1)
}

@Test("No direct path answers and there is no hosted path: the exact unreachable message, no socket")
func dialNothingReachable() async throws {
    let h = try Harness()
    await #expect(throws: CompanionConnectionError.unreachable(CompanionRelayClient.noReachablePathMessage)) {
        _ = try await h.connectResult(paths: [directLAN, directTailnet])
    }
    #expect(h.box.requests.isEmpty)
    #expect(CompanionRelayClient.noReachablePathMessage
        == "Can't reach your Mac. Connect to the same Wi-Fi as your Mac (or Tailscale), or turn on 'Connect from anywhere' in Toolroll → Settings → Phone.")
}

@Test("A hello's valid paths replace the stored ones")
func helloPathsReplaceStored() async throws {
    let h = try Harness()
    await h.mac.setHelloPaths(#"[{"kind":"direct","url":"ws://10.0.0.7:4199/v1/direct"},{"kind":"hosted","url":"wss://relay.invalid/v1/connect"}]"#)
    let result = try await h.connectResult()
    #expect(result.record.paths == [
        CompanionPath(kind: .direct, url: "ws://10.0.0.7:4199/v1/direct"),
        hostedRelay,
    ])
    #expect(result.record.deviceId == "dev-1")
}

@Test("A hello with invalid or no paths keeps the stored ones", arguments: [
    #"[{"kind":"direct","url":"ws://8.8.8.8:4199/v1/direct"}]"#,
    #"[{"kind":"carrier-pigeon","url":"ws://10.0.0.7:4199/v1/direct"}]"#,
    "[]",
    nil,
])
func helloInvalidPathsKeepStored(_ json: String?) async throws {
    let h = try Harness()
    await h.mac.setHelloPaths(json)
    let result = try await h.connectResult()
    #expect(result.record.paths == testPaths)
    #expect(await h.client.isConnected)
}

@Test("Pairing dials a healthy direct path with role=pair and no token; a broken direct handshake tries hosted once", arguments: [
    SocketModeArg.garbageReply, .closeBeforeReply, .dropBeforeReply, .stallBeforeReply,
])
fileprivate func pairingDirectFallsBackOnce(_ mode: SocketModeArg) async throws {
    let h = try Harness(timing: .init(directHandshake: .milliseconds(150)))
    h.box.answer("192.168.1.20", machineId: "m-1")
    h.box.setMode(.direct, mode.mode)
    h.box.setMode(.hosted, .dropBeforeReply)
    let qr = try PairingQRPayload.parse(PairingFixtures.json())
    await #expect(throws: CompanionConnectionError.self) {
        _ = try await h.client.beginPairing(qr: qr, deviceName: "Test iPhone") { _ in }
    }
    let requests = h.box.requests
    #expect(requests.count == 2) // direct, then hosted once; both failing means a fresh QR
    #expect(requests.first?.url?.absoluteString == "ws://192.168.1.20:4199/v1/direct?role=pair&id=ps-1")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests.last?.url?.absoluteString == "wss://relay.toolroll.invalid/v1/connect")
    #expect(requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer pct-1")
}

@Test("Pairing over direct with no hosted path makes a single attempt")
func pairingDirectOnlySingleAttempt() async throws {
    let h = try Harness()
    h.box.answer("10.1.2.3", machineId: "m-1")
    h.box.setMode(.direct, .garbageReply)
    let qr = try PairingQRPayload.parse(PairingFixtures.json(paths: [PairingFixtures.direct("ws://10.1.2.3:4199/v1/direct")], token: nil))
    await #expect(throws: CompanionConnectionError.self) {
        _ = try await h.client.beginPairing(qr: qr, deviceName: "Test iPhone") { _ in }
    }
    #expect(h.box.requests.count == 1)
}

@Test("Pairing with no healthy direct path uses hosted with the pair token")
func pairingFallsToHostedWithToken() async throws {
    let h = try Harness()
    h.box.setMode(.hosted, .dropBeforeReply)
    let qr = try PairingQRPayload.parse(PairingFixtures.json())
    await #expect(throws: CompanionConnectionError.self) {
        _ = try await h.client.beginPairing(qr: qr, deviceName: "Test iPhone") { _ in }
    }
    let requests = h.box.requests
    #expect(requests.count == 1)
    #expect(requests.first?.url?.absoluteString == "wss://relay.toolroll.invalid/v1/connect")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer pct-1")
}

@Test("A probe that doesn't answer within its timeout counts as unreachable")
func slowProbeTimesOut() async throws {
    let mac = try FakeMac()
    let box = SocketBox()
    let client = CompanionRelayClient(
        timing: .init(probe: .milliseconds(50)),
        healthProbe: { _, _ in
            try? await Task.sleep(for: .seconds(10))
            return "m-1"
        },
        socketFactory: { box.open($0, mac: mac) }
    )
    let started = ContinuousClock.now
    let result = try await client.connect(
        record: await mac.record(), devicePsk: mac.devicePsk,
        phoneNoisePriv: X25519KeyPair.generate().privateKey,
        deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation
    )
    #expect(result.path == hostedRelay)
    #expect(ContinuousClock.now - started < .seconds(5))
}

fileprivate enum SocketModeArg: String, CaseIterable, Sendable, CustomTestStringConvertible {
    case dropBeforeReply, dropOnHello, garbageReply, closeBeforeReply, refused, stallBeforeReply, stallHello
    var mode: SocketMode {
        switch self {
        case .dropBeforeReply: return .dropBeforeReply
        case .dropOnHello: return .dropOnHello
        case .garbageReply: return .garbageReply
        case .closeBeforeReply: return .closeBeforeReply
        case .refused: return .refused
        case .stallBeforeReply: return .stallBeforeReply
        case .stallHello: return .stallHello
        }
    }
    var testDescription: String { rawValue }
}
