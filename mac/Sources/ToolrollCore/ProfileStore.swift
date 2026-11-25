import Foundation

public struct ProfileStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            let base: URL
            if let xdg, !xdg.isEmpty {
                base = URL(fileURLWithPath: xdg, isDirectory: true)
            } else {
                base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config", isDirectory: true)
            }
            self.fileURL = base
                .appendingPathComponent("toolroll", isDirectory: true)
                .appendingPathComponent("remote", isDirectory: true)
                .appendingPathComponent("profiles.json", isDirectory: false)
        }
    }

    private struct DiskProfile: Codable {
        var origin: String
        var account: String
        var token: String
        var workspaceId: String?
        var recoveryGeneration: String?
        var label: String?
    }

    private struct DiskFile: Codable {
        var version: Int
        var active: String
        var profiles: [String: DiskProfile]
    }

    public struct LoadedProfiles: Sendable, Equatable {
        public let activeName: String?
        public let profiles: [ConnectionProfile]

        public var active: ConnectionProfile? {
            if let activeName, let found = profiles.first(where: { $0.name == activeName }) {
                return found
            }
            return profiles.first
        }
    }

    public func load() -> LoadedProfiles {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return LoadedProfiles(activeName: nil, profiles: [])
        }
        guard let data = try? Data(contentsOf: fileURL),
              let disk = try? JSONDecoder().decode(DiskFile.self, from: data),
              disk.version == 1
        else {
            return LoadedProfiles(activeName: nil, profiles: [])
        }
        let sorted = disk.profiles.keys.sorted().compactMap { name -> ConnectionProfile? in
            guard let p = disk.profiles[name] else { return nil }
            return ConnectionProfile(
                name: name,
                origin: p.origin,
                account: p.account,
                token: p.token,
                workspaceId: p.workspaceId,
                recoveryGeneration: p.recoveryGeneration,
                label: p.label,
                isDemo: false
            )
        }
        return LoadedProfiles(activeName: disk.active, profiles: sorted)
    }

    public func save(profile: ConnectionProfile, makeActive: Bool = true) throws {
        var existing = load()
        var map: [String: DiskProfile] = [:]
        for item in existing.profiles where !item.isDemo {
            map[item.name] = DiskProfile(
                origin: item.origin,
                account: item.account,
                token: item.token,
                workspaceId: item.workspaceId,
                recoveryGeneration: item.recoveryGeneration,
                label: item.label
            )
        }
        map[profile.name] = DiskProfile(
            origin: profile.origin,
            account: profile.account,
            token: profile.token,
            workspaceId: profile.workspaceId,
            recoveryGeneration: profile.recoveryGeneration,
            label: profile.label
        )
        let active = makeActive ? profile.name : (existing.activeName ?? profile.name)
        let file = DiskFile(version: 1, active: active, profiles: map)
        let dir = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let bytes = try encoder.encode(file)
        let tmp = dir.appendingPathComponent("profiles.json.\(UUID().uuidString.prefix(8)).tmp")
        try Self.writePrivate(bytes, to: tmp.path)
        _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmp)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        existing = load()
        _ = existing
    }

    /// Writes a new file that is 0600 from the moment it exists: created exclusively (never through an existing file or a
    /// symlink), so the tokens in it are never readable by anyone else, even briefly.
    static func writePrivate(_ bytes: Data, to path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: path]) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: bytes)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            unlink(path)
            throw error
        }
    }

    public func setActive(name: String) throws {
        let existing = load()
        guard let target = existing.profiles.first(where: { $0.name == name }) else { return }
        try save(profile: target, makeActive: true)
    }

    public static func demoProfile() -> ConnectionProfile {
        ConnectionProfile(
            name: "demo",
            origin: "https://demo.toolroll.local",
            account: "alex",
            token: "",
            workspaceId: "ws-demo",
            recoveryGeneration: "gen-demo",
            label: "Demo Workspace (Offline Preview)",
            isDemo: true
        )
    }
}
