import AppKit
import ImageIO
import SwiftUI
import ToolrollCore

/// Exact Toolroll Kit Signal 1.0.0 light & dark design tokens.
/// Monochrome, 1px hairline structure, zero resting shadows, adaptive macOS appearance.
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

    public static let ground    = dynamic(light: 0xEFEFEF, dark: 0x0B0B0B)
    public static let paper     = dynamic(light: 0xFFFFFF, dark: 0x161616)
    public static let raised    = dynamic(light: 0xF5F5F5, dark: 0x1C1C1C)
    public static let ink       = dynamic(light: 0x171717, dark: 0xEDEDED)
    public static let inverseInk = dynamic(light: 0xFFFFFF, dark: 0x0B0B0B)
    public static let muted     = dynamic(light: 0x666666, dark: 0xA1A1A1)
    public static let line      = dynamic(light: 0xE6E6E6, dark: 0x262626)
    public static let inputLine = dynamic(light: 0xD4D4D4, dark: 0x363636)
    public static let live      = dynamic(light: 0x0D74CE, dark: 0x70B8FF)
    public static let success   = dynamic(light: 0x218358, dark: 0x3DD68C)
    public static let danger    = dynamic(light: 0xC4320A, dark: 0xFF977D)
    public static let warning   = dynamic(light: 0xAB6400, dark: 0xFFCA16)
    public static let codeBg    = dynamic(light: 0xFAFAFA, dark: 0x111111)
    public static let composer  = dynamic(light: 0xF2F2F2, dark: 0x242424)
    public static let selection = dynamic(light: 0xE5E5E5, dark: 0x262626)
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

/// Canonical 5-tone Toolroll status chip.
/// Solid ink fill is reserved exclusively for `Needs you`; `Running` uses a static blue dot (never a spinner).
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

/// Shared downsampling image cache for Canvas artboard tiles and Lightbox previews.
/// Prevents inline `NSImage(contentsOfFile:)` inside SwiftUI `body` from re-decoding 21MB Retina bitmaps per frame.
@MainActor
public final class CanvasImageCache {
    public static let shared = CanvasImageCache()
    private let cache = NSCache<NSString, NSImage>()

    private init() {
        cache.countLimit = 48
        cache.totalCostLimit = 96 * 1024 * 1024 // 96 MB hard ceiling
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

public extension Color {
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
