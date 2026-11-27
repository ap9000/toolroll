import Foundation
import Testing
@testable import ToolrollCompanionCore

// The shared phone-path table (test/fixtures/companion-paths.json). src/companion/paths.ts runs the same cases, so
// the Mac and the phone agree on every path either one builds or accepts.

private struct RawPath: Decodable {
    let kind: String
    let url: String
}

private struct PathTable: Decodable {
    struct Single: Decodable {
        let path: RawPath
        let ok: Bool
    }
    struct List: Decodable {
        let paths: [RawPath]
        let ok: Bool
    }
    let single: [Single]
    let lists: [List]
}

/// Walks up from this file to the repo root (the directory holding test/fixtures/companion-paths.json).
private func loadTable(file: String = #filePath) throws -> PathTable {
    var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent("test/fixtures/companion-paths.json")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(PathTable.self, from: Data(contentsOf: candidate))
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
}

private func allowed(_ path: RawPath) -> Bool {
    (try? CompanionPathRules.validate(kind: path.kind, url: path.url)) != nil
}

private func allowed(_ paths: [RawPath]) -> Bool {
    var typed: [CompanionPath] = []
    for raw in paths {
        guard let kind = CompanionPath.Kind(rawValue: raw.kind) else { return false }
        typed.append(CompanionPath(kind: kind, url: raw.url))
    }
    return (try? CompanionPathRules.validate(typed)) != nil
}

@Test("Every single-path case in the shared table matches the one-path validator")
func sharedTableSingle() throws {
    let table = try loadTable()
    #expect(!table.single.isEmpty)
    for case_ in table.single {
        #expect(allowed(case_.path) == case_.ok, "\(case_.path.kind) \(case_.path.url) should be \(case_.ok ? "allowed" : "rejected")")
    }
}

@Test("Every list case in the shared table matches the list validator")
func sharedTableLists() throws {
    let table = try loadTable()
    #expect(!table.lists.isEmpty)
    for (i, case_) in table.lists.enumerated() {
        #expect(allowed(case_.paths) == case_.ok, "list case \(i) should be \(case_.ok ? "allowed" : "rejected")")
    }
}
