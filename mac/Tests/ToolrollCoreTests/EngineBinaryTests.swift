import Foundation
import Testing
@testable import ToolrollCore

struct EngineBinaryTests {
    private func tree() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tr-engine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func executable(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
    }

    @Test("An installed package behind the link is started")
    func installedPackage() throws {
        let root = try tree(); defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("lib/node_modules/toolroll/dist/bin.js")
        try executable(target)
        let link = root.appendingPathComponent("bin/toolroll")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(EngineBinary.trusted(candidates: [link.path]) == target.resolvingSymlinksInPath().path)
    }

    @Test("A link into a source checkout is never started")
    func sourceCheckout() throws {
        let root = try tree(); defer { try? FileManager.default.removeItem(at: root) }
        let checkout = root.appendingPathComponent("work/toolroll")
        try FileManager.default.createDirectory(at: checkout.appendingPathComponent(".git"), withIntermediateDirectories: true)
        let target = checkout.appendingPathComponent("node_modules/toolroll/dist/bin.js")
        try executable(target)
        let link = root.appendingPathComponent("bin/toolroll")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(EngineBinary.trusted(candidates: [link.path]) == nil)
    }

    @Test("A link to anything that isn't an installed package is never started")
    func elsewhere() throws {
        let root = try tree(); defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("tmp/run.sh")
        try executable(target)
        let link = root.appendingPathComponent("bin/toolroll")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(EngineBinary.trusted(candidates: [link.path]) == nil)
    }
}
