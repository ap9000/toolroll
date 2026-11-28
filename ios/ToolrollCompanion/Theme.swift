import SwiftUI
import ToolrollCompanionCore

/// Signal (DESIGN.md) for the phone: true neutral frame grey, crisp paper sheets, ink for every act
/// and for what waits on a person, colour kept strictly for status (failed vermilion, live blue, done green),
/// plus a dedicated dark terminal surface for live agent streams and code manifests. No amber anywhere.
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

    /// Outer frame grey (DESIGN.md `ground`: #EFEFEF light / #0B0B0B dark).
    static let paper = dynamic(light: hex(0xEFEFEF), dark: hex(0x0B0B0B))
    /// Paper sheet / card surface (DESIGN.md `paper`: #FFFFFF light / #161616 dark).
    static let surface = dynamic(light: hex(0xFFFFFF), dark: hex(0x161616))
    /// Raised well / segmented track / hunk header (DESIGN.md `raised`: #F5F5F5 light / #1C1C1C dark).
    static let raised = dynamic(light: hex(0xF5F5F5), dark: hex(0x1C1C1C))
    static let subtleFill = raised
    /// 1px hairline divider (DESIGN.md `line`: #E6E6E6 light / #262626 dark).
    static let hairline = dynamic(light: hex(0xE6E6E6), dark: hex(0x262626))
    static let controlLine = dynamic(light: hex(0xD4D4D4), dark: hex(0x363636))

    static let ink = dynamic(light: hex(0x171717), dark: hex(0xEDEDED))
    static let onInk = dynamic(light: hex(0xFFFFFF), dark: hex(0x0B0B0B))
    static let muted = dynamic(light: hex(0x666666), dark: hex(0xA1A1A1))
    static let subtle = dynamic(light: hex(0x8A8A8A), dark: hex(0x737373))

    static let neutralInk = dynamic(light: hex(0x525252), dark: hex(0xB4B4B4))
    static let neutralSoft = dynamic(light: hex(0xF0F0F0), dark: hex(0x1F1F1F))

    static let danger = dynamic(light: hex(0xC4320A), dark: hex(0xFF977D))
    static let dangerSoft = dynamic(light: hex(0xFEEBE7), dark: hex(0xFF977D, alpha: 0.14))
    // Light status hues hold >= 4.5:1 on their soft fills at caption size.
    static let success = dynamic(light: hex(0x1B7049), dark: hex(0x3DD68C))
    static let successSoft = dynamic(light: hex(0xE6F6EB), dark: hex(0x3DD68C, alpha: 0.14))
    static let info = dynamic(light: hex(0x0B65B8), dark: hex(0x70B8FF))
    static let infoSoft = dynamic(light: hex(0xE6F4FE), dark: hex(0x70B8FF, alpha: 0.14))

    // Diff line backgrounds calibrated for crisp light & dark readability.
    static let diffAddFill = dynamic(light: hex(0xEBF9F0), dark: hex(0x3DD68C, alpha: 0.13))
    static let diffDelFill = dynamic(light: hex(0xFEF0EE), dark: hex(0xFF977D, alpha: 0.13))

    // Dedicated dark terminal / agent output palette (consistent across light & dark system schemes).
    static let terminalBg = dynamic(light: hex(0x121212), dark: hex(0x0F0F0F))
    static let terminalSurface = dynamic(light: hex(0x1C1C1C), dark: hex(0x181818))
    static let terminalBorder = dynamic(light: hex(0x2B2B2B), dark: hex(0x262626))
    static let terminalInk = Color(uiColor: hex(0xEDEDED))
    static let terminalMuted = Color(uiColor: hex(0x969696))
    static let terminalBlue = Color(uiColor: hex(0x70B8FF))
    static let terminalGreen = Color(uiColor: hex(0x3DD68C))
    static let terminalRed = Color(uiColor: hex(0xFF977D))
}

/// The one state word a row or task wears. Needs-you states are a solid ink chip; status keeps its hue.
enum StateTone {
    case needs
    case live
    case done
    case failed
    case neutral

    var foreground: Color {
        switch self {
        case .needs: return ToolrollTheme.onInk
        case .live: return ToolrollTheme.info
        case .done: return ToolrollTheme.success
        case .failed: return ToolrollTheme.danger
        case .neutral: return ToolrollTheme.neutralInk
        }
    }

    var background: Color {
        switch self {
        case .needs: return ToolrollTheme.ink
        case .live: return ToolrollTheme.infoSoft
        case .done: return ToolrollTheme.successSoft
        case .failed: return ToolrollTheme.dangerSoft
        case .neutral: return ToolrollTheme.neutralSoft
        }
    }

    /// The hue for an icon or a line of status text (needs-you text stays ink).
    var hue: Color {
        switch self {
        case .needs: return ToolrollTheme.ink
        default: return foreground
        }
    }
}

extension EnvironmentValues {
    /// What's on screen is cached from an earlier visit (the Mac can't be reached). Borders and state chips fade;
    /// text keeps full contrast, and a "Last updated" banner says how old it is.
    @Entry var showsStaleData = false
}

/// Signal badge / chip: 6pt corners, solid ink with no dot for Needs you; soft status wash with small dot for live/done/failed.
struct StateChip: View {
    let word: String
    let tone: StateTone
    @Environment(\.showsStaleData) private var stale

    var body: some View {
        HStack(spacing: 5) {
            if tone == .live || tone == .done || tone == .failed {
                Circle()
                    .fill(tone.foreground)
                    .frame(width: 5.5, height: 5.5)
                    .accessibilityHidden(true)
            }
            Text(word)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone.foreground)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(tone.background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .opacity(stale ? 0.6 : 1)
    }
}

/// A paper sheet/card on frame grey: 10pt corners, 1px hairline, or a full 1px ink outline when waiting on a person.
struct CardBackground: ViewModifier {
    var needsYou = false
    var radius: CGFloat = 10
    @Environment(\.showsStaleData) private var stale

    func body(content: Content) -> some View {
        content
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(needsYou ? ToolrollTheme.ink : ToolrollTheme.hairline, lineWidth: 1)
                    .opacity(stale ? 0.45 : 1)
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
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(ToolrollTheme.hairline, lineWidth: 1)
            )
        }
        .accessibilityElement(children: .combine)
    }
}

extension View {
    func card(needsYou: Bool = false, radius: CGFloat = 10) -> some View {
        modifier(CardBackground(needsYou: needsYou, radius: radius))
    }
}

/// The primary act: ink fill, on-ink words, 10pt corners (Signal button-touch).
struct InkButtonStyle: ButtonStyle {
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .headline)
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 48)
            .padding(.horizontal, 14)
            .foregroundStyle(ToolrollTheme.onInk)
            .background(ToolrollTheme.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

/// A secondary act: paper surface with hairline border and ink label.
struct OutlineButtonStyle: ButtonStyle {
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .headline)
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 48)
            .padding(.horizontal, 14)
            .foregroundStyle(ToolrollTheme.ink)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(ToolrollTheme.controlLine, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

/// The brand mark: three skewed bars, the middle one taller (DESIGN.md).
struct BrandMark: View {
    var size: CGFloat = 64

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(ToolrollTheme.ink)
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
            .fill(ToolrollTheme.onInk)
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
