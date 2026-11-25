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

public struct ParsedMessageAttachment: Identifiable, Sendable, Equatable {
    public let id: String
    public let kind: ComposerAttachmentKind
    public let path: String
    public let displayName: String
    public let pixelSize: String?

    public init(kind: ComposerAttachmentKind, path: String, pixelSize: String? = nil) {
        self.id = "\(kind.rawValue):\(path)"
        self.kind = kind
        self.path = path
        self.displayName = URL(fileURLWithPath: path).lastPathComponent.isEmpty
            ? path
            : URL(fileURLWithPath: path).lastPathComponent
        self.pixelSize = pixelSize
    }
}

public enum ComposerAttachmentStore {
    public static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "tiff", "tif", "bmp", "svg"
    ]

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

    public static func parseAttachedContext(from rawText: String) -> (body: String, attachments: [ParsedMessageAttachment]) {
        let lines = rawText.components(separatedBy: .newlines)
        guard let markerIdx = lines.lastIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "Attached context:" }) else {
            return (body: rawText, attachments: [])
        }
        var parsed: [ParsedMessageAttachment] = []
        let tail = lines[(markerIdx + 1)...]
        for rawLine in tail {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("- Image: ") {
                let rest = String(trimmed.dropFirst("- Image: ".count)).trimmingCharacters(in: .whitespaces)
                var path = rest
                var pixelSize: String? = nil
                if rest.hasSuffix(")"), let openParen = rest.lastIndex(of: "(") {
                    let candidate = String(rest[rest.index(after: openParen)..<rest.index(before: rest.endIndex)])
                    if candidate.contains("×") || candidate.contains("x") {
                        pixelSize = candidate
                        path = String(rest[..<openParen]).trimmingCharacters(in: .whitespaces)
                    }
                }
                if !path.isEmpty {
                    parsed.append(ParsedMessageAttachment(kind: .image, path: path, pixelSize: pixelSize))
                }
            } else if trimmed.hasPrefix("- File: ") {
                let path = String(trimmed.dropFirst("- File: ".count)).trimmingCharacters(in: .whitespaces)
                if !path.isEmpty {
                    parsed.append(ParsedMessageAttachment(kind: .file, path: path))
                }
            } else if trimmed.hasPrefix("- Folder: ") {
                let path = String(trimmed.dropFirst("- Folder: ".count)).trimmingCharacters(in: .whitespaces)
                if !path.isEmpty {
                    parsed.append(ParsedMessageAttachment(kind: .folder, path: path))
                }
            } else {
                return (body: rawText, attachments: [])
            }
        }
        guard !parsed.isEmpty else {
            return (body: rawText, attachments: [])
        }
        let body = lines[..<markerIdx].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (body: body, attachments: parsed)
    }
}
