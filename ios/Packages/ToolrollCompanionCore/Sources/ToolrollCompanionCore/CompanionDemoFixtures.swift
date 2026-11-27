import Foundation

/// The built-in demo workspace (zero network; App Store Review Guideline 2.1). Every fixture is an Engine API
/// response body, decoded through the same models as live data.
public enum CompanionDemoFixtures {
    public static let workspaceLabel = "Demo workspace"

    public static let decideTask = "t-auth-refresh"
    public static let reviewTask = "t-frame-limits"
    public static let runningTask = "t-live-watch"
    public static let doneTask = "t-restore-wipe"
    public static let runningRun = 41

    public enum FixtureError: Error {
        case missing(String)
    }

    static func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    public static func workRows() throws -> WorkRows { try decode(workRowsJSON) }

    public static func steps(task: String) throws -> StepCards {
        guard let json = stepsJSON[task] else { throw CompanionRPCError(code: CompanionRPCError.notFound, message: "No such task") }
        return try decode(json)
    }

    public static func diff(task: String) throws -> ResultDiff {
        guard let json = diffJSON[task] else { throw CompanionRPCError(code: CompanionRPCError.notFound, message: "No such task") }
        return try decode(json)
    }

    public static func diffFile(task: String, file: Int) throws -> ResultDiffFile {
        guard let json = diffFileJSON["\(task):\(file)"] else { throw CompanionRPCError(code: CompanionRPCError.notFound, message: "No such file") }
        return try decode(json)
    }

    public static func liveWindow(run: Int) throws -> LiveSessionWindow {
        guard run == runningRun else { throw CompanionRPCError(code: CompanionRPCError.notFound, message: "No such run") }
        return try decode(liveWindowJSON)
    }

    /// What the simulated watch emits, in a loop, while the demo build "runs".
    public static let liveScript: [LiveRecord] = [
        LiveRecord(kind: .step, stepId: "d1", stepKind: "command", target: "swift test --filter LiveWatch"),
        LiveRecord(kind: .say, text: ["Building the package (1.8 s)."]),
        LiveRecord(kind: .done, stepId: "d1", ok: true),
        LiveRecord(kind: .say, text: ["14 tests passed. Checking that closing the sheet stops watching only."]),
        LiveRecord(kind: .step, stepId: "d2", stepKind: "edit", target: "ios/ToolrollCompanion/TaskDetailView.swift"),
        LiveRecord(kind: .done, stepId: "d2", ok: true),
        LiveRecord(kind: .say, text: ["Running the full suite once more before handing it to checks."]),
    ]

    // MARK: JSON

    static let workRowsJSON = #"""
    {
      "version": 1, "project": null, "projectName": "All projects", "needsCount": 2,
      "groups": [
        {"key": "decide", "label": "Decide", "count": 1},
        {"key": "review", "label": "Review", "count": 1},
        {"key": "building", "label": "Building", "count": 1},
        {"key": "rest", "label": "Everything else", "count": 1}
      ],
      "rows": [
        {
          "id": "t-auth-refresh", "title": "Make the refresh cookie strict", "href": "/t/t-auth-refresh",
          "project": "api-gateway", "age": "4m ago",
          "status": {"label": "Needs you", "tone": "attention", "token": "assignment-needs-decision"},
          "word": {"word": "Plan", "tone": "ask"}, "ask": "decide", "chip": "Plan", "group": "decide", "rank": 0,
          "detail": "A plan is ready for your approval.", "problem": null,
          "need": {
            "id": "t-auth-refresh", "title": "Make the refresh cookie strict", "href": "/t/t-auth-refresh",
            "project": "api-gateway", "age": "4m ago", "state": "needs", "ask": "approve", "group": "decide",
            "reason": null, "line": "Approve the plan so the build can start.",
            "action": {"label": "Approve", "href": "/t/t-auth-refresh"}, "question": null
          },
          "waiting": null
        },
        {
          "id": "t-frame-limits", "title": "Cap message size and pace large replies", "href": "/t/t-frame-limits",
          "project": "toolroll", "age": "12m ago",
          "status": {"label": "Needs you", "tone": "attention", "token": "assignment-needs-decision"},
          "word": {"word": "Result", "tone": "ask"}, "ask": "review", "chip": "Result", "group": "review", "rank": 0,
          "detail": "All 42 checks passed.", "problem": null,
          "need": {
            "id": "t-frame-limits", "title": "Cap message size and pace large replies", "href": "/t/t-frame-limits",
            "project": "toolroll", "age": "12m ago", "state": "needs", "ask": "review", "group": "review",
            "reason": null, "line": "The result is ready. All 42 checks passed.",
            "action": {"label": "Open result", "href": "/t/t-frame-limits?tab=result&run=38"}, "question": null
          },
          "waiting": null
        },
        {
          "id": "t-live-watch", "title": "Show live output for a running build", "href": "/t/t-live-watch",
          "project": "toolroll", "age": "2m ago",
          "status": {"label": "Building", "tone": "live", "token": "assignment-working"},
          "word": {"word": "Building", "tone": "live"}, "ask": null, "chip": null, "group": "building", "rank": 1,
          "detail": "An agent is running the tests.", "problem": null, "need": null, "waiting": null
        },
        {
          "id": "t-restore-wipe", "title": "Remove paired phones after a backup restore", "href": "/t/t-restore-wipe",
          "project": "toolroll", "age": "1h ago",
          "status": {"label": "Done", "tone": "done", "token": "assignment-complete"},
          "word": {"word": "Done", "tone": "done"}, "ask": null, "chip": null, "group": "rest", "rank": 3,
          "landed": "Landed on main (4a8d91e)",
          "detail": "Accepted.", "problem": null, "need": null, "waiting": null
        }
      ],
      "needs": [
        {"key": "decide", "label": "Decide", "count": 1, "rows": []},
        {"key": "review", "label": "Review", "count": 1, "rows": []}
      ],
      "next": null, "room": "workspace", "spend": null, "limits": null
    }
    """#

    static let stepsJSON: [String: String] = [
        "t-auth-refresh": #"""
        {
          "version": 1,
          "task": {"id": "t-auth-refresh", "root": "t-auth-refresh", "title": "Make the refresh cookie strict", "state": "queued", "project": "/Users/demo/api-gateway"},
          "chain": "plan-first", "headline": "Needs you", "liveRun": null, "latestRun": 36, "models": null,
          "cards": [
            {"key": "plan", "label": "Plan", "state": "done", "mark": "done",
             "sentence": "Set `SameSite=Strict` on the refresh cookie, keep the old cookie readable for 24 hours so signed-in phones stay signed in, and add tests for the rotation.",
             "at": "2026-11-27T09:12:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-sonnet-5-5"},
             "startedAt": "2026-11-27T09:10:40.000Z", "latestStartedAt": "2026-11-27T09:10:40.000Z", "finishedAt": "2026-11-27T09:12:00.000Z",
             "costUsd": 0.38, "runs": [36]},
            {"key": "approve", "label": "Approval", "state": "current", "mark": "needs", "sentence": "",
             "at": null, "needsYou": true, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": [],
             "terms": {
               "key": "7a4e91c0b2f38411aa02c9d1e4f50b77", "revision": null,
               "rows": [
                 {"label": "Goal", "words": "Make the refresh cookie strict without signing anyone out", "lines": []},
                 {"label": "Done when", "words": "The cookie is strict, old sessions keep working for 24 hours, and the project's checks pass", "lines": []},
                 {"label": "Agent", "words": "Claude Sonnet 5.5 plans; Claude Opus 5.5 builds", "lines": []},
                 {"label": "Files", "words": "src/auth/cookies.ts, src/auth/refresh.ts and a new test", "lines": ["src/auth/cookies.ts", "src/auth/refresh.ts", "test/auth-rotation.test.ts"]},
                 {"label": "Network", "words": "the agent's provider and npm only", "lines": []},
                 {"label": "Tools", "words": "file edits and routine commands; anything risky stops", "lines": []},
                 {"label": "May cost", "words": "Up to $2.00 · stops after 20 min without progress", "lines": []}
               ],
               "warnings": [],
               "usualLabel": "Your usual project settings",
               "usual": [
                 {"label": "Writes", "words": "only its own copy of the project"},
                 {"label": "Project checks", "words": "sandboxed"}
               ]
             }},
            {"key": "build", "label": "Build", "state": "todo", "mark": "todo", "sentence": "Starts when you approve",
             "at": null, "needsYou": false, "inChain": true, "agent": {"provider": "claude", "model": "claude-opus-5-5"},
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "checks", "label": "Checks", "state": "todo", "mark": "todo", "sentence": "Runs `npm test -- auth-rotation` on the result",
             "at": null, "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "ready", "label": "Ready", "state": "todo", "mark": "todo", "sentence": "A result for you to review",
             "at": null, "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []}
          ],
          "review": null, "shell": null, "failure": null, "waiting": null, "held": null, "retry": null,
          "approval": null, "room": "task:t-auth-refresh", "landing": null, "planStopped": null, "plan": null,
          "planQueued": false, "scopeDigest": null, "agentChoices": null, "pendingAgentChange": null
        }
        """#,
        "t-frame-limits": #"""
        {
          "version": 1,
          "task": {"id": "t-frame-limits", "root": "t-frame-limits", "title": "Cap message size and pace large replies", "state": "done", "project": "/Users/demo/toolroll"},
          "chain": "plan-first", "headline": "Needs you", "liveRun": null, "latestRun": 38, "models": null,
          "cards": [
            {"key": "plan", "label": "Plan", "state": "done", "mark": "done", "sentence": "Plan written by Claude",
             "at": "2026-11-27T08:40:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-sonnet-5-5"},
             "startedAt": "2026-11-27T08:38:00.000Z", "latestStartedAt": "2026-11-27T08:38:00.000Z", "finishedAt": "2026-11-27T08:40:00.000Z",
             "costUsd": 0.21, "runs": [37]},
            {"key": "approve", "label": "Approval", "state": "done", "mark": "done", "sentence": "Approved by you",
             "at": "2026-11-27T08:44:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "build", "label": "Build", "state": "done", "mark": "done",
             "sentence": "Messages are capped at 60,000 bytes and large replies wait for the phone to ask for more",
             "at": "2026-11-27T08:58:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "codex", "model": "gpt-5.5-codex"},
             "startedAt": "2026-11-27T08:44:30.000Z", "latestStartedAt": "2026-11-27T08:44:30.000Z", "finishedAt": "2026-11-27T08:58:00.000Z",
             "costUsd": 0.64, "runs": [38]},
            {"key": "checks", "label": "Checks", "state": "done", "mark": "done", "sentence": "All 42 checks passed",
             "at": "2026-11-27T09:00:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": "2026-11-27T08:58:10.000Z", "latestStartedAt": "2026-11-27T08:58:10.000Z", "finishedAt": "2026-11-27T09:00:00.000Z",
             "costUsd": null, "runs": [38]},
            {"key": "ready", "label": "Ready", "state": "current", "mark": "needs", "sentence": "A result for you to review",
             "at": "2026-11-27T09:00:00.000Z", "needsYou": true, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": [38]}
          ],
          "review": {"run": 38, "receipt": "4a8d91e0c2b7f13a5d6e8f9012ab34cd56ef7890a1b2c3d4e5f60718293a4b5c", "source": "demo",
                     "accept": {"owed": null, "blockers": [], "needs": null}},
          "shell": null, "failure": null, "waiting": null, "held": null, "retry": null,
          "approval": {"by": "you", "you": true, "automatic": false},
          "room": "task:t-frame-limits", "landing": null, "planStopped": null, "plan": null, "planQueued": false,
          "scopeDigest": null, "agentChoices": null, "pendingAgentChange": null
        }
        """#,
        "t-live-watch": #"""
        {
          "version": 1,
          "task": {"id": "t-live-watch", "root": "t-live-watch", "title": "Show live output for a running build", "state": "running", "project": "/Users/demo/toolroll"},
          "chain": "plan-first", "headline": "Building", "liveRun": 41, "latestRun": 41, "models": null,
          "cards": [
            {"key": "plan", "label": "Plan", "state": "done", "mark": "done", "sentence": "Plan written by Claude",
             "at": "2026-11-27T09:05:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-sonnet-5-5"},
             "startedAt": "2026-11-27T09:03:00.000Z", "latestStartedAt": "2026-11-27T09:03:00.000Z", "finishedAt": "2026-11-27T09:05:00.000Z",
             "costUsd": 0.19, "runs": [40]},
            {"key": "approve", "label": "Approval", "state": "done", "mark": "done", "sentence": "Approved by you",
             "at": "2026-11-27T09:08:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "build", "label": "Build", "state": "current", "mark": "live", "sentence": "Building · running the tests",
             "at": null, "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-opus-5-5"},
             "startedAt": "2026-11-27T09:08:20.000Z", "latestStartedAt": "2026-11-27T09:08:20.000Z", "finishedAt": null,
             "costUsd": 0.52, "runs": [41]},
            {"key": "checks", "label": "Checks", "state": "todo", "mark": "todo", "sentence": "The project's checks run on the result",
             "at": null, "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "ready", "label": "Ready", "state": "todo", "mark": "todo", "sentence": "A result for you to review",
             "at": null, "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []}
          ],
          "review": null, "shell": {"run": 41, "why": null}, "failure": null, "waiting": null, "held": null, "retry": null,
          "approval": {"by": "you", "you": true, "automatic": false},
          "room": "task:t-live-watch", "landing": null, "planStopped": null, "plan": null, "planQueued": false,
          "scopeDigest": null, "agentChoices": null, "pendingAgentChange": null
        }
        """#,
        "t-restore-wipe": #"""
        {
          "version": 1,
          "task": {"id": "t-restore-wipe", "root": "t-restore-wipe", "title": "Remove paired phones after a backup restore", "state": "done", "project": "/Users/demo/toolroll"},
          "chain": "plan-first", "headline": "Done", "liveRun": null, "latestRun": 33, "models": null,
          "cards": [
            {"key": "plan", "label": "Plan", "state": "done", "mark": "done", "sentence": "Plan written by Claude",
             "at": "2026-11-27T07:30:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-sonnet-5-5"},
             "startedAt": "2026-11-27T07:28:00.000Z", "latestStartedAt": "2026-11-27T07:28:00.000Z", "finishedAt": "2026-11-27T07:30:00.000Z",
             "costUsd": 0.17, "runs": [32]},
            {"key": "approve", "label": "Approval", "state": "done", "mark": "done", "sentence": "Approved by you",
             "at": "2026-11-27T07:33:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": []},
            {"key": "build", "label": "Build", "state": "done", "mark": "done", "sentence": "The build finished",
             "at": "2026-11-27T07:51:00.000Z", "needsYou": false, "inChain": true,
             "agent": {"provider": "claude", "model": "claude-opus-5-5"},
             "startedAt": "2026-11-27T07:33:20.000Z", "latestStartedAt": "2026-11-27T07:33:20.000Z", "finishedAt": "2026-11-27T07:51:00.000Z",
             "costUsd": 0.71, "runs": [33]},
            {"key": "checks", "label": "Checks", "state": "done", "mark": "done", "sentence": "All 454 quick checks passed",
             "at": "2026-11-27T07:55:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": [33]},
            {"key": "ready", "label": "Ready", "state": "done", "mark": "done", "sentence": "Accepted by you",
             "at": "2026-11-27T08:02:00.000Z", "needsYou": false, "inChain": true, "agent": null,
             "startedAt": null, "latestStartedAt": null, "finishedAt": null, "costUsd": null, "runs": [33]}
          ],
          "review": null, "shell": {"run": 33, "why": null}, "failure": null, "waiting": null, "held": null, "retry": null,
          "approval": {"by": "you", "you": true, "automatic": false},
          "room": "task:t-restore-wipe", "landing": {"words": "Landed on main (4a8d91e)", "reverted": false},
          "planStopped": null, "plan": null, "planQueued": false,
          "scopeDigest": null, "agentChoices": null, "pendingAgentChange": null
        }
        """#,
    ]

    static let diffJSON: [String: String] = [
        "t-auth-refresh": #"""
        {"version": 1, "task": "t-auth-refresh", "run": null, "totals": null, "files": [], "patchTruncated": false, "problem": "No result yet."}
        """#,
        "t-live-watch": #"""
        {"version": 1, "task": "t-live-watch", "run": null, "totals": null, "files": [], "patchTruncated": false, "problem": "No result yet."}
        """#,
        "t-frame-limits": #"""
        {
          "version": 1, "task": "t-frame-limits", "run": 38,
          "totals": {"files": 3, "additions": 22, "deletions": 4, "binary": 0, "filesTruncated": false},
          "files": [
            {"file": 0, "path": "src/companion/framing.ts", "oldPath": "src/companion/framing.ts", "additions": 8, "deletions": 2, "binary": false, "hunks": 1},
            {"file": 1, "path": "ios/Packages/ToolrollCompanionCore/Sources/ToolrollCompanionCore/CompanionFraming.swift", "oldPath": "ios/Packages/ToolrollCompanionCore/Sources/ToolrollCompanionCore/CompanionFraming.swift", "additions": 4, "deletions": 1, "binary": false, "hunks": 1},
            {"file": 2, "path": "src/companion/framing.test.ts", "oldPath": "src/companion/framing.test.ts", "additions": 10, "deletions": 1, "binary": false, "hunks": 1}
          ],
          "patchTruncated": false, "problem": null
        }
        """#,
        "t-restore-wipe": #"""
        {
          "version": 1, "task": "t-restore-wipe", "run": 33,
          "totals": {"files": 2, "additions": 10, "deletions": 1, "binary": 0, "filesTruncated": false},
          "files": [
            {"file": 0, "path": "src/companion/store.ts", "oldPath": "src/companion/store.ts", "additions": 6, "deletions": 1, "binary": false, "hunks": 1},
            {"file": 1, "path": "src/companion/store.test.ts", "oldPath": "src/companion/store.test.ts", "additions": 4, "deletions": 0, "binary": false, "hunks": 1}
          ],
          "patchTruncated": false, "problem": null
        }
        """#,
    ]

    static let diffFileJSON: [String: String] = [
        "t-frame-limits:0": #"""
        {
          "version": 1, "task": "t-frame-limits", "run": 38,
          "file": {
            "file": 0, "path": "src/companion/framing.ts", "oldPath": "src/companion/framing.ts",
            "meta": ["diff --git a/src/companion/framing.ts b/src/companion/framing.ts"],
            "hunks": [
              {"header": "@@ -1,9 +1,16 @@ export const FRAME_HEADER_BYTES = 13;", "lines": [
                {"kind": "context", "text": "export const FRAME_HEADER_BYTES = 13;", "oldLine": 1, "newLine": 1},
                {"kind": "deletion", "text": "export const MAX_FRAME_PAYLOAD_BYTES = 65_000;", "oldLine": 2, "newLine": null},
                {"kind": "deletion", "text": "export const MAX_LOGICAL_UNARY_RESPONSE_BYTES = 4 * 1024 * 1024;", "oldLine": 3, "newLine": null},
                {"kind": "addition", "text": "export const MAX_FRAME_PAYLOAD_BYTES = 60_000;", "oldLine": null, "newLine": 2},
                {"kind": "addition", "text": "/** One reply is at most 1 MiB, however many chunks carry it. */", "oldLine": null, "newLine": 3},
                {"kind": "addition", "text": "export const MAX_LOGICAL_UNARY_RESPONSE_BYTES = 1024 * 1024;", "oldLine": null, "newLine": 4},
                {"kind": "addition", "text": "/** Chunks wait for the phone's CREDIT; none is ever dropped. */", "oldLine": null, "newLine": 5},
                {"kind": "addition", "text": "export const INITIAL_STREAM_CREDIT = 16;", "oldLine": null, "newLine": 6},
                {"kind": "addition", "text": "export const UNARY_RESPONSE_DEADLINE_MS = 30_000;", "oldLine": null, "newLine": 7},
                {"kind": "addition", "text": "", "oldLine": null, "newLine": 8},
                {"kind": "addition", "text": "export const MAX_REQUEST_CHUNKS = 5; // 5 × 60,000 B covers the 256 KiB request ceiling", "oldLine": null, "newLine": 9},
                {"kind": "context", "text": "", "oldLine": 4, "newLine": 10},
                {"kind": "context", "text": "export enum FrameType {", "oldLine": 5, "newLine": 11}
              ]}
            ],
            "lineCount": null
          },
          "linesTruncated": false
        }
        """#,
        "t-frame-limits:1": #"""
        {
          "version": 1, "task": "t-frame-limits", "run": 38,
          "file": {
            "file": 1, "path": "ios/Packages/ToolrollCompanionCore/Sources/ToolrollCompanionCore/CompanionFraming.swift",
            "oldPath": "ios/Packages/ToolrollCompanionCore/Sources/ToolrollCompanionCore/CompanionFraming.swift",
            "meta": [],
            "hunks": [
              {"header": "@@ -18,7 +18,10 @@ public enum CompanionFramingConstants {", "lines": [
                {"kind": "context", "text": "public enum CompanionFramingConstants {", "oldLine": 18, "newLine": 18},
                {"kind": "context", "text": "    public static let headerBytes = 13", "oldLine": 19, "newLine": 19},
                {"kind": "deletion", "text": "    public static let maxFramePayloadBytes = 65_000", "oldLine": 20, "newLine": null},
                {"kind": "addition", "text": "    public static let maxFramePayloadBytes = 60_000", "oldLine": null, "newLine": 20},
                {"kind": "addition", "text": "    public static let maxLogicalUnaryResponseBytes = 1024 * 1024", "oldLine": null, "newLine": 21},
                {"kind": "addition", "text": "    public static let initialStreamCredit: UInt32 = 16", "oldLine": null, "newLine": 22},
                {"kind": "addition", "text": "    public static let maxRequestChunks = 5", "oldLine": null, "newLine": 23},
                {"kind": "context", "text": "}", "oldLine": 21, "newLine": 24}
              ]}
            ],
            "lineCount": null
          },
          "linesTruncated": false
        }
        """#,
        "t-frame-limits:2": #"""
        {
          "version": 1, "task": "t-frame-limits", "run": 38,
          "file": {
            "file": 2, "path": "src/companion/framing.test.ts", "oldPath": "src/companion/framing.test.ts",
            "meta": [],
            "hunks": [
              {"header": "@@ -40,4 +40,13 @@ describe(\"unary pacing\", () => {", "lines": [
                {"kind": "context", "text": "describe(\"unary pacing\", () => {", "oldLine": 40, "newLine": 40},
                {"kind": "deletion", "text": "  it.todo(\"waits for credit\");", "oldLine": 41, "newLine": null},
                {"kind": "addition", "text": "  it(\"sends 16 chunks, then waits for the phone's CREDIT\", () => {", "oldLine": null, "newLine": 41},
                {"kind": "addition", "text": "    const pacer = new UnaryResponsePacer(1, Buffer.alloc(1024 * 1024));", "oldLine": null, "newLine": 42},
                {"kind": "addition", "text": "    expect(pacer.pullAvailable().frames).toHaveLength(16);", "oldLine": null, "newLine": 43},
                {"kind": "addition", "text": "    pacer.grantCredit(1);", "oldLine": null, "newLine": 44},
                {"kind": "addition", "text": "    expect(pacer.pullAvailable().frames).toHaveLength(1);", "oldLine": null, "newLine": 45},
                {"kind": "addition", "text": "  });", "oldLine": null, "newLine": 46},
                {"kind": "addition", "text": "", "oldLine": null, "newLine": 47},
                {"kind": "addition", "text": "  it(\"gives up after 30 seconds\", () => {", "oldLine": null, "newLine": 48},
                {"kind": "addition", "text": "    expect(new UnaryResponsePacer(1, Buffer.alloc(10), 0).isTimedOut(30_001)).toBe(true);", "oldLine": null, "newLine": 49},
                {"kind": "addition", "text": "  });", "oldLine": null, "newLine": 50},
                {"kind": "context", "text": "});", "oldLine": 42, "newLine": 51}
              ]}
            ],
            "lineCount": null
          },
          "linesTruncated": false
        }
        """#,
        "t-restore-wipe:0": #"""
        {
          "version": 1, "task": "t-restore-wipe", "run": 33,
          "file": {
            "file": 0, "path": "src/companion/store.ts", "oldPath": "src/companion/store.ts", "meta": [],
            "hunks": [
              {"header": "@@ -88,6 +88,12 @@ export function onWorkspaceRestored(store: Store) {", "lines": [
                {"kind": "context", "text": "export function onWorkspaceRestored(store: Store) {", "oldLine": 88, "newLine": 88},
                {"kind": "deletion", "text": "  // TODO: paired phones survive a restore", "oldLine": 89, "newLine": null},
                {"kind": "addition", "text": "  // A restored backup must not trust phones paired before it was taken.", "oldLine": null, "newLine": 89},
                {"kind": "addition", "text": "  for (const device of listPairedDevices(store.handle)) {", "oldLine": null, "newLine": 90},
                {"kind": "addition", "text": "    retirePairedDevice(store.handle, device.deviceId, \"restored\");", "oldLine": null, "newLine": 91},
                {"kind": "addition", "text": "  }", "oldLine": null, "newLine": 92},
                {"kind": "addition", "text": "  store.bumpRecoveryGeneration();", "oldLine": null, "newLine": 93},
                {"kind": "addition", "text": "  store.forgetPushSubscriptions();", "oldLine": null, "newLine": 94},
                {"kind": "context", "text": "}", "oldLine": 90, "newLine": 95}
              ]}
            ],
            "lineCount": null
          },
          "linesTruncated": false
        }
        """#,
        "t-restore-wipe:1": #"""
        {
          "version": 1, "task": "t-restore-wipe", "run": 33,
          "file": {
            "file": 1, "path": "src/companion/store.test.ts", "oldPath": "src/companion/store.test.ts", "meta": [],
            "hunks": [
              {"header": "@@ -120,3 +120,7 @@ describe(\"restore\", () => {", "lines": [
                {"kind": "context", "text": "describe(\"restore\", () => {", "oldLine": 120, "newLine": 120},
                {"kind": "addition", "text": "  it(\"asks every phone to pair again\", () => {", "oldLine": null, "newLine": 121},
                {"kind": "addition", "text": "    onWorkspaceRestored(store);", "oldLine": null, "newLine": 122},
                {"kind": "addition", "text": "    expect(listPairedDevices(store.handle).every(d => d.revokedAt !== null)).toBe(true);", "oldLine": null, "newLine": 123},
                {"kind": "addition", "text": "  });", "oldLine": null, "newLine": 124},
                {"kind": "context", "text": "});", "oldLine": 121, "newLine": 125}
              ]}
            ],
            "lineCount": null
          },
          "linesTruncated": false
        }
        """#,
    ]

    static let liveWindowJSON = #"""
    {
      "version": 1,
      "session": {"kind": "run", "id": 41, "task": "t-live-watch"},
      "room": "agent:41", "live": true, "file": "main",
      "window": {
        "ok": true,
        "records": [
          {"k": "open", "at": "2026-11-27T09:08:21.000Z", "detail": "base"},
          {"k": "say", "at": "2026-11-27T09:08:24.000Z", "t": ["Reading the task page and the live sheet."]},
          {"k": "step", "at": "2026-11-27T09:08:30.000Z", "id": "s1", "kind": "edit", "target": "ios/ToolrollCompanion/LiveWatchView.swift"},
          {"k": "done", "at": "2026-11-27T09:09:02.000Z", "id": "s1", "ok": true},
          {"k": "say", "at": "2026-11-27T09:09:05.000Z", "t": ["Added the watch sheet. Running the tests now."]}
        ],
        "cursor": "demo-cursor-1", "restarted": false, "earlier": false, "quarantined": 0, "skipped": 0, "more": false
      }
    }
    """#
}
