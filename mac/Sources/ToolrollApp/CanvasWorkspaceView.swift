import AppKit
import SwiftUI
import ToolrollCore
import WebKit

/// Native SwiftUI + WKWebView Spatial UI Canvas (v1.5):
/// - Project-aware route auto-discovery (`.youi/screens`, TanStack, Next, Astro/Vite)
/// - Disk-backed content-addressed tile cache (`~/.cache/toolroll/canvas`) -> 0% idle CPU & 0 MB dev-server RAM
/// - Single managed preview server with lazy wake + 5-min idle sleep
/// - True 1440×900 (Desktop) / 390×844 (Mobile) logical viewport scaled cleanly into each artboard card
/// - Auto-injected local Toolroll session cookie (zero login screens)
/// - Read-only DOM element hover highlighter (`WKUserScript`) in Pin/Options mode
/// - Draft-batch pin review (`Per screen` | `Single task` | `Per pin`) + instant `⌘↵` filing
public struct CanvasWorkspaceView: View {
    @Bindable var store: WorkbenchStore

    // Camera state
    @State private var panOffset: CGSize = .zero
    @State private var dragStartPan: CGSize = .zero
    @State private var zoom: CGFloat = 0.85
    @State private var gestureBaseZoom: CGFloat = 0.85

    // Tools & UI popovers
    @State private var tool: CanvasTool = .select
    @State private var isAddingRoute: Bool = false
    @State private var newRouteDraft: String = "/"
    @State private var isSubmitBatchOpen: Bool = false
    @State private var batchGrouping: PinBatchGrouping = .perScreen

    // Pin drafting & inspection
    @State private var draftPin: PendingPinDraft? = nil
    @State private var draftPinText: String = ""
    @State private var selectedPinId: String? = nil
    @State private var focusedArtboardId: String? = nil

    private struct PendingPinDraft: Equatable {
        let artboardId: String
        let route: String
        let path: String
        let xFrac: Double
        let yFrac: Double
        let kind: CanvasPinKind
        let elementName: String?
        let elementSelector: String?
        let elementFile: String?
        let elementLine: Int?
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

                    // Artboards
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

                    // Floating Bottom Dock
                    VStack {
                        Spacer()
                        floatingDock()
                            .padding(.bottom, 18)
                    }

                    // Studio Screen Focus Lightbox (zoomable high-res view + edit/task creation side rail)
                    if let focusId = focusedArtboardId,
                       let focusBoard = store.canvasArtboards.first(where: { $0.id == focusId }) {
                        ScreenFocusLightboxView(
                            store: store,
                            board: focusBoard,
                            onClose: { focusedArtboardId = nil },
                            onSelectBoard: { nextId in focusedArtboardId = nextId }
                        )
                        .transition(.opacity)
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
        .task(id: "\(store.selectedProject ?? "")::\(store.selectedRow?.project ?? "")") {
            await store.loadCanvasForCurrentProject()
        }
        .onKeyPress("v") { tool = .select; return .handled }
        .onKeyPress("c") { tool = .pin; return .handled }
        .onKeyPress("o") { tool = .options; return .handled }
        .onKeyPress("d") { tool = .compare; return .handled }
        .onKeyPress(.escape) {
            if focusedArtboardId != nil {
                focusedArtboardId = nil
                return .handled
            }
            draftPin = nil
            selectedPinId = nil
            tool = .select
            return .handled
        }
    }

    // MARK: - Top Control Strip

    private var canvasControlStrip: some View {
        HStack(spacing: 10) {
            // Project switcher directly on Canvas
            Menu {
                ForEach(store.allProjects, id: \.self) { proj in
                    Button {
                        store.selectedProject = proj
                    } label: {
                        HStack {
                            Text(proj)
                            if store.canvasProjectName == proj { Image(systemName: "checkmark") }
                        }
                    }
                }
                Divider()
                Button("Add Project…") { store.isAddProjectSheetOpen = true }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "folder")
                        .font(.system(size: 10.5))
                    Text(store.canvasProjectName.isEmpty ? "Project" : store.canvasProjectName)
                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                }
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            // Preview server status pill (Cached 0 MB | Starting | Live with 1-click Sleep)
            previewServerPill

            // Desktop (1440×900) / Mobile (390×844) switcher
            HStack(spacing: 2) {
                ForEach(CanvasViewportPreset.allCases) { preset in
                    let active = store.canvasViewport == preset
                    Button {
                        store.arrangeCanvasArtboards(viewport: preset)
                    } label: {
                        Image(systemName: preset == .desktop ? "macwindow" : "iphone")
                            .font(.system(size: 11))
                            .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("\(preset.rawValue) (\(Int(preset.logicalWidth))×\(Int(preset.logicalHeight)))")
                }
            }
            .padding(2)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

            // + Screen popover (shows remaining auto-discovered routes + custom path input)
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
                addScreenPopover
            }

            Button {
                Task { await store.loadCanvasForCurrentProject(forceRefresh: true) }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
            .help("Re-capture screens from latest code")

            Spacer()

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

    private var previewServerPill: some View {
        HStack(spacing: 6) {
            switch store.previewServer.status {
            case .asleep:
                Circle().fill(ToolrollPalette.muted).frame(width: 6, height: 6)
                Text("Cached · 0 MB")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Button("Wake") {
                    Task { await store.wakePreviewServerAndHydrate(forceAll: false) }
                }
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(ToolrollPalette.ink)
                .buttonStyle(.plain)

            case .starting(let cmd):
                Circle().fill(ToolrollPalette.live).frame(width: 6, height: 6)
                Text("Starting \(cmd)…")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)

            case .running(let url, _):
                Circle().fill(ToolrollPalette.success).frame(width: 6, height: 6)
                Text(url.replacingOccurrences(of: "http://", with: ""))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                Button("Sleep") {
                    store.sleepPreviewServer()
                }
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(ToolrollPalette.muted)
                .buttonStyle(.plain)

            case .external(let url):
                Circle().fill(ToolrollPalette.success).frame(width: 6, height: 6)
                Text(url.replacingOccurrences(of: "http://", with: ""))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)

            case .failed(let msg):
                Circle().fill(ToolrollPalette.danger).frame(width: 6, height: 6)
                Text(msg)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.danger)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private var addScreenPopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add Screen")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)

            HStack(spacing: 6) {
                TextField("/pricing", text: $newRouteDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                    .frame(width: 175)
                    .onSubmit { addCustomRoute() }
                Button("Add") { addCustomRoute() }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
            }

            if !store.remainingDiscoveredRoutes.isEmpty {
                HairlineDivider()
                Text("DISCOVERED IN REPO")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(store.remainingDiscoveredRoutes.prefix(12)) { entry in
                            Button {
                                store.addCanvasArtboard(route: entry.route, path: entry.path, sourceFile: entry.sourceFile, viewport: store.canvasViewport)
                                isAddingRoute = false
                            } label: {
                                HStack {
                                    Text(entry.route)
                                        .font(.system(size: 11.5, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink)
                                    Spacer()
                                    if let f = entry.sourceFile {
                                        Text((f as NSString).lastPathComponent)
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.muted)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 170)
            }
        }
        .padding(12)
        .frame(width: 260)
        .background(ToolrollPalette.paper)
    }

    private func addCustomRoute() {
        let cleaned = newRouteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let path = cleaned.hasPrefix("/") ? cleaned : "/\(cleaned)"
        store.addCanvasArtboard(route: path, path: path, viewport: store.canvasViewport)
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

    // MARK: - Artboard Card (True 1440×900 / 390×844 Scaled Rendering + Hybrid Tile Cache)

    private func artboardView(_ board: CanvasArtboard) -> some View {
        let pinsForBoard = store.canvasPins.filter { $0.artboardPath == board.path || $0.artboardRoute == board.route }
        let scaledW = board.width * zoom
        let scaledH = board.height * zoom
        let needsWebView = board.isLiveInteractive || board.isHydrating
        let inspectorOn = board.isLiveInteractive && (tool == .pin || tool == .options)

        return VStack(alignment: .leading, spacing: 6) {
            // Draggable artboard title bar
            HStack(spacing: 6) {
                Text(board.route)
                    .font(.system(size: max(10, 11.5 * zoom), weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)

                if let src = board.sourceFile {
                    Text((src as NSString).lastPathComponent)
                        .font(.system(size: max(9, 10 * zoom), design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
                        .lineLimit(1)
                }

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
                    HStack(spacing: 4) {
                        Circle()
                            .fill(board.isLiveInteractive ? ToolrollPalette.success : (board.isHydrating ? ToolrollPalette.live : ToolrollPalette.muted.opacity(0.5)))
                            .frame(width: 5, height: 5)
                        Text(board.isLiveInteractive ? "Live" : (board.isHydrating ? "Rendering…" : "Cached"))
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

            // Visual surface
            ZStack(alignment: .topLeading) {
                if tool == .compare,
                   let basePath = board.baselineImagePath,
                   let latestPath = board.latestImagePath,
                   let baseImg = CanvasImageCache.shared.image(atPath: basePath, maxPixelDimension: 1080),
                   let latestImg = CanvasImageCache.shared.image(atPath: latestPath, maxPixelDimension: 1080) {
                    beforeAfterScrubView(board: board, before: baseImg, after: latestImg, width: scaledW, height: scaledH)
                } else if needsWebView && !store.canvasBaseURL.isEmpty {
                    // Render at TRUE logical viewport (1440×900 or 390×844), GPU-scaled smoothly into box!
                    let logW = store.canvasViewport.logicalWidth
                    let logH = store.canvasViewport.logicalHeight
                    let scale = scaledW / logW

                    ScaledLiveArtboardWebView(
                        urlString: resolvedURL(for: board.path),
                        logicalWidth: logW,
                        logicalHeight: logH,
                        sessionCookie: store.localSessionCookie,
                        autoCaptureOnLoad: board.isHydrating,
                        inspectorEnabled: inspectorOn,
                        onSnapshotPNG: { pngData in
                            store.saveArtboardSnapshot(boardId: board.id, pngData: pngData)
                        },
                        onInspectClick: { hit in
                            draftPin = PendingPinDraft(
                                artboardId: board.id,
                                route: board.route,
                                path: board.path,
                                xFrac: hit.xFrac,
                                yFrac: hit.yFrac,
                                kind: tool == .options ? .options : .change,
                                elementName: hit.elementName,
                                elementSelector: hit.selector,
                                elementFile: hit.file ?? board.sourceFile,
                                elementLine: hit.line
                            )
                            draftPinText = ""
                            selectedPinId = nil
                        }
                    )
                    .frame(width: logW, height: logH)
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: scaledW, height: scaledH, alignment: .topLeading)
                    .clipped()
                    .allowsHitTesting(board.isLiveInteractive)
                } else if let imgPath = board.latestImagePath, let img = CanvasImageCache.shared.image(atPath: imgPath, maxPixelDimension: 1080) {
                    Image(nsImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: scaledW, height: scaledH)
                        .clipped()
                } else {
                    // Clean minimal placeholder while queued for pooled hydration
                    VStack(spacing: 6) {
                        Text(board.route)
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text(store.canvasBaseURL.isEmpty ? "Click Wake to render live preview" : "Queued for capture…")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .frame(width: scaledW, height: scaledH)
                    .background(ToolrollPalette.codeBg)
                }

                // Static-tile pin-drop overlay when Pin or Options is active on a cached tile
                if (tool == .pin || tool == .options) && !inspectorOn {
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
                                kind: tool == .options ? .options : .change,
                                elementName: nil,
                                elementSelector: nil,
                                elementFile: board.sourceFile,
                                elementLine: nil
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

                // Active draft pin popover
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
                        board.isLiveInteractive ? ToolrollPalette.live.opacity(0.6) : ((tool == .pin || tool == .options) ? ToolrollPalette.ink.opacity(0.45) : ToolrollPalette.line),
                        lineWidth: 1
                    )
            )
            .onTapGesture {
                if tool == .select {
                    withAnimation(.easeInOut(duration: 0.14)) {
                        focusedArtboardId = board.id
                    }
                }
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

            Rectangle()
                .fill(ToolrollPalette.ink)
                .frame(width: 1.5, height: height)
                .offset(x: splitX)

            HStack {
                Text("BEFORE · \(store.canvasBaselineKey.prefix(7))")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(ToolrollPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 3))
                Spacer()
                Text("AFTER · \(store.canvasStateKey.prefix(7))")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(ToolrollPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 3))
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
            if pin.isDraft { return ToolrollPalette.warning }
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
                    StatusChip(tone: statusTone, label: pin.isDraft ? "Draft pin" : nil)
                    Text(pin.elementName ?? pin.artboardRoute)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                    Spacer()
                }

                Text(pin.body)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                if let file = pin.elementFile {
                    Text(pin.elementLine.map { "\(file):\($0)" } ?? file)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                HStack(spacing: 8) {
                    if let taskId = pin.linkedTaskId {
                        Button("Open Task →") {
                            selectedPinId = nil
                            store.workspaceMode = .workbench
                            Task { await store.selectTask(taskId) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    } else {
                        Button("File Task Now") {
                            selectedPinId = nil
                            Task { await store.submitPins([pin], grouping: .perPin) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))

                        Button("Remove") {
                            selectedPinId = nil
                            store.deleteCanvasPin(id: pin.id)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    }
                    Spacer()
                }
            }
            .padding(14)
            .frame(width: 290)
            .background(ToolrollPalette.paper)
        }
    }

    private func draftPinPopover(_ draft: PendingPinDraft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(draft.kind == .options ? "Explore UI Options (A/B/C/D)" : "Add Canvas Pin")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Text(draft.elementName ?? draft.route)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }

            if let f = draft.elementFile {
                Text(draft.elementLine.map { "\(f):\($0)" } ?? f)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            TextField(
                draft.kind == .options
                    ? "Ask agent for 2–4 visual options…"
                    : "Describe the UI change…",
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
                Button("File Now (⌘↵)") {
                    commitDraftPin(draft, fileImmediately: true)
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(draftPinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Spacer()

                Button("Add to Review") {
                    commitDraftPin(draft, fileImmediately: false)
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(draftPinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 315)
        .background(ToolrollPalette.paper)
    }

    private func commitDraftPin(_ draft: PendingPinDraft, fileImmediately: Bool) {
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
                elementName: draft.elementName,
                elementSelector: draft.elementSelector,
                elementFile: draft.elementFile,
                elementLine: draft.elementLine,
                fileImmediately: fileImmediately
            )
        }
    }

    // MARK: - Floating Bottom Dock + Batch Create Tasks (N)

    private func floatingDock() -> some View {
        HStack(spacing: 4) {
            dockToolButton(.select, icon: "cursorarrow", key: "V")
            dockToolButton(.pin, icon: "mappin.and.ellipse", key: "C")
            dockToolButton(.options, icon: "square.grid.2x2", key: "O")
            dockToolButton(.compare, icon: "rectangle.lefthalf.inset.filled.arrow.left", key: "D")

            HairlineDivider(vertical: true).frame(height: 18).padding(.horizontal, 4)

            Button {
                store.arrangeCanvasArtboards(viewport: store.canvasViewport)
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

            // Batch review CTA (Q4 + Q8)
            if !store.draftCanvasPins.isEmpty {
                HairlineDivider(vertical: true).frame(height: 18).padding(.horizontal, 4)

                Button {
                    isSubmitBatchOpen.toggle()
                } label: {
                    Text("Create Tasks (\(store.draftCanvasPins.count))")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background(ToolrollPalette.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .popover(isPresented: $isSubmitBatchOpen, arrowEdge: .top) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("File \(store.draftCanvasPins.count) Draft Pin\(store.draftCanvasPins.count == 1 ? "" : "s")")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)

                        HStack(spacing: 4) {
                            ForEach(PinBatchGrouping.allCases) { g in
                                let active = batchGrouping == g
                                Button {
                                    batchGrouping = g
                                } label: {
                                    Text(g.rawValue)
                                        .font(.system(size: 11, weight: active ? .semibold : .regular))
                                        .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(2)
                        .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 6))

                        HStack {
                            Spacer()
                            Button("Create Tasks") {
                                isSubmitBatchOpen = false
                                Task { await store.submitDraftPins(grouping: batchGrouping) }
                            }
                            .buttonStyle(KitButtonStyle(.primary, compact: true))
                        }
                    }
                    .padding(14)
                    .background(ToolrollPalette.paper)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .toolrollGlassCapsule(interactive: true)
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
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("\(t.rawValue) (\(key))")
    }

    private func resolvedURL(for path: String) -> String {
        let cleanBase = store.canvasBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
        return "\(cleanBase)\(cleanPath)"
    }
}

// MARK: - Scaled Live WKWebView with Session Cookie Injection + Read-Only DOM Inspector

private struct DOMInspectHit {
    let elementName: String?
    let selector: String?
    let file: String?
    let line: Int?
    let xFrac: Double
    let yFrac: Double
}

private struct ScaledLiveArtboardWebView: NSViewRepresentable {
    let urlString: String
    let logicalWidth: Double
    let logicalHeight: Double
    let sessionCookie: (name: String, value: String, origin: String)?
    let autoCaptureOnLoad: Bool
    let inspectorEnabled: Bool
    let onSnapshotPNG: (Data) -> Void
    let onInspectClick: (DOMInspectHit) -> Void

    private static let inspectorScript = """
    (function() {
      if (window.__toolrollInspectorInstalled) return;
      window.__toolrollInspectorInstalled = true;
      window.__toolrollInspectOn = false;
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:1.5px solid #0d74ce;background:rgba(13,116,206,0.08);display:none;box-sizing:border-box;';
      document.documentElement.appendChild(box);
      document.addEventListener('mousemove', function(e) {
        if (!window.__toolrollInspectOn) { box.style.display = 'none'; return; }
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === box) { box.style.display = 'none'; return; }
        var r = el.getBoundingClientRect();
        box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
        box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
        box.style.display = 'block';
      }, true);
      document.addEventListener('click', function(e) {
        if (!window.__toolrollInspectOn) return;
        e.preventDefault(); e.stopPropagation();
        var el = document.elementFromPoint(e.clientX, e.clientY);
        var name = el ? (el.getAttribute('data-component') || el.tagName.toLowerCase()) : 'page';
        var sel = el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')) : '';
        var file = null, line = null;
        if (el) {
          var fk = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
          if (fk && el[fk]) {
            var cur = el[fk];
            for (var i = 0; i < 8 && cur; i++) {
              if (cur._debugSource) { file = cur._debugSource.fileName; line = cur._debugSource.lineNumber; break; }
              if (cur.type && typeof cur.type === 'function' && cur.type.name) { name = cur.type.name; }
              cur = cur.return;
            }
          }
        }
        window.webkit.messageHandlers.toolrollInspect.postMessage({
          elementName: name, selector: sel, file: file, line: line,
          xFrac: e.clientX / Math.max(1, window.innerWidth),
          yFrac: e.clientY / Math.max(1, window.innerHeight)
        });
      }, true);
    })();
    """

    func makeCoordinator() -> Coordinator {
        Coordinator(
            autoCaptureOnLoad: autoCaptureOnLoad,
            onSnapshotPNG: onSnapshotPNG,
            onInspectClick: onInspectClick
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "toolrollInspect")
        config.userContentController.addUserScript(WKUserScript(
            source: Self.inspectorScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight), configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.loadWithCookie(webView: webView, urlString: urlString, sessionCookie: sessionCookie)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.autoCaptureOnLoad = autoCaptureOnLoad
        context.coordinator.onSnapshotPNG = onSnapshotPNG
        context.coordinator.onInspectClick = onInspectClick
        if context.coordinator.loadedURL != urlString {
            context.coordinator.loadWithCookie(webView: webView, urlString: urlString, sessionCookie: sessionCookie)
        }
        let flag = inspectorEnabled ? "true" : "false"
        webView.evaluateJavaScript("window.__toolrollInspectOn = \(flag);", completionHandler: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var loadedURL: String = ""
        var autoCaptureOnLoad: Bool
        var onSnapshotPNG: (Data) -> Void
        var onInspectClick: (DOMInspectHit) -> Void

        init(autoCaptureOnLoad: Bool, onSnapshotPNG: @escaping (Data) -> Void, onInspectClick: @escaping (DOMInspectHit) -> Void) {
            self.autoCaptureOnLoad = autoCaptureOnLoad
            self.onSnapshotPNG = onSnapshotPNG
            self.onInspectClick = onInspectClick
        }

        func loadWithCookie(webView: WKWebView, urlString: String, sessionCookie: (name: String, value: String, origin: String)?) {
            guard let targetURL = URL(string: urlString) else { return }
            loadedURL = urlString
            if let sc = sessionCookie,
               let cookieOrigin = URL(string: sc.origin),
               cookieOrigin.host == targetURL.host,
               cookieOrigin.port == targetURL.port,
               let cookie = HTTPCookie(properties: [
                   .domain: targetURL.host ?? "127.0.0.1",
                   .path: "/",
                   .name: sc.name,
                   .value: sc.value,
               ]) {
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    webView.load(URLRequest(url: targetURL))
                }
            } else {
                webView.load(URLRequest(url: targetURL))
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard autoCaptureOnLoad else { return }
            // Wait 550ms for fonts/CSS/hydration to settle, then silently cache Retina tile to disk
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self, weak webView] in
                guard let self, let webView else { return }
                let config = WKSnapshotConfiguration()
                config.rect = webView.bounds
                webView.takeSnapshot(with: config) { image, _ in
                    guard let image,
                          let tiff = image.tiffRepresentation,
                          let rep = NSBitmapImageRep(data: tiff),
                          let png = rep.representation(using: .png, properties: [:])
                    else { return }
                    self.onSnapshotPNG(png)
                }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "toolrollInspect",
                  let dict = message.body as? [String: Any]
            else { return }
            let hit = DOMInspectHit(
                elementName: dict["elementName"] as? String,
                selector: dict["selector"] as? String,
                file: dict["file"] as? String,
                line: dict["line"] as? Int,
                xFrac: (dict["xFrac"] as? Double) ?? 0.5,
                yFrac: (dict["yFrac"] as? Double) ?? 0.5
            )
            onInspectClick(hit)
        }
    }
}
