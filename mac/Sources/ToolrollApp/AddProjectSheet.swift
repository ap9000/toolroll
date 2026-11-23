import AppKit
import SwiftUI
import ToolrollCore

/// Clean 3-option Add Project overlay (⌘⇧O):
/// 1. Local folder (Finder) | 2. Create new Git project | 3. Clone Git repository URL.
public struct AddProjectSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    enum Step {
        case menu
        case newRepo
        case cloneUrl
    }

    @State private var step: Step = .menu
    @State private var repoName: String = ""
    @State private var cloneUrl: String = ""
    @State private var parentFolder: String = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents", isDirectory: true).path
    }()
    @State private var errorText: String?
    @State private var isWorking: Bool = false

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                if step != .menu {
                    Button {
                        step = .menu
                        errorText = nil
                    } label: {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }
                Text(headerTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button {
                    store.isAddProjectSheetOpen = false
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
            }

            HairlineDivider()

            switch step {
            case .menu:
                VStack(spacing: 4) {
                    optionRow(
                        icon: "folder",
                        title: "Local folder",
                        subtitle: "Open an existing Git repository from Finder"
                    ) {
                        store.isAddProjectSheetOpen = false
                        dismiss()
                        store.pickAndAddLocalFolder()
                    }
                    optionRow(
                        icon: "folder.badge.plus",
                        title: "New project",
                        subtitle: "Create and initialize a new Git repository on disk"
                    ) {
                        step = .newRepo
                    }
                    optionRow(
                        icon: "link",
                        title: "Clone Git URL",
                        subtitle: "Clone a GitHub or remote repository locally"
                    ) {
                        step = .cloneUrl
                    }

                    if !store.unconnectedGitRepos.isEmpty {
                        HairlineDivider()
                            .padding(.vertical, 6)

                        HStack {
                            Text("Found on \(store.projectsRead == nil ? "this Mac" : store.isLocalSession ? "this Mac" : "this workspace") (\(store.unconnectedGitRepos.count))")
                                .font(.system(size: 10.5, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(0.5)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                        }
                        .padding(.horizontal, 4)
                        .padding(.bottom, 2)

                        ScrollView {
                            VStack(spacing: 3) {
                                ForEach(store.unconnectedGitRepos.prefix(16)) { repo in
                                    Button {
                                        store.isAddProjectSheetOpen = false
                                        dismiss()
                                        Task { await store.addLocalProject(path: repo.path) }
                                    } label: {
                                        HStack(spacing: 8) {
                                            Image(systemName: "folder.fill")
                                                .font(.system(size: 11.5))
                                                .foregroundStyle(ToolrollPalette.muted)
                                                .frame(width: 18)
                                            VStack(alignment: .leading, spacing: 1) {
                                                HStack(spacing: 6) {
                                                    Text(repo.name)
                                                        .font(.system(size: 12.5, weight: .medium))
                                                        .foregroundStyle(ToolrollPalette.ink)
                                                        .lineLimit(1)
                                                    if let branch = repo.branch {
                                                        Text(branch)
                                                            .font(.system(size: 10, design: .monospaced))
                                                            .foregroundStyle(ToolrollPalette.muted)
                                                            .lineLimit(1)
                                                    }
                                                }
                                                Text(ComposerAttachmentStore.abbreviateHomePath(repo.path))
                                                    .font(.system(size: 10.5, design: .monospaced))
                                                    .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
                                                    .lineLimit(1)
                                                    .truncationMode(.middle)
                                            }
                                            Spacer()
                                            Text("Add")
                                                .font(.system(size: 11, weight: .medium))
                                                .foregroundStyle(ToolrollPalette.ink.opacity(0.8))
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 3)
                                                .background(ToolrollPalette.raised, in: Capsule())
                                                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                                        }
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .toolrollHoverSurface(cornerRadius: 6)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(maxHeight: 200)
                    }
                }

            case .newRepo:
                VStack(alignment: .leading, spacing: 10) {
                    field("Project name", text: $repoName, placeholder: "my-new-app")
                    parentFolderRow
                    if let errorText {
                        Text(errorText).font(.system(size: 11.5)).foregroundStyle(ToolrollPalette.danger)
                    }
                    HStack {
                        Spacer()
                        Button(isWorking ? "Creating…" : "Create & Open") {
                            createNewGitProject()
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .disabled(isWorking || repoName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

            case .cloneUrl:
                VStack(alignment: .leading, spacing: 10) {
                    field("Repository URL or owner/repo", text: $cloneUrl, placeholder: "https://github.com/org/repo.git")
                    parentFolderRow
                    if let errorText {
                        Text(errorText).font(.system(size: 11.5)).foregroundStyle(ToolrollPalette.danger)
                    }
                    HStack {
                        Spacer()
                        Button(isWorking ? "Cloning…" : "Clone & Open") {
                            cloneGitRepository()
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .disabled(isWorking || cloneUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .padding(18)
        .frame(width: 440)
        .background(ToolrollPalette.paper)
    }

    private var headerTitle: String {
        switch step {
        case .menu: return "Add Project"
        case .newRepo: return "New Git Project"
        case .cloneUrl: return "Clone Repository"
        }
    }

    private func optionRow(icon: String, title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ToolrollPalette.muted)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
        }
    }

    private var parentFolderRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Location")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(parentFolder)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button("Choose…") {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                if panel.runModal() == .OK, let url = panel.url {
                    parentFolder = url.path
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
        }
    }

    private func createNewGitProject() {
        let name = repoName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        isWorking = true
        errorText = nil
        let target = URL(fileURLWithPath: parentFolder).appendingPathComponent(name, isDirectory: true)

        Task {
            do {
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                try runGit(["init", "-b", "main"], in: target.path)
                isWorking = false
                store.isAddProjectSheetOpen = false
                await store.addLocalProject(path: target.path)
                dismiss()
            } catch {
                errorText = error.localizedDescription
                isWorking = false
            }
        }
    }

    private func cloneGitRepository() {
        var raw = cloneUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.contains("://") && !raw.hasPrefix("git@") && raw.contains("/") {
            raw = "https://github.com/\(raw).git"
        }
        let repoSlug = URL(string: raw)?.deletingPathExtension().lastPathComponent ?? "cloned-repo"
        let target = URL(fileURLWithPath: parentFolder).appendingPathComponent(repoSlug, isDirectory: true)
        isWorking = true
        errorText = nil

        Task {
            do {
                try runGit(["clone", raw, target.path], in: parentFolder)
                isWorking = false
                store.isAddProjectSheetOpen = false
                await store.addLocalProject(path: target.path)
                dismiss()
            } catch {
                errorText = error.localizedDescription
                isWorking = false
            }
        }
    }

    private func runGit(_ args: [String], in cwd: String) throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let pipe = Pipe()
        proc.standardError = pipe
        proc.standardOutput = pipe
        try proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "git failed"
            throw ToolrollClientError.refused(out.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
