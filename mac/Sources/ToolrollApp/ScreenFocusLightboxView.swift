import AppKit
import SwiftUI
import ToolrollCore
import WebKit

/// Studio Screen Focus Lightbox:
/// Opens when clicking any artboard on the Canvas. Provides high-res zoom & pan (`50%`–`300%`),
/// Cached / Live Interactive / Before-After Compare switching, click-to-pin right on the screen,
/// and a sleek right-side Edit & Task Creation panel.
struct ScreenFocusLightboxView: View {
    @Bindable var store: WorkbenchStore
    let board: CanvasArtboard
    let onClose: () -> Void
    let onSelectBoard: (String) -> Void

    enum ViewMode: String, CaseIterable, Identifiable {
        case cached = "Preview"
        case live = "Live"
        case compare = "Compare"
        var id: String { rawValue }
    }

    @State private var viewMode: ViewMode = .cached
    @State private var detailZoom: CGFloat = 1.0
    @State private var baseZoom: CGFloat = 1.0
    @State private var pan: CGSize = .zero
    @State private var dragStartPan: CGSize = .zero
    @State private var clickToPin: Bool = true
    @State private var compareSplit: Double = 0.5

    // Inline Edit / Task Creation state
    @State private var selectedKind: CanvasPinKind = .change
    @State private var planFirst: Bool = true
    @State private var taskPrompt: String = ""
    @State private var pinnedPoint: CGPoint? = nil // normalized 0...1
    @State private var pinnedElementName: String? = nil
    @State private var pinnedSelector: String? = nil
    @State private var pinnedFile: String? = nil
    @State private var pinnedLine: Int? = nil
    @State private var routeDraft: String = ""
    @State private var isEditingRoute: Bool = false

    private var boardIndex: Int? {
        store.canvasArtboards.firstIndex(where: { $0.id == board.id })
    }

    private var pinsOnScreen: [CanvasPin] {
        store.canvasPins.filter { $0.artboardPath == board.path || $0.artboardRoute == board.route }
    }

    private var hasBeforeAfter: Bool {
        board.baselineImagePath != nil && board.latestImagePath != nil
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.68)
                .ignoresSafeArea()
                .onTapGesture { onClose() }

            VStack(spacing: 0) {
                topBar
                HairlineDivider()

                HStack(spacing: 0) {
                    // LEFT: Large Zoomable Screen Inspection Stage
                    stageArea
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    HairlineDivider(vertical: true)

                    // RIGHT: Edit & Task Creation Panel
                    inspectorRail
                        .frame(width: 340)
                }
            }
            .frame(maxWidth: 1260, maxHeight: 820)
            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
            )
            .padding(24)
        }
        .onAppear {
            routeDraft = board.path
            viewMode = (board.latestImagePath == nil) ? .live : .cached
            compareSplit = board.compareSplit
        }
        .onChange(of: board.id) { _, _ in
            routeDraft = board.path
            pinnedPoint = nil
            pinnedElementName = nil
            detailZoom = 1.0
            baseZoom = 1.0
            pan = .zero
            dragStartPan = .zero
        }
    }

    // MARK: - Top Bar

    private var topBar: some View {
        HStack(spacing: 10) {
            // Prev / Next screen arrows
            HStack(spacing: 4) {
                Button {
                    if let idx = boardIndex, idx > 0 {
                        onSelectBoard(store.canvasArtboards[idx - 1].id)
                    }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle((boardIndex ?? 0) > 0 ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.35))
                        .frame(width: 24, height: 22)
                }
                .buttonStyle(.plain)
                .disabled((boardIndex ?? 0) <= 0)

                Button {
                    if let idx = boardIndex, idx + 1 < store.canvasArtboards.count {
                        onSelectBoard(store.canvasArtboards[idx + 1].id)
                    }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle((boardIndex ?? 0) + 1 < store.canvasArtboards.count ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.35))
                        .frame(width: 24, height: 22)
                }
                .buttonStyle(.plain)
                .disabled((boardIndex ?? 0) + 1 >= store.canvasArtboards.count)
            }

            if isEditingRoute {
                HStack(spacing: 6) {
                    TextField("/route", text: $routeDraft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        .frame(width: 210)
                        .onSubmit { applyRouteEdit() }
                    Button("Load") { applyRouteEdit() }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    Button("Cancel") { isEditingRoute = false }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
            } else {
                Button {
                    routeDraft = board.path
                    isEditingRoute = true
                } label: {
                    HStack(spacing: 6) {
                        Text(board.route)
                            .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                        if let src = board.sourceFile {
                            Text("· \(src)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        Image(systemName: "pencil")
                            .font(.system(size: 10))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .buttonStyle(.plain)
                .help("Click to change this screen's route URL")
            }

            Spacer()

            // Preview | Live | Compare switcher
            HStack(spacing: 2) {
                ForEach(ViewMode.allCases) { mode in
                    let active = viewMode == mode
                    let disabled = (mode == .compare && !hasBeforeAfter)
                    Button {
                        viewMode = mode
                        if mode == .live && store.canvasBaseURL.isEmpty {
                            Task { await store.wakePreviewServerAndHydrate(forceAll: false) }
                        }
                    } label: {
                        Text(mode.rawValue)
                            .font(.system(size: 11, weight: active ? .semibold : .regular))
                            .foregroundStyle(disabled ? ToolrollPalette.muted.opacity(0.4) : (active ? ToolrollPalette.ink : ToolrollPalette.muted))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                }
            }
            .padding(2)
            .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 6))

            // Zoom controls
            HStack(spacing: 4) {
                Button {
                    detailZoom = max(0.5, detailZoom - 0.25)
                    baseZoom = detailZoom
                } label: {
                    Image(systemName: "minus")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)

                Button {
                    detailZoom = 1.0
                    baseZoom = 1.0
                    pan = .zero
                    dragStartPan = .zero
                } label: {
                    Text("\(Int(detailZoom * 100))%")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                        .frame(width: 42)
                }
                .buttonStyle(.plain)
                .help("Reset zoom to Fit")

                Button {
                    detailZoom = min(3.0, detailZoom + 0.25)
                    baseZoom = detailZoom
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

            // Remove screen from canvas
            Button {
                let id = board.id
                onClose()
                store.removeCanvasArtboard(id: id)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 26, height: 24)
            }
            .buttonStyle(.plain)
            .help("Remove screen from Canvas")

            Button {
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 26, height: 24)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help("Close (Esc)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(ToolrollPalette.raised)
    }

    private func applyRouteEdit() {
        let clean = routeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        isEditingRoute = false
        store.updateCanvasArtboardPath(id: board.id, newPath: clean)
    }

    // MARK: - Zoomable Stage Area

    private var stageArea: some View {
        GeometryReader { geo in
            let pad: CGFloat = 28
            let availW = max(200, geo.size.width - pad * 2)
            let availH = max(200, geo.size.height - pad * 2)
            let aspect = CGFloat(store.canvasViewport.logicalWidth / store.canvasViewport.logicalHeight)
            let fitW = min(availW, availH * aspect)
            let fitH = fitW / aspect
            let renderW = fitW * detailZoom
            let renderH = fitH * detailZoom

            ZStack {
                ToolrollPalette.ground

                ZStack(alignment: .topLeading) {
                    if viewMode == .compare,
                       let basePath = board.baselineImagePath,
                       let latestPath = board.latestImagePath,
                       let baseImg = NSImage(contentsOfFile: basePath),
                       let latestImg = NSImage(contentsOfFile: latestPath) {
                        focusCompareView(before: baseImg, after: latestImg, width: renderW, height: renderH)
                    } else if viewMode == .live && !store.canvasBaseURL.isEmpty {
                        let logW = store.canvasViewport.logicalWidth
                        let logH = store.canvasViewport.logicalHeight
                        let scale = renderW / logW

                        FocusLiveWebView(
                            urlString: resolvedURL(for: board.path),
                            logicalWidth: logW,
                            logicalHeight: logH,
                            sessionCookie: store.localSessionCookie,
                            inspectorEnabled: clickToPin,
                            onInspectClick: { name, sel, file, line, xf, yf in
                                pinnedPoint = CGPoint(x: xf, y: yf)
                                pinnedElementName = name
                                pinnedSelector = sel
                                pinnedFile = file ?? board.sourceFile
                                pinnedLine = line
                            }
                        )
                        .frame(width: logW, height: logH)
                        .scaleEffect(scale, anchor: .topLeading)
                        .frame(width: renderW, height: renderH, alignment: .topLeading)
                        .clipped()
                    } else if let imgPath = board.latestImagePath, let img = NSImage(contentsOfFile: imgPath) {
                        Image(nsImage: img)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: renderW, height: renderH)
                    } else {
                        VStack(spacing: 10) {
                            Text("Preview not captured yet")
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.ink)
                            Button("Wake Preview Server") {
                                Task { await store.wakePreviewServerAndHydrate(forceAll: true) }
                            }
                            .buttonStyle(KitButtonStyle(.primary))
                        }
                        .frame(width: renderW, height: renderH)
                        .background(ToolrollPalette.codeBg)
                    }

                    // Click-to-pin tap overlay on Preview image
                    if viewMode == .cached && clickToPin {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { loc in
                                pinnedPoint = CGPoint(
                                    x: min(0.98, max(0.02, loc.x / max(1, renderW))),
                                    y: min(0.98, max(0.02, loc.y / max(1, renderH)))
                                )
                                pinnedElementName = nil
                                pinnedSelector = nil
                                pinnedFile = board.sourceFile
                                pinnedLine = nil
                            }
                    }

                    // Existing pins on this screen
                    ForEach(Array(pinsOnScreen.enumerated()), id: \.element.id) { idx, pin in
                        let tone = store.statusTone(forPin: pin)
                        Circle()
                            .fill(pin.isDraft ? ToolrollPalette.warning : (tone == .running ? ToolrollPalette.live : (tone == .finished ? ToolrollPalette.success : ToolrollPalette.ink)))
                            .frame(width: 22, height: 22)
                            .overlay(
                                Text(pin.kind == .options ? "O" : "\(idx + 1)")
                                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.inverseInk)
                            )
                            .overlay(Circle().strokeBorder(ToolrollPalette.paper, lineWidth: 2))
                            .position(x: pin.xFrac * renderW, y: pin.yFrac * renderH)
                    }

                    // Active new pin crosshair
                    if let pt = pinnedPoint {
                        ZStack {
                            Circle()
                                .strokeBorder(ToolrollPalette.live, lineWidth: 2)
                                .frame(width: 26, height: 26)
                            Circle()
                                .fill(ToolrollPalette.live)
                                .frame(width: 8, height: 8)
                        }
                        .position(x: pt.x * renderW, y: pt.y * renderH)
                    }
                }
                .frame(width: renderW, height: renderH)
                .background(ToolrollPalette.paper)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                .offset(pan)
                .gesture(
                    DragGesture()
                        .onChanged { val in
                            guard !clickToPin || detailZoom > 1.01 else { return }
                            pan = CGSize(width: dragStartPan.width + val.translation.width, height: dragStartPan.height + val.translation.height)
                        }
                        .onEnded { _ in dragStartPan = pan }
                )

                // Floating bottom micro-hint bar inside stage
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        Button {
                            clickToPin.toggle()
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: clickToPin ? "mappin.and.ellipse" : "hand.draw")
                                    .font(.system(size: 10.5))
                                Text(clickToPin ? "Click screen to target pin" : "Pan / Interact mode")
                                    .font(.system(size: 11, weight: .medium))
                            }
                            .foregroundStyle(ToolrollPalette.ink)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(ToolrollPalette.paper, in: Capsule())
                            .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        }
                        .buttonStyle(.plain)

                        if detailZoom > 1.01 {
                            Text("Drag to pan · Pinch to zoom")
                                .font(.system(size: 10.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                    .padding(.bottom, 12)
                }
            }
            .clipped()
            .gesture(
                MagnifyGesture()
                    .onChanged { val in
                        detailZoom = min(3.0, max(0.5, baseZoom * val.magnification))
                    }
                    .onEnded { _ in baseZoom = detailZoom }
            )
        }
    }

    private func focusCompareView(before: NSImage, after: NSImage, width: CGFloat, height: CGFloat) -> some View {
        let splitX = CGFloat(compareSplit) * width
        return ZStack(alignment: .topLeading) {
            Image(nsImage: after)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: width, height: height)

            Image(nsImage: before)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: width, height: height)
                .mask(
                    Rectangle()
                        .frame(width: max(0, splitX), height: height)
                        .frame(width: width, height: height, alignment: .leading)
                )

            Rectangle()
                .fill(ToolrollPalette.ink)
                .frame(width: 2, height: height)
                .offset(x: splitX)

            HStack {
                Text("BEFORE")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(ToolrollPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 4))
                Spacer()
                Text("AFTER")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(ToolrollPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 4))
            }
            .foregroundStyle(ToolrollPalette.ink)
            .padding(10)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { val in
                    compareSplit = min(0.98, max(0.02, Double(val.location.x / max(1, width))))
                    store.setArtboardCompareSplit(id: board.id, split: compareSplit)
                }
        )
    }

    // MARK: - Right Edit & Task Creation Rail

    private var inspectorRail: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Composer header
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("EDIT & CREATE TASK")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .tracking(0.7)
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                    Text("\(Int(store.canvasViewport.logicalWidth))×\(Int(store.canvasViewport.logicalHeight))")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                // Target indicator pill (auto-populated when user clicks anywhere on the screen!)
                HStack(spacing: 6) {
                    Image(systemName: pinnedPoint == nil ? "viewfinder" : "mappin.circle.fill")
                        .font(.system(size: 11.5))
                        .foregroundStyle(pinnedPoint == nil ? ToolrollPalette.muted : ToolrollPalette.live)
                    if let pt = pinnedPoint {
                        Text(pinnedElementName ?? "Pinned at \(Int(pt.x * 100))%, \(Int(pt.y * 100))%")
                            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                            .lineLimit(1)
                        Spacer()
                        Button("Clear") {
                            pinnedPoint = nil
                            pinnedElementName = nil
                        }
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .buttonStyle(.plain)
                    } else {
                        Text("Whole screen · click image to target a spot")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                        Spacer()
                    }
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                // Kind switcher: UI Change vs Explore Options (A/B/C/D)
                HStack(spacing: 4) {
                    kindButton(.change, label: "UI Change")
                    kindButton(.options, label: "Options (A/B/C/D)")
                }
                .padding(2)
                .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 6))

                // Multiline prompt input
                TextField(
                    selectedKind == .options
                        ? "Ask Toolroll to propose 2–4 visual options for this area…"
                        : "Describe the visual change, copy tweak, or fix…",
                    text: $taskPrompt,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(4...8)
                .padding(10)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

                // Execution cadence: Plan first vs Just code
                HStack(spacing: 4) {
                    executionButton(plan: true, label: "Plan first")
                    executionButton(plan: false, label: "Just code")
                }
                .padding(2)
                .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 6))

                HStack(spacing: 8) {
                    Button("Add to Batch") {
                        submitFromFocus(fileImmediately: false)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    .disabled(taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Spacer()

                    Button("File Task (⌘↵)") {
                        submitFromFocus(fileImmediately: true)
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(16)

            HairlineDivider()

            // Pins & tasks linked to this screen
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("ON THIS SCREEN (\(pinsOnScreen.count))")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .tracking(0.7)
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)

                if pinsOnScreen.isEmpty {
                    Text("No feedback pinned on \(board.route) yet. Click any spot on the screen and describe what to change.")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(pinsOnScreen.enumerated()), id: \.element.id) { idx, pin in
                                pinRowCard(pin: pin, index: idx + 1)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 16)
                    }
                }
            }
        }
        .background(ToolrollPalette.paper)
    }

    private func kindButton(_ kind: CanvasPinKind, label: String) -> some View {
        let active = selectedKind == kind
        return Button {
            selectedKind = kind
        } label: {
            Text(label)
                .font(.system(size: 11.5, weight: active ? .semibold : .regular))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity)
                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func executionButton(plan: Bool, label: String) -> some View {
        let active = planFirst == plan
        return Button {
            planFirst = plan
        } label: {
            Text(label)
                .font(.system(size: 11, weight: active ? .semibold : .regular))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity)
                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func pinRowCard(pin: CanvasPin, index: Int) -> some View {
        let tone = store.statusTone(forPin: pin)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(pin.kind == .options ? "O" : "#\(index)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                StatusChip(tone: tone, label: pin.isDraft ? "Draft" : nil)
                Spacer()
                if let taskId = pin.linkedTaskId {
                    Button("Open →") {
                        onClose()
                        store.workspaceMode = .workbench
                        Task { await store.selectTask(taskId) }
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .buttonStyle(.plain)
                } else {
                    Button("Remove") {
                        store.deleteCanvasPin(id: pin.id)
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .buttonStyle(.plain)
                }
            }

            Text(pin.body)
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func submitFromFocus(fileImmediately: Bool) {
        let body = taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        let pt = pinnedPoint ?? CGPoint(x: 0.5, y: 0.35)
        let elName = pinnedElementName
        let elSel = pinnedSelector
        let elFile = pinnedFile ?? board.sourceFile
        let elLine = pinnedLine
        let shouldPlan = planFirst
        taskPrompt = ""
        pinnedPoint = nil
        pinnedElementName = nil

        Task {
            await store.createCanvasPin(
                route: board.route,
                path: board.path,
                xFrac: Double(pt.x),
                yFrac: Double(pt.y),
                kind: selectedKind,
                body: body,
                elementName: elName,
                elementSelector: elSel,
                elementFile: elFile,
                elementLine: elLine,
                fileImmediately: fileImmediately,
                planFirst: shouldPlan
            )
        }
    }

    private func resolvedURL(for path: String) -> String {
        let cleanBase = store.canvasBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
        return "\(cleanBase)\(cleanPath)"
    }
}

// MARK: - Live WebView inside Focus Lightbox (with DOM Element Inspector)

private struct FocusLiveWebView: NSViewRepresentable {
    let urlString: String
    let logicalWidth: Double
    let logicalHeight: Double
    let sessionCookie: (name: String, value: String, origin: String)?
    let inspectorEnabled: Bool
    let onInspectClick: (String?, String?, String?, Int?, Double, Double) -> Void

    private static let script = """
    (function() {
      if (window.__trFocusInspector) return;
      window.__trFocusInspector = true;
      window.__trFocusInspectOn = true;
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:1.5px solid #0d74ce;background:rgba(13,116,206,0.08);display:none;box-sizing:border-box;';
      document.documentElement.appendChild(box);
      document.addEventListener('mousemove', function(e) {
        if (!window.__trFocusInspectOn) { box.style.display = 'none'; return; }
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === box) { box.style.display = 'none'; return; }
        var r = el.getBoundingClientRect();
        box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
        box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
        box.style.display = 'block';
      }, true);
      document.addEventListener('click', function(e) {
        if (!window.__trFocusInspectOn) return;
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
        window.webkit.messageHandlers.trFocusInspect.postMessage({
          elementName: name, selector: sel, file: file, line: line,
          xFrac: e.clientX / Math.max(1, window.innerWidth),
          yFrac: e.clientY / Math.max(1, window.innerHeight)
        });
      }, true);
    })();
    """

    func makeCoordinator() -> Coordinator {
        Coordinator(onInspectClick: onInspectClick)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "trFocusInspect")
        config.userContentController.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.load(webView: webView, urlString: urlString, cookie: sessionCookie)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onInspectClick = onInspectClick
        if context.coordinator.loadedURL != urlString {
            context.coordinator.load(webView: webView, urlString: urlString, cookie: sessionCookie)
        }
        webView.evaluateJavaScript("window.__trFocusInspectOn = \(inspectorEnabled ? "true" : "false");", completionHandler: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        var loadedURL: String = ""
        var onInspectClick: (String?, String?, String?, Int?, Double, Double) -> Void

        init(onInspectClick: @escaping (String?, String?, String?, Int?, Double, Double) -> Void) {
            self.onInspectClick = onInspectClick
        }

        func load(webView: WKWebView, urlString: String, cookie: (name: String, value: String, origin: String)?) {
            guard let targetURL = URL(string: urlString) else { return }
            loadedURL = urlString
            if let sc = cookie,
               let co = URL(string: sc.origin),
               co.host == targetURL.host, co.port == targetURL.port,
               let httpCookie = HTTPCookie(properties: [
                   .domain: targetURL.host ?? "127.0.0.1",
                   .path: "/",
                   .name: sc.name,
                   .value: sc.value,
               ]) {
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(httpCookie) {
                    webView.load(URLRequest(url: targetURL))
                }
            } else {
                webView.load(URLRequest(url: targetURL))
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "trFocusInspect",
                  let dict = message.body as? [String: Any]
            else { return }
            onInspectClick(
                dict["elementName"] as? String,
                dict["selector"] as? String,
                dict["file"] as? String,
                dict["line"] as? Int,
                (dict["xFrac"] as? Double) ?? 0.5,
                (dict["yFrac"] as? Double) ?? 0.5
            )
        }
    }
}
