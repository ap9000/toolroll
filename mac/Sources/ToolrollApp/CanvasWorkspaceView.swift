import AppKit
import SwiftUI
import ToolrollCore
import WebKit

/// Native SwiftUI + WKWebView Spatial UI Canvas (Toolroll's native port of `youiyoux`).
/// Infinite dot-grid pan/zoom, live interactive screen artboards, spatial Pin-to-Task & Options (A/B/C/D)
/// commentary (`youi.request/v1`), live SSE status halos on pins, and Before/After visual comparison scrub.
public struct CanvasWorkspaceView: View {
    @Bindable var store: WorkbenchStore

    // Camera state
    @State private var panOffset: CGSize = .zero
    @State private var dragStartPan: CGSize = .zero
    @State private var zoom: CGFloat = 0.85
    @State private var gestureBaseZoom: CGFloat = 0.85

    // Active tool & modals
    @State private var tool: CanvasTool = .select
    @State private var viewportPreset: CanvasViewportPreset = .desktop
    @State private var baseURLString: String = "http://127.0.0.1:4180"
    @State private var isAddingRoute: Bool = false
    @State private var newRouteDraft: String = "/"

    // Pin drafting / inspection
    @State private var draftPin: PendingPinDraft? = nil
    @State private var draftPinText: String = ""
    @State private var selectedPinId: String? = nil
    @State private var snapshotTick: Int = 0

    private struct PendingPinDraft: Equatable {
        let artboardId: String
        let route: String
        let path: String
        let xFrac: Double
        let yFrac: Double
        let kind: CanvasPinKind
    }

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            canvasControlStrip
            HairlineDivider()

            GeometryReader { geo in
                ZStack {
                    // Infinite Signal 1.0.0 dot grid
                    dotGridBackground(size: geo.size)
                        .gesture(
                            DragGesture()
                                .onChanged { value in
                                    panOffset = CGSize(
                                        width: dragStartPan.width + value.translation.width,
                                        height: dragStartPan.height + value.translation.height
                                    )
                                }
                                .onEnded { _ in
                                    dragStartPan = panOffset
                                }
                        )

                    // Artboard layer
                    ZStack(alignment: .topLeading) {
                        ForEach(store.canvasArtboards) { board in
                            artboardView(board)
                                .position(
                                    x: (board.x + board.width / 2) * zoom + panOffset.width,
                                    y: (board.y + board.height / 2) * zoom + panOffset.height
                                )
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

                    // Floating Bottom Tool Dock (Minimal Signal 1.0.0 Pill)
                    VStack {
                        Spacer()
                        floatingDock(canvasSize: geo.size)
                            .padding(.bottom, 18)
                    }
                }
                .clipped()
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in
                            zoom = min(2.0, max(0.3, gestureBaseZoom * value.magnification))
                        }
                        .onEnded { _ in
                            gestureBaseZoom = zoom
                        }
                )
            }
        }
        .background(ToolrollPalette.ground)
        .onAppear {
            if !store.activeProfile.origin.isEmpty && !store.activeProfile.isDemo {
                baseURLString = store.activeProfile.origin
            }
            store.loadCanvasForCurrentProject()
        }
        .onKeyPress("v") { tool = .select; return .handled }
        .onKeyPress("c") { tool = .pin; return .handled }
        .onKeyPress("o") { tool = .options; return .handled }
        .onKeyPress("d") { tool = .compare; return .handled }
        .onKeyPress(.escape) {
            draftPin = nil
            selectedPinId = nil
            tool = .select
            return .handled
        }
    }

    // MARK: - Top Control Strip

    private var canvasControlStrip: some View {
        HStack(spacing: 10) {
            // Live Base URL pill
            HStack(spacing: 6) {
                Image(systemName: "globe")
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("http://localhost:3000", text: $baseURLString)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 195)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

            // Desktop / Mobile viewport switcher
            HStack(spacing: 2) {
                ForEach(CanvasViewportPreset.allCases) { preset in
                    let active = viewportPreset == preset
                    Button {
                        viewportPreset = preset
                        store.arrangeCanvasArtboards(viewport: preset)
                    } label: {
                        Image(systemName: preset == .desktop ? "macwindow" : "iphone")
                            .font(.system(size: 11))
                            .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                    .help(preset.rawValue)
                }
            }
            .padding(2)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

            // Add Route button
            Button {
                isAddingRoute.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Screen")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .popover(isPresented: $isAddingRoute, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Add Screen Route")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    HStack(spacing: 6) {
                        TextField("/pricing", text: $newRouteDraft)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                            .frame(width: 170)
                            .onSubmit { addNewRoute() }
                        Button("Add") { addNewRoute() }
                            .buttonStyle(KitButtonStyle(.primary, compact: true))
                    }
                }
                .padding(12)
                .background(ToolrollPalette.paper)
            }

            Button {
                snapshotTick += 1
                store.notice = WorkbenchNotice(kind: .info, message: "Captured live snapshots for \(store.canvasArtboards.count) screen(s).")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "camera")
                        .font(.system(size: 10.5))
                    Text("Snapshot All")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))

            Spacer()

            // Quiet project UI progress summary
            HStack(spacing: 8) {
                Text("\(store.canvasArtboards.count) screens")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                if !store.canvasPins.isEmpty {
                    Text("· \(store.canvasPins.count) pin\(store.canvasPins.count == 1 ? "" : "s")")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(ToolrollPalette.ground)
    }

    private func addNewRoute() {
        let cleaned = newRouteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let path = cleaned.hasPrefix("/") ? cleaned : "/\(cleaned)"
        store.addCanvasArtboard(route: path, path: path, viewport: viewportPreset)
        newRouteDraft = "/"
        isAddingRoute = false
    }

    // MARK: - Infinite Dot Grid

    private func dotGridBackground(size: CGSize) -> some View {
        Canvas { context, canvasSize in
            let step = max(14.0, 24.0 * zoom)
            let ox = panOffset.width.truncatingRemainder(dividingBy: step)
            let oy = panOffset.height.truncatingRemainder(dividingBy: step)
            let dotColor = ToolrollPalette.line
            var y = oy
            while y < canvasSize.height {
                var x = ox
                while x < canvasSize.width {
                    context.fill(
                        Path(ellipseIn: CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)),
                        with: .color(dotColor)
                    )
                    x += step
                }
                y += step
            }
        }
        .frame(width: size.width, height: size.height)
        .background(ToolrollPalette.ground)
    }

    // MARK: - Artboard Card

    private func artboardView(_ board: CanvasArtboard) -> some View {
        let pinsForBoard = store.canvasPins.filter { $0.artboardPath == board.path || $0.artboardRoute == board.route }
        let scaledW = board.width * zoom
        let scaledH = board.height * zoom

        return VStack(alignment: .leading, spacing: 6) {
            // Draggable artboard header bar
            HStack(spacing: 6) {
                Text(board.route)
                    .font(.system(size: max(10, 11.5 * zoom), weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)

                if !pinsForBoard.isEmpty {
                    Text("\(pinsForBoard.count)")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(ToolrollPalette.ink, in: Capsule())
                }

                Spacer()

                Button {
                    store.toggleArtboardLive(id: board.id)
                } label: {
                    HStack(spacing: 3) {
                        Circle()
                            .fill(board.isLiveInteractive ? ToolrollPalette.success : ToolrollPalette.muted.opacity(0.5))
                            .frame(width: 5, height: 5)
                        Text(board.isLiveInteractive ? "Live" : "Snapshot")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .buttonStyle(.plain)
            }
            .frame(width: scaledW)
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { val in
                        store.moveCanvasArtboard(id: board.id, dx: val.translation.width / zoom, dy: val.translation.height / zoom)
                    }
            )

            // Artboard visual surface
            ZStack(alignment: .topLeading) {
                if tool == .compare,
                   let basePath = board.baselineImagePath,
                   let latestPath = board.latestImagePath,
                   let baseImg = NSImage(contentsOfFile: basePath),
                   let latestImg = NSImage(contentsOfFile: latestPath) {
                    beforeAfterScrubView(board: board, before: baseImg, after: latestImg, width: scaledW, height: scaledH)
                } else if board.isLiveInteractive || board.latestImagePath == nil {
                    LiveArtboardWebView(
                        urlString: resolvedURL(for: board.path),
                        snapshotTrigger: snapshotTick,
                        onSnapshotPNG: { pngData in
                            store.saveArtboardSnapshot(boardId: board.id, pngData: pngData)
                        }
                    )
                    .frame(width: scaledW, height: scaledH)
                    .allowsHitTesting(tool == .select && board.isLiveInteractive)
                } else if let imgPath = board.latestImagePath, let img = NSImage(contentsOfFile: imgPath) {
                    Image(nsImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: scaledW, height: scaledH)
                        .clipped()
                }

                // Transparent pin-drop overlay when Pin or Options tool is active
                if tool == .pin || tool == .options {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { location in
                            let xFrac = Double(location.x / max(1, scaledW))
                            let yFrac = Double(location.y / max(1, scaledH))
                            draftPin = PendingPinDraft(
                                artboardId: board.id,
                                route: board.route,
                                path: board.path,
                                xFrac: xFrac,
                                yFrac: yFrac,
                                kind: tool == .options ? .options : .change
                            )
                            draftPinText = ""
                            selectedPinId = nil
                        }
                }

                // Existing spatial pins with live SSE status halos
                ForEach(Array(pinsForBoard.enumerated()), id: \.element.id) { idx, pin in
                    pinMarker(pin: pin, index: idx + 1)
                        .position(x: pin.xFrac * scaledW, y: pin.yFrac * scaledH)
                }

                // Active draft pin marker + inline creation popover
                if let draft = draftPin, draft.artboardId == board.id {
                    Circle()
                        .fill(draft.kind == .options ? ToolrollPalette.live : ToolrollPalette.ink)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().strokeBorder(ToolrollPalette.paper, lineWidth: 2))
                        .position(x: draft.xFrac * scaledW, y: draft.yFrac * scaledH)
                        .popover(isPresented: Binding(
                            get: { draftPin?.artboardId == board.id },
                            set: { if !$0 { draftPin = nil } }
                        ), arrowEdge: .trailing) {
                            draftPinPopover(draft)
                        }
                }
            }
            .frame(width: scaledW, height: scaledH)
            .background(ToolrollPalette.paper)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(
                        (tool == .pin || tool == .options) ? ToolrollPalette.ink.opacity(0.45) : ToolrollPalette.line,
                        lineWidth: 1
                    )
            )
            .onTapGesture(count: 2) {
                store.toggleArtboardLive(id: board.id)
            }
        }
    }

    private func beforeAfterScrubView(board: CanvasArtboard, before: NSImage, after: NSImage, width: CGFloat, height: CGFloat) -> some View {
        let splitX = CGFloat(board.compareSplit) * width
        return ZStack(alignment: .topLeading) {
            Image(nsImage: after)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: width, height: height)
                .clipped()

            Image(nsImage: before)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: width, height: height)
                .clipped()
                .mask(
                    Rectangle()
                        .frame(width: max(0, splitX), height: height)
                        .frame(width: width, height: height, alignment: .leading)
                )

            // Vertical scrub hairline + handle
            Rectangle()
                .fill(ToolrollPalette.ink)
                .frame(width: 1.5, height: height)
                .offset(x: splitX)

            HStack {
                Text("BEFORE")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(ToolrollPalette.paper.opacity(0.88), in: RoundedRectangle(cornerRadius: 3))
                Spacer()
                Text("AFTER")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(ToolrollPalette.paper.opacity(0.88), in: RoundedRectangle(cornerRadius: 3))
            }
            .foregroundStyle(ToolrollPalette.ink)
            .padding(8)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { val in
                    let next = min(0.98, max(0.02, Double(val.location.x / max(1, width))))
                    store.setArtboardCompareSplit(id: board.id, split: next)
                }
        )
    }

    private func pinMarker(pin: CanvasPin, index: Int) -> some View {
        let statusTone = store.statusTone(forPin: pin)
        let fillColor: Color = {
            switch statusTone {
            case .needs: return ToolrollPalette.ink
            case .running: return ToolrollPalette.live
            case .finished: return ToolrollPalette.success
            case .failed: return ToolrollPalette.danger
            default: return pin.kind == .options ? ToolrollPalette.live : ToolrollPalette.ink
            }
        }()

        return Button {
            selectedPinId = (selectedPinId == pin.id) ? nil : pin.id
        } label: {
            Text(pin.kind == .options ? "O" : "\(index)")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(ToolrollPalette.inverseInk)
                .frame(width: 22, height: 22)
                .background(fillColor, in: Circle())
                .overlay(Circle().strokeBorder(ToolrollPalette.paper, lineWidth: 2))
        }
        .buttonStyle(.plain)
        .popover(isPresented: Binding(
            get: { selectedPinId == pin.id },
            set: { if !$0 { selectedPinId = nil } }
        ), arrowEdge: .trailing) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    StatusChip(tone: statusTone)
                    Text(pin.kind == .options ? "Options (A/B/C/D)" : pin.artboardRoute)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                }

                Text(pin.body)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    if let taskId = pin.linkedTaskId {
                        Button("Open Task →") {
                            selectedPinId = nil
                            store.workspaceMode = .workbench
                            Task { await store.selectTask(taskId) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    } else {
                        Button("Turn into Task") {
                            selectedPinId = nil
                            Task { await store.fileTaskFromCanvasPin(pin) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    }
                    Spacer()
                    Text("@\(pin.author)")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(14)
            .frame(width: 280)
            .background(ToolrollPalette.paper)
        }
    }

    private func draftPinPopover(_ draft: PendingPinDraft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(draft.kind == .options ? "Explore UI Options (A/B/C/D)" : "Pin Feedback → Task")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Text(draft.route)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            TextField(
                draft.kind == .options
                    ? "Ask agent for 2–4 visual options (e.g. tighter header layout)…"
                    : "Describe the UI change for Toolroll to build…",
                text: $draftPinText,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 12.5))
            .lineLimit(2...5)
            .padding(8)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

            HStack {
                Button("Comment only") {
                    commitDraftPin(draft, fileTaskImmediately: false)
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                .disabled(draftPinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Spacer()

                Button("File Task") {
                    commitDraftPin(draft, fileTaskImmediately: true)
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(draftPinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 310)
        .background(ToolrollPalette.paper)
    }

    private func commitDraftPin(_ draft: PendingPinDraft, fileTaskImmediately: Bool) {
        let body = draftPinText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        draftPin = nil
        draftPinText = ""
        Task {
            await store.createCanvasPin(
                route: draft.route,
                path: draft.path,
                xFrac: draft.xFrac,
                yFrac: draft.yFrac,
                kind: draft.kind,
                body: body,
                fileTask: fileTaskImmediately
            )
        }
    }

    // MARK: - Floating Bottom Pill Dock

    private func floatingDock(canvasSize: CGSize) -> some View {
        HStack(spacing: 4) {
            dockToolButton(.select, icon: "cursorarrow", key: "V")
            dockToolButton(.pin, icon: "mappin.and.ellipse", key: "C")
            dockToolButton(.options, icon: "square.grid.2x2", key: "O")
            dockToolButton(.compare, icon: "rectangle.lefthalf.inset.filled.arrow.left", key: "D")

            HairlineDivider(vertical: true).frame(height: 18).padding(.horizontal, 4)

            Button {
                store.arrangeCanvasArtboards(viewport: viewportPreset)
                panOffset = .zero
                dragStartPan = .zero
                zoom = 0.85
                gestureBaseZoom = 0.85
            } label: {
                Text("Arrange")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            .help("Arrange artboards in a clean grid")

            Button {
                zoom = max(0.35, zoom - 0.15)
                gestureBaseZoom = zoom
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)

            Button {
                zoom = 1.0
                gestureBaseZoom = 1.0
                panOffset = .zero
                dragStartPan = .zero
            } label: {
                Text("\(Int(zoom * 100))%")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 38)
            }
            .buttonStyle(.plain)
            .help("Reset Zoom (⌘0)")

            Button {
                zoom = min(2.0, zoom + 0.15)
                gestureBaseZoom = zoom
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(ToolrollPalette.paper, in: Capsule())
        .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
    }

    private func dockToolButton(_ t: CanvasTool, icon: String, key: String) -> some View {
        let active = tool == t
        return Button {
            tool = t
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                Text(t.rawValue)
                    .font(.system(size: 11.5, weight: active ? .semibold : .medium))
            }
            .foregroundStyle(active ? ToolrollPalette.inverseInk : ToolrollPalette.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(active ? ToolrollPalette.ink : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .help("\(t.rawValue) (\(key))")
    }

    private func resolvedURL(for path: String) -> String {
        let cleanBase = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
        return "\(cleanBase)\(cleanPath)"
    }
}

// MARK: - Live WKWebView Artboard Surface with Real PNG Snapshot Capture

private struct LiveArtboardWebView: NSViewRepresentable {
    let urlString: String
    let snapshotTrigger: Int
    let onSnapshotPNG: (Data) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSnapshotPNG: onSnapshotPNG)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
            context.coordinator.loadedURL = urlString
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onSnapshotPNG = onSnapshotPNG
        if context.coordinator.loadedURL != urlString, let url = URL(string: urlString) {
            context.coordinator.loadedURL = urlString
            webView.load(URLRequest(url: url))
        }
        if context.coordinator.lastSnapshotTrigger != snapshotTrigger {
            context.coordinator.lastSnapshotTrigger = snapshotTrigger
            context.coordinator.captureSnapshot(webView: webView)
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: String = ""
        var lastSnapshotTrigger: Int = 0
        var onSnapshotPNG: (Data) -> Void

        init(onSnapshotPNG: @escaping (Data) -> Void) {
            self.onSnapshotPNG = onSnapshotPNG
        }

        func captureSnapshot(webView: WKWebView) {
            let config = WKSnapshotConfiguration()
            webView.takeSnapshot(with: config) { [weak self] image, _ in
                guard let image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:])
                else { return }
                self?.onSnapshotPNG(png)
            }
        }
    }
}
