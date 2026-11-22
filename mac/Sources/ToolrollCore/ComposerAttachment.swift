import Foundation

public enum ComposerAttachmentKind: String, Codable, Sendable, Equatable {
    case image
    case folder
    case file
}

public struct ComposerAttachment: Identifiable, Codable, Sendable, Equatable {
    public let id: UUID
    public let kind: ComposerAttachmentKind
    public let path: String
    public let displayName: String
    public let subtitle: String?
    public let pixelSize: String?

    public init(
        id: UUID = UUID(),
        kind: ComposerAttachmentKind,
        path: String,
        displayName: String,
        subtitle: String? = nil,
        pixelSize: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.path = path
        self.displayName = displayName
        self.subtitle = subtitle
        self.pixelSize = pixelSize
    }
}

public enum ComposerAttachmentStore {
    public static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "tiff", "tif", "bmp", "svg"
    ]

    /// Directory inside the user's home folder (~/Library/Caches/ToolrollAttachments)
    /// so sandboxed agents (Claude Code, Codex, Gemini) can read attached images
    /// without touching Toolroll's denied config directories or polluting git worktrees.
    public static func defaultDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches", isDirectory: true)
        return caches.appendingPathComponent("ToolrollAttachments", isDirectory: true)
    }

    public static func saveImageData(
        _ pngData: Data,
        pixelSize: String? = nil,
        suggestedName: String? = nil,
        in directory: URL? = nil
    ) throws -> ComposerAttachment {
        let dir = directory ?? defaultDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = fmt.string(from: Date())
        let shortId = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(6).lowercased())
        let fileName = "paste-\(stamp)-\(shortId).png"
        let targetURL = dir.appendingPathComponent(fileName)
        try pngData.write(to: targetURL, options: .atomic)

        let label: String
        if let suggestedName, !suggestedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            label = suggestedName
        } else {
            let timeFmt = DateFormatter()
            timeFmt.dateFormat = "h:mm a"
            label = "Pasted image (\(timeFmt.string(from: Date())))"
        }

        return ComposerAttachment(
            kind: .image,
            path: targetURL.path,
            displayName: label,
            subtitle: pixelSize,
            pixelSize: pixelSize
        )
    }

    public static func makeAttachment(for url: URL, pixelSize: String? = nil) -> ComposerAttachment? {
        guard url.isFileURL else { return nil }
        let standardized = url.standardizedFileURL
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: standardized.path, isDirectory: &isDir) else {
            return nil
        }

        let name = standardized.lastPathComponent.isEmpty ? standardized.path : standardized.lastPathComponent
        let parentPath = abbreviateHomePath(standardized.deletingLastPathComponent().path)

        if isDir.boolValue {
            return ComposerAttachment(
                kind: .folder,
                path: standardized.path,
                displayName: name,
                subtitle: parentPath
            )
        }

        let ext = standardized.pathExtension.lowercased()
        if imageExtensions.contains(ext) {
            return ComposerAttachment(
                kind: .image,
                path: standardized.path,
                displayName: name,
                subtitle: pixelSize ?? ext.uppercased(),
                pixelSize: pixelSize
            )
        }

        return ComposerAttachment(
            kind: .file,
            path: standardized.path,
            displayName: name,
            subtitle: parentPath
        )
    }

    public static func abbreviateHomePath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    public static func formatContextBlock(for attachments: [ComposerAttachment]) -> String {
        guard !attachments.isEmpty else { return "" }
        var lines: [String] = ["Attached context:"]
        for item in attachments {
            switch item.kind {
            case .folder:
                lines.append("- Folder: \(item.path)")
            case .image:
                if let px = item.pixelSize, !px.isEmpty {
                    lines.append("- Image: \(item.path) (\(px))")
                } else {
                    lines.append("- Image: \(item.path)")
                }
            case .file:
                lines.append("- File: \(item.path)")
            }
        }
        return lines.joined(separator: "\n")
    }

    public static func composeSubmission(
        text: String,
        attachments: [ComposerAttachment]
    ) -> (title: String, goal: String, combinedMessage: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let context = formatContextBlock(for: attachments)

        guard !attachments.isEmpty else {
            return (title: trimmed, goal: "", combinedMessage: trimmed)
        }

        let title: String
        if !trimmed.isEmpty {
            title = trimmed
        } else if let first = attachments.first {
            switch first.kind {
            case .image:
                title = attachments.count == 1 ? "Inspect attached image (\(first.displayName))" : "Inspect \(attachments.count) attached images"
            case .folder:
                title = attachments.count == 1 ? "Work with folder \(first.displayName)" : "Work with \(attachments.count) attached folders"
            case .file:
                title = attachments.count == 1 ? "Inspect \(first.displayName)" : "Inspect \(attachments.count) attached files"
            }
        } else {
            title = "Attached context"
        }

        let combined: String
        if trimmed.isEmpty {
            combined = context
        } else {
            combined = "\(trimmed)\n\n\(context)"
        }
        return (title: title, goal: combined, combinedMessage: combined)
    }
}
