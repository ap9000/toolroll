import Foundation

public enum PaletteAction: Sendable, Equatable {
    case selectTask(taskId: String)
    case handOff(taskId: String, person: String)
    case promoteCandidate(taskId: String, candidateId: String)
    case openCandidatePr(taskId: String, candidateId: String)
    case openTerminal(taskId: String, program: String)
    case releaseTerminalControl
    case openInBrowser(taskId: String)
    case pingApproval(taskId: String)
    case switchInspectorTab(String)
    case toggleInspector
    case switchProfile(name: String)
    case openPairWorkspace
    case refreshAll
}

public struct PaletteItem: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let category: String
    public let shortcutHint: String?
    public let action: PaletteAction
    public let priority: Int

    public init(
        id: String,
        title: String,
        subtitle: String,
        category: String,
        shortcutHint: String? = nil,
        action: PaletteAction,
        priority: Int = 0
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.category = category
        self.shortcutHint = shortcutHint
        self.action = action
        self.priority = priority
    }
}

public enum CommandPaletteEngine {
    public static func buildItems(
        rows: [WorkRow],
        selectedTaskId: String?,
        presence: PresenceSnapshot,
        candidates: [HandoffCandidate],
        profiles: [ConnectionProfile],
        activeProfileName: String?,
        terminalControlling: Bool
    ) -> [PaletteItem] {
        var items: [PaletteItem] = []

        if let taskId = selectedTaskId {
            for cand in candidates {
                if cand.promotedAt == nil && !cand.stale {
                    items.append(PaletteItem(
                        id: "promote-\(cand.id)",
                        title: "Promote Candidate \(cand.id.prefix(8))",
                        subtitle: "by \(cand.author) · \(cand.files.count) files",
                        category: "Candidate",
                        action: .promoteCandidate(taskId: taskId, candidateId: cand.id),
                        priority: 95
                    ))
                }
                if cand.canOpenPr {
                    items.append(PaletteItem(
                        id: "open-pr-\(cand.id)",
                        title: "Open PR for Candidate \(cand.id.prefix(8))",
                        subtitle: "Push promoted Run #\(cand.runId ?? 0) & create Pull Request",
                        category: "Candidate",
                        action: .openCandidatePr(taskId: taskId, candidateId: cand.id),
                        priority: 96
                    ))
                }
            }

            items.append(PaletteItem(
                id: "term-shell-\(taskId)",
                title: "Attach / Start Live Terminal (shell)",
                subtitle: "Task \(taskId)",
                category: "Live Terminal",
                shortcutHint: "⌘J",
                action: .openTerminal(taskId: taskId, program: "shell"),
                priority: 90
            ))
            items.append(PaletteItem(
                id: "term-claude-\(taskId)",
                title: "Attach / Start Live Terminal (claude)",
                subtitle: "Task \(taskId)",
                category: "Live Terminal",
                action: .openTerminal(taskId: taskId, program: "claude"),
                priority: 82
            ))
            if terminalControlling {
                items.append(PaletteItem(
                    id: "term-release",
                    title: "Release Live Terminal Control",
                    subtitle: "Step down to Observer so teammates can take over",
                    category: "Live Terminal",
                    action: .releaseTerminalControl,
                    priority: 98
                ))
            }

            for teammate in presence.accounts {
                let label = teammate == presence.me ? "\(teammate) (me)" : teammate
                items.append(PaletteItem(
                    id: "handoff-\(taskId)-\(teammate)",
                    title: "Hand off task to \(label)",
                    subtitle: "Reassign owner for \(taskId)",
                    category: "Task Handoff",
                    action: .handOff(taskId: taskId, person: teammate),
                    priority: 75
                ))
            }

            items.append(PaletteItem(
                id: "browser-\(taskId)",
                title: "Open Task in Browser",
                subtitle: "Approve plans & view full web console",
                category: "Task",
                shortcutHint: "⌘O",
                action: .openInBrowser(taskId: taskId),
                priority: 70
            ))
            items.append(PaletteItem(
                id: "ping-\(taskId)",
                title: "Ping Phone / Browser for Approval",
                subtitle: "Send approval notification for \(taskId)",
                category: "Task",
                action: .pingApproval(taskId: taskId),
                priority: 68
            ))
        }

        items.append(PaletteItem(
            id: "inspector-terminal",
            title: "Focus Live Terminal Inspector",
            subtitle: "Switch right pane to Live Terminal",
            category: "View",
            shortcutHint: "⌘1",
            action: .switchInspectorTab("terminal"),
            priority: 60
        ))
        items.append(PaletteItem(
            id: "inspector-diff",
            title: "Focus Diff Inspector",
            subtitle: "Switch right pane to Result Diff",
            category: "View",
            shortcutHint: "⌘2",
            action: .switchInspectorTab("diff"),
            priority: 60
        ))
        items.append(PaletteItem(
            id: "inspector-lead",
            title: "Focus Lead Thread",
            subtitle: "Switch right pane to Lead conversation",
            category: "View",
            shortcutHint: "⌘L",
            action: .switchInspectorTab("lead"),
            priority: 60
        ))
        items.append(PaletteItem(
            id: "toggle-inspector",
            title: "Toggle Inspector Pane",
            subtitle: "Show or hide Terminal / Diff / Lead drawer",
            category: "View",
            shortcutHint: "⌘J",
            action: .toggleInspector,
            priority: 58
        ))
        items.append(PaletteItem(
            id: "refresh-all",
            title: "Refresh Workspace",
            subtitle: "Reload tasks, presence, candidates, and diff",
            category: "Workspace",
            shortcutHint: "⌘R",
            action: .refreshAll,
            priority: 55
        ))
        items.append(PaletteItem(
            id: "pair-workspace",
            title: "Connect / Pair Remote Workspace…",
            subtitle: "Browser-assisted device pairing or bearer token",
            category: "Workspace",
            shortcutHint: "⌘⇧P",
            action: .openPairWorkspace,
            priority: 52
        ))

        for profile in profiles where profile.name != activeProfileName {
            items.append(PaletteItem(
                id: "profile-\(profile.name)",
                title: "Switch Workspace: \(profile.displayTitle)",
                subtitle: "\(profile.account) @ \(profile.origin)",
                category: "Workspace",
                action: .switchProfile(name: profile.name),
                priority: 50
            ))
        }

        for row in rows {
            let statusLabel = row.word.isEmpty ? row.status.rawValue : row.word
            let proj = row.project ?? "workspace"
            items.append(PaletteItem(
                id: "task-\(row.id)",
                title: row.title,
                subtitle: "\(proj) · \(statusLabel) · \(row.id)",
                category: "Task",
                action: .selectTask(taskId: row.id),
                priority: row.status == .needs ? 88 : (row.status == .running ? 78 : 40)
            ))
        }

        return items
    }

    public static func filter(items: [PaletteItem], query rawQuery: String) -> [PaletteItem] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty {
            return items.sorted {
                if $0.priority != $1.priority { return $0.priority > $1.priority }
                return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
        }

        let scored: [(PaletteItem, Int)] = items.compactMap { item in
            let titleScore = fuzzyScore(query: query, target: item.title.lowercased())
            let subScore = fuzzyScore(query: query, target: "\(item.category) \(item.subtitle)".lowercased())
            let best: Int?
            switch (titleScore, subScore) {
            case (let t?, let s?): best = max(t * 2, s)
            case (let t?, nil): best = t * 2
            case (nil, let s?): best = s
            case (nil, nil): best = nil
            }
            guard let matchScore = best else { return nil }
            return (item, matchScore + item.priority)
        }

        return scored
            .sorted {
                if $0.1 != $1.1 { return $0.1 > $1.1 }
                return $0.0.title.localizedCaseInsensitiveCompare($1.0.title) == .orderedAscending
            }
            .map(\.0)
    }

    public static func fuzzyScore(query: String, target: String) -> Int? {
        if target.contains(query) {
            if target.hasPrefix(query) { return 200 }
            return 140
        }
        var qIdx = query.startIndex
        var tIdx = target.startIndex
        var score = 0
        var consecutive = 0

        while qIdx < query.endIndex && tIdx < target.endIndex {
            if query[qIdx] == target[tIdx] {
                consecutive += 1
                score += 10 + (consecutive * 6)
                if tIdx == target.startIndex {
                    score += 15
                } else {
                    let prev = target[target.index(before: tIdx)]
                    if prev == " " || prev == "-" || prev == "_" || prev == "/" {
                        score += 12
                    }
                }
                qIdx = query.index(after: qIdx)
            } else {
                consecutive = 0
            }
            tIdx = target.index(after: tIdx)
        }
        return qIdx == query.endIndex ? score : nil
    }
}
