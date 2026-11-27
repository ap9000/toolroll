import SwiftUI
import ToolrollCompanionCore

/// Signal (DESIGN.md) for the phone: warm paper, ink for every act and for what waits on a person,
/// colour kept for status (failed vermilion, live blue, done green). No amber anywhere.
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

    static let paper = dynamic(light: hex(0xFAF9F6), dark: hex(0x111214))
    static let surface = dynamic(light: .white, dark: hex(0x1B1D20))
    static let subtleFill = dynamic(light: hex(0xF2F0EB), dark: hex(0x26282C))
    static let hairline = dynamic(light: UIColor(white: 0, alpha: 0.08), dark: UIColor(white: 1, alpha: 0.10))
    static let ink = dynamic(light: hex(0x171717), dark: hex(0xEDEDED))
    static let onInk = dynamic(light: .white, dark: hex(0x0A0A0A))
    static let muted = dynamic(light: hex(0x666666), dark: hex(0xA1A1A1))

    static let neutralInk = dynamic(light: hex(0x525252), dark: hex(0xB4B4B4))
    static let neutralSoft = dynamic(light: hex(0xF0EFEC), dark: hex(0x26282C))

    static let danger = dynamic(light: hex(0xC4320A), dark: hex(0xFF977D))
    static let dangerSoft = dynamic(light: hex(0xFEEBE7), dark: hex(0xFF977D, alpha: 0.14))
    // Light status hues hold ≥ 4.5:1 on their soft fills at caption size (info 5.3:1, success 5.4:1).
    static let success = dynamic(light: hex(0x1B7049), dark: hex(0x3DD68C))
    static let successSoft = dynamic(light: hex(0xE6F6EB), dark: hex(0x3DD68C, alpha: 0.14))
    static let info = dynamic(light: hex(0x0B65B8), dark: hex(0x70B8FF))
    static let infoSoft = dynamic(light: hex(0xE6F4FE), dark: hex(0x70B8FF, alpha: 0.14))
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

struct StateChip: View {
    let word: String
    let tone: StateTone
    @Environment(\.showsStaleData) private var stale

    var body: some View {
        Text(word)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tone.foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tone.background, in: Capsule())
            .opacity(stale ? 0.6 : 1)
    }
}

/// A card on paper: white surface, hairline edge, or a full 1px ink outline when it waits on a person.
struct CardBackground: ViewModifier {
    var needsYou = false
    var radius: CGFloat = 14
    @Environment(\.showsStaleData) private var stale

    func body(content: Content) -> some View {
        content
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(needsYou ? ToolrollTheme.ink : ToolrollTheme.hairline, lineWidth: 1)
                    .opacity(stale ? 0.4 : 1)
            )
    }
}

/// Over cached data while the Mac can't be reached: how old it is, kept current by the minute.
struct StaleDataBanner: View {
    let lastUpdated: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Label {
                Text(lastUpdated.map { "Last updated \(RelativeTime.ago($0, now: context.date))" } ?? "Showing what was here last time")
            } icon: {
                Image(systemName: "clock")
            }
            .font(.footnote)
            .foregroundStyle(ToolrollTheme.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollTheme.neutralSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .accessibilityElement(children: .combine)
    }
}

extension View {
    func card(needsYou: Bool = false, radius: CGFloat = 14) -> some View {
        modifier(CardBackground(needsYou: needsYou, radius: radius))
    }
}

/// The primary act: ink fill, paper words.
struct InkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .foregroundStyle(ToolrollTheme.onInk)
            .background(ToolrollTheme.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

/// A secondary act: a paper pill with an ink label.
struct OutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .foregroundStyle(ToolrollTheme.ink)
            .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(ToolrollTheme.hairline, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// The brand mark: three skewed bars, the middle one taller (DESIGN.md).
struct BrandMark: View {
    var size: CGFloat = 64

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(ToolrollTheme.ink)
            HStack(alignment: .center, spacing: size * 0.07) {
                bar(height: size * 0.30)
                bar(height: size * 0.46)
                bar(height: size * 0.30)
            }
            .transformEffect(CGAffineTransform(a: 1, b: 0, c: -0.18, d: 1, tx: size * 0.04, ty: 0))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func bar(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: size * 0.03)
            .fill(ToolrollTheme.paper)
            .frame(width: size * 0.08, height: height)
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
