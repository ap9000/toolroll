import AppKit
import SwiftUI
import ToolrollCore

public struct AgentChatView: View {
    @Bindable var store: WorkbenchStore
    let thread: AgentChatThread

    @State private var isComposerDropTargeted: Bool = false
    @State private var expandedToolMessageIds: Set<String> = []
    @FocusState private var replyFocused: Bool

    public init(store: WorkbenchStore, thread: AgentChatThread) {
        self.store = store
        self.thread = thread
    }

    private var replyTextBinding: Binding<String> {
        Binding(
            get: { store.chatReplyDrafts[thread.id] ?? "" },
            set: { store.chatReplyDrafts[thread.id] = $0 }
        )
    }

    private var currentReplyText: String {
        store.chatReplyDrafts[thread.id] ?? ""
    }

    private var currentAttachments: [ComposerAttachment] {
        store.chatReplyAttachments[thread.id] ?? []
    }

    private func addChatAttachments(_ incoming: [ComposerAttachment]) {
        var list = store.chatReplyAttachments[thread.id] ?? []
        appendUniqueAttachments(incoming, to: &list)
        store.chatReplyAttachments[thread.id] = list
    }

    private func removeChatAttachment(_ id: UUID) {
        var list = store.chatReplyAttachments[thread.id] ?? []
        list.removeAll { $0.id == id }
        store.chatReplyAttachments[thread.id] = list
    }

    private var isRunning: Bool {
        store.runningChatThreadIds.contains(thread.id)
    }

    private var gitDiff: AgentChatGitDiff {
        store.chatThreadDiffs[thread.id] ?? AgentChatGitDiff()
    }

    public var body: some View {
        VStack(spacing: 0) {
            if store.isChatDiffDrawerOpen && !gitDiff.isEmpty {
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
                Button("Hide") { store.isChatDiffDrawerOpen = false }
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

    @ViewBuilder
    private func messageRow(_ msg: AgentChatMessage) -> some View {
        if msg.role == .user {
            HStack(alignment: .top, spacing: 10) {
                UserMonogramBadge(account: store.activeProfile.account, size: 22)
                Text(msg.text)
                    .font(.system(size: 13.5))
                    .lineSpacing(3)
                    .foregroundStyle(ToolrollPalette.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        } else {
            HStack(alignment: .top, spacing: 10) {
                ProviderBrandGlyph(provider: thread.provider.rawValue, size: 22, tinted: true, inTile: true)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 8) {
                    Text(thread.provider.label(for: thread.modelId))
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(-0.1)
                        .foregroundStyle(ToolrollPalette.ink)

                    if msg.isStreaming || !msg.tools.isEmpty {
                        liveActivityRow(for: msg)
                    }

                    if !msg.text.isEmpty {
                        if msg.isError {
                            Text(msg.text)
                                .font(.system(size: 13.5))
                                .foregroundStyle(ToolrollPalette.danger)
                                .textSelection(.enabled)
                                .lineSpacing(3)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            NativeMarkdownView(markdown: msg.text, compact: true, bodyFontSize: 13.5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    } else if !msg.isStreaming && !msg.isError {
                        Text(msg.tools.isEmpty ? "Response was interrupted before finishing." : "Completed steps with no final text reply.")
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    private func liveActivityRow(for msg: AgentChatMessage) -> some View {
        let isExpanded = expandedToolMessageIds.contains(msg.id)
        let currentTool = msg.tools.last(where: { $0.status == "running" }) ?? msg.tools.last
        let hasSteps = !msg.tools.isEmpty

        return VStack(alignment: .leading, spacing: 6) {
            if hasSteps {
                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        if isExpanded {
                            expandedToolMessageIds.remove(msg.id)
                        } else {
                            expandedToolMessageIds.insert(msg.id)
                        }
                    }
                } label: {
                    HStack(spacing: 7) {
                        if msg.isStreaming {
                            ToolrollKineticLoader(provider: thread.provider.rawValue, height: 11)
                                .frame(width: 12, height: 12)
                            Text(liveStepHeadline(tool: currentTool))
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(ToolrollPalette.ink.opacity(0.85))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if msg.tools.count > 1 {
                                Text("· \(msg.tools.count) steps")
                                    .font(.system(size: 11.5))
                                    .monospacedDigit()
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .fixedSize()
                            }
                        } else {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 8.5, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.muted)
                                .frame(width: 10)
                            Text("Worked through \(msg.tools.count) \(msg.tools.count == 1 ? "step" : "steps")")
                                .font(.system(size: 12, weight: .medium))
                                .monospacedDigit()
                                .foregroundStyle(ToolrollPalette.muted)
                        }

                        if msg.isStreaming {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 8.5, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
                        }

                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 3)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isExpanded {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(msg.tools) { tool in
                            HStack(spacing: 7) {
                                stepStatusIcon(tool.status)
                                    .frame(width: 12, height: 12)
                                Text(tool.name)
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(ToolrollPalette.ink.opacity(0.85))
                                if !tool.detail.isEmpty {
                                    Text(tool.detail)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(.leading, 10)
                    .padding(.vertical, 4)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(ToolrollPalette.line)
                            .frame(width: 1)
                            .padding(.leading, 4)
                    }
                }
            } else if msg.isStreaming {
                KineticThinkingRow(provider: thread.provider.rawValue, label: "Thinking…")
            }
        }
    }

    private func liveStepHeadline(tool: AgentChatToolEvent?) -> String {
        guard let tool else { return "Thinking…" }
        let verb: String
        switch tool.name.lowercased() {
        case "read": verb = "Reading"
        case "edit": verb = "Editing"
        case "write": verb = "Writing"
        case "bash", "shell", "run": verb = "Running"
        case "grep", "search": verb = "Searching"
        case "glob", "browse": verb = "Browsing"
        default: verb = tool.name
        }
        return tool.detail.isEmpty ? "\(verb)…" : "\(verb) \(tool.detail)"
    }

    @ViewBuilder
    private func stepStatusIcon(_ status: String) -> some View {
        if status == "running" {
            ToolrollKineticLoader(provider: thread.provider.rawValue, height: 9)
        } else if status == "error" {
            Image(systemName: "xmark")
                .font(.system(size: 8.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.danger)
        } else {
            Image(systemName: "checkmark")
                .font(.system(size: 8.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
        }
    }

    private var composerFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !currentAttachments.isEmpty {
                ComposerAttachmentStrip(attachments: currentAttachments) { removedId in
                    removeChatAttachment(removedId)
                }
            }

            TextField(
                "Message \(thread.provider.displayName) in \(thread.projectName)…",
                text: replyTextBinding,
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
                    addChatAttachments(incoming)
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
                    .disabled(currentReplyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && currentAttachments.isEmpty)
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
            addChatAttachments(incoming)
        }
        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                addChatAttachments(incoming)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 14)
        .padding(.top, 6)
        .frame(maxWidth: 868)
        .frame(maxWidth: .infinity)
    }

    private func sendReply() {
        let trimmed = currentReplyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !currentAttachments.isEmpty else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: currentAttachments)
        store.chatReplyDrafts[thread.id] = ""
        store.chatReplyAttachments[thread.id] = []
        Task {
            await store.sendChatMessage(threadId: thread.id, text: composed.combinedMessage)
        }
    }
}
