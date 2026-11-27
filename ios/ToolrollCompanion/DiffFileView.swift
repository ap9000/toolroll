import SwiftUI
import ToolrollCompanionCore

/// One file's changes, read lazily with `task.diff { task, run, file }`.
/// Dynamic Type monospaced text, line wrapping on by default, scalable line numbers.
struct DiffFileView: View {
    let appState: CompanionAppState
    let route: DiffRoute
    @AppStorage("diff.wrapLines") private var wrapLines = true
    @ScaledMetric(relativeTo: .footnote) private var gutterWidth: CGFloat = 30
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var file: Loadable<ResultDiffFile> { appState.diffFile(route) }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let value = file.value {
                    if value.file.hunks.isEmpty {
                        Text(value.file.meta.isEmpty ? "No line changes to show." : value.file.meta.joined(separator: "\n"))
                            .font(.footnote.monospaced())
                            .foregroundStyle(ToolrollTheme.muted)
                    }
                    ForEach(Array(value.file.hunks.enumerated()), id: \.offset) { _, hunk in
                        hunkView(hunk)
                    }
                    if value.linesTruncated {
                        Text("This file is too long to show in full here. Open it on your Mac for the rest.")
                            .font(.footnote)
                            .foregroundStyle(ToolrollTheme.muted)
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
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .padding(.vertical, 32)
                }
            }
            .padding(16)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .navigationTitle((route.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(wrapLines ? "No wrap" : "Wrap") {
                    wrapLines.toggle()
                }
                .foregroundStyle(ToolrollTheme.ink)
                .accessibilityLabel("Wrap long lines")
                .accessibilityValue(wrapLines ? "On" : "Off")
            }
        }
        .task(id: appState.refreshTick) {
            await appState.loadDiffFile(route)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(route.path)
                .font(.footnote.monospaced())
                .foregroundStyle(ToolrollTheme.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Text("+\(route.additions) added").foregroundStyle(ToolrollTheme.success)
                Text("−\(route.deletions) removed").foregroundStyle(ToolrollTheme.danger)
            }
            .font(.footnote.monospacedDigit().weight(.semibold))
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func hunkView(_ hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(hunk.header)
                .font(.caption.monospaced())
                .typesettingLanguage(Locale.Language(identifier: "zxx"))
                .foregroundStyle(ToolrollTheme.muted)
                .lineLimit(wrapLines ? nil : 1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Rectangle().fill(ToolrollTheme.subtleFill))
                .accessibilityLabel("Lines \(hunk.header)")
            if wrapLines {
                lines(hunk)
            } else {
                ScrollView(.horizontal, showsIndicators: true) {
                    lines(hunk)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .card(radius: 10)
    }

    private func lines(_ hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                lineView(line)
            }
        }
    }

    private func lineView(_ line: DiffLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if dynamicTypeSize.isAccessibilitySize {
                // One gutter at large sizes: the line's number where it ends up (or where it was, if removed).
                Text((line.newLine ?? line.oldLine).map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(ToolrollTheme.muted)
            } else {
                Text(line.oldLine.map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(ToolrollTheme.muted)
                Text(line.newLine.map(String.init) ?? "")
                    .frame(width: gutterWidth, alignment: .trailing)
                    .foregroundStyle(ToolrollTheme.muted)
            }
            Text(marker(line.kind))
                .foregroundStyle(markerColor(line.kind))
                .fontWeight(.bold)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .meta ? ToolrollTheme.muted : ToolrollTheme.ink)
                .fixedSize(horizontal: !wrapLines, vertical: true)
                .frame(maxWidth: wrapLines ? .infinity : nil, alignment: .leading)
        }
        .font(.footnote.monospaced())
        .typesettingLanguage(Locale.Language(identifier: "zxx"))
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .frame(maxWidth: wrapLines ? .infinity : nil, alignment: .leading)
        .background(Rectangle().fill(background(line.kind)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(line))
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
        default: return ToolrollTheme.muted
        }
    }

    private func background(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: return ToolrollTheme.successSoft
        case .deletion: return ToolrollTheme.dangerSoft
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
