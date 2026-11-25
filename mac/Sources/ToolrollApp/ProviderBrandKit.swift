import SwiftUI
import ToolrollCore

struct SVGPathShape: Shape {
    let commands: [Command]

    enum Command {
        case move(CGPoint)
        case line(CGPoint)
        case curve(CGPoint, CGPoint, CGPoint)
        case close
    }

    init(svgPath: String) {
        self.commands = Self.parse(svgPath)
    }

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 24.0
        let sy = rect.height / 24.0
        let ox = rect.minX
        let oy = rect.minY
        var p = Path()
        for cmd in commands {
            switch cmd {
            case .move(let pt):
                p.move(to: CGPoint(x: ox + pt.x * sx, y: oy + pt.y * sy))
            case .line(let pt):
                p.addLine(to: CGPoint(x: ox + pt.x * sx, y: oy + pt.y * sy))
            case .curve(let c1, let c2, let end):
                p.addCurve(
                    to: CGPoint(x: ox + end.x * sx, y: oy + end.y * sy),
                    control1: CGPoint(x: ox + c1.x * sx, y: oy + c1.y * sy),
                    control2: CGPoint(x: ox + c2.x * sx, y: oy + c2.y * sy)
                )
            case .close:
                p.closeSubpath()
            }
        }
        return p
    }

    private static func parse(_ d: String) -> [Command] {
        var out: [Command] = []
        let chars = Array(d.unicodeScalars)
        var i = 0
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCmd: UnicodeScalar = "M"

        func skipSep() {
            while i < chars.count {
                let c = chars[i]
                if c == " " || c == "," || c == "\t" || c == "\n" || c == "\r" {
                    i += 1
                } else {
                    break
                }
            }
        }

        func isCmd(_ s: UnicodeScalar) -> Bool {
            (s >= "A" && s <= "Z") || (s >= "a" && s <= "z")
        }

        func readNumber() -> Double? {
            skipSep()
            guard i < chars.count else { return nil }
            let startIdx = i
            if chars[i] == "+" || chars[i] == "-" {
                i += 1
            }
            var hasDot = false
            var hasDigits = false
            while i < chars.count {
                let c = chars[i]
                if c >= "0" && c <= "9" {
                    hasDigits = true
                    i += 1
                } else if c == "." && !hasDot {
                    hasDot = true
                    i += 1
                } else {
                    break
                }
            }
            guard hasDigits else {
                i = startIdx
                return nil
            }
            if i < chars.count && (chars[i] == "e" || chars[i] == "E") {
                let expIdx = i
                i += 1
                if i < chars.count && (chars[i] == "+" || chars[i] == "-") { i += 1 }
                var expDigits = false
                while i < chars.count && chars[i] >= "0" && chars[i] <= "9" {
                    expDigits = true
                    i += 1
                }
                if !expDigits { i = expIdx }
            }
            let str = String(String.UnicodeScalarView(chars[startIdx..<i]))
            return Double(str)
        }

        while i < chars.count {
            skipSep()
            guard i < chars.count else { break }
            var cmd = lastCmd
            if isCmd(chars[i]) {
                cmd = chars[i]
                i += 1
                lastCmd = cmd
            }

            switch cmd {
            case "M", "m":
                guard let x = readNumber(), let y = readNumber() else { break }
                let pt = cmd == "m" ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                cur = pt
                start = pt
                out.append(.move(pt))
                lastCmd = cmd == "m" ? "l" : "L"

            case "L", "l":
                guard let x = readNumber(), let y = readNumber() else { break }
                let pt = cmd == "l" ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                cur = pt
                out.append(.line(pt))

            case "H", "h":
                guard let x = readNumber() else { break }
                let pt = CGPoint(x: cmd == "h" ? cur.x + x : x, y: cur.y)
                cur = pt
                out.append(.line(pt))

            case "V", "v":
                guard let y = readNumber() else { break }
                let pt = CGPoint(x: cur.x, y: cmd == "v" ? cur.y + y : y)
                cur = pt
                out.append(.line(pt))

            case "C", "c":
                guard let x1 = readNumber(), let y1 = readNumber(),
                      let x2 = readNumber(), let y2 = readNumber(),
                      let x = readNumber(), let y = readNumber()
                else { break }
                let rel = cmd == "c"
                let c1 = CGPoint(x: rel ? cur.x + x1 : x1, y: rel ? cur.y + y1 : y1)
                let c2 = CGPoint(x: rel ? cur.x + x2 : x2, y: rel ? cur.y + y2 : y2)
                let end = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                cur = end
                out.append(.curve(c1, c2, end))

            case "Z", "z":
                cur = start
                out.append(.close)

            default:
                break
            }
        }
        return out
    }
}

enum ProviderBrandPaths {
    static let claude = SVGPathShape(
        svgPath: "M5.926,15.298l3.933-2.207l.066-.192l-.066-.106h-.192l-.658-.041l-2.247-.061l-1.949-.081l-1.888-.101l-.476-.101l-.445-.587l.046-.294l.4-.268l.572,.051l1.265,.086l1.898,.132l1.377,.081l2.04,.213h.324l.046-.132l-.111-.081l-.086-.081l-1.964-1.331l-2.126-1.407l-1.113-.81l-.602-.41l-.304-.385l-.132-.84l.547-.602l.734,.051l.187,.051l.744,.572l1.589,1.23l2.075,1.529l.304,.253l.121-.086l.015-.061l-.137-.228l-1.129-2.04l-1.205-2.075l-.536-.86l-.142-.516c-.051-.213-.086-.39-.086-.607l.623-.845l.344-.111l.83,.111l.349,.304l.516,1.179l.835,1.858l1.296,2.526l.38,.749l.202,.693l.076,.213h.132v-.121l.106-1.422l.197-1.746l.192-2.247l.066-.633l.314-.759l.623-.41l.486,.233l.4,.572l-.056,.37l-.238,1.544l-.466,2.419l-.304,1.62h.177l.202-.202l.82-1.088l1.377-1.721l.607-.683l.709-.754l.456-.359h.86l.633,.941l-.283,.972l-.886,1.124l-.734,.952l-1.053,1.417l-.658,1.134l.061,.091l.157-.015l2.379-.506l1.286-.233l1.534-.263l.693,.324l.076,.329l-.273,.673l-1.64,.405l-1.923,.385l-2.865,.678l-.035,.025l.041,.051l1.291,.121l.552,.03h1.351l2.516,.187l.658,.435l.395,.532l-.066,.405l-1.012,.516l-1.367-.324l-3.189-.759l-1.093-.273h-.152v.091l.911,.891l1.67,1.508l2.09,1.944l.106,.481l-.268,.38l-.283-.041l-1.837-1.382l-.709-.623l-1.604-1.351h-.106v.142l.369,.542l1.954,2.936l.101,.901l-.142,.294l-.506,.177l-.557-.101l-1.144-1.604l-1.179-1.807l-.952-1.62l-.116,.066l-.562,6.048l-.263,.309l-.607,.233l-.506-.385l-.268-.623l.268-1.23l.324-1.604l.263-1.275l.238-1.584l.142-.526l-.01-.035l-.116,.015l-1.194,1.64l-1.817,2.455l-1.437,1.539l-.344,.137l-.597-.309l.056-.552l.334-.491l1.989-2.531l1.2-1.569l.774-.906l-.005-.132h-.046l-5.284,3.432l-.941,.121l-.405-.38l.051-.622l.192-.202l1.589-1.093z"
    )

    static let openai = SVGPathShape(
        svgPath: "M9.367,2.175c1.818-.487 3.67,.075 4.913,1.315c1.697-.453 3.582-.014 4.912,1.317c1.331,1.331 1.77,3.216 1.317,4.913v0c1.241,1.243 1.803,3.095 1.316,4.913c-.487,1.818-1.9,3.141-3.596,3.597c-.456,1.696-1.779,3.109-3.597,3.596c-1.818,.487-3.67-.075-4.913-1.315c-1.697,.453-3.582,.014-4.913-1.317c-1.331-1.331-1.77-3.216-1.317-4.913c-1.24-1.243-1.803-3.095-1.315-4.913c.487-1.818 1.9-3.141 3.596-3.597c.456-1.696 1.779-3.109 3.597-3.596zM15.436,17.077c0,.206-.11,.397-.288,.5l-4.236,2.445c.937,.723 2.189,1.017 3.421,.687c1.737-.466 2.89-2.025 2.914-3.739v-4.36c0-.132-.071-.255-.185-.32l-1.626-.939zM9.321,17.515c-.178,.103-.398,.103-.577,0l-4.235-2.445c-.158,1.174 .214,2.405 1.116,3.307h0c1.272,1.272 3.199,1.49 4.695,.654l3.776-2.18c.114-.066 .185-.189 .185-.321v-1.877zM15.152,7.76c-.114-.066-.256-.065-.37,0l-1.626,.939l4.959,2.863c.179,.103 .289,.294 .289,.5v4.891c1.095-.45 1.975-1.388 2.305-2.62c.465-1.737-.309-3.515-1.781-4.393zM5.596,7.047c-1.095,.45-1.975,1.388-2.306,2.62c-.465,1.737 .309,3.515 1.781,4.393l3.776,2.18c.114,.066 .256,.065 .37,0l1.626-.939l-4.959-2.863c-.179-.103-.288-.294-.288-.5zM9.72,10.684v2.633l2.28,1.316l2.28-1.316v-2.633l-2.28-1.317zM13.088,3.978c-.937-.723-2.189-1.017-3.421-.687c-1.737,.466-2.89,2.025-2.914,3.739v4.36c0,.132 .071,.255 .185,.32l1.626,.939v-5.726c0-.206 .11-.397 .289-.5zM18.376,5.625c-1.272-1.272-3.199-1.49-4.695-.654l-3.776,2.18c-.114,.066-.185,.189-.185,.321v1.877l4.959-2.863c.178-.103 .398-.103 .577,0l4.235,2.445c.158-1.174-.214-2.405-1.116-3.306z"
    )

    static let gemini = SVGPathShape(
        svgPath: "M12,2C12,7.523 16.477,12 22,12C16.477,12 12,16.477 12,22C12,16.477 7.523,12 2,12C7.523,12 12,7.523 12,2Z"
    )
}

@MainActor
public struct ProviderBrandGlyph: View {
    public let provider: String
    public var size: CGFloat = 14
    public var tinted: Bool = true
    public var inTile: Bool = false

    public init(provider: String, size: CGFloat = 14, tinted: Bool = true, inTile: Bool = false) {
        self.provider = provider
        self.size = size
        self.tinted = tinted
        self.inTile = inTile
    }

    public static func accentColor(for provider: String) -> Color {
        switch provider.lowercased() {
        case "claude", "anthropic":
            return Color(red: 0.88, green: 0.54, blue: 0.41)
        case "codex", "openai":
            return Color(red: 0.36, green: 0.88, blue: 0.63)
        case "gemini", "google", "antigravity":
            return Color(red: 0.47, green: 0.70, blue: 1.0)
        default:
            return ToolrollPalette.ink
        }
    }

    private var glyphColor: Color {
        tinted ? Self.accentColor(for: provider) : ToolrollPalette.ink
    }

    @ViewBuilder
    private func rawIcon(iconSize: CGFloat) -> some View {
        switch provider.lowercased() {
        case "claude", "anthropic":
            ProviderBrandPaths.claude
                .fill(glyphColor)
                .frame(width: iconSize, height: iconSize)
        case "codex", "openai":
            ProviderBrandPaths.openai
                .fill(glyphColor, style: FillStyle(eoFill: true))
                .frame(width: iconSize, height: iconSize)
        case "gemini", "google", "antigravity":
            ProviderBrandPaths.gemini
                .fill(glyphColor)
                .frame(width: iconSize, height: iconSize)
        case "lead", "toolroll":
            ToolrollBrandMark(height: iconSize * 0.92)
        default:
            Image(systemName: "bolt.fill")
                .font(.system(size: iconSize * 0.75))
                .foregroundStyle(glyphColor)
                .frame(width: iconSize, height: iconSize)
        }
    }

    public var body: some View {
        if inTile {
            let accent = Self.accentColor(for: provider)
            let isLead = provider.lowercased() == "lead" || provider.lowercased() == "toolroll"
            ZStack {
                RoundedRectangle(cornerRadius: max(5, size * 0.28), style: .continuous)
                    .fill(isLead ? ToolrollPalette.raised : accent.opacity(tinted ? 0.12 : 0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: max(5, size * 0.28), style: .continuous)
                            .strokeBorder(isLead ? ToolrollPalette.line : accent.opacity(tinted ? 0.26 : 0.16), lineWidth: 1)
                    )
                rawIcon(iconSize: size * 0.62)
            }
            .frame(width: size, height: size)
        } else {
            rawIcon(iconSize: size)
        }
    }
}

@MainActor
public struct UserMonogramBadge: View {
    public let account: String
    public var size: CGFloat = 20

    public init(account: String = "", size: CGFloat = 20) {
        self.account = account
        self.size = size
    }

    private var initials: String {
        let full = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = full.split(whereSeparator: { $0.isWhitespace })
        if parts.count >= 2, let a = parts.first?.first, let b = parts.last?.first {
            return "\(a)\(b)".uppercased()
        }
        let cleaned = account.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.count >= 2 {
            return String(cleaned.prefix(2)).uppercased()
        }
        if let first = full.first ?? cleaned.first {
            return String(first).uppercased()
        }
        return "U"
    }

    public var body: some View {
        Text(initials)
            .font(.system(size: max(8.5, size * 0.44), weight: .semibold))
            .tracking(-0.2)
            .foregroundStyle(ToolrollPalette.ink)
            .frame(width: size, height: size)
            .background(ToolrollPalette.raised, in: Circle())
            .overlay(Circle().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
    }
}

@MainActor
public struct ToolrollKineticLoader: View {
    public var provider: String = "lead"
    public var height: CGFloat = 14

    public init(provider: String = "lead", height: CGFloat = 14) {
        self.provider = provider
        self.height = height
    }

    public var body: some View {
        let color = ProviderBrandGlyph.accentColor(for: provider)
        let reduced = WorkspaceThemeEngine.shared.config.reducedMotion
        if reduced {
            bars(phase: 0.4, color: color)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                bars(phase: t * 3.4, color: color)
            }
        }
    }

    private func bars(phase: Double, color: Color) -> some View {
        let scale = height / 18.0
        let barW = max(2.0, 3.0 * scale)
        let spacing = max(1.8, 2.6 * scale)
        return HStack(alignment: .center, spacing: spacing) {
            ForEach(0..<3, id: \.self) { idx in
                let wave = 0.5 + 0.5 * sin(phase - Double(idx) * 0.85)
                let baseH: CGFloat = (idx == 1) ? 16.0 : 11.5
                let minFactor: CGFloat = 0.38
                let factor = minFactor + CGFloat(wave) * (1.0 - minFactor)
                RoundedRectangle(cornerRadius: max(0.8, 1.0 * scale))
                    .fill(color.opacity(0.45 + 0.55 * wave))
                    .frame(width: barW, height: baseH * scale * factor)
            }
        }
        .frame(width: 15.0 * scale, height: height)
        .transformEffect(CGAffineTransform(a: 1, b: tan(-10 * .pi / 180), c: 0, d: 1, tx: 0, ty: 7 * scale * tan(10 * .pi / 180)))
        .accessibilityHidden(true)
    }
}

@MainActor
public struct KineticThinkingRow: View {
    public let provider: String
    public let label: String

    public init(provider: String = "lead", label: String = "Thinking…") {
        self.provider = provider
        self.label = label
    }

    public var body: some View {
        HStack(spacing: 8) {
            ToolrollKineticLoader(provider: provider, height: 13)
                .frame(width: 20, height: 20)
            shimmerLabel
        }
    }

    @ViewBuilder
    private var shimmerLabel: some View {
        if WorkspaceThemeEngine.shared.config.reducedMotion {
            Text(label)
                .font(.system(size: 12.5, weight: .medium))
                .tracking(-0.1)
                .foregroundStyle(ToolrollPalette.muted)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let cycle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.0) / 2.0
                let pos = CGFloat(cycle * 2.4 - 0.7)
                Text(label)
                    .font(.system(size: 12.5, weight: .medium))
                    .tracking(-0.1)
                    .foregroundStyle(ToolrollPalette.muted)
                    .overlay {
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: max(0, pos - 0.35)),
                                .init(color: ToolrollPalette.ink, location: min(1, max(0, pos))),
                                .init(color: .clear, location: min(1, pos + 0.35)),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .mask(
                            Text(label)
                                .font(.system(size: 12.5, weight: .medium))
                                .tracking(-0.1)
                        )
                    }
            }
        }
    }
}
