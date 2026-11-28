import SwiftUI
import UIKit
import ToolrollCompanionCore

/// Appearance preference persisted per device (`UserDefaults`), mirroring `so-theme` on Web & Desktop.
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

/// The theme choice (System / Light / Dark). Signal has one accent, ink, for every act and everything that waits on a
/// person; colour is kept for status (blue = running, green = success, red = problem). No custom accents.
@Observable
final class ToolrollAppearance: @unchecked Sendable {
    static let shared = ToolrollAppearance()
    static let themeStorageKey = "appearance.theme.v1"

    var scheme: AppearanceScheme {
        didSet {
            UserDefaults.standard.set(scheme.rawValue, forKey: Self.themeStorageKey)
        }
    }

    init() {
        let savedScheme = UserDefaults.standard.string(forKey: Self.themeStorageKey)
        scheme = savedScheme.flatMap(AppearanceScheme.init(rawValue:)) ?? .system
        // The old accent picker's choice no longer applies.
        UserDefaults.standard.removeObject(forKey: "appearance.accentHex.v1")
    }

    /// Primary button fill: ink.
    var signal: Color { ToolrollTheme.ink }
    /// Text on an ink fill.
    var onSignal: Color { ToolrollTheme.onInk }
    /// Act-coloured text on paper: ink.
    var signalText: Color { ToolrollTheme.ink }
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

    /// Canvas (Light #F5F5F3 / Dark #0E0E10).
    static let paper = dynamic(light: hex(0xF5F5F3), dark: hex(0x0E0E10))
    /// Card / sheet surface (Light #FFFFFF / Dark #18181B).
    static let surface = dynamic(light: hex(0xFFFFFF), dark: hex(0x18181B))
    /// Raised well / segmented track / hunk header.
    static let raised = dynamic(light: hex(0xEFEFEC), dark: hex(0x222226))
    static let subtleFill = raised
    /// Card border (Light #E4E4E0 / Dark #2A2A2E).
    static let border = dynamic(light: hex(0xE4E4E0), dark: hex(0x2A2A2E))
    /// Row divider inside a card.
    static let hairline = dynamic(light: hex(0xEFEFEC), dark: hex(0x242428))
    /// Outline of a secondary control (Light #CFCFCA / Dark #3A3A3F).
    static let controlLine = dynamic(light: hex(0xCFCFCA), dark: hex(0x3A3A3F))
    static let topHighlight = dynamic(light: hex(0xFFFFFF, alpha: 0.0), dark: hex(0xFFFFFF, alpha: 0.06))

    static let ink = dynamic(light: hex(0x111113), dark: hex(0xEDEDEA))
    static let onInk = dynamic(light: hex(0xFFFFFF), dark: hex(0x0E0E10))
    /// Body text a step down from ink.
    static let body = dynamic(light: hex(0x3B3B38), dark: hex(0xC9C9C4))
    static let muted = dynamic(light: hex(0x5F5F5B), dark: hex(0xA1A19B))
    static let subtle = dynamic(light: hex(0x8A8A86), dark: hex(0x76767A))
    /// A switch that's on: ink on paper; in dark, green (a light knob on a light track would vanish).
    static let toggleOn = dynamic(light: hex(0x111113), dark: hex(0x2FB574))
    /// A disabled primary button.
    static let disabledFill = dynamic(light: hex(0xD9D9D5), dark: hex(0x2C2C30))

    static let neutralInk = dynamic(light: hex(0x525257), dark: hex(0xB4B4BC))
    static let neutralSoft = dynamic(light: hex(0xEFEFEC), dark: hex(0x222226))
    /// A highlight behind changed words (stale plan).
    static let changedMark = dynamic(light: hex(0xE6E6E1), dark: hex(0x34343A))

    static let danger = dynamic(light: hex(0xB42318), dark: hex(0xFF8A7A))
    static let dangerSoft = dynamic(light: hex(0xFBEAE8), dark: hex(0xFF8A7A, alpha: 0.14))
    static let dangerInk = dynamic(light: hex(0x7A1A12), dark: hex(0xFFB4A8))
    static let success = dynamic(light: hex(0x1A7348), dark: hex(0x3DD68C))
    static let successSoft = dynamic(light: hex(0xE7F3EC), dark: hex(0x3DD68C, alpha: 0.13))
    static let successInk = dynamic(light: hex(0x14583A), dark: hex(0x8BE5B6))
    /// Running / live only.
    static let info = dynamic(light: hex(0x1D5FD1), dark: hex(0x6EA2FF))
    static let infoSoft = dynamic(light: hex(0xDCE7FA), dark: hex(0x6EA2FF, alpha: 0.18))

    // Diff line backgrounds calibrated for crisp light & dark readability.
    static let diffAddFill = dynamic(light: hex(0xEBF9F0), dark: hex(0x3DD68C, alpha: 0.13))
    static let diffDelFill = dynamic(light: hex(0xFEF0EE), dark: hex(0xFF977D, alpha: 0.13))

    // Dedicated dark terminal / agent output palette (consistent across light & dark system schemes).
    static let terminalBg = dynamic(light: hex(0x111113), dark: hex(0x09090B))
    static let terminalSurface = dynamic(light: hex(0x1A1A1D), dark: hex(0x141417))
    static let terminalBorder = dynamic(light: hex(0xFFFFFF, alpha: 0.10), dark: hex(0xFFFFFF, alpha: 0.09))
    static let terminalHighlight = Color.white.opacity(0.09)
    static let terminalInk = Color(uiColor: hex(0xEDEDEA))
    static let terminalMuted = Color(uiColor: hex(0x9A9A95))
    static let terminalBlue = Color(uiColor: hex(0x8FB4F5))
    static let terminalGreen = Color(uiColor: hex(0x3DD68C))
    static let terminalRed = Color(uiColor: hex(0xFF977D))
}

/// The one state tone a row or task carries. What waits on a person is ink; only running/live is blue.
enum StateTone {
    case needs
    case live
    case done
    case failed
    case neutral

    func hue(appearance: ToolrollAppearance) -> Color { hue }

    var hue: Color {
        switch self {
        case .needs: return ToolrollTheme.ink
        case .live: return ToolrollTheme.info
        case .done: return ToolrollTheme.success
        case .failed: return ToolrollTheme.danger
        case .neutral: return ToolrollTheme.muted
        }
    }
}

/// What waits on a person: a solid ink chip ("Approve plan", "Review result"). Outlined when the data is saved, not live.
struct InkChip: View {
    let text: String
    var outlined = false
    @Environment(\.showsStaleData) private var stale

    var body: some View {
        let hollow = outlined || stale
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(hollow ? ToolrollTheme.ink : ToolrollTheme.onInk)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(hollow ? Color.clear : ToolrollTheme.ink)
            }
            .overlay {
                if hollow {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollTheme.ink, lineWidth: 1)
                }
            }
    }
}

/// Running: a blue dot with a soft halo.
struct LiveDot: View {
    var body: some View {
        Circle()
            .fill(ToolrollTheme.info)
            .frame(width: 8, height: 8)
            .padding(4)
            .background(Circle().fill(ToolrollTheme.infoSoft))
            .accessibilityHidden(true)
    }
}

/// An uppercase section label ("DONE WHEN", "PLAN", "PAIRED MAC").
struct SectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.4)
            .foregroundStyle(ToolrollTheme.muted)
            .accessibilityAddTraits(.isHeader)
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
        let color = tone.hue
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
    var radius: CGFloat = 14
    @Environment(\.showsStaleData) private var stale

    func body(content: Content) -> some View {
        content
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(ToolrollTheme.border, lineWidth: 1)
                    .opacity(stale ? 0.6 : 1)
            )
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
    func card(radius: CGFloat = 14) -> some View {
        modifier(CardBackground(radius: radius))
    }

    func terminalCard(radius: CGFloat = 12) -> some View {
        modifier(TerminalCardBackground(radius: radius))
    }
}

/// Primary act: an ink fill, 52pt tall (44 compact), 12pt corners.
struct SignalButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 52)
            .padding(.horizontal, 16)
            .foregroundStyle(isEnabled ? ToolrollTheme.onInk : ToolrollTheme.muted)
            .background(isEnabled ? ToolrollTheme.ink : ToolrollTheme.disabledFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// A deliberate act that always asks for the passkey (protected work, exceptions): an ink outline, not a fill, so the
/// hand slows down.
struct DeliberateButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 52)
            .padding(.horizontal, 12)
            .foregroundStyle(isEnabled ? ToolrollTheme.ink : ToolrollTheme.subtle)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(isEnabled ? ToolrollTheme.ink : ToolrollTheme.controlLine, lineWidth: 2))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.84 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// Secondary: surface fill, a thin control outline, ink label.
struct OutlineButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 52)
            .padding(.horizontal, 16)
            .foregroundStyle(isEnabled ? ToolrollTheme.ink : ToolrollTheme.subtle)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.84 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// A small pill button ("Lock now", "Paste", "Done").
struct PillButtonStyle: ButtonStyle {
    var filled = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(filled ? .semibold : .medium))
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .foregroundStyle(filled ? ToolrollTheme.onInk : ToolrollTheme.ink)
            .background(Capsule().fill(filled ? ToolrollTheme.ink : ToolrollTheme.surface))
            .overlay { if !filled { Capsule().strokeBorder(ToolrollTheme.controlLine, lineWidth: 1) } }
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}

/// A round 44pt icon button on paper (Settings, Back, Open on Mac).
struct RoundIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(ToolrollTheme.ink)
            .frame(width: 44, height: 44)
            .background(Circle().fill(ToolrollTheme.surface))
            .overlay(Circle().strokeBorder(ToolrollTheme.border, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Circle())
    }
}

/// Alias kept for existing call sites that adopt the primary style.
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
