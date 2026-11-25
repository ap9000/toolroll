import Foundation

public enum EngineBinary {
    public static let candidates = ["/opt/homebrew/bin/toolroll", "/usr/local/bin/toolroll"]

    public static func trusted(candidates: [String] = candidates, fileManager: FileManager = .default) -> String? {
        for path in candidates where fileManager.isExecutableFile(atPath: path) {
            let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
            if isInstalledPackage(resolved), !insideWorkTree(resolved, fileManager: fileManager) { return resolved }
        }
        return nil
    }

    static func isInstalledPackage(_ resolved: String) -> Bool {
        resolved.contains("/Cellar/toolroll/") || resolved.contains("/lib/node_modules/toolroll/")
    }

    static func insideWorkTree(_ resolved: String, fileManager: FileManager) -> Bool {
        var dir = URL(fileURLWithPath: resolved).deletingLastPathComponent()
        while dir.path != "/" {
            if fileManager.fileExists(atPath: dir.appendingPathComponent(".git").path) { return true }
            dir = dir.deletingLastPathComponent()
        }
        return false
    }
}
