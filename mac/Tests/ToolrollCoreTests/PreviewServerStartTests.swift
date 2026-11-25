import Foundation
import Testing
@testable import ToolrollCore

@MainActor
@Suite("Preview server start")
struct PreviewServerStartTests {
    /// A project whose dev script names a port nothing listens on, with node_modules present: the only thing left
    /// between it and a started process is the person's click.
    private func project(script: String) throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tr-preview-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: "\(root)/node_modules", withIntermediateDirectories: true)
        try write(script: script, root: root)
        return root
    }

    private func write(script: String, root: String) throws {
        let json = try JSONSerialization.data(withJSONObject: ["scripts": ["dev": script]])
        try json.write(to: URL(fileURLWithPath: "\(root)/package.json"))
    }

    @Test("Opening a project never starts its dev server: it waits for Start, naming the command and folder")
    func neverStartsOnItsOwn() async throws {
        let root = try project(script: "vite --port 59321")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let manager = PreviewServerManager()
        let url = await manager.ensureRunning(projectRoot: root)
        #expect(url == nil)
        #expect(!manager.managedByToolroll)
        guard case .needsStart(let command, let folder) = manager.status else {
            Issue.record("expected needsStart, got \(manager.status)")
            return
        }
        #expect(command.hasSuffix("dev (vite --port 59321)"))
        #expect(folder == root)
        #expect(manager.pendingStart?.command.scriptBody == "vite --port 59321")
    }

    @Test("A click consents to exactly the script it named: a changed script asks again")
    func consentIsBoundToTheScript() async throws {
        let root = try project(script: "vite --port 59322")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let manager = PreviewServerManager()
        _ = await manager.ensureRunning(projectRoot: root)
        #expect(manager.consentToPendingStart())
        try write(script: "vite --port 59322 && echo changed", root: root)
        _ = await manager.ensureRunning(projectRoot: root)
        #expect(!manager.managedByToolroll)
        guard case .needsStart(let command, _) = manager.status else {
            Issue.record("expected needsStart, got \(manager.status)")
            return
        }
        #expect(command.contains("echo changed"))
    }

    @Test("Nothing waiting means a click consents to nothing")
    func noPendingNoConsent() {
        #expect(!PreviewServerManager().consentToPendingStart())
    }

    @Test("The repo's scripts get only PATH, HOME, LANG, TERM and BROWSER, never the app's tokens")
    func minimalEnvironment() {
        let inherited = ["PATH": "/usr/bin:/bin", "LANG": "en_GB.UTF-8", "TERM": "xterm", "GITHUB_TOKEN": "ghp_x",
                         "ANTHROPIC_API_KEY": "sk-x", "TOOLROLL_DB": "/x/orders.db", "SSH_AUTH_SOCK": "/tmp/agent"]
        let env = PreviewServerManager.minimalEnvironment(inherited: inherited, home: "/Users/someone")
        #expect(Set(env.keys) == ["PATH", "HOME", "LANG", "TERM", "BROWSER"])
        #expect(env["HOME"] == "/Users/someone")
        #expect(env["LANG"] == "en_GB.UTF-8")
        #expect(env["PATH"]?.hasSuffix(":/usr/bin:/bin") == true)
        #expect(env["BROWSER"] == "none")
    }
}
