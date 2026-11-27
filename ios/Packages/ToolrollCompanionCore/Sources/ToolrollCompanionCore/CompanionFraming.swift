import Foundation

/// Bounded RPC-over-Noise binary framing matching `src/companion/framing.ts`
/// and `docs/plans/companion-app/noise-relay-protocol.md` §3.
public enum CompanionFrameType: UInt8, Sendable {
    case req = 0x01
    case res = 0x02
    case chunk = 0x03
    case credit = 0x04
    case cancel = 0x05
    case ping = 0x06
    case pong = 0x07
    case end = 0x08
    case error = 0x09
    case reqChunk = 0x0a
}

public enum CompanionFramingConstants {
    public static let headerBytes = 13
    public static let maxFramePayloadBytes = 60_000
    public static let maxLogicalRequestBytes = 256 * 1024
    public static let maxRequestChunks = 5
    public static let maxLogicalUnaryResponseBytes = 1024 * 1024
    public static let initialStreamCredit: UInt32 = 16
}

public enum CompanionFramingError: Error, Equatable, Sendable {
    case truncated(Int)
    case unknownFrameType(UInt8)
    case payloadTooLarge(Int)
    case lengthMismatch(declared: Int, actual: Int)
    case invalidCredit(UInt32)
}

public struct CompanionFrame: Equatable, Sendable {
    public let type: CompanionFrameType
    public let streamId: UInt32
    public let seq: UInt32
    public let payload: Data

    public init(type: CompanionFrameType, streamId: UInt32, seq: UInt32, payload: Data = Data()) {
        self.type = type
        self.streamId = streamId
        self.seq = seq
        self.payload = payload
    }

    public func encode() throws -> Data {
        guard payload.count <= CompanionFramingConstants.maxFramePayloadBytes else {
            throw CompanionFramingError.payloadTooLarge(payload.count)
        }
        let total = CompanionFramingConstants.headerBytes + payload.count
        guard total <= CompanionNoiseConstants.maxPlaintextBytes else {
            throw CompanionFramingError.payloadTooLarge(total)
        }
        var out = Data(capacity: total)
        out.append(type.rawValue)
        var sid = streamId.bigEndian
        var s = seq.bigEndian
        var len = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &sid) { out.append(contentsOf: $0) }
        withUnsafeBytes(of: &s) { out.append(contentsOf: $0) }
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    public static func decode(_ raw: Data) throws -> CompanionFrame {
        guard raw.count >= CompanionFramingConstants.headerBytes else {
            throw CompanionFramingError.truncated(raw.count)
        }
        guard raw.count <= CompanionNoiseConstants.maxPlaintextBytes else {
            throw CompanionFramingError.payloadTooLarge(raw.count)
        }
        guard let type = CompanionFrameType(rawValue: raw[0]) else {
            throw CompanionFramingError.unknownFrameType(raw[0])
        }
        let streamId = readUInt32BE(raw, offset: 1)
        let seq = readUInt32BE(raw, offset: 5)
        let payloadLen = Int(readUInt32BE(raw, offset: 9))
        guard payloadLen <= CompanionFramingConstants.maxFramePayloadBytes else {
            throw CompanionFramingError.payloadTooLarge(payloadLen)
        }
        let actual = raw.count - CompanionFramingConstants.headerBytes
        guard actual == payloadLen else {
            throw CompanionFramingError.lengthMismatch(declared: payloadLen, actual: actual)
        }
        return CompanionFrame(
            type: type,
            streamId: streamId,
            seq: seq,
            payload: Data(raw.dropFirst(CompanionFramingConstants.headerBytes))
        )
    }

    public static func splitRequest(streamId: UInt32, payload: Data) throws -> [CompanionFrame] {
        guard payload.count <= CompanionFramingConstants.maxLogicalRequestBytes else {
            throw CompanionFramingError.payloadTooLarge(payload.count)
        }
        if payload.count <= CompanionFramingConstants.maxFramePayloadBytes {
            return [CompanionFrame(type: .req, streamId: streamId, seq: 0, payload: payload)]
        }
        var frames: [CompanionFrame] = []
        var offset = 0
        var seq: UInt32 = 0
        while offset < payload.count {
            let end = min(offset + CompanionFramingConstants.maxFramePayloadBytes, payload.count)
            frames.append(CompanionFrame(type: .reqChunk, streamId: streamId, seq: seq, payload: Data(payload[offset..<end])))
            offset = end
            seq += 1
        }
        guard frames.count <= CompanionFramingConstants.maxRequestChunks else {
            throw CompanionFramingError.payloadTooLarge(payload.count)
        }
        frames.append(CompanionFrame(type: .end, streamId: streamId, seq: seq, payload: Data()))
        return frames
    }

    public static func creditFrame(streamId: UInt32, grant: UInt32) throws -> CompanionFrame {
        guard grant >= 1 && grant <= 1024 else {
            throw CompanionFramingError.invalidCredit(grant)
        }
        var be = grant.bigEndian
        let payload = withUnsafeBytes(of: &be) { Data($0) }
        return CompanionFrame(type: .credit, streamId: streamId, seq: 0, payload: payload)
    }
}

private func readUInt32BE(_ data: Data, offset: Int) -> UInt32 {
    let b0 = UInt32(data[offset]) << 24
    let b1 = UInt32(data[offset + 1]) << 16
    let b2 = UInt32(data[offset + 2]) << 8
    let b3 = UInt32(data[offset + 3])
    return b0 | b1 | b2 | b3
}
