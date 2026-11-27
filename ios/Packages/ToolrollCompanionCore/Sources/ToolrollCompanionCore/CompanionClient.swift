import CryptoKit
import Foundation
import Security

/// Keychain storage for `ThisDeviceOnly` secrets (Noise static key, `devicePsk`,
/// Ed25519 `deviceRelayPriv`, and App Group shared P-256 push decryption key + `authSecret`).
///
/// Transport secrets (`sharedAppGroup: false`) go to the app's default access group: the first entry of the app's
/// `keychain-access-groups`, which is app-only (`<team>.dev.toolroll.ios`). The notification extension has no
/// `keychain-access-groups` entitlement at all, so it can never read them; it reaches only the push items, which are
/// saved to the App Group (`group.dev.toolroll.ios`).
public enum CompanionKeychain {
    public static let appGroupAccessGroup = "group.dev.toolroll.ios"
    private static let service = "dev.toolroll.ios.companion"

    /// Writes in place (`SecItemUpdate`), adding the item only if it doesn't exist yet, so a failed write never
    /// leaves the old value deleted.
    public static func save(_ data: Data, account: String, sharedAppGroup: Bool = false) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if sharedAppGroup {
            query[kSecAttrAccessGroup as String] = appGroupAccessGroup
        }
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
