/**
 * The nightly full check on main (docs/plans/release-once.md, part 3): a safety net for accidental omissions, not a
 * deadline.
 *
 * - A scheduled flow (flow-schedule.ts) whose standing order names `check: main-full`. A person approves it once, with
 *   their password: the approval binds the release check grant (id and digest), the fenced check access and the
 *   check-only capability, for future main commits. Each firing files `nightly-<date>-<sha7>` at main's head — never a
 *   release branch — sealed with basis `schedule`; that task can't deploy, merge or complete.
 * - A failing nightly writes one `main_check_failure` row per failed item (each failed identity, each group or version,
 *   or the whole part for a part-level outcome) and sends one attention notification.
 * - A row clears only when a qualifying full pass covers that exact item: intended mode full and coverage full, on a
 *   commit that contains the failed main commit (verified ancestry), the item or its whole part ran and passed there.
 *   A composed result never clears anything; a pass that covers one item never clears another.
 * - Open rows refuse targeted planning and block the deploy and merge of a composed release (scope.ts liveReleaseOf).
 * - A missed, stalled or disabled nightly gives no signal but its flow's own health notice after 26 hours.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkoutGitEnv, HARDENED_GIT_ARGS } from "./agent-fence.js";
import { projectGitDir } from "./check-report.js";
import { readVerifiedCommit, verifiedFirstParentWalk } from "./commit-extract.js";
import { fileIdentity, groupIdentity, journeyIdentity, partIdentity, unitIdentity, versionIdentity, type CheckReport } from "./contracts/release-check.js";
import type { StandingOrder } from "./contracts/flow.js";
import { propose, authenticateApprover, liveReleaseOf, personProof } from "./scope.js";
import { failedIdentities, sealedRun } from "./release-recheck.js";
import { verificationEvidence } from "./verification-evidence.js";
import { BUILT_IN, type Store } from "./store.js";
import type { StandingFiring } from "./flow-schedule.js";

/** How long a nightly may be missing before its flow says so. */
export const NIGHTLY_MISSED_MS = 26 * 60 * 60_000;
export const NIGHTLY_STEM = "nightly";
export type MainCheck = NonNullable<StandingOrder["check"]>;

/** What every nightly firing files: fixed here, never read from the trigger's settings. */
export const NIGHTLY_GOAL = "Run the full release check on main's head.";
export const NIGHTLY_NOT = "Changing anything: this is a check only.";
export const NIGHTLY_ACCEPTANCE = Object.freeze([{ id: "c1", statement: "The full release check passes on main", how: null, evidence: ["check" as const] }]);
/** The ledger act that records a person's approval of a nightly check, keyed by its trigger. */
export const NIGHTLY_APPROVED = "nightly check approved";

/** The digest a person's approval of the nightly signs: the trigger, the project, the schedule, the check-only terms
 * and the fixed words each firing files. */
export function nightlyDigestOf(trigger: number, repo: string, schedule: string, check: MainCheck): string {
  return createHash("sha256").update(`nightly-check:${JSON.stringify({ trigger, repo, schedule, check, goal: NIGHTLY_GOAL, not: NIGHTLY_NOT, acceptance: NIGHTLY_ACCEPTANCE })}`).digest("hex").slice(0, 32);
}

/**
 * The approval of a nightly check as the plane recorded it when a person proved themselves (createNightlyCheckFlow):
 * the newest ledger row for this trigger. The trigger's own settings never stand in for it — anyone who can edit them
 * could write one.
 */
export function nightlyApprovalOf(store: Store, trigger: number): { digest: string; by: string; proof: string; at: string } | null {
  for (const row of store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = ? ORDER BY id DESC LIMIT 20").all(NIGHTLY_APPROVED)) {
    try {
      const read = JSON.parse(String(row["detail"])) as Record<string, unknown>;
      if (read["v"] !== 1 || read["trigger"] !== trigger) continue;
      if (typeof read["digest"] !== "string" || typeof read["by"] !== "string" || typeof read["proof"] !== "string" || typeof read["at"] !== "string" || !personProof(read["proof"])) return null;
      return { digest: read["digest"], by: read["by"], proof: read["proof"], at: read["at"] };
    } catch { continue; }
  }
  return null;
}

/** Main's head as the project's own Git directory records it (origin's main as the last fetch saw it, else the local
 * main), read with the hardened environment and verified as a commit. Never a release branch. */
export function mainHeadOf(repo: string): { ok: true; sha: string } | { ok: false; why: string } {
  const gitDir = projectGitDir(repo);
  if (gitDir === null) return { ok: false, why: "the project's Git directory can't be read" };
  const env = { ...checkoutGitEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
  const listed = spawnSync("git", ["--git-dir", gitDir, "--no-replace-objects", ...HARDENED_GIT_ARGS, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin/main", "refs/heads/main"], { env, encoding: "utf8", timeout: 30_000 });
  if (listed.status !== 0) return { ok: false, why: "main can't be read" };
  const refs = new Map(listed.stdout.trim().split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
  const sha = refs.get("refs/remotes/origin/main") ?? refs.get("refs/heads/main");
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, why: "the project has no main" };
  const commit = readVerifiedCommit(gitDir, sha);
  return commit.ok ? { ok: true, sha } : { ok: false, why: commit.message };
}

/**
 * Set up the nightly full check for a project, approved by a person proved now (their password or a re-check; never a
 * lead or remote token). Its schedule starts paused unless `start`; turning it on is the flow's own switch.
 */
export function createNightlyCheckFlow(store: Store, input: { repo: string; schedule: string; as: string; token: string; start: boolean }, now: Date): { ok: true; flow: number; trigger: number } | { ok: false; message: string } {
  const proved = authenticateApprover(store, input.as, input.token, input.repo);
  if (!proved.ok || !personProof(proved.method)) return { ok: false, message: "Only an approver of this project, proved as a person, sets up the nightly check." };
  const grant = store.liveVerifyCommand(input.repo);
  if (grant === null) return { ok: false, message: "The project has no approved release check to run." };
  if (store.projectCheckAccess(input.repo) !== "sandboxed") return { ok: false, message: "The project's checks run outside the sandbox; the nightly check runs only inside it." };
  const check: MainCheck = { kind: "main-full", grant: { id: grant.id, digest: grant.digest }, access: "sandboxed" };
  // The order carries no approval: the person's yes is the plane's own ledger row, written below.
  const order: StandingOrder = {
    stem: NIGHTLY_STEM, goal: NIGHTLY_GOAL, outOfScope: NIGHTLY_NOT, touches: [], requirements: [], acceptance: [...NIGHTLY_ACCEPTANCE], budgetPerRunMicrousd: null, costCeilingUsd: null,
    singleFlight: true, filedBy: input.as, routine: null, approval: null, check,
  };
  const definition = { version: 1, start: "build", stages: [
    { id: "build", title: "Check main", kind: "task", zone: { x: 0, y: 0, w: 260, h: 300, color: "blue" }, instructions: order.goal, planning: "skip", approver: null, message: null, close: null, script: null, sort: null, next: "done", onFail: null },
    { id: "done", title: "Done", kind: "done", zone: { x: 420, y: 0, w: 260, h: 300, color: "green" }, instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null, next: null, onFail: null },
  ] };
  return store.transact(() => {
    const flow = store.createFlow({ repo: input.repo, name: "Nightly check of main", definitionJson: JSON.stringify(definition), by: input.as }, now);
    const trigger = store.addFlowTrigger({ flow, kind: "schedule", configJson: JSON.stringify({ kind: "schedule", schedule: input.schedule, title: "Nightly check of main", description: null, zone: "build", order }), hookHash: null, cursor: null, nextAt: null, by: input.as }, now);
    if (!input.start) store.updateFlowTrigger(trigger, { state: "paused" }, now);
    store.recordAction({ at: now.toISOString(), actor: input.as, repo: input.repo, taskId: null, runId: null, action: NIGHTLY_APPROVED, outcome: input.start ? "on" : "paused", source: "request",
      detail: JSON.stringify({ v: 1, trigger, flow, digest: nightlyDigestOf(trigger, input.repo, input.schedule, check), by: input.as, proof: proved.method, at: now.toISOString(), schedule: input.schedule, grant: grant.id }) });
    return { ok: true as const, flow, trigger };
  });
}

/** A nightly firing (fileStandingOrder routes here): the approval checked again, main's head read, one check-only task
 * filed and sealed by its standing order. */
export function fileNightlyCheck(store: Store, input: { flowId: number; repo: string; trigger: number; schedule: string; order: StandingOrder; title: string; slot: string }, now: Date): StandingFiring {
  const { order, repo } = input;
  const check = order.check!;
  // The approval is the plane's own record of the person's yes for this trigger; anything in the settings is ignored.
  const approval = nightlyApprovalOf(store, input.trigger);
  if (approval === null || approval.digest !== nightlyDigestOf(input.trigger, repo, input.schedule, check)) return { made: "skipped", note: "Skipped: the nightly check isn't approved as it stands. Set it up again." };
  const account = store.accountOf(approval.by);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(approval.by, repo)) return { made: "skipped", note: `Skipped: ${approval.by} can no longer approve in this project.` };
  const grant = store.liveVerifyCommand(repo);
  if (grant === null || grant.id !== check.grant.id || grant.digest !== check.grant.digest) return { made: "skipped", note: "Skipped: the release check changed since the nightly check was approved." };
  if (store.projectCheckAccess(repo) !== "sandboxed") return { made: "skipped", note: "Skipped: the project's checks run outside the sandbox." };
  const blocker = store.standingOrderBlocker(input.trigger, order.routine, now);
  if (blocker !== null) return { made: "skipped", note: `Skipped: the last one (${blocker.taskId}, ${blocker.state}) hasn't finished.` };
  const head = mainHeadOf(repo);
  if (!head.ok) return { made: "skipped", note: `Skipped: ${head.why}.` };
  const taskId = `${NIGHTLY_STEM}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${head.sha.slice(0, 7)}`;
  if (store.getTask(taskId) !== null) return { made: "skipped", note: `Skipped: ${head.sha.slice(0, 7)} was already checked today (${taskId}).` };
  store.createTask({ id: taskId, title: `Nightly check of main at ${head.sha.slice(0, 7)}`, filedBy: { name: null, kind: "automation" } }, now);
  const ref = store.refFor(BUILT_IN, taskId, "ours");
  store.placeTask(ref.id, repo, {}, now);
  store.recordAction({ at: now.toISOString(), actor: "toolroll", repo, taskId, runId: null, action: "task checks chosen", outcome: "full", source: "request", detail: "Checks for this task: Full" });
  // Fixed words, never the trigger's: what the person approved is what files.
  propose(store, { taskId, goal: NIGHTLY_GOAL, outOfScope: NIGHTLY_NOT, candidate: head.sha, acceptance: [...NIGHTLY_ACCEPTANCE], now });
  const sealed = store.sealScopeApproval(taskId, approval.by, now, {}, { kind: "schedule", modeDigest: approval.digest }, "automation");
  store.handle.prepare("INSERT INTO nightly_check (repo, sha, task, at) VALUES (?, ?, ?, ?)").run(repo, head.sha, taskId, now.toISOString());
  return sealed ? { made: "filed", taskId, approved: true, note: `Checking main at ${head.sha.slice(0, 7)}.` }
    : { made: "filed", taskId, approved: false, note: "Its approval can't stand on its own here, so this one waits for approval." };
}

/** Whether a task is a nightly check of main (check only: it never deploys, merges or completes). */
export const isNightlyTask = (store: Store, taskId: string): boolean => store.handle.prepare("SELECT 1 AS hit FROM nightly_check WHERE task = ?").get(taskId) !== undefined;

/** Every item a failed check failed: each failed identity, each failed group or version, and the whole part for a
 * part that couldn't say which items (it stopped, never reported, or crashed). No report: every part. */
export function failedItems(report: CheckReport | null): string[] {
  if (report === null) return [partIdentity("all")];
  const items = new Set(failedIdentities(report));
  for (const part of report.parts) {
    if (!part.selected) continue;
    const attributed = part.part === "unit" ? report.units !== null && report.units.finished && report.units.runErrors === 0
      : part.part === "upgrade" ? report.upgrades !== null && report.upgrades.finished
      : part.part === "typecheck" || part.part === "build" ? false
      : report.journeys.some(one => (one.kind === "real" ? `${one.script}-real` : one.script) === part.part && one.finished && one.groups.every(group => group.state !== "not-run"));
    if ((!part.ran || part.code !== 0) && (!attributed || part.part === "typecheck" || part.part === "build")) items.add(partIdentity(part.part));
  }
  return [...items].sort();
}

/** The words of one failure notice: "2 unit files, app/pages". */
export function failureSummary(items: readonly string[]): string {
  const files = new Set(items.flatMap(one => /^unit:(.+?)::/.exec(one)?.[1] ?? /^file:(.+)$/.exec(one)?.[1] ?? []));
  const groups = new Set(items.flatMap(one => { const m = /^(?:group|journey):(app|flows):(?:scripted|real):([^:]+?)(?:::|$)/.exec(one); return m === null ? [] : [`${m[1]}/${m[2]}`]; }));
  const versions = items.flatMap(one => /^upgrade:(.+)$/.exec(one)?.[1] ?? []);
  const parts = items.flatMap(one => /^part:(.+)$/.exec(one)?.[1] ?? []);
  return [
    ...(files.size === 0 ? [] : [`${files.size} unit file${files.size === 1 ? "" : "s"}`]), ...groups,
    ...(versions.length === 0 ? [] : [`upgrade ${versions.join(", ")}`]), ...parts.map(one => one === "all" ? "the whole check" : `the ${one} part`),
  ].join(", ") || "the check";
}

/**
 * Whether a full run's report shows `item` itself ran and PASSED there (security review): a failed identity has to be
 * reported passed by name — missing, skipped, or a passing part around it never clears it. A part-level item clears
 * when that whole part ran and passed.
 */
export function coversItem(report: CheckReport, item: string): boolean {
  const part = (name: string) => report.parts.find(one => one.part === name);
  const passedPart = (name: string) => { const one = part(name); return one !== undefined && one.ran && one.code === 0; };
  const unit = /^unit:(.+?)::(.+)$/s.exec(item);
  if (unit !== null) return report.units?.identities.some(one => one.file === unit[1] && one.name === unit[2] && one.state === "passed") === true;
  const file = /^file:(.+)$/.exec(item)?.[1];
  if (file !== undefined) return report.units?.files.some(one => one.file === file && one.state === "passed" && one.failed === 0) === true;
  const journey = /^journey:(app|flows):(scripted|real):([^:]+?)::(.+)$/s.exec(item);
  if (journey !== null) {
    const found = report.journeys.find(one => one.script === journey[1] && one.kind === journey[2])?.groups.find(one => one.group === journey[3]);
    return found?.journeys.some(one => one.name === journey[4] && one.state === "passed") === true;
  }
  const group = /^group:(app|flows):(scripted|real):(.+)$/.exec(item);
  if (group !== null) {
    const found = report.journeys.find(one => one.script === group[1] && one.kind === group[2])?.groups.find(one => one.group === group[3]);
    return found !== undefined && found.state === "passed" && !found.unattributed;
  }
  const version = /^upgrade:(.+)$/.exec(item)?.[1];
  if (version !== undefined) return report.upgrades?.versions.some(one => one.version === version && one.state === "passed") === true;
  const whole = /^part:(.+)$/.exec(item)?.[1];
  if (whole === "all") return report.parts.filter(one => one.selected).every(one => one.ran && one.code === 0) && report.exitCode === 0;
  return whole !== undefined && passedPart(whole);
}

/**
 * The plane's sweep (watch's follow-up checks): settle each finished nightly (failure rows and one attention notice),
 * then let each finished full release check clear the main failures it covers. Returns how many it settled.
 */
export function settleReleaseChecks(store: Store, root: string, now: Date): number {
  let settled = 0;
  for (const row of store.handle.prepare("SELECT * FROM nightly_check WHERE outcome IS NULL AND task IS NOT NULL ORDER BY id").all()) {
    const ref = store.lookupRef(String(row["task"]));
    if (ref === null) continue;
    const runs = store.runsFor(ref.id).filter(one => one.role === "builder" && one.finishedAt !== null).sort((a, b) => b.id - a.id);
    const run = runs[0];
    if (run === undefined) continue;
    const check = store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(run.id);
    const status = check === undefined ? (run.outcome === "built" ? null : "failed") : String(check["status"]);
    if (status === null || status === "running" || status === "pending") continue;
    const repo = String(row["repo"]), sha = String(row["sha"]);
    store.transact(() => {
      store.handle.prepare("UPDATE nightly_check SET run = ?, outcome = ? WHERE id = ?").run(run.id, status, Number(row["id"]));
      if (status !== "passed") {
        const items = failedItems(sealedRun(store, root, run.id)?.report ?? null);
        for (const item of items) store.handle.prepare("INSERT OR IGNORE INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, ?, ?, ?)").run(repo, sha, run.id, item, now.toISOString());
        store.enqueueNotification({ dedupeKey: `nightly-failed:${Number(row["id"])}`, kind: "nightly-failed", subject: "Nightly check failed on main",
          body: `Nightly full check failed on main at ${sha.slice(0, 7)}: ${failureSummary(items)}.`, pushClass: "attention", source: { taskRef: ref.id } }, now);
      }
    });
    settled++;
  }
  for (const row of store.handle.prepare("SELECT a.run, a.mode, r.task_ref, r.head_revision, r.finished_at FROM release_check_attempt a JOIN run r ON r.id = a.run WHERE a.settled_at IS NULL AND r.finished_at IS NOT NULL ORDER BY a.run").all()) {
    const runId = Number(row["run"]);
    const repo = store.refById(Number(row["task_ref"]))?.repo ?? null;
    store.transact(() => {
      store.handle.prepare("UPDATE release_check_attempt SET settled_at = ? WHERE run = ?").run(now.toISOString(), runId);
      if (repo === null || row["mode"] !== "full" || row["head_revision"] == null) return;
      // Only a full pass with coverage full clears anything; a composed result never does.
      const gate = verificationEvidence(store, root, runId);
      if (!gate.ok || gate.bytes === null) return;
      let coverage: unknown;
      try { coverage = (JSON.parse(gate.bytes) as { coverage?: unknown }).coverage; } catch { return; }
      if (coverage !== "full") return;
      const report = sealedRun(store, root, runId)?.report ?? null;
      if (report === null) return;
      const gitDir = projectGitDir(repo);
      if (gitDir === null) return;
      const head = String(row["head_revision"]);
      // The pass has to be on main (its head an ancestor of, or main's head itself) or the exact candidate of a release
      // whose approval stands: a pass on a side branch clears nothing (security review).
      const task = store.refById(Number(row["task_ref"]))?.externalId ?? null;
      const main = mainHeadOf(repo);
      const onMain = main.ok && (head === main.sha || verifiedFirstParentWalk(gitDir, main.sha, head, 5000).ok);
      const release = task === null ? null : liveReleaseOf(store, task, "dispatch", now);
      const candidate = task === null ? null : store.getScope(task)?.candidate ?? null;
      const releaseTip = release !== null && release.applies && release.ok && candidate !== null && release.authority.tipSha === candidate;
      if (!onMain && !releaseTip) return;
      for (const failure of store.handle.prepare("SELECT id, sha, item FROM main_check_failure WHERE repo = ? AND cleared_at IS NULL").all(repo)) {
        const sha = String(failure["sha"]);
        const contains = sha === head || verifiedFirstParentWalk(gitDir, head, sha, 2000).ok;
        if (!contains || !coversItem(report, String(failure["item"]))) continue;
        store.handle.prepare("UPDATE main_check_failure SET cleared_by_run = ?, cleared_at = ? WHERE id = ? AND cleared_at IS NULL").run(runId, now.toISOString(), Number(failure["id"]));
        store.recordAction({ at: now.toISOString(), actor: "toolroll", repo, taskId: null, runId, action: "main failure cleared", outcome: "cleared", source: "work", detail: `${String(failure["item"])} at ${sha.slice(0, 7)} · by run ${runId}` });
      }
    });
    settled++;
  }
  return settled;
}

/** The nightly's flow health: "the nightly check hasn't run since …" after 26 hours without a firing. Null when it ran
 * recently, or the project has no nightly check. */
export function nightlyHealthWords(store: Store, repo: string, configuredAt: string, now: Date): string | null {
  const last = store.handle.prepare("SELECT at FROM nightly_check WHERE repo = ? ORDER BY id DESC LIMIT 1").get(repo);
  const since = last === undefined ? configuredAt : String(last["at"]);
  if (now.getTime() - Date.parse(since) < NIGHTLY_MISSED_MS) return null;
  return last === undefined ? `the nightly check hasn't run since it was set up (${since.slice(0, 16).replace("T", " ")})` : `the nightly check hasn't run since ${since.slice(0, 16).replace("T", " ")}`;
}

export { fileIdentity, groupIdentity, journeyIdentity, unitIdentity, versionIdentity };

/** The items the nightly check of main found failing that are still open: a full check reports each by name. */
export function openMainFailureItems(store: Store, repo: string): string[] {
  return store.handle.prepare("SELECT DISTINCT item FROM main_check_failure WHERE repo = ? AND cleared_at IS NULL ORDER BY item").all(repo).map(row => String(row["item"]));
}
