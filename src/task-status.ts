/** One answer per task, then the details (docs/design/task-status.md). Every
 * surface — the Tasks list, the task page, the build page, Crew, the Chat
 * result, the Telegram/Slack/Discord/Teams cards and `toolroll status` — reads
 * its headline, sentence, tone and detail rows from `taskStatusOf`, so the
 * words cannot drift apart again. Pure: it reads facts the existing
 * projections already recorded and never changes a check, approval or
 * completion.
 *
 * Severity: red belongs to the Failed headline alone. A detail problem that
 * doesn't undo the outcome (a pull request that couldn't open, shortened
 * output) is an amber note on its own row with one action; the exact
 * technical reason stays one tap away in `why`. */
import { DEFAULT_LEAD_NAME } from "./lead-identity.js";
import type { AssignmentSnapshot } from "./assignment.js";
import { CODE_NEED, NEEDS, needSentence, waitSentence, type NeedAction, type NeedContext, type NeedKey, type WaitKey } from "./needs-you.js";
export type { NeedKey, WaitKey } from "./needs-you.js";

/** A cancelled task with a successor reads "Replaced by <id>" everywhere, never "Cancelled". */
export const replacedWords = (successor: string): string => `Replaced by ${successor}`;
const REPLACED = /^Replaced by \S+/;
/** Waiting: a reason no person can act on, worded as what it waits for (needs-you.ts). */
export const HEADLINES = ["Queued", "Planning", "Needs you", "Waiting", "Building", "Ready for review", "Complete", "Failed", "Stopped"] as const;
export type Headline = (typeof HEADLINES)[number];
export type HeadlineTone = "neutral" | "live" | "attention" | "ready" | "success" | "danger";
export const HEADLINE_TONE: Readonly<Record<Headline, HeadlineTone>> = {
  Queued: "neutral", Planning: "live", "Needs you": "attention", Waiting: "neutral", Building: "live",
  "Ready for review": "ready", Complete: "success", Failed: "danger", Stopped: "neutral",
};

/** The project's own checks and the pull request's CI are two different things, never one word (Checks beside CI). */
export const CHECKS_LABEL = "Project checks";
export const PR_CI_LABEL = "PR CI";
/** The one verb for opening a saved result, on every surface. */
export const OPEN_RESULT = "Open result";

export type DetailKey = "checks" | "pull-request" | "requirements" | "evidence";
/** The row's small icon: the only coloured part of a detail. `failed` is red
 * and only ever appears under the Failed headline; `note` is amber. */
export type DetailMark = "ok" | "running" | "none" | "note" | "failed";
export type StatusAction = { label: string; href: string | null };
export type StatusDetail = { key: DetailKey; label: string; text: string; mark: DetailMark; href: string | null; action: StatusAction | null; why: string | null };
/** `need`: what a Needs you asks for and the one action that resolves it; null under every other headline. */
export type TaskStatus = { headline: Headline; tone: HeadlineTone; sentence: string; details: StatusDetail[]; primaryAction: StatusAction | null; why: string[];
  need?: { key: NeedKey; action: NeedAction } | null };

/** `reviewing`: the one automatic review (build-review.ts) is reading a finished build; it reads Building, not a headline of its own. */
export type TaskStage = "queued" | "planning" | "needs-you" | "waiting" | "building" | "checking" | "reviewing" | "finished" | "complete" | "failed" | "stopped";
export type ChecksFact = {
  status: "passed" | "failed" | "running" | "not-run" | "unavailable"; exitCode: number | null; head: string | null;
  /** The check level that ran (check-levels.ts). Off never reads Ready; a quick pass says so. */
  level?: "quick" | "full" | "off" | null;
  /** A follow-up check (Run checks) waiting or running on this commit. */
  running?: "quick" | "full" | null;
  /** A batch check (batch-checks.ts): waiting for its batch, or how it was checked. */
  batch?: ChecksBatch | null;
  /** Off: the passing full release check whose commit contains this one (release-coverage.ts), read at read time. */
  release?: { run: number; head: string } | null;
};
/** What checks Off leaves for a release: `pending` until a passing full release check contains the commit, then
 * `covered`. `running`: a check is waiting for its batch or running on this commit. */
export type ReleaseState = "pending" | "covered" | "running";
export const CHECKED_AT_RELEASE = "Checked at release";
export function releaseStateOf(checks: Pick<ChecksFact, "status" | "level" | "release"> | null | undefined): ReleaseState | undefined {
  if (checks?.level !== "off" || checks.status === "passed" || checks.status === "failed") return undefined;
  return checks.release != null ? "covered" : "pending";
}
/** How the project check stands for requirements that rest on it, read now: `covered` once a check passed on this
 * commit (its own, a follow-up, or a release check containing it), `pending` while checks Off wait for a release. */
export function checkBackingOf(checks: Pick<ChecksFact, "status" | "level" | "release" | "running" | "batch"> | null | undefined): ReleaseState | undefined {
  return checks?.status === "passed" ? "covered" : checksUnderway(checks) ? "running" : releaseStateOf(checks);
}
/** What stands between a finished result and Complete (`completionBlockersOf`): each with the exact next step. */
export type CompletionBlocker = { key: "check-failed" | "check-missing" | "criteria" | "high"; message: string };
/** `waiting`: the result waits to be checked with others. Otherwise how its check ran: `together` on the
 * temporary batch commit `tested` with `peers`; `split` (its batch failed), `conflict` or `alone` on its own commit. */
export type ChecksBatch = { state: "waiting" | "together" | "split" | "conflict" | "alone"; tested: string | null; peers: string[] };

/** "T2", "T2 and T3", "T2, T3 and 2 more": short enough for one line. The full list is on the result. */
export function peerWords(peers: readonly string[], shown = 2): string {
  if (peers.length <= shown) return peers.length <= 1 ? peers.join("") : `${peers.slice(0, -1).join(", ")} and ${peers.at(-1)}`;
  return `${peers.slice(0, shown).join(", ")} and ${peers.length - shown} more`;
}
/** "Checked together with T2 on 1a2b3c4": every surface says a shared check the same way, naming the commit it tested. */
export function checkedTogetherWords(batch: ChecksBatch): string | null {
  const sha = short(batch.tested);
  return batch.state === "together" && batch.peers.length > 0 && sha !== null ? `Checked together with ${peerWords(batch.peers)} on ${sha}` : null;
}
const BATCH_WHY: Partial<Record<ChecksBatch["state"], string>> = {
  split: "Its batch check failed, so it was checked on its own.",
  conflict: "It conflicted with another result when merged for a batch check, so it was checked on its own.",
};
export type PullRequestFact = {
  state: "none" | "opening" | "open" | "merged" | "closed" | "failed";
  number: number | null; url: string | null; ci: "running" | "passing" | "failing" | null; error: string | null;
  /** GitHub's compare page for the pushed branch: where a person opens it by hand. */
  compareUrl?: string | null;
  /** Who merged it and its merge commit, shown on request. */
  note?: string | null;
};
export type TaskStatusFacts = {
  stage: TaskStage;
  /** Needs you: what a person is asked for (needs-you.ts). The sentence names it. */
  need?: NeedKey;
  /** Waiting: what the work waits for when no person can act. */
  wait?: WaitKey;
  /** The build or agent a need's sentence names. */
  needContext?: NeedContext;
  /** The recorded reason in plain words, when the stage has one. */
  reason?: string | null;
  /** A research report rather than a code change. */
  report?: boolean;
  checks?: ChecksFact | null;
  pullRequest?: PullRequestFact | null;
  /** `unverified`: the report is refuted, so no requirement counts as met however it was marked. `missed`: the ones it
   * failed or left unanswered. `atRelease`: checks Off, waiting for a release check. `unshown`: a required screenshot
   * is missing. `ask`: what a person is asked to look at first (a requirement they check, or a missing screenshot). */
  requirements?: { met: number; total: number; yours: number; missed?: number; unverified?: boolean; atRelease?: number; unshown?: number; ask?: string | null } | null;
  /** A person accepted this result's proof: their own check and a recorded exception need nothing more. */
  accepted?: boolean;
  /** What refuses Complete (`completionBlockersOf`); the first one is the sentence when it holds the result back. */
  blockers?: readonly CompletionBlocker[];
  evidence?: { shortened: number; missing: number; damaged: number } | null;
  completedBy?: string | null;
  action?: StatusAction | null;
  /** Where a row's one action leads: the result (and its Checks tab), the task's pull request, Run checks. */
  links?: { result?: string | null; checks?: string | null; pullRequest?: string | null; runChecks?: string | null };
  /** Exact technical reasons, shown only on request. */
  why?: readonly string[];
  /** The person's lead took this on (lead-voice.ts): "on-it" reads "<name> is on it" and needs nobody; "lapsed"
   * (two hours without a lead act) is back with the person, and says so. */
  lead?: "on-it" | "lapsed" | null;
  /** What the person calls their lead (Settings → Lead); "Lead" when unnamed. */
  leadName?: string;
};

const short = (sha: string | null): string | null => sha !== null && /^[a-f0-9]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;

/** A check waiting for its batch or running on this commit: the result reads Ready meanwhile, not Needs you. */
const checksUnderway = (checks: Pick<ChecksFact, "running" | "batch"> | null | undefined): boolean => checks?.batch?.state === "waiting" || checks?.running != null;
/** A finished result a person still has to act on before it can be complete: an unresolved HIGH finding or unmet
 * requirement, a missing check, or a requirement only they can confirm. Failed checks read Failed instead. */
function resultAsk(facts: Pick<TaskStatusFacts, "report" | "checks" | "requirements" | "accepted" | "blockers">): string | null {
  if (facts.report || facts.checks?.status === "failed") return null;
  const blocker = facts.blockers?.find(one => one.key !== "check-failed" && !(one.key === "check-missing" && checksUnderway(facts.checks)));
  if (blocker !== undefined) return blocker.message;
  const req = facts.requirements;
  if (req == null || facts.accepted === true || req.unverified === true) return null;
  if ((req.yours > 0 || (req.unshown ?? 0) > 0) && req.ask != null) return req.ask;
  return null;
}

export function headlineOf(facts: Pick<TaskStatusFacts, "stage" | "checks" | "report" | "requirements" | "accepted" | "blockers">): Headline {
  switch (facts.stage) {
    case "queued": return "Queued";
    case "planning": return "Planning";
    case "needs-you": return "Needs you";
    case "waiting": return "Waiting";
    case "building": case "checking": case "reviewing": return "Building";
    case "finished":
      if (facts.report) return "Ready for review";
      if (facts.checks?.status === "failed") return "Failed";
      // A requirement a person checks, a missing screenshot, an unmet requirement or a HIGH finding: Needs you, with the ask.
      if (resultAsk(facts) !== null) return "Needs you";
      // Off: ready like any build; the sentence and the Checks row say it is checked at release.
      return "Ready for review";
    case "complete": return "Complete";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
  }
}

function sentenceOf(headline: Headline, facts: TaskStatusFacts): string {
  const reason = facts.reason?.trim() || null;
  const sha = short(facts.checks?.head ?? null);
  switch (headline) {
    case "Queued": return reason ?? "Waiting for a worker.";
    case "Planning": return reason ?? "The lead is writing the plan.";
    // One plain sentence per need (needs-you.ts); a recorded reason only where the need keeps one.
    case "Needs you": return facts.stage === "finished" ? resultAsk(facts) ?? needSentence("review-result", reason, facts.needContext) : needSentence(facts.need ?? "other", reason, facts.needContext);
    case "Waiting": return waitSentence(facts.wait, reason, facts.needContext);
    case "Building": return facts.stage === "checking" ? "Checks are running on the change."
      : facts.stage === "reviewing" ? "Reviewing the change before it reaches you." : reason ?? "An agent is working on it.";
    case "Ready for review":
      if (facts.report) return "The report is ready to read. Read it, then mark it complete.";
      if (releaseStateOf(facts.checks) === "covered") return `Checked at release on ${short(facts.checks!.release!.head) ?? "its release"}. Review the change, then mark it complete.`;
      if (facts.checks?.level === "off" && facts.checks.status !== "passed") return "Checked at release. Review the change, then mark it complete.";
      if (facts.checks?.status === "passed") {
        // The Checks row names the others and the batch commit; the sentence doesn't repeat them.
        const peers = facts.checks.batch?.state === "together" ? facts.checks.batch.peers.length : 0;
        if (peers > 0) return `Checks passed together with ${peers === 1 ? "1 other result" : `${peers} other results`}. Review the change, then mark it complete.`;
        return `${facts.checks.level === "quick" ? "Quick checks" : "Checks"} passed${sha === null ? "" : ` on ${sha}`}. Review the change, then mark it complete.`;
      }
      if (facts.checks?.batch?.state === "waiting") return "Its full check runs with other results within 10 minutes. Review the change, then mark it complete.";
      // Never claim a check that isn't known to have passed.
      if (facts.checks == null) return "Review the change, then mark it complete.";
      return "Built without a passing project check. Review the change, then mark it complete.";
    case "Complete": {
      const by = facts.completedBy ? `Marked complete by ${facts.completedBy}.` : "Marked complete.";
      const pr = facts.pullRequest;
      return pr?.state === "merged" ? `${by} ${pr.number === null ? "Its pull request" : `Pull request #${pr.number}`} merged.` : by;
    }
    case "Failed":
      if (facts.checks?.status === "failed") return `${facts.checks.level === "quick" ? "Quick checks" : "Checks"} failed${sha === null ? "" : ` on ${sha}`}. See what broke, then retry or ask for changes.`;
      return reason ?? "The last attempt stopped before it finished. Review it, then retry.";
    case "Stopped": return reason ?? "Stopped by a person. The work so far is kept.";
  }
}

/** A detail problem: red only under Failed, otherwise an amber note. */
const problem = (headline: Headline): DetailMark => headline === "Failed" ? "failed" : "note";

function detailsOf(headline: Headline, facts: TaskStatusFacts): StatusDetail[] {
  const rows: StatusDetail[] = [];
  const row = (key: DetailKey, label: string, text: string, mark: DetailMark, extra: Partial<Pick<StatusDetail, "href" | "action" | "why">> = {}) =>
    rows.push({ key, label, text, mark, href: extra.href ?? null, action: extra.action ?? null, why: extra.why ?? null });
  const checks = facts.checks;
  if (checks != null && !facts.report) {
    const sha = short(checks.head);
    const checksHref = facts.links?.checks ?? facts.links?.result ?? null;
    const runChecks = facts.links?.runChecks === undefined ? null : { label: "Run checks", href: facts.links.runChecks };
    const quick = checks.level === "quick";
    const batch = checks.batch ?? null;
    const together = batch === null ? null : checkedTogetherWords(batch);
    const batchWhy = batch === null ? null : BATCH_WHY[batch.state] ?? null;
    if (batch?.state === "waiting") row("checks", CHECKS_LABEL, "Waiting to check with other results", "running", { href: checksHref });
    else if (checks.running != null) row("checks", CHECKS_LABEL, `${checks.running === "quick" ? "Quick" : "Full"} checks running`, "running", { href: checksHref });
    else if (checks.status === "passed" && together !== null) row("checks", CHECKS_LABEL, together, "ok", { href: checksHref });
    else if (checks.status === "passed" && batchWhy !== null) row("checks", CHECKS_LABEL, `Passed on its own${sha === null ? "" : ` on ${sha}`}`, "ok", { href: checksHref, why: batchWhy });
    else if (checks.status === "failed" && batchWhy !== null) row("checks", CHECKS_LABEL, `Failed on its own${checks.exitCode === null ? "" : ` (exit ${checks.exitCode})`}`, problem(headline),
      headline === "Failed" ? { href: checksHref, why: batchWhy } : { action: { label: "See what failed", href: checksHref }, why: batchWhy });
    else if (checks.status === "passed") row("checks", CHECKS_LABEL, `${quick ? "Quick checks passed" : "Passed"}${sha === null ? "" : ` on ${sha}`}`, "ok",
      quick && runChecks !== null && headline !== "Complete" ? { href: checksHref, action: { label: "Run full checks", href: runChecks.href } } : { href: checksHref });
    else if (checks.status === "failed") row("checks", CHECKS_LABEL, `${quick ? "Quick checks failed" : "Failed"}${checks.exitCode === null ? "" : ` (exit ${checks.exitCode})`}`, problem(headline),
      headline === "Failed" ? { href: checksHref } : { action: { label: "See what failed", href: checksHref } });
    else if (checks.status === "running") row("checks", CHECKS_LABEL, "Running", "running");
    else if (checks.level === "off" && checks.release != null) row("checks", CHECKS_LABEL, `Passed at release on ${short(checks.release.head) ?? `build #${checks.release.run}`}`, "ok", { href: checksHref });
    else if (checks.level === "off") row("checks", CHECKS_LABEL, CHECKED_AT_RELEASE, "none", runChecks === null ? {} : { action: runChecks });
    else if (checks.status === "not-run") row("checks", CHECKS_LABEL, "Didn't run", "none", runChecks === null ? {} : { action: runChecks });
    // A saved check that can't be read is run again where that is possible.
    else row("checks", CHECKS_LABEL, "Couldn't be read", "note", { action: runChecks ?? { label: OPEN_RESULT, href: facts.links?.result ?? null } });
  }
  const pr = facts.pullRequest;
  if (pr != null) {
    const name = pr.number === null ? "Pull request" : `#${pr.number}`;
    const github = pr.url !== null && /^https:\/\/github\.com\//.test(pr.url) ? pr.url : null;
    if (pr.state === "none") row("pull-request", "Pull request", "None", "none");
    else if (pr.state === "opening") row("pull-request", "Pull request", "Opening…", "running", { why: pr.error });
    else if (pr.state === "merged") row("pull-request", "Pull request", `${name} merged`, "ok", { href: github, why: pr.note ?? null });
    else if (pr.state === "closed") row("pull-request", "Pull request", `${name} closed without merging`, "none", { href: github });
    else if (pr.state === "failed") row("pull-request", "Pull request", "Couldn't open", "note",
      { action: pr.compareUrl ? { label: "Open it on GitHub", href: pr.compareUrl } : { label: "See why", href: facts.links?.pullRequest ?? null }, why: pr.error === null ? "Publishing gave up. The commit is safe locally." : `${pr.error} The commit is safe locally.` });
    else if (pr.ci === "running") row("pull-request", "Pull request", `${name} open · ${PR_CI_LABEL} running`, "running", { href: github });
    else if (pr.ci === "passing") row("pull-request", "Pull request", `${name} open · ${PR_CI_LABEL} passed`, "ok", { href: github });
    else if (pr.ci === "failing") row("pull-request", "Pull request", `${name} open · ${PR_CI_LABEL} failing`, "note", { action: { label: "Open it on GitHub", href: github } });
    else row("pull-request", "Pull request", `${name} open`, "none", { href: github });
  }
  const req = facts.requirements;
  // A failed result names how many it missed, refuted or not: that is what failed.
  if (req != null && req.total > 0 && headline === "Failed" && (req.missed ?? 0) > 0) row("requirements", "Requirements", `${req.missed} missed`, "failed");
  else if (req != null && req.total > 0 && req.unverified === true) row("requirements", "Requirements", "Unverified", "none");
  else if (req != null && req.total > 0) {
    const atRelease = req.atRelease ?? 0;
    const unmet = req.total - req.met - req.yours - atRelease;
    const text = `${req.met} of ${req.total} met${atRelease > 0 ? ` · ${atRelease} at release` : ""}${req.yours > 0 ? ` · You check ${req.yours}` : ""}`;
    row("requirements", "Requirements", text, unmet > 0 ? problem(headline) : req.met === req.total ? "ok" : "none",
      unmet > 0 && headline !== "Failed" ? { action: { label: "See which", href: facts.links?.checks ?? facts.links?.result ?? null } } : {});
  }
  const evidence = facts.evidence;
  if (evidence != null) {
    const action = { label: "See what was kept", href: facts.links?.result ?? null };
    if (evidence.damaged > 0) row("evidence", "Saved evidence", "Some saved files changed", problem(headline), headline === "Failed" ? {} : { action });
    else if (evidence.missing > 0) row("evidence", "Saved evidence", "Some saved files are missing", problem(headline), headline === "Failed" ? {} : { action });
    else if (evidence.shortened > 0) row("evidence", "Saved evidence", "Some output shortened", "note", { action });
    else row("evidence", "Saved evidence", "Complete", "ok");
  }
  return rows;
}

/** What the lead's claim says, in place of "waits for you" (lead-voice.ts). */
export const leadOnIt = (name: string = DEFAULT_LEAD_NAME): string => `${name} is on it.`;
export const leadLapsed = (name: string = DEFAULT_LEAD_NAME): string => `${name} hasn't acted on this for 2 hours, so it's back with you.`;
/** The headlines a lead's claim speaks for: the ones that would otherwise wait on a person. */
const LEAD_HEADLINES: ReadonlySet<Headline> = new Set(["Needs you", "Failed", "Ready for review", "Stopped"]);

function leadSentence(headline: Headline, facts: TaskStatusFacts): string {
  const sha = short(facts.checks?.head ?? null);
  // A failed check stays said: the claim changes who acts next, never the result.
  if (headline === "Failed" && facts.checks?.status === "failed") return `${facts.checks.level === "quick" ? "Quick checks" : "Checks"} failed${sha === null ? "" : ` on ${sha}`}. ${leadOnIt(facts.leadName)}`;
  return leadOnIt(facts.leadName);
}

/** The one status every surface shows (console list, task and result pages, CLI, chat, phone, `status`). */
export function statusOf(facts: TaskStatusFacts): TaskStatus {
  const read = headlineOf(facts);
  const lead = facts.lead != null && LEAD_HEADLINES.has(read) ? facts.lead : null;
  // The lead has it: nothing waits on the person, so a Needs you reads Waiting.
  const headline: Headline = lead === "on-it" && read === "Needs you" ? "Waiting" : read;
  // Every Needs you carries the one action that resolves it, worded the same everywhere; a finished result's is Open result.
  const needKey: NeedKey = facts.stage === "finished" ? "review-result" : facts.need ?? "other";
  const need = headline === "Needs you" ? { key: needKey, action: NEEDS[needKey].action } : null;
  const ownWords = need !== null && (need.key === "other" || need.key === "review-result") && facts.action != null;
  const primaryAction = need === null || ownWords ? facts.action ?? null : { label: need.action.label, href: facts.action?.href ?? null };
  const sentence = lead === "on-it" ? leadSentence(headline, facts) : lead === "lapsed" ? `${leadLapsed(facts.leadName)} ${sentenceOf(headline, facts)}` : sentenceOf(headline, facts);
  return { headline, tone: HEADLINE_TONE[headline], sentence, details: detailsOf(headline, facts),
    primaryAction, why: [...new Set(facts.why ?? [])].filter(one => one.trim() !== ""), need };
}

/** The name most surfaces already import. */
export const taskStatusOf = statusOf;

// ---- reading the existing projections ----------------------------------------

/** Every dispatch or work-index code, as the stage it means. Unknown codes that
 * wait on a person stay Needs you; everything else waits in the queue. */
const CODE_STAGE: Readonly<Record<string, [TaskStage, TaskStatusFacts["need"]?]>> = {
  queued: ["queued"], ready: ["queued"], "worker-at-capacity": ["queued"], "retry-scheduled": ["queued"], updating: ["queued"],
  "waiting-dependency": ["queued"], "scouting-ready": ["queued"], "planning-ready": ["queued"], "provider-quota": ["queued"], "planner-source": ["queued"],
  running: ["building"], reviewing: ["reviewing"], "review-pending": ["building"],
  "signed-out": ["needs-you", "sign-in"],
  "needs-approval": ["needs-you", "approval"],
  "waiting-decision": ["needs-you", "answer"], "decision-queue": ["needs-you", "answer"],
  "build-stopping": ["waiting"], "other-computer": ["waiting"],
  stopping: ["stopped"], stopped: ["stopped"], paused: ["stopped"], cancelled: ["stopped"],
  failed: ["failed"], "waiting-incident": ["failed"], "checks-failed": ["failed"],
  "ready-to-check": ["finished"], "ready-to-review": ["finished"], "report-ready": ["finished"], "no-change": ["finished"],
  "pr-opened": ["finished"], "merge-observed": ["finished"], "pr-closed": ["finished"], "agent-attested": ["finished"], "accepted-exception": ["finished"],
  complete: ["complete"],
};

/** Queue reasons worth a sentence of their own; any other queued or
 * building reason is scheduler wording, and the default sentence is plainer. */
const QUEUED_REASONS = new Set(["worker-at-capacity", "waiting-dependency", "retry-scheduled", "updating", "planning-ready", "scouting-ready", "provider-quota"]);
export function plainReasonOf(stage: TaskStage, code: string, detail: string | null | undefined): string | null {
  if (stage === "building" || stage === "checking" || stage === "reviewing" || stage === "planning") return null;
  if (stage === "queued") return QUEUED_REASONS.has(code) ? detail ?? null : null;
  return detail ?? null;
}

export function stageOfCode(code: string, options: { needsPerson?: boolean; planning?: boolean; operatorHold?: boolean } = {}): { stage: TaskStage; need?: TaskStatusFacts["need"] } {
  if (code === "running" && options.planning) return { stage: "planning" };
  if (code === "held") return options.operatorHold === false ? { stage: "needs-you", need: "hold" } : { stage: "stopped" };
  const known = CODE_STAGE[code];
  if (known !== undefined) return known[1] === undefined ? { stage: known[0] } : { stage: known[0], need: known[1] };
  return options.needsPerson === false ? { stage: "queued" } : { stage: "needs-you", need: CODE_NEED[code] ?? "other" };
}

/** The pull request as the task page's follower reports it, or the bare publication row. */
export function pullRequestFactOf(publication: { state: string; prNumber?: number | null; prUrl: string | null; remoteState: string | null; lastCheckState?: string | null; lastError?: string | null; merged?: boolean;
  githubRepo?: string; base?: string; head?: string } | null): PullRequestFact | null {
  if (publication === null) return null;
  const safe = (part: string | undefined) => part !== undefined && /^[A-Za-z0-9_.\/-]+$/.test(part) && !part.includes("..") ? part : null;
  const repo = safe(publication.githubRepo), from = safe(publication.base), to = safe(publication.head);
  const compareUrl = repo !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && from !== null && to !== null ? `https://github.com/${repo}/compare/${from}...${to}?expand=1` : null;
  const seen = publication.lastCheckState;
  const ci: PullRequestFact["ci"] = seen === "running" || seen === "passing" || seen === "failing" ? seen : null;
  const fromUrl = /\/pull\/(\d+)$/.exec(publication.prUrl ?? "");
  const number = publication.prNumber ?? (fromUrl === null ? null : Number(fromUrl[1]));
  const base = { number, url: publication.prUrl, ci, error: publication.lastError ?? null, compareUrl };
  if (publication.merged === true || publication.remoteState === "MERGED") return { ...base, state: "merged" };
  if (publication.remoteState === "CLOSED") return { ...base, state: "closed" };
  if (publication.state === "failed") return { ...base, state: "failed" };
  if (publication.state === "opened") return { ...base, state: "open" };
  return { ...base, state: "opening" };
}

/** The assignment's stage. The work status, when the caller read one, names
 * the exact reason (a running planner, a pause, a failed attempt, a sign-in). */
export function assignmentStageOf(assignment: Pick<AssignmentSnapshot, "state" | "primaryAction"> & { review?: AssignmentSnapshot["review"]; need?: AssignmentSnapshot["need"] }, work?: { token: string; views?: readonly string[] } | null, planning = false): { stage: TaskStage; need?: TaskStatusFacts["need"]; wait?: WaitKey } {
  // The assignment's own reading (a build Toolroll can't confirm stopped) comes first.
  const own = assignment.need ?? null;
  if (own !== null && (assignment.state === "working" || assignment.state === "needs-decision")) return "wait" in own ? { stage: "waiting", wait: own.wait } : { stage: "needs-you", need: own.key };
  switch (assignment.state) {
    case "cancelled": return { stage: "stopped" };
    case "complete": return { stage: "complete" };
    case "ready-to-check": return { stage: "finished" };
    case "checking": return { stage: assignment.review?.state === "pending" ? "reviewing" : "checking" };
    case "working": {
      const token = work?.token ?? "running";
      const read = stageOfCode(token, { needsPerson: work?.views?.includes("needs-you") ?? false, planning });
      return read.stage === "finished" || read.stage === "complete" ? { stage: "building" } : read;
    }
    case "needs-decision": {
      const action = assignment.primaryAction?.code;
      if (action === "approve-scope") return { stage: "needs-you", need: "approval" };
      if (action === "answer-decision") return { stage: "needs-you", need: "answer" };
      if (action === "inspect-decisions") return { stage: "needs-you", need: "questions" };
      const token = work?.token ?? "";
      // A failed attempt is Failed. A saved result that still needs a decision
      // (its scope, a hold, a process exit) is Needs you, even if its checks
      // failed: the decision is the next step, and the Checks row says the rest.
      if (token === "failed" || token === "waiting-incident") return { stage: "failed" };
      const read = stageOfCode(token, { needsPerson: true, operatorHold: action === "unhold" });
      if (read.stage === "stopped" || read.stage === "waiting") return read;
      // A saved result that isn't ready keeps its own reading; a task's dispatch reason names its need.
      return { stage: "needs-you", need: read.need ?? "other" };
    }
  }
}

type RequirementRow = { id?: string; statement?: string; state: string; requiredEvidence?: readonly string[]; answered?: readonly { kind: string }[];
  assessment?: { evidenceState?: string } | undefined; review?: unknown };
/** Evidence that passed and only awaits the retired assessment step is met. */
const requirementMet = (row: RequirementRow): boolean => row.state === "pass" || (row.assessment?.evidenceState === "pass" && (row.review ?? null) === null);
/** A requirement whose only gap is the project check: every other kind it needs was shown, none is a person's check. */
const onlyCheckMissing = (row: RequirementRow): boolean => {
  const needs = row.requiredEvidence ?? [];
  const answered = new Set((row.answered ?? []).map(one => one.kind));
  return row.state !== "failed" && needs.includes("check") && !needs.includes("manual-review") &&
    needs.every(kind => kind === "check" || answered.has(kind));
};
/** A required screenshot nobody captured. */
const screenshotMissing = (row: RequirementRow): boolean =>
  (row.requiredEvidence ?? []).includes("screenshot") && !(row.answered ?? []).some(one => one.kind === "screenshot");
/** One requirement's state in words: the card's Requirements row and the Checks tab read this one source, so they
 * can't disagree. A refuted report verifies none of its requirements, so each reads Unverified, as the card does.
 * With checks Off, a requirement that waits only on the check reads Checked at release, then Met once a passing full
 * release check contains the commit. */
export type RequirementWord = "Met" | "You check" | "Not shown yet" | "Checked at release" | "Waiting for checks" | "Not met" | "Unverified";
export function requirementWordOf(row: RequirementRow, verdict?: string | null, release?: ReleaseState): RequirementWord {
  if (verdict === "refuted") return "Unverified";
  if (requirementMet(row)) return "Met";
  if (release !== undefined && onlyCheckMissing(row)) return release === "covered" ? "Met" : release === "running" ? "Waiting for checks" : CHECKED_AT_RELEASE;
  if (row.state === "manual-review") return "You check";
  return row.state === "missing" || screenshotMissing(row) ? "Not shown yet" : "Not met";
}

const ASK_STATEMENT = 140;
const quoted = (statement: string | undefined): string => {
  const one = (statement ?? "").replace(/\s+/g, " ").trim();
  return one.length > ASK_STATEMENT ? `${one.slice(0, ASK_STATEMENT - 1)}…` : one;
};
/** The ask for one unresolved requirement: what is wrong with it, and the two ways on. */
function unresolvedAsk(row: RequirementRow, word: RequirementWord): string {
  const what = word === "Not shown yet" && screenshotMissing(row) ? "A screenshot is missing for"
    : word === "Not shown yet" ? "Nothing shows this requirement is met" : word === "Unverified" ? "This requirement couldn't be verified" : "This requirement isn't met";
  return `${what}: ${quoted(row.statement) || row.id || "a requirement"}. Ask for changes, or accept the result with a reason.`;
}
/** Requirements from the stored matrix: met, the ones only a person confirms, and the total. */
export function requirementsOf(matrix: readonly RequirementRow[] | null | undefined, release?: ReleaseState): NonNullable<TaskStatusFacts["requirements"]> | null {
  if (!matrix || matrix.length === 0) return null;
  const words = matrix.map(row => requirementWordOf(row, null, release));
  const yours = matrix.find((_, index) => words[index] === "You check");
  const unshown = matrix.filter((row, index) => words[index] === "Not shown yet" && screenshotMissing(row));
  const ask = yours !== undefined ? `Check this requirement yourself, then mark it complete: ${quoted(yours.statement)}`
    : unshown.length > 0 ? unresolvedAsk(unshown[0]!, "Not shown yet") : null;
  return { met: words.filter(word => word === "Met").length, total: matrix.length, yours: words.filter(word => word === "You check").length,
    missed: words.filter(word => word === "Not met" || word === "Not shown yet").length,
    ...(release !== "pending" ? {} : { atRelease: words.filter(word => word === CHECKED_AT_RELEASE).length }),
    ...(unshown.length === 0 ? {} : { unshown: unshown.length }),
    ...(ask === null ? {} : { ask }) };
}

/** What refuses Complete, for `task complete`, the console and chat completion and deploy-candidate alike: a failed
 * check; a required check that is missing (checks deliberately Off are not missing: they are checked at release);
 * an unresolved requirement (a person's own check is theirs to give by completing; a recorded acceptance resolves
 * the rest); an unresolved HIGH review finding. A release check that covers the commit counts as passed. */
export function completionBlockersOf(f: {
  report: boolean; checks: Pick<ChecksFact, "status" | "exitCode" | "level" | "release" | "running" | "batch"> | null; checkRequired: boolean;
  matrix: readonly RequirementRow[] | null | undefined; verdict: string | null | undefined; accepted: boolean; high: number;
}): CompletionBlocker[] {
  const blockers: CompletionBlocker[] = [];
  const release = releaseStateOf(f.checks);
  const backing = checkBackingOf(f.checks);
  if (!f.report && f.checks?.status === "failed") {
    blockers.push({ key: "check-failed", message: `Checks failed${f.checks.exitCode === null ? "" : ` (exit ${f.checks.exitCode})`}. Fix them and run checks again, or ask for changes.` });
  } else if (!f.report && f.checkRequired && f.checks?.status !== "passed" && release === undefined) {
    blockers.push({ key: "check-missing", message: checksUnderway(f.checks) ? "Its project check hasn't finished yet. Mark it complete once it passes."
      : "No passing project check is recorded for this result. Run checks on it, then mark it complete." });
  }
  if (!f.accepted && f.checks?.status !== "failed") {
    const refuted = f.verdict === "refuted";
    const unresolved = (f.matrix ?? []).map(row => ({ row, word: requirementWordOf(row, refuted ? "refuted" : null, backing) }))
      .filter(one => one.word === "Not met" || one.word === "Not shown yet" || one.word === "Unverified");
    if (unresolved.length === 1) blockers.push({ key: "criteria", message: unresolvedAsk(unresolved[0]!.row, unresolved[0]!.word) });
    else if (unresolved.length > 1) {
      const ids = unresolved.map(one => one.row.id ?? "?");
      blockers.push({ key: "criteria", message: `${unresolved.length} requirements ${unresolved.every(one => one.word === "Unverified") ? "couldn't be verified" : "aren't met yet"} (${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", …" : ""}). Ask for changes, or accept the result with a reason.` });
    }
  }
  if (f.high > 0) blockers.push({ key: "high", message: `The automatic review found ${f.high === 1 ? "a high-severity problem" : `${f.high} high-severity problems`}. Ask for changes before marking it complete.` });
  return blockers;
}

/** A refuted report verifies none of its requirements, whatever it marked met (a person's acceptance doesn't change that). */
export function unverifiedWhenRefuted(requirements: NonNullable<TaskStatusFacts["requirements"]> | null, verdict: string | null | undefined): NonNullable<TaskStatusFacts["requirements"]> | null {
  return requirements === null || verdict !== "refuted" ? requirements : { ...requirements, unverified: true };
}

/** Saved evidence health from the receipt's artifact list and its caveats. */
export function evidenceOf(receipt: AssignmentSnapshot["receipt"], problems: readonly string[] = receipt?.caveats ?? []): NonNullable<TaskStatusFacts["evidence"]> | null {
  if (receipt === null) return null;
  const shortened = receipt.artifacts.filter(one => !one.complete).length + problems.filter(one => /shortened|cut short/.test(one)).length;
  const damaged = problems.filter(one => /unavailable or changed|no longer verif|cannot be read|could not be read|failed capture|altered|damaged/i.test(one)).length;
  const missing = problems.filter(one => /missing|ambiguous|no longer exists/i.test(one) && !/unavailable or changed/.test(one)).length;
  return { shortened, missing, damaged };
}

/** The status facts of one assignment, as every surface reads them. */
export function assignmentStatusFacts(assignment: AssignmentSnapshot, options: {
  work?: { token: string; views?: readonly string[]; detail?: string } | null; planning?: boolean;
  pullRequest?: PullRequestFact | null; action?: StatusAction | null; links?: TaskStatusFacts["links"];
  evidence?: TaskStatusFacts["evidence"]; why?: readonly string[];
} = {}): TaskStatusFacts {
  const { stage, need, wait } = assignmentStageOf(assignment, options.work ?? null, options.planning ?? false);
  const build = assignment.need?.build ?? null;
  const receipt = assignment.receipt;
  const finished = stage === "finished" || stage === "complete";
  // A saved result's rows show whenever it is the reason a person is needed, too.
  const withResult = finished || stage === "failed" || ((stage === "needs-you" || stage === "waiting") && receipt !== null);
  const report = receipt?.completionKind === "research-report";
  const checks: ChecksFact | null = receipt === null || !withResult ? null
    : { status: receipt.checks.status, exitCode: receipt.checks.exitCode, head: receipt.head,
      ...(receipt.checks.level == null ? {} : { level: receipt.checks.level }), ...(receipt.checks.running == null ? {} : { running: receipt.checks.running }),
      ...(receipt.checks.batch == null ? {} : { batch: receipt.checks.batch }), ...(receipt.checks.release == null ? {} : { release: receipt.checks.release }) };
  const publication = assignment.publication;
  const pullRequest = options.pullRequest !== undefined ? options.pullRequest
    : publication === null ? (withResult && !report ? { state: "none" as const, number: null, url: null, ci: null, error: null } : null)
    : pullRequestFactOf(publication);
  // Ready, Complete and Failed speak for themselves; every other stage keeps its recorded reason.
  const reason = stage === "needs-you" || stage === "waiting" || stage === "stopped" || stage === "queued" || (stage === "failed" && checks?.status !== "failed")
    ? stage === "stopped" && assignment.state === "cancelled" ? REPLACED.test(assignment.detail) ? assignment.detail : "Cancelled. Nothing else will run." : plainReasonOf(stage, options.work?.token ?? "", options.work?.detail ?? assignment.detail)
    : null;
  return {
    stage, ...(need === undefined ? {} : { need }), ...(wait === undefined ? {} : { wait }), ...(build === null ? {} : { needContext: { build } }), reason, report,
    checks,
    pullRequest: withResult ? pullRequest : null,
    requirements: withResult ? unverifiedWhenRefuted(requirementsOf(receipt?.proof?.matrix, checkBackingOf(checks)), assignment.readiness?.verdict ?? receipt?.proof?.verdict) : null,
    ...(withResult && receipt?.proofAcceptance != null ? { accepted: true } : {}),
    ...(withResult && (assignment.readiness?.blockers.length ?? 0) > 0 ? { blockers: assignment.readiness!.blockers } : {}),
    evidence: withResult ? options.evidence ?? evidenceOf(receipt, [...(receipt?.caveats ?? []), ...assignment.attention]) : null,
    completedBy: assignment.completion === null ? null : assignment.completion.lead === true ? "the lead" : assignment.completion.actor.replace(/^(?:operator|coordinator|lead):/, ""),
    action: options.action ?? null,
    ...(options.links === undefined ? {} : { links: options.links }),
    why: options.why ?? [],
    ...(assignment.lead == null ? {} : { lead: assignment.lead.state }),
  };
}

// ---- rendering helpers shared by the server pages and chat cards ------------

/** The legacy work tone each headline wears where a surface still keys off StatusTone. */
export function workToneOf(headline: Headline): "attention" | "problem" | "live" | "ready" | "done" | "muted" {
  switch (headline) {
    case "Needs you": return "attention";
    case "Failed": return "problem";
    case "Building": case "Planning": return "live";
    case "Ready for review": return "ready";
    case "Complete": return "done";
    default: return "muted";
  }
}

/** One plain-text line per detail for chat cards: an icon, the label, the words. */
export function statusDetailLines(status: TaskStatus): string[] {
  const icon: Record<DetailMark, string> = { ok: "✓", running: "●", none: "○", note: "⚠", failed: "✕" };
  return status.details.map(one => `${icon[one.mark]} ${one.label} · ${one.text}${one.action === null ? "" : ` — ${one.action.label}`}`);
}

/** The headline's emoji for chat cards (colour is never the only signal: the words follow). */
export function headlineEmoji(headline: Headline): string {
  return ({ Queued: "🕓", Planning: "📝", "Needs you": "👋", Waiting: "⏸", Building: "⏳", "Ready for review": "✅", Complete: "✅", Failed: "❌", Stopped: "⏹" } as const)[headline];
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const ICON_PATHS: Record<DetailMark, string> = {
  ok: `<path d="M20 6 9 17l-5-5"/>`,
  running: `<circle cx="12" cy="12" r="4"/>`,
  none: `<circle cx="12" cy="12" r="3"/>`,
  note: `<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
  failed: `<path d="M18 6 6 18M6 6l12 12"/>`,
};
export const statusIconSvg = (mark: DetailMark): string =>
  `<svg class="status-icon status-icon--${mark}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[mark]}</svg>`;

/** The detail rows as server HTML: quiet rows, colour only on the icon. */
export function statusDetailsHtml(status: TaskStatus): string {
  if (status.details.length === 0) return "";
  return `<ul class="status-details" aria-label="Status">` + status.details.map(one => {
    const text = one.href === null ? escapeHtml(one.text) : `<a href="${escapeHtml(one.href)}">${escapeHtml(one.text)}</a>`;
    const action = one.action === null ? "" : one.action.href === null ? `<span class="status-detail-act">${escapeHtml(one.action.label)}</span>` : `<a class="status-detail-act" href="${escapeHtml(one.action.href)}">${escapeHtml(one.action.label)}</a>`;
    return `<li class="status-detail status-detail--${one.mark}" data-status-detail="${one.key}" data-mark="${one.mark}">${statusIconSvg(one.mark)}<span class="status-detail-label">${escapeHtml(one.label)}</span><span class="status-detail-text"><span>${text}</span>${action}</span></li>`;
  }).join("") + `</ul>`;
}

/** The status card's fold of exact reasons: "More", never a third thing called Details. */
export const STATUS_MORE = "More";
/** The technical reasons, one tap away. */
export function statusWhyHtml(status: TaskStatus, extra: readonly string[] = [], diagnostics: readonly { token: string; label: string; detail: string }[] = []): string {
  const lines = [...new Set([...status.details.flatMap(one => one.why === null ? [] : [`${one.label}: ${one.why}`]), ...status.why, ...extra])];
  if (lines.length === 0 && diagnostics.length === 0) return "";
  return `<details class="status-why"><summary>${STATUS_MORE}</summary>${lines.map(one => `<p class="meta">${escapeHtml(one)}</p>`).join("")}` +
    diagnostics.map(one => `<p class="meta" data-work-diagnostic="${escapeHtml(one.token)}">${escapeHtml(one.label)} · ${escapeHtml(one.detail)}</p>`).join("") + `</details>`;
}

/** Shared CSS for the server-rendered status: neutral rows, coloured icons. */
export const TASK_STATUS_CSS = `.status-headline{display:flex;align-items:center;gap:.6rem;margin:0;font-size:1.125rem;font-weight:600;color:var(--foreground)}.status-headline i{width:.625rem;height:.625rem;border-radius:999px;flex-shrink:0;background:var(--muted-foreground)}[data-headline-tone=live] .status-headline i{background:var(--so-info,#0d74ce)}[data-headline-tone=attention] .status-headline i{background:var(--so-attention,var(--attention))}[data-headline-tone=ready] .status-headline i{background:transparent;box-shadow:inset 0 0 0 2px var(--so-success,#218358)}[data-headline-tone=success] .status-headline i{background:var(--so-success,#218358)}[data-headline-tone=danger] .status-headline i{background:var(--so-danger,#c4320a)}.status-sentence{margin:.35rem 0 0;color:var(--muted-foreground)}.status-details{list-style:none;margin:.75rem 0 0;padding:.25rem 0 0;border-top:1px solid var(--so-line,var(--border))}.status-detail{display:grid;grid-template-columns:14px 7.5rem minmax(0,1fr);align-items:center;gap:.6rem;padding:.4rem 0;font-size:.8125rem;color:var(--foreground)}.status-detail .status-icon{align-self:center;color:var(--muted-foreground)}.status-detail--ok .status-icon{color:var(--so-success,#218358)}.status-detail--running .status-icon{color:var(--so-info,#0d74ce)}.status-detail--note .status-icon{color:var(--so-warning,#ab6400)}.status-detail--failed .status-icon{color:var(--so-danger,#c4320a)}.status-detail-label{color:var(--muted-foreground)}.status-detail-text{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .6rem;min-width:0;overflow-wrap:anywhere}.status-detail-text a{color:inherit}.status-detail-act{font-weight:600;white-space:nowrap}.status-detail--note .status-detail-act{color:var(--so-warning,#ab6400)}@media(max-width:480px){.status-detail{grid-template-columns:14px 6.5rem minmax(0,1fr);min-height:2.75rem;padding:.25rem 0}.status-detail-text a{display:inline-block;padding:.75rem 0;margin:-.75rem 0}}.status-why{border:0;padding:0;margin:.25rem 0 0;background:transparent;box-shadow:none}.status-why>summary{cursor:pointer;min-height:2.75rem;display:list-item;align-content:center;font-size:.8125rem;color:var(--muted-foreground)}.status-why p{margin:.25rem 0 .5rem}.receipt-note{display:flex;align-items:center;gap:.45rem;font-size:.8125rem;color:var(--foreground)}.receipt-note .status-icon{color:var(--so-warning,#ab6400)}`;

/** A dispatch diagnosis as its stage, for the phone and CLI reads that hold
 * no assignment. A done task is Complete once a person marked its result;
 * a refuted result whose project check failed is Failed. */
export function stageOfDispatch(d: { code: string; condition: string; action: string | null; role?: string | null; detail?: string },
  options: { completed?: boolean } = {}): { stage: TaskStage; need?: TaskStatusFacts["need"] } {
  if (d.code === "reviewing") return { stage: "reviewing" };
  if (d.code === "complete" || d.code.startsWith("review-")) return { stage: options.completed ? "complete" : "finished" };
  if (d.code === "proof-refuted") return /approved check failed|checks failed/i.test(d.detail ?? "") ? { stage: "failed" } : { stage: "needs-you", need: "review-result" };
  if (d.code === "needs-verification") return { stage: "needs-you", need: "review-result" };
  return stageOfCode(d.code, { needsPerson: d.condition === "waiting" && d.action !== null, planning: d.condition === "running" && d.role === "planner", operatorHold: d.action === "unhold" });
}

/** The demo runs no checks: a Checks row that would offer to run one (or open one that never ran) says so instead. */
export const DEMO_CHECKS = "Can't run in the demo";
export function demoChecksOf(status: TaskStatus): TaskStatus {
  return { ...status, details: status.details.map(one => one.key !== "checks" || one.mark === "ok" || one.mark === "failed" || one.mark === "running" ? one
    : { ...one, text: DEMO_CHECKS, mark: "none", href: null, action: null, why: null }) };
}
