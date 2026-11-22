import AppKit
import SwiftUI
import ToolrollCore

/// A document displayed inside Toolroll's right-hand Artifact window (Plan, Result Summary, or local Markdown file).
public struct WorkbenchArtifact: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let markdown: String
    public let filePath: String?
    public let isPinnedVirtual: Bool

    public init(
        id: String,
        title: String,
        subtitle: String,
        markdown: String,
        filePath: String? = nil,
        isPinnedVirtual: Bool = false
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.markdown = markdown
        self.filePath = filePath
        self.isPinnedVirtual = isPinnedVirtual
    }
}

/// Right-hand tabbed Artifact & Markdown reader — displays Implementation Plans, Result Walkthroughs,
/// and project Markdown docs (ADRs, GLOSSARY, README, custom files) with full GFM tables, callouts, and code blocks.
struct ArtifactPaneView: View {
    @Bindable var store: WorkbenchStore
    @State private var copiedId: String? = nil

    private var activeArtifact: WorkbenchArtifact? {
        if let activeId = store.activeArtifactId,
           let match = store.openArtifacts.first(where: { $0.id == activeId }) {
            return match
        }
        return store.openArtifacts.first
    }

    var body: some View {
        VStack(spacing: 0) {
            artifactTabStrip
            HairlineDivider()

            if let doc = activeArtifact {
                // Subtle metadata & action strip
                HStack(spacing: 8) {
                    Text(doc.subtitle)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(doc.markdown, forType: .string)
                        copiedId = doc.id
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            if copiedId == doc.id { copiedId = nil }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: copiedId == doc.id ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 10.5))
                            Text(copiedId == doc.id ? "Copied" : "Copy")
                                .font(.system(size: 10.5, weight: .medium))
                        }
                        .foregroundStyle(copiedId == doc.id ? ToolrollPalette.success : ToolrollPalette.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Copy Markdown")

                    if let filePath = doc.filePath {
                        Button {
                            store.reloadArtifactFile(id: doc.id)
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 10.5))
                        }
                        .buttonStyle(ToolrollIconButtonStyle(size: 22))
                        .help("Reload file from disk")

                        Button {
                            NSWorkspace.shared.open(URL(fileURLWithPath: filePath))
                        } label: {
                            Image(systemName: "arrow.up.right.square")
                                .font(.system(size: 11))
                        }
                        .buttonStyle(ToolrollIconButtonStyle(size: 22))
                        .help("Open in external editor")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(ToolrollPalette.paper)

                HairlineDivider()

                ScrollView {
                    NativeMarkdownView(markdown: doc.markdown)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 18)
                }
                .textSelection(.enabled)
            } else {
                emptyArtifactState
            }
        }
        .background(ToolrollPalette.paper)
        .onAppear {
            store.syncTaskArtifacts()
        }
        .onChange(of: store.selectedTaskId) { _, _ in
            store.syncTaskArtifacts()
        }
    }

    private var artifactTabStrip: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(store.openArtifacts) { doc in
                        let active = doc.id == activeArtifact?.id
                        HStack(spacing: 5) {
                            Button {
                                store.activeArtifactId = doc.id
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: doc.filePath != nil ? "doc.text" : "doc.richtext")
                                        .font(.system(size: 10))
                                    Text(doc.title)
                                        .font(.system(size: 11, weight: active ? .semibold : .regular))
                                        .lineLimit(1)
                                }
                                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .padding(.vertical, 4)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if !doc.isPinnedVirtual || store.openArtifacts.count > 1 {
                                Button {
                                    store.closeArtifact(id: doc.id)
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 8.5, weight: .semibold))
                                        .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                                        .frame(width: 14, height: 14)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 8)
                        .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1)
                        )
                    }
                }
            }

            // + Menu to open project Markdown docs or pick any .md file
            Menu {
                let projectDocs = store.discoverProjectMarkdownFiles()
                if !projectDocs.isEmpty {
                    Section("Project Docs") {
                        ForEach(projectDocs, id: \.path) { docURL in
                            Button(docURL.lastPathComponent) {
                                store.openMarkdownArtifact(path: docURL.path)
                            }
                        }
                    }
                    Divider()
                }
                Button("Open Markdown File…") {
                    store.pickAndOpenMarkdownArtifact()
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 24, height: 22)
                    .toolrollHoverSurface(cornerRadius: 4)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Open project doc or Markdown artifact")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(ToolrollPalette.raised)
    }

    private var emptyArtifactState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "doc.richtext")
                .font(.system(size: 26))
                .foregroundStyle(ToolrollPalette.muted.opacity(0.5))
            Text("No artifact open")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Select a task with a Plan or Result Summary, or open any Markdown document from your project.")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
            Button("Open Markdown File…") {
                store.pickAndOpenMarkdownArtifact()
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Pure Native SwiftUI GFM Markdown Renderer (Tables, Callouts, Code Blocks, Headings, Lists)

private struct NativeMarkdownView: View {
    let markdown: String

    private var blocks: [MarkdownBlock] {
        MarkdownBlockParser.parse(markdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text):
                    VStack(alignment: .leading, spacing: 6) {
                        inlineText(text)
                            .font(headingFont(level))
                            .foregroundStyle(ToolrollPalette.ink)
                            .padding(.top, level == 1 ? 2 : 8)
                        if level == 2 {
                            HairlineDivider()
                        }
                    }

                case .paragraph(let text):
                    inlineText(text)
                        .font(.system(size: 13))
                        .foregroundStyle(ToolrollPalette.ink.opacity(0.92))
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)

                case .callout(let text):
                    HStack(alignment: .top, spacing: 0) {
                        Rectangle()
                            .fill(ToolrollPalette.muted.opacity(0.55))
                            .frame(width: 2.5)
                        inlineText(text)
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.88))
                            .lineSpacing(4)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                case .codeBlock(let lang, let code):
                    MarkdownCodeBlockView(language: lang, code: code)

                case .table(let headers, let rows):
                    MarkdownTableView(headers: headers, rows: rows)

                case .list(let ordered, let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(ordered ? "\(idx + 1)." : "•")
                                    .font(.system(size: 12, weight: .semibold, design: ordered ? .monospaced : .default))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .frame(minWidth: ordered ? 18 : 10, alignment: .trailing)
                                inlineText(item)
                                    .font(.system(size: 13))
                                    .foregroundStyle(ToolrollPalette.ink.opacity(0.92))
                                    .lineSpacing(3.5)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                case .divider:
                    HairlineDivider()
                        .padding(.vertical, 4)
                }
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(size: 19, weight: .bold)
        case 2: return .system(size: 15, weight: .semibold)
        case 3: return .system(size: 13.5, weight: .semibold)
        default: return .system(size: 12.5, weight: .semibold)
        }
    }

    private func inlineText(_ raw: String) -> Text {
        if let attr = try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(attr)
        }
        return Text(raw)
    }
}

private struct MarkdownCodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text((language?.isEmpty == false ? language! : "code").lowercased())
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.3))
                        copied = false
                    }
                } label: {
                    Text(copied ? "Copied" : "Copy")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(copied ? ToolrollPalette.success : ToolrollPalette.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(ToolrollPalette.raised)

            HairlineDivider()

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }
}

private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        let colCount = max(headers.count, rows.map(\.count).max() ?? 0)
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                // Header row
                HStack(alignment: .top, spacing: 0) {
                    ForEach(0..<colCount, id: \.self) { c in
                        let cellText = c < headers.count ? headers[c] : ""
                        inlineCell(cellText, bold: true)
                            .frame(minWidth: c == 0 ? 120 : 140, maxWidth: 240, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                        if c + 1 < colCount {
                            Rectangle().fill(ToolrollPalette.line).frame(width: 1)
                        }
                    }
                }
                .background(ToolrollPalette.raised)

                ForEach(Array(rows.enumerated()), id: \.offset) { rIdx, row in
                    HairlineDivider()
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(0..<colCount, id: \.self) { c in
                            let cellText = c < row.count ? row[c] : ""
                            inlineCell(cellText, bold: false)
                                .frame(minWidth: c == 0 ? 120 : 140, maxWidth: 240, alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                            if c + 1 < colCount {
                                Rectangle().fill(ToolrollPalette.line).frame(width: 1)
                            }
                        }
                    }
                    .background(rIdx % 2 == 1 ? ToolrollPalette.raised.opacity(0.35) : Color.clear)
                }
            }
            .background(ToolrollPalette.paper)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func inlineCell(_ raw: String, bold: Bool) -> some View {
        let base: Text
        if let attr = try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            base = Text(attr)
        } else {
            base = Text(raw)
        }
        return base
            .font(.system(size: 11.5, weight: bold ? .semibold : .regular))
            .foregroundStyle(bold ? ToolrollPalette.ink : ToolrollPalette.ink.opacity(0.9))
            .lineSpacing(2.5)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case callout(String)
    case codeBlock(language: String?, code: String)
    case table(headers: [String], rows: [[String]])
    case list(ordered: Bool, items: [String])
    case divider
}

private enum MarkdownBlockParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            // Fenced code block
            if trimmed.hasPrefix("```") {
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                i += 1
                var codeLines: [String] = []
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }
                blocks.append(.codeBlock(language: lang.isEmpty ? nil : lang, code: codeLines.joined(separator: "\n")))
                continue
            }

            // Horizontal rule
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                blocks.append(.divider)
                i += 1
                continue
            }

            // Heading
            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix { $0 == "#" }
                if hashes.count <= 4, trimmed.dropFirst(hashes.count).first == " " {
                    let text = String(trimmed.dropFirst(hashes.count + 1)).trimmingCharacters(in: .whitespaces)
                    blocks.append(.heading(level: hashes.count, text: text))
                    i += 1
                    continue
                }
            }

            // Blockquote / Callout
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix(">") {
                        let stripped = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
                        quoteLines.append(stripped)
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.callout(quoteLines.joined(separator: "\n")))
                continue
            }

            // GFM Table (header + separator row containing ---)
            if trimmed.contains("|"), i + 1 < lines.count {
                let nextTrim = lines[i + 1].trimmingCharacters(in: .whitespaces)
                if nextTrim.contains("|") && nextTrim.contains("---") {
                    let headers = splitTableRow(trimmed)
                    i += 2
                    var rows: [[String]] = []
                    while i < lines.count {
                        let rt = lines[i].trimmingCharacters(in: .whitespaces)
                        if rt.contains("|") && !rt.isEmpty {
                            rows.append(splitTableRow(rt))
                            i += 1
                        } else {
                            break
                        }
                    }
                    blocks.append(.table(headers: headers, rows: rows))
                    continue
                }
            }

            // Bullet list
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("- ") || t.hasPrefix("* ") {
                        items.append(String(t.dropFirst(2)))
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(ordered: false, items: items))
                continue
            }

            // Ordered list
            if let dotRange = trimmed.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if let r = t.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
                        items.append(String(t[r.upperBound...]))
                        i += 1
                    } else {
                        break
                    }
                }
                _ = dotRange
                blocks.append(.list(ordered: true, items: items))
                continue
            }

            // Paragraph
            var paraLines: [String] = []
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                if t.isEmpty || t.hasPrefix("#") || t.hasPrefix("```") || t.hasPrefix(">") || t.hasPrefix("- ") || t.hasPrefix("* ") || t == "---" {
                    break
                }
                if t.contains("|"), i + 1 < lines.count, lines[i + 1].contains("---") {
                    break
                }
                paraLines.append(t)
                i += 1
            }
            if !paraLines.isEmpty {
                blocks.append(.paragraph(paraLines.joined(separator: " ")))
            } else {
                i += 1
            }
        }

        return blocks
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s = String(s.dropFirst()) }
        if s.hasSuffix("|") { s = String(s.dropLast()) }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
