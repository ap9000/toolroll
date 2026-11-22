import AppKit
import SwiftUI
import ToolrollCore

/// Clean native reader & handoff view for existing local Claude Code, Codex, and Gemini CLI threads.
public struct LocalCliThreadView: View {
    @Bindable var store: WorkbenchStore
    let thread: LocalCliThread
    @State private var copiedResume: Bool = false

    public init(store: WorkbenchStore, thread: LocalCliThread) {
        self.store = store
        self.thread = thread
    }

    private var isRepoConnected: Bool {
        store.allProjects.contains { $0.caseInsensitiveCompare(thread.projectName) == .orderedSame }
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header bar
            HStack(spacing: 8) {
                Text(thread.provider.displayName)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3.5)
                    .background(ToolrollPalette.raised, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

                Text(thread.projectName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)

                if let branch = thread.branch, !branch.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 9.5))
                        Text(branch)
                            .font(.system(size: 10.5, design: .monospaced))
                            .lineLimit(1)
                    }
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(ToolrollPalette.raised, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }

                Spacer(minLength: 8)

                if !isRepoConnected, let path = thread.projectPath {
                    Button("Connect Repo") {
                        Task { await store.addLocalProject(path: path) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    .help("Add \(thread.projectName) to Toolroll")
                }

                Button {
                    let cmd = thread.projectPath.map { "cd \"\($0)\" && \(thread.resumeCommand)" } ?? thread.resumeCommand
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cmd, forType: .string)
                    copiedResume = true
                    store.notice = WorkbenchNotice(kind: .info, message: "Copied `\(thread.resumeCommand)` to clipboard.")
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copiedResume = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copiedResume ? "checkmark" : "terminal")
                            .font(.system(size: 10))
                        Text(copiedResume ? "Copied" : "Copy Resume")
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                .help("Copy `\(thread.resumeCommand)` to resume in your terminal")

                Button {
                    Task { await store.continueCliThreadAsTask(thread) }
                } label: {
                    HStack(spacing: 4) {
                        Text("Continue in Toolroll")
                        Image(systemName: "arrow.right")
                            .font(.system(size: 9.5, weight: .semibold))
                    }
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .help("Open Launchpad in \(thread.projectName) with this thread as context")

                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: thread.filePath)])
                } label: {
                    Image(systemName: "folder")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .help("Reveal raw session file in Finder")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(ToolrollPalette.paper)

            HairlineDivider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(thread.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)
                            .textSelection(.enabled)
                        HStack(spacing: 8) {
                            Text("Session \(thread.sessionId.prefix(12))")
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                            Text("·")
                                .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                            Text("Updated \(thread.relativeAge) ago")
                                .font(.system(size: 10.5))
                                .foregroundStyle(ToolrollPalette.muted)
                            if let path = thread.projectPath {
                                Text("·")
                                    .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                                Text(ComposerAttachmentStore.abbreviateHomePath(path))
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                    .padding(.bottom, 4)

                    if store.selectedCliThreadMessages.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("No text messages parsed from this session file.")
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                            Text("Use Copy Resume (`\(thread.resumeCommand)`) to inspect or resume it directly in your terminal.")
                                .font(.system(size: 11.5))
                                .foregroundStyle(ToolrollPalette.muted.opacity(0.85))
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    } else {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(store.selectedCliThreadMessages) { msg in
                                let isUser = msg.role == "user"
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack {
                                        Text(isUser ? "You" : thread.provider.displayName)
                                            .font(.system(size: 10.5, weight: .semibold))
                                            .foregroundStyle(isUser ? ToolrollPalette.ink : ToolrollPalette.muted)
                                        Spacer()
                                    }
                                    Text(msg.text)
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(ToolrollPalette.ink.opacity(isUser ? 0.96 : 0.88))
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    isUser ? ToolrollPalette.raised : ToolrollPalette.codeBg,
                                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                                )
                            }
                        }
                    }
                }
                .padding(18)
            }
        }
        .background(ToolrollPalette.paper)
    }
}
