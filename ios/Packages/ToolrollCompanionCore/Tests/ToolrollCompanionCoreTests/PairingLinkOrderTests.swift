import Foundation
import Testing
@testable import ToolrollCompanionCore

/// Records what the pairing link writes, in write order.
private final class RecordingSocket: CompanionSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [Data] = []
    var count: Int { lock.withLock { sent.count } }
    var all: [Data] { lock.withLock { sent } }
    func send(_ data: Data) async throws { lock.withLock { sent.append(data) } }
    func receive() async throws -> Data { try await Task.sleep(for: .seconds(3600)); throw CompanionConnectionError.closed }
    func close() {}
}

@Test("Pairing link: frames sent from many tasks at once reach the socket in nonce order")
func pairingLinkKeepsNonceOrder() async throws {
    let phone = X25519KeyPair.generate(), mac = X25519KeyPair.generate()
    let psk = Data(repeating: 0x21, count: 32), prologue = Data("order-test".utf8)
    let initiator = try NoiseIKpsk2Initiator(localStatic: phone, remoteStaticPublicKey: mac.publicKey, psk: psk, prologue: prologue)
    let responder = try NoiseIKpsk2Responder(localStatic: mac, psk: psk, prologue: prologue)
    _ = try responder.readMessage1(try initiator.writeMessage1(payload: Data("m1".utf8)))
    let (m2, macSession) = try responder.writeMessage2(payload: Data("m2".utf8))
    let (_, phoneSession) = try initiator.readMessage2(m2)

    let socket = RecordingSocket()
    let link = PairingLink(socket: socket, session: phoneSession)
    let total = 400
    await withTaskGroup(of: Void.self) { group in
        for i in 0..<total {
            group.addTask { try? link.send(CompanionFrame(type: .ping, streamId: 0, seq: UInt32(i), payload: Data(count: 8))) }
        }
    }
    // The writer drains on its own task; yield until it has written everything (bounded, no sleeps).
    for _ in 0..<100_000 where socket.count < total { await Task.yield() }
    #expect(socket.count == total)
    // The Mac decrypts strictly in order: any reordering fails authentication here.
    for ciphertext in socket.all { _ = try macSession.decrypt(ciphertext) }
}
