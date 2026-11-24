import AppKit
import SwiftUI
import ToolrollCore

public struct AgentChatView: View {
    @Bindable var store: WorkbenchStore
    let thread: AgentChatThread

    @State private var replyText: String = ""
    @State private var attachments: [ComposerAttachment] = []
    @State private var showDiffDrawer: Bool = false
    @State private var isComposerDropTargeted: Bool = false
    @FocusState private var replyFocused: Bool

    public init(store: WorkbenchStore, thread: AgentChatThread) {
        self.store = store
        self.thread = thread
    }

    private var isRunning: Bool {
        store.runningChatThreadIds.contains(thread.id)
    }

    private var gitDiff: AgentChatGitDiff {
        store.chatThreadDiffs[thread.id] ?? AgentChatGitDiff()
    }

    public var body: some View {
        VStack(spacing: 0) {
            chatHeaderBar
            HairlineDivider()

            if showDiffDrawer && !gitDiff.isEmpty {
                diffPreviewDrawer
                HairlineDivider()
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(thread.messages) { msg in
                            messageRow(msg)
                                .id(msg.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("chat-bottom-anchor")
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 20)
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .onChange(of: thread.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("chat-bottom-anchor", anchor: .bottom)
                    }
                }
                .onChange(of: thread.messages.last?.text.count) { _, _ in
                    proxy.scrollTo("chat-bottom-anchor", anchor: .bottom)
                }
            }

            composerFooter
        }
        .background(ToolrollPalette.ground)
        .onAppear {
            replyFocused = true
            Task { await store.refreshChatDiff(threadId: thread.id) }
        }
    }

    private var chatHeaderBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                if isRunning {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Circle()
                        .fill(ToolrollPalette.success)
                        .frame(width: 6, height: 6)
                }
                Text(thread.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Text(thread.projectName)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 7)
                .frame(height: 22)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))

            providerModelMenu

            Spacer(minLength: 8)

            if !gitDiff.isEmpty {
                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        showDiffDrawer.toggle()
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 10.5))
                        Text("\(gitDiff.changedFiles.count) changed")
                            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    }
                    .foregroundStyle(showDiffDrawer ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(showDiffDrawer ? ToolrollPalette.raised : Color.clear, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("Inspect working tree diff in \(thread.projectName)")
            }

            Button {
                Task { await store.promoteChatToTask(threadId: thread.id) }
            } label: {
                Label("Ship as Task", systemImage: "arrow.up.right.square")
                    .font(.system(size: 11.5, weight: .medium))
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Create a structured Toolroll task from this chat for formal checks & merge")

            Menu {
                Button("Open Shell in \(thread.projectName)") {
                    Task { await store.startProjectTerminal(project: thread.projectName, program: "shell") }
                }
                Button("Open Canvas for \(thread.projectName)") {
                    store.activeProject = thread.projectName
                    store.workspaceMode = .canvas
                }
                Button("Refresh Diff") {
                    Task { await store.refreshChatDiff(threadId: thread.id) }
                }
                Divider()
                Button("Delete Chat", role: .destructive) {
                    store.deleteChatThread(id: thread.id)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 26, height: 24)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .background(ToolrollPalette.ground)
    }

    private var providerModelMenu: some View {
        Menu {
            ForEach(AgentChatProvider.allCases) { provider in
                Section(provider.displayName) {
                    ForEach(provider.presets, id: \.id) { preset in
                        Button {
                            store.updateChatThreadModel(threadId: thread.id, provider: provider, modelId: preset.id)
                        } label: {
                            HStack {
                                Text(preset.label)
                                if thread.provider == provider && thread.modelId == preset.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(thread.provider.shortBadge)
                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(thread.provider.label(for: thread.modelId))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(ToolrollPalette.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(isRunning)
    }

    private var diffPreviewDrawer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Working tree changes (\(gitDiff.changedFiles.count))")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button("Refresh") {
                    Task { await store.refreshChatDiff(threadId: thread.id) }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
                Button("Hide") { showDiffDrawer = false }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(gitDiff.changedFiles.prefix(20), id: \.self) { file in
                        Text(file)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    if !gitDiff.diffText.isEmpty {
                        Text(gitDiff.diffText)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
            .frame(maxHeight: 200)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised)
    }

    private func messageRow(_ msg: AgentChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if msg.role == .user {
                HStack {
                    Spacer(minLength: 48)
                    Text(msg.text)
                        .font(.system(size: 13.5))
                        .foregroundStyle(ToolrollPalette.ink)
                        .textSelection(.enabled)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(thread.provider.displayName)
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                        if msg.isStreaming {
                            ProgressView()
                                .controlSize(.mini)
                        }
                    }

                    if !msg.tools.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(msg.tools) { tool in
                                HStack(spacing: 6) {
                                    Image(systemName: tool.status == "running" ? "circle.dotted" : "checkmark")
                                        .font(.system(size: 9.5, weight: .semibold))
                                        .foregroundStyle(tool.status == "running" ? ToolrollPalette.live : ToolrollPalette.muted)
                                    Text(tool.name)
                                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink)
                                    if !tool.detail.isEmpty {
                                        Text(tool.detail)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.muted)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            }
                        }
                    }

                    if !msg.text.isEmpty {
                        Text(msg.text)
                            .font(.system(size: 13.5))
                            .foregroundStyle(msg.isError ? ToolrollPalette.danger : ToolrollPalette.ink)
                            .textSelection(.enabled)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if msg.isStreaming {
                        Text("Thinking…")
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
        }
    }

    private var composerFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ComposerAttachmentStrip(attachments: attachments) { removedId in
                    attachments.removeAll { $0.id == removedId }
                }
            }

            TextField(
                "Message \(thread.provider.displayName) in \(thread.projectName)…",
                text: $replyText,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 13.5))
            .foregroundStyle(ToolrollPalette.ink)
            .lineLimit(1...6)
            .focused($replyFocused)
            .onSubmit {
                if !isRunning { sendReply() }
            }
            .padding(.horizontal, 4)

            HStack(spacing: 8) {
                ComposerAttachMenuButton(compact: true) { incoming in
                    appendUniqueAttachments(incoming, to: &attachments)
                }
                Spacer()
                if isRunning {
                    Button {
                        store.stopChatThread(threadId: thread.id)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 9))
                            Text("Stop")
                        }
                        .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                } else {
                    Button {
                        sendReply()
                    } label: {
                        HStack(spacing: 4) {
                            Text("Send")
                            Image(systemName: "arrow.up")
                                .font(.system(size: 10, weight: .bold))
                        }
                        .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
                }
            }
        }
        .padding(12)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(isComposerDropTargeted ? ToolrollPalette.live : (replyFocused ? ToolrollPalette.inputLine : ToolrollPalette.line), lineWidth: 1)
        )
        .onComposerPaste(isActive: replyFocused) { incoming in
            appendUniqueAttachments(incoming, to: &attachments)
        }
        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                appendUniqueAttachments(incoming, to: &attachments)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 14)
        .padding(.top, 6)
        .frame(maxWidth: 868)
        .frame(maxWidth: .infinity)
    }

    private func sendReply() {
        let trimmed = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: attachments)
        replyText = ""
        attachments = []
        Task {
            await store.sendChatMessage(threadId: thread.id, text: composed.combinedMessage)
        }
    }
}
