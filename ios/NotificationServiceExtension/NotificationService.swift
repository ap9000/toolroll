import CryptoKit
import Foundation
import ToolrollCompanionCore
import UserNotifications

/// E2EE Notification Service Extension (`dev.toolroll.ios.notification-service`).
///
/// Decrypts RFC 8291 `aes128gcm` push payloads locally in <50ms using the P-256 private key
/// and 16-byte `authSecret` stored in the shared App Group Keychain (`group.dev.toolroll.ios`).
/// Zero outbound network calls. Falls back gracefully to the generic `aps.alert` on any failure.
/// The content handler is called exactly once: by `didReceive`, or by `serviceExtensionTimeWillExpire` if that comes
/// first (the system may call it from another thread).
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    /// Hands `content` to the pending handler, if no one has yet.
    private func deliver(_ content: UNNotificationContent?) {
        let handler: ((UNNotificationContent) -> Void)? = lock.withLock {
            defer { contentHandler = nil }
            return contentHandler
        }
        guard let handler, let content else { return }
        handler(content)
    }

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let mutable = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        lock.withLock {
            self.contentHandler = contentHandler
            self.bestAttemptContent = mutable
        }

        defer { deliver(mutable) }

        guard let tr = request.content.userInfo["tr"] as? [String: Any],
              let cipherB64 = tr["c"] as? String,
              let cipherData = CompanionRelayAuth.base64UrlDecode(cipherB64),
              let privRaw = CompanionKeychain.load(account: "push.p256.priv", sharedAppGroup: true),
              let authSecret = CompanionKeychain.load(account: "push.auth.secret", sharedAppGroup: true),
              let uaPrivate = try? P256.KeyAgreement.PrivateKey(rawRepresentation: privRaw),
              let plaintext = try? RFC8291PushCrypto.decrypt(
                ciphertextBody: cipherData,
                uaPrivateKey: uaPrivate,
                authSecret: authSecret
              ),
              let decoded = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
        else {
            // Neutral fallback (spec §5.5): never expose decryption errors or stale data.
            mutable.title = "Toolroll"
            mutable.body = "Open app to check your workspace."
            return
        }

        if let title = decoded["title"] as? String, !title.isEmpty {
            mutable.title = title
        } else {
            mutable.title = "Toolroll"
        }
        if let body = decoded["phrase"] as? String, !body.isEmpty {
            mutable.body = body
        } else if let summary = decoded["summary"] as? String, !summary.isEmpty {
            mutable.body = summary
        }
        if let taskId = decoded["taskId"] as? String {
            var info = mutable.userInfo
            info["decryptedTaskId"] = taskId
            mutable.userInfo = info
        }
    }

    override func serviceExtensionTimeWillExpire() {
        deliver(lock.withLock { bestAttemptContent })
    }
}
