import SwiftUI
import ToolrollCompanionCore

/// Builds a file's flat row list once and keeps it while the same file is shown.
final class DiffLayoutCache {
    enum Row {
        case hunk(index: Int, header: String)
        case line(DiffLine)
    }

    private var file: ResultDiffFile?
    private var cached: (rows: [Row], widest: Int) = ([], 0)

    func layout(for file: ResultDiffFile) -> (rows: [Row], widest: Int) {
        if file == self.file { return cached }
        var rows: [Row] = []
        var widest = 0
        for (index, hunk) in file.file.hunks.enumerated() {
            rows.append(.hunk(index: index, header: hunk.header))
            widest = max(widest, hunk.header.count)
            for line in hunk.lines {
                rows.append(.line(line))
                widest = max(widest, line.text.count)
            }
        }
        self.file = file
        cached = (rows, widest)
        return cached
    }
}

/// One file's changes, read lazily with `task.diff { task, run, file }`.
/// Preserves the two-column old/new gutter and file stepper while adding Signal light/dark surfaces,
/// a crisp vertical gutter hairline, and horizontal scroll toggle.
struct DiffFileView: View {
    let appState: CompanionAppState
    @State private var route: DiffRoute
    @AppStorage("diff.wrapLines") private var wrapLines = false
    @ScaledMetric(relativeTo: .footnote) private var gutterWidth: CGFloat = 28
    @ScaledMetric(relativeTo: .footnote) private var charWidth: CGFloat = 8
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var layoutCache = DiffLayoutCache()

    init(appState: CompanionAppState, route: DiffRoute) {
        self.appState = appState
        _route = State(initialValue: route)
    }

    private var file: Loadable<ResultDiffFile> { appState.diffFile(route) }

    private var siblings: [DiffRoute] {
        guard let value = appState.diff(route.task).value, let run = value.run, run == route.run else { return [route] }
        let routes = value.files.filter { !$0.binary }.map {
            DiffRoute(task: route.task, run: run, file: $0.file, path: $0.path, additions: $0.additions, deletions: $0.deletions)
        }
        return routes.contains(route) ? routes : [route]
    }

    private func rows(_ file: ResultDiffFile) -> (rows: [DiffLayoutCache.Row], widest: Int) {
        layoutCache.layout(for: file)
    }

    var body: some View {
        VStack(spacing: 0) {
            pinnedFileHeader
            Divider().overlay(ToolrollTheme.hairline)
            GeometryReader { geometry in
                let viewport = max(0, geometry.size.width)
                let minHeight = max(0, geometry.size.height)
                Group {
                    if wrapLines {
                        ScrollView(.vertical) {
                            content(viewport: viewport)
                                .frame(minHeight: minHeight, alignment: .topLeading)
                        }
                    } else {
                        ScrollView([.horizontal, .vertical]) {
                            content(viewport: viewport)
                                .frame(minHeight: minHeight, alignment: .topLeading)
                        }
                        .defaultScrollAnchor(.topLeading)
                    }
                }
                .id(route)
            }
        }
        .background(ToolrollTheme.surface.ignoresSafeArea())
        .navigationTitle((route.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Long lines", selection: $wrapLines) {
                        Label("Scroll sideways", systemImage: "arrow.left.and.right").tag(false)
                        Label("Wrap long lines", systemImage: "text.alignleft").tag(true)
                    }
                } label: {
                    Image(systemName: wrapLines ? "text.alignleft" : "arrow.left.and.right")
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.ink)
                }
                .accessibilityLabel("Long lines")
                .accessibilityValue(wrapLines ? "Wrapped" : "Scroll sideways")
            }
        }
        .safeAreaInset(edge: .bottom) {
            let files = siblings
            if files.count > 1, let index = files.firstIndex(of: route) {
                fileStepper(files: files, index: index)
            }
        }
        .task(id: "\(appState.refreshTick)#\(route.file)") {
            await appState.loadDiffFile(route)
        }
    }

    private var pinnedFileHeader: some View {
        HStack(spacing: 8) {
            Text(route.path)
                .font(.caption.monospaced())
                .foregroundStyle(ToolrollTheme.muted)
                .lineLimit(1)
                .truncationMode(.head)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                HStack(spacing: 5) {
                    Text("+\(route.additions)").foregroundStyle(ToolrollTheme.success)
                    Text("−\(route.deletions)").foregroundStyle(ToolrollTheme.danger)
                }
                .font(.caption.monospacedDigit().weight(.semibold))
                if !dynamicTypeSize.isAccessibilitySize {
                    DiffStatPips(additions: route.additions, deletions: route.deletions)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(ToolrollTheme.paper)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func content(viewport: CGFloat) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if let value = file.value {
                let layout = rows(value)
                let lineWidth = max(viewport, CGFloat(layout.widest) * charWidth * 1.12 + gutterWidth * 2 + 52)
                if value.file.hunks.isEmpty {
                    Text(value.file.meta.isEmpty ? "No line changes to show." : value.file.meta.joined(separator: "\n"))
                        .font(.footnote.monospaced())
                        .foregroundStyle(ToolrollTheme.muted)
                        .padding(16)
                        .frame(width: viewport, alignment: .leading)
                }
                ForEach(Array(layout.rows.enumerated()), id: \.offset) { _, row in
                    switch row {
                    case .hunk(let index, let header):
                        hunkHeader(header, first: index == 0, index: index)
                            .frame(width: wrapLines ? viewport : lineWidth, alignment: .leading)
                    case .line(let line):
                        lineView(line)
                            .frame(width: wrapLines ? viewport : lineWidth, alignment: .leading)
                    }
                }
                if value.linesTruncated {
                    Text("This file is too long to show in full here. Open it on your Mac for the rest.")
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.muted)
                        .padding(16)
                        .frame(width: viewport, alignment: .leading)
                }
            } else if let failure = file.failure {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't load this file")
                        .font(.headline)
                        .foregroundStyle(ToolrollTheme.ink)
                    Text(failure)
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                    Button("Try again") { Task { await appState.loadDiffFile(route) } }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                        .frame(minHeight: 44)
                }
                .padding(16)
                .frame(width: viewport, alignment: .leading)
            } else {
                ProgressView()
                    .frame(width: viewport)
                    .padding(.vertical, 40)
            }
        }
        .padding(.bottom, 16)
    }

    private func fileStepper(files: [DiffRoute], index: Int) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(ToolrollTheme.hairline)
            HStack {
                Button {
                    route = files[index - 1]
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                }
                .disabled(index == 0)
                .accessibilityLabel("Previous file")

                Spacer()

                VStack(spacing: 1) {
                    Text((route.path as NSString).lastPathComponent)
                        .font(.caption.monospaced().weight(.medium))
                        .foregroundStyle(ToolrollTheme.ink)
                        .lineLimit(1)
                    Text("\(index + 1) of \(files.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(ToolrollTheme.muted)
                }
                .accessibilityLabel("File \(index + 1) of \(files.count)")

                Spacer()

                Button {
                    route = files[index + 1]
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                }
                .disabled(index == files.count - 1)
                .accessibilityLabel("Next file")
            }
            .foregroundStyle(ToolrollTheme.ink)
            .padding(.horizontal, 12)
        }
        .background(ToolrollTheme.paper)
    }

    static func hunkLabel(_ header: String, index: Int) -> String {
        let pattern = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
        if let match = header.firstMatch(of: pattern), let start = Int(match.1) {
            let count = match.2.flatMap { Int($0) } ?? 1
            let (sum, overflow) = start.addingReportingOverflow(max(count, 1) - 1)
            let end = overflow ? start : sum
            return "Change \(index + 1): lines \(start) to \(end)"
        }
        return "Change \(index + 1)"
    }

    private func hunkHeader(_ header: String, first: Bool, index: Int) -> some View {
        Text(header)
            .font(.caption.monospaced())
            .typesettingLanguage(Locale.Language(identifier: "zxx"))
            .foregroundStyle(ToolrollTheme.muted)
            .lineLimit(wrapLines ? nil : 1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollTheme.raised)
            .overlay(alignment: .bottom) { Divider().overlay(ToolrollTheme.hairline) }
            .overlay(alignment: .top) {
                if !first { Divider().overlay(ToolrollTheme.hairline) }
            }
            .padding(.top, first ? 0 : 10)
            .accessibilityLabel(Self.hunkLabel(header, index: index))
            .accessibilityAddTraits(.isHeader)
    }

    private func lineView(_ line: DiffLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if dynamicTypeSize.isAccessibilitySize {
                Text((line.newLine ?? line.oldLine).map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(gutterColor(line.kind))
            } else {
                Text(line.oldLine.map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(gutterColor(line.kind))
                Text(line.newLine.map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(gutterColor(line.kind))
            }

            Rectangle()
                .fill(ToolrollTheme.hairline)
                .frame(width: 1)
                .padding(.vertical, -2)

            Text(marker(line.kind))
                .foregroundStyle(markerColor(line.kind))
                .fontWeight(.bold)

            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .meta ? ToolrollTheme.muted : ToolrollTheme.ink)
                .fixedSize(horizontal: !wrapLines, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.footnote.monospaced())
        .typesettingLanguage(Locale.Language(identifier: "zxx"))
        .padding(.horizontal, 10)
        .padding(.vertical, 2.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Rectangle().fill(background(line.kind)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(line))
    }

    private func gutterColor(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.success.opacity(0.85)
        case .deletion: return ToolrollTheme.danger.opacity(0.85)
        default: return ToolrollTheme.subtle
        }
    }

    private func marker(_ kind: DiffLineKind) -> String {
        switch kind {
        case .addition: return "+"
        case .deletion: return "−"
        default: return " "
        }
    }

    private func markerColor(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.success
        case .deletion: return ToolrollTheme.danger
        default: return ToolrollTheme.subtle
        }
    }

    private func background(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.diffAddFill
        case .deletion: return ToolrollTheme.diffDelFill
        default: return .clear
        }
    }

    private func accessibilityText(_ line: DiffLine) -> String {
        let text = line.text.isEmpty ? "blank line" : line.text
        switch line.kind {
        case .addition: return "Added, line \(line.newLine ?? 0): \(text)"
        case .deletion: return "Removed, line \(line.oldLine ?? 0): \(text)"
        default: return "Line \(line.newLine ?? line.oldLine ?? 0): \(text)"
        }
    }
}
