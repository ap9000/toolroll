import Foundation

/// One Work view as loaded so far (page 1 plus any "Load more" pages).
public struct InboxPage: Equatable, Sendable, Codable {
    public var rows: [WorkRow]
    /// Waiting asks that are no task row (a held release, a flow card, a setup step).
    public var otherNeeds: [NeedRow]
    /// The cursor of the page after the last one loaded, or nil when everything is loaded.
    public var next: String?
    /// Why the last "Load more" failed, shown next to the button (which stays usable).
    public var moreFailure: String?
    /// The ids page 1 brought, so a refresh knows which rows it speaks for.
    public var firstPageIds: [String]

    public init(rows: [WorkRow], otherNeeds: [NeedRow], next: String?, moreFailure: String? = nil, firstPageIds: [String]? = nil) {
        self.rows = rows
        self.otherNeeds = otherNeeds
        self.next = next
        self.moreFailure = moreFailure
        self.firstPageIds = firstPageIds ?? rows.map(\.id)
    }

    /// More than page 1 is on screen.
    public var hasLoadedMore: Bool { rows.count > firstPageIds.count }

    private enum CodingKeys: String, CodingKey { case rows, otherNeeds, next, firstPageIds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rows = try c.decode([WorkRow].self, forKey: .rows)
        otherNeeds = try c.decode([NeedRow].self, forKey: .otherNeeds)
        next = try c.decodeIfPresent(String.self, forKey: .next)
        firstPageIds = try c.decodeIfPresent([String].self, forKey: .firstPageIds) ?? rows.map(\.id)
        moreFailure = nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(rows, forKey: .rows)
        try c.encode(otherNeeds, forKey: .otherNeeds)
        try c.encodeIfPresent(next, forKey: .next)
        try c.encode(firstPageIds, forKey: .firstPageIds)
    }
}

/// How fetched pages join what's on screen.
public enum InboxMerge {
    /// A fresh page 1. With only page 1 loaded it replaces everything. With more pages loaded (C2) it replaces only
    /// what page 1 spoke for: fresh page-1 rows first, then the loaded tail (minus anything page 1 now carries), and the
    /// tail's cursor is kept, so the list never snaps back under the person's finger.
    public static func refreshed(current: InboxPage?, firstPage: WorkRows) -> InboxPage {
        let fresh = InboxPage(rows: firstPage.rows, otherNeeds: firstPage.needs.flatMap(\.rows), next: firstPage.next)
        guard let current, current.hasLoadedMore else { return fresh }
        let freshIds = Set(firstPage.rows.map(\.id))
        let oldFirst = Set(current.firstPageIds)
        let tail = current.rows.filter { !oldFirst.contains($0.id) && !freshIds.contains($0.id) }
        // Page 1 ended (no cursor): what used to be the tail is gone from the server's view.
        guard firstPage.next != nil else { return fresh }
        return InboxPage(
            rows: firstPage.rows + tail,
            otherNeeds: fresh.otherNeeds,
            next: current.next,
            moreFailure: current.moreFailure,
            firstPageIds: firstPage.rows.map(\.id)
        )
    }

    /// The page loaded with `cursor`, joined onto what's on screen now (re-read after the await, never the copy taken
    /// before it). Nil when the screen moved on meanwhile (a refresh reset the cursor, another "Load more" landed):
    /// a stale page never overwrites a newer state.
    public static func appended(current: InboxPage?, cursor: String, page: WorkRows) -> InboxPage? {
        guard var current, current.next == cursor else { return nil }
        let seen = Set(current.rows.map(\.id))
        current.rows += page.rows.filter { !seen.contains($0.id) }
        current.next = page.next
        current.moreFailure = nil
        return current
    }
}
