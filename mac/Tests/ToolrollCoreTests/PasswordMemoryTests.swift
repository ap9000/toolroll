import AppKit
import Foundation
import Testing
@testable import ToolrollCore

@MainActor
@Suite("PasswordMemory")
struct PasswordMemoryTests {
    nonisolated static let alice = "alice|http://127.0.0.1:4000"
    nonisolated static let bob = "bob|http://127.0.0.1:4000"
    nonisolated static let aliceElsewhere = "alice|https://team.example"
    nonisolated static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func withMemory(_ window: PasswordMemory.Window?, _ body: (PasswordMemory) throws -> Void) rethrows {
        let suite = "toolroll.tests.password-memory.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = PasswordMemory(defaults: defaults)
        if let window { memory.window = window }
        try body(memory)
    }

    @Test("The default window is 15 minutes, read from the injected defaults")
    func defaultWindow() {
        withMemory(nil) { memory in
            #expect(memory.window == .fifteenMinutes)
        }
    }

    @Test("Each timed window keeps the password until its last moment and drops it at expiry",
          arguments: [PasswordMemory.Window.fiveMinutes, .fifteenMinutes, .oneHour])
    func timedWindowExpires(_ window: PasswordMemory.Window) {
        withMemory(window) { memory in
            let span = TimeInterval(window.rawValue * 60)
            memory.remember("pw", for: Self.alice, now: Self.t0)
            #expect(memory.recall(for: Self.alice, now: Self.t0) == "pw")
            #expect(memory.recall(for: Self.alice, now: Self.t0.addingTimeInterval(span - 1)) == "pw")
            #expect(memory.recall(for: Self.alice, now: Self.t0.addingTimeInterval(span)) == nil)
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("Until I quit never expires by time")
    func untilQuit() {
        withMemory(.untilQuit) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            #expect(memory.recall(for: Self.alice, now: Self.t0.addingTimeInterval(30 * 24 * 3600)) == "pw")
        }
    }

    @Test("Every time remembers nothing")
    func everyTimeRemembersNothing() {
        withMemory(.everyTime) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("Choosing Every time forgets what was already remembered")
    func switchingToEveryTimeForgets() {
        withMemory(.oneHour) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            memory.window = .everyTime
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
            memory.window = .oneHour
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("An empty password is never remembered")
    func emptyNotRemembered() {
        withMemory(.oneHour) { memory in
            memory.remember("", for: Self.alice, now: Self.t0)
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("A different account or origin gets nil, and the value is dropped for the owner too",
          arguments: [bob, aliceElsewhere])
    func ownerMismatchDrops(_ other: String) {
        withMemory(.oneHour) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            #expect(memory.recall(for: other, now: Self.t0) == nil)
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("forget() drops it")
    func forgetDrops() {
        withMemory(.untilQuit) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            memory.forget()
            #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
        }
    }

    @Test("The Mac going to sleep forgets it (in-process notification only)")
    func sleepForgets() async {
        let suite = "toolroll.tests.password-memory.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = PasswordMemory(defaults: defaults)
        memory.window = .untilQuit
        memory.remember("pw", for: Self.alice, now: Self.t0)
        NSWorkspaceSleepPoster.post()
        for _ in 0..<100 where memory.recall(for: Self.alice, now: Self.t0) != nil { await Task.yield() }
        #expect(memory.recall(for: Self.alice, now: Self.t0) == nil)
    }

    @Test("Shortening the window applies to a password already remembered")
    func shorteningApplies() {
        withMemory(.oneHour) { memory in
            memory.remember("pw", for: Self.alice, now: Self.t0)
            memory.window = .fiveMinutes
            #expect(memory.recall(for: Self.alice, now: Self.t0.addingTimeInterval(10 * 60)) == nil)
        }
    }
}

enum NSWorkspaceSleepPoster {
    static func post() {
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
    }
}
