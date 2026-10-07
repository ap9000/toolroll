/** Cheap lead-facing status. Every fact comes from indexed SQLite records;
 * this module never opens a repository, retained evidence, or a live log. */
import { familyCompleted } from "./result-completion.js";
import { windowLabel, type LimitWindow } from "./provider-limits.js";
import { openAuthPauses, signInCommand, signInReason } from "./provider-auth.js";
import { BUILT_IN, checkSuitesOf, type RunCheckSuite, type Store } from "./store.js";
import { workIndexPage, workReadyForReview } from "./work-index.js";
import { currentActor } from "./actor.js";
import { leadActivity, leadActivityLine } from "./lead-voice.js";

export type CheckSummary = {
  status: "passed" | "failed" | "not-run" | "unknown";
  exitCode: number | null;
  suites: RunCheckSuite[];
};

export type TaskWaitSnapshot = {
  task: string;
  outcome: "Running" | "Queued" | "Ready" | "Complete" | "Failed" | "Needs a person";
  run: number | null;
  /** The attempt `wait` started watching, when a later retry replaced it. */
  replacedRun: number | null;
  phase: string | null;
  check: CheckSummary;
  next: string;
  terminal: boolean;
  exitCode: 0 | 1 | null;
  reason: "ready" | "complete" | "failed" | "needs-person" | null;
};

export type InstallationStatus = {
  generatedAt: string;
  running: {
    count: number;
    phases: { phase: string; count: number }[];
    tasks: { task: string; run: number; phase: string }[];
  };
  queued: { count: number; reasons: { reason: string; count: number }[]; tasks: { task: string; reason: string }[] };
  waitingForReview: { count: number; results: { task: string; run: number | null; check: CheckSummary }[] };
  releaseCheck: { task: string; run: number; finishedAt: string | null; check: CheckSummary } | null;
  planWindows: (LimitWindow & { provider: string; plan: string | null; observedAt: string })[];
  /** Providers whose sign-in stopped working: their dispatch is paused. */
  signIn: { provider: string; reason: string; command: string; since: string }[];
  /** The most urgent tasks with the shared headline and sentence (task-status.ts), as every other surface words them. */
  tasks: { task: string; title: string; headline: string; sentence: string }[];
  /** What the person's lead is doing now and when it last acted (lead-voice.ts), as one line. */
  lead: { owner: string; doing: string; at: string; task: string | null; line: string } | null;
};

const maybeNumber = (value: unknown): number | null => value === null || value === undefined || !Number.isInteger(Number(value)) ? null : Number(value);

const CHECK_COLUMNS = "rc.status AS check_status, rc.exit_code AS check_exit_code, rc.suites_json AS check_suites_json";

function checkOf(row: Record<string, unknown> | undefined): CheckSummary {
  const status = row?.["check_status"];
  return {
    status: status === "passed" || status === "failed" || status === "not-run" ? status : "unknown",
    exitCode: maybeNumber(row?.["check_exit_code"]),
    suites: checkSuitesOf(row?.["check_suites_json"]),
  };
}

function phaseOf(row: Record<string, unknown>): string {
  const phase = row["phase"] == null ? null : String(row["phase"]);
  if (phase !== null) return phase;
  const role = String(row["role"] ?? "builder");
  return role === "planner" ? "planning" : role === "scout" ? "researching" : role === "reviewer" ? "reviewing" : "preparing";
}

const phaseWords = (phase: string): string => ({
  "agent-running": "agent working",
  "validating-handoff": "checking handoff",
  "capturing-evidence": "saving result",
  committing: "committing",
  "verifying-proof": "running checks",
  "correcting-proof": "correcting result",
  planning: "planning",
  researching: "researching",
  reviewing: "reviewing",
  preparing: "preparing",
}[phase] ?? phase.replace(/-/g, " "));

function latestResult(store: Store, taskRef: number): Record<string, unknown> | undefined {
  return store.handle.prepare(`SELECT run.id, run.outcome, run.reason, run.phase, run.finished_at, ${CHECK_COLUMNS}
    FROM run INDEXED BY work_result LEFT JOIN run_check AS rc ON rc.run = run.id
    WHERE run.task_ref = ? AND run.finished_at IS NOT NULL AND run.role IN ('builder','scout')
    ORDER BY run.id DESC LIMIT 1`).get(taskRef);
}

function unfinishedAttempt(store: Store, taskRef: number): Record<string, unknown> | undefined {
  return store.handle.prepare(`SELECT run.id, run.role, run.outcome, run.reason, run.phase, run.finished_at, ${CHECK_COLUMNS}
    FROM run INDEXED BY work_unfinished LEFT JOIN run_check AS rc ON rc.run = run.id
    WHERE run.task_ref = ? AND run.outcome IS NULL ORDER BY run.id DESC LIMIT 1`).get(taskRef);
}

function latestAttempt(store: Store, taskRef: number): Record<string, unknown> | undefined {
  return store.handle.prepare(`SELECT run.id, run.role, run.outcome, run.reason, run.phase, run.finished_at, ${CHECK_COLUMNS}
    FROM run INDEXED BY lead_status_task_run LEFT JOIN run_check AS rc ON rc.run = run.id
    WHERE run.task_ref = ? AND run.finished_at IS NOT NULL ORDER BY run.id DESC LIMIT 1`).get(taskRef);
}

function newestAttemptSince(store: Store, taskRef: number, run: number): Record<string, unknown> | undefined {
  return store.handle.prepare(`SELECT run.id, run.role, run.outcome, run.reason, run.phase, run.finished_at, ${CHECK_COLUMNS}
    FROM run INDEXED BY lead_status_task_run LEFT JOIN run_check AS rc ON rc.run = run.id
    WHERE run.task_ref = ? AND run.id >= ? ORDER BY run.id DESC LIMIT 1`).get(taskRef, run);
}

/** One indexed observation for `task wait`. `watchedRun` is the attempt the
 * caller first saw. Each poll follows the task's newest attempt from there, so
 * a retry that lands between polls is reported with its own run and outcome,
 * and `replacedRun` says which attempt it replaced. Undefined means no attempt
 * has been observed yet. */
export function taskWaitSnapshot(store: Store, taskId: string, now: Date, watchedRun?: number): TaskWaitSnapshot | null {
  const task = store.handle.prepare(`SELECT task.id, task.state, ref.id AS task_ref, ref.plan, ref.strikes
    FROM task INDEXED BY sqlite_autoindex_task_1
    JOIN task_ref AS ref INDEXED BY sqlite_autoindex_task_ref_1 ON ref.backend = ? AND ref.external_id = task.id
    WHERE task.id = ?`).get(BUILT_IN, taskId);
  if (task === undefined) return null;
  const taskRef = Number(task["task_ref"]);
  const state = String(task["state"]);
  const attempt = watchedRun === undefined ? unfinishedAttempt(store, taskRef) : newestAttemptSince(store, taskRef, watchedRun);
  const followed = maybeNumber(attempt?.["id"]);
  const replacedRun = watchedRun !== undefined && followed !== null && followed !== watchedRun ? watchedRun : null;
  const result = state === "done" ? latestResult(store, taskRef) : undefined;
  const terminalAttempt = state === "failed" || state === "cancelled" ? latestAttempt(store, taskRef) : undefined;
  const shown = attempt ?? result ?? terminalAttempt;
  const run = maybeNumber(shown?.["id"]);
  const check = checkOf(shown);
  const phase = shown === undefined ? null : phaseWords(phaseOf(shown));
  const answer = (outcome: TaskWaitSnapshot["outcome"], next: string, terminal: boolean, exitCode: 0 | 1 | null, reason: TaskWaitSnapshot["reason"]): TaskWaitSnapshot =>
    ({ task: taskId, outcome, run, replacedRun, phase, check, next, terminal, exitCode, reason });

  // The followed attempt's own failure is the answer, even if the task's state
  // has already moved on; a task-level success must not stand in for it.
  if (watchedRun !== undefined && attempt !== undefined && attempt["outcome"] !== null && state !== "failed" && state !== "cancelled") {
    const outcome = String(attempt["outcome"]);
    if (outcome === "parked") return answer("Needs a person", "Answer the task's question", true, 1, "needs-person");
    if (outcome !== "built" && outcome !== "no-change") return answer("Failed", "Inspect attempt", true, 1, "failed");
    if (state !== "done") return answer("Ready", "Open result", true, 0, "ready");
  }

  // A completed family is Complete from any of its tasks.
  const completed = state === "done" && familyCompleted(store, taskId);
  if (completed) return answer("Complete", "No action needed", true, 0, "complete");
  if (state === "done") return answer("Ready", "Open result", true, 0, "ready");
  if (state === "failed" || state === "cancelled") return answer("Failed", state === "cancelled" ? "Review cancellation" : "Inspect failure", true, 1, "failed");

  const decision = store.handle.prepare(`SELECT decision.id FROM run INDEXED BY lead_status_task_run
    JOIN decision INDEXED BY work_open_decision ON decision.run = run.id
    WHERE run.task_ref = ? AND decision.state <> 'answered' AND decision.answered_at IS NULL LIMIT 1`).get(taskRef);
  if (decision !== undefined) return answer("Needs a person", "Answer question", true, 1, "needs-person");

  const hold = store.handle.prepare(`SELECT owner_kind FROM hold INDEXED BY hold_by_task
    WHERE task_ref = ? AND (until IS NULL OR until > ?)
    ORDER BY CASE owner_kind WHEN 'decision' THEN 0 WHEN 'incident' THEN 1 WHEN 'operator' THEN 2 WHEN 'revision' THEN 3 WHEN 'stop' THEN 4 WHEN 'contest' THEN 5 ELSE 6 END, id LIMIT 1`)
    .get(taskRef, now.toISOString());
  const holdKind = hold === undefined ? null : String(hold["owner_kind"]);
  if (holdKind !== null && holdKind !== "backoff") {
    const next = holdKind === "operator" ? "Remove hold" : holdKind === "revision" ? "Review plan" : holdKind === "stop" ? "Resume or close attempt" : holdKind === "contest" ? "Choose a result" : "Review task";
    return answer("Needs a person", next, true, 1, "needs-person");
  }
  // An admitted attempt is already the work being watched. Its immutable
  // approval snapshot lives on the run, so a damaged or later-edited current
  // scope must not make `wait` abandon that attempt before it settles.
  if (attempt !== undefined) return answer("Running", phase === null ? "Wait for attempt" : `Wait — ${phase}`, false, null, null);

  const scope = store.handle.prepare(`SELECT digest, approved_digest, profile_state,
    (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approved_digest = digest) AS approved
    FROM task_scope WHERE task_id = ?`).get(taskId);
  if (task["plan"] === "drafted" && Number(scope?.["approved"]) !== 1) return answer("Needs a person", "Approve plan", true, 1, "needs-person");
  if (Number(task["strikes"] ?? 0) >= 3) return answer("Needs a person", "Review repeated failures", true, 1, "needs-person");
  if (scope === undefined) return answer("Needs a person", "Add scope", true, 1, "needs-person");
  if (Number(scope["approved"]) !== 1 || scope["profile_state"] !== "resolved") return answer("Needs a person", "Approve task", true, 1, "needs-person");
  if (state === "running" && attempt === undefined) {
    const liveClaim = store.handle.prepare(`SELECT 1 AS hit FROM claim INDEXED BY claim_by_task
      WHERE task_ref = ? AND released_at IS NULL AND expires_at > ?
        AND lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest INDEXED BY claim_by_task WHERE newest.task_ref = ?)
      LIMIT 1`).get(taskRef, now.toISOString(), taskRef);
    if (liveClaim !== undefined) return answer("Queued", "Wait for attempt to start", false, null, null);
    return answer("Needs a person", "Reconcile unfinished work", true, 1, "needs-person");
  }
  if (holdKind === "backoff") return answer("Queued", "Wait for retry", false, null, null);
  return answer("Queued", "Wait for a worker", false, null, null);
}

function queueReason(row: Record<string, unknown>): string {
  const hold = row["hold_kind"] == null ? null : String(row["hold_kind"]);
  if (hold === "decision") return "needs a decision";
  if (hold === "incident") return "needs attention";
  if (hold === "operator") return "on hold";
  if (hold === "revision") return "needs plan review";
  if (hold === "stop") return "stopped";
  if (hold === "contest") return "needs a result choice";
  if (hold === "backoff") return "retrying later";
  if (row["plan"] === "drafted" && Number(row["approved"]) !== 1) return "needs plan review";
  if (Number(row["strikes"] ?? 0) >= 3) return "stalled after failures";
  if (Number(row["blocked"] ?? 0) === 1) return "waiting for another task";
  if (row["scope_digest"] == null) return "needs a scope";
  if (Number(row["approved"]) !== 1 || row["profile_state"] !== "resolved") return "needs approval";
  return "ready for a worker";
}

/** Whole-installation status, deliberately aggregated and bounded. */
/** The one-off repair on start. An older build left finished runs' process
 * exits unrecorded and counted completed families as waiting; nothing about
 * a status is stored, so recording every exit that can now be proven and
 * re-deriving each open task's headline from the shared projection clears
 * them. What can't be proven stays as it was. */
export function repairStaleStatuses(store: Store, now: Date): { exitsRecorded: number; readyForReview: number } {
  const exitsRecorded = store.recordFinishedRunExits(now);
  return { exitsRecorded, readyForReview: workReadyForReview(store, now, { principal: "operator", repos: null, includeUnplaced: true }, 0).count };
}

/** `viewer`: the person asking (the lead asks as its person); null when nobody is known, which shows no lead.
 * `repos`: the only projects to report (a remote person limited to some projects); null is the whole installation.
 * A limited report counts only those projects' tasks and leaves out what belongs to the installation as a whole:
 * the release check, plan windows and the lead line are empty, never another project's. */
export function installationStatus(store: Store, now: Date, viewer: string | null = currentActor()?.account ?? null, repos: readonly string[] | null = null): InstallationStatus {
  const admitted = (row: Record<string, unknown>) => repos === null || typeof row["repo"] === "string" && repos.includes(row["repo"]);
  const access = { principal: "operator" as const, repos, includeUnplaced: repos === null };
  const runningRows = store.handle.prepare(`SELECT run.id, run.role, run.phase, ref.id AS task_ref, ref.external_id AS task, ref.repo
    FROM run INDEXED BY work_unfinished
    JOIN task_ref AS ref ON ref.id = run.task_ref
    JOIN claim ON claim.lease_id = run.lease_id
    WHERE run.outcome IS NULL AND claim.released_at IS NULL AND claim.expires_at > ?
      AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest INDEXED BY claim_by_task WHERE newest.task_ref = run.task_ref)
    ORDER BY run.id`).all(now.toISOString()).filter(admitted);
  const phases = new Map<string, number>();
  const runningTasks = runningRows.map(row => {
    const phase = phaseWords(phaseOf(row));
    phases.set(phase, (phases.get(phase) ?? 0) + 1);
    return { task: String(row["task"]), run: Number(row["id"]), phase };
  });

  const runningRefs = new Set(runningRows.map(row => Number(row["task_ref"])));
  const queuedRows = store.handle.prepare(`SELECT task.id, ref.id AS task_ref, ref.repo, ref.plan, ref.strikes, scope.digest AS scope_digest,
      scope.profile_state,
      (scope.approved_at IS NOT NULL AND scope.approved_by IS NOT NULL AND scope.approved_digest = scope.digest) AS approved,
      EXISTS (SELECT 1 FROM task_edge WHERE task_edge.blocked = task.id
        AND EXISTS (SELECT 1 FROM task AS blocker WHERE blocker.id = task_edge.blocker AND blocker.state <> 'done')) AS blocked,
      (SELECT owner_kind FROM hold INDEXED BY hold_by_task WHERE hold.task_ref = ref.id AND (hold.until IS NULL OR hold.until > ?)
        ORDER BY CASE owner_kind WHEN 'decision' THEN 0 WHEN 'incident' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END, id LIMIT 1) AS hold_kind
    FROM task INDEXED BY task_by_state
    JOIN task_ref AS ref INDEXED BY sqlite_autoindex_task_ref_1 ON ref.backend = ? AND ref.external_id = task.id
    LEFT JOIN task_scope AS scope ON scope.task_id = task.id
    WHERE task.state = 'queued'`).all(now.toISOString(), BUILT_IN)
    .filter(row => !runningRefs.has(Number(row["task_ref"])) && admitted(row));
  const reasons = new Map<string, number>();
  const queuedTasks: { task: string; reason: string }[] = [];
  const pauses = openAuthPauses(store);
  for (const row of queuedRows) {
    let reason = queueReason(row);
    if (reason === "ready for a worker" && pauses.length > 0) {
      const scope = store.getScope(String(row["id"]));
      const provider = scope?.approvedProfile?.provider ?? scope?.profile?.provider;
      const paused = pauses.find(one => one.provider === provider);
      if (paused !== undefined) reason = signInReason(paused);
    }
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (queuedTasks.length < 8) queuedTasks.push({ task: String(row["id"]), reason });
  }

  // One per family, from the same projection as the Tasks list: a completed
  // family (root or any revision) and a superseded version never count.
  const ready = workReadyForReview(store, now, access, 5);
  const checkRow = (run: number) => store.handle.prepare(`SELECT ${CHECK_COLUMNS} FROM run_check AS rc WHERE rc.run = ?`).get(run);

  // Run ids grow with time, so the newest finished release check is the
  // first finished row down the partial index.
  const release = repos !== null ? undefined : store.handle.prepare(`SELECT run.id, run.finished_at, ${CHECK_COLUMNS}, ref.external_id AS task
    FROM run_check AS rc INDEXED BY run_check_release
    JOIN run ON run.id = rc.run
    JOIN task_ref AS ref ON ref.id = run.task_ref
    WHERE rc.release = 1 AND run.finished_at IS NOT NULL
    ORDER BY rc.run DESC LIMIT 1`).get();

  return {
    generatedAt: now.toISOString(),
    running: { count: runningTasks.length, phases: [...phases].map(([phase, count]) => ({ phase, count })), tasks: runningTasks.slice(0, 8) },
    queued: {
      count: queuedRows.length,
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      tasks: queuedTasks,
    },
    waitingForReview: { count: ready.count, results: ready.results.map(one => ({ task: one.taskId, run: one.run, check: checkOf(one.run === null ? undefined : checkRow(one.run)) })) },
    releaseCheck: release === undefined ? null : { task: String(release["task"]), run: Number(release["id"]), finishedAt: release["finished_at"] == null ? null : String(release["finished_at"]), check: checkOf(release) },
    planWindows: repos !== null ? [] : store.handle.prepare(`SELECT provider, window, used_percent, window_minutes, resets_at, reached, plan, observed_at
      FROM provider_limit INDEXED BY sqlite_autoindex_provider_limit_1 ORDER BY provider, window`).all().map(row => ({
        provider: String(row["provider"]),
        plan: row["plan"] == null ? null : String(row["plan"]),
        window: String(row["window"]),
        usedPercent: Number(row["used_percent"]),
        windowMinutes: row["window_minutes"] == null ? null : Number(row["window_minutes"]),
        resetsAt: row["resets_at"] == null ? null : String(row["resets_at"]),
        reached: Number(row["reached"]) === 1,
        observedAt: String(row["observed_at"]),
      })),
    signIn: pauses.map(one => ({ provider: one.provider, reason: signInReason(one), command: signInCommand(one), since: one.openedAt })),
    tasks: workIndexPage(store, now, { ...access, viewer }, { limit: 8 }).items
      .map(one => ({ task: one.rootId, title: one.title, headline: one.status.label, sentence: one.status.detail })),
    lead: repos !== null ? null : (() => {
      // Only the asker's own lead: another person's lead is never "Your lead".
      const activity = leadActivity(store, viewer);
      return activity === null ? null : { owner: activity.owner, doing: activity.doing, at: activity.at, task: activity.taskId, line: leadActivityLine(activity, now) };
    })(),
  };
}

/** `limited`: a report over some projects (installationStatus's `repos`), which has no release check or plan windows to state. */
export function renderInstallationStatus(status: InstallationStatus, limited = false): string[] {
  const lines: string[] = [];
  // A paused provider comes first: it is the one thing a person must do.
  for (const one of status.signIn) lines.push(`${one.reason} — run \`${one.command}\`. Its tasks wait until then.`);
  if (status.lead != null) lines.push(status.lead.line);
  // Each task's one headline, the same words as the console and chat cards.
  if (status.tasks.length > 0) {
    lines.push("Tasks:");
    for (const one of status.tasks) lines.push(`  ${one.headline.padEnd(16)} ${one.title} (${one.task}) — ${one.sentence}`);
  }
  lines.push(status.running.count === 0 ? "Building: none" : `Building: ${status.running.count} — ${status.running.tasks.map(one => `${one.task} (#${one.run}, ${one.phase})`).join(", ")}${status.running.count > status.running.tasks.length ? ", …" : ""}`);
  lines.push(status.queued.count === 0 ? "Queued: none" : `Queued: ${status.queued.count} — ${status.queued.tasks.map(one => `${one.task} (${one.reason})`).join(", ")}${status.queued.count > status.queued.tasks.length ? ", …" : ""}`);
  lines.push(status.waitingForReview.count === 0 ? "Ready for review: none" : `Ready for review: ${status.waitingForReview.count} — ${status.waitingForReview.results.map(one => one.run === null ? one.task : `${one.task} (#${one.run})`).join(", ")}${status.waitingForReview.count > status.waitingForReview.results.length ? ", …" : ""}`);
  // Neither the release check nor plan windows belong to a person's projects: a limited report leaves both out.
  if (limited) return lines;
  if (status.releaseCheck === null) {
    lines.push("Release check: none recorded");
  } else {
    const check = status.releaseCheck.check;
    lines.push(`Release check: ${status.releaseCheck.task} #${status.releaseCheck.run} — ${check.status}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`);
    if (check.suites.length > 0) {
      lines.push(`  Suites: ${check.suites.map(suite => `${suite.name} ${suite.status}${suite.exitCode === null ? "" : ` (exit ${suite.exitCode})`}`).join("; ")}`);
    }
  }
  if (status.planWindows.length === 0) {
    lines.push("Plan windows: none recorded");
  } else {
    const providers = new Map<string, typeof status.planWindows>();
    for (const window of status.planWindows) {
      const key = `${window.provider}${window.plan === null ? "" : ` ${window.plan}`}`;
      const list = providers.get(key) ?? [];
      list.push(window);
      providers.set(key, list);
    }
    for (const [provider, windows] of providers) {
      const detail = windows.map(window => `${windowLabel(window.window, window.windowMinutes)} ${window.usedPercent}%${window.reached ? " (limit reached)" : ""}`).join(", ");
      lines.push(`Plan windows: ${provider} — ${detail}`);
    }
  }
  return lines.slice(0, 12 + status.signIn.length + (status.lead == null ? 0 : 1) + (status.tasks.length === 0 ? 0 : status.tasks.length + 1));
}

export function renderTaskWait(snapshot: TaskWaitSnapshot, outcome: string = snapshot.outcome): string {
  const check = snapshot.check.status === "unknown" ? "checks unknown" : snapshot.check.status === "not-run" ? "checks not run" : `checks ${snapshot.check.status}${snapshot.check.exitCode === null ? "" : ` (exit ${snapshot.check.exitCode})`}`;
  const run = snapshot.run === null ? "no run" : snapshot.replacedRun === null ? `run #${snapshot.run}` : `run #${snapshot.run}, a retry that replaced run #${snapshot.replacedRun}`;
  return `${outcome} | ${run} | ${check} | next: ${snapshot.next}`;
}
