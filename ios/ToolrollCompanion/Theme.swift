import SwiftUI
import UIKit
import ToolrollCompanionCore

/// Customizable accent presets matching Web & Desktop (`src/accent-colors.ts`).
struct AccentPreset: Identifiable, Equatable {
    let id: String
    let name: String
    let hex: String

    static let signalBlue = AccentPreset(id: "signal-blue", name: "Signal Blue", hex: "#3B82F6")
    static let ink = AccentPreset(id: "ink", name: "Ink", hex: "#171717")
    static let chartMagenta = AccentPreset(id: "chart-magenta", name: "Chart Magenta", hex: "#C0267E")
    static let builtMint = AccentPreset(id: "built-mint", name: "Built Mint", hex: "#16A34A")
    static let violet = AccentPreset(id: "violet", name: "Violet", hex: "#6E56CF")

    static let all: [AccentPreset] = [.signalBlue, .ink, .chartMagenta, .builtMint, .violet]
}

/// Appearance preference persisted per device (`UserDefaults`), mirroring `so-theme` / `so-accent` on Web & Desktop.
enum AppearanceScheme: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// Live-updating appearance controller injected into SwiftUI environment so changing accent or theme
/// immediately repigments every screen consistently.
@Observable
final class ToolrollAppearance: @unchecked Sendable {
    static let shared = ToolrollAppearance()
    static let accentStorageKey = "appearance.accentHex.v1"
    static let themeStorageKey = "appearance.theme.v1"

    var accentHex: String {
        didSet {
            let normalized = Self.normalizeHex(accentHex) ?? AccentPreset.signalBlue.hex
            if accentHex != normalized { accentHex = normalized; return }
            UserDefaults.standard.set(normalized, forKey: Self.accentStorageKey)
        }
    }

    var scheme: AppearanceScheme {
        didSet {
            UserDefaults.standard.set(scheme.rawValue, forKey: Self.themeStorageKey)
        }
    }

    init() {
        let savedHex = UserDefaults.standard.string(forKey: Self.accentStorageKey)
        accentHex = savedHex.flatMap(Self.normalizeHex) ?? AccentPreset.signalBlue.hex
        let savedScheme = UserDefaults.standard.string(forKey: Self.themeStorageKey)
        scheme = savedScheme.flatMap(AppearanceScheme.init(rawValue:)) ?? .system
    }

    var isMonochromeInk: Bool {
        accentHex.uppercased() == AccentPreset.ink.hex
    }

    /// Primary button fill / count pill fill (3% disciplined accent).
    var signal: Color {
        if isMonochromeInk { return ToolrollTheme.ink }
        let base = Self.uiColor(hex: accentHex) ?? Self.uiColor(hex: AccentPreset.signalBlue.hex)!
        let lightFill = Self.ensureLightFillReadable(base)
        let darkFill = Self.ensureDarkFillReadable(base)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkFill : lightFill })
    }

    /// High-contrast text on top of `signal` fill.
    var onSignal: Color {
        if isMonochromeInk { return ToolrollTheme.onInk }
        let base = Self.uiColor(hex: accentHex) ?? Self.uiColor(hex: AccentPreset.signalBlue.hex)!
        let lightFill = Self.ensureLightFillReadable(base)
        let darkFill = Self.ensureDarkFillReadable(base)
        let lightFg = Self.relativeLuminance(lightFill) > 0.42 ? UIColor(red: 0.06, green: 0.06, blue: 0.07, alpha: 1) : UIColor.white
        let darkFg = Self.relativeLuminance(darkFill) > 0.46 ? UIColor(red: 0.05, green: 0.06, blue: 0.07, alpha: 1) : UIColor.white
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkFg : lightFg })
    }

    /// Readable text/dot hue on canvas & paper surfaces (calibrated >= 4.5:1 light, >= 6:1 dark).
    var signalText: Color {
        if isMonochromeInk { return ToolrollTheme.ink }
        let base = Self.uiColor(hex: accentHex) ?? Self.uiColor(hex: AccentPreset.signalBlue.hex)!
        let lightText = Self.ensureContrastOnLight(base)
        let darkText = Self.ensureContrastOnDark(base)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkText : lightText })
    }

    /// Subtle wash for soft badges or accent callouts.
    var signalSoft: Color {
        if isMonochromeInk { return ToolrollTheme.neutralSoft }
        let base = Self.uiColor(hex: accentHex) ?? Self.uiColor(hex: AccentPreset.signalBlue.hex)!
        let lightSoft = base.withAlphaComponent(0.11)
        let darkSoft = Self.ensureContrastOnDark(base).withAlphaComponent(0.15)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkSoft : lightSoft })
    }

    var swiftUIColor: Color {
        Color(uiColor: Self.uiColor(hex: accentHex) ?? Self.uiColor(hex: AccentPreset.signalBlue.hex)!)
    }

    func setCustomColor(_ color: Color) {
        let ui = UIColor(color)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard ui.getRed(&r, green: &g, blue: &b, alpha: &a) else { return }
        let hex = String(format: "#%02X%02X%02X", Int(round(max(0, min(1, r)) * 255)), Int(round(max(0, min(1, g)) * 255)), Int(round(max(0, min(1, b)) * 255)))
        accentHex = hex
    }

    // MARK: Contrast Calibration (mirrors src/accent-colors.ts)

    static func normalizeHex(_ raw: String) -> String? {
        let stripped = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
            .uppercased()
        if stripped.count == 6, UInt32(stripped, radix: 16) != nil {
            return "#\(stripped)"
        }
        if stripped.count == 3, UInt32(stripped, radix: 16) != nil {
            let expanded = stripped.map { "\($0)\($0)" }.joined()
            return "#\(expanded)"
        }
        return nil
    }

    static func uiColor(hex: String) -> UIColor? {
        guard let norm = normalizeHex(hex), let value = UInt32(norm.dropFirst(), radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }

    private static func relativeLuminance(_ color: UIColor) -> CGFloat {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func lin(_ c: CGFloat) -> CGFloat { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    private static func contrastRatio(_ c1: UIColor, _ c2: UIColor) -> CGFloat {
        let l1 = relativeLuminance(c1)
        let l2 = relativeLuminance(c2)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    private static func adjustBrightness(_ color: UIColor, factor: CGFloat, liftTowardWhite: CGFloat = 0) -> UIColor {
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        let nextB = max(0.05, min(1.0, b * factor))
        let nextS = max(0, min(1.0, s * (1 - liftTowardWhite * 0.45)))
        let liftedB = min(1.0, nextB + (1 - nextB) * liftTowardWhite)
        return UIColor(hue: h, saturation: nextS, brightness: liftedB, alpha: 1)
    }

    private static func ensureLightFillReadable(_ base: UIColor) -> UIColor {
        // Keep Signal Blue crisp (#2563EB on light) so white button labels pass contrast cleanly.
        let white = UIColor.white
        var current = base
        for _ in 0..<18 {
            if contrastRatio(current, white) >= 4.5 { return current }
            current = adjustBrightness(current, factor: 0.94)
        }
        return current
    }

    private static func ensureDarkFillReadable(_ base: UIColor) -> UIColor {
        let darkBg = UIColor(red: 0.06, green: 0.06, blue: 0.065, alpha: 1)
        var current = base
        for _ in 0..<16 {
            if contrastRatio(current, darkBg) >= 4.2 { return current }
            current = adjustBrightness(current, factor: 1.08, liftTowardWhite: 0.05)
        }
        return current
    }

    private static func ensureContrastOnLight(_ base: UIColor) -> UIColor {
        let paper = UIColor(red: 0.96, green: 0.96, blue: 0.96, alpha: 1)
        var current = base
        for _ in 0..<20 {
            if contrastRatio(current, paper) >= 4.6 { return current }
            current = adjustBrightness(current, factor: 0.93)
        }
        return current
    }

    private static func ensureContrastOnDark(_ base: UIColor) -> UIColor {
        let darkPaper = UIColor(red: 0.09, green: 0.09, blue: 0.10, alpha: 1)
        var current = base
        for _ in 0..<24 {
            if contrastRatio(current, darkPaper) >= 6.0 { return current }
            current = adjustBrightness(current, factor: 1.08, liftTowardWhite: 0.08)
        }
        return current
    }
}

extension EnvironmentValues {
    @Entry var toolrollAppearance = ToolrollAppearance.shared
    /// What's on screen is cached from an earlier visit (the Mac can't be reached). Borders and state accents fade;
    /// text keeps full contrast, and a "Last updated" banner says how old it is.
    @Entry var showsStaleData = false
}

/// Unified Signal Design Language for iOS: calm graphite/paper neutrals, machined 1px hairlines with dark top-edge
/// light catch, one customizable Signal accent (3% discipline), dedicated dark terminal surface, and semantic status hues.
/// No amber or yellow anywhere.
enum ToolrollTheme {
    private static func dynamic(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }

    private static func hex(_ value: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: alpha
        )
    }

    /// Outer frame / canvas (Light #F4F4F5 graphite paper / Dark #0E0E10 deep graphite).
    static let paper = dynamic(light: hex(0xF4F4F5), dark: hex(0x0E0E10))
    /// Card / sheet surface (Light #FFFFFF / Dark #161618).
    static let surface = dynamic(light: hex(0xFFFFFF), dark: hex(0x161618))
    /// Raised well / segmented track / hunk header (Light #ECECEE / Dark #1E1E21).
    static let raised = dynamic(light: hex(0xECECEE), dark: hex(0x1E1E21))
    static let subtleFill = raised
    /// Quiet 1px hairline divider (Light black 8% / Dark white 8%).
    static let hairline = dynamic(light: hex(0x171717, alpha: 0.09), dark: hex(0xFFFFFF, alpha: 0.08))
    static let controlLine = dynamic(light: hex(0x171717, alpha: 0.14), dark: hex(0xFFFFFF, alpha: 0.13))
    /// Subtle machined top-edge light catch on dark surfaces (`unslop` tokens.md).
    static let topHighlight = dynamic(light: hex(0xFFFFFF, alpha: 0.0), dark: hex(0xFFFFFF, alpha: 0.10))

    static let ink = dynamic(light: hex(0x171717), dark: hex(0xEDEDED))
    static let onInk = dynamic(light: hex(0xFFFFFF), dark: hex(0x0E0E10))
    static let muted = dynamic(light: hex(0x5A5A60), dark: hex(0x9C9CA4))
    static let subtle = dynamic(light: hex(0x8A8A91), dark: hex(0x6E6E76))

    static let neutralInk = dynamic(light: hex(0x525257), dark: hex(0xB4B4BC))
    static let neutralSoft = dynamic(light: hex(0xEFEFF1), dark: hex(0x202024))

    static let danger = dynamic(light: hex(0xC4320A), dark: hex(0xFF977D))
    static let dangerSoft = dynamic(light: hex(0xFEEBE7), dark: hex(0xFF977D, alpha: 0.14))
    static let success = dynamic(light: hex(0x1B7049), dark: hex(0x3DD68C))
    static let successSoft = dynamic(light: hex(0xE6F6EB), dark: hex(0x3DD68C, alpha: 0.14))
    static let info = dynamic(light: hex(0x0B65B8), dark: hex(0x70B8FF))
    static let infoSoft = dynamic(light: hex(0xE6F4FE), dark: hex(0x70B8FF, alpha: 0.14))

    // Diff line backgrounds calibrated for crisp light & dark readability.
    static let diffAddFill = dynamic(light: hex(0xEBF9F0), dark: hex(0x3DD68C, alpha: 0.13))
    static let diffDelFill = dynamic(light: hex(0xFEF0EE), dark: hex(0xFF977D, alpha: 0.13))

    // Dedicated dark terminal / agent output palette (consistent across light & dark system schemes).
    static let terminalBg = dynamic(light: hex(0x101012), dark: hex(0x09090B))
    static let terminalSurface = dynamic(light: hex(0x1A1A1D), dark: hex(0x141417))
    static let terminalBorder = dynamic(light: hex(0xFFFFFF, alpha: 0.10), dark: hex(0xFFFFFF, alpha: 0.09))
    static let terminalHighlight = Color.white.opacity(0.09)
    static let terminalInk = Color(uiColor: hex(0xEDEDED))
    static let terminalMuted = Color(uiColor: hex(0x96969E))
    static let terminalBlue = Color(uiColor: hex(0x70B8FF))
    static let terminalGreen = Color(uiColor: hex(0x3DD68C))
    static let terminalRed = Color(uiColor: hex(0xFF977D))
}

/// The one state tone a row or task carries. Needs-you uses the customizable Signal accent; status keeps its hue.
enum StateTone {
    case needs
    case live
    case done
    case failed
    case neutral

    func hue(appearance: ToolrollAppearance) -> Color {
        switch self {
        case .needs: return appearance.signalText
        case .live: return ToolrollTheme.info
        case .done: return ToolrollTheme.success
        case .failed: return ToolrollTheme.danger
        case .neutral: return ToolrollTheme.muted
        }
    }

    var hue: Color {
        switch self {
        case .needs: return ToolrollTheme.ink
        case .live: return ToolrollTheme.info
        case .done: return ToolrollTheme.success
        case .failed: return ToolrollTheme.danger
        case .neutral: return ToolrollTheme.neutralInk
        }
    }
}

/// Quiet inline status indicator: 7pt semantic/accent dot + sentence-case label. No boxed sticker badges.
struct StatusDotLabel: View {
    let word: String
    let tone: StateTone
    var size: Font = .caption
    @Environment(\.toolrollAppearance) private var appearance
    @Environment(\.showsStaleData) private var stale

    var body: some View {
        let color = tone.hue(appearance: appearance)
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(word)
                .font(size.weight(.medium))
                .foregroundStyle(tone == .neutral ? ToolrollTheme.muted : color)
        }
        .opacity(stale ? 0.6 : 1)
    }
}

/// Toolroll's one Signature Detail: three skewed brand bars gently pulsing in Live Blue when an agent is actively running.
struct LivePulseBars: View {
    var color: Color = ToolrollTheme.terminalBlue
    var height: CGFloat = 11
    var animate: Bool = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        let shouldAnimate = animate && !reduceMotion
        HStack(alignment: .bottom, spacing: 2.5) {
            bar(scale: shouldAnimate && pulse ? 0.62 : 1.0, opacity: shouldAnimate && pulse ? 0.55 : 1.0, delay: 0.0)
            bar(scale: shouldAnimate && pulse ? 1.0 : 0.68, opacity: shouldAnimate && pulse ? 1.0 : 0.62, delay: 0.16)
            bar(scale: shouldAnimate && pulse ? 0.70 : 0.96, opacity: shouldAnimate && pulse ? 0.58 : 0.95, delay: 0.32)
        }
        .frame(height: height)
        .accessibilityHidden(true)
        .onAppear {
            guard shouldAnimate else { return }
            withAnimation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private func bar(scale: CGFloat, opacity: Double, delay: Double) -> some View {
        RoundedRectangle(cornerRadius: 1, style: .continuous)
            .fill(color.opacity(opacity))
            .frame(width: 2.5, height: height)
            .scaleEffect(x: 1, y: scale, anchor: .bottom)
            .transformEffect(CGAffineTransform(a: 1, b: 0, c: -0.22, d: 1, tx: 1.5, ty: 0))
            .animation(animate && !reduceMotion ? .easeInOut(duration: 0.95).repeatForever(autoreverses: true).delay(delay) : nil, value: pulse)
    }
}

/// Data-made micro-pop: 5-pip proportional green/vermilion diff bar beside +N -M counts.
struct DiffStatPips: View {
    let additions: Int
    let deletions: Int

    private var pipColors: [Color] {
        let add = max(0, additions)
        let del = max(0, deletions)
        let total = add + del
        guard total > 0 else { return Array(repeating: ToolrollTheme.hairline, count: 5) }
        var greenCount = Int(round((Double(add) / Double(total)) * 5.0))
        var redCount = 5 - greenCount
        if add > 0 && greenCount == 0 { greenCount = 1; redCount = 4 }
        if del > 0 && redCount == 0 { redCount = 1; greenCount = 4 }
        return Array(repeating: ToolrollTheme.success, count: greenCount) + Array(repeating: ToolrollTheme.danger, count: redCount)
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { idx in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(pipColors[idx])
                    .frame(width: 5, height: 5)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Quiet machined surface card: 12pt radius, subtle 1px hairline (never a bright white wireframe box),
/// plus a razor-thin dark-mode top-edge light catch.
struct CardBackground: ViewModifier {
    var radius: CGFloat = 12
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.showsStaleData) private var stale

    func body(content: Content) -> some View {
        content
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: colorScheme == .dark
                                ? [Color.white.opacity(0.13), Color.white.opacity(0.06)]
                                : [Color.black.opacity(0.08), Color.black.opacity(0.08)],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                    .opacity(stale ? 0.45 : 1)
            )
            .shadow(color: colorScheme == .light ? Color.black.opacity(0.03) : .clear, radius: 2, y: 1)
    }
}

/// Dedicated dark terminal surface with quiet hairline and machined top-edge light catch.
struct TerminalCardBackground: ViewModifier {
    var radius: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .background(ToolrollTheme.terminalBg, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.14), Color.white.opacity(0.06)],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
            )
    }
}

/// Over cached data while the Mac can't be reached: how old it is, kept current by the minute.
struct StaleDataBanner: View {
    let lastUpdated: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 8) {
                Image(systemName: "clock")
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.muted)
                    .accessibilityHidden(true)
                Text(lastUpdated.map { "Cached · last updated \(RelativeTime.ago($0, now: context.date))" } ?? "Showing cached data from last visit")
                    .font(.footnote)
                    .foregroundStyle(ToolrollTheme.ink)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(radius: 10)
        }
        .accessibilityElement(children: .combine)
    }
}

extension View {
    func card(radius: CGFloat = 12) -> some View {
        modifier(CardBackground(radius: radius))
    }

    func terminalCard(radius: CGFloat = 12) -> some View {
        modifier(TerminalCardBackground(radius: radius))
    }
}

/// Primary Signal CTA: uses the person's chosen accent, machined top-edge highlight, and tactile 0.98 press scale.
struct SignalButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.toolrollAppearance) private var appearance

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .headline)
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 48)
            .padding(.horizontal, 16)
            .foregroundStyle(appearance.onSignal)
            .background(appearance.signal, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.28), Color.clear],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// Secondary button: quiet raised surface with hairline border, ink label, and tactile 0.98 press scale.
struct OutlineButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .headline)
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 48)
            .padding(.horizontal, 16)
            .foregroundStyle(ToolrollTheme.ink)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: colorScheme == .dark
                                ? [Color.white.opacity(0.15), Color.white.opacity(0.08)]
                                : [ToolrollTheme.controlLine, ToolrollTheme.controlLine],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.84 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// Alias kept for existing call sites that adopt the primary Signal CTA style.
typealias InkButtonStyle = SignalButtonStyle

/// The brand mark: three skewed bars, the middle one taller (DESIGN.md).
struct BrandMark: View {
    var size: CGFloat = 64
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(colorScheme == .dark ? Color(uiColor: UIColor(white: 0.12, alpha: 1)) : ToolrollTheme.ink)
                .overlay(
                    RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: colorScheme == .dark
                                    ? [Color.white.opacity(0.18), Color.white.opacity(0.06)]
                                    : [Color.clear, Color.clear],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 1
                        )
                )
            HStack(alignment: .center, spacing: size * 0.075) {
                bar(height: size * 0.30)
                bar(height: size * 0.48)
                bar(height: size * 0.30)
            }
            .transformEffect(CGAffineTransform(a: 1, b: 0, c: -0.18, d: 1, tx: size * 0.04, ty: 0))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func bar(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: size * 0.03)
            .fill(colorScheme == .dark ? Color(uiColor: UIColor(white: 0.94, alpha: 1)) : ToolrollTheme.onInk)
            .frame(width: size * 0.085, height: height)
    }
}

/// Renders an agent's sentence with `code`, **bold** and *italic*. Links are stripped (CompanionText), so agent
/// text is never tappable; screens showing it also discard any URL open.
func markdownText(_ string: String) -> Text {
    Text(CompanionText.inlineMarkdown(string))
}

extension View {
    /// Nothing in agent- or server-written text opens a URL.
    func discardingLinks() -> some View {
        environment(\.openURL, OpenURLAction { _ in .discarded })
    }
}

enum RelativeTime {
    // Made once: these formatters are costly to build and are thread-safe once configured (never mutated after).
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) private static let whole = ISO8601DateFormatter()
    nonisolated(unsafe) private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    static func date(_ string: String?) -> Date? {
        guard let string else { return nil }
        return fractional.date(from: string) ?? whole.date(from: string)
    }

    static func ago(_ date: Date, now: Date = Date()) -> String {
        if now.timeIntervalSince(date) < 60 { return "just now" }
        return relative.localizedString(for: date, relativeTo: now)
    }
}
