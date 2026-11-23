import Foundation
import LocalAuthentication
import Security

public enum TouchIDVaultError: LocalizedError, Sendable {
    case notAvailable
    case cancelled
    case notStored
    case keychainFailure(OSStatus)
    case authenticationFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notAvailable:
            return "Touch ID or Mac authentication is not available on this device."
        case .cancelled:
            return "Authentication was cancelled."
        case .notStored:
            return "No password is saved for Touch ID yet. Enable Touch ID in Project Settings."
        case .keychainFailure(let status):
            return "Keychain error (\(status))."
        case .authenticationFailed(let message):
            return message
        }
    }
}

/// Optional macOS Keychain + LocalAuthentication (`Touch ID`) vault for the user's Toolroll operator password.
/// Never bypasses Toolroll's server-side password check: every approval prompts macOS biometric/device-owner
/// authentication, retrieves the stored password for that single request, and submits it to Toolroll's real
/// password-checked endpoint.
public enum TouchIDVault {
    private static let service = "com.toolroll.operator-password"

    private static func normalizedAccount(_ account: String) -> String {
        let trimmed = account.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "local-owner" : trimmed
    }

    public static func isAuthenticationAvailable() -> Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    public static func biometryLabel() -> String {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        switch context.biometryType {
        case .touchID:
            return "Touch ID"
        case .faceID:
            return "Face ID"
        case .opticID:
            return "Optic ID"
        default:
            return "Mac Auth"
        }
    }

    public static func biometrySystemImage() -> String {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        switch context.biometryType {
        case .touchID:
            return "touchid"
        case .faceID:
            return "faceid"
        case .opticID:
            return "opticid"
        default:
            return "lock.shield"
        }
    }

    public static func hasStoredPassword(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: normalizedAccount(account),
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return status == errSecSuccess
    }

    public static func savePassword(_ password: String, account: String) throws {
        let acct = normalizedAccount(account)
        guard let data = password.data(using: .utf8), !data.isEmpty else {
            throw TouchIDVaultError.authenticationFailed("Password is empty.")
        }

        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrLabel as String: "Toolroll Operator Password (Touch ID)",
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw TouchIDVaultError.keychainFailure(status)
        }
    }

    public static func deletePassword(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: normalizedAccount(account),
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Prompts macOS Touch ID (falling back to Apple Watch / macOS login password) and returns the stored
    /// Toolroll password for one single authenticated server call.
    public static func unlockPassword(account: String, reason: String) async throws -> String {
        guard hasStoredPassword(account: account) else {
            throw TouchIDVaultError.notStored
        }
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            throw TouchIDVaultError.notAvailable
        }

        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            guard ok else { throw TouchIDVaultError.cancelled }
        } catch let laError as LAError {
            if laError.code == .userCancel || laError.code == .systemCancel || laError.code == .appCancel {
                throw TouchIDVaultError.cancelled
            }
            throw TouchIDVaultError.authenticationFailed(laError.localizedDescription)
        } catch {
            throw TouchIDVaultError.authenticationFailed(error.localizedDescription)
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: normalizedAccount(account),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let password = String(data: data, encoding: .utf8),
              !password.isEmpty
        else {
            throw status == errSecItemNotFound ? TouchIDVaultError.notStored : TouchIDVaultError.keychainFailure(status)
        }
        return password
    }
}
