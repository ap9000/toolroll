import Foundation

public enum DiffScopeMode: String, Sendable, Equatable, CaseIterable {
    case branch
    case turn

    public var title: String {
        switch self {
        case .branch: return "Branch"
        case .turn: return "Last Turn"
        }
    }
}

public struct ParsedUnifiedDiffFile: Sendable, Equatable, Identifiable {
    public let path: String
    public let hunks: [DiffHunk]
    public let added: Int
    public let removed: Int
    public var id: String { path }

    public init(path: String, hunks: [DiffHunk], added: Int, removed: Int) {
        self.path = path
        self.hunks = hunks
        self.added = added
        self.removed = removed
    }
}

public enum DiffReviewEngine {
    public static func parseUnifiedDiff(_ diffText: String) -> [ParsedUnifiedDiffFile] {
        let trimmed = diffText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        let rawLines = diffText.components(separatedBy: "\n")
        var files: [ParsedUnifiedDiffFile] = []

        var currentPath: String?
        var currentHunks: [DiffHunk] = []
        var currentHunkHeader: String?
        var currentHunkLines: [DiffLine] = []
        var currentAdded = 0
        var currentRemoved = 0
        var oldLine = 0
        var newLine = 0

        func flushHunk() {
            guard let header = currentHunkHeader else { return }
            currentHunks.append(DiffHunk(header: header, lines: currentHunkLines))
            currentHunkHeader = nil
            currentHunkLines = []
        }

        func flushFile() {
            flushHunk()
            guard let path = currentPath else { return }
            files.append(ParsedUnifiedDiffFile(
                path: path,
                hunks: currentHunks,
                added: currentAdded,
                removed: currentRemoved
            ))
            currentPath = nil
            currentHunks = []
            currentAdded = 0
            currentRemoved = 0
        }

        for raw in rawLines {
            if raw.hasPrefix("diff --git ") {
                flushFile()
                currentPath = extractPathFromDiffHeader(raw)
                continue
            }
            if raw.hasPrefix("+++ ") {
                let candidate = String(raw.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                if candidate != "/dev/null" {
                    let clean = candidate.hasPrefix("b/") ? String(candidate.dropFirst(2)) : candidate
                    if !clean.isEmpty {
                        currentPath = clean
                    }
                }
                continue
            }
            if raw.hasPrefix("--- ") || raw.hasPrefix("index ") || raw.hasPrefix("new file mode") || raw.hasPrefix("deleted file mode") || raw.hasPrefix("similarity index") || raw.hasPrefix("rename from") || raw.hasPrefix("rename to") {
                continue
            }
            if raw.hasPrefix("@@ ") {
                flushHunk()
                currentHunkHeader = raw
                let starts = parseHunkStarts(raw)
                oldLine = starts.oldStart
                newLine = starts.newStart
                continue
            }
            guard currentHunkHeader != nil else { continue }
            if raw.hasPrefix("+") {
                let body = String(raw.dropFirst())
                currentHunkLines.append(DiffLine(kind: "add", text: body, oldLine: nil, newLine: newLine))
                newLine += 1
                currentAdded += 1
            } else if raw.hasPrefix("-") {
                let body = String(raw.dropFirst())
                currentHunkLines.append(DiffLine(kind: "del", text: body, oldLine: oldLine, newLine: nil))
                oldLine += 1
                currentRemoved += 1
            } else if raw.hasPrefix("\\ ") {
                currentHunkLines.append(DiffLine(kind: "meta", text: raw, oldLine: nil, newLine: nil))
            } else if raw.hasPrefix(" ") {
                let body = String(raw.dropFirst())
                currentHunkLines.append(DiffLine(kind: "context", text: body, oldLine: oldLine, newLine: newLine))
                oldLine += 1
                newLine += 1
            }
        }

        flushFile()
        return files
    }

    public static func formatBatchPrompt(
        comments: [InlineDiffComment],
        intro: String = "Please address these review comments:"
    ) -> String {
        guard !comments.isEmpty else { return "" }
        var sections: [String] = [intro]
        for (index, comment) in comments.enumerated() {
            var block = "\(index + 1). `\(comment.locationLabel)`"
            if let snippet = comment.snippet?.trimmingCharacters(in: .whitespacesAndNewlines), !snippet.isEmpty {
                let clipped = snippet.count > 260 ? String(snippet.prefix(260)) + "…" : snippet
                block += "\n```\n\(clipped)\n```"
            }
            block += "\n\(comment.text.trimmingCharacters(in: .whitespacesAndNewlines))"
            sections.append(block)
        }
        return sections.joined(separator: "\n\n")
    }

    public static func extractSnippet(from lines: [DiffLine], startLine: Int, endLine: Int) -> String? {
        let low = min(startLine, endLine)
        let high = max(startLine, endLine)
        let picked = lines.filter { line in
            guard let ln = line.newLine ?? line.oldLine else { return false }
            return ln >= low && ln <= high
        }
        guard !picked.isEmpty else { return nil }
        return picked.prefix(6).map { line in
            let prefix = line.isAddition ? "+" : (line.isDeletion ? "-" : " ")
            return "\(prefix)\(line.text)"
        }.joined(separator: "\n")
    }

    private static func extractPathFromDiffHeader(_ header: String) -> String {
        let rest = header.dropFirst("diff --git ".count)
        let parts = rest.split(separator: " ", maxSplits: 1)
        if parts.count == 2 {
            let bPart = String(parts[1])
            return bPart.hasPrefix("b/") ? String(bPart.dropFirst(2)) : bPart
        }
        return String(rest)
    }

    private static func parseHunkStarts(_ header: String) -> (oldStart: Int, newStart: Int) {
        var oldStart = 1
        var newStart = 1
        let tokens = header.split(separator: " ")
        for token in tokens {
            if token.hasPrefix("-") && !token.hasPrefix("---") {
                let numPart = token.dropFirst().split(separator: ",").first ?? ""
                if let parsed = Int(numPart) {
                    oldStart = parsed
                }
            } else if token.hasPrefix("+") && !token.hasPrefix("+++") {
                let numPart = token.dropFirst().split(separator: ",").first ?? ""
                if let parsed = Int(numPart) {
                    newStart = parsed
                }
            }
        }
        return (oldStart, newStart)
    }
}
