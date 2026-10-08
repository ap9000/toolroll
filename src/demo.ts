/**
 * `toolroll demo` (adoption track, step 4) — a seeded, throwaway
 * sandbox: ninety seconds from npx to seeing the product mid-flight, with
 * zero real repos, zero agents, zero spend.
 *
 * The honesty contract (Codex adoption review, findings 8 and 9):
 *
 *   - The database is stamped `demo` BEFORE any row exists — an append-only
 *     installation fact with no unset API. Every spending or external-effect
 *     command (tick, watch, build, publish, reconcile, daemon, bridge,
 *     intake) fails closed on the stamp, so a kept sandbox
 *     can never be mistaken for real work by a worker pointed at it later.
 *     The console banner is decoration; the fence is enforcement.
 *   - The seeded history is SYNTHETIC and does not pretend otherwise: runs
 *     are written with the same permissive store methods the test suite
 *     uses, inside a database that can never join operational history,
 *     because nothing that computes provider success or spends quota will
 *     open it (the fence again).
 *   - The throwaway password goes to the terminal and to a mode-0600 file
 *     inside the sandbox — NEVER into the --json envelope, a URL, or the
 *     database.
 *
 * Everything lives under one mkdtemp directory: database, evidence,
 * "repos". Ctrl-C tears it down; --keep preserves it (still fenced).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, propose, approve, type AcceptanceCriterion } from "./scope.js";
import { legOf, routeDigestOf, type RouteStamp } from "./phase-routing.js";
import { acquire, release } from "./claim.js";
import { register } from "./runner.js";
import { approveRoutine, fireRoutine } from "./routine.js";
import { fileTaskProposal, fileRoutineProposal } from "./proposal.js";
import { storeEvidence, budgetedStatJson, imageDimensions, type DiffStat } from "./evidence.js";
import { parseProof, adjudicate } from "./proof.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { HANDOFF_VERSION, readHandoffArtifact, type HandoffArtifact } from "./contracts/handoff.js";
import { parseExecutionPlanDocument, milestonesOf } from "./plan.js";
import { maybeTriggerRepair } from "./dispose.js";
import { deflateSync } from "node:zlib";
import { FLOW_TEMPLATES } from "./flows.js";

// The demo demonstrates a CONFIGURED install: routing is named once, the
// way `config set build` would, so approvals bind it like production.
const DEMO_PROFILE = {
  provider: "claude" as const,
  model: "sonnet",
  permissionArgv: "auto" as const,
  maxTurns: 1_000, repairMaxTurns: 4, timeoutSeconds: 1_200, timeoutKind: "idle" as const, repairTimeoutSeconds: 300,
  repairModel: "inherit",
};


/** The exact route authority a demo run presents at admission (v48 authority repair): the
 * store dictates nothing, so every routed row here presents the sealed (or,
 * for a planner, the working) leg exactly as a real dispatch would. */
function presentedRoute(
  store: Store,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer",
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: RouteStamp } {
  // A task with no scope presents the bare word `legacy` for the exact
  // pair it spends as (atomic authority closure) — nothing opens unstamped.
  const authority = store.routeAuthorityFor(taskRef, role) ?? store.routeAuthorityFor(taskRef, role, null, spend);
  if (authority === null || !authority.ok) throw new Error(`demo seed: ${authority === null ? "no task" : authority.problem}`);
  return { route: authority.stamp };
}

export type DemoSeed = {
  login: { name: string; password: string };
  repos: string[];
};

/** A believable patch for the finished run's review card. */
const DEMO_PATCH = `diff --git a/src/payout.ts b/src/payout.ts
index 3f1c2aa..9e07b41 100644
--- a/src/payout.ts
+++ b/src/payout.ts
@@ -41,7 +41,9 @@ export function settle(cents: number, rate: number): number {
-  return Math.round(cents * rate);
+  // Banker's rounding: half-cents were accumulating a payable drift of
+  // ~$14/day across the fleet. Verified against the ledger fixtures.
+  return Math.round(cents * rate * 100) / 100;
 }

 export function settleAll(rows: PayoutRow[]): number {
diff --git a/src/payout.test.ts b/src/payout.test.ts
index 11aa0b2..c44d1f7 100644
--- a/src/payout.test.ts
+++ b/src/payout.test.ts
@@ -12,4 +12,12 @@ describe("settle", () => {
+  test("half-cent boundaries do not drift", () => {
+    expect(settle(1005, 0.031)).toBe(31.16);
+  });
`;

/** A demo run's handoff artifact: the run's own identity around the story's conclusion and lists, written through
 * the handoff schema like a real one. */
function demoHandoffBytes(
  store: Store,
  runId: number,
  told: Pick<HandoffArtifact, "outcome" | "committed" | "conclusion" | "changes" | "verification" | "followUps" | "decisionsIncorporated">,
): Buffer {
  const run = store.getRun(runId)!;
  const head = run.headRevision ?? run.baseRevision ?? "0".repeat(40);
  const read = readHandoffArtifact({
    version: HANDOFF_VERSION, taskId: store.externalIdFor(run.taskRef) ?? String(run.taskRef), runId, provider: run.provider,
    sessionId: null, branch: run.branch ?? "", worktree: run.worktree ?? "", base: run.baseRevision ?? head, head, ...told,
    freshness: { stampedAt: run.startedAt, currentAsOf: head },
  });
  if (!read.ok) throw new Error(`demo handoff: ${read.issues.map(issue => issue.line).join("; ")}`);
  return Buffer.from(JSON.stringify(read.value, null, 2), "utf8");
}

const DEMO_HANDOFF = {
  outcome: "built" as const,
  committed: true,
  conclusion:
    "Fixed the payout rounding drift: settle() now rounds at cent precision instead of accumulating half-cent errors. Added boundary tests against the ledger fixtures. All 214 tests pass.",
  changes: [
    "Rounded settlement values at cent precision in src/payout.ts.",
    "Added ledger-fixture coverage for half-cent boundaries.",
  ],
  verification: ["All 214 tests pass, including the new rounding boundary cases."],
  followUps: [],
  decisionsIncorporated: [],
};

/** The failed demo build: it took the flag out of settlement and config, but
 * not out of the admin override, and its own report says so. */
const DEMO_FAILED_PATCH = `diff --git a/src/payout.ts b/src/payout.ts
index 7c1d2e3..5a1f0c7 100644
--- a/src/payout.ts
+++ b/src/payout.ts
@@ -18,9 +18,5 @@ export function settleAll(rows: PayoutRow[]): number {
-  if (config.LEGACY_PAYOUT) {
-    return rows.reduce((sum, row) => sum + legacySettle(row), 0);
-  }
-
-  return rows.reduce((sum, row) => sum + settle(row.cents, row.rate), 0);
+  return rows.reduce((sum, row) => sum + settle(row.cents, row.rate), 0);
 }
diff --git a/src/config.ts b/src/config.ts
index 2b3c4d5..8e9f0a1 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -4,8 +4,6 @@ export const config = {
   PAYOUT_BATCH_SIZE: 500,
-  // Retired once every merchant is on the new settlement path.
-  LEGACY_PAYOUT: process.env.LEGACY_PAYOUT === "1",
   PAYOUT_CURRENCY: "USD",
 };
`;

const DEMO_FAILED_HANDOFF = {
  outcome: "built" as const,
  committed: true,
  conclusion: "Removed LEGACY_PAYOUT from settlement and config. The admin override still reads it, so one reference remains.",
  changes: ["Dropped the legacy settlement branch in src/payout.ts.", "Removed the LEGACY_PAYOUT flag from src/config.ts."],
  verification: ["Searched the codebase for LEGACY_PAYOUT after the change."],
  followUps: [],
  decisionsIncorporated: [],
};

const DEMO_FAILED_PROOF = {
  version: 1 as const,
  criteria: [
    {
      id: "c1",
      statement: "No reference to LEGACY_PAYOUT remains in the codebase.",
      verdict: "met" as const,
      how: "Removed the flag and the settlement branch behind it.",
      evidence: [{ kind: "changed-path" as const, ref: "src/payout.ts" }, { kind: "changed-path" as const, ref: "src/config.ts" }],
    },
  ],
  checks: [],
  changed: ["src/payout.ts", "src/config.ts"],
  caveats: ["c1: src/admin/overrides.ts still reads LEGACY_PAYOUT for the per-merchant override toggle, so one reference remains."],
  screenshots: [],
};

/** The evidence bundle's own manifest (Acceptance Contract v2 demo): the
 * seeded sandbox answers its OWN signed rubric by exact id, with typed
 * evidence references — the same shape a real builder writes — so a
 * fresh install sees the finished feature end to end, not a stub. */
const DEMO_PROOF = {
  version: 1 as const,
  criteria: [
    {
      id: "c1",
      statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.",
      verdict: "met" as const,
      how: "Added and ran boundary tests against the ledger fixtures.",
      evidence: [
        { kind: "check" as const, ref: "npm test" },
        { kind: "changed-path" as const, ref: "src/payout.ts" },
        { kind: "changed-path" as const, ref: "src/payout.test.ts" },
      ],
    },
    {
      id: "c2",
      statement: "The human console formatter still renders payout dashboards.",
      verdict: "met" as const,
      how: "Ran the dashboard's own snapshot tests.",
      evidence: [{ kind: "screenshot" as const, ref: "evidence/payout-dashboard.png" }],
    },
  ],
  checks: [{ command: "npm test", exitCode: 0, summary: "214 tests passed, including the new rounding boundary cases." }],
  changed: ["src/payout.ts", "src/payout.test.ts"],
  // One declared caveat, so the review cockpit's "caveats" row shows a real
  // agent-declared concern in the sandbox rather than only its empty state.
  caveats: ["The dashboard screenshot was captured against the ledger fixtures, not production data."],
  screenshots: [{ path: "evidence/payout-dashboard.png", caption: "Payout dashboard after the fix — totals match the ledger." }],
};

const DEMO_COPY_PATCH = `diff --git a/src/inbox-copy.ts b/src/inbox-copy.ts
index a1b2c3d..d4e5f6a 100644
--- a/src/inbox-copy.ts
+++ b/src/inbox-copy.ts
@@ -8,5 +8,7 @@ export const EMPTY_STATE = {
-  body: "Nothing here.",
+  body: "Nothing needs you right now — approvals, decisions, and proofs waiting on a human all land in this list.",
 };
+
+export const EMPTY_STATE_ILLUSTRATION = "quiet-inbox";
`;

const DEMO_COPY_HANDOFF = {
  outcome: "built" as const,
  committed: true,
  conclusion: "Rewrote the inbox's empty-state copy so it explains why the list is empty instead of just saying so.",
  changes: ["Replaced the empty-state body copy in src/inbox-copy.ts."],
  verification: ["Opened the inbox pane with zero items and read the new copy."],
  followUps: [],
  decisionsIncorporated: [],
};

/** A criterion whose only required evidence is `manual-review` (Acceptance
 * Contract v2, review finding): no check, no screenshot, nothing a machine
 * can resolve on its own — a human has to read the copy and say it is
 * good. The seeded verdict below is computed by the REAL adjudicate(),
 * so the sandbox proves the fix live: this build reads "needs
 * verification", never "verified" or "attested", until an operator uses
 * the same "accept anyway" act a short/refuted proof already offers. */
const DEMO_COPY_PROOF = {
  version: 1 as const,
  criteria: [
    {
      id: "c1",
      statement: "The new empty-state copy reads clearly.",
      verdict: "met" as const,
      how: "Opened the inbox pane with zero items and read the new copy aloud.",
      evidence: [{ kind: "manual-review" as const, ref: "read the new copy in src/inbox-copy.ts" }],
    },
  ],
  checks: [],
  changed: ["src/inbox-copy.ts"],
  caveats: [],
  screenshots: [],
};

const DEMO_EXECUTION_PLAN = [
  "## Approach",
  "Move the request logger to structured JSON lines at the existing boundary, then update only the dashboards that still parse the legacy text format.",
  "## Milestones",
  "1. Trace the logger and the two dashboard consumers.",
  "2. Add the JSON-line formatter without changing local human-readable output.",
  "3. Migrate both dashboard parsers and cover the compatibility boundary.",
  "## Dependencies",
  "- The collector accepts one JSON object per line.",
  "- Local development keeps the existing console formatter.",
  "## Risks",
  "- A partial rollout could mix formats; keep parsing compatibility at the collector boundary during the change.",
  "- Dashboard field names could drift; lock them with fixture-based checks.",
  "## Proof",
  "- c1 — run the logger and dashboard fixture checks and review the rendered JSON lines.",
  "",
].join("\n");

/** Adaptive execution plans (v44): the "building" demo task's revision 1,
 * the planner's original plan before the running build's own evidence
 * revised it. */
const DEMO_BUILDING_PLAN_V1 = [
  "## Approach",
  "Add a per-endpoint token-bucket limiter and enforce it before dispatch, reusing the existing webhook queue.",
  "## Milestones",
  "1. Add a per-endpoint token-bucket limiter.",
  "2. Enforce the limiter before dispatch.",
  "3. Add timeout budgets per endpoint.",
  "4. Cover the limiter and budget interaction with load tests.",
  "## Dependencies",
  "- The existing webhook queue exposes a stable per-endpoint key.",
  "## Risks",
  "- A shared limiter could starve a burst-y but healthy endpoint; scope it per-endpoint from the start.",
  "## Proof",
  "- c1 — load-test one slow and one healthy endpoint together.",
  "",
].join("\n");

/** Revision 2: a prior builder attempt found the named dependency was
 * false (the queue has no stable per-endpoint key) and filed a bounded,
 * evidence-linked, plan-only revision — auto-applied, no operator wait,
 * exactly what c3/c4's plan-only path resumes without another approval. */
const DEMO_BUILDING_PLAN_V2 = [
  "## Approach",
  "Derive a stable per-endpoint key from the normalized webhook URL host, since the queue has none; add a per-endpoint token-bucket limiter keyed on it and enforce it before dispatch.",
  "## Milestones",
  "1. Derive a stable per-endpoint key from the normalized URL host.",
  "2. Add a per-endpoint token-bucket limiter.",
  "3. Enforce the limiter before dispatch.",
  "4. Confirm the dispatch feature flag is enabled in every deploy target.",
  "5. Add timeout budgets per endpoint.",
  "6. Cover the limiter and budget interaction with load tests.",
  "## Dependencies",
  "- None found — the per-endpoint key is now derived, not assumed.",
  "## Risks",
  "- A shared limiter could starve a burst-y but healthy endpoint; scope it per-endpoint from the start.",
  "## Proof",
  "- c1 — load-test one slow and one healthy endpoint together.",
  "",
].join("\n");

const DEMO_BUILDING_REVISION_REASON =
  "The webhook queue has no stable per-endpoint key (src/webhooks/queue.ts) — the planned limiter needed one, so this revision derives it from the normalized URL host instead.";
const DEMO_BUILDING_REVISION_EVIDENCE = "src/webhooks/queue.ts";

/**
 * A minimal, real, uncompressed-per-scanline PNG encoder — no image
 * library, just IHDR + one zlib-deflated IDAT + IEND. Used only to give
 * the demo's screenshot evidence REAL, non-placeholder dimensions and
 * byte size (Acceptance Contract v2: a screenshot criterion needs a real
 * file of at least 320×200 and meaningful bytes to verify) without
 * shipping a binary asset for a run nobody actually captured.
 */
function encodeDemoPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  // A faint vertical gradient so the file is not one repeated byte —
  // "meaningful", not merely large.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    const shade = Math.round((y / Math.max(1, height - 1)) * 40);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = Math.min(255, rgb[0] + shade);
      raw[p + 1] = Math.min(255, rgb[1] + shade);
      raw[p + 2] = Math.min(255, rgb[2] + shade);
    }
  }
  return pngOf(width, height, raw);
}

/** IHDR + one zlib-deflated IDAT + IEND around filtered RGB scanlines. */
function pngOf(width: number, height: number, raw: Buffer): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A real 640×400 PNG — comfortably past the 320×200 / meaningful-byte-size
 * floor a screenshot criterion needs to verify. */
const DEMO_SCREENSHOT_PNG = encodeDemoPng(640, 400, [16, 24, 32]);

/**
 * Seed a believable fleet mid-flight. The store MUST already carry the
 * demo stamp — this function refuses to seed an unfenced database, so no
 * caller can accidentally write synthetic history somewhere real.
 */
export function seedDemo(store: Store, repos: { api: string; web: string }, evidenceRoot: string, now: Date): DemoSeed {
  if (!store.isDemo()) {
    throw new Error("seedDemo refuses an unfenced database — stamp it demo first");
  }
  const password = `demo-${randomBytes(9).toString("base64url")}`;
  const added = addApprover(store, "demo", now, undefined, undefined, {}, password);
  if (!added.ok) throw new Error(`demo approver: ${added.reason}`);
  const token = password;

  const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

  // Configure the install before filing any task, exactly as a normal first
  // run does. Every seeded scope can then be approved from the demo instead
  // of inheriting an artificial "model not set" blocker.
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "demo", now);
  // Approvals bind EXACT routing for every phase (v47): the planner and
  // reviewer name their models too, or no scope could file.
  store.setPhaseConfig("installation", "plan", "claude", "sonnet", "demo", now);
  store.setPhaseConfig("installation", "review", "claude", "sonnet", "demo", now);
  // The strong tier (v47): the named agents high-risk, strict, screenshot-
  // proof, and automerge routes reach for — configured, never inferred.
  store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "demo", now);
  store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "demo", now);

  // The demo's builder goes through the REAL claim machinery, and the claim
  // primitive proves identity and repo binding in-transaction — so the demo
  // runner is registered like a real one, bound to both demo repos.
  const nightShift = register(store, {
    name: "night-shift-1",
    host: "demo",
    capacity: 2,
    repos: [repos.api, repos.web],
    now: hoursAgo(30),
  });
  // What the demo machine observed about each provider without spending
  // (v47): claude installed but unproven (no non-spending login check),
  // codex logged in, openrouter without a key, gemini not installed.
  store.recordProviderReadiness(
    "night-shift-1",
    [
      { provider: "claude", state: "unknown", reason: "installed (claude 2.1.0); no non-spending login check exists — a real run is the proof", probe: "version" },
      { provider: "codex", state: "ready", reason: "installed (codex 0.62.0); logged in as demo@standing-orders.dev", probe: "identity" },
      { provider: "openrouter", state: "unavailable", reason: "OPENROUTER_API_KEY is absent from this runner's environment", probe: "key" },
      { provider: "gemini", state: "unavailable", reason: "`gemini` is not installed on this runner's PATH", probe: "version" },
    ],
    hoursAgo(0.2),
  );

  const genericAcceptance: AcceptanceCriterion[] = [
    { id: "c1", statement: "The described change is made and verified.", how: null, evidence: ["manual-review"] },
  ];
  const task = (id: string, title: string, repo: string, goal?: string, acceptance: AcceptanceCriterion[] = genericAcceptance): string => {
    const made = fileTaskProposal(
      store,
      { id, title, repo, ...(goal === undefined ? {} : { goal, acceptance }), filedVia: "demo" },
      hoursAgo(30),
    );
    if (!made.ok) throw new Error(`seed task ${id}: ${made.reason}`);
    return made.id;
  };

  // --- needs-you: an approval waiting -----------------------------------
  const planned = task(
    "rotate-log-format",
    "Rotate the request-log format to JSON lines",
    repos.web,
    "Switch the request logger to JSON lines so the collector stops parsing free text. Keep the human console formatter for local dev. Migrate the two dashboards that grep the old format.",
  );
  const plannedRef = store.refFor("built-in", planned).id;
  // An explainable route (v47): the operator declared elevated risk and
  // overrode the reviewer, so the ceremony shows a recommended leg, a
  // strong-tier leg, and an overridden leg side by side, with the runner's
  // readiness per provider.
  store.editTaskRoute(plannedRef, { by: "demo", authenticate: () => ({ ok: true }), risk: "elevated" }, hoursAgo(3.5));
  store.editTaskRoute(plannedRef, { by: "demo", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "opus" } }, hoursAgo(3.2));
  store.setPlanState(plannedRef, "drafted");
  const plannerRun = store.startRun({
    taskRef: plannedRef,
    leaseId: "demo-lease-plan",
    runner: "night-shift-1",
    role: "planner",
    branch: `toolroll-plan/${planned}`,
    worktree: join(repos.web, ".demo-worktree-plan"),
    now: hoursAgo(3),
    ...presentedRoute(store, plannedRef, "planner"),
  });
  storeEvidence(
    store,
    evidenceRoot,
    plannerRun,
    "plan",
    "plan.md",
    Buffer.from(DEMO_EXECUTION_PLAN, "utf8"),
    "planner handoff (verified tree) [demo: synthetic]",
    hoursAgo(2.8),
  );
  store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: hoursAgo(2.8) });

  // --- needs-you: a blocking decision -----------------------------------
  const asking = task(
    "choose-retry-policy",
    "Choose the webhook retry policy",
    repos.api,
    "Give outbound webhooks a bounded retry policy with dead-lettering.",
  );
  // The build that parked this question ran under an approval (v48: a
  // routed task opens no run without its sealed route).
  approve(store, asking, "demo", hoursAgo(3), store.getScope(asking)?.digest ?? "", token);
  const askingRun = store.startRun({
    taskRef: store.refFor("built-in", asking).id,
    leaseId: "demo-lease-ask",
    runner: "night-shift-1",
    branch: `toolroll/${asking}`,
    worktree: join(repos.api, ".demo-worktree"),
    now: hoursAgo(2),
    ...presentedRoute(store, store.refFor("built-in", asking).id, "builder"),
  });
  store.saveDecision(
    {
      run: askingRun,
      urgency: "blocking",
      recap:
        "Retries currently hammer failing endpoints forever. The collector at partner X was down 40 minutes yesterday and we sent 8,400 attempts.",
      question: "How should webhook retries back off?",
      options: [
        {
          id: "exp",
          label: "Exponential, cap 1h, dead-letter after 24h",
          consequence: "Slowest to give up; partners see at most ~30 attempts/day.",
          reversible: true,
        },
        {
          id: "fixed",
          label: "Fixed 5-minute retries, dead-letter after 2h",
          consequence: "Faster surrender; brief outages on their side can drop events.",
          reversible: true,
        },
      ],
      recommendation: "exp",
    },
    hoursAgo(1),
  );

  // --- building now ------------------------------------------------------
  const building = task(
    "harden-webhook-retries",
    "Harden webhook delivery against slow consumers",
    repos.api,
    "Add per-endpoint concurrency caps and timeout budgets to webhook delivery.",
  );
  const proposedBuilding = propose(store, {
    profile: DEMO_PROFILE,
    taskId: building,
    goal: "Add per-endpoint concurrency caps and timeout budgets to webhook delivery.",
    outOfScope: "No changes to the public webhook payload shape.",
    touches: ["src/webhooks/"],
    acceptance: [
      { id: "c1", statement: "Slow consumers cannot starve other endpoints' delivery.", how: "Load-test one slow and one healthy endpoint together.", evidence: ["check"] },
    ],
    now: hoursAgo(21),
  });
  approve(store, building, "demo", hoursAgo(20), proposedBuilding.digest, token);
  const buildingRef = store.refFor("built-in", building).id;

  // Adaptive execution plans (v44): the planner's revision 1, and a prior
  // builder attempt that found a stated dependency false and filed a
  // bounded, evidence-linked, plan-only revision — auto-applied, no
  // operator wait (c3, c4's plan-only path). The CURRENT live build below
  // resumes under revision 2, exactly as a real fresh claim would.
  const buildingPlannerRun = store.startRun({
    taskRef: buildingRef,
    leaseId: "demo-lease-plan-2",
    runner: "night-shift-1",
    role: "planner",
    branch: `toolroll-plan/${building}`,
    worktree: join(repos.api, ".demo-worktree-plan-2"),
    now: hoursAgo(19),
    ...presentedRoute(store, buildingRef, "planner"),
  });
  const buildingRev1Artifact = storeEvidence(
    store,
    evidenceRoot,
    buildingPlannerRun,
    "plan",
    "plan.md",
    Buffer.from(DEMO_BUILDING_PLAN_V1, "utf8"),
    "planner handoff (verified tree) [demo: synthetic]",
    hoursAgo(18.9),
  );
  store.finishRun(buildingPlannerRun, { outcome: "built", reason: "plan-drafted", now: hoursAgo(18.9) });
  const buildingRev1Sha = store.getArtifact(buildingRev1Artifact)?.sha256 ?? null;

  const buildingPriorRun = store.startRun({
    taskRef: buildingRef,
    leaseId: "demo-lease-prior",
    runner: "night-shift-1",
    branch: `toolroll/${building}`,
    worktree: join(repos.api, ".demo-worktree-1"),
    now: hoursAgo(2),
    ...presentedRoute(store, buildingRef, "builder"),
  });
  const buildingRev2Artifact = storeEvidence(
    store,
    evidenceRoot,
    buildingPriorRun,
    "plan",
    "revision.md",
    Buffer.from(DEMO_BUILDING_PLAN_V2, "utf8"),
    "builder-filed revision proposal [demo: synthetic]",
    hoursAgo(1.6),
  );
  const buildingRev2Id = store.insertPlanRevision(
    {
      taskRef: buildingRef,
      revision: 2,
      artifact: buildingRev2Artifact,
      parentHash: buildingRev1Sha,
      reason: DEMO_BUILDING_REVISION_REASON,
      evidenceLink: DEMO_BUILDING_REVISION_EVIDENCE,
      author: `builder:${buildingPriorRun}`,
      originRun: buildingPriorRun,
      kind: "builder-proposal",
      authorityKind: "plan-only",
      authorityDigest: "demo-authority-digest-unchanged",
      changedFields: [],
      status: "applied",
    },
    hoursAgo(1.6),
  );
  store.setRunPlanRevision(buildingPriorRun, buildingRev2Id, "demo-authority-digest-unchanged");
  store.finishRun(buildingPriorRun, { outcome: "refused", reason: "plan-revised", now: hoursAgo(1.6) });

  // The board's "building" lane keys off a live claim — take one through
  // the real claim machinery so the card wears worker and lease honestly.
  const liveClaim = acquire(store, buildingRef, "night-shift-1", {
    now: hoursAgo(0.4),
    token: nightShift.token,
    ttlMs: 4 * 3_600_000,
  });
  const liveRun = store.startRun({
    taskRef: buildingRef,
    // The claim's own lease, so the build reads as live: the run the task's current claim owns.
    leaseId: liveClaim.ok ? liveClaim.claim.leaseId : "demo-lease-live",
    runner: "night-shift-1",
    branch: `toolroll/${building}`,
    worktree: join(repos.api, ".demo-worktree-2"),
    now: hoursAgo(0.4),
    ...presentedRoute(store, buildingRef, "builder"),
  });
  store.setRunPlanRevision(liveRun, buildingRev2Id, "demo-authority-digest-unchanged");
  {
    // Mixed milestone states (c1, c2): completed, in progress, blocked, and
    // pending all shown at once on the live build's own checkpoint.
    const buildingRev2Parsed = parseExecutionPlanDocument(DEMO_BUILDING_PLAN_V2);
    if (!buildingRev2Parsed.ok) throw new Error("demo building revision 2 plan is malformed");
    const buildingMilestones = milestonesOf(buildingRev2Parsed.document);
    const state = (index: number): "pending" | "current" | "completed" | "blocked" =>
      index === 0 || index === 1 ? "completed" : index === 2 ? "current" : index === 3 ? "blocked" : "pending";
    const note = (index: number): string | null =>
      index === 3 ? "the flag is off in the staging deploy target — confirming before enforcing" : null;
    store.insertRunCheckpoint(
      {
        run: liveRun,
        taskRef: buildingRef,
        planRevision: buildingRev2Id,
        snapshot: {
          revisionHash: store.getArtifact(buildingRev2Artifact)?.sha256 ?? "",
          milestones: buildingMilestones.map((one, index) => ({ id: one.id, state: state(index), note: note(index) })),
        },
      },
      hoursAgo(0.1),
    );
  }
  store.setRunPhase(liveRun, "agent-running");
  store.setTaskState(building, "running", hoursAgo(0.4));

  // --- done recently: a finished run with a reviewable terminal diff ----
  const done = task(
    "fix-payout-rounding",
    "Fix the payout rounding drift",
    repos.api,
    "Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.",
  );
  const doneProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: done,
    goal: "Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.",
    outOfScope: "No ledger schema changes.",
    touches: ["src/payout.ts", "src/payout.test.ts"],
    acceptance: [
      { id: "c1", statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.", how: null, evidence: ["check", "changed-path"] },
      { id: "c2", statement: "The human console formatter still renders payout dashboards.", how: null, evidence: ["screenshot"] },
    ],
    now: hoursAgo(27),
  });
  approve(store, done, "demo", hoursAgo(26), doneProposed.digest, token);
  // Route provenance (v47): the demo's finished build names the exact
  // agent it spent as, under the route its approval sealed — the same
  // stamp a real admission writes.
  const doneRoute = store.approvedRouteOf(done);
  const doneRun = store.startRun({
    taskRef: store.refFor("built-in", done).id,
    leaseId: "demo-lease-done",
    runner: "night-shift-2",
    branch: `toolroll/${done}`,
    worktree: join(repos.api, ".demo-worktree-3"),
    now: hoursAgo(9),
    ...(doneRoute === null ? {} : { route: { routeDigest: routeDigestOf(doneRoute), phase: "build" as const, provider: legOf(doneRoute, "build").provider, model: legOf(doneRoute, "build").model, chosen: legOf(doneRoute, "build").chosen } }),
  });
  store.stampRun(doneRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", scopeDigest: doneProposed.digest });
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(8.5),
  );
  const stat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "9e07b4152aa01c9f3d7700e54bf8d69288fbe777",
    fileCount: 2,
    additions: 13,
    deletions: 1,
    binaryCount: 0,
    files: [
      { path: "src/payout.ts", additions: 4, deletions: 1 },
      { path: "src/payout.test.ts", additions: 9, deletions: 0 },
    ],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(stat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(8.5),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "handoff",
    "handoff.json",
    demoHandoffBytes(store, doneRun, DEMO_HANDOFF),
    "composed at completion [demo: synthetic]",
    hoursAgo(8.4),
  );
  // The evidence bundle (Priority 2): a validated proof, its claimed
  // screenshot stored as immutable image evidence, the plane's own re-run
  // check, and the closed verdict — computed once, exactly as the real
  // builder would leave it, so a fresh install sees the finished feature.
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(8.4),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "screenshot",
    "screenshot-demo.png",
    DEMO_SCREENSHOT_PNG,
    "agent-claimed screenshot at evidence/payout-dashboard.png (validated png) [demo: synthetic]",
    hoursAgo(8.4),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "check-log",
    "check-log.txt",
    Buffer.from(`$ npm test\n(exit 0)\n\n--- stdout ---\n214 tests passed.\n\n--- stderr ---\n`, "utf8"),
    `sh -c "npm test" (exit 0) [demo: synthetic]`,
    hoursAgo(8.4),
  );
  // The verdict AND the criterion-to-evidence matrix are computed by the
  // real adjudicate() — same function, same rules the builder runs —
  // never hand-authored, so the seeded sandbox shows exactly what the
  // feature actually renders, dimensions read from the real PNG above.
  const demoProofParse = parseProof(JSON.stringify(DEMO_PROOF));
  const demoPngDims = imageDimensions(DEMO_SCREENSHOT_PNG, "png");
  const demoAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: demoProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
    screenshots: [{ path: "evidence/payout-dashboard.png", ok: true, bytes: DEMO_SCREENSHOT_PNG.length, dims: demoPngDims }],
    approvedCriteria: doneProposed.acceptance,
  });
  store.saveProofVerdict(doneRun, demoAdjudicated.verdict, demoAdjudicated.reasons, hoursAgo(8.4), demoAdjudicated.matrix);
  store.finishRun(doneRun, { outcome: "built", committed: true, now: hoursAgo(8.4) });
  store.setTaskState(done, "done", hoursAgo(8.4));
  store.addRunNote(doneRun, "demo", "Reviewed the diff — the fixture numbers check out. Shipping.", hoursAgo(3));

  // --- attention: a failed attempt --------------------------------------
  const failed = task(
    "retire-legacy-flag",
    "Retire the legacy payout feature flag",
    repos.api,
    "Remove LEGACY_PAYOUT and every branch behind it.",
  );
  const failedProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: failed,
    goal: "Remove LEGACY_PAYOUT and every branch behind it.",
    acceptance: [
      { id: "c1", statement: "No reference to LEGACY_PAYOUT remains in the codebase.", how: null, evidence: ["changed-path"] },
    ],
    now: hoursAgo(16),
  });
  approve(store, failed, "demo", hoursAgo(15), failedProposed.digest, token);
  const failedRun = store.startRun({
    taskRef: store.refFor("built-in", failed).id,
    leaseId: "demo-lease-failed",
    runner: "night-shift-2",
    branch: `toolroll/${failed}`,
    worktree: join(repos.api, ".demo-worktree-4"),
    now: hoursAgo(6),
    ...presentedRoute(store, store.refFor("built-in", failed).id, "builder"),
  });
  // What the failed build left: its saved changes, its report and the
  // machine's reading of them. It removed the flag from settlement but left
  // the admin override reading it, and said so in its own note — so the
  // signed requirement is missed, and the task card can name it.
  store.stampRun(failedRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", scopeDigest: failedProposed.digest });
  store.recordOutcomeFacts(failedRun, { headRevision: "5a1f0c7e2b9d4e6f8a0b1c2d3e4f5a6b7c8d9e0f" });
  storeEvidence(store, evidenceRoot, failedRun, "terminal-diff", "terminal-diff.patch", Buffer.from(DEMO_FAILED_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]", hoursAgo(5.6));
  const failedStat: DiffStat = {
    schema: 1, base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head: "5a1f0c7e2b9d4e6f8a0b1c2d3e4f5a6b7c8d9e0f",
    fileCount: 2, additions: 1, deletions: 7, binaryCount: 0,
    files: [{ path: "src/payout.ts", additions: 1, deletions: 5 }, { path: "src/config.ts", additions: 0, deletions: 2 }],
    filesTruncated: false,
  };
  storeEvidence(store, evidenceRoot, failedRun, "diff-stat", "diff-stat.json", budgetedStatJson(failedStat), "parsed from git diff --numstat -z [demo: synthetic]", hoursAgo(5.6));
  storeEvidence(store, evidenceRoot, failedRun, "handoff", "handoff.json", demoHandoffBytes(store, failedRun, DEMO_FAILED_HANDOFF), "composed at completion [demo: synthetic]", hoursAgo(5.6));
  storeEvidence(store, evidenceRoot, failedRun, "proof", "proof.json", Buffer.from(JSON.stringify(DEMO_FAILED_PROOF, null, 2), "utf8"), "agent-authored proof (validated, re-serialized) [demo: synthetic]", hoursAgo(5.6));
  const failedAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: parseProof(JSON.stringify(DEMO_FAILED_PROOF)),
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(failedStat.files.map(one => one.path)) },
    verifyCommand: { configured: false },
    screenshots: [],
    approvedCriteria: failedProposed.acceptance,
  });
  store.saveProofVerdict(failedRun, failedAdjudicated.verdict, failedAdjudicated.reasons, hoursAgo(5.5), failedAdjudicated.matrix);
  store.finishRun(failedRun, {
    outcome: "failed",
    reason: "acceptance",
    now: hoursAgo(5.5),
  });
  store.setTaskState(failed, "failed", hoursAgo(5.5));

  // --- attention: needs verification (manual-review, unaccepted) --------
  // Acceptance Contract v2's own review finding, made visible: a signed
  // rubric can require a human's eyes ("manual-review" evidence), and
  // that alone must cap the build below verified/attested until an
  // operator explicitly accepts it — the SAME "accept anyway" act a
  // short/refuted proof already uses, never a new mechanism.
  const copyReview = task(
    "confirm-empty-state-copy",
    "Confirm the new inbox empty-state copy reads well",
    repos.web,
    "Rewrite the inbox's empty-state copy so it explains why nothing is there yet.",
  );
  const copyReviewProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: copyReview,
    goal: "Rewrite the inbox's empty-state copy so it explains why nothing is there yet.",
    acceptance: [
      {
        id: "c1",
        statement: "The new empty-state copy reads clearly.",
        how: "Open the inbox pane with zero items and read it.",
        evidence: ["manual-review"],
      },
    ],
    now: hoursAgo(10),
  });
  approve(store, copyReview, "demo", hoursAgo(9), copyReviewProposed.digest, token);
  const copyReviewRun = store.startRun({
    taskRef: store.refFor("built-in", copyReview).id,
    leaseId: "demo-lease-copy",
    runner: "night-shift-1",
    branch: `toolroll/${copyReview}`,
    worktree: join(repos.web, ".demo-worktree-5"),
    now: hoursAgo(4),
    ...presentedRoute(store, store.refFor("built-in", copyReview).id, "builder"),
  });
  store.stampRun(copyReviewRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", scopeDigest: copyReviewProposed.digest });
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_COPY_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(3.6),
  );
  const copyStat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "1c2d3e4f52aa01c9f3d7700e54bf8d69288fbe999",
    fileCount: 1,
    additions: 3,
    deletions: 1,
    binaryCount: 0,
    files: [{ path: "src/inbox-copy.ts", additions: 3, deletions: 1 }],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(copyStat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(3.6),
  );
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "handoff",
    "handoff.json",
    demoHandoffBytes(store, copyReviewRun, DEMO_COPY_HANDOFF),
    "composed at completion [demo: synthetic]",
    hoursAgo(3.5),
  );
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_COPY_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(3.5),
  );
  const copyReviewProofParse = parseProof(JSON.stringify(DEMO_COPY_PROOF));
  const copyReviewAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: copyReviewProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(copyStat.files.map(one => one.path)) },
    verifyCommand: { configured: false },
    screenshots: [],
    approvedCriteria: copyReviewProposed.acceptance,
  });
  store.saveProofVerdict(copyReviewRun, copyReviewAdjudicated.verdict, copyReviewAdjudicated.reasons, hoursAgo(3.5), copyReviewAdjudicated.matrix);
  store.finishRun(copyReviewRun, { outcome: "built", committed: true, now: hoursAgo(3.5) });
  store.setTaskState(copyReview, "done", hoursAgo(3.5));

  // --- reviewed + repaired: an independent reviewer contradicts a signed
  // criterion, and the bounded repair loop drafts one unapproved fix
  // (evidence-review-v1) — every step through the REAL functions the tick
  // itself runs: adjudicate(), addReviewerComments/ingestCriterionReviews
  // (the same fold reviewPass performs), and maybeTriggerRepair. Nothing
  // here hand-authors a verdict or a chain row.
  const reviewed = task(
    "guard-payout-limiter",
    "Guard the payout limiter against concurrent settlement",
    repos.api,
    "Add a per-account concurrency guard so two settlements never race the same payout limiter.",
  );
  const reviewedProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: reviewed,
    goal: "Add a per-account concurrency guard so two settlements never race the same payout limiter.",
    outOfScope: "No changes to the limiter's public API.",
    touches: ["src/payout-limiter.ts"],
    acceptance: [
      {
        id: "c1",
        statement: "Two concurrent settlements for the same account cannot both pass the limiter.",
        how: "Read the guard; an independent reviewer confirms it actually locks.",
        evidence: ["manual-review"],
      },
      { id: "c2", statement: "The existing limiter tests still pass.", how: null, evidence: ["check"] },
    ],
    now: hoursAgo(6),
  });
  approve(store, reviewed, "demo", hoursAgo(5.8), reviewedProposed.digest, token);
  const reviewedRun = store.startRun({
    taskRef: store.refFor("built-in", reviewed).id,
    leaseId: "demo-lease-reviewed",
    runner: "night-shift-1",
    branch: `toolroll/${reviewed}`,
    worktree: join(repos.api, ".demo-worktree-4"),
    now: hoursAgo(5),
    ...presentedRoute(store, store.refFor("built-in", reviewed).id, "builder"),
  });
  store.stampRun(reviewedRun, {
    baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    scopeDigest: reviewedProposed.digest,
  });
  const DEMO_REPAIR_PATCH = `diff --git a/src/payout-limiter.ts b/src/payout-limiter.ts
--- a/src/payout-limiter.ts
+++ b/src/payout-limiter.ts
@@ -1,3 +1,4 @@
+// TODO: lock per account
 export function settleWithLimiter(accountId: string, cents: number): number {
   return settle(cents, currentRate(accountId));
 }
`;
  const reviewedDiffArtifact = storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_REPAIR_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(4.6),
    // The seeded capture says its exit 0 in a typed verdict too: the real
    // review door reads THIS, and it refuses a diff with no verdict.
    { captureStatus: "ok" },
  );
  const reviewedStat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "aa11bb22cc33dd44ee55ff6600112233445566aa",
    fileCount: 1,
    additions: 1,
    deletions: 0,
    binaryCount: 0,
    files: [{ path: "src/payout-limiter.ts", additions: 1, deletions: 0 }],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(reviewedStat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(4.6),
  );
  const DEMO_REPAIR_HANDOFF = {
    outcome: "built" as const,
    committed: true,
    conclusion: "Added a TODO comment marking the per-account lock — ran out of turns before wiring the actual guard.",
    changes: ["Marked the per-account lock in src/payout-limiter.ts."],
    verification: [],
    followUps: [],
    decisionsIncorporated: [],
  };
  storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "handoff",
    "handoff.json",
    demoHandoffBytes(store, reviewedRun, DEMO_REPAIR_HANDOFF),
    "composed at completion [demo: synthetic]",
    hoursAgo(4.5),
  );
  const DEMO_REPAIR_PROOF = {
    version: 1,
    criteria: [
      {
        id: "c1",
        statement: "Two concurrent settlements for the same account cannot both pass the limiter.",
        verdict: "met",
        how: "Added the lock.",
        evidence: [{ kind: "manual-review", ref: "see src/payout-limiter.ts" }],
      },
      { id: "c2", statement: "The existing limiter tests still pass.", verdict: "met", how: "npm test", evidence: [{ kind: "check", ref: "npm test" }] },
    ],
    checks: [{ command: "npm test", exitCode: 0, summary: "214 tests passed." }],
    changed: ["src/payout-limiter.ts"],
    caveats: [],
    screenshots: [],
  };
  const reviewedProofArtifact = storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_REPAIR_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(4.5),
  );
  // The verdict, computed by the real adjudicate() — the proof's OWN
  // self-declared "met" reads clean until the independent reviewer looks.
  const reviewedProofParse = parseProof(JSON.stringify(DEMO_REPAIR_PROOF));
  const reviewedAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: reviewedProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(reviewedStat.files.map(one => one.path)) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
    screenshots: [],
    approvedCriteria: reviewedProposed.acceptance,
  });
  store.saveProofVerdict(reviewedRun, reviewedAdjudicated.verdict, reviewedAdjudicated.reasons, hoursAgo(4.4), reviewedAdjudicated.matrix);
  store.finishRun(reviewedRun, { outcome: "built", committed: true, now: hoursAgo(4.4) });
  store.setTaskState(reviewed, "done", hoursAgo(4.4));

  // The independent reviewer: a real reviewer run, its comments AND its
  // criterion judgement ingested through the SAME atomic store method
  // reviewPass itself calls (ingestReview) — the fold is the real
  // foldReview, never a hand-authored verdict, and the bindings are the
  // real scope digest and proof artifact this run actually carries.
  // The review is asked for through the real door and answered through
  // the real admission (raw authority repair): the reviewer run consumes
  // the open request inside its own insert, exactly as the review pass
  // does — a reviewer row opens no other way.
  const reviewAsked = store.requestReview(reviewedRun, "alex", hoursAgo(3.95));
  if (!reviewAsked.ok) throw new Error(`demo: the seeded review could not be requested (${reviewAsked.reason})`);
  const reviewerRun = store.startRun({
    taskRef: store.refFor("built-in", reviewed).id,
    leaseId: "demo-lease-reviewer",
    runner: "night-shift-1",
    role: "reviewer",
    parentRun: reviewedRun,
    request: reviewAsked.id,
    provider: "codex",
    now: hoursAgo(3.9),
    ...presentedRoute(store, store.refFor("built-in", reviewed).id, "reviewer"),
  });
  const reviewedProofSha = store.getArtifact(reviewedProofArtifact)?.sha256 ?? null;
  const reviewedDiffSha = store.getArtifact(reviewedDiffArtifact)?.sha256 ?? "";
  store.stampProviderStart(reviewerRun, hoursAgo(3.9));
  const { folded } = store.ingestReview(
    {
      reviewerRunId: reviewerRun,
      runId: reviewedRun,
      artifactId: reviewedDiffArtifact,
      author: "reviewer:codex",
      comments: [
        {
          path: "src/payout-limiter.ts",
          line: 1,
          note: "This is a TODO, not a lock — two concurrent calls both still read the same rate before either settles.",
          severity: "problem",
        },
      ],
      judgements: [
        {
          id: "c1",
          judgement: "contradicts",
          note: "The diff adds a TODO comment, not an actual lock — two concurrent settlements still race the limiter.",
        },
        {
          id: "c2",
          judgement: "upholds",
          note: "The stored check log supports that the existing limiter test suite still passes.",
        },
      ],
      bindings: {
        diffSha: reviewedDiffSha,
        scopeDigest: reviewedProposed.digest,
        headSha: store.getRun(reviewedRun)?.headRevision ?? store.getRun(reviewedRun)?.baseRevision ?? null,
        proof: reviewedProofSha === null ? null : { artifactId: reviewedProofArtifact, sha256: reviewedProofSha },
        checkLog: null,
        screenshots: [],
      },
    },
    hoursAgo(3.9),
  );
  if (folded === null) throw new Error("seed reviewed+repaired: the fold produced nothing");

  // The bounded repair loop's own trigger — the SAME function the tick
  // calls after a review pass settles a verdict. No mode is signed, so
  // the draft it composes waits unapproved, exactly as the default road
  // promises.
  const repairTrigger = maybeTriggerRepair(store, repos.api, evidenceRoot, reviewedRun, folded.verdict, hoursAgo(3.9));
  if (repairTrigger.kind !== "drafted") {
    throw new Error(`seed reviewed+repaired: expected a draft, got ${repairTrigger.kind}`);
  }

  // --- waiting: a repairable terminal dependency and a hold ---------------
  task("design-tokens", "Extract the design tokens package", repos.web);
  task("ship-dark-mode", "Ship dark mode", repos.web);
  store.addEdge("ship-dark-mode", "design-tokens", {});
  store.cancelTask("design-tokens", hoursAgo(10), "the token package was superseded");
  const held = task("migrate-billing", "Migrate billing exports to the new vendor", repos.api);
  store.hold(store.refFor("built-in", held).id, "waiting on the vendor sandbox account", null, hoursAgo(12));

  // --- a standing order with a track record ------------------------------
  const routine = fileRoutineProposal(
    store,
    {
      name: "nightly-deps",
      repo: repos.api,
      goal: "Refresh the lockfile within existing ranges, run the suite, summarize anything notable.",
      outOfScope: "No major version bumps.",
      touches: [],
      acceptance: [
        { id: "c1", statement: "The full test suite passes against the refreshed lockfile.", how: null, evidence: ["check"] },
      ],
      requirements: [],
      schedule: "daily:03:30",
      costCeilingUsd: null,
      filedVia: "demo",
    },
    hoursAgo(70),
  );
  if (!routine.ok) throw new Error(`seed routine: ${routine.reason}`);
  approveRoutine(store, routine.id, "demo", hoursAgo(69), routine.digest, token);
  // Two nightly slots since approval: one fires, the second records its
  // single-flight skip honestly (the first instance is still open).
  fireRoutine(store, routine.id, hoursAgo(45));
  fireRoutine(store, routine.id, hoursAgo(21));

  // --- the outer loop: an opened PR with observed checks ----------------
  const pub = store.createPublicationIntent(
    {
      run: doneRun,
      taskRef: store.refFor("built-in", done).id,
      githubRepo: "acme/payments-api",
      remote: "origin",
      base: "main",
      head: `toolroll/${done}`,
      headSha: "9e07b4152aa01c9f3d7700e54bf8d69288fbe777",
      bodyHash: "demo",
      draft: false,
    },
    hoursAgo(8.3),
  );
  store.markPublicationPushed(pub, hoursAgo(8.2));
  store.markPublicationOpened(pub, 47, "https://github.com/acme/payments-api/pull/47", hoursAgo(8.1));
  store.recordPublicationCheckState(pub, "passing", hoursAgo(1.5));

  seedDemoFlows(store, repos.web, now);
  return { login: { name: "demo", password }, repos: [repos.api, repos.web] };
}

/** Two tiny real repositories, so repo-bound surfaces have something true
 * to point at. git is optional here — a plain directory still demos. */
export function makeDemoRepos(root: string): { api: string; web: string } {
  const make = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=demo@localhost", "-c", "user.name=demo", "commit", "-q", "-m", "seed"], {
        cwd: dir,
        stdio: "ignore",
      });
    } catch {
      // No git on PATH: a plain directory still serves the demo.
    }
    return dir;
  };
  return {
    api: make("payments-api", {
      "package.json": JSON.stringify({ name: "payments-api", private: true }, null, 2),
      "src/payout.ts": "export function settle(cents: number, rate: number): number {\n  return Math.round(cents * rate * 100) / 100;\n}\n",
      ...demoLeadFiles("payments-api"),
    }),
    web: make("web-console", {
      "package.json": JSON.stringify({ name: "web-console", private: true }, null, 2),
      "src/app.ts": "export const app = () => 'hello';\n",
      ...demoLeadFiles("web-console"),
    }),
  };
}

/** The sandbox: one directory holding everything, stamped before seeding. */
/**
 * Two flows mid-flight (v88), so the canvas has something to show on a first
 * look: a support desk Jev has sorted, and customer replies Claude drafted —
 * one waiting for the demo person's decision. Every decision and draft is
 * written as the real steps write them; nothing runs, and nothing spends.
 */
function seedDemoFlows(store: Store, folder: string, now: Date): void {
  // Projects are known by their real path (macOS's /var is /private/var): the Flows page matches on it.
  const repo = realpathSync(folder);
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const template = (id: string) => JSON.stringify(FLOW_TEMPLATES.find(one => one.id === id)!.definition);
  // Cards arrive where their flow starts; a step's run is recorded, then the card moves where it said.
  const step = (card: number, stage: string, kind: "sort" | "draft" | "email", when: Date, result: string, output: string, extra: { decisionJson?: string; log?: string } = {}) => {
    store.claimFlowStep({ card, entry: store.getFlowCard(card)!.entry, stage, kind, script: null, scriptVersion: null }, when);
    store.finishFlowStep(card, store.getFlowCard(card)!.entry, { state: "passed", result, durationMs: kind === "sort" ? 180 : 4200, ...extra }, when);
    store.updateFlowCard(card, { outputs: { ...store.getFlowCard(card)!.outputs, [stage]: output } }, when);
  };
  const move = (card: number, to: string, when: Date, actor = "flow") => store.moveFlowCard(card, { to, outcome: actor === "flow" ? "ok" : "moved", actor }, when);
  const sorted = (answer: string, sure: number, to: string | null, urgency: string, refund: boolean) => JSON.stringify({
    model: "typesafe/jev-1.13", answer, sure, sureAt: 0.8, confident: sure >= 0.8, to, chances: { [answer]: sure }, ms: 170, cost: 0.000017,
    notes: [{ id: "urgency", question: "How urgent is it?", kind: "score", answer: urgency, sure: 0.8 }, { id: "refund", question: "Is the customer asking for money back?", kind: "yes-no", answer: refund ? "yes" : "no", sure: 0.9 }],
  });
  const desk = store.createFlow({ repo, name: "Support desk", definitionJson: template("exception-routing"), by: "demo" }, at(300));
  for (const [title, description, answer, sure, to, urgency, refund, minutes] of [
    ["Please cancel order #4471", "I ordered the wrong size. Can you cancel it before it ships? — Priya", "Order change", 0.97, "orders", "Soon: the customer is waiting on it", false, 240],
    ["Charged twice for invoice INV-2291", "My card was charged twice this morning. I need the duplicate back before Friday's payroll.", "Invoice problem", 0.94, "billing", "Now: money is at stake or a deadline is named", true, 180],
    ["Parcel arrived crushed", "The box was crushed and two glasses inside are broken.", "Delivery problem", 0.91, "delivery", "Soon: the customer is waiting on it", true, 120],
    ["Where is my order and why was I billed?", "It hasn't arrived and there's a charge I don't recognise.", "Delivery problem", 0.58, "by-hand", "Soon: the customer is waiting on it", false, 45],
  ] as const) {
    const card = store.addFlowCard({ flow: desk, title, description, stage: "sort", by: "Support form" }, at(minutes));
    const confident = sure >= 0.8;
    step(card, "sort", "sort", at(minutes - 1), confident ? `${answer}, ${Math.round(sure * 100)}% sure.` : `Not sure: ${Math.round(sure * 100)}% ${answer}.`, `${confident ? `${answer}, ${Math.round(sure * 100)}% sure.` : `Not sure: ${Math.round(sure * 100)}% ${answer}.`} How urgent is it? ${urgency.split(":")[0]}.`, { decisionJson: sorted(answer, sure, to, urgency, refund) });
    move(card, to, at(minutes - 1));
  }
  const replies = store.createFlow({ repo, name: "Customer replies", definitionJson: template("email-replies"), by: "demo" }, at(200));
  const drafted = (title: string, description: string, draft: string, minutes: number) => {
    const card = store.addFlowCard({ flow: replies, title, description, stage: "write", by: "Contact form" }, at(minutes));
    step(card, "write", "draft", at(minutes - 1), `Drafted ${draft.split(/\s+/).length} words.`, draft, { log: `Claude (sonnet) · 4.2 s\n\n${draft}` });
    move(card, "check", at(minutes - 1));
    return card;
  };
  const sent = drafted("Do you ship to Canada?", "Thinking of ordering but I'm in Toronto. — sam@example.com", "Hi Sam,\n\nYes, we ship to Canada, including Toronto. Delivery usually takes 5–8 business days, and you'll get a tracking link as soon as it leaves us.\n\nThe team", 150);
  store.moveFlowCard(sent, { to: "send", outcome: "approved", actor: "demo" }, at(140));
  step(sent, "send", "email", at(139), "Emailed sam@example.com.", "Sent to sam@example.com: “Re: Do you ship to Canada?”");
  move(sent, "done", at(139));
  store.updateFlowCard(sent, { state: "done" }, at(139));
  drafted("Refund for order 42?", "I was charged twice for order 42. Can I get one refunded? — priya@example.com", "Hi Priya,\n\nSorry about that! We've refunded the duplicate charge for order 42; it should be back on your card within 5 days.\n\nThe team", 20);
  store.updateFlowCard(store.flowCards(replies, false).find(one => one.title === "Refund for order 42?")!.id, { waiting: "Waiting for demo to approve or send it back" }, at(19));
}

export function createDemoSandbox(now: Date): {
  sandbox: string;
  store: Store;
  seed: DemoSeed;
  evidenceRoot: string;
  passwordFile: string;
  lead: DemoLead;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "toolroll-demo-"));
  const repos = makeDemoRepos(sandbox);
  const store = openStore(join(sandbox, "orders.db"));
  // The stamp precedes every row — a half-seeded sandbox is still fenced.
  store.recordInstallationFact("demo", "1", now);
  const evidenceRoot = join(sandbox, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const seed = seedDemo(store, repos, evidenceRoot, now);
  // v105: the plans' windows as Claude and Codex last said them, and a project budget (Tasks shows them as tiles).
  const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  store.recordProviderLimits({ provider: "claude", plan: null, windows: [
    { window: "five_hour", usedPercent: 48, windowMinutes: 300, resetsAt: later(2.2), reached: false },
    { window: "seven_day", usedPercent: 83, windowMinutes: 10_080, resetsAt: later(62), reached: false },
  ] }, now);
  store.recordProviderLimits({ provider: "codex", plan: "pro", windows: [{ window: "seven_day", usedPercent: 12, windowMinutes: 10_080, resetsAt: later(130), reached: false }] }, now);
  store.setBudget({ scope: "project", key: repos.web, limitMicrousd: 25_000_000, hardStop: true }, seed.login.name, now);
  const passwordFile = join(sandbox, "demo-login.txt");
  writeFileSync(passwordFile, `name: ${seed.login.name}\npassword: ${seed.login.password}\n`, { mode: 0o600 });
  const lead = createDemoLead({ store, repos, evidenceRoot, approver: seed.login.name, token: seed.login.password });
  return { sandbox, store, seed, evidenceRoot, passwordFile, lead };
}

// ---------------------------------------------------------------------------
// The scripted demo lead (launch demo): whatever a visitor types in Chat, it
// answers with a short plan for one of a few realistic changes in the seeded
// repos. Approve files a real task under a real approval in this fenced
// database, then a timer walks it through planning, building and checks and
// lands it Ready with stored evidence — the same rows a real build leaves.
// Nothing here calls a model, starts a process or reaches outside; the only
// writes are to the sandbox database and its evidence folder.
// ---------------------------------------------------------------------------

type DemoProject = "payments-api" | "web-console";
type DemoFile = { path: string; before: string | null; after: string };

export type DemoPlan = {
  kind: "flaky-test" | "bug" | "copy" | "flag" | "default";
  project: DemoProject;
  title: string;
  goal: string;
  boundaries: string[];
  checks: string[];
  /** What the builder reports while it works, one line per beat. */
  progress: string[];
  conclusion: string;
  checkOutput: string;
  screenshot: { caption: string; accent: readonly [number, number, number] };
  files: DemoFile[];
};

const DEMO_CHECK_COMMAND = "npm test";

const DEMO_PLANS: Record<DemoPlan["kind"], DemoPlan> = {
  "flaky-test": {
    kind: "flaky-test",
    project: "payments-api",
    title: "Fix the flaky refund test",
    goal: "Make the refund retry test pass every time. It fails about one run in twenty because it waits on a real timer.",
    boundaries: ["Only the test changes; refund logic stays as it is.", "No new dependencies."],
    checks: ["npm test passes, with the refund test run 50 times in a row.", "A screenshot of the passing test report."],
    progress: ["Reading test/refunds.test.ts", "Replacing the real timer with a fake clock", "Running the refund test 50 times"],
    conclusion: "The refund retry test now uses a fake clock instead of a real 200 ms wait, so it no longer depends on how busy the machine is. It passed 50 runs in a row.",
    checkOutput: " ✓ test/refunds.test.ts (1 test, repeated 50 times) 412ms\n ✓ test/payout.test.ts (14 tests) 38ms\n\n Test Files  9 passed (9)\n      Tests  216 passed (216)\n",
    screenshot: { caption: "Test report: 216 passed, refund test 50/50.", accent: [33, 131, 88] },
    files: [{
      path: "test/refunds.test.ts",
      before: 'import { test, expect } from "vitest";\nimport { retryRefund } from "../src/refunds";\n\ntest("retries a declined refund", async () => {\n  const started = Date.now();\n  const result = await retryRefund("rf_1042", { delayMs: 200 });\n  expect(result.status).toBe("refunded");\n  expect(Date.now() - started).toBeLessThan(250);\n});\n',
      after: 'import { test, expect, vi } from "vitest";\nimport { retryRefund } from "../src/refunds";\n\ntest("retries a declined refund", async () => {\n  vi.useFakeTimers();\n  const pending = retryRefund("rf_1042", { delayMs: 200 });\n  await vi.advanceTimersByTimeAsync(200);\n  const result = await pending;\n  expect(result.status).toBe("refunded");\n  vi.useRealTimers();\n});\n',
    }],
  },
  bug: {
    kind: "bug",
    project: "payments-api",
    title: "Stop double refunds when a retry races",
    goal: "A refund retried while the first request is still in flight pays the customer twice. Make refunds idempotent per request.",
    boundaries: ["Only src/refunds.ts and a new test change.", "No database or bank API changes."],
    checks: ["npm test passes, including a new test that retries a refund mid-flight.", "A screenshot of the refunds log showing one refund per request."],
    progress: ["Reading src/refunds.ts", "Sharing one in-flight refund per request id", "Adding a test that retries mid-flight"],
    conclusion: "Refunds now share one in-flight request per request id and pass that id to the bank as the idempotency key, so a racing retry returns the first refund instead of paying twice. Added a regression test.",
    checkOutput: " ✓ test/refunds-race.test.ts (2 tests) 21ms\n ✓ test/refunds.test.ts (1 test) 205ms\n ✓ test/payout.test.ts (14 tests) 38ms\n\n Test Files  10 passed (10)\n      Tests  218 passed (218)\n",
    screenshot: { caption: "Refunds log: one refund per request after two racing retries.", accent: [13, 116, 206] },
    files: [
      {
        path: "src/refunds.ts",
        before: 'import { bank } from "./bank";\n\nexport type Refund = { id: string; status: "refunded" | "declined" };\n\nexport async function refund(id: string, requestId: string): Promise<Refund> {\n  return bank.refund(id);\n}\n',
        after: 'import { bank } from "./bank";\n\nexport type Refund = { id: string; status: "refunded" | "declined" };\n\nconst inFlight = new Map<string, Promise<Refund>>();\n\nexport async function refund(id: string, requestId: string): Promise<Refund> {\n  const existing = inFlight.get(requestId);\n  if (existing) return existing;\n  const started = bank.refund(id, { idempotencyKey: requestId });\n  inFlight.set(requestId, started);\n  try {\n    return await started;\n  } finally {\n    inFlight.delete(requestId);\n  }\n}\n',
      },
      {
        path: "test/refunds-race.test.ts",
        before: null,
        after: 'import { test, expect } from "vitest";\nimport { refund } from "../src/refunds";\nimport { bank } from "../src/bank";\n\ntest("a racing retry refunds once", async () => {\n  const [first, second] = await Promise.all([refund("rf_7", "req_1"), refund("rf_7", "req_1")]);\n  expect(second).toBe(first);\n  expect(bank.refunds("rf_7")).toHaveLength(1);\n});\n',
      },
    ],
  },
  copy: {
    kind: "copy",
    project: "web-console",
    title: "Rewrite the empty Payouts page",
    goal: "The Payouts page says “No data” before the first payout. Say what will appear there and how to send the first one.",
    boundaries: ["Only the empty state's words and link change.", "No layout or style changes."],
    checks: ["npm test passes.", "A screenshot of the new empty Payouts page."],
    progress: ["Reading src/pages/payouts.tsx", "Writing the new empty-state copy", "Rendering the empty page"],
    conclusion: "The empty Payouts page now says “No payouts yet”, explains that sent payouts appear there with their status, and links to sending the first one.",
    checkOutput: " ✓ test/pages.test.tsx (6 tests) 64ms\n ✓ test/app.test.ts (3 tests) 9ms\n\n Test Files  4 passed (4)\n      Tests  41 passed (41)\n",
    screenshot: { caption: "Payouts page with no payouts: the new heading, sentence and link.", accent: [23, 23, 23] },
    files: [{
      path: "src/pages/payouts.tsx",
      before: 'export function PayoutsEmpty() {\n  return (\n    <div className="empty">\n      <p>No data</p>\n    </div>\n  );\n}\n',
      after: 'export function PayoutsEmpty() {\n  return (\n    <div className="empty">\n      <h2>No payouts yet</h2>\n      <p>Payouts you send will appear here with their status.</p>\n      <a href="/payouts/new">Send your first payout</a>\n    </div>\n  );\n}\n',
    }],
  },
  flag: {
    kind: "flag",
    project: "web-console",
    title: "Put the new invoice view behind a flag",
    goal: "Ship the new invoice view switched off, behind an invoices.v2 flag that can be turned on per workspace.",
    boundaries: ["The current invoice list stays the default.", "No changes to invoice data or the API."],
    checks: ["npm test passes, with the flag both on and off.", "A screenshot of the invoices page with the flag on."],
    progress: ["Reading src/flags.ts", "Adding invoices.v2, off by default", "Rendering the invoices page both ways"],
    conclusion: "Added an invoices.v2 flag, off by default. With it on for a workspace, the invoices page shows the new view; otherwise the current list is unchanged.",
    checkOutput: " ✓ test/flags.test.ts (4 tests) 7ms\n ✓ test/pages.test.tsx (8 tests) 71ms\n\n Test Files  4 passed (4)\n      Tests  45 passed (45)\n",
    screenshot: { caption: "Invoices page with invoices.v2 on for the Acme workspace.", accent: [171, 100, 0] },
    files: [
      {
        path: "src/flags.ts",
        before: 'export const flags = {\n  "billing.export": true,\n} as const;\n\nexport type Flag = keyof typeof flags;\n\nexport function isOn(flag: Flag, workspace: { flags?: Partial<Record<Flag, boolean>> }): boolean {\n  return workspace.flags?.[flag] ?? flags[flag];\n}\n',
        after: 'export const flags = {\n  "billing.export": true,\n  "invoices.v2": false,\n} as const;\n\nexport type Flag = keyof typeof flags;\n\nexport function isOn(flag: Flag, workspace: { flags?: Partial<Record<Flag, boolean>> }): boolean {\n  return workspace.flags?.[flag] ?? flags[flag];\n}\n',
      },
      {
        path: "src/pages/invoices.tsx",
        before: 'import { InvoiceList } from "../invoices/list";\n\nexport function InvoicesPage({ workspace }: { workspace: Workspace }) {\n  return <InvoiceList workspace={workspace} />;\n}\n',
        after: 'import { InvoiceList } from "../invoices/list";\nimport { InvoiceView } from "../invoices/view-v2";\nimport { isOn } from "../flags";\n\nexport function InvoicesPage({ workspace }: { workspace: Workspace }) {\n  if (isOn("invoices.v2", workspace)) return <InvoiceView workspace={workspace} />;\n  return <InvoiceList workspace={workspace} />;\n}\n',
      },
    ],
  },
  default: {
    kind: "default",
    project: "payments-api",
    title: "Explain declined payouts in the log",
    goal: "When a payout is declined, the log only says “payout failed”. Log the payout id and the bank's reason so support can answer customers.",
    boundaries: ["Only the declined-payout log line and its test change.", "No customer data beyond the payout id."],
    checks: ["npm test passes, including a test for the new log line.", "A screenshot of the log with a declined payout."],
    progress: ["Reading src/payout-log.ts", "Adding the payout id and reason", "Adding a test for the log line"],
    conclusion: "Declined payouts now log “payout declined” with the payout id and the bank's reason code. Added a test that checks the log line.",
    checkOutput: " ✓ test/payout-log.test.ts (1 test) 4ms\n ✓ test/payout.test.ts (14 tests) 38ms\n\n Test Files  9 passed (9)\n      Tests  215 passed (215)\n",
    screenshot: { caption: "Log viewer: a declined payout with its id and reason.", accent: [196, 50, 10] },
    files: [
      {
        path: "src/payout-log.ts",
        before: 'import { log } from "./log";\n\nexport function payoutDeclined(payoutId: string, reason: string): void {\n  log.warn("payout failed");\n}\n',
        after: 'import { log } from "./log";\n\nexport function payoutDeclined(payoutId: string, reason: string): void {\n  log.warn("payout declined", { payoutId, reason });\n}\n',
      },
      {
        path: "test/payout-log.test.ts",
        before: null,
        after: 'import { test, expect } from "vitest";\nimport { payoutDeclined } from "../src/payout-log";\nimport { log } from "../src/log";\n\ntest("a declined payout logs its id and reason", () => {\n  payoutDeclined("po_311", "R01");\n  expect(log.last()).toEqual({ level: "warn", message: "payout declined", payoutId: "po_311", reason: "R01" });\n});\n',
      },
    ],
  },
};

/** The files each plan changes, as they stand before the change. */
function demoLeadFiles(project: DemoProject): Record<string, string> {
  const files: Record<string, string> = {};
  for (const plan of Object.values(DEMO_PLANS)) {
    if (plan.project !== project) continue;
    for (const file of plan.files) if (file.before !== null) files[file.path] = file.before;
  }
  return files;
}

/** The scripted lead's choice: a plan named by the request's words, else the default. */
export function pickDemoPlan(text: string): DemoPlan {
  const words = text.toLowerCase();
  if (/\b(tests?|flaky|flake|spec|ci)\b/.test(words)) return DEMO_PLANS["flaky-test"];
  if (/\b(flags?|toggle|feature|rollout)\b/.test(words)) return DEMO_PLANS.flag;
  if (/\b(copy|text|wording|words|label|typo|empty|page)\b/.test(words)) return DEMO_PLANS.copy;
  if (/\b(bugs?|fix|broken|crash|errors?|fails?|wrong|double|refunds?)\b/.test(words)) return DEMO_PLANS.bug;
  return DEMO_PLANS.default;
}

/** A unified diff of one small file, one hunk, from a longest-common-subsequence walk. */
function unifiedDiff(file: DemoFile): { patch: string; additions: number; deletions: number } {
  const split = (text: string | null): string[] => (text === null ? [] : text.replace(/\n$/, "").split("\n"));
  const a = split(file.before);
  const b = split(file.after);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { lines.push(`-${a[i]}`); i++; deletions++; }
    else { lines.push(`+${b[j]}`); j++; additions++; }
  }
  const head = file.before === null
    ? `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${b.length} @@\n`
    : `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1,${a.length} +1,${b.length} @@\n`;
  return { patch: `${head}${lines.join("\n")}\n`, additions, deletions };
}

/** A plain mock of the screen the plan's screenshot shows: a header, rows and one coloured result mark. */
function demoScreenshot(accent: readonly [number, number, number]): Buffer {
  const width = 960;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const fill = (x: number, y: number, w: number, h: number, rgb: readonly [number, number, number]): void => {
    for (let row = y; row < Math.min(height, y + h); row++) {
      for (let col = x; col < Math.min(width, x + w); col++) {
        const p = (row * width + col) * 3;
        pixels[p] = rgb[0]; pixels[p + 1] = rgb[1]; pixels[p + 2] = rgb[2];
      }
    }
  };
  fill(0, 0, width, 56, [245, 245, 245]);
  fill(24, 20, 140, 16, [23, 23, 23]);
  fill(0, 56, width, 1, [230, 230, 230]);
  for (let index = 0; index < 7; index++) {
    const y = 96 + index * 64;
    fill(48, y, 260 - (index % 3) * 40, 14, [64, 64, 64]);
    fill(48, y + 24, 420 - (index % 2) * 90, 10, [190, 190, 190]);
    fill(width - 168, y + 4, 112, 24, index === 0 ? accent : [232, 232, 232]);
    fill(24, y + 52, width - 48, 1, [236, 236, 236]);
  }
  return encodePngPixels(width, height, pixels);
}

function encodePngPixels(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return pngOf(width, height, raw);
}

export type DemoExchange = {
  id: number;
  /** What the visitor typed, or the note that asked for this plan. */
  asked: string;
  reply: string;
  plan: DemoPlan;
  /** A visitor's extra instruction carried into the plan by Change it or Request changes. */
  note: string | null;
  state: "proposed" | "replaced" | "working" | "ready" | "complete" | "sent-back";
  stage: "planning" | "building" | "checking" | null;
  progress: string | null;
  taskId: string | null;
  runId: number | null;
  approvedAt: number | null;
};

export type DemoLead = {
  exchanges(): readonly DemoExchange[];
  /** Changes whenever anything a reader would see changes. */
  version(): number;
  ask(text: string, now: Date): DemoExchange;
  approve(id: number, now: Date): { ok: true } | { ok: false; message: string };
  change(id: number, note: string, now: Date): { ok: true } | { ok: false; message: string };
  requestChanges(id: number, note: string, now: Date): { ok: true } | { ok: false; message: string };
  /** Complete through the real completion act, then mark the exchange. */
  complete(id: number, now: Date, act: (taskId: string, runId: number) => { ok: true } | { ok: false; message: string }): { ok: true } | { ok: false; message: string };
  advance(now: Date): void;
  stop(): void;
};

const DEMO_STAGES = ["planning", "building", "checking"] as const;
const DEMO_MAX_EXCHANGES = 40;

/**
 * The scripted lead. `stepMs` is one beat: planning takes one, building two
 * (one per progress line), checks one, so a build lands Ready in four beats.
 * State advances on a timer AND whenever someone reads, so a page and the
 * Tasks list agree without anyone polling.
 */
export function createDemoLead(input: {
  store: Store;
  repos: { api: string; web: string };
  evidenceRoot: string;
  approver: string;
  token: string;
  stepMs?: number;
  clock?: () => Date;
}): DemoLead {
  const { store, repos, evidenceRoot, approver, token } = input;
  if (!store.isDemo()) throw new Error("the scripted lead only runs in a demo database");
  const stepMs = input.stepMs ?? 2_500;
  const clock = input.clock ?? (() => new Date());
  const list: DemoExchange[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let changes = 0;
  let nextId = 1;
  const touched = (): void => { changes++; };
  // The scripted crew is a registered builder, so Tasks reads a demo build
  // as a live claim on a connected builder — registered on first use only.
  const CREW = "demo-crew";
  let crewToken: string | null = null;
  const crewSeen = (at: Date): string => {
    if (crewToken === null) crewToken = register(store, { name: CREW, host: "demo", capacity: 4, repos: [repos.api, repos.web], now: at }).token;
    store.touchRunner(CREW, at);
    return crewToken;
  };
  const leases = new Map<number, string>();
  const find = (id: number): DemoExchange | undefined => list.find(one => one.id === id);
  const repoOf = (plan: DemoPlan): string => (plan.project === "payments-api" ? repos.api : repos.web);
  const said = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 500);

  const add = (asked: string, reply: string, plan: DemoPlan, note: string | null): DemoExchange => {
    const exchange: DemoExchange = { id: nextId++, asked, reply, plan, note, state: "proposed", stage: null, progress: null, taskId: null, runId: null, approvedAt: null };
    list.push(exchange);
    if (list.length > DEMO_MAX_EXCHANGES) list.splice(0, list.length - DEMO_MAX_EXCHANGES);
    touched();
    return exchange;
  };
  const goalOf = (exchange: DemoExchange): string => (exchange.note === null ? exchange.plan.goal : `${exchange.plan.goal} Also: ${exchange.note}`);

  const taskIdFor = (plan: DemoPlan): string => {
    const base = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (store.lookupRef(id) === null) return id;
    }
  };

  /** Each stage's store facts, written once, in order. */
  const enterStage = (exchange: DemoExchange, stage: number, at: Date): void => {
    const plan = exchange.plan;
    const taskId = exchange.taskId!;
    const ref = store.refFor("built-in", taskId).id;
    if (stage === 1) {
      const repo = repoOf(plan);
      // The project check the result reports, approved before the attempt starts — as `verify set` would.
      const command = store.liveVerifyCommand(store.refById(ref)?.repo ?? repo);
      if (command === null || command.command !== DEMO_CHECK_COMMAND) {
        store.setVerifyCommand({ repo: store.refById(ref)?.repo ?? repo, command: DEMO_CHECK_COMMAND, timeoutMs: 120_000, approvedBy: approver }, at);
      }
      const route = store.approvedRouteOf(taskId);
      const claimed = acquire(store, ref, CREW, { now: at, token: crewSeen(at), ttlMs: 10 * 60_000 });
      const leaseId = claimed.ok ? claimed.claim.leaseId : `demo-lease-${taskId}`;
      const run = store.startRun({
        taskRef: ref,
        leaseId,
        runner: CREW,
        branch: `toolroll/${taskId}`,
        worktree: join(repo, `.demo-worktree-${taskId}`),
        now: at,
        ...(route === null ? {} : { route: { routeDigest: routeDigestOf(route), phase: "build" as const, provider: legOf(route, "build").provider, model: legOf(route, "build").model, chosen: legOf(route, "build").chosen } }),
      });
      store.stampRun(run, { baseRevision: randomBytes(20).toString("hex"), scopeDigest: store.getScope(taskId)?.digest ?? "" });
      store.setRunPhase(run, "agent-running", at);
      store.setTaskState(taskId, "running", at);
      exchange.runId = run;
      if (claimed.ok) leases.set(exchange.id, leaseId);
    }
    if (stage === 2) {
      crewSeen(at);
      store.setRunPhase(exchange.runId!, "verifying-proof", at);
    }
    if (stage === 3) finish(exchange, at);
  };

  const finish = (exchange: DemoExchange, at: Date): void => {
    const plan = exchange.plan;
    const run = exchange.runId!;
    const taskId = exchange.taskId!;
    const head = randomBytes(20).toString("hex");
    const base = store.getRun(run)?.baseRevision ?? "";
    const diffs = plan.files.map(file => ({ path: file.path, ...unifiedDiff(file) }));
    const stat: DiffStat = {
      schema: 1, base, head, fileCount: diffs.length,
      additions: diffs.reduce((sum, one) => sum + one.additions, 0),
      deletions: diffs.reduce((sum, one) => sum + one.deletions, 0),
      binaryCount: 0,
      files: diffs.map(one => ({ path: one.path, additions: one.additions, deletions: one.deletions })),
      filesTruncated: false,
    };
    const shotPath = `evidence/${plan.kind}.png`;
    const png = demoScreenshot(plan.screenshot.accent);
    const handoff = { outcome: "built" as const, committed: true, conclusion: plan.conclusion, changes: diffs.map(one => `Changed ${one.path}.`), verification: [plan.checks[0]!], followUps: [], decisionsIncorporated: [] };
    const proof = {
      version: 1 as const,
      criteria: [
        { id: "c1", statement: plan.checks[0]!, verdict: "met" as const, how: "Ran the project check.", evidence: [{ kind: "check" as const, ref: DEMO_CHECK_COMMAND }] },
        { id: "c2", statement: plan.checks[1]!, verdict: "met" as const, how: "Captured the screen after the change.", evidence: [{ kind: "screenshot" as const, ref: shotPath }] },
      ],
      checks: [{ command: DEMO_CHECK_COMMAND, exitCode: 0, summary: plan.checkOutput.trim().split("\n").at(-1)!.trim() }],
      changed: diffs.map(one => one.path),
      caveats: [],
      screenshots: [{ path: shotPath, caption: plan.screenshot.caption }],
    };
    const synthetic = "[demo: scripted]";
    storeEvidence(store, evidenceRoot, run, "terminal-diff", "terminal-diff.patch", Buffer.from(diffs.map(one => one.patch).join(""), "utf8"), `git diff --no-ext-diff --no-textconv --no-color ${base.slice(0, 8)}..HEAD (exit 0) ${synthetic}`, at);
    storeEvidence(store, evidenceRoot, run, "diff-stat", "diff-stat.json", budgetedStatJson(stat), `parsed from git diff --numstat -z ${synthetic}`, at);
    storeEvidence(store, evidenceRoot, run, "handoff", "handoff.json", demoHandoffBytes(store, run, handoff), `composed at completion ${synthetic}`, at);
    storeEvidence(store, evidenceRoot, run, "proof", "proof.json", Buffer.from(JSON.stringify(proof, null, 2), "utf8"), `agent-authored proof (validated, re-serialized) ${synthetic}`, at);
    storeEvidence(store, evidenceRoot, run, "screenshot", `screenshot-${plan.kind}.png`, png, `agent-claimed screenshot at ${shotPath} (validated png) ${synthetic}`, at);
    const log = `=== Attempt summary ===\n- Project check · attempt 1: (exit 0)\n\n=== Project check · attempt 1 ===\n$ ${DEMO_CHECK_COMMAND}\n(exit 0)\n\n--- stdout ---\n${plan.checkOutput}\n--- stderr ---\n`;
    storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from(log, "utf8"), `${DEMO_CHECK_COMMAND} (attempt recorded) ${synthetic}`, at, { captureStatus: "ok" });
    store.recordOutcomeFacts(run, { headRevision: head, handoff: plan.conclusion });
    const repo = store.refById(store.refFor("built-in", taskId).id)?.repo ?? repoOf(plan);
    const command = store.liveVerifyCommand(repo);
    if (command !== null) sealVerificationReceipt(store, evidenceRoot, run, head, command, { configured: true, ran: true, exitCode: 0 }, at);
    store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, at);
    const adjudicated = adjudicate({
      proofArtifactPresent: true,
      proofParse: parseProof(JSON.stringify(proof)),
      handoffPresent: true,
      terminalDiffPresent: true,
      terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) },
      verifyCommand: { configured: true, ran: true, exitCode: 0 },
      screenshots: [{ path: shotPath, ok: true, bytes: png.length, dims: imageDimensions(png, "png") }],
      approvedCriteria: store.getScope(taskId)?.acceptance ?? [],
    });
    store.saveProofVerdict(run, adjudicated.verdict, adjudicated.reasons, at, adjudicated.matrix);
    store.finishRun(run, { outcome: "built", committed: true, now: at });
    store.setTaskState(taskId, "done", at);
    crewSeen(at);
    const lease = leases.get(exchange.id);
    if (lease !== undefined) { release(store, lease, at); leases.delete(exchange.id); }
  };

  const advance = (now: Date): void => {
    for (const exchange of list) {
      if (exchange.state !== "working" || exchange.approvedAt === null) continue;
      const beats = Math.floor((now.getTime() - exchange.approvedAt) / stepMs);
      // planning: beat 0; building: beats 1–2; checks: beat 3; Ready: beat 4.
      const target = beats >= 4 ? 3 : beats >= 3 ? 2 : beats >= 1 ? 1 : 0;
      const current = exchange.stage === null ? -1 : DEMO_STAGES.indexOf(exchange.stage);
      for (let stage = current + 1; stage <= target; stage++) {
        const at = new Date(exchange.approvedAt + [0, 1, 3, 4][stage]! * stepMs);
        enterStage(exchange, stage, at);
        if (stage < 3) exchange.stage = DEMO_STAGES[stage]!;
        else { exchange.state = "ready"; exchange.stage = null; exchange.progress = null; }
        touched();
      }
      if (exchange.state === "working") {
        const line = exchange.stage === "planning" ? "Reading the project and its guidance"
          : exchange.stage === "building" ? exchange.plan.progress[Math.min(1, Math.max(0, beats - 1))]!
          : `Running ${DEMO_CHECK_COMMAND} — ${exchange.plan.progress[2]!.toLowerCase()}`;
        if (line !== exchange.progress) { exchange.progress = line; touched(); }
      }
    }
  };

  const schedule = (exchange: DemoExchange): void => {
    for (const beat of [1, 2, 3, 4]) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        try { advance(clock()); } catch { /* the next read advances it again */ }
      }, beat * stepMs + 20);
      timer.unref();
      timers.add(timer);
    }
    void exchange;
  };

  return {
    exchanges: () => { advance(clock()); return list; },
    version: () => { advance(clock()); return changes; },
    ask(text, now) {
      advance(now);
      const asked = said(text);
      const plan = pickDemoPlan(asked);
      const reply = plan.kind === "default"
        ? `This demo lead is scripted, so it can't plan that exactly. Here's a realistic change in ${plan.project} instead.`
        : `Here's my plan for ${plan.project}. Approve it and the crew starts.`;
      return add(asked, reply, plan, null);
    },
    approve(id, now) {
      advance(now);
      const exchange = find(id);
      if (exchange === undefined) return { ok: false, message: "That plan is no longer here. Ask again." };
      if (exchange.state !== "proposed") return { ok: false, message: "That plan was already handled." };
      const repo = repoOf(exchange.plan);
      const taskId = taskIdFor(exchange.plan);
      const acceptance: AcceptanceCriterion[] = [
        { id: "c1", statement: exchange.plan.checks[0]!, how: null, evidence: ["check"] },
        { id: "c2", statement: exchange.plan.checks[1]!, how: null, evidence: ["screenshot"] },
      ];
      const made = fileTaskProposal(store, { id: taskId, title: exchange.plan.title, repo, goal: goalOf(exchange), acceptance, filedVia: "demo" }, now);
      if (!made.ok) return { ok: false, message: "The demo couldn't file that task." };
      const proposed = propose(store, {
        profile: DEMO_PROFILE,
        taskId,
        goal: goalOf(exchange),
        outOfScope: exchange.plan.boundaries.join(" "),
        touches: exchange.plan.files.map(file => file.path),
        acceptance,
        now,
      });
      const approved = approve(store, taskId, approver, now, proposed.digest, token);
      if (!approved.ok) return { ok: false, message: "The demo couldn't approve that plan." };
      exchange.taskId = taskId;
      exchange.state = "working";
      exchange.stage = "planning";
      exchange.progress = "Reading the project and its guidance";
      exchange.approvedAt = now.getTime();
      store.setTaskState(taskId, "queued", now);
      crewSeen(now);
      touched();
      schedule(exchange);
      return { ok: true };
    },
    change(id, note, now) {
      advance(now);
      const exchange = find(id);
      const words = said(note);
      if (exchange === undefined || exchange.state !== "proposed") return { ok: false, message: "That plan was already handled." };
      if (words === "") return { ok: false, message: "Say what should change." };
      exchange.state = "replaced";
      add(words, "Updated the plan with your note.", exchange.plan, exchange.note === null ? words : `${exchange.note} ${words}`);
      return { ok: true };
    },
    requestChanges(id, note, now) {
      advance(now);
      const exchange = find(id);
      const words = said(note);
      if (exchange === undefined || exchange.state !== "ready") return { ok: false, message: "That result was already handled." };
      if (words === "") return { ok: false, message: "Say what should change." };
      store.addRunNote(exchange.runId!, approver, words, now);
      exchange.state = "sent-back";
      add(words, "Sent back with your note. Here's the revised plan.", exchange.plan, exchange.note === null ? words : `${exchange.note} ${words}`);
      return { ok: true };
    },
    complete(id, now, act) {
      advance(now);
      const exchange = find(id);
      if (exchange === undefined || exchange.state !== "ready") return { ok: false, message: "That result was already handled." };
      const done = act(exchange.taskId!, exchange.runId!);
      if (!done.ok) return done;
      exchange.state = "complete";
      touched();
      return { ok: true };
    },
    advance,
    stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
