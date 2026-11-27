import Foundation

/// Truthful connection state (ADR 0004): losing contact NEVER claims the Mac is asleep.
public enum CompanionConnectionState: Equatable, Sendable {
    case unpaired
    case demo
    case connecting
    case awaitingMacConfirm(code: String, workspaceId: String)
    case connected(workspaceLabel: String, connectedAt: Date)
    case unavailable(lastSeen: Date?, reason: String)
    case restoredRequiresRePair
}

public struct PairingQRPayload: Codable, Equatable, Sendable {
    public let v: Int
    public let relayUrl: String
    public let machineId: String
    public let workspaceId: String
    public let macStaticPub: String
    public let pairSessionId: String
    public let pairPsk: String
    public let pairConnToken: String
}

public struct PairedWorkspaceRecord: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let workspaceLabel: String
    public let machineId: String
    public let relayUrl: String
    public let macStaticPubBase64Url: String
    public let deviceId: String
    public let recoveryGeneration: String
    public let pairedAt: Date
}

public enum CompanionTaskStatus: String, Codable, Sendable {
    case needsYou = "needs"
    case running = "running"
    case queued = "queued"
    case finished = "finished"
    case failed = "failed"
}

public struct CompanionWorkRow: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let project: String
    public let age: String
    public let status: CompanionTaskStatus
    public let badgeLabel: String
    public let ask: String?
    public let detail: String
    public let needGroup: String? // "Decide" | "Review" | "Unblock"
    public let checksSummary: String?
    public let addedLines: Int
    public let removedLines: Int

    public init(
        id: String,
        title: String,
        project: String,
        age: String,
        status: CompanionTaskStatus,
        badgeLabel: String,
        ask: String?,
        detail: String,
        needGroup: String?,
        checksSummary: String?,
        addedLines: Int = 0,
        removedLines: Int = 0
    ) {
        self.id = id
        self.title = title
        self.project = project
        self.age = age
        self.status = status
        self.badgeLabel = badgeLabel
        self.ask = ask
        self.detail = detail
        self.needGroup = needGroup
        self.checksSummary = checksSummary
        self.addedLines = addedLines
        self.removedLines = removedLines
    }
}

public struct CompanionStepCard: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let state: String // "done" | "needs_you" | "running" | "queued"
    public let sentence: String
    public let age: String?
    public let agentLabel: String?
    public let costUsd: Double?

    public init(id: String, label: String, state: String, sentence: String, age: String?, agentLabel: String?, costUsd: Double?) {
        self.id = id
        self.label = label
        self.state = state
        self.sentence = sentence
        self.age = age
        self.agentLabel = agentLabel
        self.costUsd = costUsd
    }
}

public struct CompanionApprovalTerms: Codable, Equatable, Sendable {
    public let key: String
    public let digest: String
    public let verb: String
    public let summary: String
    public let lines: [String]

    public init(key: String, digest: String, verb: String, summary: String, lines: [String]) {
        self.key = key
        self.digest = digest
        self.verb = verb
        self.summary = summary
        self.lines = lines
    }
}

public struct CompanionDiffLine: Identifiable, Equatable, Sendable {
    public let id: Int
    public let kind: Kind
    public let oldLine: Int?
    public let newLine: Int?
    public let text: String

    public enum Kind: Sendable {
        case context
        case addition
        case deletion
        case header
    }

    public init(id: Int, kind: Kind, oldLine: Int?, newLine: Int?, text: String) {
        self.id = id
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
    }
}

public struct CompanionDiffFile: Identifiable, Equatable, Sendable {
    public let id: String
    public let path: String
    public let added: Int
    public let removed: Int
    public let lines: [CompanionDiffLine]

    public init(id: String, path: String, added: Int, removed: Int, lines: [CompanionDiffLine]) {
        self.id = id
        self.path = path
        self.added = added
        self.removed = removed
        self.lines = lines
    }
}

public struct CompanionLiveRecord: Identifiable, Equatable, Sendable {
    public let id: Int
    public let timestamp: String
    public let kind: String // "line" | "tool" | "cut"
    public let text: String

    public init(id: Int, timestamp: String, kind: String, text: String) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.text = text
    }
}

/// Built-in zero-network Demo Workspace fixtures (matches `toolroll demo` and supports App Store Review Guideline 2.1).
public enum CompanionDemoFixtures {
    public static let workspaceLabel = "Demo Workspace"

    public static let workRows: [CompanionWorkRow] = [
        CompanionWorkRow(
            id: "t-auth-refresh",
            title: "Rotate refresh token cookie with strict SameSite",
            project: "api-gateway",
            age: "4m",
            status: .needsYou,
            badgeLabel: "Decide",
            ask: "Approve plan revision r3 before build executes cookie migration.",
            detail: "3 files · touches auth cookie rotation · dual-read 24h window",
            needGroup: "Decide",
            checksSummary: "Pending approval",
            addedLines: 48,
            removedLines: 14
        ),
        CompanionWorkRow(
            id: "t-diff-review",
            title: "Enforce 65,535-byte Noise framing ceiling & credit pacing",
            project: "toolroll",
            age: "12m",
            status: .needsYou,
            badgeLabel: "Review",
            ask: "All 42 checks passed on sealed candidate. Ready for your review.",
            detail: "4 files · 0 warnings · 100% snow vectors matched",
            needGroup: "Review",
            checksSummary: "42/42 checks passed",
            addedLines: 142,
            removedLines: 29
        ),
        CompanionWorkRow(
            id: "t-live-build",
            title: "Add SwiftUI live run watcher with watch-only cancel",
            project: "toolroll",
            age: "2m",
            status: .running,
            badgeLabel: "Running",
            ask: nil,
            detail: "Builder running unit tests inside macOS Seatbelt fence",
            needGroup: nil,
            checksSummary: "Running checks…",
            addedLines: 94,
            removedLines: 6
        ),
        CompanionWorkRow(
            id: "t-restore-wipe",
            title: "Retire companion paired devices & PSKs on backup restore",
            project: "toolroll",
            age: "1h",
            status: .finished,
            badgeLabel: "Done",
            ask: nil,
            detail: "Landed cleanly · PR #524 checks green",
            needGroup: nil,
            checksSummary: "All 454 fast checks green",
            addedLines: 64,
            removedLines: 2
        ),
    ]

    public static func steps(for taskId: String) -> [CompanionStepCard] {
        switch taskId {
        case "t-auth-refresh":
            return [
                CompanionStepCard(
                    id: "plan",
                    label: "Plan",
                    state: "needs_you",
                    sentence: "Set SameSite=Strict on refresh cookies, keep a 24h dual-read grace cookie for active mobile sessions, and add rotation regression tests.",
                    age: "4m ago",
                    agentLabel: "Claude Sonnet · Plan r3",
                    costUsd: 0.38
                ),
                CompanionStepCard(
                    id: "build",
                    label: "Build",
                    state: "queued",
                    sentence: "Waiting for your approval of Plan r3 inside fenced worktree.",
                    age: nil,
                    agentLabel: "Claude Opus",
                    costUsd: nil
                ),
                CompanionStepCard(
                    id: "checks",
                    label: "Checks",
                    state: "queued",
                    sentence: "Will run `npm run check:fast` + `auth-rotation.test.ts`.",
                    age: nil,
                    agentLabel: nil,
                    costUsd: nil
                ),
            ]
        case "t-diff-review":
            return [
                CompanionStepCard(
                    id: "plan",
                    label: "Plan",
                    state: "done",
                    sentence: "Approved scope sealed at digest `9f3a8c12` (person proof).",
                    age: "24m ago",
                    agentLabel: "Claude Sonnet",
                    costUsd: 0.21
                ),
                CompanionStepCard(
                    id: "build",
                    label: "Build",
                    state: "done",
                    sentence: "Implemented 60,000 B frame ceiling, 1 MiB unary pacer, and Swift parity tests.",
                    age: "14m ago",
                    agentLabel: "Codex · Builder",
                    costUsd: 0.64
                ),
                CompanionStepCard(
                    id: "checks",
                    label: "Checks",
                    state: "done",
                    sentence: "42/42 unit and security tests passed on exact candidate commit `4a8d91e`.",
                    age: "12m ago",
                    agentLabel: "Hardened runner",
                    costUsd: nil
                ),
                CompanionStepCard(
                    id: "review",
                    label: "Review",
                    state: "needs_you",
                    sentence: "Diff is sealed and ready for inspection.",
                    age: "12m ago",
                    agentLabel: nil,
                    costUsd: nil
                ),
            ]
        default:
            return [
                CompanionStepCard(
                    id: "plan",
                    label: "Plan",
                    state: "done",
                    sentence: "Approved scope sealed.",
                    age: "15m ago",
                    agentLabel: "Claude Sonnet",
                    costUsd: 0.19
                ),
                CompanionStepCard(
                    id: "build",
                    label: "Build",
                    state: taskId == "t-live-build" ? "running" : "done",
                    sentence: taskId == "t-live-build" ? "Running SwiftPM tests inside Seatbelt fence…" : "Completed with zero warnings.",
                    age: "2m ago",
                    agentLabel: "Claude Opus",
                    costUsd: 0.52
                ),
            ]
        }
    }

    public static func approvalTerms(for taskId: String) -> CompanionApprovalTerms? {
        guard taskId == "t-auth-refresh" else { return nil }
        return CompanionApprovalTerms(
            key: "plan-r3",
            digest: "7a4e91c0b2f38411",
            verb: "Approve",
            summary: "Approve Plan r3 for api-gateway",
            lines: [
                "Repository: api-gateway (branch worktree, no direct push)",
                "Sandbox: Seatbelt fenced · Toolroll state denied · proxy-only network",
                "Touch set: src/auth/cookies.ts, src/auth/refresh.ts, test/auth-rotation.test.ts",
                "Checks required before Ready: npm test -- auth-rotation",
            ]
        )
    }

    public static func diffFiles(for taskId: String) -> [CompanionDiffFile] {
        switch taskId {
        case "t-auth-refresh":
            return [
                CompanionDiffFile(
                    id: "f1",
                    path: "src/auth/cookies.ts",
                    added: 18,
                    removed: 5,
                    lines: [
                        CompanionDiffLine(id: 1, kind: .header, oldLine: nil, newLine: nil, text: "@@ -42,9 +42,14 @@ export function formatRefreshCookie(token: string)"),
                        CompanionDiffLine(id: 2, kind: .context, oldLine: 42, newLine: 42, text: "  const attrs = ["),
                        CompanionDiffLine(id: 3, kind: .context, oldLine: 43, newLine: 43, text: "    `tr_refresh=${token}`, \"HttpOnly\", \"Secure\","),
                        CompanionDiffLine(id: 4, kind: .deletion, oldLine: 44, newLine: nil, text: "    \"SameSite=Lax\", \"Path=/\","),
                        CompanionDiffLine(id: 5, kind: .addition, oldLine: nil, newLine: 44, text: "    \"SameSite=Strict\", \"Path=/auth/refresh\","),
                        CompanionDiffLine(id: 6, kind: .addition, oldLine: nil, newLine: 45, text: "    `Max-Age=${REFRESH_TTL_SECONDS}`,"),
                        CompanionDiffLine(id: 7, kind: .context, oldLine: 45, newLine: 46, text: "  ];"),
                        CompanionDiffLine(id: 8, kind: .context, oldLine: 46, newLine: 47, text: "  return attrs.join(\"; \");"),
                    ]
                ),
                CompanionDiffFile(
                    id: "f2",
                    path: "test/auth-rotation.test.ts",
                    added: 30,
                    removed: 9,
                    lines: [
                        CompanionDiffLine(id: 1, kind: .header, oldLine: nil, newLine: nil, text: "@@ -12,6 +12,11 @@ describe(\"refresh cookie rotation\")"),
                        CompanionDiffLine(id: 2, kind: .addition, oldLine: nil, newLine: 12, text: "  test(\"sets SameSite=Strict and scopes Path=/auth/refresh\", () => {"),
                        CompanionDiffLine(id: 3, kind: .addition, oldLine: nil, newLine: 13, text: "    const header = formatRefreshCookie(\"tok_123\");"),
                        CompanionDiffLine(id: 4, kind: .addition, oldLine: nil, newLine: 14, text: "    expect(header).toContain(\"SameSite=Strict\");"),
                        CompanionDiffLine(id: 5, kind: .addition, oldLine: nil, newLine: 15, text: "    expect(header).toContain(\"Path=/auth/refresh\");"),
                        CompanionDiffLine(id: 6, kind: .addition, oldLine: nil, newLine: 16, text: "  });"),
                    ]
                ),
            ]
        default:
            return [
                CompanionDiffFile(
                    id: "f3",
                    path: "src/companion/framing.ts",
                    added: 84,
                    removed: 16,
                    lines: [
                        CompanionDiffLine(id: 1, kind: .header, oldLine: nil, newLine: nil, text: "@@ -1,7 +1,9 @@ export const MAX_FRAME_PAYLOAD_BYTES = 60_000;"),
                        CompanionDiffLine(id: 2, kind: .context, oldLine: 1, newLine: 1, text: "export const FRAME_HEADER_BYTES = 13;"),
                        CompanionDiffLine(id: 3, kind: .deletion, oldLine: 2, newLine: nil, text: "export const MAX_LOGICAL_UNARY_RESPONSE_BYTES = 4 * 1024 * 1024;"),
                        CompanionDiffLine(id: 4, kind: .addition, oldLine: nil, newLine: 2, text: "export const MAX_LOGICAL_UNARY_RESPONSE_BYTES = 1024 * 1024; // 1 MiB"),
                        CompanionDiffLine(id: 5, kind: .addition, oldLine: nil, newLine: 3, text: "// Unary chunks wait for CREDIT and are never dropped."),
                    ]
                ),
            ]
        }
    }

    public static let liveRecords: [CompanionLiveRecord] = [
        CompanionLiveRecord(id: 1, timestamp: "21:20:02", kind: "tool", text: "swift test --package-path ios/Packages/ToolrollCompanionCore"),
        CompanionLiveRecord(id: 2, timestamp: "21:20:05", kind: "line", text: "Build complete! (1.76 sec)"),
        CompanionLiveRecord(id: 3, timestamp: "21:20:06", kind: "line", text: "✔ Swift Noise_IKpsk2_25519_ChaChaPoly_SHA256 matches snow Revision 34 vectors"),
        CompanionLiveRecord(id: 4, timestamp: "21:20:06", kind: "line", text: "✔ Swift enforces reserved nonce 2^64-1, 65,535 B ceiling, 2^20 rekey"),
    ]
}
