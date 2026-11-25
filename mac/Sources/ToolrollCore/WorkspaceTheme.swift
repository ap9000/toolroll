import Foundation

public struct CustomThemePalette: Sendable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var base: String
    public var paper: String?
    public var ground: String?
    public var raised: String?
    public var fill: String?
    public var ink: String?
    public var muted: String?
    public var line: String?
    public var selection: String?
    public var selectionInk: String?
    public var chatBubble: String?
    public var chatBubbleInk: String?
    public var live: String?
    public var success: String?
    public var warning: String?
    public var danger: String?

    public init(
        name: String,
        base: String = "dark",
        paper: String? = nil,
        ground: String? = nil,
        raised: String? = nil,
        fill: String? = nil,
        ink: String? = nil,
        muted: String? = nil,
        line: String? = nil,
        selection: String? = nil,
        selectionInk: String? = nil,
        chatBubble: String? = nil,
        chatBubbleInk: String? = nil,
        live: String? = nil,
        success: String? = nil,
        warning: String? = nil,
        danger: String? = nil
    ) {
        self.name = name
        self.base = base
        self.paper = paper
        self.ground = ground
        self.raised = raised
        self.fill = fill
        self.ink = ink
        self.muted = muted
        self.line = line
        self.selection = selection
        self.selectionInk = selectionInk
        self.chatBubble = chatBubble
        self.chatBubbleInk = chatBubbleInk
        self.live = live
        self.success = success
        self.warning = warning
        self.danger = danger
    }
}

public struct WorkspaceAppearanceConfig: Sendable, Equatable {
    public var activeTheme: String
    public var density: String
    public var listSide: String
    public var showCosts: Bool
    public var reducedMotion: Bool
    public var notifyAsks: Bool
    public var notifyFinished: Bool
    public var notifyFailed: Bool
    public var glassChrome: Bool
    public var sidebarVibrancy: Bool
    public var savedThemes: [String: CustomThemePalette]
    public var colorOverrides: CustomThemePalette?

    public init(
        activeTheme: String = "signal",
        density: String = "comfortable",
        listSide: String = "left",
        showCosts: Bool = true,
        reducedMotion: Bool = false,
        notifyAsks: Bool = true,
        notifyFinished: Bool = true,
        notifyFailed: Bool = true,
        glassChrome: Bool = false,
        sidebarVibrancy: Bool = false,
        savedThemes: [String: CustomThemePalette] = [:],
        colorOverrides: CustomThemePalette? = nil
    ) {
        self.activeTheme = activeTheme
        self.density = density
        self.listSide = listSide
        self.showCosts = showCosts
        self.reducedMotion = reducedMotion
        self.notifyAsks = notifyAsks
        self.notifyFinished = notifyFinished
        self.notifyFailed = notifyFailed
        self.glassChrome = glassChrome
        self.sidebarVibrancy = sidebarVibrancy
        self.savedThemes = savedThemes
        self.colorOverrides = colorOverrides
    }

    public var isCompact: Bool { density == "compact" }
    public var isSidebarOnRight: Bool { listSide == "right" }

    public var effectiveCustomPalette: CustomThemePalette? {
        let basePalette = savedThemes[activeTheme]
        guard basePalette != nil || colorOverrides != nil else { return nil }
        let fallbackBase: String
        switch activeTheme.lowercased() {
        case "light": fallbackBase = "light"
        case "dark", "high-contrast": fallbackBase = "dark"
        default: fallbackBase = "system"
        }
        var merged = basePalette ?? CustomThemePalette(name: activeTheme, base: fallbackBase)
        if let ov = colorOverrides {
            if let v = ov.paper { merged.paper = v }
            if let v = ov.ground { merged.ground = v }
            if let v = ov.raised { merged.raised = v }
            if let v = ov.fill { merged.fill = v }
            if let v = ov.ink { merged.ink = v }
            if let v = ov.muted { merged.muted = v }
            if let v = ov.line { merged.line = v }
            if let v = ov.selection { merged.selection = v }
            if let v = ov.selectionInk { merged.selectionInk = v }
            if let v = ov.chatBubble { merged.chatBubble = v }
            if let v = ov.chatBubbleInk { merged.chatBubbleInk = v }
            if let v = ov.live { merged.live = v }
            if let v = ov.success { merged.success = v }
            if let v = ov.warning { merged.warning = v }
            if let v = ov.danger { merged.danger = v }
        }
        return merged
    }
}

public enum WorkspaceThemeStore {
    public static var configDirectoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/toolroll", isDirectory: true)
    }

    public static var configURL: URL {
        configDirectoryURL.appendingPathComponent("tui.toml")
    }

    public static func load(from url: URL = configURL) -> WorkspaceAppearanceConfig {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            return WorkspaceAppearanceConfig()
        }
        return parse(toml: text)
    }

    public static func parse(toml: String) -> WorkspaceAppearanceConfig {
        var cfg = WorkspaceAppearanceConfig()
        var section = ""

        for rawLine in toml.components(separatedBy: .newlines) {
            let line = stripInlineComment(rawLine).trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }

            if line.hasPrefix("[") && line.hasSuffix("]") {
                section = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                if section.hasPrefix("themes.") {
                    let name = String(section.dropFirst("themes.".count)).trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty && cfg.savedThemes[name] == nil {
                        cfg.savedThemes[name] = CustomThemePalette(name: name)
                    }
                }
                continue
            }

            guard let eqIdx = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eqIdx]).trimmingCharacters(in: .whitespaces)
            let rawVal = String(line[line.index(after: eqIdx)...]).trimmingCharacters(in: .whitespaces)
            let strVal = unquote(rawVal)
            let boolVal = (strVal.lowercased() == "true")

            if section.isEmpty {
                switch key {
                case "theme": cfg.activeTheme = strVal
                case "density": cfg.density = strVal
                case "list_side": cfg.listSide = strVal
                case "show_costs": cfg.showCosts = boolVal
                case "reduced_motion": cfg.reducedMotion = boolVal
                default: break
                }
            } else if section == "notifications" {
                switch key {
                case "asks": cfg.notifyAsks = boolVal
                case "finished": cfg.notifyFinished = boolVal
                case "failed": cfg.notifyFailed = boolVal
                default: break
                }
            } else if section == "mac" {
                switch key {
                case "glass": cfg.glassChrome = boolVal
                case "sidebar_vibrancy": cfg.sidebarVibrancy = boolVal
                default: break
                }
            } else if section == "colors" {
                var ov = cfg.colorOverrides ?? CustomThemePalette(name: "overrides")
                assignColor(&ov, key: key, value: strVal)
                cfg.colorOverrides = ov
            } else if section.hasPrefix("themes.") {
                let name = String(section.dropFirst("themes.".count)).trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { continue }
                var pal = cfg.savedThemes[name] ?? CustomThemePalette(name: name)
                assignColor(&pal, key: key, value: strVal)
                cfg.savedThemes[name] = pal
            }
        }
        return cfg
    }

    public static func savePreferences(
        theme: String? = nil,
        density: String? = nil,
        listSide: String? = nil,
        showCosts: Bool? = nil,
        glassChrome: Bool? = nil,
        sidebarVibrancy: Bool? = nil,
        notifyAsks: Bool? = nil,
        notifyFinished: Bool? = nil,
        to url: URL = configURL
    ) {
        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? "# Toolroll workspace appearance (live-synced with Lead's toolroll_view_set)\n"
        var lines = existing.components(separatedBy: "\n")

        func upsertTopLevel(_ key: String, value: String) {
            let firstSectionIdx = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[") }) ?? lines.count
            if let existingIdx = lines[..<firstSectionIdx].firstIndex(where: {
                $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(key) =") || $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(key)=")
            }) {
                lines[existingIdx] = "\(key) = \(value)"
            } else {
                lines.insert("\(key) = \(value)", at: firstSectionIdx)
            }
        }

        func upsertSection(_ sectionName: String, key: String, value: String) {
            let header = "[\(sectionName)]"
            if let startIdx = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == header }) {
                let nextSection = lines[(startIdx + 1)...].firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[") }) ?? lines.count
                if let existingIdx = lines[(startIdx + 1)..<nextSection].firstIndex(where: {
                    $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(key) =") || $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(key)=")
                }) {
                    lines[existingIdx] = "\(key) = \(value)"
                } else {
                    lines.insert("\(key) = \(value)", at: nextSection)
                }
            } else {
                if let last = lines.last, !last.trimmingCharacters(in: .whitespaces).isEmpty {
                    lines.append("")
                }
                lines.append(header)
                lines.append("\(key) = \(value)")
            }
        }

        if let theme { upsertTopLevel("theme", value: "\"\(theme)\"") }
        if let density { upsertTopLevel("density", value: "\"\(density)\"") }
        if let listSide { upsertTopLevel("list_side", value: "\"\(listSide)\"") }
        if let showCosts { upsertTopLevel("show_costs", value: showCosts ? "true" : "false") }
        if let glassChrome { upsertSection("mac", key: "glass", value: glassChrome ? "true" : "false") }
        if let sidebarVibrancy { upsertSection("mac", key: "sidebar_vibrancy", value: sidebarVibrancy ? "true" : "false") }
        if let notifyAsks { upsertSection("notifications", key: "asks", value: notifyAsks ? "true" : "false") }
        if let notifyFinished { upsertSection("notifications", key: "finished", value: notifyFinished ? "true" : "false") }

        let rendered = lines.joined(separator: "\n")
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try rendered.write(to: url, atomically: true, encoding: .utf8)
        } catch {
        }
    }

    public static func parseHex(_ raw: String?) -> (r: Double, g: Double, b: Double)? {
        guard let raw else { return nil }
        var hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex = String(hex.dropFirst()) }
        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }
        guard hex.count == 6, let val = UInt32(hex, radix: 16) else { return nil }
        return (
            Double((val >> 16) & 0xFF) / 255.0,
            Double((val >> 8) & 0xFF) / 255.0,
            Double(val & 0xFF) / 255.0
        )
    }

    private static func assignColor(_ pal: inout CustomThemePalette, key: String, value: String) {
        switch key {
        case "base": pal.base = value
        case "paper": pal.paper = value
        case "ground": pal.ground = value
        case "raised": pal.raised = value
        case "fill": pal.fill = value
        case "ink": pal.ink = value
        case "muted": pal.muted = value
        case "line", "rule": pal.line = value
        case "selection", "accent": pal.selection = value
        case "selection-ink", "selection_ink": pal.selectionInk = value
        case "chat-bubble", "chat_bubble": pal.chatBubble = value
        case "chat-bubble-ink", "chat_bubble_ink": pal.chatBubbleInk = value
        case "live", "info": pal.live = value
        case "success", "ok", "green": pal.success = value
        case "warning", "warn", "amber": pal.warning = value
        case "danger", "error", "red": pal.danger = value
        default: break
        }
    }

    private static func stripInlineComment(_ line: String) -> String {
        var inQuotes = false
        var out = ""
        for ch in line {
            if ch == "\"" { inQuotes.toggle() }
            if ch == "#" && !inQuotes { break }
            out.append(ch)
        }
        return out
    }

    private static func unquote(_ raw: String) -> String {
        if raw.hasPrefix("\"") && raw.hasSuffix("\"") && raw.count >= 2 {
            return String(raw.dropFirst().dropLast())
        }
        if raw.hasPrefix("'") && raw.hasSuffix("'") && raw.count >= 2 {
            return String(raw.dropFirst().dropLast())
        }
        return raw
    }
}
