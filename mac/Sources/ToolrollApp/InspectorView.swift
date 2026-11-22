import AppKit
import SwiftUI
import ToolrollCore

/// Right collapsible Inspector (Terminal | Diff | Lead).
public struct InspectorView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Segmented tab bar — single-line tabs with crisp hover states
            HStack(spacing: 3) {
                ForEach(InspectorTab.allCases) { tab in
                    let active = store.inspectorTab == tab
                    Button {
                        store.inspectorTab = tab
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: icon(for: tab))
                                .font(.system(size: 10.5))
                            Text(tab.rawValue)
                                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .toolrollHoverSurface(cornerRadius: 4, isSelected: active)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 4)
                Button {
                    store.isInspectorVisible = false
                } label: {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 12))
                }
                .buttonStyle(ToolrollIconButtonStyle(size: 26))
                .help("Hide Inspector (⌘J)")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(ToolrollPalette.ground)

            HairlineDivider()

            switch store.inspectorTab {
            case .artifact:
                ArtifactPaneView(store: store)
            case .terminal:
                LiveTerminalPaneView(store: store, session: store.terminalSession)
            case .diff:
                DiffInspectorView(store: store)
            case .lead:
                LeadThreadView(store: store)
            }
        }
        .background(ToolrollPalette.paper)
    }

    private func icon(for tab: InspectorTab) -> String {
        switch tab {
        case .artifact: return "doc.richtext"
        case .terminal: return "terminal"
        case .diff: return "doc.text.magnifyingglass"
        case .lead: return "text.bubble"
        }
    }
}

// MARK: - Live Terminal Pane (WebSocket PTY + Lease Controls + AppKit Key Capture)

struct LiveTerminalPaneView: View {
    @Bindable var store: WorkbenchStore
    @Bindable var session: LiveTerminalSession
    var inMainPane: Bool = false
    @State private var selectedProgram: String = "shell"

    private let programs = ["shell", "claude", "codex", "antigravity"]

    var body: some View {
        VStack(spacing: 0) {
            leaseControlBar
            HairlineDivider()

            if let note = session.statusNote {
                HStack(spacing: 6) {
                    Circle()
                        .fill(session.takeoverArmed ? ToolrollPalette.warning : ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(note)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.ink)
                    Spacer()
                    if session.takeoverArmed {
                        Button("Confirm Takeover") {
                            _ = session.requestTakeControl()
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))

                        Button("Cancel") {
                            session.cancelTakeoverArm()
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(ToolrollPalette.raised)
                HairlineDivider()
            }

            if session.connectionState == .idle {
                detachedPlaceholder
            } else {
                terminalCanvas
            }
        }
    }

    private var leaseControlBar: some View {
        HStack(spacing: 8) {
            // Lease status pill
            HStack(spacing: 5) {
                Circle()
                    .fill(leaseDotColor)
                    .frame(width: 6, height: 6)
                Text(leaseSummary)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
            }

            Spacer()

            if session.connectionState == .connected {
                if session.isControlling {
                    Button("Release") {
                        session.releaseControl()
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                } else if session.takeoverArmed {
                    Button("Confirm Takeover") {
                        _ = session.requestTakeControl()
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                } else {
                    Button(session.requiresTakeoverConfirm ? "Take Over" : "Take Control") {
                        _ = session.requestTakeControl()
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
            }

            // Program launcher menu
            if let taskId = store.selectedTaskId {
                Menu {
                    ForEach(programs, id: \.self) { prog in
                        Button("Attach / Start \(prog)") {
                            selectedProgram = prog
                            Task { await store.attachOrStartTerminal(taskId: taskId, program: prog, openDrawer: !inMainPane) }
                        }
                    }
                    if session.connectionState != .idle {
                        Divider()
                        Button("Detach Terminal") {
                            session.disconnect(clearOutput: true)
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(session.terminalId == nil ? selectedProgram : session.program)
                            .font(.system(size: 11, design: .monospaced))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                    }
                    .foregroundStyle(ToolrollPalette.ink)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3.5)
                    .toolrollHoverSurface(cornerRadius: 4)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised)
    }

    private var leaseDotColor: Color {
        switch session.connectionState {
        case .idle: return ToolrollPalette.muted
        case .connecting: return ToolrollPalette.live
        case .connected: return session.isControlling ? ToolrollPalette.success : ToolrollPalette.live
        case .exited: return ToolrollPalette.muted
        case .disconnected: return ToolrollPalette.danger
        }
    }

    private var leaseSummary: String {
        switch session.connectionState {
        case .idle:
            return "Detached"
        case .connecting:
            return "Connecting…"
        case .exited(let code, _):
            return "Exited (\(code.map(String.init) ?? "0"))"
        case .disconnected:
            return "Disconnected"
        case .connected:
            let progLabel = session.program == "shell" ? "Worktree Shell" : "Worktree \(session.program.capitalized)"
            if session.isControlling {
                let obs = session.otherViewersCount
                return obs > 0 ? "\(progLabel) · Controlling · \(obs) observing" : "\(progLabel) · Controlling"
            }
            if let ctrl = session.controller, !ctrl.isEmpty {
                return "\(progLabel) · Observing · @\(ctrl)"
            }
            return "\(progLabel) · Observing"
        }
    }

    private var terminalCanvas: some View {
        ZStack(alignment: .topLeading) {
            ToolrollPalette.codeBg

            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if session.renderLines.isEmpty {
                            HStack(spacing: 6) {
                                Text("Waiting for shell output…")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                Text("▋")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.live)
                            }
                        } else {
                            let lastId = session.renderLines.last?.id
                            ForEach(session.renderLines) { line in
                                HStack(spacing: 0) {
                                    attributedText(for: line)
                                        .font(.system(size: 12.5, design: .monospaced))
                                        .textSelection(.enabled)
                                    if session.connectionState == .connected && line.id == lastId {
                                        Text("▋")
                                            .font(.system(size: 12.5, design: .monospaced))
                                            .foregroundStyle(session.isControlling ? ToolrollPalette.ink.opacity(0.85) : ToolrollPalette.muted.opacity(0.5))
                                    }
                                }
                                .id(line.id)
                            }
                        }
                        Color.clear.frame(height: 12).id("terminal-bottom")
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: session.renderLines.count) { _, _ in
                    proxy.scrollTo("terminal-bottom", anchor: .bottom)
                }
            }

            // Invisible AppKit key-event responder auto-focuses and captures terminal typing cleanly
            TerminalKeyCaptureView(
                onInput: { input in
                    session.sendInput(input)
                },
                onResize: { cols, rows in
                    session.resize(cols: cols, rows: rows)
                }
            )
        }
    }

    private func attributedText(for line: TerminalRenderLine) -> Text {
        var result = AttributedString()
        for run in line.runs {
            var part = AttributedString(run.text)
            let fg = Color.fromTerminal(run.style.inverse ? run.style.background : run.style.foreground, isForeground: true)
            let bg = Color.fromTerminal(run.style.inverse ? run.style.foreground : run.style.background, isForeground: false)
            part.foregroundColor = run.style.dim ? fg.opacity(0.6) : fg
            if bg != .clear {
                part.backgroundColor = bg
            }
            if run.style.bold {
                part.inlinePresentationIntent = .stronglyEmphasized
            }
            result.append(part)
        }
        return Text(result)
    }

    private var detachedPlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 22))
                .foregroundStyle(ToolrollPalette.muted)
            Text("No Live Terminal attached")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Attach or start a central PTY on the selected task. Multiple teammates can observe in real time with 1-step lease takeover.")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)

            if let taskId = store.selectedTaskId {
                HStack(spacing: 8) {
                    Button("Attach Shell") {
                        Task { await store.attachOrStartTerminal(taskId: taskId, program: "shell", openDrawer: !inMainPane) }
                    }
                    .buttonStyle(KitButtonStyle(.primary))

                    Button("Attach Claude") {
                        Task { await store.attachOrStartTerminal(taskId: taskId, program: "claude", openDrawer: !inMainPane) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
        .background(ToolrollPalette.codeBg)
    }
}

// MARK: - AppKit Native Key Capture Surface (TerminalSurfaceProtocol input bridge)

private struct TerminalKeyCaptureView: NSViewRepresentable {
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    func makeNSView(context: Context) -> KeyCaptureNSView {
        let view = KeyCaptureNSView()
        view.onInput = onInput
        view.onResize = onResize
        return view
    }

    func updateNSView(_ nsView: KeyCaptureNSView, context: Context) {
        nsView.onInput = onInput
        nsView.onResize = onResize
    }

    final class KeyCaptureNSView: NSView {
        var onInput: ((String) -> Void)?
        var onResize: ((Int, Int) -> Void)?
        private var lastCols: Int = 0
        private var lastRows: Int = 0

        override var acceptsFirstResponder: Bool { true }
        override var isOpaque: Bool { false }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil {
                DispatchQueue.main.async { [weak self] in
                    guard let self, let win = self.window else { return }
                    if !(win.firstResponder is NSTextView) {
                        win.makeFirstResponder(self)
                    }
                }
            }
        }

        override func mouseDown(with event: NSEvent) {
            window?.makeFirstResponder(self)
        }

        override func layout() {
            super.layout()
            guard bounds.width > 40, bounds.height > 40 else { return }
            let charWidth: CGFloat = 7.5
            let lineHeight: CGFloat = 17.0
            let cols = max(40, Int((bounds.width - 28) / charWidth))
            let rows = max(12, Int((bounds.height - 28) / lineHeight))
            if cols != lastCols || rows != lastRows {
                lastCols = cols
                lastRows = rows
                DispatchQueue.main.async { [weak self] in
                    self?.onResize?(cols, rows)
                }
            }
        }

        override func keyDown(with event: NSEvent) {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            // Let Command shortcuts (⌘K, ⌘J, ⌘R, ⌘C) bubble up except ⌘V paste
            if flags.contains(.command) {
                if event.charactersIgnoringModifiers?.lowercased() == "v",
                   let str = NSPasteboard.general.string(forType: .string) {
                    onInput?(str)
                    return
                }
                super.keyDown(with: event)
                return
            }

            if flags.contains(.control), let ch = event.charactersIgnoringModifiers?.lowercased().unicodeScalars.first {
                let code = ch.value
                if code >= 97 && code <= 122 { // Ctrl+A..Z
                    let ctrl = UnicodeScalar(code - 96)!
                    onInput?(String(ctrl))
                    return
                }
            }

            switch event.keyCode {
            case 36, 76: onInput?("\r")      // Return / Enter
            case 51:     onInput?("\u{7F}")  // Backspace
            case 48:     onInput?("\t")      // Tab
            case 53:     onInput?("\u{1B}")  // Escape
            case 126:    onInput?("\u{1B}[A") // Up
            case 125:    onInput?("\u{1B}[B") // Down
            case 124:    onInput?("\u{1B}[C") // Right
            case 123:    onInput?("\u{1B}[D") // Left
            default:
                if let chars = event.characters, !chars.isEmpty {
                    onInput?(chars)
                }
            }
        }
    }
}

// MARK: - Diff Inspector

private struct DiffInspectorView: View {
    @Bindable var store: WorkbenchStore
    @State private var commentingLine: Int? = nil
    @State private var commentDraft: String = ""

    var body: some View {
        VStack(spacing: 0) {
            if let diff = store.diffResponse, !diff.files.isEmpty {
                // Summary bar
                HStack(spacing: 8) {
                    if let totals = diff.totals {
                        Text("\(totals.files) files")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text("+\(totals.added)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.success)
                        Text("-\(totals.removed)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.danger)
                    }
                    Spacer()
                    if let run = diff.run {
                        Text("Run #\(run)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(ToolrollPalette.raised)

                HairlineDivider()

                // File picker chips
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(diff.files) { file in
                            let selected = store.selectedDiffPath == file.path
                            Button {
                                Task { await store.selectDiffFile(path: file.path) }
                            } label: {
                                HStack(spacing: 5) {
                                    Text((file.path as NSString).lastPathComponent)
                                        .font(.system(size: 11, weight: selected ? .semibold : .regular, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink)
                                    if let a = file.added, a > 0 {
                                        Text("+\(a)")
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.success)
                                    }
                                    if let r = file.removed, r > 0 {
                                        Text("-\(r)")
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.danger)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .toolrollHoverSurface(cornerRadius: 4, isSelected: selected)
                                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(selected ? ToolrollPalette.ink.opacity(0.4) : ToolrollPalette.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                }
                .background(ToolrollPalette.ground)

                HairlineDivider()

                // Hunks
                GeometryReader { geo in
                    ScrollView([.vertical, .horizontal]) {
                        VStack(alignment: .leading, spacing: 12) {
                            if let file = store.selectedDiffFile {
                                Text(file.path)
                                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .padding(.horizontal, 12)
                                    .padding(.top, 10)

                                ForEach(file.hunks) { hunk in
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(hunk.header)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.muted)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 5)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .background(ToolrollPalette.raised)

                                        ForEach(hunk.lines) { line in
                                            diffLineRow(line, filePath: file.path)
                                        }
                                    }
                                    .overlay(
                                        Rectangle()
                                            .strokeBorder(ToolrollPalette.line, lineWidth: 0.5)
                                    )
                                }
                            }
                        }
                        .frame(minWidth: geo.size.width, alignment: .leading)
                        .padding(.bottom, 16)
                    }
                    .background(ToolrollPalette.codeBg)
                }
            } else {
                VStack(spacing: 8) {
                    Text("No diff recorded for this task yet.")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text("Promote a Candidate or wait for the active Run to finish.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ToolrollPalette.codeBg)
            }
        }
    }

    private func diffLineRow(_ line: DiffLine, filePath: String) -> some View {
        let targetLine = line.newLine ?? line.oldLine
        let existingComments = targetLine.map { ln in
            store.inlineDiffComments.filter { $0.path == filePath && $0.line == ln }
        } ?? []

        return DiffLineRowView(
            line: line,
            isCommenting: targetLine != nil && commentingLine == targetLine,
            commentDraft: $commentDraft,
            existingComments: existingComments,
            onToggleComment: {
                guard let ln = targetLine else { return }
                commentingLine = (commentingLine == ln) ? nil : ln
                commentDraft = ""
            },
            onSaveComment: { text in
                guard let ln = targetLine else { return }
                commentDraft = ""
                commentingLine = nil
                Task { await store.addInlineDiffComment(path: filePath, line: ln, text: text) }
            }
        )
    }
}

private struct DiffLineRowView: View {
    let line: DiffLine
    let isCommenting: Bool
    @Binding var commentDraft: String
    let existingComments: [InlineDiffComment]
    let onToggleComment: () -> Void
    let onSaveComment: (String) -> Void
    @State private var isHovered: Bool = false

    var body: some View {
        let isAdd = line.isAddition
        let isDel = line.isDeletion
        let isMeta = line.isMeta
        let prefix = isAdd ? "+" : (isDel ? "-" : " ")
        let rowBg: Color = isAdd
            ? ToolrollPalette.success.opacity(0.14)
            : (isDel ? ToolrollPalette.danger.opacity(0.14) : (isHovered ? ToolrollPalette.raised.opacity(0.55) : .clear))
        let stripeColor: Color = isAdd
            ? ToolrollPalette.success
            : (isDel ? ToolrollPalette.danger : .clear)
        let gutterFg: Color = isAdd
            ? ToolrollPalette.success.opacity(0.8)
            : (isDel ? ToolrollPalette.danger.opacity(0.8) : ToolrollPalette.muted.opacity(0.75))
        let signFg: Color = isAdd
            ? ToolrollPalette.success
            : (isDel ? ToolrollPalette.danger : ToolrollPalette.muted.opacity(0.45))
        let codeFg: Color = isAdd
            ? ToolrollPalette.success
            : (isDel ? ToolrollPalette.danger : (isMeta ? ToolrollPalette.muted : ToolrollPalette.ink.opacity(0.88)))
        let targetLine = line.newLine ?? line.oldLine

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                // Crisp 2.5pt left status bar
                Rectangle()
                    .fill(stripeColor)
                    .frame(width: 2.5)

                // Hover-revealed inline comment trigger in the left gutter (never clips on wide lines)
                Group {
                    if let ln = targetLine, isHovered || isCommenting || !existingComments.isEmpty {
                        Button(action: onToggleComment) {
                            Image(systemName: existingComments.isEmpty ? "plus" : "text.bubble.fill")
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(isCommenting || !existingComments.isEmpty ? ToolrollPalette.live : ToolrollPalette.ink)
                                .frame(width: 16, height: 16)
                                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 0.75))
                        }
                        .buttonStyle(.plain)
                        .help("Comment on line \(ln)")
                    } else {
                        Color.clear.frame(width: 16, height: 16)
                    }
                }
                .padding(.leading, 4)

                Text(line.oldLine.map(String.init) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(gutterFg)
                    .frame(width: 30, alignment: .trailing)

                Text(line.newLine.map(String.init) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(gutterFg)
                    .frame(width: 30, alignment: .trailing)
                    .padding(.leading, 4)

                Text(prefix)
                    .font(.system(size: 11.5, weight: (isAdd || isDel) ? .bold : .regular, design: .monospaced))
                    .foregroundStyle(signFg)
                    .frame(width: 14, alignment: .center)
                    .padding(.leading, 4)

                Text(line.text)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(codeFg)
                    .fixedSize(horizontal: true, vertical: false)
                    .textSelection(.enabled)

                Spacer(minLength: 16)
            }
            .padding(.trailing, 10)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rowBg)
            .onHover { isHovered = $0 }

            if let ln = targetLine, isCommenting {
                HStack(spacing: 6) {
                    Text("L\(ln)")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                    TextField("Add inline review note…", text: $commentDraft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.ink)
                        .onSubmit {
                            let trimmed = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty { onSaveComment(commentDraft) }
                        }
                    Button("Save") {
                        onSaveComment(commentDraft)
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(commentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(ToolrollPalette.raised)
            }

            ForEach(existingComments) { note in
                HStack(spacing: 6) {
                    Image(systemName: "text.bubble.fill")
                        .font(.system(size: 9.5))
                        .foregroundStyle(ToolrollPalette.live)
                    Text("L\(note.line): \(note.text)")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.ink)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(ToolrollPalette.raised)
            }
        }
    }
}

// MARK: - Lead Thread Inspector

private struct LeadThreadView: View {
    @Bindable var store: WorkbenchStore
    @State private var draft: String = ""
    @State private var attachments: [ComposerAttachment] = []
    @State private var isDropTargeted: Bool = false
    @FocusState private var draftFocused: Bool

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(store.leadChat.leadName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                if store.leadChat.busy {
                    Circle().fill(ToolrollPalette.live).frame(width: 6, height: 6)
                    Text("Thinking")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(ToolrollPalette.raised)

            HairlineDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(store.leadChat.messages) { msg in
                        let isUser = msg.role == "user"
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(isUser ? "You" : store.leadChat.leadName)
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(ToolrollPalette.muted)
                                Spacer()
                                if let at = msg.at {
                                    Text(at)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.muted)
                                }
                            }
                            Text(msg.text)
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.ink)
                                .textSelection(.enabled)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(isUser ? ToolrollPalette.raised : ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                }
                .padding(12)
            }

            HairlineDivider()

            VStack(alignment: .leading, spacing: 8) {
                if !attachments.isEmpty {
                    ComposerAttachmentStrip(attachments: attachments) { removedId in
                        attachments.removeAll { $0.id == removedId }
                    }
                }

                HStack(spacing: 8) {
                    ComposerAttachMenuButton(
                        compact: true,
                        onAddAttachments: { incoming in
                            appendUniqueAttachments(incoming, to: &attachments)
                        },
                        onNoClipboardImage: {
                            store.notice = WorkbenchNotice(kind: .info, message: "No image found on the clipboard — copy a screenshot (⌘⌃⇧4) or image first.")
                        }
                    )

                    TextField("Ask Lead or paste screenshot…", text: $draft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12.5))
                        .foregroundStyle(ToolrollPalette.ink)
                        .focused($draftFocused)
                        .onSubmit { send() }

                    Button("Send") { send() }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                        .disabled(!canSend)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(ToolrollPalette.composer, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(
                        isDropTargeted ? ToolrollPalette.live : ToolrollPalette.inputLine,
                        lineWidth: isDropTargeted ? 1.5 : 1
                    )
            )
            .onComposerPaste(isActive: draftFocused) { incoming in
                appendUniqueAttachments(incoming, to: &attachments)
            }
            .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isDropTargeted) { providers in
                ComposerDropHelper.handleDrop(providers: providers) { incoming in
                    appendUniqueAttachments(incoming, to: &attachments)
                }
            }
            .padding(10)
        }
    }

    private func send() {
        guard canSend else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: draft, attachments: attachments)
        draft = ""
        attachments = []
        Task { await store.sendLeadMessage(composed.combinedMessage) }
    }
}
