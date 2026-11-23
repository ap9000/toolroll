import Foundation

/// The Work screen's built-in widgets (phase 1: bundled definitions; a manifest format and server sync come later,
/// see docs/plans/work-screen-widgets.md).
public enum WorkWidgetKind: String, Codable, CaseIterable, Sendable {
    case header
    case limits
    case list

    public var title: String {
        switch self {
        case .header: return "Summary"
        case .limits: return "Limits"
        case .list: return "Work list"
        }
    }

    public var detail: String {
        switch self {
        case .header: return "What waits on you, what's running, what settled"
        case .limits: return "Plan usage and today's spend (shown to the workspace owner)"
        case .list: return "Every task, grouped by what it needs"
        }
    }
}

public struct WorkWidgetInstance: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: WorkWidgetKind
    public var isHidden: Bool

    public init(id: String, kind: WorkWidgetKind, isHidden: Bool) {
        self.id = id
        self.kind = kind
        self.isHidden = isHidden
    }
}

/// The person's Work layout: order and visibility. Saved on this Mac until layouts sync through the server.
public struct WorkLayout: Codable, Equatable, Sendable {
    public static let schemaV1 = "toolroll.work-layout/v1"
    public static let defaultsKey = "toolroll.workLayout"

    public var schema: String = WorkLayout.schemaV1
    public var widgets: [WorkWidgetInstance]

    public init(schema: String = WorkLayout.schemaV1, widgets: [WorkWidgetInstance]) {
        self.schema = schema
        self.widgets = widgets
    }

    /// Version A, "Quiet list": summary, limits, then the list.
    public static let standard = WorkLayout(widgets: WorkWidgetKind.allCases.map { WorkWidgetInstance(id: $0.rawValue, kind: $0, isHidden: false) })

    /// The saved layout, or the standard one when there is none, it can't be read, or it's from a newer schema.
    /// Built-ins added since it was saved join at the end, so Work is never missing a widget or blank.
    public static func load(from defaults: UserDefaults = .standard) -> WorkLayout {
        guard let data = defaults.data(forKey: defaultsKey),
              let saved = try? JSONDecoder().decode(WorkLayout.self, from: data),
              saved.schema == schemaV1
        else { return .standard }
        var seen = Set<WorkWidgetKind>()
        var widgets = saved.widgets.filter { seen.insert($0.kind).inserted }
        for kind in WorkWidgetKind.allCases where !seen.contains(kind) {
            widgets.append(WorkWidgetInstance(id: kind.rawValue, kind: kind, isHidden: false))
        }
        return WorkLayout(widgets: widgets)
    }

    public func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    public func moving(_ id: String, by offset: Int) -> WorkLayout {
        guard let from = widgets.firstIndex(where: { $0.id == id }) else { return self }
        let to = max(0, min(widgets.count - 1, from + offset))
        guard to != from else { return self }
        var next = widgets
        next.insert(next.remove(at: from), at: to)
        return WorkLayout(schema: schema, widgets: next)
    }

    public func togglingHidden(_ id: String) -> WorkLayout {
        WorkLayout(schema: schema, widgets: widgets.map { $0.id == id ? WorkWidgetInstance(id: $0.id, kind: $0.kind, isHidden: !$0.isHidden) : $0 })
    }
}
