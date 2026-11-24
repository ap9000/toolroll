import AppKit
import Foundation
import UserNotifications

@MainActor
public final class DesktopNotifier: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    public static let shared = DesktopNotifier()
    public var onSelectTask: ((String) -> Void)?

    private var isBundledApp: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }

    private override init() {
        super.init()
    }

    public func configure() {
        guard isBundledApp else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }

    public func updateDockBadge(needsCount: Int) {
        NSApp.dockTile.badgeLabel = needsCount > 0 ? "\(needsCount)" : nil
    }

    public func notify(taskId: String, title: String, subtitle: String, body: String) {
        guard isBundledApp else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = subtitle
        content.body = body
        content.sound = .default
        content.userInfo = ["taskId": taskId]

        let req = UNNotificationRequest(
            identifier: "toolroll-\(taskId)-\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound]
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        if let taskId = response.notification.request.content.userInfo["taskId"] as? String {
            NSApp.activate(ignoringOtherApps: true)
            onSelectTask?(taskId)
        }
    }
}
