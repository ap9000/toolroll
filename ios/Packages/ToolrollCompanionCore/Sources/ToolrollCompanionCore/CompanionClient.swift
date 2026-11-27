import CryptoKit
import Foundation
import Security

/// Keychain storage for the three `ThisDeviceOnly` transport secrets (Noise static key, `devicePsk`, Ed25519
/// `deviceRelayPriv`), in the app's default access group (`<team>.dev.toolroll.ios`, app-only).
public enum CompanionKeychain {
    private static let service = "dev.toolroll.ios.companion"

    /// What reading a set of items found (C1). Only "every item is errSecItemNotFound" means the keys are gone; any
    /// other failure is transient and must never wipe a pairing.
    public enum ReadOutcome: Equatable, Sendable {
        case present([Data])
        /// Every item is missing (a restored backup, a wiped keychain).
        case missing
        /// Some items exist and some don't: the pairing data is damaged.
        case partial
        /// The keychain couldn't be read (locked since boot, interaction not allowed, -34018, …). Retry later.
        case unavailable(OSStatus)
    }

    /// One item's read: its data, or the OSStatus that stopped it.
    public typealias ItemRead = Result<Data, KeychainStatus>

    public struct KeychainStatus: Error, Equatable, Sendable {
        public let status: OSStatus
        public init(_ status: OSStatus) { self.status = status }
    }

    /// Classifies per-item reads (pure, so the rule is tested without a keychain).
    public static func classify(_ reads: [ItemRead]) -> ReadOutcome {
        var found: [Data] = []
        var notFound = 0
        for read in reads {
            switch read {
            case .success(let data): found.append(data)
            case .failure(let error) where error.status == errSecItemNotFound: notFound += 1
            case .failure(let error): return .unavailable(error.status)
            }
        }
        if notFound == reads.count { return .missing }
        if notFound > 0 { return .partial }
        return .present(found)
    }

    /// Writes in place (`SecItemUpdate`), adding the item only if it doesn't exist yet, so a failed write never
    /// leaves the old value deleted.
    public static func save(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    /// One item: its data, or the status that stopped the read (`errSecItemNotFound` when it doesn't exist).
    public static func read(account: String) -> ItemRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess else { return .failure(KeychainStatus(status)) }
        guard let data = out as? Data else { return .failure(KeychainStatus(errSecDecode)) }
        return .success(data)
    }

    /// Reads every account and classifies the result.
    public static func load(accounts: [String]) -> ReadOutcome {
        classify(accounts.map(read(account:)))
    }

    public static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
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

    /// The relay's audience: the hosted URL's lowercase host, with `:port` when the URL names one (what the relay
    /// sees as its public host).
    public static func audience(forHostedURL url: String) -> String? {
        guard let c = URLComponents(string: url), let host = c.host?.lowercased(), !host.isEmpty else { return nil }
        if let port = c.port { return "\(host):\(port)" }
        return host
    }

    /// A one-time WebSocket token for this device: exactly `v, role, machineId, deviceId, aud, jti, iat, exp`
    /// (contract §3.3). `now` is this iPhone's clock already corrected by any offset learned from the relay.
    public static func signDeviceToken(
        privateKey: Curve25519.Signing.PrivateKey,
        machineId: String,
        deviceId: String,
        audience: String,
        now: Date = Date(),
        ttlSec: Int = 300
    ) throws -> String {
        let nowSec = Int(now.timeIntervalSince1970)
        var jti = Data(count: 16)
        for i in jti.indices { jti[i] = UInt8.random(in: 0...255) }
        let payload: [String: Any] = [
            "v": 1,
            "role": "device",
            "machineId": machineId,
            "deviceId": deviceId,
            "aud": audience,
            "jti": base64UrlEncode(jti),
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
