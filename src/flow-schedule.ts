/**
 * Schedules (v115: flow-owned; routines became scheduled flows).
 *
 * A schedule trigger fires on one of four readable cadences. Its two failure modes are subtle enough to deserve
 * names: advancing one interval after downtime leaves the next firing in the past — a catch-up burst; advancing to
 * `now + interval` drifts the cadence forever. The rule is ALIGNED advancement: the next occurrence strictly after
 * now, anchored to the occurrence that just fired (for `every`) or to the clock itself (for calendar schedules).
 * Missed slots while nothing was running fire ONCE — the overdue occurrence — and are never backfilled.
 */

import { createHash } from "node:crypto";
import type { StandingOrder } from "./contracts/flow.js";
import { fileTaskProposal } from "./proposal.js";
import { reportsCost } from "./provider.js";
import { legOf, routeDigestOf, routeFromJson, routeProblems, type PhaseRoute } from "./phase-routing.js";
import { canonicalAcceptance, digestOf, parseAcceptanceCriteria, profileDigestOf, profileFromJson, type AcceptanceCriterion, type ExecutionProfile } from "./scope.js";
import { hasDisguisedText, hasForbiddenControls } from "./decision.js";
import { BUILT_IN, parseCapabilityKey, type Store } from "./store.js";

export type { StandingOrder };

export type Schedule =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; hhmm: string; timezone?: string }
  /** v96: Monday to Friday. */
  | { kind: "weekdays"; hhmm: string; timezone?: string }
  | { kind: "weekly"; day: number; hhmm: string; timezone?: string };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function validTimezone(value: string): boolean {
  if (value.trim() !== value) return false;
  if (!/^[A-Za-z0-9_+/-]{1,80}$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

/** Bounds a person would pick on purpose: 5 minutes to 7 days. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;

/**
 * Existing daily schedules remain UTC. Calendar schedules may name an IANA
 * timezone, whose wall-clock time stays fixed across daylight saving changes.
 * No cron expressions in v1 — a schedule the operator cannot read at a
 * glance is a schedule they cannot honestly approve.
 */
export function parseSchedule(text: string): Schedule | null {
  if (text.trim() !== text) return null;
  const every = /^every:([0-9]{1,5})$/.exec(text);
  if (every !== null) {
    const minutes = Number(every[1]);
    if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) return null;
    return { kind: "every", minutes };
  }
  const calendar = /^(daily|weekdays|weekly:[0-6]):([01][0-9]|2[0-3]):([0-5][0-9])(?:@([A-Za-z0-9_+/-]{1,80}))?$/.exec(text);
  if (calendar !== null) {
    const timezone = calendar[4];
    if (timezone !== undefined && !validTimezone(timezone)) return null;
    const time = { hhmm: `${calendar[2]}:${calendar[3]}`, ...(timezone === undefined ? {} : { timezone }) };
    return calendar[1] === "daily" ? { kind: "daily", ...time } : calendar[1] === "weekdays" ? { kind: "weekdays", ...time } : { kind: "weekly", day: Number(calendar[1]!.slice(-1)), ...time };
  }
  return null;
}

export function scheduleText(schedule: Schedule): string {
  return schedule.kind === "every" ? `every:${schedule.minutes}` : `${schedule.kind === "weekly" ? `weekly:${schedule.day}` : schedule.kind}:${schedule.hhmm}${schedule.timezone === undefined ? "" : `@${schedule.timezone}`}`;
}

/** The schedule, in words an operator agrees to. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind !== "every") return `${schedule.kind === "daily" ? "daily" : schedule.kind === "weekdays" ? "weekdays" : `every ${WEEKDAYS[schedule.day]}`} at ${schedule.hhmm} ${schedule.timezone ?? "UTC"}`;
  const { minutes } = schedule;
  if (minutes % (24 * 60) === 0) return `every ${minutes / (24 * 60)} day(s)`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hour(s)`;
  return `every ${minutes} minutes`;
}

/**
 * The first occurrence after approval: the schedule starts counting from the
 * yes, because "approved at 14:07, every 60 minutes" firing instantly would
 * spend before the approver's hand left the keyboard.
 */
export function firstFireAt(schedule: Schedule, now: Date): string {
  if (schedule.kind === "every") {
    return new Date(now.getTime() + schedule.minutes * 60_000).toISOString();
  }
  return nextCalendar(schedule, now);
}

/**
 * Aligned advancement: the smallest cadence occurrence STRICTLY after now.
 * `anchor` is the occurrence that just fired (or was just skipped) — the
 * cadence grid grows from it, so a pass that ran late does not tilt every
 * later firing by its lateness.
 */
export function nextFireAt(schedule: Schedule, anchorIso: string, now: Date): string {
  if (schedule.kind !== "every") return nextCalendar(schedule, now);
  const interval = schedule.minutes * 60_000;
  const anchor = new Date(anchorIso).getTime();
  const elapsed = now.getTime() - anchor;
  // Strictly after now: an occurrence landing exactly on now already fired.
  const steps = Math.max(1, Math.floor(elapsed / interval) + 1);
  return new Date(anchor + steps * interval).toISOString();
}

function nextCalendar(schedule: Exclude<Schedule, { kind: "every" }>, now: Date): string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Represent wall-clock components as a UTC number solely for arithmetic.
  const wall = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const localNow = new Date(wall(now.getTime()));
  const [hour, minute] = schedule.hhmm.split(":").map(Number);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute);
  for (let days = 0; days <= 15; days++) {
    const target = today + days * 86_400_000;
    if (schedule.kind === "weekly" && new Date(target).getUTCDay() !== schedule.day) continue;
    if (schedule.kind === "weekdays" && (new Date(target).getUTCDay() === 0 || new Date(target).getUTCDay() === 6)) continue;
    // Nearby dates expose both offsets around a daylight-saving transition.
    // A missing clock time skips its slot. An ambiguous time uses the first
    // occurrence only, even if the scheduler advances during the repeated hour.
    const offsets = [...new Set([-36, 0, 36].map(hours => { const sample = target + hours * 3_600_000; return wall(sample) - sample; }))];
    const matches = offsets.map(offset => target - offset).filter(instant => wall(instant) === target);
    if (matches.length > 0) {
      const first = Math.min(...matches);
      if (first > now.getTime()) return new Date(first).toISOString();
    }
  }
  throw new Error("No calendar occurrence within the next fifteen days");
}

// ------------------------------------------------------------------ standing orders

/** The rolling window a standing order's cost ceiling counts over: seven days, and every surface says so. */
export const BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A firing's task id: the order's stem stamped with its slot (`nightly-deps-20261008-0700`). */
export function instanceId(stem: string, slotIso: string): string {
  return `${stem}-${slotIso.replace(/[-:]/g, "").slice(0, 13).replace("T", "-")}`;
}

/**
 * The exact standing order an approver agreed to, as 128 bits — byte for byte what a routine's digest was, so a
 * routine's approval moved onto a scheduled flow (v115) still verifies: the project, the terms, the schedule, the
 * ceiling, and the agents the approval froze. Editing any of them (or moving the flow) strands the approval.
 */
export function standingDigestOf(repo: string, schedule: string, order: StandingOrder, acceptance: readonly AcceptanceCriterion[], profile: ExecutionProfile, route: PhaseRoute): string {
  return createHash("sha256").update(JSON.stringify({
    repo,
    goal: order.goal.trim(),
    outOfScope: order.outOfScope?.trim() ?? null,
    touches: [...order.touches].sort(),
    ...(acceptance.length === 0 ? {} : { acceptance: canonicalAcceptance(acceptance) }),
    requirements: [...order.requirements].sort(),
    schedule,
    singleFlight: order.singleFlight,
    costCeilingUsd: order.costCeilingUsd,
    ...(order.budgetPerRunMicrousd == null ? {} : { budgetPerRun: order.budgetPerRunMicrousd }),
    profileDigest: profileDigestOf(profile),
    route: routeDigestOf(route),
  }), "utf8").digest("hex").slice(0, 32);
}

export type StandingApproval =
  | { live: true; by: string | null; profile: ExecutionProfile; route: PhaseRoute; acceptance: AcceptanceCriterion[] }
  | { live: false; problem: string | null; acceptance: AcceptanceCriterion[] | null };

/**
 * Whether a standing order's carried approval still stands, read whole before anything is written: the frozen agents
 * read back, re-hash with the order's terms, this schedule and project to the digest the approver signed, state no
 * problem, and build and repair on the approved profile's own agents. `problem` is null when there is no approval.
 */
export function standingApproval(order: StandingOrder, repo: string, schedule: string): StandingApproval {
  const read = parseAcceptanceCriteria(order.acceptance);
  const acceptance = read.problems.length === 0 && read.criteria.length > 0 ? read.criteria : null;
  if (order.approval === null) return { live: false, problem: null, acceptance };
  const refused = (problem: string): StandingApproval => ({ live: false, problem, acceptance });
  if (acceptance === null) return refused("its success checks can't be read");
  const profile = profileFromJson(order.approval.profileJson), route = routeFromJson(order.approval.routeJson);
  if (profile === null || route === null) return refused("the agents its approval froze can't be read back");
  if (standingDigestOf(repo, schedule, order, acceptance, profile, route) !== order.approval.digest) return refused("it changed after it was approved");
  const problems = routeProblems(route);
  if (problems.length > 0) return refused(problems.join("; "));
  const build = legOf(route, "build"), repair = legOf(route, "repair");
  const repairModel = profile.repairModel === "inherit" ? profile.model : profile.repairModel;
  if (build.provider !== profile.provider || build.model !== profile.model || repair.provider !== profile.provider || repair.model !== repairModel) {
    return refused("its approved agents disagree with its approved route");
  }
  return { live: true, by: order.approval.by, profile, route, acceptance };
}

export type StandingFiring = { made: "filed"; taskId: string; approved: boolean; note: string | null } | { made: "skipped"; note: string };

/** A firing that must not stand: thrown inside the transaction so nothing it wrote survives. */
export class StandingOrderRefused extends Error {}

/**
 * File one firing of a standing order (v115, what firing a routine did), inside the caller's transaction. It skips,
 * saying why, while the last task is unfinished or the rolling 7-day ceiling is reached (an unmeasured paid run fails
 * closed). Otherwise it files the order's terms unchanged: approved by the carried approval when that still verifies
 * — on exactly the agents it froze, sealed like any automatic approval under the project's rules — or else as an
 * ordinary proposal that waits for the project's approval rules like any other.
 */
export function fileStandingOrder(store: Store, input: { flowId: number; repo: string; trigger: number; schedule: string; order: StandingOrder; title: string; slot: string }, now: Date): StandingFiring {
  const { order, repo } = input;
  const blocker = store.standingOrderBlocker(input.trigger, order.routine, now);
  if (blocker !== null) return { made: "skipped", note: `Skipped: the last one (${blocker.taskId}, ${blocker.state}) hasn't finished.` };
  const approval = standingApproval(order, repo, input.schedule);
  if (approval.acceptance === null) return { made: "skipped", note: "Skipped: its success checks can't be read. Set the flow up again." };
  if (order.costCeilingUsd !== null) {
    const ceiling = `$${order.costCeilingUsd.toFixed(2)}`;
    if (approval.live && !reportsCost(legOf(approval.route, "build").provider)) {
      return { made: "skipped", note: `Skipped: ${legOf(approval.route, "build").provider} doesn't report what it spends, so the ${ceiling} weekly limit can't be kept.` };
    }
    const spend = store.standingOrderSpend(input.trigger, order.routine, new Date(now.getTime() - BUDGET_WINDOW_MS).toISOString());
    if (spend.unmeasuredRuns > 0) return { made: "skipped", note: `Skipped: ${spend.unmeasuredRuns} run(s) in the last 7 days recorded no cost, so the ${ceiling} weekly limit can't be kept.` };
    if (spend.costUsd >= order.costCeilingUsd) return { made: "skipped", note: `Skipped: $${spend.costUsd.toFixed(2)} of the ${ceiling} weekly limit is spent.` };
  }
  let taskId = instanceId(order.stem, input.slot);
  for (let n = 2; store.getTask(taskId) !== null; n++) taskId = `${instanceId(order.stem, input.slot)}-${n}`;
  const filedBy = order.filedBy === null ? { name: null, kind: "automation" as const } : { name: order.filedBy, kind: "person" as const };
  if (!approval.live) {
    const filed = fileTaskProposal(store, {
      id: taskId, title: input.title, repo, goal: order.goal, outOfScope: order.outOfScope, touches: [...order.touches], acceptance: approval.acceptance,
      budgetMicrousd: order.budgetPerRunMicrousd, filedVia: `flow:${input.flowId}`, filedBy, planning: "skip", admittedRepos: [repo],
    }, now);
    if (!filed.ok) return { made: "skipped", note: `Couldn't file it: ${filed.message}.` };
    const ref = store.lookupRef(filed.id);
    if (ref !== null && order.requirements.length > 0) store.setRequirements(ref.id, order.requirements);
    return { made: "filed", taskId: filed.id, approved: false, note: approval.problem === null ? null : `Its earlier approval no longer applies (${approval.problem}), so this one waits for approval.` };
  }
  // The approved road: the frozen agents are the pin, the terms are the scope byte for byte, and the seal must read
  // back as the frozen route — or nothing of this firing stands.
  store.createTask({ id: taskId, title: input.title, filedBy }, now);
  const ref = store.refFor(BUILT_IN, taskId, "ours");
  store.placeTask(ref.id, repo);
  store.pinTaskAgent(ref.id, approval.profile.provider, approval.profile.model);
  if (order.requirements.length > 0) store.setRequirements(ref.id, order.requirements);
  const draft = { goal: order.goal, outOfScope: order.outOfScope, touches: [...order.touches], acceptance: approval.acceptance, ...(order.budgetPerRunMicrousd == null ? {} : { budgetMicrousd: order.budgetPerRunMicrousd }) };
  const digest = digestOf(draft, approval.profile, approval.route);
  store.saveScope(
    { taskId, ...draft, proposedAt: now.toISOString(), digest, budgetMicrousd: order.budgetPerRunMicrousd ?? null, approvedAt: order.approval!.at, approvedBy: approval.by, approvedDigest: digest },
    {},
    { profile: approval.profile, route: approval.route },
  );
  const sealed = store.sealScopeApproval(taskId, approval.by ?? "schedule", now, {}, undefined, "automation");
  const sealedRoute = sealed ? store.sealedRouteOf(taskId) : null;
  if (!sealed || sealedRoute === null || !sealedRoute.ok || routeDigestOf(sealedRoute.route) !== routeDigestOf(approval.route)) {
    throw new StandingOrderRefused(!sealed ? "the approval couldn't be sealed" : sealedRoute !== null && !sealedRoute.ok ? sealedRoute.detail : "the sealed agents aren't the approved ones");
  }
  return { made: "filed", taskId, approved: true, note: null };
}

/** A standing order in the words a person reads before turning its schedule on. */
export function describeStandingOrder(order: StandingOrder, repo: string, schedule: string): string[] {
  const approval = standingApproval(order, repo, schedule);
  return [
    `Builds: ${order.goal}`,
    ...(order.outOfScope === null ? [] : [`Not this: ${order.outOfScope}`]),
    ...(order.touches.length === 0 ? [] : [`Only touches: ${order.touches.join(", ")}`]),
    ...(order.requirements.length === 0 ? [] : [`Needs: ${order.requirements.join(", ")}`]),
    ...(order.budgetPerRunMicrousd === null ? [] : [`Each run: up to $${(order.budgetPerRunMicrousd / 1_000_000).toFixed(2)}`]),
    ...(order.costCeilingUsd === null ? [] : [`Every 7 days: up to $${order.costCeilingUsd.toFixed(2)}`]),
    "One at a time: it skips while the last one is unfinished.",
    approval.live ? `Approved by ${approval.by ?? "an approver"}: each run builds without asking, on the agents approved then.` : approval.problem === null ? "Each run waits for approval under the project's rules." : `Each run waits for approval: its earlier approval no longer applies (${approval.problem}).`,
  ];
}

/** The terms a person sets a standing order up with (a template's, a recipe's): what each firing files. */
export type StandingTerms = {
  goal: string;
  outOfScope: string | null;
  touches: string[];
  requirements: string[];
  acceptance: readonly AcceptanceCriterion[];
  budgetPerRunMicrousd: number | null;
  costCeilingUsd: number | null;
};

/** Every problem with a standing order's terms and schedule at once, as `field: problem` lines (none when it can be set up). */
export function standingTermsProblems(terms: StandingTerms, schedule: string): string[] {
  const problems: string[] = [];
  // What an approver reads must be what it appears to be (no control, invisible or direction-override text), bounded in bytes too.
  const unfit = (text: string, chars: number, bytes: number) => text.length > chars || Buffer.byteLength(text, "utf8") > bytes || hasForbiddenControls(text) || hasDisguisedText(text);
  if (terms.goal.trim() === "" || unfit(terms.goal, 2_000, 8_000)) problems.push("goal: required, at most 2000 characters, no control or hidden characters");
  if (terms.outOfScope !== null && unfit(terms.outOfScope, 2_000, 8_000)) problems.push("outOfScope: at most 2000 characters, no control or hidden characters");
  if (terms.touches.length > 50 || terms.touches.some(one => one.trim() === "" || unfit(one, 200, 800))) problems.push("touches: at most 50 paths, each non-empty and under 200 characters");
  if (terms.requirements.length > 20 || terms.requirements.some(one => parseCapabilityKey(one) === null || unfit(one, 400, 400))) problems.push("requirements: capability keys, `kind:name`, at most 20");
  // Each firing copies its success checks forward unchanged and never asks again, so there must be at least one.
  const read = parseAcceptanceCriteria(terms.acceptance);
  if (read.problems.length > 0) problems.push(`acceptance: ${read.problems.map(one => one.message).join("; ")}`);
  else if (read.criteria.length === 0) problems.push("acceptance: a repeating task needs at least one success check");
  if (parseSchedule(schedule) === null) problems.push(`schedule: \`every:<minutes>\` (${MIN_EVERY_MINUTES}–${MAX_EVERY_MINUTES}), \`daily:<HH:MM>\`, \`weekdays:<HH:MM>\` or \`weekly:<0–6>:<HH:MM>\`, with an optional @IANA/timezone`);
  if (terms.costCeilingUsd !== null && (!Number.isFinite(terms.costCeilingUsd) || terms.costCeilingUsd <= 0)) problems.push("costCeilingUsd: a positive dollar amount, or none for no weekly limit");
  if (terms.budgetPerRunMicrousd !== null && (!Number.isSafeInteger(terms.budgetPerRunMicrousd) || terms.budgetPerRunMicrousd <= 0)) problems.push("budgetPerRunMicrousd: a positive whole micro-dollar amount, or none");
  return problems;
}

export type ScheduledFlowMade = { ok: true; flow: number; trigger: number } | { ok: false; message: string };

/**
 * A scheduled flow a person set up (a template or a recipe; v115, what filing a routine was): a Build step that follows
 * the task each firing files, then Done, and a schedule trigger carrying the terms as its standing order — with no
 * approval, so each firing waits for approval under the project's rules. The schedule starts PAUSED with no time:
 * nothing repeats until a person turns it on, and it starts counting then. Its tasks are filed as `filedBy`'s (default
 * `by`; null files them as automation's). Inside the caller's transaction, if any.
 */
export function createScheduledFlow(store: Store, input: { repo: string; name: string; stem: string; schedule: string; terms: StandingTerms; by: string; filedBy?: string | null }, now: Date): ScheduledFlowMade {
  const problems = standingTermsProblems(input.terms, input.schedule);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(input.stem)) problems.unshift("name: lowercase letters, digits and dashes, at most 41 — it starts each task's id");
  if (input.name.trim() === "" || input.name.length > 80 || hasForbiddenControls(input.name)) problems.unshift("name: required, at most 80 characters");
  if (problems.length > 0) return { ok: false, message: problems.join("; ") };
  const { terms } = input;
  const order: StandingOrder = {
    stem: input.stem, goal: terms.goal, outOfScope: terms.outOfScope, touches: [...terms.touches], requirements: [...terms.requirements], acceptance: [...terms.acceptance],
    budgetPerRunMicrousd: terms.budgetPerRunMicrousd, costCeilingUsd: terms.costCeilingUsd, singleFlight: true, filedBy: input.filedBy === undefined ? input.by : input.filedBy, routine: null, approval: null,
  };
  const zone = (x: number, color: string) => ({ x, y: 0, w: 260, h: 300, color });
  const definition = { version: 1, start: "build", stages: [
    { id: "build", title: "Build", kind: "task", zone: zone(0, "blue"), instructions: terms.goal, planning: "skip", approver: null, message: null, close: null, script: null, sort: null, next: "done", onFail: null },
    { id: "done", title: "Done", kind: "done", zone: zone(420, "green"), instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null, next: null, onFail: null },
  ] };
  return store.transact(() => {
    const flow = store.createFlow({ repo: input.repo, name: input.name, definitionJson: JSON.stringify(definition), by: input.by }, now);
    const trigger = store.addFlowTrigger({ flow, kind: "schedule", configJson: JSON.stringify({ kind: "schedule", schedule: input.schedule, title: input.name, description: null, zone: "build", order }), hookHash: null, cursor: null, nextAt: null, by: input.by }, now);
    store.updateFlowTrigger(trigger, { state: "paused" }, now);
    return { ok: true as const, flow, trigger };
  });
}
