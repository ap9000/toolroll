import AppKit
import SwiftUI
import ToolrollCore

private struct DirectChatGallerySelection: Identifiable, Equatable {
    let id = UUID()
    let artifacts: [DirectChatArtifact]
    let initialIndex: Int
}

public struct AgentChatView: View {
    @Bindable var store: WorkbenchStore
    let thread: AgentChatThread

    @State private var isComposerDropTargeted: Bool = false
    @State private var expandedToolMessageIds: Set<String> = []
    @State private var selectedDiffFileFilter: String? = nil
    @State private var isPosturePopoverOpen: Bool = false
    @State private var isUsagePopoverOpen: Bool = false
    @State private var lightboxSelection: DirectChatGallerySelection? = nil
    @State private var localAttachmentPreview: ([ParsedMessageAttachment], Int)? = nil
    @State private var isLocalLightboxOpen = false
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
        store.runningChatThreadIds.contains(thread.id) || thread.running
    }

    private var gitDiff: AgentChatGitDiff {
        store.chatThreadDiffs[thread.id] ?? AgentChatGitDiff()
    }

    public var body: some View {
        VStack(spacing: 0) {
            workspaceStatusStrip

            if store.showBackgroundServiceBanner && !store.directChatBackgroundOn && !store.activeProfile.isDemo {
                backgroundServiceBanner
                HairlineDivider()
            }

            if let gitError = store.chatGitBindingErrors[thread.id] {
                gitRepairBanner(gitError)
                HairlineDivider()
            }

            if !thread.mainDirtyFiles.isEmpty {
                mainDirtyBanner
                HairlineDivider()
            }

            if let latestShip = thread.ships.first {
                shipStatusBanner(latestShip)
                HairlineDivider()
            }

            if store.isChatDiffDrawerOpen && !gitDiff.isEmpty {
                diffPreviewDrawer
                HairlineDivider()
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if !thread.attachments.isEmpty {
                            threadAttachmentsStrip
                        }
                        ForEach(thread.messages) { msg in
                            messageRow(msg)
                                .id(msg.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("chat-bottom-anchor")
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 18)
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
            if !thread.id.hasPrefix("pending-") {
                Task { await store.refreshDirectChatDetail(threadId: thread.id) }
            }
        }
        .sheet(item: $lightboxSelection) { selection in
            DirectChatArtifactLightbox(
                store: store,
                artifacts: selection.artifacts,
                initialIndex: selection.initialIndex
            )
            .dismissSheetOnOutsideClick()
        }
        .sheet(isPresented: $isLocalLightboxOpen) {
            if let preview = localAttachmentPreview {
                LocalAttachmentLightbox(images: preview.0, initialIndex: preview.1)
                    .dismissSheetOnOutsideClick()
            }
        }
    }

    private var workspaceStatusStrip: some View {
        HStack(spacing: 8) {
            if !thread.branch.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9.5))
                    Text(thread.branch)
                        .font(.system(size: 10.5, design: .monospaced))
                        .lineLimit(1)
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                .help("Isolated local clone — cannot modify your main repo refs, hooks, or config")
            }

            Button {
                isPosturePopoverOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: thread.posture.sandboxed ? "checkmark.shield" : "bolt.shield")
                        .font(.system(size: 9.5))
                        .foregroundStyle(thread.posture.sandboxed ? ToolrollPalette.success : ToolrollPalette.warning)
                    Text(thread.posture.summary)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .popover(isPresented: $isPosturePopoverOpen, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Image(systemName: thread.posture.sandboxed ? "checkmark.shield.fill" : "bolt.shield.fill")
                            .foregroundStyle(thread.posture.sandboxed ? ToolrollPalette.success : ToolrollPalette.warning)
                        Text(thread.posture.summary)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    Text(thread.posture.detail)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Changes stay in an isolated local clone with no remote until you press Ship.")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(width: 280)
            }

            Spacer()

            if let usage = thread.usage, usage.contextTokens > 0 || usage.totalTokens > 0 {
                contextUsagePill(usage)
            }

            if store.directChatBackgroundOn {
                HStack(spacing: 4) {
                    Circle().fill(ToolrollPalette.success).frame(width: 5.5, height: 5.5)
                    Text("Background on")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .help("Chats keep running even if you close Toolroll")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(ToolrollPalette.ground)
        .overlay(alignment: .bottom) { HairlineDivider() }
    }

    private func contextUsagePill(_ usage: DirectChatUsage) -> some View {
        let frac = usage.contextFraction ?? 0
        let gaugeColor: Color = frac >= 0.90
            ? ToolrollPalette.danger
            : (frac >= 0.75 ? ToolrollPalette.warning : ToolrollPalette.live)
        return Button {
            isUsagePopoverOpen.toggle()
        } label: {
            HStack(spacing: 6) {
                if usage.contextWindow != nil {
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(ToolrollPalette.line)
                            .frame(width: 28, height: 4)
                        Capsule()
                            .fill(gaugeColor)
                            .frame(width: max(2, 28 * min(1, frac)), height: 4)
                    }
                }
                Text(usage.compactContextLabel)
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .monospacedDigit()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(ToolrollPalette.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Context window & token usage")
        .popover(isPresented: $isUsagePopoverOpen, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Context & Tokens")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Spacer()
                    Text(store.directChatModelLabel(provider: thread.provider, modelId: thread.modelId))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                if let window = usage.contextWindow, window > 0 {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Context window")
                                .font(.system(size: 11))
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Text("\(usage.contextTokens.formatted()) / \(window.formatted())")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.ink)
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(ToolrollPalette.line)
                                Capsule()
                                    .fill(gaugeColor)
                                    .frame(width: max(3, geo.size.width * min(1, frac)))
                            }
                        }
                        .frame(height: 5)
                    }
                }

                HairlineDivider()

                VStack(alignment: .leading, spacing: 4) {
                    usageMetricRow("Input tokens", value: usage.inputTokens.formatted())
                    if usage.cacheReadTokens > 0 {
                        usageMetricRow("Cache read", value: usage.cacheReadTokens.formatted())
                    }
                    if usage.cacheCreationTokens > 0 {
                        usageMetricRow("Cache write", value: usage.cacheCreationTokens.formatted())
                    }
                    usageMetricRow("Output tokens", value: usage.outputTokens.formatted())
                    if usage.thinkingTokens > 0 {
                        usageMetricRow("Thinking tokens", value: usage.thinkingTokens.formatted())
                    }
                    if let cost = usage.costUsd, cost > 0 {
                        usageMetricRow("List-price equiv.", value: String(format: "$%.3f", cost))
                    }
                }
            }
            .padding(12)
            .frame(width: 280)
        }
    }

    private func usageMetricRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
            Spacer()
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
                .monospacedDigit()
        }
    }

    private var backgroundServiceBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.live)
            Text("Keep chats running if you close Toolroll by turning on the background service.")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                .lineLimit(1)
            Spacer()
            Button(store.isUpdatingBackgroundService ? "Enabling…" : "Turn On Background") {
                Task { _ = await store.setBackgroundServiceEnabled(true) }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(store.isUpdatingBackgroundService)
            Button {
                store.dismissBackgroundServiceBanner()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(ToolrollPalette.raised)
    }

    private func gitRepairBanner(_ errorText: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "wrench.and.screwdriver.fill")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.warning)
            Text(errorText)
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(2)
            Spacer()
            Button("Repair Git Binding") {
                Task { await store.repairChatGitBinding(threadId: thread.id) }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
            .disabled(isRunning)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(ToolrollPalette.warning.opacity(0.10))
    }

    private var mainDirtyBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.live)
            Text("Main checkout had \(thread.mainDirtyFiles.count) uncommitted \(thread.mainDirtyFiles.count == 1 ? "file" : "files") when this chat started.")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                .lineLimit(1)
            Spacer()
            Button("Bring in my uncommitted changes") {
                Task { await store.applyMainEditsToChat(threadId: thread.id) }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(isRunning)
            Button {
                store.dismissMainDirtyNotice(threadId: thread.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(ToolrollPalette.raised)
    }

    private func shipStatusBanner(_ ship: DirectChatShipSummary) -> some View {
        let tone: Color = switch ship.state {
        case "merged", "kept": ToolrollPalette.success
        case "cancelled", "failed": ToolrollPalette.danger
        default: ToolrollPalette.live
        }
        return HStack(spacing: 8) {
            Circle().fill(tone).frame(width: 7, height: 7)
            Text("Ship #\(ship.seq) · \(ship.statusLabel)")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("\(ship.branch) (\(ship.shortSha))")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.muted)
                .lineLimit(1)
            if let detail = ship.detail, !detail.isEmpty {
                Text("· \(detail)")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer()
            if let prUrl = ship.prUrl, !prUrl.isEmpty {
                Button("Open PR") {
                    store.openExternalURL(prUrl)
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
            if let taskId = ship.taskId, !taskId.isEmpty {
                Button("View Task") {
                    Task { await store.selectTask(taskId) }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
            if ship.canCancel {
                Button("Cancel Auto-Merge") {
                    Task { await store.cancelChatShip(threadId: thread.id, shipId: ship.id) }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(tone.opacity(0.08))
    }

    private var filteredDiffLines: [String] {
        let rawLines = gitDiff.diffText.components(separatedBy: "\n")
        guard let targetFile = selectedDiffFileFilter else { return rawLines }
        var out: [String] = []
        var inSection = false
        for line in rawLines {
            if line.hasPrefix("diff --git ") {
                inSection = line.contains("b/\(targetFile)") || line.contains(targetFile)
            }
            if inSection { out.append(line) }
        }
        return out.isEmpty ? rawLines : out
    }

    private var diffPreviewDrawer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Isolated clone changes (\(gitDiff.changedFiles.count))")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button("Ship…") {
                    Task { await store.openChatShipSheet(threadId: thread.id) }
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(isRunning)
                Button("Refresh") {
                    Task { await store.refreshDirectChatDetail(threadId: thread.id) }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
                Button("Hide") { store.isChatDiffDrawerOpen = false }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    diffFilterChip(label: "All (\(gitDiff.changedFiles.count))", isSelected: selectedDiffFileFilter == nil) {
                        selectedDiffFileFilter = nil
                    }
                    ForEach(gitDiff.changedFiles.prefix(24), id: \.self) { file in
                        diffFilterChip(
                            label: (file as NSString).lastPathComponent,
                            isSelected: selectedDiffFileFilter == file
                        ) {
                            selectedDiffFileFilter = (selectedDiffFileFilter == file) ? nil : file
                        }
                        .help(file)
                    }
                }
            }

            if !gitDiff.diffText.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(filteredDiffLines.enumerated()), id: \.offset) { _, line in
                            Text(line.isEmpty ? " " : line)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(diffLineForeground(line))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 0.5)
                                .background(diffLineBackground(line))
                        }
                    }
                    .textSelection(.enabled)
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: 240)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised)
    }

    private func diffFilterChip(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 10.5, weight: isSelected ? .semibold : .regular, design: .monospaced))
                .foregroundStyle(isSelected ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(isSelected ? Color.white.opacity(0.11) : ToolrollPalette.ground, in: Capsule())
                .overlay(Capsule().strokeBorder(isSelected ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func diffLineForeground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return ToolrollPalette.success }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return ToolrollPalette.danger }
        if line.hasPrefix("@@") { return ToolrollPalette.live }
        if line.hasPrefix("diff --git") || line.hasPrefix("---") || line.hasPrefix("+++") { return ToolrollPalette.muted }
        return ToolrollPalette.ink.opacity(0.88)
    }

    private func diffLineBackground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return ToolrollPalette.success.opacity(0.10) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return ToolrollPalette.danger.opacity(0.10) }
        if line.hasPrefix("@@") { return ToolrollPalette.live.opacity(0.08) }
        return .clear
    }

    private var threadAttachmentsStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Attached to this chat")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            artifactGallery(thread.attachments)
        }
    }

    private func artifactDisplayLabel(_ artifact: DirectChatArtifact, index: Int) -> String {
        if artifact.filename.hasPrefix("tool-capture-") {
            return "Screenshot \(index + 1)"
        }
        return artifact.filename
    }

    private func artifactGallery(_ artifacts: [DirectChatArtifact]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(artifacts.enumerated()), id: \.element.id) { idx, artifact in
                    DirectChatArtifactCard(
                        store: store,
                        artifact: artifact,
                        label: artifactDisplayLabel(artifact, index: idx)
                    ) {
                        lightboxSelection = DirectChatGallerySelection(
                            artifacts: artifacts,
                            initialIndex: idx
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func messageRow(_ msg: AgentChatMessage) -> some View {
        if msg.role == .user {
            VStack(alignment: .leading, spacing: 6) {
                if let prev = msg.switchedFromProvider {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.left.arrow.right")
                            .font(.system(size: 9.5))
                        Text("Handed off from \(prev.displayName) to \(thread.provider.displayName)")
                            .font(.system(size: 10.5, weight: .medium))
                    }
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.leading, 4)
                }
                let parsed = ComposerAttachmentStore.parseAttachedContext(from: msg.text)
                HStack(alignment: .top, spacing: 10) {
                    UserMonogramBadge(account: store.activeProfile.account, size: 22)
                    VStack(alignment: .leading, spacing: 8) {
                        if !parsed.body.isEmpty {
                            Text(parsed.body)
                                .font(.system(size: 13.5))
                                .lineSpacing(3)
                                .foregroundStyle(ToolrollPalette.chatBubbleInk)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if !parsed.attachments.isEmpty {
                            MessageAttachmentStrip(
                                attachments: parsed.attachments,
                                inkColor: ToolrollPalette.chatBubbleInk
                            ) { imgs, idx in
                                localAttachmentPreview = (imgs, idx)
                                isLocalLightboxOpen = true
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(ToolrollPalette.chatBubble, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(ToolrollPalette.chatBubbleBorder, lineWidth: 1))
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                ProviderBrandGlyph(provider: thread.provider.rawValue, size: 22, tinted: true, inTile: true)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(store.directChatModelLabel(provider: thread.provider, modelId: thread.modelId))
                            .font(.system(size: 12, weight: .semibold))
                            .tracking(-0.1)
                            .foregroundStyle(ToolrollPalette.ink)
                        if let eff = thread.effort, !eff.isEmpty {
                            Text(DirectChatEffortDisplay.label(for: eff))
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1.5)
                                .background(ToolrollPalette.raised, in: Capsule())
                                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                        }
                        if let u = msg.usage, !msg.isStreaming, u.outputTokens > 0 {
                            Text("\(DirectChatEffortDisplay.formatTokens(u.outputTokens)) out")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                        }
                    }

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
                        Text(msg.status == "stopped"
                             ? "Stopped."
                             : (msg.tools.isEmpty ? "Response was interrupted before finishing." : "Completed steps with no final text reply."))
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }

                    if !msg.artifacts.isEmpty {
                        artifactGallery(msg.artifacts)
                            .padding(.top, 2)
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
        let runningTool = msg.tools.last(where: { $0.status == "running" })
        let hasSteps = !msg.tools.isEmpty
        let isWritingText = msg.isStreaming && !msg.text.isEmpty && runningTool == nil

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
                            Text(isWritingText ? "Writing reply…" : liveStepHeadline(tool: runningTool ?? msg.tools.last))
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(ToolrollPalette.ink.opacity(0.85))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if msg.tools.count > 1 || isWritingText {
                                Text("· \(msg.tools.count) \(msg.tools.count == 1 ? "step" : "steps")")
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
                KineticThinkingRow(provider: thread.provider.rawValue, label: msg.text.isEmpty ? "Thinking…" : "Writing reply…")
            }
        }
    }

    private func liveStepHeadline(tool: AgentChatToolEvent?) -> String {
        guard let tool else { return "Thinking…" }
        if tool.name.lowercased() == "workspace" {
            return tool.detail.isEmpty ? "Preparing isolated workspace…" : tool.detail
        }
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
        let attachments = currentAttachments
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        store.chatReplyDrafts[thread.id] = ""
        store.chatReplyAttachments[thread.id] = []
        Task {
            await store.sendChatMessage(threadId: thread.id, text: trimmed, attachments: attachments)
        }
    }
}

private struct DirectChatArtifactCard: View {
    @Bindable var store: WorkbenchStore
    let artifact: DirectChatArtifact
    let label: String
    let onOpen: () -> Void

    @State private var loadedImage: NSImage? = nil

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 5) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(ToolrollPalette.codeBg)
                    if let img = loadedImage {
                        Image(nsImage: img)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 156, height: 102)
                            .clipped()
                    } else if artifact.isImage {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "doc.text")
                            .font(.system(size: 22))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .frame(width: 156, height: 102)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                Text(label)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(width: 156, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .task(id: artifact.url) {
            guard artifact.isImage else { return }
            if let data = await store.loadDirectChatArtifactData(for: artifact),
               let img = NSImage(data: data) {
                loadedImage = img
            }
        }
    }
}

private struct DirectChatArtifactLightbox: View {
    @Bindable var store: WorkbenchStore
    let artifacts: [DirectChatArtifact]
    @Environment(\.dismiss) private var dismiss

    @State private var currentIndex: Int
    @State private var loadedImages: [String: NSImage] = [:]
    @FocusState private var galleryFocused: Bool

    init(store: WorkbenchStore, artifacts: [DirectChatArtifact], initialIndex: Int) {
        self.store = store
        self.artifacts = artifacts
        let clamped = max(0, min(initialIndex, max(0, artifacts.count - 1)))
        self._currentIndex = State(initialValue: clamped)
    }

    private var currentArtifact: DirectChatArtifact? {
        guard artifacts.indices.contains(currentIndex) else { return nil }
        return artifacts[currentIndex]
    }

    private var canGoPrevious: Bool { currentIndex > 0 }
    private var canGoNext: Bool { currentIndex + 1 < artifacts.count }

    private func labelFor(_ artifact: DirectChatArtifact, index: Int) -> String {
        if artifact.filename.hasPrefix("tool-capture-") {
            return "Screenshot \(index + 1)"
        }
        return artifact.filename
    }

    private func step(_ delta: Int) {
        let next = currentIndex + delta
        guard artifacts.indices.contains(next) else { return }
        withAnimation(.easeOut(duration: 0.14)) {
            currentIndex = next
        }
    }

    private func loadImage(for artifact: DirectChatArtifact) async {
        guard artifact.isImage, loadedImages[artifact.url] == nil else { return }
        if let data = await store.loadDirectChatArtifactData(for: artifact),
           let img = NSImage(data: data) {
            loadedImages[artifact.url] = img
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let artifact = currentArtifact {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text(labelFor(artifact, index: currentIndex))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.ink)
                            if artifacts.count > 1 {
                                Text("\(currentIndex + 1) / \(artifacts.count)")
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(ToolrollPalette.ground, in: Capsule())
                            }
                        }
                        if let src = artifact.sourcePath, !src.isEmpty {
                            Text(src)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                }

                Spacer()

                if artifacts.count > 1 {
                    HStack(spacing: 4) {
                        Button { step(-1) } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .semibold))
                                .frame(width: 26, height: 24)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(!canGoPrevious)
                        .help("Previous image (←)")

                        Button { step(1) } label: {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .frame(width: 26, height: 24)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(!canGoNext)
                        .help("Next image (→)")
                    }
                }

                Button("Close") { dismiss() }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(ToolrollPalette.raised)

            HairlineDivider()

            ZStack {
                ToolrollPalette.ground
                if let artifact = currentArtifact, let img = loadedImages[artifact.url] {
                    Image(nsImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .padding(.horizontal, artifacts.count > 1 ? 56 : 20)
                        .padding(.vertical, 18)
                        .id(artifact.id)
                } else {
                    ProgressView()
                }

                if artifacts.count > 1 {
                    HStack {
                        galleryEdgeArrow(systemName: "chevron.left", enabled: canGoPrevious) {
                            step(-1)
                        }
                        Spacer()
                        galleryEdgeArrow(systemName: "chevron.right", enabled: canGoNext) {
                            step(1)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if artifacts.count > 1 {
                HairlineDivider()
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(artifacts.enumerated()), id: \.element.id) { idx, item in
                                let selected = idx == currentIndex
                                Button {
                                    withAnimation(.easeOut(duration: 0.14)) {
                                        currentIndex = idx
                                    }
                                } label: {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .fill(ToolrollPalette.codeBg)
                                        if let thumb = loadedImages[item.url] {
                                            Image(nsImage: thumb)
                                                .resizable()
                                                .aspectRatio(contentMode: .fill)
                                                .frame(width: 72, height: 48)
                                                .clipped()
                                        } else {
                                            ProgressView().controlSize(.mini)
                                        }
                                    }
                                    .frame(width: 72, height: 48)
                                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .strokeBorder(
                                                selected ? ToolrollPalette.live : ToolrollPalette.line,
                                                lineWidth: selected ? 2 : 1
                                            )
                                    )
                                    .opacity(selected ? 1.0 : 0.68)
                                }
                                .buttonStyle(.plain)
                                .id(idx)
                                .task(id: item.url) {
                                    await loadImage(for: item)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }
                    .background(ToolrollPalette.raised)
                    .onChange(of: currentIndex) { _, newIdx in
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo(newIdx, anchor: .center)
                        }
                    }
                }
            }
        }
        .frame(width: 900, height: 640)
        .focusable()
        .focused($galleryFocused)
        .focusEffectDisabled()
        .onAppear {
            galleryFocused = true
        }
        .onKeyPress(.leftArrow) {
            if canGoPrevious { step(-1); return .handled }
            return .ignored
        }
        .onKeyPress(.rightArrow) {
            if canGoNext { step(1); return .handled }
            return .ignored
        }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .task(id: currentIndex) {
            if let cur = currentArtifact {
                await loadImage(for: cur)
            }
            if currentIndex + 1 < artifacts.count {
                await loadImage(for: artifacts[currentIndex + 1])
            }
            if currentIndex - 1 >= 0 {
                await loadImage(for: artifacts[currentIndex - 1])
            }
        }
    }

    private func galleryEdgeArrow(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(enabled ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.3))
                .frame(width: 34, height: 34)
                .background(ToolrollPalette.raised.opacity(enabled ? 0.9 : 0.4), in: Circle())
                .overlay(Circle().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
