import AppKit
import SwiftUI
import ToolrollCore
import WebKit

/// Studio Screen Focus Lightbox:
/// Opens when clicking any artboard on the Canvas. Provides high-res zoom & pan (`50%`–`300%`),
/// Cached / Live Interactive / Before-After Compare switching, floating Figma-style Element Context Bar
/// + Right-Click Context Menu, live 0ms Copy/Style/Hide preview tweaks, ancestor breadcrumb stepping,
/// local repo source lookup, and a right-side Edit & Task Creation rail.
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

    enum CompareSubMode: String, CaseIterable, Identifiable {
        case wipe = "Wipe"
        case sideBySide = "Side-by-Side"
        case pixelDiff = "Pixel Diff"
        var id: String { rawValue }
    }

    @State private var bridge = FocusWebBridge()
    @State private var viewMode: ViewMode = .cached
    @State private var compareSubMode: CompareSubMode = .wipe
    @State private var liveTweakSnapshot: NSImage? = nil
    @State private var visualDiff: VisualDiffResult? = nil
    @State private var detailZoom: CGFloat = 1.0
    @State private var baseZoom: CGFloat = 1.0
    @State private var pan: CGSize = .zero
    @State private var dragStartPan: CGSize = .zero
    @State private var clickToPin: Bool = true
    @State private var compareSplit: Double = 0.5

    // Selected element + floating HUD + live edits
    @State private var selectedElement: SelectedElementContext? = nil
    @State private var pinnedPoint: CGPoint? = nil // normalized 0...1 (also used in Preview mode)
    @State private var isEditingCopy: Bool = false
    @State private var isStylePopoverOpen: Bool = false
    @State private var isContextMenuOpen: Bool = false
    @State private var contextMenuAnchorFrac: CGPoint? = nil
    @State private var pendingEdits: [String: ElementLiveEdit] = [:]

    // Inline Edit / Task Creation state
    @State private var selectedKind: CanvasPinKind = .change
    @State private var planFirst: Bool = true
    @State private var taskPrompt: String = ""
    @State private var routeDraft: String = ""
    @State private var isEditingRoute: Bool = false
    @State private var copiedFeedback: String? = nil

    private var boardIndex: Int? {
        store.canvasArtboards.firstIndex(where: { $0.id == board.id })
    }

    private var pinsOnScreen: [CanvasPin] {
        store.canvasPins.filter { $0.artboardPath == board.path || $0.artboardRoute == board.route }
    }

    private var hasBeforeAfter: Bool {
        (board.baselineImagePath != nil && board.latestImagePath != nil)
            || (!activeLiveEdits.isEmpty && board.latestImagePath != nil)
    }

    private var activeLiveEdits: [ElementLiveEdit] {
        pendingEdits.values.filter(\.hasChanges).sorted { $0.id < $1.id }
    }

    private var canSubmitTask: Bool {
        !taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !activeLiveEdits.isEmpty
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
                    // LEFT: Large Zoomable Screen Inspection Stage + Floating Element Context HUD
                    stageArea
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    HairlineDivider(vertical: true)

                    // RIGHT: Rich Element Inspector + Edit & Task Creation Panel
                    inspectorRail
                        .frame(width: 356)
                }
            }
            .frame(maxWidth: 1320, maxHeight: 840)
            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
            )
            .padding(24)
        }
        .onAppear {
            routeDraft = board.path
            // Q3: Auto-open in Live when preview server is already warm; stay in Preview when asleep.
            if !store.canvasBaseURL.isEmpty {
                viewMode = .live
            } else {
                viewMode = (board.latestImagePath == nil) ? .live : .cached
            }
            compareSplit = board.compareSplit
        }
        .onChange(of: board.id) { _, _ in
            routeDraft = board.path
            resetSelectionAndViewport()
        }
    }

    private func resetSelectionAndViewport() {
        selectedElement = nil
        pinnedPoint = nil
        isEditingCopy = false
        isStylePopoverOpen = false
        isContextMenuOpen = false
        contextMenuAnchorFrac = nil
        pendingEdits.removeAll()
        liveTweakSnapshot = nil
        visualDiff = nil
        detailZoom = 1.0
        baseZoom = 1.0
        pan = .zero
        dragStartPan = .zero
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
                        if mode == .compare {
                            Task { await enterCompareMode() }
                        } else {
                            viewMode = mode
                            if mode != .live {
                                isStylePopoverOpen = false
                                isContextMenuOpen = false
                                isEditingCopy = false
                            }
                            if mode == .live && store.canvasBaseURL.isEmpty {
                                Task { await store.wakePreviewServerAndHydrate(forceAll: false) }
                            }
                        }
                    } label: {
                        Text(mode.rawValue)
                            .font(.system(size: 11, weight: active ? .semibold : .regular))
                            .foregroundStyle(disabled ? ToolrollPalette.muted.opacity(0.4) : (active ? ToolrollPalette.ink : ToolrollPalette.muted))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                            .contentShape(Rectangle())
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

    // MARK: - Zoomable Stage Area + Floating Element Context HUD

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

            // Origin of the rendered screen inside the stage coordinate space
            let stageOriginX = (geo.size.width - renderW) / 2 + pan.width
            let stageOriginY = (geo.size.height - renderH) / 2 + pan.height

            ZStack(alignment: .topLeading) {
                ToolrollPalette.ground
                    .frame(width: geo.size.width, height: geo.size.height)

                ZStack(alignment: .topLeading) {
                    if viewMode == .compare,
                       let pair = resolveCompareImages() {
                        focusCompareView(
                            before: pair.before,
                            after: pair.after,
                            beforeLabel: pair.beforeLabel,
                            afterLabel: pair.afterLabel,
                            width: renderW,
                            height: renderH
                        )
                    } else if viewMode == .live && !store.canvasBaseURL.isEmpty {
                        let logW = store.canvasViewport.logicalWidth
                        let logH = store.canvasViewport.logicalHeight
                        let scale = renderW / logW

                        FocusLiveWebView(
                            bridge: bridge,
                            urlString: resolvedURL(for: board.path),
                            logicalWidth: logW,
                            logicalHeight: logH,
                            sessionCookie: store.localSessionCookie,
                            inspectorEnabled: clickToPin,
                            onElementSelected: { ctx, openMenu in
                                handleElementSelected(ctx, openContextMenu: openMenu)
                            },
                            onInlineTextChanged: { elId, newText, finished in
                                handleInlineTextChanged(elId: elId, newText: newText, finished: finished)
                            }
                        )
                        .frame(width: logW, height: logH)
                        .scaleEffect(scale, anchor: .topLeading)
                        .frame(width: renderW, height: renderH, alignment: .topLeading)
                        .clipped()
                    } else if let imgPath = board.latestImagePath, let img = CanvasImageCache.shared.image(atPath: imgPath, maxPixelDimension: 2160) {
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
                                selectedElement = nil
                                isStylePopoverOpen = false
                                isContextMenuOpen = false
                                pinnedPoint = CGPoint(
                                    x: min(0.98, max(0.02, loc.x / max(1, renderW))),
                                    y: min(0.98, max(0.02, loc.y / max(1, renderH)))
                                )
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

                    // Active target pin crosshair (in Preview mode or when no element rect)
                    if let pt = pinnedPoint, selectedElement == nil {
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
                .position(x: stageOriginX + renderW / 2, y: stageOriginY + renderH / 2)
                .gesture(
                    DragGesture()
                        .onChanged { val in
                            guard !clickToPin || detailZoom > 1.01 else { return }
                            pan = CGSize(width: dragStartPan.width + val.translation.width, height: dragStartPan.height + val.translation.height)
                        }
                        .onEnded { _ in dragStartPan = pan }
                )

                // FLOATING ELEMENT CONTEXT BAR (Anchored right above/below selected element!)
                if viewMode == .live, let el = selectedElement {
                    let elTopY = stageOriginY + CGFloat(el.rectYFrac) * renderH
                    let elBottomY = stageOriginY + CGFloat(el.rectYFrac + el.rectHFrac) * renderH
                    let elCenterX = stageOriginX + CGFloat(el.rectXFrac + el.rectWFrac / 2) * renderW

                    let barX = min(max(190, elCenterX), max(190, geo.size.width - 190))
                    let placeAbove = elTopY > 64
                    let rawBarY = placeAbove ? (elTopY - 26) : (elBottomY + 26)
                    let barY = min(max(30, rawBarY), max(30, geo.size.height - 72))

                    floatingElementToolbar(for: el)
                        .position(x: barX, y: barY)
                        .transition(.opacity)

                    // Compact Style Tweaks Popover (toggled from floating bar or right-click menu)
                    if isStylePopoverOpen {
                        let popX = min(max(150, barX), max(150, geo.size.width - 150))
                        let popY: CGFloat = (barY < geo.size.height * 0.5)
                            ? min(geo.size.height - 155, barY + 148)
                            : max(155, barY - 148)
                        styleTweaksPopover(for: el)
                            .position(x: popX, y: popY)
                    }

                    // Rich Right-Click / Overflow Context Menu
                    if isContextMenuOpen {
                        let anchorPt = contextMenuAnchorFrac.map {
                            CGPoint(
                                x: stageOriginX + $0.x * renderW,
                                y: stageOriginY + $0.y * renderH
                            )
                        } ?? CGPoint(x: barX + 80, y: barY + 115)
                        let menuX = min(max(132, anchorPt.x), max(132, geo.size.width - 132))
                        let menuY = min(max(145, anchorPt.y + 85), max(145, geo.size.height - 165))
                        elementContextMenuPopover(for: el)
                            .position(x: menuX, y: menuY)
                    }
                }

                // Floating bottom micro-hint bar inside stage
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        if viewMode == .compare {
                            compareFloatingControlBar
                        } else if viewMode == .cached {
                            Button {
                                viewMode = .live
                                if store.canvasBaseURL.isEmpty {
                                    Task { await store.wakePreviewServerAndHydrate(forceAll: false) }
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(ToolrollPalette.live)
                                        .frame(width: 6, height: 6)
                                    Text("Switch to Live to inspect & edit elements")
                                        .font(.system(size: 11, weight: .medium))
                                }
                                .foregroundStyle(ToolrollPalette.ink)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 5)
                                .background(ToolrollPalette.paper, in: Capsule())
                                .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        } else {
                            Button {
                                clickToPin.toggle()
                                if !clickToPin {
                                    isStylePopoverOpen = false
                                    isContextMenuOpen = false
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: clickToPin ? "scope" : "hand.tap")
                                        .font(.system(size: 10.5))
                                    Text(clickToPin ? "Inspect · ⌥+click to interact · right-click menu" : "Interact mode · click to resume Inspect")
                                        .font(.system(size: 11, weight: .medium))
                                }
                                .foregroundStyle(ToolrollPalette.ink)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 5)
                                .background(ToolrollPalette.paper, in: Capsule())
                                .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }

                        if let toast = copiedFeedback {
                            Text(toast)
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.ink)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(ToolrollPalette.raised, in: Capsule())
                                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                        } else if detailZoom > 1.01 {
                            Text("Drag to pan · Pinch to zoom")
                                .font(.system(size: 10.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                    .frame(maxWidth: .infinity)
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

    // MARK: - Floating Element Context Bar (Figma / v0 Design Mode Style)

    private func floatingElementToolbar(for el: SelectedElementContext) -> some View {
        let edit = pendingEdits[el.elId]
        let isHidden = edit?.isHidden ?? false
        let hasEdits = edit?.hasChanges ?? false

        return HStack(spacing: 2) {
            // Step up to parent element
            Button {
                selectParentElement(of: el)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Parent")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(el.hasParent ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.35))
                .padding(.horizontal, 7)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!el.hasParent)
            .help("Select parent container")

            toolbarHairline

            // Edit Copy Inline
            Button {
                isStylePopoverOpen = false
                isContextMenuOpen = false
                isEditingCopy.toggle()
                if isEditingCopy {
                    bridge.beginInlineCopyEdit(elId: el.elId)
                } else {
                    bridge.endInlineCopyEdit()
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "character.cursor.ibeam")
                        .font(.system(size: 10.5))
                    Text(isEditingCopy ? "Done Copy" : "Copy")
                        .font(.system(size: 11, weight: isEditingCopy ? .semibold : .medium))
                }
                .foregroundStyle(isEditingCopy ? ToolrollPalette.inverseInk : ToolrollPalette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(isEditingCopy ? ToolrollPalette.ink : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Edit text directly on the live page")

            // Style Tweaks Popover
            Button {
                isContextMenuOpen = false
                isEditingCopy = false
                bridge.endInlineCopyEdit()
                isStylePopoverOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 10.5))
                    Text("Style")
                        .font(.system(size: 11, weight: isStylePopoverOpen ? .semibold : .medium))
                }
                .foregroundStyle(isStylePopoverOpen ? ToolrollPalette.inverseInk : ToolrollPalette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(isStylePopoverOpen ? ToolrollPalette.ink : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Live padding, spacing, type & radius tweaks")

            // Explore Options (A/B/C/D)
            Button {
                selectedKind = .options
                if taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    taskPrompt = "Propose 3–4 visual variations for \(el.displayName)."
                }
                isStylePopoverOpen = false
                isContextMenuOpen = false
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 10.5))
                    Text("Options")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Generate A/B/C/D design options for this element")

            // Hide / Restore Element
            Button {
                toggleHideElement(el)
            } label: {
                Image(systemName: isHidden ? "eye" : "eye.slash")
                    .font(.system(size: 11))
                    .foregroundStyle(isHidden ? ToolrollPalette.warning : ToolrollPalette.ink)
                    .frame(width: 26, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isHidden ? "Restore element visibility" : "Preview hiding / removing this element")

            if hasEdits {
                toolbarHairline
                Button {
                    resetEdits(for: el.elId)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Reset live tweaks on this element")
            }

            toolbarHairline

            // Overflow / Context Menu
            Button {
                isStylePopoverOpen = false
                contextMenuAnchorFrac = nil
                isContextMenuOpen.toggle()
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("More element actions")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .toolrollGlassCapsule(interactive: true)
    }

    private var toolbarHairline: some View {
        Rectangle()
            .fill(ToolrollPalette.line)
            .frame(width: 1, height: 14)
            .padding(.horizontal, 2)
    }

    // MARK: - Compact 80/20 Style Tweaks Popover (0ms Live DOM Preview)

    private func styleTweaksPopover(for el: SelectedElementContext) -> some View {
        let edit = pendingEdits[el.elId]
        let curPadding = edit?.padding ?? el.metrics.padding
        let curGap = edit?.gap ?? el.metrics.gap
        let curFontSize = edit?.fontSize ?? el.metrics.fontSize
        let curWeight = edit?.fontWeight ?? el.metrics.fontWeight
        let curRadius = edit?.borderRadius ?? el.metrics.borderRadius
        let curOpacity = edit?.opacity ?? el.metrics.opacity

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("STYLE PREVIEW")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if edit?.hasChanges == true {
                    Button("Reset") { resetEdits(for: el.elId) }
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                        .buttonStyle(.plain)
                }
                Button {
                    isStylePopoverOpen = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .buttonStyle(.plain)
            }

            styleSliderRow(label: "Padding", valueText: "\(Int(curPadding.rounded()))px", value: Binding(
                get: { curPadding },
                set: { next in
                    mutateEdit(for: el) { $0.padding = next }
                    bridge.applyStyleTweak(elId: el.elId, property: "padding", value: "\(Int(next.rounded()))px")
                }
            ), range: 0...64, step: 2)

            styleSliderRow(label: "Gap", valueText: "\(Int(curGap.rounded()))px", value: Binding(
                get: { curGap },
                set: { next in
                    mutateEdit(for: el) { $0.gap = next }
                    bridge.applyStyleTweak(elId: el.elId, property: "gap", value: "\(Int(next.rounded()))px")
                }
            ), range: 0...48, step: 2)

            styleSliderRow(label: "Font size", valueText: "\(Int(curFontSize.rounded()))px", value: Binding(
                get: { curFontSize },
                set: { next in
                    mutateEdit(for: el) { $0.fontSize = next }
                    bridge.applyStyleTweak(elId: el.elId, property: "fontSize", value: "\(Int(next.rounded()))px")
                }
            ), range: 10...48, step: 1)

            // Font weight segmented bar
            HStack(spacing: 8) {
                Text("Weight")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 58, alignment: .leading)
                HStack(spacing: 2) {
                    ForEach([400, 500, 600, 700], id: \.self) { w in
                        let active = abs(curWeight - w) < 50
                        Button {
                            mutateEdit(for: el) { $0.fontWeight = w }
                            bridge.applyStyleTweak(elId: el.elId, property: "fontWeight", value: "\(w)")
                        } label: {
                            Text("\(w)")
                                .font(.system(size: 10, weight: active ? .semibold : .regular, design: .monospaced))
                                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 3)
                                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(2)
                .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 5))
            }

            styleSliderRow(label: "Radius", valueText: "\(Int(curRadius.rounded()))px", value: Binding(
                get: { curRadius },
                set: { next in
                    mutateEdit(for: el) { $0.borderRadius = next }
                    bridge.applyStyleTweak(elId: el.elId, property: "borderRadius", value: "\(Int(next.rounded()))px")
                }
            ), range: 0...24, step: 1)

            styleSliderRow(label: "Opacity", valueText: "\(Int((curOpacity * 100).rounded()))%", value: Binding(
                get: { curOpacity },
                set: { next in
                    mutateEdit(for: el) { $0.opacity = next }
                    bridge.applyStyleTweak(elId: el.elId, property: "opacity", value: String(format: "%.2f", next))
                }
            ), range: 0.1...1.0, step: 0.05)
        }
        .padding(12)
        .frame(width: 280)
        .toolrollGlassPanel(cornerRadius: 10)
    }

    private func styleSliderRow(label: String, valueText: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(ToolrollPalette.muted)
                .frame(width: 58, alignment: .leading)
            Slider(value: value, in: range, step: step)
                .controlSize(.mini)
                .tint(ToolrollPalette.ink)
            Text(valueText)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
                .frame(width: 38, alignment: .trailing)
        }
    }

    // MARK: - Right-Click / Overflow Element Context Menu

    private func elementContextMenuPopover(for el: SelectedElementContext) -> some View {
        let edit = pendingEdits[el.elId]
        let isHidden = edit?.isHidden ?? false
        let parentLabel = el.ancestors.first(where: { $0.depthFromSelected == 1 })?.label

        return VStack(alignment: .leading, spacing: 2) {
            // Breadcrumb & size header
            HStack(spacing: 6) {
                Text(el.displayName)
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                Spacer()
                Text("\(el.metrics.width)×\(el.metrics.height)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            HairlineDivider()

            if let parentLabel {
                contextMenuRow(icon: "arrow.up", title: "Select parent (\(parentLabel))") {
                    isContextMenuOpen = false
                    selectParentElement(of: el)
                }
            }

            contextMenuRow(icon: "character.cursor.ibeam", title: "Edit copy inline") {
                isContextMenuOpen = false
                isStylePopoverOpen = false
                isEditingCopy = true
                bridge.beginInlineCopyEdit(elId: el.elId)
            }

            contextMenuRow(icon: "slider.horizontal.3", title: "Tweak style (padding, type, radius…)") {
                isContextMenuOpen = false
                isStylePopoverOpen = true
            }

            contextMenuRow(icon: "square.grid.2x2", title: "Explore options (A/B/C/D)") {
                isContextMenuOpen = false
                selectedKind = .options
                if taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    taskPrompt = "Propose 3–4 visual variations for \(el.displayName)."
                }
            }

            contextMenuRow(icon: isHidden ? "eye" : "eye.slash", title: isHidden ? "Restore visibility" : "Hide / remove element") {
                isContextMenuOpen = false
                toggleHideElement(el)
            }

            HairlineDivider()
                .padding(.vertical, 2)

            contextMenuRow(icon: "doc.on.doc", title: "Copy CSS selector") {
                isContextMenuOpen = false
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(el.selector, forType: .string)
                flashFeedback("Copied \(el.selector)")
            }

            if let file = el.file {
                contextMenuRow(icon: "chevron.left.forwardslash.chevron.right", title: "Open \(URL(fileURLWithPath: file).lastPathComponent)") {
                    isContextMenuOpen = false
                    openSourceFile(file)
                }
            }

            if edit?.hasChanges == true {
                contextMenuRow(icon: "arrow.uturn.backward", title: "Reset tweaks on element") {
                    isContextMenuOpen = false
                    resetEdits(for: el.elId)
                }
            }
        }
        .padding(.vertical, 4)
        .frame(width: 244)
        .toolrollGlassPanel(cornerRadius: 10)
    }

    private func contextMenuRow(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - 3-Mode Compare View (Wipe | Side-by-Side | Pixel Diff) + Original vs Live Tweaks

    private func resolveCompareImages() -> (before: NSImage, after: NSImage, beforeLabel: String, afterLabel: String)? {
        // Priority 1: Original vs Your Live Preview Tweaks!
        if let tweaked = liveTweakSnapshot,
           let basePath = board.latestImagePath ?? board.baselineImagePath,
           let orig = CanvasImageCache.shared.image(atPath: basePath, maxPixelDimension: 2160) {
            return (orig, tweaked, "ORIGINAL", "LIVE TWEAKS")
        }
        // Priority 2: Locked Baseline / Main Branch vs Latest Build
        if let basePath = board.baselineImagePath,
           let latestPath = board.latestImagePath,
           let baseImg = CanvasImageCache.shared.image(atPath: basePath, maxPixelDimension: 2160),
           let latestImg = CanvasImageCache.shared.image(atPath: latestPath, maxPixelDimension: 2160) {
            return (baseImg, latestImg, "BEFORE", "AFTER")
        }
        return nil
    }

    private func enterCompareMode() async {
        isStylePopoverOpen = false
        isContextMenuOpen = false
        isEditingCopy = false
        bridge.endInlineCopyEdit()

        if !activeLiveEdits.isEmpty, bridge.webView != nil {
            liveTweakSnapshot = await bridge.captureSnapshot(cropRectFrac: nil)?.image
        } else {
            liveTweakSnapshot = nil
        }

        if let pair = resolveCompareImages(),
           let bCG = pair.before.cgImage(forProposedRect: nil, context: nil, hints: nil),
           let aCG = pair.after.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            visualDiff = CanvasVisualDiff.compare(before: bCG, after: aCG)
        } else {
            visualDiff = nil
        }
        viewMode = .compare
    }

    private var compareFloatingControlBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                ForEach(CompareSubMode.allCases) { sub in
                    let active = compareSubMode == sub
                    Button {
                        compareSubMode = sub
                    } label: {
                        Text(sub.rawValue)
                            .font(.system(size: 11, weight: active ? .semibold : .regular))
                            .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .padding(.horizontal, 9)
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

            if let diff = visualDiff {
                HStack(spacing: 5) {
                    Circle()
                        .fill(diff.isIdentical ? ToolrollPalette.muted : ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(diff.isIdentical ? "Identical (0.0%)" : String(format: "%.1f%% changed", diff.changedPercent))
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(diff.isIdentical ? ToolrollPalette.muted : ToolrollPalette.ink)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            Button("Set as Baseline") {
                if store.setArtboardBaselineCheckpoint(boardId: board.id) {
                    flashFeedback("Locked current screen as Before baseline")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Lock the current snapshot as this screen's Before checkpoint")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .toolrollGlassCapsule(interactive: true)
    }

    @ViewBuilder
    private func focusCompareView(
        before: NSImage,
        after: NSImage,
        beforeLabel: String,
        afterLabel: String,
        width: CGFloat,
        height: CGFloat
    ) -> some View {
        switch compareSubMode {
        case .wipe:
            let splitX = CGFloat(compareSplit) * width
            ZStack(alignment: .topLeading) {
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

                // Center drag pill handle
                Capsule()
                    .fill(ToolrollPalette.ink)
                    .frame(width: 22, height: 34)
                    .overlay(
                        Image(systemName: "chevron.left.chevron.right")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(ToolrollPalette.inverseInk)
                    )
                    .position(x: splitX, y: height / 2)

                HStack {
                    compareBadge(beforeLabel)
                    Spacer()
                    compareBadge(afterLabel)
                }
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

        case .sideBySide:
            let halfW = max(120, (width - 10) / 2)
            HStack(spacing: 10) {
                ZStack(alignment: .topLeading) {
                    Image(nsImage: before)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: halfW, height: height)
                    compareBadge(beforeLabel).padding(8)
                }
                .background(ToolrollPalette.codeBg)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                ZStack(alignment: .topLeading) {
                    Image(nsImage: after)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: halfW, height: height)
                    compareBadge(afterLabel).padding(8)
                }
                .background(ToolrollPalette.codeBg)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .frame(width: width, height: height)

        case .pixelDiff:
            ZStack(alignment: .topLeading) {
                Image(nsImage: after)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: width, height: height)
                    .opacity(0.68)

                if let heatCG = visualDiff?.heatmapImage {
                    Image(nsImage: NSImage(cgImage: heatCG, size: NSSize(width: heatCG.width, height: heatCG.height)))
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: width, height: height)
                }

                HStack {
                    compareBadge("PIXEL DIFF · \(beforeLabel) → \(afterLabel)")
                    Spacer()
                    if let diff = visualDiff, diff.isIdentical {
                        compareBadge("NO VISUAL CHANGE YET")
                    }
                }
                .padding(10)
            }
            .frame(width: width, height: height)
        }
    }

    private func compareBadge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(ToolrollPalette.ink)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(ToolrollPalette.paper.opacity(0.92), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    // MARK: - Right Edit & Task Creation Rail

    private var inspectorRail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 11) {
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

                    // Rich Element Context Card (or whole-screen prompt)
                    elementContextCard

                    // Element-aware quick intent chips (when an element is selected)
                    if let el = selectedElement {
                        quickIntentChipsSection(for: el)
                    }

                    // Native macOS segmented kind switcher: UI Change vs Options (A/B/C/D)
                    Picker("", selection: $selectedKind) {
                        Text("UI Change").tag(CanvasPinKind.change)
                        Text("Options (A/B/C/D)").tag(CanvasPinKind.options)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    // Multiline prompt input
                    TextField(
                        selectedKind == .options
                            ? "Ask Toolroll to propose 2–4 visual options for this area…"
                            : (activeLiveEdits.isEmpty
                                ? "Describe the visual change, copy tweak, or fix…"
                                : "Optional note (your \(activeLiveEdits.count) live edit(s) attach automatically)…"),
                        text: $taskPrompt,
                        axis: .vertical
                    )
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(3...7)
                    .padding(10)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))

                    // Native macOS segmented cadence switcher: Plan first vs Just code
                    Picker("", selection: $planFirst) {
                        Text("Plan first").tag(true)
                        Text("Just code").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    HStack(spacing: 8) {
                        Button("Add to Batch") {
                            submitFromFocus(fileImmediately: false)
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                        .disabled(!canSubmitTask)

                        Spacer()

                        Button("File Task (⌘↵)") {
                            submitFromFocus(fileImmediately: true)
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .keyboardShortcut(.return, modifiers: [.command])
                        .disabled(!canSubmitTask)
                    }
                }
                .padding(15)

                // Pending Live Visual Edits diff stack (when user made live copy/style/hide tweaks)
                if !activeLiveEdits.isEmpty {
                    HairlineDivider()
                    pendingLiveEditsSection
                }

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
                    .padding(.horizontal, 15)
                    .padding(.top, 12)

                    if pinsOnScreen.isEmpty {
                        Text("No feedback pinned on \(board.route) yet. Click any element to inspect, tweak live, or describe what to change.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.horizontal, 15)
                            .padding(.bottom, 16)
                    } else {
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

    @ViewBuilder
    private var elementContextCard: some View {
        if let el = selectedElement {
            VStack(alignment: .leading, spacing: 7) {
                // Clickable DOM Ancestor Breadcrumb
                if el.ancestors.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 3) {
                            ForEach(Array(el.ancestors.enumerated()), id: \.element.id) { idx, anc in
                                let isCurrent = anc.depthFromSelected == 0
                                if idx > 0 {
                                    Text("›")
                                        .font(.system(size: 10))
                                        .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                                }
                                Button {
                                    if !isCurrent {
                                        bridge.selectAncestor(elId: el.elId, depth: anc.depthFromSelected)
                                    }
                                } label: {
                                    Text(anc.label)
                                        .font(.system(size: 10, weight: isCurrent ? .semibold : .regular, design: .monospaced))
                                        .foregroundStyle(isCurrent ? ToolrollPalette.ink : ToolrollPalette.muted)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 2)
                                        .background(isCurrent ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 3))
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .help(isCurrent ? "Current selection" : "Select ancestor \(anc.label)")
                            }
                        }
                    }
                }

                // Identity + size + Clear
                HStack(spacing: 6) {
                    Image(systemName: categoryIcon(for: el.category))
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.live)
                    Text(el.displayName)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    Text("\(el.metrics.width)×\(el.metrics.height)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                    Spacer()
                    Button("Clear") {
                        selectedElement = nil
                        pinnedPoint = nil
                        isStylePopoverOpen = false
                        isContextMenuOpen = false
                        isEditingCopy = false
                        bridge.clearSelection()
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .buttonStyle(.plain)
                }

                if !el.textExcerpt.isEmpty {
                    Text("“\(el.textExcerpt)”")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }

                // Measured computed style spec chips
                HStack(spacing: 5) {
                    specChip("\(Int(el.metrics.fontSize.rounded()))px/\(el.metrics.fontWeight)")
                    specChip("pad \(Int(el.metrics.padding.rounded()))")
                    if el.metrics.borderRadius > 0 {
                        specChip("r \(Int(el.metrics.borderRadius.rounded()))")
                    }
                    if el.metrics.gap > 0 {
                        specChip("gap \(Int(el.metrics.gap.rounded()))")
                    }
                    Spacer()
                }

                // Matched local repo source file (clickable!)
                if let file = el.file {
                    Button {
                        openSourceFile(file)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 10))
                            Text(el.line.map { "\(file):\($0)" } ?? file)
                                .font(.system(size: 10.5, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9))
                        }
                        .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                    .help("Open source file")
                }
            }
            .padding(10)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        } else if let pt = pinnedPoint {
            HStack(spacing: 6) {
                Image(systemName: "mappin.circle.fill")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.live)
                Text("Pinned at \(Int(pt.x * 100))%, \(Int(pt.y * 100))%")
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button("Clear") { pinnedPoint = nil }
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        } else {
            HStack(spacing: 6) {
                Image(systemName: "viewfinder")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(viewMode == .live ? "Click any element on the screen to target or right-click" : "Whole screen · click image to target a spot")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
        }
    }

    private func specChip(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9.5, design: .monospaced))
            .foregroundStyle(ToolrollPalette.muted)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 3))
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func quickIntentChipsSection(for el: SelectedElementContext) -> some View {
        let chips = el.category.quickChips
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 5), GridItem(.flexible(), spacing: 5)], spacing: 5) {
            ForEach(chips) { chip in
                Button {
                    if chip.isOptions {
                        selectedKind = .options
                    } else {
                        selectedKind = .change
                    }
                    if taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        taskPrompt = chip.prompt
                    } else if !taskPrompt.contains(chip.prompt) {
                        taskPrompt += "\n\(chip.prompt)"
                    }
                } label: {
                    Text(chip.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var pendingLiveEditsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("LIVE EDITS (\(activeLiveEdits.count))")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .tracking(0.7)
                    .foregroundStyle(ToolrollPalette.live)
                Spacer()
                Button("Reset all") {
                    bridge.resetAll()
                    pendingEdits.removeAll()
                }
                .font(.system(size: 10.5))
                .foregroundStyle(ToolrollPalette.muted)
                .buttonStyle(.plain)
            }

            ForEach(activeLiveEdits) { edit in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(edit.elementLabel)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                            .lineLimit(1)
                        Spacer()
                        Button("Undo") {
                            resetEdits(for: edit.id)
                        }
                        .font(.system(size: 10))
                        .foregroundStyle(ToolrollPalette.muted)
                        .buttonStyle(.plain)
                    }
                    ForEach(edit.summaryLines, id: \.self) { line in
                        Text("Δ \(line)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(8)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 12)
    }

    // MARK: - Actions & Helpers

    private func handleElementSelected(_ ctx: SelectedElementContext, openContextMenu: Bool) {
        var enriched = ctx
        if enriched.file == nil, let root = store.canvasProjectRoot {
            if let found = YouiCanvasStorage.findSourceFile(
                projectRoot: root,
                testId: enriched.testId,
                textExcerpt: enriched.textExcerpt,
                selector: enriched.selector
            ) {
                enriched.file = found.file
                enriched.line = found.line
            } else {
                enriched.file = board.sourceFile
            }
        }
        selectedElement = enriched
        pinnedPoint = CGPoint(x: enriched.clickXFrac, y: enriched.clickYFrac)
        isEditingCopy = false
        if openContextMenu {
            isStylePopoverOpen = false
            contextMenuAnchorFrac = CGPoint(x: enriched.clickXFrac, y: enriched.clickYFrac)
            isContextMenuOpen = true
        } else {
            isContextMenuOpen = false
        }
    }

    private func handleInlineTextChanged(elId: String, newText: String, finished: Bool) {
        if let el = selectedElement, el.elId == elId {
            mutateEdit(for: el) { edit in
                edit.editedText = newText.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if finished {
            isEditingCopy = false
        }
    }

    private func selectParentElement(of el: SelectedElementContext) {
        guard el.hasParent else { return }
        isEditingCopy = false
        bridge.endInlineCopyEdit()
        bridge.selectAncestor(elId: el.elId, depth: 1)
    }

    private func toggleHideElement(_ el: SelectedElementContext) {
        let nextHidden = !(pendingEdits[el.elId]?.isHidden ?? false)
        mutateEdit(for: el) { $0.isHidden = nextHidden }
        bridge.setHidden(elId: el.elId, hidden: nextHidden)
    }

    private func mutateEdit(for el: SelectedElementContext, _ update: (inout ElementLiveEdit) -> Void) {
        var entry = pendingEdits[el.elId] ?? ElementLiveEdit(from: el)
        update(&entry)
        if entry.hasChanges {
            pendingEdits[el.elId] = entry
        } else {
            pendingEdits.removeValue(forKey: el.elId)
        }
    }

    private func resetEdits(for elId: String) {
        bridge.resetElement(elId: elId)
        pendingEdits.removeValue(forKey: elId)
        isEditingCopy = false
    }

    private func openSourceFile(_ relPath: String) {
        let fullPath: String
        if relPath.hasPrefix("/") {
            fullPath = relPath
        } else if let root = store.canvasProjectRoot {
            fullPath = "\(root)/\(relPath)"
        } else {
            fullPath = relPath
        }
        let url = URL(fileURLWithPath: fullPath)
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(relPath, forType: .string)
            flashFeedback("Copied \(relPath)")
        }
    }

    private func flashFeedback(_ message: String) {
        copiedFeedback = message
        Task {
            try? await Task.sleep(for: .seconds(1.8))
            if copiedFeedback == message {
                copiedFeedback = nil
            }
        }
    }

    private func categoryIcon(for category: ElementCategory) -> String {
        switch category {
        case .text: return "textformat"
        case .button: return "capsule.inset.filled"
        case .input: return "rectangle.and.pencil.and.ellipsis"
        case .image: return "photo"
        case .card: return "rectangle.inset.filled"
        case .container: return "square.dashed"
        }
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

            if let shotRel = pin.screenshotPath,
               let root = store.canvasProjectRoot,
               let thumb = CanvasImageCache.shared.image(atPath: "\(root)/\(shotRel)", maxPixelDimension: 420) {
                Image(nsImage: thumb)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: 84, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
        .padding(10)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private func submitFromFocus(fileImmediately: Bool) {
        let userNote = taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let edits = activeLiveEdits
        guard !userNote.isEmpty || !edits.isEmpty else { return }

        var parts: [String] = []
        if !userNote.isEmpty {
            parts.append(userNote)
        }
        if !edits.isEmpty {
            let diffSummary = edits.map { "• " + $0.formattedForTask() }.joined(separator: "\n")
            parts.append("Visual tweaks previewed on \(board.route):\n\(diffSummary)")
        }
        let combinedBody = parts.joined(separator: "\n\n")

        let pt = pinnedPoint ?? CGPoint(x: 0.5, y: 0.35)
        let capturedEl = selectedElement
        let elName = capturedEl?.displayName ?? edits.first?.elementLabel
        let elSel = capturedEl?.selector ?? edits.first?.selector
        let elFile = capturedEl?.file ?? edits.first?.file ?? board.sourceFile
        let elLine = capturedEl?.line ?? edits.first?.line
        let shouldPlan = planFirst
        let shouldCropShot = (viewMode == .live && capturedEl != nil && bridge.webView != nil)
        let cropFrac: CGRect? = capturedEl.map {
            CGRect(x: $0.rectXFrac, y: $0.rectYFrac, width: $0.rectWFrac, height: $0.rectHFrac)
        }

        taskPrompt = ""
        isStylePopoverOpen = false
        isContextMenuOpen = false
        isEditingCopy = false
        pendingEdits.removeAll()

        Task {
            var shotData: Data? = nil
            if shouldCropShot {
                shotData = await bridge.captureSnapshot(cropRectFrac: cropFrac)?.pngData
            }
            await store.createCanvasPin(
                route: board.route,
                path: board.path,
                xFrac: Double(pt.x),
                yFrac: Double(pt.y),
                kind: selectedKind,
                body: combinedBody,
                elementName: elName,
                elementSelector: elSel,
                elementFile: elFile,
                elementLine: elLine,
                screenshotPNG: shotData,
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

// MARK: - Bidirectional Swift ↔ WKWebView Bridge

@MainActor
final class FocusWebBridge {
    weak var webView: WKWebView?

    private func jsString(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }

    func selectAncestor(elId: String, depth: Int) {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.selectAncestor(\(jsString(elId)), \(depth));", completionHandler: nil)
    }

    func beginInlineCopyEdit(elId: String) {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.beginCopyEdit(\(jsString(elId)));", completionHandler: nil)
    }

    func endInlineCopyEdit() {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.endCopyEdit();", completionHandler: nil)
    }

    func applyStyleTweak(elId: String, property: String, value: String) {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.applyStyle(\(jsString(elId)), \(jsString(property)), \(jsString(value)));", completionHandler: nil)
    }

    func setHidden(elId: String, hidden: Bool) {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.setHidden(\(jsString(elId)), \(hidden ? "true" : "false"));", completionHandler: nil)
    }

    func resetElement(elId: String) {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.resetElement(\(jsString(elId)));", completionHandler: nil)
    }

    func resetAll() {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.resetAll();", completionHandler: nil)
    }

    func clearSelection() {
        webView?.evaluateJavaScript("window.__trFocus && window.__trFocus.clearSelection();", completionHandler: nil)
    }

    /// Captures a clean PNG snapshot (hiding inspector highlight boxes temporarily).
    /// Pass `cropRectFrac` (`0...1` normalized bounds) to capture a cropped element thumbnail with breathing margin.
    func captureSnapshot(cropRectFrac: CGRect?) async -> (image: NSImage, pngData: Data)? {
        guard let webView else { return nil }
        _ = try? await webView.evaluateJavaScript("window.__trFocus && window.__trFocus.setBoxesHidden(true);")
        defer {
            webView.evaluateJavaScript("window.__trFocus && window.__trFocus.setBoxesHidden(false);", completionHandler: nil)
        }

        let config = WKSnapshotConfiguration()
        let bounds = webView.bounds
        if let frac = cropRectFrac, bounds.width > 0, bounds.height > 0 {
            let pad: CGFloat = 24
            let x = max(0, frac.origin.x * bounds.width - pad)
            let y = max(0, frac.origin.y * bounds.height - pad)
            let w = min(bounds.width - x, max(80, frac.size.width * bounds.width + pad * 2))
            let h = min(bounds.height - y, max(48, frac.size.height * bounds.height + pad * 2))
            config.rect = CGRect(x: x, y: y, width: w, height: h)
        } else {
            config.rect = bounds
        }

        return await withCheckedContinuation { continuation in
            webView.takeSnapshot(with: config) { image, _ in
                guard let image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:])
                else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: (image, png))
            }
        }
    }
}

// MARK: - Live WebView inside Focus Lightbox (DOM Inspector + Right-Click + Live Mutations)

private struct FocusLiveWebView: NSViewRepresentable {
    let bridge: FocusWebBridge
    let urlString: String
    let logicalWidth: Double
    let logicalHeight: Double
    let sessionCookie: (name: String, value: String, origin: String)?
    let inspectorEnabled: Bool
    let onElementSelected: (SelectedElementContext, Bool) -> Void
    let onInlineTextChanged: (String, String, Bool) -> Void

    private static let script = """
    (function() {
      if (window.__trFocus) return;
      window.__trFocusInspectOn = true;

      var counter = 0;
      var selectedEl = null;
      var editingEl = null;
      var originals = new Map();

      var hoverBox = document.createElement('div');
      hoverBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:1px dashed rgba(13,116,206,0.75);background:rgba(13,116,206,0.05);display:none;box-sizing:border-box;border-radius:2px;';
      document.documentElement.appendChild(hoverBox);

      var selectBox = document.createElement('div');
      selectBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:1.5px solid #0d74ce;background:rgba(13,116,206,0.08);display:none;box-sizing:border-box;border-radius:2px;';
      document.documentElement.appendChild(selectBox);

      function ensureId(el) {
        if (!el.dataset.trElId) {
          counter += 1;
          el.dataset.trElId = 'tr-el-' + counter;
        }
        return el.dataset.trElId;
      }

      function saveOriginal(el) {
        var id = ensureId(el);
        if (!originals.has(id)) {
          originals.set(id, {
            text: el.textContent || '',
            style: el.getAttribute('style')
          });
        }
      }

      function classHint(el) {
        if (!el || !el.className || typeof el.className !== 'string') return '';
        var tokens = el.className.trim().split(/\\s+/).filter(function(c) {
          return c && c.length >= 2 && c.indexOf(':') === -1 && !/^(flex|grid|block|inline|relative|absolute|w-|h-|p-|px-|py-|m-|mx-|my-|text-|bg-|border|rounded|items-|justify-|gap-)/.test(c);
        });
        return tokens.length ? '.' + tokens[0] : '';
      }

      function reactInfo(el) {
        var comp = null, file = null, line = null;
        if (!el) return { comp: null, file: null, line: null };
        var fk = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fk && el[fk]) {
          var cur = el[fk];
          for (var i = 0; i < 10 && cur; i++) {
            if (!file && cur._debugSource) {
              file = cur._debugSource.fileName || null;
              line = cur._debugSource.lineNumber || null;
            }
            if (!comp && cur.type && typeof cur.type === 'function' && cur.type.name && cur.type.name.length > 1) {
              comp = cur.type.name;
            }
            cur = cur.return;
          }
        }
        return { comp: comp, file: file, line: line };
      }

      function nodeLabel(el) {
        if (!el || el.nodeType !== 1) return '';
        var ri = reactInfo(el);
        if (ri.comp) return ri.comp;
        var tid = el.getAttribute('data-testid');
        if (tid) return tid;
        var aria = el.getAttribute('aria-label');
        if (aria && aria.length <= 24) return aria;
        var tag = el.tagName.toLowerCase();
        if (el.id) return tag + '#' + el.id;
        return tag + classHint(el);
      }

      function buildSelector(el) {
        var tag = el.tagName.toLowerCase();
        if (el.id) return tag + '#' + el.id;
        var tid = el.getAttribute('data-testid');
        if (tid) return '[data-testid="' + tid + '"]';
        var cls = (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '');
        return cls ? (tag + '.' + cls) : tag;
      }

      function classify(el) {
        var tag = el.tagName.toLowerCase();
        var role = (el.getAttribute('role') || '').toLowerCase();
        if (tag === 'button' || tag === 'a' || role === 'button') return 'button';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
        if (tag === 'img' || tag === 'svg' || tag === 'video' || tag === 'picture' || tag === 'canvas') return 'image';
        if (/^(h[1-6]|p|span|label|code|pre|strong|em|small|time)$/.test(tag)) return 'text';
        if (el.children.length === 0 && (el.textContent || '').trim().length > 0) return 'text';
        var cs = window.getComputedStyle(el);
        var hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) >= 4;
        if (tag === 'article' || tag === 'li' || tag === 'section' || hasBorder) return 'card';
        return 'container';
      }

      function positionBox(box, el) {
        if (!el || !el.isConnected) { box.style.display = 'none'; return; }
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { box.style.display = 'none'; return; }
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        box.style.display = 'block';
      }

      function emitSelection(el, clickX, clickY, openMenu) {
        if (!el || el === hoverBox || el === selectBox) return;
        selectedEl = el;
        var id = ensureId(el);
        positionBox(selectBox, el);

        var r = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        var ri = reactInfo(el);
        var vw = Math.max(1, window.innerWidth);
        var vh = Math.max(1, window.innerHeight);

        var ancestors = [];
        var walk = el;
        for (var d = 0; d < 5 && walk && walk.nodeType === 1 && walk.tagName.toLowerCase() !== 'html'; d++) {
          ancestors.unshift({
            depth: d,
            label: nodeLabel(walk),
            tag: walk.tagName.toLowerCase()
          });
          if (walk.tagName.toLowerCase() === 'body') break;
          walk = walk.parentElement;
        }

        var rawText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        var excerpt = rawText.length > 90 ? rawText.slice(0, 90) + '…' : rawText;

        window.webkit.messageHandlers.trFocusInspect.postMessage({
          elId: id,
          displayName: nodeLabel(el),
          tag: el.tagName.toLowerCase(),
          selector: buildSelector(el),
          testId: el.getAttribute('data-testid') || null,
          textExcerpt: excerpt,
          category: classify(el),
          file: ri.file,
          line: ri.line,
          ancestors: ancestors,
          width: Math.round(r.width),
          height: Math.round(r.height),
          padding: parseFloat(cs.paddingTop) || 0,
          gap: parseFloat(cs.gap) || parseFloat(cs.rowGap) || 0,
          fontSize: parseFloat(cs.fontSize) || 14,
          fontWeight: parseInt(cs.fontWeight, 10) || 400,
          borderRadius: parseFloat(cs.borderTopLeftRadius) || 0,
          opacity: parseFloat(cs.opacity),
          display: cs.display || 'block',
          color: cs.color || '',
          backgroundColor: cs.backgroundColor || '',
          rectXFrac: r.left / vw,
          rectYFrac: r.top / vh,
          rectWFrac: r.width / vw,
          rectHFrac: r.height / vh,
          clickXFrac: (clickX != null ? clickX : (r.left + r.width / 2)) / vw,
          clickYFrac: (clickY != null ? clickY : (r.top + r.height / 2)) / vh,
          openMenu: !!openMenu
        });
      }

      document.addEventListener('mousemove', function(e) {
        if (!window.__trFocusInspectOn || e.altKey || editingEl) {
          hoverBox.style.display = 'none';
          return;
        }
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === hoverBox || el === selectBox || el === selectedEl) {
          hoverBox.style.display = 'none';
          return;
        }
        positionBox(hoverBox, el);
      }, true);

      document.addEventListener('click', function(e) {
        if (!window.__trFocusInspectOn || e.altKey) return;
        if (editingEl && editingEl.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (editingEl) window.__trFocus.endCopyEdit();
        var el = document.elementFromPoint(e.clientX, e.clientY);
        emitSelection(el, e.clientX, e.clientY, false);
      }, true);

      document.addEventListener('contextmenu', function(e) {
        if (!window.__trFocusInspectOn || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (editingEl) window.__trFocus.endCopyEdit();
        var el = document.elementFromPoint(e.clientX, e.clientY);
        emitSelection(el, e.clientX, e.clientY, true);
      }, true);

      window.addEventListener('scroll', function() {
        if (selectedEl) positionBox(selectBox, selectedEl);
      }, true);

      function findById(elId) {
        return document.querySelector('[data-tr-el-id="' + elId + '"]');
      }

      window.__trFocus = {
        selectAncestor: function(elId, depth) {
          var el = findById(elId);
          for (var i = 0; i < depth && el && el.parentElement && el.parentElement.tagName.toLowerCase() !== 'html'; i++) {
            el = el.parentElement;
          }
          if (el) emitSelection(el, null, null, false);
        },
        beginCopyEdit: function(elId) {
          var el = findById(elId);
          if (!el) return;
          if (editingEl && editingEl !== el) window.__trFocus.endCopyEdit();
          saveOriginal(el);
          editingEl = el;
          hoverBox.style.display = 'none';
          el.contentEditable = 'true';
          el.style.outline = '2px solid #0d74ce';
          el.style.outlineOffset = '2px';
          el.focus();

          el.__trOnInput = function() {
            positionBox(selectBox, el);
            window.webkit.messageHandlers.trFocusTextEdit.postMessage({
              elId: elId,
              text: (el.innerText || el.textContent || ''),
              finished: false
            });
          };
          el.__trOnKeyDown = function(ev) {
            if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) {
              ev.preventDefault();
              window.__trFocus.endCopyEdit();
            }
          };
          el.__trOnBlur = function() {
            window.__trFocus.endCopyEdit();
          };
          el.addEventListener('input', el.__trOnInput);
          el.addEventListener('keydown', el.__trOnKeyDown);
          el.addEventListener('blur', el.__trOnBlur);
        },
        endCopyEdit: function() {
          if (!editingEl) return;
          var el = editingEl;
          var elId = el.dataset.trElId || '';
          editingEl = null;
          el.contentEditable = 'false';
          el.style.outline = '';
          el.style.outlineOffset = '';
          if (el.__trOnInput) el.removeEventListener('input', el.__trOnInput);
          if (el.__trOnKeyDown) el.removeEventListener('keydown', el.__trOnKeyDown);
          if (el.__trOnBlur) el.removeEventListener('blur', el.__trOnBlur);
          positionBox(selectBox, el);
          window.webkit.messageHandlers.trFocusTextEdit.postMessage({
            elId: elId,
            text: (el.innerText || el.textContent || ''),
            finished: true
          });
        },
        applyStyle: function(elId, prop, val) {
          var el = findById(elId);
          if (!el) return;
          saveOriginal(el);
          el.style[prop] = val;
          if (selectedEl === el) positionBox(selectBox, el);
        },
        setHidden: function(elId, hidden) {
          var el = findById(elId);
          if (!el) return;
          saveOriginal(el);
          if (hidden) {
            el.style.display = 'none';
            if (selectedEl === el) selectBox.style.display = 'none';
          } else {
            var orig = originals.get(elId);
            el.style.display = '';
            if (orig && orig.style == null) el.removeAttribute('style');
            if (selectedEl === el) positionBox(selectBox, el);
          }
        },
        resetElement: function(elId) {
          var el = findById(elId);
          var orig = originals.get(elId);
          if (!el || !orig) return;
          if (editingEl === el) window.__trFocus.endCopyEdit();
          if (orig.style == null) { el.removeAttribute('style'); } else { el.setAttribute('style', orig.style); }
          if ((el.textContent || '') !== orig.text && el.children.length === 0) {
            el.textContent = orig.text;
          }
          originals.delete(elId);
          if (selectedEl === el) positionBox(selectBox, el);
        },
        resetAll: function() {
          Array.from(originals.keys()).forEach(function(id) {
            window.__trFocus.resetElement(id);
          });
        },
        clearSelection: function() {
          if (editingEl) window.__trFocus.endCopyEdit();
          selectedEl = null;
          selectBox.style.display = 'none';
          hoverBox.style.display = 'none';
        },
        setBoxesHidden: function(hidden) {
          if (hidden) {
            selectBox.style.visibility = 'hidden';
            hoverBox.style.visibility = 'hidden';
          } else {
            selectBox.style.visibility = 'visible';
            hoverBox.style.visibility = 'visible';
          }
        }
      };
    })();
    """

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onElementSelected: onElementSelected,
            onInlineTextChanged: onInlineTextChanged
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "trFocusInspect")
        config.userContentController.add(context.coordinator, name: "trFocusTextEdit")
        config.userContentController.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        bridge.webView = webView
        context.coordinator.load(webView: webView, urlString: urlString, cookie: sessionCookie)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        bridge.webView = webView
        context.coordinator.onElementSelected = onElementSelected
        context.coordinator.onInlineTextChanged = onInlineTextChanged
        if context.coordinator.loadedURL != urlString {
            context.coordinator.load(webView: webView, urlString: urlString, cookie: sessionCookie)
        }
        webView.evaluateJavaScript("window.__trFocusInspectOn = \(inspectorEnabled ? "true" : "false");", completionHandler: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        var loadedURL: String = ""
        var onElementSelected: (SelectedElementContext, Bool) -> Void
        var onInlineTextChanged: (String, String, Bool) -> Void

        init(
            onElementSelected: @escaping (SelectedElementContext, Bool) -> Void,
            onInlineTextChanged: @escaping (String, String, Bool) -> Void
        ) {
            self.onElementSelected = onElementSelected
            self.onInlineTextChanged = onInlineTextChanged
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
            if message.name == "trFocusTextEdit", let dict = message.body as? [String: Any] {
                let elId = (dict["elId"] as? String) ?? ""
                let text = (dict["text"] as? String) ?? ""
                let finished = (dict["finished"] as? Bool) ?? false
                onInlineTextChanged(elId, text, finished)
                return
            }

            guard message.name == "trFocusInspect",
                  let dict = message.body as? [String: Any]
            else { return }

            let rawAncestors = (dict["ancestors"] as? [[String: Any]]) ?? []
            let ancestors = rawAncestors.compactMap { item -> ElementAncestorRef? in
                guard let depth = item["depth"] as? Int,
                      let label = item["label"] as? String,
                      let tag = item["tag"] as? String
                else { return nil }
                return ElementAncestorRef(depthFromSelected: depth, label: label, tag: tag)
            }

            let opacityVal: Double = {
                if let d = dict["opacity"] as? Double, d.isFinite { return d }
                return 1.0
            }()

            let metrics = ElementStyleMetrics(
                width: (dict["width"] as? Int) ?? Int((dict["width"] as? Double) ?? 0),
                height: (dict["height"] as? Int) ?? Int((dict["height"] as? Double) ?? 0),
                padding: (dict["padding"] as? Double) ?? 0,
                gap: (dict["gap"] as? Double) ?? 0,
                fontSize: (dict["fontSize"] as? Double) ?? 14,
                fontWeight: (dict["fontWeight"] as? Int) ?? 400,
                borderRadius: (dict["borderRadius"] as? Double) ?? 0,
                opacity: opacityVal,
                display: (dict["display"] as? String) ?? "block",
                color: (dict["color"] as? String) ?? "",
                backgroundColor: (dict["backgroundColor"] as? String) ?? ""
            )

            let ctx = SelectedElementContext(
                elId: (dict["elId"] as? String) ?? UUID().uuidString,
                displayName: (dict["displayName"] as? String) ?? "element",
                tag: (dict["tag"] as? String) ?? "div",
                selector: (dict["selector"] as? String) ?? "div",
                testId: dict["testId"] as? String,
                textExcerpt: (dict["textExcerpt"] as? String) ?? "",
                category: ElementCategory(rawValue: (dict["category"] as? String) ?? "container") ?? .container,
                file: dict["file"] as? String,
                line: dict["line"] as? Int,
                ancestors: ancestors,
                metrics: metrics,
                rectXFrac: (dict["rectXFrac"] as? Double) ?? 0.25,
                rectYFrac: (dict["rectYFrac"] as? Double) ?? 0.25,
                rectWFrac: (dict["rectWFrac"] as? Double) ?? 0.2,
                rectHFrac: (dict["rectHFrac"] as? Double) ?? 0.1,
                clickXFrac: (dict["clickXFrac"] as? Double) ?? 0.5,
                clickYFrac: (dict["clickYFrac"] as? Double) ?? 0.5
            )
            let openMenu = (dict["openMenu"] as? Bool) ?? false
            onElementSelected(ctx, openMenu)
        }
    }
}
