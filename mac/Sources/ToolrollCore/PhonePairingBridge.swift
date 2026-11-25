import Foundation

public enum PhoneChannel: String, CaseIterable, Identifiable, Sendable {
    case telegram
    case slack
    case discord
    case teams
    case mobileWeb

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .telegram: return "Telegram"
        case .slack: return "Slack"
        case .discord: return "Discord"
        case .teams: return "Teams"
        case .mobileWeb: return "Mobile Web"
        }
    }

    public var badge: String {
        switch self {
        case .telegram: return "Fastest · 30s · Works behind NAT"
        case .slack: return "Socket Mode · Private DM"
        case .discord: return "Outbound Bot · Private DM"
        case .teams: return "Personal Chat · Public HTTPS"
        case .mobileWeb: return "QR · Tailscale / HTTPS"
        }
    }

    public var symbolName: String {
        switch self {
        case .telegram: return "paperplane.fill"
        case .slack: return "number.square.fill"
        case .discord: return "bubble.left.and.bubble.right.fill"
        case .teams: return "person.2.fill"
        case .mobileWeb: return "qrcode"
        }
    }

    public var settingsPath: String? {
        switch self {
        case .telegram: return "/settings/telegram"
        case .slack: return "/settings/slack"
        case .discord: return "/settings/discord"
        case .teams: return "/settings/teams"
        case .mobileWeb: return nil
        }
    }

    public var pairEndpoint: String? {
        switch self {
        case .telegram: return "/settings/telegram/pair"
        case .slack: return "/settings/slack/pair"
        case .discord: return "/settings/discord/pair"
        case .teams: return "/settings/teams/pair"
        case .mobileWeb: return nil
        }
    }

    public var unpairEndpoint: String? {
        switch self {
        case .telegram: return "/settings/telegram/unpair"
        case .slack: return "/settings/slack/unpair"
        case .discord: return "/settings/discord/unpair"
        case .teams: return "/settings/teams/unpair"
        case .mobileWeb: return nil
        }
    }

    public var testPromptHint: String {
        switch self {
        case .telegram: return "Send /status or \"What needs my attention?\" to your bot."
        case .slack: return "DM your Toolroll Slack app: \"What needs my attention?\""
        case .discord: return "DM your Toolroll Discord bot: \"What needs my attention?\""
        case .teams: return "Message your Toolroll Teams bot: \"status\" or \"What needs my attention?\""
        case .mobileWeb: return "Open the Mobile Web console and tap Share → Add to Home Screen."
        }
    }
}

public struct PhoneChannelStatus: Equatable, Sendable {
    public let channel: PhoneChannel
    public let botConnected: Bool
    public let isPaired: Bool
    public let isLive: Bool
    public let workspaceLabel: String?
    public let pairingCode: String?
    public let problem: String?

    public init(
        channel: PhoneChannel,
        botConnected: Bool,
        isPaired: Bool,
        isLive: Bool = false,
        workspaceLabel: String? = nil,
        pairingCode: String? = nil,
        problem: String? = nil
    ) {
        self.channel = channel
        self.botConnected = botConnected
        self.isPaired = isPaired
        self.isLive = isLive
        self.workspaceLabel = workspaceLabel
        self.pairingCode = pairingCode
        self.problem = problem
    }
}

public enum PhonePairingParser {
    public static func parse(html: String, channel: PhoneChannel) -> PhoneChannelStatus {
        switch channel {
        case .telegram:
            return parseTelegramHTML(html)
        case .slack, .discord, .teams:
            return parseChatAppHTML(html, channel: channel)
        case .mobileWeb:
            return PhoneChannelStatus(channel: .mobileWeb, botConnected: true, isPaired: false)
        }
    }

    public static func parseTelegramHTML(_ html: String) -> PhoneChannelStatus {
        let problem = extractNotice(html)
        let botConnected = !html.contains("No Telegram bot is connected yet")
            && !html.contains("· Not saved")
            && (html.contains("· Saved") || html.contains("id=\"telegram-pair\""))
        let isPaired = html.contains("Your phone is paired.")
            || html.contains("id=\"telegram-unpair-form\"")
        let pairingCode = extractFirstMatch(
            pattern: #"<code[^>]*class="[^"]*k-mono[^"]*"[^>]*>(/pair\s+[^<]+)</code>"#,
            in: html
        ).map(decodeHTMLEntities)
        return PhoneChannelStatus(
            channel: .telegram,
            botConnected: botConnected,
            isPaired: isPaired,
            isLive: botConnected && isPaired,
            workspaceLabel: botConnected ? "Telegram bot connected" : nil,
            pairingCode: pairingCode,
            problem: problem
        )
    }

    public static func parseChatAppHTML(_ html: String, channel: PhoneChannel) -> PhoneChannelStatus {
        let problem = extractNotice(html)
        let botConnected = !html.contains("id=\"connect-form\"") && html.contains("id=\"connection\"")
        let isPaired = html.contains("id=\"unpair-form\"")
            || html.contains("Your account is paired")
            || html.contains("· Paired")
        let isLive = botConnected && (html.contains(">Connected<") || html.contains(">Signed in<"))
        let pairingCode = extractFirstMatch(
            pattern: #"<code[^>]*class="[^"]*k-mono[^"]*"[^>]*>(pair\s+[^<]+)</code>"#,
            in: html
        ).map(decodeHTMLEntities)
        let workspaceLabel = extractConnectionHeading(html).map(decodeHTMLEntities)
        return PhoneChannelStatus(
            channel: channel,
            botConnected: botConnected,
            isPaired: isPaired,
            isLive: isLive,
            workspaceLabel: workspaceLabel,
            pairingCode: pairingCode,
            problem: problem
        )
    }

    private static func extractConnectionHeading(_ html: String) -> String? {
        guard let sectionRange = html.range(of: "id=\"connection\"") else { return nil }
        let tail = String(html[sectionRange.lowerBound...].prefix(600))
        guard let raw = extractFirstMatch(pattern: #"<h[23][^>]*>(.*?)</h[23]>"#, in: tail) else { return nil }
        let stripped = stripTags(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = stripped
            .replacingOccurrences(of: "Connected", with: "")
            .replacingOccurrences(of: "Waiting for connection", with: "")
            .replacingOccurrences(of: "Signed in", with: "")
            .replacingOccurrences(of: "Waiting for sign-in", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func extractNotice(_ html: String) -> String? {
        if let raw = extractFirstMatch(pattern: #"<p[^>]*role="alert"[^>]*>(.*?)</p>"#, in: html) {
            let text = decodeHTMLEntities(stripTags(raw)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        if let raw = extractFirstMatch(pattern: #"<div[^>]*class="[^"]*k-notice[^"]*"[^>]*role="alert"[^>]*>(.*?)</div>"#, in: html) {
            let text = decodeHTMLEntities(stripTags(raw)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return nil
    }

    private static func extractFirstMatch(pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators, .caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text)
        else {
            return nil
        }
        return String(text[captureRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stripTags(_ raw: String) -> String {
        raw.replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    }

    private static func decodeHTMLEntities(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&#x27;", with: "'")
    }
}
