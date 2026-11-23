import AppKit
import Foundation
import SwiftUI

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

    static let defaultsKey = "toolroll.passwordRememberMinutes"
    static let defaultWindow: Window = .fifteenMinutes

    private var value: String?
    private var until: Date?
    /// Whose password this is and for which Toolroll (account + origin): never recalled for any other.
    private var owner: String?
    private var observers: [NSObjectProtocol] = []

    public init() {
        let forget: @Sendable (Notification) -> Void = { [weak self] _ in Task { @MainActor in self?.forget() } }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main, using: forget))
        observers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main, using: forget))
    }

    public var window: Window {
        get {
            let stored = UserDefaults.standard.object(forKey: Self.defaultsKey) as? Int
            return stored.flatMap(Window.init(rawValue:)) ?? Self.defaultWindow
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: Self.defaultsKey)
            if newValue == .everyTime { forget() }
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
        until = chosen == .untilQuit ? nil : now.addingTimeInterval(TimeInterval(chosen.rawValue * 60))
    }

    public func forget() {
        value = nil
        until = nil
        owner = nil
    }
}

/// Settings row: how long a typed or Touch ID password is remembered.
struct RememberPasswordPicker: View {
    let memory: PasswordMemory
    @State private var window: PasswordMemory.Window = PasswordMemory.defaultWindow

    var body: some View {
        Picker("Remember password for", selection: $window) {
            ForEach(PasswordMemory.Window.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.menu)
        .font(.system(size: 12))
        .fixedSize()
        .onAppear { window = memory.window }
        .onChange(of: window) { _, chosen in memory.window = chosen }
    }
}
