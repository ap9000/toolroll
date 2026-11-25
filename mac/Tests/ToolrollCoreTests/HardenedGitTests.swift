import Foundation
import Testing
@testable import ToolrollCore

@Suite("Hardened git")
struct HardenedGitTests {
    @Test("Every call disables fsmonitor, hooks, the untracked cache and ext:: before the command")
    func argv() {
        let args = HardenedGit.arguments(["rev-parse", "HEAD"])
        #expect(args == ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false",
                         "-c", "protocol.ext.allow=never", "rev-parse", "HEAD"])
    }

    @Test("The environment is made from nothing: no tokens, no system or global config, no prompts")
    func env() {
        let inherited = ["PATH": "/evil/bin:/usr/bin", "LANG": "fr_FR.UTF-8", "GITHUB_TOKEN": "ghp_x", "ANTHROPIC_API_KEY": "sk",
                         "GIT_DIR": "/elsewhere", "GIT_CONFIG_PARAMETERS": "'core.fsmonitor'='x'", "SSH_AUTH_SOCK": "/tmp/agent"]
        let env = HardenedGit.environment(inherited: inherited, home: "/Users/me")
        #expect(env == ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/Users/me", "LANG": "fr_FR.UTF-8",
                        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"])
        #expect(HardenedGit.environment(inherited: inherited, home: "/Users/me", forwardSSHAgent: true)["SSH_AUTH_SOCK"] == "/tmp/agent")
    }

    @Test("A config that names a program is refused, in plain words",
          arguments: [("core.fsmonitor\ntouch /tmp/x", true), ("core.fsmonitor\nfalse", false),
                      ("filter.lfs.clean\ngit-lfs clean -- %f", true), ("filter.x.process\nrun", true),
                      ("user.name\nme", false), ("CORE.FSMONITOR\n/bin/sh", true)])
    func configRefusal(_ entry: String, _ refused: Bool) {
        let data = Data(("core.bare\nfalse\u{0}" + entry + "\u{0}").utf8)
        #expect((HardenedGit.refusal(configList: data) != nil) == refused)
    }

    @Test("Only https and ssh clone addresses are taken",
          arguments: [("https://github.com/owner/repo.git", true), ("ssh://git@github.com/owner/repo", true),
                      ("git@github.com:owner/repo.git", true), ("ext::sh -c touch% /tmp/x", false),
                      ("file:///tmp/repo", false), ("/tmp/repo", false), ("--upload-pack=touch /tmp/x", false),
                      ("http://example.com/repo", false)])
    func cloneURLs(_ raw: String, _ ok: Bool) {
        #expect(HardenedGit.isCloneURL(raw) == ok)
    }

    private func repo() throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tr-git-\(UUID().uuidString)").resolvingSymlinksInPath().path
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let made = try #require(HardenedGit.run(["init", "-q"], in: root))
        #expect(made.status == 0)
        try "hello\n".write(toFile: "\(root)/a.txt", atomically: true, encoding: .utf8)
        return root
    }

    private func appendConfig(_ root: String, _ text: String) throws {
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: "\(root)/.git/config"))
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
        try handle.close()
    }

    @Test("Opening Canvas on a repository whose fsmonitor or filter runs a program runs nothing")
    func canvasNeverRunsRepoPrograms() throws {
        for config in ["[core]\n\tfsmonitor = touch SENTINEL\n", "[filter \"x\"]\n\tclean = touch SENTINEL\n\tsmudge = touch SENTINEL\n"] {
            let root = try repo()
            defer { try? FileManager.default.removeItem(atPath: root) }
            let sentinel = "\(root)/ran"
            try "a.txt filter=x\n".write(toFile: "\(root)/.gitattributes", atomically: true, encoding: .utf8)
            try appendConfig(root, config.replacingOccurrences(of: "SENTINEL", with: sentinel))
            #expect(HardenedGit.refusal(in: root) != nil)
            #expect(YouiCanvasStorage.gitStateKey(projectRoot: root) == "unread")
            #expect(YouiCanvasStorage.mainBranchKey(projectRoot: root) == "baseline")
            #expect(!FileManager.default.fileExists(atPath: sentinel))
        }
    }

    @Test("A filter pulled in through an include is refused too")
    func includedFilterRefused() throws {
        let root = try repo()
        defer { try? FileManager.default.removeItem(atPath: root) }
        try "[filter \"x\"]\n\tclean = touch \(root)/ran\n".write(toFile: "\(root)/extra.cfg", atomically: true, encoding: .utf8)
        try appendConfig(root, "[include]\n\tpath = \(root)/extra.cfg\n")
        #expect(HardenedGit.refusal(in: root) != nil)
        #expect(YouiCanvasStorage.gitStateKey(projectRoot: root) == "unread")
    }

    @Test("A plain repository gets a key that changes when a file changes")
    func plainRepoKeyTracksEdits() throws {
        let root = try repo()
        defer { try? FileManager.default.removeItem(atPath: root) }
        #expect(HardenedGit.refusal(in: root) == nil)
        let first = YouiCanvasStorage.gitStateKey(projectRoot: root)
        #expect(first.hasPrefix("nogit-"))
        try "hello, longer\n".write(toFile: "\(root)/a.txt", atomically: true, encoding: .utf8)
        #expect(YouiCanvasStorage.gitStateKey(projectRoot: root) != first)
    }
}
