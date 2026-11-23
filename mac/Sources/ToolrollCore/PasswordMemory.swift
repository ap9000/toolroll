import AppKit
import Foundation

/// How long the app keeps your Toolroll password after you type it or unlock it with Touch ID, so a run of approvals
/// asks once. In memory only: never written to disk, and forgotten when the Mac sleeps, the screen locks, or the app quits.
@MainActor
public final class PasswordMemory {
    public enum Window: Int, CaseIterable, Identifiable, Sendable {
        case everyTime = 0
        case fiveMinutes = 5
        case fifteenMinutes = 15
        case oneHour = 60
        case untilQuit = -1

        public var id: Int { rawValue }

        public var label: String {
            switch self {
            case .everyTime: return "Every time"
            case .fiveMinutes: return "5 minutes"
            case .fifteenMinutes: return "15 minutes"
            case .oneHour: return "1 hour"
            case .untilQuit: return "Until I quit"
            }
        }
    }

    public static let defaultsKey = "toolroll.passwordRememberMinutes"
    public static let defaultWindow: Window = .fifteenMinutes

    private var value: String?
    private var until: Date?
    /// When it was typed or unlocked: a changed window counts from here, so a shorter one applies at once.
    private var rememberedAt: Date?
    /// Whose password this is and for which Toolroll (account + origin): never recalled for any other.
    private var owner: String?
    private var observers: [NSObjectProtocol] = []
    /// Where the chosen window is kept (the app's own defaults; a test passes its own suite).
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let forget: @Sendable (Notification) -> Void = { [weak self] _ in Task { @MainActor in self?.forget() } }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main, using: forget))
        observers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main, using: forget))
    }

    public var window: Window {
        get {
            let stored = defaults.object(forKey: Self.defaultsKey) as? Int
            return stored.flatMap(Window.init(rawValue:)) ?? Self.defaultWindow
        }
        set {
            defaults.set(newValue.rawValue, forKey: Self.defaultsKey)
            if newValue == .everyTime {
                forget()
            } else if let rememberedAt, value != nil {
                until = newValue == .untilQuit ? nil : rememberedAt.addingTimeInterval(TimeInterval(newValue.rawValue * 60))
            }
        }
    }

    /// The remembered password for `owner` (account + origin) while its window lasts. A different owner gets nil and
    /// the memory is dropped, so a password typed for one Toolroll is never sent to another.
    public func recall(for owner: String, now: Date = Date()) -> String? {
        guard let value else { return nil }
        guard owner == self.owner else {
            forget()
            return nil
        }
        if let until, now >= until {
            forget()
            return nil
        }
        return value
    }

    public func remember(_ password: String, for owner: String, now: Date = Date()) {
        let chosen = window
        guard chosen != .everyTime, !password.isEmpty else { return }
        value = password
        self.owner = owner
        rememberedAt = now
        until = chosen == .untilQuit ? nil : now.addingTimeInterval(TimeInterval(chosen.rawValue * 60))
    }

    public func forget() {
        value = nil
        until = nil
        owner = nil
        rememberedAt = nil
    }
}
