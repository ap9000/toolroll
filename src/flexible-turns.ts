/**
 * Flexible threads, slice F2e (the Flexible plan v2 §8, with Codex round 2's required changes 8 and 10, binding): turn
 * admission and limits. Every agent turn a Flexible thread takes (its first message, each later one, each resume) is
 * admitted here first, in one write transaction, and gets an id: the thread start (F2c) runs exactly that turn, and the
 * sign-in relay (F2b) charges every call it forwards to it.
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false (flexible-available.ts): every writer refuses with
 *   `not-available` before it reads or writes anything.
 * - One transaction proves the thread's terms still stand for this person at this level (flexible.ts
 *   flexibleDelegationAtUse: lapse, digest, approver standing and generation, starters, level, ceiling, fresh proof),
 *   that the thread is theirs and ready, and that every limit has room, then records the turn. Two admissions racing
 *   for the last place get exactly one.
 * - The limits, stricter wins: the project's signed terms (threads working at once, turns a day in the project, turns
 *   a day per person, an optional measured-dollar limit); the installation's own limits an instance operator set
 *   (threads at once, turns a day and measured dollars a day, across every project); an active mode's daily rails
 *   (store.ts reserveModeRail, which counts thread turns' dollars too); the provider's plan windows for a plan turn;
 *   and the monthly budgets for a keyed turn (as store.ts budgetGate reads them, uncached). The defaults (3 threads, 300 turns a day per
 *   project, 150 per person, no dollar limit) are well past what one person working normally uses.
 * - A person's turns count across every project: the per-person limit is a person's day, wherever they spend it.
 * - Turn limits are hard (reserved before the provider is asked) and dollar limits soft (no new turn once the day's
 *   measured spend reaches one; a running turn may go past it). A turn limit doesn't bound what one turn costs.
 * - Unknown cost: a turn whose usage can't be read still counts toward every turn limit. A keyed turn whose cost is
 *   unknown is never counted as $0: while a daily dollar limit applies to it, the day's spend can't be checked, so no
 *   new turn starts under that limit until the next day (UTC); and a monthly hard budget it counts toward holds the
 *   keyed turns it covers until the month ends (nothing settles an unknown cost later). A plan's turn costs $0
 *   (spend.ts), whatever its usage.
 * - An admission is for exactly that request under exactly those terms, on its own UTC day. Its start re-checks the
 *   terms (the same terms row, not just the same words), the thread, and every spend limit (spend can move while it
 *   waits); a start on a later day, or one that fails a check, withdraws it.
 * - A repeated request (the same request key on the same thread) never takes a second turn: while its turn waits to
 *   start, the exact same request (person, generation, terms, level, agent, model, billing, holder) gets the same id
 *   back and anything different is refused; once it started, it is refused. A turn that never started when its process went
 *   away is withdrawn (the provider was never asked: it counts toward nothing, and an active mode's start is given
 *   back), so the same request sent again after a restart takes exactly one turn. A turn that had started is
 *   interrupted and still counts.
 */
import { randomBytes } from "node:crypto";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { threadLevelAllowed } from "./flexible-levels.js";
import { flexibleDelegationAtUse, FLEXIBLE_LEVEL_WORDS, FLEXIBLE_LEVELS, FLEXIBLE_UNAVAILABLE, isFlexibleLevel, type FlexibleLevel, type FlexibleRefusalReason, type FlexibleTerms } from "./flexible.js";
import { budgetHoldWords, budgetLabel, budgetStates, canPrice, countsToward, monthOf, priceWork, spendItems, type Billing, type SpendItem } from "./spend.js";
import type { Store } from "./store.js";

// ---- records ----------------------------------------------------------------------------------------------------------

export type FlexibleTurnStatus = "admitted" | "running" | "finished" | "interrupted" | "unknown" | "withdrawn";
export type FlexibleCostBasis = "measured" | "estimated" | "unknown";
export type FlexibleTurnProvider = "claude" | "codex";
export type FlexibleTurnRow = {
  id: string; thread: string; seq: number; repo: string; owner: string; ownerGeneration: number; termsId: number; termsDigest: string; level: FlexibleLevel;
  provider: FlexibleTurnProvider; model: string; billing: Billing; requestKey: string; holder: string; admittedAt: string; utcDay: string; status: FlexibleTurnStatus;
  startedAt: string | null; endedAt: string | null; tokensIn: number; tokensOut: number; costMicrousd: number; relayCalls: number; costBasis: FlexibleCostBasis | null;
};

const TURN_ID = /^[0-9a-f]{32}$/;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

function readTurn(row: Record<string, unknown> | undefined): FlexibleTurnRow | null {
  if (row === undefined) return null;
  return { id: String(row["id"]), thread: String(row["thread"]), seq: Number(row["seq"]), repo: String(row["repo"]), owner: String(row["owner"]), ownerGeneration: Number(row["owner_generation"]),
    termsId: Number(row["terms_id"]), termsDigest: String(row["terms_digest"]), level: String(row["level"]) as FlexibleLevel, provider: String(row["provider"]) as FlexibleTurnProvider,
    model: String(row["model"]), billing: row["billing"] === "subscription" ? "subscription" : "api-key", requestKey: String(row["request_key"]), holder: String(row["holder"]),
    admittedAt: String(row["admitted_at"]), utcDay: String(row["utc_day"]), status: String(row["status"]) as FlexibleTurnStatus, startedAt: text(row["started_at"]), endedAt: text(row["ended_at"]),
    tokensIn: Number(row["tokens_in"]), tokensOut: Number(row["tokens_out"]), costMicrousd: Number(row["cost_microusd"]), relayCalls: Number(row["relay_calls"]),
    costBasis: row["cost_basis"] === null ? null : String(row["cost_basis"]) as FlexibleCostBasis };
}

/** A turn's record, or null (an id that isn't one is never looked up). */
export function flexibleTurn(store: Store, id: string): FlexibleTurnRow | null {
  if (!TURN_ID.test(id)) return null;
  return readTurn(store.handle.prepare("SELECT * FROM thread_turn WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

/** The installation's own Flexible limits, across every project; null is no limit beyond each project's terms. */
export type FlexibleInstallationCaps = { liveThreads: number | null; turnsPerDay: number | null; measuredMicrousdPerDay: number | null };
export function flexibleInstallationCaps(store: Store): FlexibleInstallationCaps {
  const row = store.handle.prepare("SELECT live_threads, turns_per_day, measured_microusd_per_day FROM flexible_installation_caps WHERE id = 1").get();
  const limit = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return { liveThreads: limit(row?.["live_threads"]), turnsPerDay: limit(row?.["turns_per_day"]), measuredMicrousdPerDay: limit(row?.["measured_microusd_per_day"]) };
}

// ---- refusals -----------------------------------------------------------------------------------------------------------

/** Which limit refused a turn. */
export type FlexibleCap = "project-threads" | "project-turns" | "person-turns" | "project-dollars" | "installation-threads" | "installation-turns" | "installation-dollars"
  | "mode-runs" | "mode-dollars" | "plan" | "budget";
export type FlexibleTurnRefusalReason = "not-available" | "invalid-request" | "thread-unknown" | "thread-not-ready" | "not-owner" | "already-sent" | "turn-in-progress"
  | "level-pending" | "cap-reached" | "spend-unknown" | "turn-unknown" | "turn-not-admitted" | "turn-not-running" | "held-elsewhere" | "not-an-operator"
  | "request-changed" | "turn-expired" | "level-unavailable";
export type FlexibleTurnRefusal = { ok: false; reason: FlexibleTurnRefusalReason | FlexibleRefusalReason; message: string;
  /** For `cap-reached` and `spend-unknown`: the limit, and when it has room again (null: when a running turn ends). */
  cap?: FlexibleCap; resetsAt?: string | null };

const WORDS: Readonly<Record<Exclude<FlexibleTurnRefusalReason, "cap-reached" | "spend-unknown" | "level-pending" | "level-unavailable">, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "invalid-request": "That turn request isn't one Toolroll can read. Nothing was started.",
  "thread-unknown": "There's no such thread.",
  "thread-not-ready": "This thread isn't ready, so it can't take a turn. Start a new thread.",
  "not-owner": "Only the person who started this thread can send it messages.",
  "already-sent": "That message already started a turn. Nothing new was started.",
  "turn-in-progress": "This thread is already working on a turn. Wait for it to finish, or stop it.",
  "turn-unknown": "There's no such turn.",
  "turn-not-admitted": "This turn isn't waiting to start, so it wasn't started again.",
  "turn-not-running": "This turn isn't running, so nothing was charged to it.",
  "held-elsewhere": "Another Toolroll process holds this turn, so this one didn't touch it.",
  "not-an-operator": "Only an instance operator can change the installation's Flexible limits. Nothing changed.",
  "request-changed": "That message is already waiting to start with different settings (level, agent, billing or session). Send it again as a new message.",
  "turn-expired": "This turn waited past midnight UTC, so it didn't start. Send the message again.",
});
const refuse = (reason: keyof typeof WORDS): FlexibleTurnRefusal => ({ ok: false, reason, message: WORDS[reason] });

/** A clock: every writer here reads it once, inside its write transaction (after the write lock is held, however long
 * that took), and uses that one time for every check and write in it. Never a time the caller took earlier. */
export type FlexibleClock = () => Date;
function timeOf(clock: FlexibleClock | undefined): Date {
  const now = (clock ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("the Flexible turn clock gave no usable time");
  return now;
}
const clockOk = (clock: unknown): boolean => clock === undefined || typeof clock === "function";

/** The next midnight (UTC) after `now`: when a day's limits have room again. */
const nextUtcDay = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dollars = (microusd: number) => `$${(microusd / 1_000_000).toFixed(2)}`;
const PROVIDER_WORDS: Readonly<Record<FlexibleTurnProvider, string>> = Object.freeze({ claude: "Claude", codex: "Codex" });
const TOMORROW = "New turns can start after midnight UTC.";

function capReached(cap: FlexibleCap, message: string, resetsAt: string | null): FlexibleTurnRefusal {
  return { ok: false, reason: "cap-reached", message, cap, resetsAt };
}

// ---- admission ------------------------------------------------------------------------------------------------------------

export type FlexibleTurnRequest = {
  /** The thread (flexible_thread.id). */
  thread: string;
  /** The person sending, from their own proof at a person's surface: a machine never reaches here as one. */
  starter: { name: string; generation: number };
  /** The terms digest the person holds; the live terms must still hash to it. */
  digest: string;
  level: FlexibleLevel;
  /** A password typed now (or the local owner's own act) for this turn: needed above the terms' password-free level. */
  freshProof: boolean;
  provider: FlexibleTurnProvider;
  model: string;
  /** How the turn is billed, as the credential the thread runs with says (a plan or a key). */
  billing: Billing;
  /** The request this turn answers (the message's id): the same key on the same thread never takes a second turn. */
  requestKey: string;
  /** The process that will run the turn: only it may start, finish or charge it, and when it is gone its turns end. */
  holder: string;
  /** Where the time comes from, read once after the write lock is held (default: the system clock). */
  clock?: FlexibleClock;
};
export type FlexibleTurnAdmission = { ok: true; turn: string; seq: number; replayed: boolean };

/** Today's turns, threads at once and spend, within one project or across every project (repo null). */
function usageOf(store: Store, day: string, repo: string | null): { threads: number; turns: number; spent: number; blind: number } {
  const where = repo === null ? "" : " AND repo = ?";
  const params = repo === null ? [day] : [day, repo];
  const today = store.handle.prepare(`SELECT COUNT(*) AS turns, COALESCE(SUM(cost_microusd), 0) AS spent,
      COALESCE(SUM(CASE WHEN billing = 'api-key' AND status IN ('finished', 'interrupted', 'unknown') AND cost_basis = 'unknown' THEN 1 ELSE 0 END), 0) AS blind
    FROM thread_turn WHERE utc_day = ? AND status <> 'withdrawn'${where}`).get(...params)!;
  const live = store.handle.prepare(`SELECT COUNT(DISTINCT thread) AS n FROM thread_turn WHERE status IN ('admitted', 'running')${where}`).get(...(repo === null ? [] : [repo]))!;
  return { threads: Number(live["n"]), turns: Number(today["turns"]), spent: Number(today["spent"]), blind: Number(today["blind"]) };
}

/** A dollar limit that refuses: reached, or not checkable because a keyed turn's cost is unknown. */
function dollarsRefusal(cap: FlexibleCap, who: string, limit: number | null, usage: { spent: number; blind: number }, now: Date): FlexibleTurnRefusal | null {
  if (limit === null) return null;
  if (usage.blind > 0) {
    return { ok: false, reason: "spend-unknown", cap, resetsAt: nextUtcDay(now),
      message: `A turn today on an API key ended without a cost Toolroll could measure, so ${who} ${dollars(limit)} daily limit can't be checked. ${TOMORROW}` };
  }
  return usage.spent >= limit ? capReached(cap, `${who[0]!.toUpperCase()}${who.slice(1)} measured spend today reached its ${dollars(limit)} limit. ${TOMORROW}`, nextUtcDay(now)) : null;
}

/** The provider's plan window that is used up now, from its last reading (provider_limit) or the runners' quota rows. */
function planSpent(store: Store, provider: FlexibleTurnProvider, now: Date): { until: string | null } | null {
  const stamp = now.toISOString();
  const window = store.handle.prepare("SELECT resets_at FROM provider_limit WHERE provider = ? AND reached = 1 AND (resets_at IS NULL OR resets_at > ?) ORDER BY resets_at IS NULL DESC, resets_at DESC LIMIT 1").get(provider, stamp);
  if (window !== undefined) return { until: text(window["resets_at"]) };
  const quota = store.handle.prepare("SELECT reset_at FROM quota WHERE provider = ? AND state = 'exhausted' AND (reset_at IS NULL OR reset_at > ?) ORDER BY reset_at IS NULL DESC, reset_at DESC LIMIT 1").get(provider, stamp);
  return quota === undefined ? null : { until: text(quota["reset_at"]) };
}

/** An active mode's measured-dollar rail for the project, when it has one. */
function modeDollarCap(store: Store, repo: string, now: Date): number | null {
  const mode = store.activeMode(repo, now);
  if (mode === null) return null;
  try {
    const terms = JSON.parse(mode.termsJson) as { dailyMeasuredCapMicrousd?: unknown };
    return typeof terms.dailyMeasuredCapMicrousd === "number" ? terms.dailyMeasuredCapMicrousd : null;
  } catch {
    return null;
  }
}

const reservedStarts = (store: Store, repo: string, day: string): number =>
  Number(store.handle.prepare("SELECT reserved_starts FROM mode_rail WHERE repo = ? AND utc_day = ?").get(repo, day)?.["reserved_starts"] ?? 0);

/** Give back the mode's daily start a turn that never started took. */
function releaseRail(store: Store, turn: FlexibleTurnRow): void {
  if (turn.relayCalls !== 0 || turn.startedAt !== null) return;
  const row = store.handle.prepare("SELECT rail_reserved FROM thread_turn WHERE id = ?").get(turn.id);
  if (Number(row?.["rail_reserved"] ?? 0) !== 1) return;
  store.handle.prepare("UPDATE mode_rail SET reserved_starts = reserved_starts - 1 WHERE repo = ? AND utc_day = ? AND reserved_starts > 0").run(turn.repo, turn.utcDay);
}

/** Withdraw a turn that never started: it counts toward nothing, and gives back an active mode's start it took. */
function withdrawTurn(store: Store, turn: FlexibleTurnRow, detail: string, at: string): void {
  releaseRail(store, turn);
  store.handle.prepare("UPDATE thread_turn SET status = 'withdrawn', ended_at = ?, end_detail = ? WHERE id = ? AND status = 'admitted'").run(at, detail.slice(0, 2000), turn.id);
}

/** What one month's monthly hard budgets say about a keyed turn toward `repo` and `person`: used up, unpriceable, or not
 * checkable because a keyed Flexible turn this month toward one of them has an unknown cost. Read uncached, in the
 * caller's transaction. An unknown cost holds the budgets it counts toward until the month ends (budgets are monthly;
 * nothing settles an unknown cost later), never read as $0. */
function budgetRefusal(store: Store, repo: string, person: string, provider: FlexibleTurnProvider, now: Date): FlexibleTurnRefusal | null {
  const hard = store.budgets().filter(one => one.hardStop);
  if (hard.length === 0) return null;
  const month = monthOf(now);
  const items = spendItems(store.handle, month.from, month.to);
  const mine = budgetStates(hard, items).filter(one => countsToward({ project: repo, person, subagent: null } as SpendItem, one));
  if (mine.length === 0) return null;
  const over = mine.find(one => one.spentMicrousd >= one.limitMicrousd) ?? null;
  if (over !== null) {
    const hold = { over, why: "used-up" as const, unpricedProvider: null, remainingMicrousd: null };
    return capReached("budget", `${budgetHoldWords(hold, month.name)}. Turns on an API key wait for next month or a higher budget.`, month.to);
  }
  const blind = mine.find(budget => items.some(item => item.kind === "flexible" && item.microusd === null && countsToward(item, budget))) ?? null;
  if (blind !== null) {
    return { ok: false, reason: "spend-unknown", cap: "budget", resetsAt: month.to,
      message: `A turn this month on an API key ended without a cost Toolroll could measure, so ${budgetLabel(blind).replace(/^The /, "the ")} budget can't be checked. Turns on an API key it covers wait for next month.` };
  }
  if (!canPrice(store.handle, provider)) {
    const hold = { over: mine[0]!, why: "unpriced" as const, unpricedProvider: provider, remainingMicrousd: null };
    return capReached("budget", `${budgetHoldWords(hold, month.name)}.`, null);
  }
  return null;
}

/** An active mode's measured spend today in the project, as reserveModeRail counts it: runs and thread turns. */
function modeSpentToday(store: Store, repo: string, day: string): number {
  const runs = store.handle.prepare(`SELECT COALESCE(SUM(CAST(ROUND(run.cost_usd * 1000000) AS INTEGER)), 0) AS total FROM run JOIN task_ref ON task_ref.id = run.task_ref
    WHERE task_ref.repo = ? AND run.cost_usd IS NOT NULL AND run.provider_started_at >= ? AND run.provider_started_at < ?`).get(repo, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`);
  const threads = store.handle.prepare("SELECT COALESCE(SUM(cost_microusd), 0) AS total FROM thread_turn WHERE repo = ? AND utc_day = ? AND status <> 'withdrawn'").get(repo, day);
  return Number(runs?.["total"] ?? 0) + Number(threads?.["total"] ?? 0);
}

function validRequest(input: FlexibleTurnRequest): boolean {
  return typeof input === "object" && input !== null && TURN_ID.test(input.thread) && typeof input.starter?.name === "string" && Number.isSafeInteger(input.starter.generation)
    && typeof input.digest === "string" && isFlexibleLevel(input.level) && typeof input.freshProof === "boolean" && (input.provider === "claude" || input.provider === "codex")
    && typeof input.model === "string" && MODEL.test(input.model) && (input.billing === "subscription" || input.billing === "api-key")
    && typeof input.requestKey === "string" && KEY.test(input.requestKey) && typeof input.holder === "string" && KEY.test(input.holder)
    && clockOk(input.clock);
}

/**
 * Admit one agent turn for a Flexible thread, or say plainly why not. Inside ONE write transaction: the thread is the
 * starter's and ready; the project's terms still stand for them at this level (flexibleDelegationAtUse); a repeated
 * request gets its waiting turn back; the thread has no turn already; a level change waits for the thread's agent to
 * restart; and every limit has room. Then the turn is recorded (admitted), an active mode's daily start is reserved,
 * and its id is returned for the thread start and the relay.
 */
export function admitFlexibleTurn(store: Store, input: FlexibleTurnRequest): FlexibleTurnAdmission | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!validRequest(input)) return refuse("invalid-request");
  return store.transact((): FlexibleTurnAdmission | FlexibleTurnRefusal => {
    const now = timeOf(input.clock);
    const thread = store.handle.prepare("SELECT repo, state, created_by, live_pid FROM flexible_thread WHERE id = ?").get(input.thread);
    if (thread === undefined) return refuse("thread-unknown");
    if (thread["state"] !== "ready") return refuse("thread-not-ready");
    if (thread["created_by"] !== input.starter.name) return refuse("not-owner");
    const repo = String(thread["repo"]);
    const delegation = flexibleDelegationAtUse(store, { repo, starter: input.starter, digest: input.digest, level: input.level, freshProof: input.freshProof });
    if (!delegation.ok) return delegation;

    const same = readTurn(store.handle.prepare("SELECT * FROM thread_turn WHERE thread = ? AND request_key = ? AND status <> 'withdrawn'").get(input.thread, input.requestKey) as Record<string, unknown> | undefined);
    if (same !== null) {
      if (same.status !== "admitted") return refuse("already-sent");
      if (same.termsId !== delegation.termsId) {
        // Admitted under terms that have since ended (off and on again, even with the same words): it can never start.
        // It is withdrawn, and this request is admitted afresh under the live terms, every limit checked again.
        withdrawTurn(store, same, "admitted under terms that have since ended", now.toISOString());
      } else {
        // The same request, exactly: the waiting turn back. Anything else about it differing is refused, never merged.
        const exact = same.owner === input.starter.name && same.ownerGeneration === input.starter.generation && same.termsDigest === delegation.digest && same.level === input.level
          && same.provider === input.provider && same.model === input.model && same.billing === input.billing && same.holder === input.holder;
        return exact ? { ok: true as const, turn: same.id, seq: same.seq, replayed: true } : refuse("request-changed");
      }
    }
    if (store.handle.prepare("SELECT 1 AS hit FROM thread_turn WHERE thread = ? AND status IN ('admitted', 'running')").get(input.thread) !== undefined) return refuse("turn-in-progress");
    // The level the thread's agent runs at is its live launch's (F2c, flexible_thread_launch), never a guess from the
    // last turn: another level or agent waits for the boundary, and so does an agent some of whose processes may still
    // run (custody unresolved: Codex round 2 item 10, no replacement while it is).
    const launch = store.handle.prepare("SELECT level, provider, state FROM flexible_thread_launch WHERE thread = ? AND state <> 'exited'").get(input.thread);
    if (launch !== undefined) {
      if (launch["state"] !== "live") {
        return { ok: false as const, reason: "level-pending" as const, message: "Some of this thread's agent's processes are still being stopped, so no new turn starts until they have. Try again in a moment." };
      }
      if (launch["level"] !== input.level || launch["provider"] !== input.provider) {
        const was = isFlexibleLevel(launch["level"]) ? FLEXIBLE_LEVEL_WORDS[launch["level"]] : "another level";
        return { ok: false as const, reason: "level-pending" as const, message: `This thread's agent is still running at ${was}. Stop it, and its next turn starts at ${FLEXIBLE_LEVEL_WORDS[input.level]}.` };
      }
    }
    // A thread its owner lowered: a turn above that level raises it, and a raise needs a fresh proof (§5).
    const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(input.thread);
    const chosenLevel = chosen !== undefined && isFlexibleLevel(chosen["level"]) ? chosen["level"] : null;
    if (chosenLevel !== null && FLEXIBLE_LEVELS.indexOf(input.level) > FLEXIBLE_LEVELS.indexOf(chosenLevel) && input.freshProof !== true) {
      return { ok: false as const, reason: "proof-required" as const, message: `This thread was lowered to ${FLEXIBLE_LEVEL_WORDS[chosenLevel]}. Raising it to ${FLEXIBLE_LEVEL_WORDS[input.level]} needs your password.` };
    }
    // Only a level proven for this agent, under the organisation's ceiling (flexible-levels.ts).
    const allowed = threadLevelAllowed(store.orgPolicy(), input.provider, input.level);
    if (!allowed.ok) return allowed;

    const limits = countsRefusal(store, repo, input.starter.name, delegation.terms, now) ?? spendRefusal(store, repo, input.starter.name, input.provider, input.billing, delegation.terms, now, false);
    if (limits !== null) return limits;
    const day = now.toISOString().slice(0, 10);
    const before = reservedStarts(store, repo, day);
    const rail = store.reserveModeRail(repo, 1, now);
    if (!rail.ok) return capReached(rail.rail === "daily-runs" ? "mode-runs" : "mode-dollars", `This project's mode limits it: ${rail.detail}.`, nextUtcDay(now));
    const railReserved = reservedStarts(store, repo, day) > before ? 1 : 0;

    const id = randomBytes(16).toString("hex");
    const seq = Number(store.handle.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM thread_turn WHERE thread = ?").get(input.thread)!["n"]);
    const at = now.toISOString();
    store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing, request_key, holder, admitted_at, utc_day, rail_reserved, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted')`).run(id, input.thread, seq, repo, input.starter.name, input.starter.generation, delegation.termsId, delegation.digest,
      input.level, input.provider, input.model, input.billing, input.requestKey, input.holder, at, day, railReserved);
    if (chosenLevel !== null && FLEXIBLE_LEVELS.indexOf(input.level) > FLEXIBLE_LEVELS.indexOf(chosenLevel)) {
      store.handle.prepare("UPDATE flexible_thread_level SET level = ?, set_by = ?, set_at = ? WHERE thread = ?").run(input.level, input.starter.name, at, input.thread);
    }
    store.recordAction({ at, actor: input.starter.name, repo, taskId: null, runId: null, source: "policy", action: "flexible turn admitted", outcome: "admitted",
      detail: `thread ${input.thread} · turn ${seq} · ${input.level} · ${input.provider} ${input.model} · ${input.billing} · terms ${delegation.digest}` });
    return { ok: true as const, turn: id, seq, replayed: false };
  });
}

/** The first count limit (threads at once, turns today) with no room for this turn, or null. Read inside the admission's
 * transaction; the turn's own place is reserved by the row it writes. */
function countsRefusal(store: Store, repo: string, person: string, terms: FlexibleTerms, now: Date): FlexibleTurnRefusal | null {
  const day = now.toISOString().slice(0, 10);
  const tomorrow = nextUtcDay(now);
  const caps = terms.caps;
  const project = usageOf(store, day, repo);
  if (project.threads >= caps.liveThreads) {
    return capReached("project-threads", `This project already has ${plural(project.threads, "thread")} working, the most its Flexible terms allow. Try again when one finishes.`, null);
  }
  if (project.turns >= caps.turnsPerDayProject) return capReached("project-turns", `This project used its ${plural(caps.turnsPerDayProject, "agent turn")} for today. ${TOMORROW}`, tomorrow);
  const personTurns = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn WHERE owner = ? AND utc_day = ? AND status <> 'withdrawn'").get(person, day)!["n"]);
  if (personTurns >= caps.turnsPerDayPerson) return capReached("person-turns", `You used your ${plural(caps.turnsPerDayPerson, "agent turn")} for today across Flexible projects. ${TOMORROW}`, tomorrow);
  const own = flexibleInstallationCaps(store);
  if (own.liveThreads !== null || own.turnsPerDay !== null) {
    const all = usageOf(store, day, null);
    if (own.liveThreads !== null && all.threads >= own.liveThreads) {
      return capReached("installation-threads", `Toolroll already has ${plural(all.threads, "thread")} working, the most this installation allows. Try again when one finishes.`, null);
    }
    if (own.turnsPerDay !== null && all.turns >= own.turnsPerDay) return capReached("installation-turns", `This installation used its ${plural(own.turnsPerDay, "agent turn")} for today. ${TOMORROW}`, tomorrow);
  }
  return null;
}

/**
 * The first spend limit with no room for a turn now, or null: the installation's and the project's measured dollars a
 * day (reached, or not checkable for an unknown keyed cost), an active mode's measured budget, the provider's plan window
 * for a plan turn, and the monthly budgets for a keyed turn. Checked at admission and again at the turn's start, since
 * spend can move while a turn waits; it reserves nothing. `modeReached`: also check the mode's budget is not yet spent
 * (at admission reserveModeRail does that, and takes the day's start with it).
 */
function spendRefusal(store: Store, repo: string, owner: string, provider: FlexibleTurnProvider, billing: Billing, terms: FlexibleTerms, now: Date, modeReached: boolean): FlexibleTurnRefusal | null {
  const day = now.toISOString().slice(0, 10);
  const own = flexibleInstallationCaps(store);
  if (own.measuredMicrousdPerDay !== null) {
    const installation = dollarsRefusal("installation-dollars", "the installation's", own.measuredMicrousdPerDay, usageOf(store, day, null), now);
    if (installation !== null) return installation;
  }
  const project = usageOf(store, day, repo);
  const projectDollars = dollarsRefusal("project-dollars", "this project's", terms.caps.measuredMicrousdPerDay, project, now);
  if (projectDollars !== null) return projectDollars;
  // An active mode's measured budget counts thread turns' dollars (reserveModeRail); an unknown one can't be checked.
  const modeCap = modeDollarCap(store, repo, now);
  if (modeCap !== null && (project.blind > 0 || modeReached)) {
    const mode = dollarsRefusal("mode-dollars", "this project's mode", modeCap, { spent: modeReached ? modeSpentToday(store, repo, day) : 0, blind: project.blind }, now);
    if (mode !== null) return mode;
  }
  if (billing === "subscription") {
    const spent = planSpent(store, provider, now);
    if (spent !== null) {
      const when = spent.until === null ? "when it resets" : `after it resets at ${spent.until.slice(11, 16)} UTC on ${spent.until.slice(0, 10)}`;
      return capReached("plan", `Your ${PROVIDER_WORDS[provider]} plan's usage limit is reached. New turns can start ${when}.`, spent.until);
    }
    return null;
  }
  return budgetRefusal(store, repo, owner, provider, now);
}

// ---- the turn's life: start, charge, finish, and when its process is gone ----------------------------------------------

/**
 * Start an admitted turn (F2c calls this, and commits it, before it asks the provider anything). The terms are checked
 * again from the turn's own record (the terms row, digest and generation it was admitted under), and so is every spend
 * limit: if the terms lapsed or changed, the thread is no longer ready, a spend limit has no room now, or the UTC day
 * it was admitted in has passed, the turn is withdrawn (it counts toward nothing) and refused. It reserves nothing more.
 */
export function beginFlexibleTurn(store: Store, input: { turn: string; holder: string; clock?: FlexibleClock }): { ok: true; turn: FlexibleTurnRow } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; turn: FlexibleTurnRow } | FlexibleTurnRefusal => {
    const now = timeOf(input.clock);
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-unknown");
    if (turn.status !== "admitted") return refuse("turn-not-admitted");
    if (turn.holder !== input.holder) return refuse("held-elsewhere");
    const at = now.toISOString();
    const withdraw = (refusal: FlexibleTurnRefusal): FlexibleTurnRefusal => { withdrawTurn(store, turn, refusal.message, at); return refusal; };
    // An admission lasts its own UTC day: its place was counted in that day, so a later start would spend outside it.
    if (at.slice(0, 10) !== turn.utcDay) return withdraw(refuse("turn-expired"));
    const thread = store.handle.prepare("SELECT state, created_by FROM flexible_thread WHERE id = ?").get(turn.thread);
    if (thread === undefined || thread["state"] !== "ready") return withdraw(refuse("thread-not-ready"));
    if (thread["created_by"] !== turn.owner) return withdraw(refuse("not-owner"));
    // The admission already required a fresh proof where this level needs one, for exactly this turn.
    const delegation = flexibleDelegationAtUse(store, { repo: turn.repo, starter: { name: turn.owner, generation: turn.ownerGeneration }, digest: turn.termsDigest, level: turn.level, freshProof: true });
    if (!delegation.ok) return withdraw(delegation);
    // A thread lowered since this turn was admitted: a turn above its level never starts (raising needs a fresh proof).
    const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(turn.thread);
    if (chosen !== undefined && isFlexibleLevel(chosen["level"]) && FLEXIBLE_LEVELS.indexOf(turn.level) > FLEXIBLE_LEVELS.indexOf(chosen["level"])) {
      return withdraw({ ok: false, reason: "level-pending", message: `This thread was lowered to ${FLEXIBLE_LEVEL_WORDS[chosen["level"]]} after this message was sent, so it didn't start. Send it again.` });
    }
    // The exact terms row it was admitted under: terms turned off and on again (even with the same words) are new terms.
    if (delegation.termsId !== turn.termsId) {
      return withdraw({ ok: false, reason: "terms-changed", message: "This project's Flexible terms changed since this turn was admitted, so it didn't start. Send the message again." });
    }
    // Spend may have moved while it waited: a dollar limit reached, a plan window used up, a budget spent.
    const spend = spendRefusal(store, turn.repo, turn.owner, turn.provider, turn.billing, delegation.terms, now, true);
    if (spend !== null) return withdraw(spend);
    store.handle.prepare("UPDATE thread_turn SET status = 'running', started_at = ? WHERE id = ? AND status = 'admitted'").run(at, turn.id);
    return { ok: true as const, turn: flexibleTurn(store, turn.id)! };
  });
}

const BASIS_RANK: Readonly<Record<FlexibleCostBasis, number>> = Object.freeze({ measured: 0, estimated: 1, unknown: 2 });
const worse = (a: FlexibleCostBasis | null, b: FlexibleCostBasis): FlexibleCostBasis => a === null || BASIS_RANK[b] > BASIS_RANK[a] ? b : a;
export type FlexibleUsage = { tokensIn: number; tokensOut: number; costUsd: number | null };
const validUsage = (usage: FlexibleUsage): boolean => typeof usage === "object" && usage !== null && Number.isSafeInteger(usage.tokensIn) && usage.tokensIn >= 0
  && Number.isSafeInteger(usage.tokensOut) && usage.tokensOut >= 0 && (usage.costUsd === null || (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0));

/** What some usage cost, and how sure that is: reported by the provider (measured), tokens at the catalogue price or a
 * plan's $0 (estimated), or not priceable at all (unknown, never $0). */
function priced(store: Store, turn: FlexibleTurnRow, usage: FlexibleUsage, model: string): { microusd: number; basis: FlexibleCostBasis } {
  const price = priceWork(store.handle, { provider: turn.provider, model, costUsd: usage.costUsd, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, billing: turn.billing });
  if (price.microusd === null || price.source === "unpriced") return { microusd: 0, basis: "unknown" };
  return { microusd: Math.max(0, price.microusd), basis: price.source === "reported" ? "measured" : "estimated" };
}

/**
 * Charge one relay call to a turn (F2b's relay calls this for every call it forwarded, with the usage it counted
 * itself, outside the fence). A turn that started takes the charge even after it ended (a call can finish after its
 * turn did): usage only grows, and an unpriceable call makes the turn's cost unknown. A turn that never started takes
 * none: the relay must forward nothing for it. `incomplete`: the relay couldn't read the call's whole usage (its answer
 * was cut off or unreadable): what it did read is added, and the call's cost is unknown, never what was read alone.
 */
export function chargeFlexibleTurn(store: Store, input: { turn: string; usage: FlexibleUsage; model?: string; incomplete?: boolean }): { ok: true; costMicrousd: number; basis: FlexibleCostBasis } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!validUsage(input.usage) || (input.model !== undefined && (typeof input.model !== "string" || !MODEL.test(input.model)))
    || (input.incomplete !== undefined && typeof input.incomplete !== "boolean")) return refuse("invalid-request");
  return store.transact((): { ok: true; costMicrousd: number; basis: FlexibleCostBasis } | FlexibleTurnRefusal => {
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-unknown");
    if (turn.status === "admitted" || turn.status === "withdrawn") return refuse("turn-not-running");
    const priced1 = priced(store, turn, input.usage, input.model ?? turn.model);
    const cost = input.incomplete === true ? { microusd: priced1.microusd, basis: "unknown" as const } : priced1;
    // A running turn's basis is the worst of its calls; an ended turn's can only get less certain.
    const basis = turn.status === "running" ? worse(turn.costBasis, cost.basis) : cost.basis === "unknown" ? "unknown" : turn.costBasis!;
    store.handle.prepare("UPDATE thread_turn SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_microusd = cost_microusd + ?, relay_calls = relay_calls + 1, cost_basis = ? WHERE id = ?")
      .run(input.usage.tokensIn, input.usage.tokensOut, cost.microusd, basis, turn.id);
    return { ok: true as const, costMicrousd: cost.microusd, basis: cost.basis };
  });
}

/**
 * End a running turn: `finished`, or `unknown` when the provider ended without saying how. Usage: the relay's own
 * counts when it charged any calls (not something the agent can shape); otherwise what the provider reported; with
 * neither, the cost is unknown (a keyed turn's then holds any dollar limit for the day).
 */
export function finishFlexibleTurn(store: Store, input: { turn: string; holder: string; outcome: "finished" | "unknown"; usage: FlexibleUsage | null; detail?: string; clock?: FlexibleClock }):
  { ok: true; turn: FlexibleTurnRow } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if ((input.outcome !== "finished" && input.outcome !== "unknown") || (input.usage !== null && !validUsage(input.usage)) || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; turn: FlexibleTurnRow } | FlexibleTurnRefusal => {
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-unknown");
    if (turn.status !== "running") return refuse("turn-not-running");
    if (turn.holder !== input.holder) return refuse("held-elsewhere");
    const at = timeOf(input.clock).toISOString();
    const detail = input.detail === undefined ? null : input.detail.slice(0, 2000);
    if (turn.relayCalls > 0) {
      store.handle.prepare("UPDATE thread_turn SET status = ?, ended_at = ?, end_detail = ?, cost_basis = ? WHERE id = ?").run(input.outcome, at, detail, turn.costBasis ?? "unknown", turn.id);
    } else if (input.usage !== null) {
      const cost = priced(store, turn, input.usage, turn.model);
      store.handle.prepare("UPDATE thread_turn SET status = ?, ended_at = ?, end_detail = ?, tokens_in = ?, tokens_out = ?, cost_microusd = ?, cost_basis = ? WHERE id = ?")
        .run(input.outcome, at, detail, input.usage.tokensIn, input.usage.tokensOut, cost.microusd, cost.basis, turn.id);
    } else {
      store.handle.prepare("UPDATE thread_turn SET status = ?, ended_at = ?, end_detail = ?, cost_basis = 'unknown' WHERE id = ?").run(input.outcome, at, detail, turn.id);
    }
    return { ok: true as const, turn: flexibleTurn(store, turn.id)! };
  });
}

/**
 * The process that held these turns is gone (a restart, a crash): the caller has proved it (F2c's process custody).
 * Its turns that never started are withdrawn (the provider was never asked: they count toward nothing, and an active
 * mode's start is given back, so the same request sent again takes exactly one turn); its running turns are
 * interrupted and still count. An interrupted keyed turn's cost is unknown (a call may have been answered and not yet
 * charged), never $0. Nothing is resumed or replayed.
 */
export function interruptFlexibleTurnsOf(store: Store, input: { holder: string; clock?: FlexibleClock }): { ok: true; withdrawn: number; interrupted: number } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.holder !== "string" || !KEY.test(input.holder) || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; withdrawn: number; interrupted: number } | FlexibleTurnRefusal => {
    const at = timeOf(input.clock).toISOString();
    let withdrawn = 0, interrupted = 0;
    for (const row of store.handle.prepare("SELECT * FROM thread_turn WHERE holder = ? AND status IN ('admitted', 'running') ORDER BY admitted_at, id").all(input.holder)) {
      const turn = readTurn(row as Record<string, unknown>)!;
      if (turn.status === "admitted") {
        withdrawTurn(store, turn, "not started before Toolroll restarted", at);
        withdrawn++;
      } else {
        const basis: FlexibleCostBasis = turn.billing === "subscription" ? turn.costBasis ?? "unknown" : "unknown";
        store.handle.prepare("UPDATE thread_turn SET status = 'interrupted', ended_at = ?, end_detail = 'interrupted when Toolroll restarted', cost_basis = ? WHERE id = ?").run(at, basis, turn.id);
        interrupted++;
      }
    }
    if (withdrawn + interrupted > 0) {
      store.recordAction({ at, actor: "toolroll", repo: null, taskId: null, runId: null, source: "policy", action: "flexible turns ended at restart", outcome: "interrupted",
        detail: `${plural(interrupted, "turn")} interrupted, ${plural(withdrawn, "turn")} not started withdrawn` });
    }
    return { ok: true as const, withdrawn, interrupted };
  });
}

// ---- the installation's own limits ------------------------------------------------------------------------------------------

const INSTALLATION_LIMITS = { liveThreads: 1000, turnsPerDay: 1_000_000, measuredMicrousdPerDay: 100_000_000 * 1_000_000 } as const;
const limitOk = (value: unknown, max: number) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max);

/** Set the installation's own Flexible limits across every project (null: none). An instance operator only; a surface
 * that offers it adds its own step-up. Written and recorded in one transaction. */
export function setFlexibleInstallationCaps(store: Store, input: { by: string; caps: FlexibleInstallationCaps; clock?: FlexibleClock }): { ok: true; caps: FlexibleInstallationCaps } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const caps = input.caps;
  if (typeof caps !== "object" || caps === null || !limitOk(caps.liveThreads, INSTALLATION_LIMITS.liveThreads) || !limitOk(caps.turnsPerDay, INSTALLATION_LIMITS.turnsPerDay)
    || !limitOk(caps.measuredMicrousdPerDay, INSTALLATION_LIMITS.measuredMicrousdPerDay) || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; caps: FlexibleInstallationCaps } | FlexibleTurnRefusal => {
    const account = store.accountOf(input.by);
    if (account === null || account.revokedAt !== null || !store.isInstanceOperator(input.by)) return refuse("not-an-operator");
    const before = flexibleInstallationCaps(store);
    const at = timeOf(input.clock).toISOString();
    store.handle.prepare(`INSERT INTO flexible_installation_caps (id, live_threads, turns_per_day, measured_microusd_per_day, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET live_threads = excluded.live_threads, turns_per_day = excluded.turns_per_day, measured_microusd_per_day = excluded.measured_microusd_per_day,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(caps.liveThreads, caps.turnsPerDay, caps.measuredMicrousdPerDay, input.by, at);
    const words = (one: FlexibleInstallationCaps) => `threads ${one.liveThreads ?? "none"}, turns a day ${one.turnsPerDay ?? "none"}, dollars a day ${one.measuredMicrousdPerDay === null ? "none" : dollars(one.measuredMicrousdPerDay)}`;
    store.recordAction({ at, actor: input.by, repo: null, taskId: null, runId: null, source: "policy", action: "flexible installation limits changed", outcome: "changed", detail: `${words(before)} → ${words(caps)}` });
    return { ok: true as const, caps: { liveThreads: caps.liveThreads, turnsPerDay: caps.turnsPerDay, measuredMicrousdPerDay: caps.measuredMicrousdPerDay } };
  });
}

// ---- F2c: the thread start's own steps ---------------------------------------------------------------------------------------

/**
 * Withdraw an admitted turn the thread start won't run (its agent or level isn't offered now, its agent couldn't be
 * matched to the one running): it counts toward nothing and gives back an active mode's start. Only its holder may.
 */
export function withdrawFlexibleTurn(store: Store, input: { turn: string; holder: string; detail: string; clock?: FlexibleClock }): { ok: true } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.detail !== "string" || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true } | FlexibleTurnRefusal => {
    const at = timeOf(input.clock).toISOString();
    const turn = flexibleTurn(store, input.turn);
    if (turn === null) return refuse("turn-unknown");
    if (turn.status !== "admitted") return refuse("turn-not-admitted");
    if (turn.holder !== input.holder) return refuse("held-elsewhere");
    withdrawTurn(store, turn, input.detail, at);
    return { ok: true as const };
  });
}

/**
 * A thread's agent was stopped and its exit verified, whole tree (F2c's process custody, flexible-launch.ts settleLaunch:
 * the proof interruptFlexibleTurnsOf trusts its caller for, here for one thread). Its running turn is interrupted (it
 * still counts; a keyed one's cost becomes unknown), and a turn waiting to start is withdrawn. Called inside the
 * transaction that records the verified exit.
 */
export function interruptFlexibleThreadTurns(store: Store, input: { thread: string; detail: string; clock?: FlexibleClock; except?: string }): { ok: true; withdrawn: number; interrupted: number } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || typeof input.detail !== "string" || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; withdrawn: number; interrupted: number } | FlexibleTurnRefusal => {
    const at = timeOf(input.clock).toISOString();
    let withdrawn = 0, interrupted = 0;
    for (const row of store.handle.prepare("SELECT * FROM thread_turn WHERE thread = ? AND status IN ('admitted', 'running')").all(input.thread)) {
      const turn = readTurn(row as Record<string, unknown>)!;
      if (turn.id === input.except) continue;
      if (turn.status === "admitted") { withdrawTurn(store, turn, input.detail, at); withdrawn++; continue; }
      const basis: FlexibleCostBasis = turn.billing === "subscription" ? turn.costBasis ?? "unknown" : "unknown";
      store.handle.prepare("UPDATE thread_turn SET status = 'interrupted', ended_at = ?, end_detail = ?, cost_basis = ? WHERE id = ? AND status = 'running'").run(at, input.detail.slice(0, 2000), basis, turn.id);
      interrupted++;
    }
    return { ok: true as const, withdrawn, interrupted };
  });
}

/**
 * A thread was lowered to `level` (F2c, in the transaction that records it): every turn of it admitted above that level
 * and not yet started is withdrawn (it counts toward nothing). A running one is the stop's to end.
 */
export function withdrawFlexibleTurnsAbove(store: Store, input: { thread: string; level: FlexibleLevel; detail: string; clock?: FlexibleClock }): { ok: true; withdrawn: number } | FlexibleTurnRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !isFlexibleLevel(input.level) || typeof input.detail !== "string" || !clockOk(input.clock)) return refuse("invalid-request");
  return store.transact((): { ok: true; withdrawn: number } | FlexibleTurnRefusal => {
    const at = timeOf(input.clock).toISOString();
    let withdrawn = 0;
    for (const row of store.handle.prepare("SELECT * FROM thread_turn WHERE thread = ? AND status = 'admitted'").all(input.thread)) {
      const turn = readTurn(row as Record<string, unknown>)!;
      if (FLEXIBLE_LEVELS.indexOf(turn.level) <= FLEXIBLE_LEVELS.indexOf(input.level)) continue;
      withdrawTurn(store, turn, input.detail, at);
      withdrawn++;
    }
    return { ok: true as const, withdrawn };
  });
}
