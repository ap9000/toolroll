import AppKit
import ImageIO
import Observation
import SwiftUI
import ToolrollCore

@MainActor
@Observable
public final class WorkspaceThemeEngine {
    public static let shared = WorkspaceThemeEngine()

    public private(set) var config: WorkspaceAppearanceConfig
    private var dirFD: Int32 = -1
    private var watchSource: DispatchSourceFileSystemObject?

    private init() {
        self.config = WorkspaceThemeStore.load()
        startWatchingConfigDirectory()
    }

    public func reload() {
        let next = WorkspaceThemeStore.load()
        if next != config {
            config = next
        }
    }

    public func apply(
        theme: String? = nil,
        density: String? = nil,
        listSide: String? = nil,
        showCosts: Bool? = nil,
        glassChrome: Bool? = nil,
        sidebarVibrancy: Bool? = nil,
        notifyAsks: Bool? = nil,
        notifyFinished: Bool? = nil
    ) {
        WorkspaceThemeStore.savePreferences(
            theme: theme,
            density: density,
            listSide: listSide,
            showCosts: showCosts,
            glassChrome: glassChrome,
            sidebarVibrancy: sidebarVibrancy,
            notifyAsks: notifyAsks,
            notifyFinished: notifyFinished
        )
        reload()
    }

    public func resetToSignal() {
        apply(
            theme: "signal",
            density: "comfortable",
            listSide: "left",
            showCosts: true,
            glassChrome: false,
            sidebarVibrancy: false
        )
    }

    public var snappyAnimation: Animation? {
        config.reducedMotion ? nil : .snappy(duration: 0.16)
    }

    public var preferredColorScheme: ColorScheme? {
        if let custom = config.effectiveCustomPalette {
            switch custom.base.lowercased() {
            case "light": return .light
            case "dark", "high-contrast": return .dark
            default: return nil
            }
        }
        switch config.activeTheme.lowercased() {
        case "light": return .light
        case "dark", "high-contrast": return .dark
        default: return nil
        }
    }

    private func startWatchingConfigDirectory() {
        let dirURL = WorkspaceThemeStore.configDirectoryURL
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        let fd = open(dirURL.path, O_EVTONLY)
        guard fd >= 0 else { return }
        dirFD = fd
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .extend, .attrib],
            queue: .main
        )
        src.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                self?.reload()
            }
        }
        src.setCancelHandler {
            close(fd)
        }
        watchSource = src
        src.resume()
    }
}

@MainActor
public enum ToolrollPalette {
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hex = isDark ? dark : light
            let r = CGFloat((hex >> 16) & 0xFF) / 255.0
            let g = CGFloat((hex >> 8) & 0xFF) / 255.0
            let b = CGFloat(hex & 0xFF) / 255.0
            return NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
        })
    }

    private static func fromHex(_ raw: String?) -> Color? {
        guard let rgb = WorkspaceThemeStore.parseHex(raw) else { return nil }
        return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
    }

    private static var custom: CustomThemePalette? {
        WorkspaceThemeEngine.shared.config.effectiveCustomPalette
    }

    private static var isHighContrast: Bool {
        WorkspaceThemeEngine.shared.config.activeTheme.lowercased() == "high-contrast"
    }

    public static var ground: Color {
        fromHex(custom?.ground) ?? dynamic(light: 0xEFEFEF, dark: isHighContrast ? 0x000000 : 0x0B0B0B)
    }
    public static var paper: Color {
        fromHex(custom?.paper) ?? dynamic(light: 0xFFFFFF, dark: isHighContrast ? 0x080808 : 0x161616)
    }
    public static var raised: Color {
        fromHex(custom?.raised ?? custom?.fill) ?? dynamic(light: 0xF5F5F5, dark: isHighContrast ? 0x141414 : 0x1C1C1C)
    }
    public static var ink: Color {
        fromHex(custom?.ink) ?? dynamic(light: 0x171717, dark: isHighContrast ? 0xFFFFFF : 0xEDEDED)
    }
    public static var inverseInk: Color {
        fromHex(custom?.selectionInk ?? custom?.ground) ?? dynamic(light: 0xFFFFFF, dark: 0x0B0B0B)
    }
    public static var muted: Color {
        fromHex(custom?.muted) ?? dynamic(light: 0x666666, dark: isHighContrast ? 0xCCCCCC : 0xA1A1A1)
    }
    public static var line: Color {
        fromHex(custom?.line).map { $0.opacity(0.45) } ?? dynamic(light: 0xE6E6E6, dark: isHighContrast ? 0x525252 : 0x262626)
    }
    public static var inputLine: Color {
        fromHex(custom?.line).map { $0.opacity(0.75) } ?? dynamic(light: 0xD4D4D4, dark: isHighContrast ? 0x7A7A7A : 0x363636)
    }
    public static var live: Color {
        fromHex(custom?.live ?? custom?.selection) ?? dynamic(light: 0x0D74CE, dark: 0x70B8FF)
    }
    public static var success: Color {
        fromHex(custom?.success) ?? dynamic(light: 0x218358, dark: 0x3DD68C)
    }
    public static var danger: Color {
        fromHex(custom?.danger) ?? dynamic(light: 0xC4320A, dark: 0xFF977D)
    }
    public static var warning: Color {
        fromHex(custom?.warning) ?? dynamic(light: 0xAB6400, dark: 0xFFCA16)
    }
    public static var codeBg: Color {
        fromHex(custom?.ground) ?? dynamic(light: 0xFAFAFA, dark: isHighContrast ? 0x040404 : 0x111111)
    }
    public static var composer: Color {
        fromHex(custom?.fill ?? custom?.raised) ?? dynamic(light: 0xF2F2F2, dark: 0x242424)
    }
    public static var selection: Color {
        if let sel = fromHex(custom?.selection) {
            return sel.opacity(0.22)
        }
        return dynamic(light: 0xE5E5E5, dark: 0x262626)
    }
}

public struct HairlineDivider: View {
    public let vertical: Bool
    public init(vertical: Bool = false) {
        self.vertical = vertical
    }
    public var body: some View {
        Rectangle()
            .fill(ToolrollPalette.line)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

public struct StatusChip: View {
    public let tone: TaskStatusTone
    public let label: String

    public init(tone: TaskStatusTone, label: String? = nil) {
        self.tone = tone
        if let label, !label.isEmpty {
            self.label = label
        } else {
            switch tone {
            case .needs: self.label = "Needs you"
            case .running: self.label = "Running"
            case .queued: self.label = "Queued"
            case .finished: self.label = "Finished"
            case .failed: self.label = "Failed"
            case .unknown: self.label = "Task"
            }
        }
    }

    public var body: some View {
        HStack(spacing: 5) {
            if tone == .running {
                Circle()
                    .fill(ToolrollPalette.live)
                    .frame(width: 6, height: 6)
            } else if tone == .finished {
                Circle()
                    .fill(ToolrollPalette.success)
                    .frame(width: 6, height: 6)
            } else if tone == .failed {
                Circle()
                    .fill(ToolrollPalette.danger)
                    .frame(width: 6, height: 6)
            }
            Text(label)
                .font(.system(size: 11, weight: tone == .needs ? .semibold : .medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(foregroundColor)
        .background(backgroundColor, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .strokeBorder(borderColor, lineWidth: tone == .needs ? 0 : 1)
        )
    }

    private var foregroundColor: Color {
        switch tone {
        case .needs: return ToolrollPalette.inverseInk
        case .running: return ToolrollPalette.ink
        case .queued, .unknown: return ToolrollPalette.muted
        case .finished: return ToolrollPalette.ink
        case .failed: return ToolrollPalette.danger
        }
    }

    private var backgroundColor: Color {
        switch tone {
        case .needs: return ToolrollPalette.ink
        case .failed: return ToolrollPalette.danger.opacity(0.08)
        default: return ToolrollPalette.raised
        }
    }

    private var borderColor: Color {
        switch tone {
        case .failed: return ToolrollPalette.danger.opacity(0.35)
        default: return ToolrollPalette.line
        }
    }
}

public enum KitButtonVariant {
    case primary
    case ghost
    case danger
}

public struct KitButtonStyle: ButtonStyle {
    public let variant: KitButtonVariant
    public let compact: Bool

    public init(_ variant: KitButtonVariant = .ghost, compact: Bool = false) {
        self.variant = variant
        self.compact = compact
    }

    public func makeBody(configuration: Configuration) -> some View {
        KitButtonBody(configuration: configuration, variant: variant, compact: compact)
    }
}

private struct KitButtonBody: View {
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered: Bool = false
    let configuration: ButtonStyleConfiguration
    let variant: KitButtonVariant
    let compact: Bool

    var body: some View {
        configuration.label
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .font(.system(size: compact ? 11.5 : 12.5, weight: variant == .primary ? .semibold : .medium))
            .padding(.horizontal, compact ? 9 : 12)
            .padding(.vertical, compact ? 4.5 : 6)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(border, lineWidth: variant == .primary ? 0 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.36)
            .onHover { hovering in
                isHovered = hovering
            }
    }

    private var foreground: Color {
        switch variant {
        case .primary: return ToolrollPalette.inverseInk
        case .ghost: return ToolrollPalette.ink
        case .danger: return ToolrollPalette.danger
        }
    }

    private var background: Color {
        switch variant {
        case .primary:
            if configuration.isPressed { return ToolrollPalette.ink.opacity(0.85) }
            if isHovered && isEnabled { return ToolrollPalette.ink.opacity(0.92) }
            return ToolrollPalette.ink
        case .ghost:
            if configuration.isPressed { return ToolrollPalette.selection }
            if isHovered && isEnabled { return ToolrollPalette.raised }
            return ToolrollPalette.paper
        case .danger:
            return configuration.isPressed ? ToolrollPalette.danger.opacity(0.18) : ToolrollPalette.danger.opacity(isHovered && isEnabled ? 0.13 : 0.08)
        }
    }

    private var border: Color {
        switch variant {
        case .primary: return .clear
        case .ghost: return isHovered && isEnabled ? ToolrollPalette.muted : ToolrollPalette.inputLine
        case .danger: return ToolrollPalette.danger.opacity(0.45)
        }
    }
}

@MainActor
public final class CanvasImageCache {
    public static let shared = CanvasImageCache()
    private let cache = NSCache<NSString, NSImage>()

    private init() {
        cache.countLimit = 48
        cache.totalCostLimit = 96 * 1024 * 1024
    }

    public func image(atPath path: String, maxPixelDimension: Int? = nil) -> NSImage? {
        let mtime = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(path)#\(Int(mtime))#\(maxPixelDimension ?? 0)" as NSString
        if let hit = cache.object(forKey: key) {
            return hit
        }

        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }

        let cgImage: CGImage?
        if let maxDim = maxPixelDimension {
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxDim,
            ]
            cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
        } else {
            let opts: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
            cgImage = CGImageSourceCreateImageAtIndex(source, 0, opts as CFDictionary)
        }

        guard let cg = cgImage else { return nil }
        let img = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        let cost = cg.bytesPerRow * cg.height
        cache.setObject(img, forKey: key, cost: cost)
        return img
    }
}

public struct WindowGlassConfigurator: NSViewRepresentable {
    public init() {}

    public func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            window.isOpaque = false
            window.backgroundColor = .clear
            window.titlebarAppearsTransparent = true
        }
        return view
    }

    public func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { [weak nsView] in
            guard let window = nsView?.window else { return }
            if window.isOpaque {
                window.isOpaque = false
                window.backgroundColor = .clear
                window.titlebarAppearsTransparent = true
            }
        }
    }
}

public struct SidebarVibrancyBackground: NSViewRepresentable {
    public let material: NSVisualEffectView.Material
    public let blendingMode: NSVisualEffectView.BlendingMode

    public init(
        material: NSVisualEffectView.Material = .sidebar,
        blendingMode: NSVisualEffectView.BlendingMode = .behindWindow
    ) {
        self.material = material
        self.blendingMode = blendingMode
    }

    public func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blendingMode
        v.state = .followsWindowActiveState
        return v
    }

    public func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        if nsView.material != material { nsView.material = material }
        if nsView.blendingMode != blendingMode { nsView.blendingMode = blendingMode }
    }
}

public struct ToolrollGlassGroup<Content: View>: View {
    public let spacing: CGFloat
    @ViewBuilder public let content: () -> Content

    public init(spacing: CGFloat = 6, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    public var body: some View {
        if #available(macOS 26.0, *), WorkspaceThemeEngine.shared.config.glassChrome {
            GlassEffectContainer(spacing: spacing) {
                HStack(spacing: spacing) {
                    content()
                }
            }
        } else {
            HStack(spacing: spacing) {
                content()
            }
        }
    }
}

public struct ToolrollHoverSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat
    let isSelected: Bool
    @State private var isHovered = false

    public func body(content: Content) -> some View {
        content
            .background(
                (isSelected ? ToolrollPalette.selection : (isHovered ? ToolrollPalette.raised.opacity(0.85) : Color.clear)),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

public struct ToolrollIconButtonStyle: ButtonStyle {
    public let size: CGFloat
    public let isActive: Bool

    public init(size: CGFloat = 26, isActive: Bool = false) {
        self.size = size
        self.isActive = isActive
    }

    public func makeBody(configuration: Configuration) -> some View {
        ToolrollIconButtonBody(configuration: configuration, size: size, isActive: isActive)
    }
}

private struct ToolrollIconButtonBody: View {
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false
    let configuration: ButtonStyleConfiguration
    let size: CGFloat
    let isActive: Bool

    var body: some View {
        configuration.label
            .frame(width: size, height: size)
            .background(
                isActive
                    ? ToolrollPalette.paper
                    : (isHovered && isEnabled ? ToolrollPalette.raised : Color.clear),
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(isActive ? ToolrollPalette.line : Color.clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1.0) : 0.35)
            .onHover { isHovered = $0 }
    }
}

public extension View {
    func toolrollHoverSurface(cornerRadius: CGFloat = 5, isSelected: Bool = false) -> some View {
        modifier(ToolrollHoverSurfaceModifier(cornerRadius: cornerRadius, isSelected: isSelected))
    }

    @ViewBuilder
    @MainActor
    func toolrollGlassCapsule(interactive: Bool = true) -> some View {
        if WorkspaceThemeEngine.shared.config.glassChrome {
            if #available(macOS 26.0, *) {
                self.glassEffect(interactive ? .regular.interactive() : .regular, in: Capsule())
            } else {
                self
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }
        } else {
            self
                .background(ToolrollPalette.paper, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
        }
    }

    @ViewBuilder
    @MainActor
    func toolrollGlassPanel(cornerRadius: CGFloat = 10, interactive: Bool = false) -> some View {
        if WorkspaceThemeEngine.shared.config.glassChrome {
            if #available(macOS 26.0, *) {
                self.glassEffect(interactive ? .regular.interactive() : .regular, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            } else {
                self
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
                    )
            }
        } else {
            self
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
                )
        }
    }
}

public extension Color {
    @MainActor
    static func fromTerminal(_ tc: TerminalColor, isForeground: Bool) -> Color {
        switch tc {
        case .default:
            return isForeground ? ToolrollPalette.ink : .clear
        case .ansi(let code):
            switch code {
            case 0: return Color(red: 0.15, green: 0.15, blue: 0.15)
            case 1: return ToolrollPalette.danger
            case 2: return ToolrollPalette.success
            case 3: return ToolrollPalette.warning
            case 4: return ToolrollPalette.live
            case 5: return Color(red: 0.62, green: 0.36, blue: 0.82)
            case 6: return Color(red: 0.12, green: 0.62, blue: 0.68)
            case 7: return ToolrollPalette.muted
            case 8: return ToolrollPalette.muted.opacity(0.8)
            case 9: return ToolrollPalette.danger
            case 10: return ToolrollPalette.success
            case 11: return ToolrollPalette.warning
            case 12: return ToolrollPalette.live
            case 13: return Color(red: 0.78, green: 0.50, blue: 0.94)
            case 14: return Color(red: 0.25, green: 0.78, blue: 0.84)
            default: return ToolrollPalette.ink
            }
        case .palette(let idx):
            if idx < 16 { return fromTerminal(.ansi(idx), isForeground: isForeground) }
            if idx >= 232 {
                let v = Double(8 + Int(idx - 232) * 10) / 255.0
                return Color(red: v, green: v, blue: v)
            }
            let c = Int(idx - 16)
            let r = Double((c / 36) * 51) / 255.0
            let g = Double(((c / 6) % 6) * 51) / 255.0
            let b = Double((c % 6) * 51) / 255.0
            return Color(red: r, green: g, blue: b)
        case .rgb(let r, let g, let b):
            return Color(red: Double(r) / 255.0, green: Double(g) / 255.0, blue: Double(b) / 255.0)
        }
    }
}
