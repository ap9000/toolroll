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

private final class PipeSocket: CompanionSocket, @unchecked Sendable {
    let toPhone = Mailbox()
    let mac: FakeMac

    init(mac: FakeMac) {
        self.mac = mac
    }

    func send(_ data: Data) async throws {
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
    var answerPings = true
    var behaviors: [String: Behavior] = [:]

    private var responder: NoiseIKpsk2Responder?
    private var session: NoiseTransportSession?
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

    func receive(_ data: Data, socket: PipeSocket) async throws {
        if session == nil {
            let responder = try NoiseIKpsk2Responder(localStatic: macStatic, psk: devicePsk, prologue: prologue)
            _ = try responder.readMessage1(data)
            let (msg2, transport) = try responder.writeMessage2(payload: Data())
            session = transport
            await socket.toPhone.put(msg2)
            return
        }
        let frame = try CompanionFrame.decode(try session!.decrypt(data))
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
                let hello = #"{"ok":true,"result":{"version":1,"workspaceId":"ws-1","workspaceLabel":"Studio Mac","account":"alex","deviceId":"\#(helloDeviceId)","toolroll":"0.9.130"}}"#
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
        guard let session, let ct = try? session.encrypt(try frame.encode()) else { return }
        await socket.toPhone.put(ct)
    }

    func record() -> PairedWorkspaceRecord {
        PairedWorkspaceRecord(
            workspaceId: "ws-1", workspaceLabel: "Your Mac", machineId: "m-1", relayUrl: "ws://relay.invalid/v1/connect",
            macStaticPubBase64Url: CompanionRelayAuth.base64UrlEncode(macStatic.publicKey),
            deviceId: "dev-1", recoveryGeneration: "0123456789abcdef0123456789abcdef", pairedAt: Date()
        )
    }
}

private final class SocketBox: @unchecked Sendable {
    var socket: PipeSocket?
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
        client = CompanionRelayClient(timing: timing) { _ in
            let socket = PipeSocket(mac: mac)
            box.socket = socket
            return socket
        }
    }

    func connect() async throws -> DeviceHello {
        let record = await mac.record()
        return try await client.connect(
            record: record, devicePsk: await mac.devicePsk,
            phoneNoisePriv: X25519KeyPair.generate().privateKey,
            deviceRelayPriv: Curve25519.Signing.PrivateKey().rawRepresentation
        )
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
