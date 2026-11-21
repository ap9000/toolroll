import Foundation

/// Rich offline preview fixtures so `Toolroll.app` launches immediately into an interactive
/// 3-pane workbench even before a remote workspace profile is paired.
public enum DemoFixtures {
    public static let workRows = WorkRowsResponse(
        version: 1,
        project: nil,
        projectName: "All projects",
        needsCount: 1,
        rows: [
            WorkRow(
                id: "t-auth-refresh",
                title: "Rotate refresh token cookie with strict SameSite",
                href: "/t/t-auth-refresh",
                project: "api-gateway",
                age: "4m",
                status: .needs,
                word: "Needs you",
                ask: "Approve plan revision r3 before central run executes migration.",
                chip: "Plan ready",
                group: "needs",
                rank: 1,
                detail: "3 files · touches auth cookie rotation"
            ),
            WorkRow(
                id: "t-handoff-rebase",
                title: "Multi-hop handoff rebase & candidate PR publication",
                href: "/t/t-handoff-rebase",
                project: "toolroll",
                age: "11m",
                status: .running,
                word: "Running",
                chip: "Checks passed",
                group: "running",
                rank: 2,
                detail: "Candidate cand-8a2f promoted to Run #14 · ready to open PR"
            ),
            WorkRow(
                id: "t-live-lease",
                title: "Verify WebSocket PTY takeover confirmation on reconnect",
                href: "/t/t-live-lease",
                project: "toolroll",
                age: "27m",
                status: .queued,
                word: "Queued",
                group: "queued",
                rank: 3,
                detail: "Waiting for central worker slot"
            ),
            WorkRow(
                id: "t-diff-stream",
                title: "Stream hunk diffs without touching repo working tree",
                href: "/t/t-diff-stream",
                project: "toolroll",
                age: "2h",
                status: .finished,
                word: "Finished",
                chip: "PR #486",
                group: "finished",
                rank: 4,
                detail: "All 42 checks green"
            ),
        ],
        room: "home",
        spend: SpendSummary(todayUsd: 4.82, planPercent: 34)
    )

    public static let presence = PresenceSnapshot(
        me: "alex",
        tasks: [
            "t-handoff-rebase": TaskPresence(
                viewers: ["sam", "maya"],
                terminalController: "sam",
                terminalProgram: "shell",
                terminalViewers: 2
            ),
            "t-auth-refresh": TaskPresence(
                viewers: ["maya"],
                terminalController: nil,
                terminalProgram: nil,
                terminalViewers: 0
            ),
        ],
        owners: [
            "t-auth-refresh": "alex",
            "t-handoff-rebase": "alex",
            "t-live-lease": "sam",
            "t-diff-stream": "maya",
        ],
        accounts: ["alex", "sam", "maya"]
    )

    public static func steps(for taskId: String) -> StepCardsResponse {
        switch taskId {
        case "t-auth-refresh":
            return StepCardsResponse(
                task: StepTaskSummary(id: taskId, title: "Rotate refresh token cookie with strict SameSite", project: "api-gateway", state: "needs_approval"),
                headline: "Plan r3 is ready for digest-bound browser approval.",
                liveRun: nil,
                cards: [
                    StepCard(
                        key: "plan",
                        label: "Plan",
                        state: "needs_you",
                        mark: "●",
                        sentence: "Update refresh cookie SameSite=Strict, add dual-read grace window for 24h, and run session rotation integration tests.",
                        at: "4m ago",
                        needsYou: true,
                        inChain: true,
                        agent: StepAgent(provider: "claude", model: "sonnet-4"),
                        costUsd: 0.42,
                        terms: StepTerms(key: "plan", revision: "r3", summary: "Digest-bound approval required in Browser")
                    ),
                    StepCard(
                        key: "checks",
                        label: "Checks",
                        state: "queued",
                        mark: "○",
                        sentence: "Pending approval of plan r3.",
                        at: nil,
                        needsYou: false,
                        inChain: true
                    ),
                ]
            )
        default:
            return StepCardsResponse(
                task: StepTaskSummary(id: taskId, title: "Multi-hop handoff rebase & candidate PR publication", project: "toolroll", state: "running"),
                headline: "Promoted Run #14 passed checks — ready to open Pull Request.",
                liveRun: 14,
                cards: [
                    StepCard(
                        key: "plan",
                        label: "Plan",
                        state: "done",
                        mark: "✓",
                        sentence: "Track multi-hop parentCommit patch chains and expose Open PR on promoted Candidates.",
                        at: "28m ago",
                        inChain: true,
                        agent: StepAgent(provider: "codex", model: "gpt-5"),
                        costUsd: 0.65
                    ),
                    StepCard(
                        key: "run-14",
                        label: "Promoted Run #14",
                        state: "done",
                        mark: "✓",
                        sentence: "Materialized Candidate cand-8a2f onto central branch tr/t-handoff-rebase/c-8a2f and verified diff-stat + terminal-diff.",
                        at: "6m ago",
                        inChain: true,
                        costUsd: 1.18,
                        runs: [14]
                    ),
                    StepCard(
                        key: "checks",
                        label: "Checks",
                        state: "done",
                        mark: "✓",
                        sentence: "typecheck, build, multiplayer-handoff (4/4), and local-handoff (3/3) all passed.",
                        at: "2m ago",
                        inChain: true,
                        runs: [14]
                    ),
                ]
            )
        }
    }

    public static func candidates(for taskId: String) -> CandidatesListResponse {
        if taskId == "t-handoff-rebase" {
            return CandidatesListResponse(
                ok: true,
                taskId: taskId,
                currentBaseCommit: "1ed67ca1",
                candidates: [
                    HandoffCandidate(
                        id: "cand-8a2f4b10",
                        author: "alex",
                        createdAt: "2026-11-21T18:10:00Z",
                        files: ["src/handoff-cli.ts", "src/multiplayer-handoff.ts", "src/browser/multiplayer-bar.tsx"],
                        note: "Add handoff rebase/status/clean + Open PR button",
                        stale: false,
                        promotedAt: "2026-11-21T18:12:00Z",
                        promotedBy: "alex",
                        runId: 14,
                        branch: "tr/t-handoff-rebase/c-8a2f",
                        headCommit: "f753020f",
                        checkStatus: "passed",
                        liveCheckState: "passed",
                        publication: nil,
                        canOpenPr: true
                    ),
                    HandoffCandidate(
                        id: "cand-3d9c1104",
                        author: "sam",
                        createdAt: "2026-11-21T18:16:00Z",
                        files: ["src/handoff-cli.ts"],
                        note: "Polish handoff clean --force safety prompt",
                        stale: false,
                        promotedAt: nil,
                        canOpenPr: false
                    ),
                    HandoffCandidate(
                        id: "cand-0a7e9012",
                        author: "maya",
                        createdAt: "2026-11-21T17:40:00Z",
                        files: ["src/local-handoff.ts"],
                        note: "Earlier patch before base advanced",
                        stale: true,
                        promotedAt: nil,
                        canOpenPr: false
                    ),
                ]
            )
        }
        return CandidatesListResponse(ok: true, taskId: taskId, currentBaseCommit: "7ca335c4", candidates: [])
    }

    public static func diff(for taskId: String) -> ResultDiffResponse {
        ResultDiffResponse(
            task: taskId,
            run: 14,
            totals: DiffTotals(files: 2, added: 38, removed: 6),
            files: [
                DiffFileEntry(path: "src/handoff-cli.ts", added: 26, removed: 4, status: "modified"),
                DiffFileEntry(path: "src/multiplayer-handoff.ts", added: 12, removed: 2, status: "modified"),
            ]
        )
    }

    public static func diffFile(path: String) -> ResultDiffFileResponse {
        ResultDiffFileResponse(
            path: path,
            hunks: [
                DiffHunk(
                    header: "@@ -142,8 +142,14 @@ export async function runHandoffCommand(argv: string[])",
                    lines: [
                        DiffLine(kind: "ctx", text: "  if (sub === \"status\") return await runHandoffStatus(rest);", oldLine: 142, newLine: 142),
                        DiffLine(kind: "del", text: "  if (sub === \"rebase\") return await rebaseSingleHop(rest);", oldLine: 143, newLine: nil),
                        DiffLine(kind: "add", text: "  if (sub === \"rebase\") {", oldLine: nil, newLine: 143),
                        DiffLine(kind: "add", text: "    // Apply chronological patchChain when central base moved ahead.", oldLine: nil, newLine: 144),
                        DiffLine(kind: "add", text: "    return await runHandoffRebase(rest);", oldLine: nil, newLine: 145),
                        DiffLine(kind: "add", text: "  }", oldLine: nil, newLine: 146),
                        DiffLine(kind: "add", text: "  if (sub === \"clean\") return await runHandoffClean(rest);", oldLine: nil, newLine: 147),
                        DiffLine(kind: "ctx", text: "  throw new Error(`Unknown handoff command: ${sub}`);", oldLine: 144, newLine: 148),
                    ]
                )
            ]
        )
    }

    public static func approvalCard(for taskId: String) -> ApprovalCard? {
        guard taskId == "t-auth-refresh" else { return nil }
        return ApprovalCard(
            version: 1,
            task: taskId,
            key: "plan-r3",
            digest: "sha256:9f82a10c4e2b",
            nonce: "demo-nonce-1",
            terms: [
                ApprovalTerm(label: "Scope", words: "3 files in api-gateway/src/auth/ (cookie.ts, refresh.ts, session.test.ts)"),
                ApprovalTerm(label: "Change", words: "Set SameSite=Strict on refresh token cookie with a 24h dual-read grace window"),
                ApprovalTerm(label: "Checks", words: "Run npm run typecheck && vitest src/auth/session.test.ts before ready"),
                ApprovalTerm(label: "Risk", words: "Existing mobile webview sessions roll forward on next refresh; zero downtime"),
            ]
        )
    }

    public static let agents = AgentsReadResponse(
        version: 1,
        checkedAt: "just now",
        agents: [
            AgentRow(id: "claude", name: "Claude Code", state: "signed-in", how: "subscription", ready: true),
            AgentRow(id: "codex", name: "Codex", state: "signed-in", how: "subscription", ready: true),
            AgentRow(id: "antigravity", name: "Antigravity", state: "signed-out", ready: false, setup: AgentSetup(signIn: "agy login")),
            AgentRow(id: "opencode", name: "OpenCode", state: "not-installed", ready: false, setup: AgentSetup(install: "brew install opencode")),
        ],
        firstTask: FirstTaskAgent(id: "claude", name: "Claude Code"),
        lines: ["Claude Code and Codex are signed in and ready to run."]
    )

    public static let models = ModelsReadResponse(
        version: 1,
        defaultAgent: "claude",
        roles: [
            ModelRoleSummary(key: "plan", label: "Plan", current: "claude|sonnet-4", words: "Claude Sonnet 4"),
            ModelRoleSummary(key: "build", label: "Build", current: "codex|gpt-5", words: "Codex GPT-5"),
            ModelRoleSummary(key: "review", label: "Review", current: "claude|sonnet-4", words: "Claude Sonnet 4"),
        ]
    )

    public static let liveRunRecords: [LiveAgentRecord] = [
        LiveAgentRecord(k: "say", at: "14:02", textLines: ["Checking multi-hop handoff patch chains and verifying candidate materialization."]),
        LiveAgentRecord(k: "step", at: "14:02", stepId: "s1", kind: "read", target: "src/handoff-cli.ts"),
        LiveAgentRecord(k: "done", at: "14:02", stepId: "s1", ok: true),
        LiveAgentRecord(k: "step", at: "14:03", stepId: "s2", kind: "bash", target: "vitest run src/local-handoff.test.ts"),
        LiveAgentRecord(k: "done", at: "14:03", stepId: "s2", ok: true, out: ["3 passed (3)"]),
    ]

    public static let leadChat = LeadChatResponse(
        leadName: "Lead",
        canSend: true,
        busy: false,
        messages: [
            LeadMessage(id: 1, role: "user", text: "What needs attention before we cut the release?", at: "18:05"),
            LeadMessage(
                id: 2,
                role: "assistant",
                text: "1 task needs your browser approval (`t-auth-refresh` plan r3). `t-handoff-rebase` Run #14 passed all checks and is ready to Open PR.",
                at: "18:05"
            ),
        ]
    )
}
