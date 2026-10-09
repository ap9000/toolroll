/**
 * Sign-in pauses: when a provider's sign-in (or API key) stops working, its
 * runs fail in seconds and every retry fails the same way. So an
 * `auth-expired` run takes no strike and no retry: its task goes back to the
 * queue, dispatch for THAT provider pauses (the others keep working), and a
 * person is told once per incident, on every connected messaging channel, what
 * to run. The pause lifts when a run or a sign-in probe on that provider
 * succeeds, or when a person resumes it; one short message says so.
 *
 * One row per incident. At most one open incident per provider (a partial
 * unique index), so however many runs hit it, one notification goes out:
 * its key is `signin:auth-expired:<provider>:<ordinal>:<person>`, the ordinal
 * being the incident's own number for that provider.
 */
import type { Store } from "./store.js";
import { PROVIDER_IDS, type ProviderId } from "./provider.js";

/** Every sign-in message's dedupe key starts here: `signin:<kind>:<provider>:<ordinal>:<person>`.
 * Not a lifecycle (`life:`) key: those are progress chatter, and an undelivered
 * one stays out of the attention list — this one needs a person. */
export const SIGN_IN_KEY_PREFIX = "signin:";

export const PROVIDER_AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_auth_pause (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription', 'api-key')),
  opened_at   TEXT NOT NULL,
  first_run   INTEGER,
  task_ref    INTEGER,
  runs        INTEGER NOT NULL DEFAULT 1,
  -- 1 once a sign-in probe during this pause said the provider is signed out:
  -- only a probe that then sees it signed in again may lift the pause.
  probe_saw_out INTEGER NOT NULL DEFAULT 0,
  lifted_at   TEXT,
  lifted_by   TEXT,
  lifted_how  TEXT CHECK (lifted_how IS NULL OR lifted_how IN ('run', 'probe', 'person')),
  resumed     INTEGER,
  -- The last task let through as a trial while paused: a sign-in check can
  -- say "logged in" for a session that no longer works, so a real run decides.
  last_trial_at TEXT,
  UNIQUE (provider, ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_auth_pause_open ON provider_auth_pause (provider) WHERE lifted_at IS NULL;
`;

export type AuthPause = {
  id: number;
  provider: ProviderId;
  ordinal: number;
  authMode: "subscription" | "api-key";
  openedAt: string;
  firstRun: number | null;
  taskRef: number | null;
  runs: number;
};

const NAMES: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", openrouter: "OpenRouter", gemini: "Gemini" };
const SIGN_IN: Record<ProviderId, string> = { claude: "claude /login", codex: "codex login", gemini: "gemini", openrouter: "toolroll keys set openrouter" };

export function providerName(provider: string): string {
  return (PROVIDER_IDS as readonly string[]).includes(provider) ? NAMES[provider as ProviderId] : provider;
}

/** The plain reason: "Claude needs you to sign in again". */
export function signInReason(pause: Pick<AuthPause, "provider" | "authMode">): string {
  const name = providerName(pause.provider);
  return pause.authMode === "api-key" ? `${name} needs a working API key` : `${name} needs you to sign in again`;
}

/** What to run, as a command. */
export function signInCommand(pause: Pick<AuthPause, "provider" | "authMode">): string {
  return pause.authMode === "api-key" && pause.provider !== "openrouter" ? `toolroll keys set ${pause.provider}` : SIGN_IN[pause.provider];
}

/** The same command for a chat message: the phone scrub hides anything shaped
 * like a path (`/login` included), so a message names Claude's equivalent
 * `claude auth login`. */
export function messageCommand(pause: Pick<AuthPause, "provider" | "authMode">): string {
  const command = signInCommand(pause);
  return command === "claude /login" ? "claude auth login" : command;
}

/** One line for status, ready and the console. */
export function signInWords(pause: AuthPause): string {
  return `${signInReason(pause)}. Run \`${signInCommand(pause)}\` on this computer; its tasks start again on their own once it works (or \`toolroll providers resume ${pause.provider}\`).`;
}

function readPause(row: Record<string, unknown>): AuthPause {
  return {
    id: Number(row["id"]),
    provider: String(row["provider"]) as ProviderId,
    ordinal: Number(row["ordinal"]),
    authMode: row["auth_mode"] === "api-key" ? "api-key" : "subscription",
    openedAt: String(row["opened_at"]),
    firstRun: row["first_run"] == null ? null : Number(row["first_run"]),
    taskRef: row["task_ref"] == null ? null : Number(row["task_ref"]),
    runs: Number(row["runs"]),
  };
}

/** The open pause for a provider, or null. */
export function authPauseOf(store: Store, provider: string): AuthPause | null {
  const row = store.handle.prepare("SELECT * FROM provider_auth_pause WHERE provider = ? AND lifted_at IS NULL").get(provider);
  return row === undefined ? null : readPause(row);
}

/**
 * SQL: whether the pause `pause` (a provider_auth_pause alias) is on one of
 * the task_ref `taskRef`'s current providers — its pins, its working profile,
 * and route legs — so a task re-routed to another provider
 * stops saying it waits on the old one. A task that names none yet (an
 * unpinned planner, whose agent comes from configuration) keeps what the gate
 * found.
 */
export function pauseOnTaskProviders(pause: string, taskRef: string): string {
  const providers = `SELECT r.agent_provider provider FROM task_ref r WHERE r.id = ${taskRef}
    UNION ALL SELECT r.plan_provider FROM task_ref r WHERE r.id = ${taskRef}
    UNION ALL SELECT json_extract(ts.profile_json, '$.provider') FROM task_ref r JOIN task_scope ts ON ts.task_id = r.external_id
      WHERE r.id = ${taskRef} AND json_valid(ts.profile_json)
    UNION ALL SELECT json_extract(leg.value, '$.provider') FROM task_ref r JOIN task_scope ts ON ts.task_id = r.external_id,
      json_each(CASE WHEN json_valid(ts.proposed_route_json) THEN ts.proposed_route_json ELSE '{}' END, '$.legs') leg WHERE r.id = ${taskRef}`;
  return `(${pause}.provider IN (SELECT provider FROM (${providers}) WHERE provider IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM (${providers}) WHERE provider IS NOT NULL))`;
}

/** The open pause the dispatch gate last left this task waiting on, while it
 * is still on one of the task's providers; or null. */
export function authWaitOf(store: Store, taskRef: number): AuthPause | null {
  const row = store.handle.prepare(`SELECT p.* FROM task_ref r JOIN provider_auth_pause p ON p.id = r.auth_wait_pause
    WHERE r.id = ? AND p.lifted_at IS NULL AND ${pauseOnTaskProviders("p", "r.id")}`).get(taskRef);
  return row === undefined ? null : readPause(row);
}

/** Every open pause, oldest first. */
export function openAuthPauses(store: Store): AuthPause[] {
  return store.handle.prepare("SELECT * FROM provider_auth_pause WHERE lifted_at IS NULL ORDER BY id").all().map(readPause);
}

/**
 * Record an auth-expired run against its provider's pause, opening the
 * incident (and its one notification) when none is open. Called inside the
 * run's own failure transaction. Returns whether this run opened it.
 */
export function pauseForAuth(
  store: Store,
  args: { provider: string; authMode: "subscription" | "api-key" | null; runId: number; taskRef: number; now: Date },
): { opened: boolean; pause: AuthPause } {
  return store.transact(() => {
    const db = store.handle;
    const open = authPauseOf(store, args.provider);
    if (open !== null) {
      db.prepare("UPDATE provider_auth_pause SET runs = runs + 1 WHERE id = ?").run(open.id);
      return { opened: false, pause: { ...open, runs: open.runs + 1 } };
    }
    const ordinal = Number(db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM provider_auth_pause WHERE provider = ?").get(args.provider)?.["n"] ?? 1);
    const inserted = db.prepare(`INSERT INTO provider_auth_pause (provider, ordinal, auth_mode, opened_at, first_run, task_ref)
      VALUES (?, ?, ?, ?, ?, ?)`).run(args.provider, ordinal, args.authMode ?? "subscription", args.now.toISOString(), args.runId, args.taskRef);
    const pause = readPause(db.prepare("SELECT * FROM provider_auth_pause WHERE id = ?").get(Number(inserted.lastInsertRowid))!);
    notifyOperators(store, `auth-expired:${pause.provider}:${pause.ordinal}`, {
      kind: "auth-expired",
      subject: signInReason(pause),
      body: `Run \`${messageCommand(pause)}\` on this computer. Its tasks wait in the queue; one is tried every 10 minutes and the rest start again on their own once ${providerName(pause.provider)} works (or run \`toolroll providers resume ${pause.provider}\`).`,
    }, args.now);
    return { opened: true, pause };
  });
}

/**
 * One message per instance operator, addressed to them: only someone at this
 * computer can sign an agent back in, and a personal notification reaches that
 * person on every channel they paired (Telegram, Slack, Discord, Teams) and in
 * the console, whichever projects those channels follow.
 */
function notifyOperators(store: Store, key: string, message: { kind: string; subject: string; body: string }, now: Date): void {
  const operators = store.accountFacts().map(one => one.name).filter(name => store.isInstanceOperator(name));
  for (const recipient of operators) {
    store.enqueueNotification({
      dedupeKey: `${SIGN_IN_KEY_PREFIX}${key}:${recipient}`,
      kind: message.kind,
      pushClass: "attention",
      link: "/work",
      subject: message.subject,
      body: message.body,
      recipient,
      source: { installation: true },
    }, now);
  }
}

/**
 * Lift a provider's open pause — a run or probe on it succeeded, or a person
 * resumed it — and send the one short "signed in again" message. Returns the
 * number of tasks its incident sent back to the queue, or null when nothing
 * was paused.
 */
export function liftAuthPause(
  store: Store,
  provider: string,
  how: "run" | "probe" | "person",
  by: string,
  now: Date,
  /** For a run: when it started. A run that began before the pause opened proves nothing about the sign-in now. */
  runStartedAt?: Date,
): { resumed: number; pause: AuthPause } | null {
  return store.transact(() => {
    const pause = authPauseOf(store, provider);
    if (pause === null) return null;
    if (runStartedAt !== undefined && runStartedAt.getTime() < Date.parse(pause.openedAt)) return null;
    const resumed = Number(store.handle.prepare(`SELECT COUNT(DISTINCT task_ref) AS n FROM run
      WHERE provider = ? AND reason = 'auth-expired' AND finished_at >= ?`).get(provider, pause.openedAt)?.["n"] ?? 0);
    store.handle.prepare("UPDATE provider_auth_pause SET lifted_at = ?, lifted_by = ?, lifted_how = ?, resumed = ? WHERE id = ? AND lifted_at IS NULL")
      .run(now.toISOString(), by.slice(0, 120), how, resumed, pause.id);
    const name = providerName(provider);
    notifyOperators(store, `auth-restored:${pause.provider}:${pause.ordinal}`, {
      kind: "auth-restored",
      subject: `${name} is signed in again, ${resumed} ${resumed === 1 ? "task" : "tasks"} resumed`,
      body: how === "person" ? `Resumed by ${by.slice(0, 80)}.` : `A ${how === "run" ? "run" : "sign-in check"} on ${name} worked.`,
    }, now);
    if (how === "person") {
      store.recordAction({ at: now.toISOString(), actor: by.slice(0, 120), repo: null, taskId: null, runId: null,
        action: `resumed ${name} after a sign-in pause`, outcome: "resumed", source: "request", detail: `${resumed} ${resumed === 1 ? "task" : "tasks"}` });
    }
    store.bumpWake();
    return { resumed, pause };
  });
}

/**
 * What a non-spending sign-in probe said. A probe lifts the pause only after
 * one during the same pause saw the provider signed out: a CLI that reports
 * "logged in" while its session cannot refresh must not lift and re-open the
 * pause over and over.
 */
export function noteSignInProbe(store: Store, provider: string, state: string, now: Date): { resumed: number } | null {
  const pause = authPauseOf(store, provider);
  if (pause === null) return null;
  if (state === "signed-out" || state === "key-refused" || state === "missing-key") {
    store.handle.prepare("UPDATE provider_auth_pause SET probe_saw_out = 1 WHERE id = ?").run(pause.id);
    return null;
  }
  if (state !== "connected" && state !== "key-works") return null;
  const sawOut = Number(store.handle.prepare("SELECT probe_saw_out FROM provider_auth_pause WHERE id = ?").get(pause.id)?.["probe_saw_out"] ?? 0) === 1;
  if (!sawOut) return null;
  const lifted = liftAuthPause(store, provider, "probe", "sign-in check", now);
  return lifted === null ? null : { resumed: lifted.resumed };
}

/** How often a paused provider lets one task through as a trial. */
export const AUTH_TRIAL_MS = 10 * 60_000;

/** A trial taken: the pause, when it was taken, and the trial time it replaced. */
export type AuthTrial = { pauseId: number; takenAt: string; previous: string | null };

/**
 * Whether this task may go ahead as the paused provider's trial: at most one
 * every AUTH_TRIAL_MS. A trial that works lifts the pause (its run proves the
 * sign-in); one that fails the same way only counts against the open
 * incident, so nobody is told twice. Null when no trial is due.
 */
export function claimAuthTrial(store: Store, pause: AuthPause, now: Date): AuthTrial | null {
  return store.transact(() => {
    const due = new Date(now.getTime() - AUTH_TRIAL_MS).toISOString();
    const row = store.handle.prepare("SELECT last_trial_at FROM provider_auth_pause WHERE id = ?").get(pause.id);
    const previous = row?.["last_trial_at"] == null ? null : String(row["last_trial_at"]);
    const takenAt = now.toISOString();
    const claimed = store.handle.prepare(`UPDATE provider_auth_pause SET last_trial_at = ?
      WHERE id = ? AND lifted_at IS NULL AND COALESCE(last_trial_at, opened_at) <= ?`).run(takenAt, pause.id, due);
    return Number(claimed.changes) === 1 ? { pauseId: pause.id, takenAt, previous } : null;
  });
}

/** Give a trial back when its task never started (its claim failed), so the next pass may take it. */
export function giveBackAuthTrial(store: Store, trial: AuthTrial): void {
  store.handle.prepare("UPDATE provider_auth_pause SET last_trial_at = ? WHERE id = ? AND last_trial_at = ? AND lifted_at IS NULL")
    .run(trial.previous, trial.pauseId, trial.takenAt);
}

/** What the sign-in gate decided: the open pause the work waits on, or null
 * when it may go ahead; and, when it goes ahead as a pause's trial, how to
 * give that trial back if its claim then fails. */
export type SignInGate = { waiting: AuthPause | null; giveBack: () => void };

/**
 * The sign-in gate every road that starts an agent asks before it claims
 * anything: the tick's queue and the roads beside it.
 * Waits when a provider is paused,
 * unless this is the pause's one trial. A waiting task is noted on its
 * task_ref, so the work index says exactly what the gate decided; a task let
 * through is un-noted. A road whose claim fails after a trial calls giveBack.
 */
export function signInGate(store: Store, providers: readonly string[], now: Date, taskRef?: number): SignInGate {
  const pause = [...new Set(providers)].map(one => authPauseOf(store, one)).find(one => one !== null) ?? null;
  const trial = pause === null ? null : claimAuthTrial(store, pause, now);
  const waiting = pause !== null && trial === null ? pause : null;
  if (taskRef !== undefined) {
    store.handle.prepare("UPDATE task_ref SET auth_wait_pause = ? WHERE id = ? AND auth_wait_pause IS NOT ?").run(waiting?.id ?? null, taskRef, waiting?.id ?? null);
  }
  let given = false;
  return {
    waiting,
    giveBack: () => {
      if (trial === null || given) return;
      given = true;
      giveBackAuthTrial(store, trial);
    },
  };
}

/** The loop beside the console: every two minutes, probe each paused
 * provider's sign-in (no model, nothing spent) and lift the pause when it
 * works again. Nothing is probed while nothing is paused. */
export function startSignInProbes(
  store: Store,
  check: (provider: ProviderId, fresh?: boolean) => Promise<{ state: string }>,
  everyMs = 120_000,
): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const pause of openAuthPauses(store)) {
        try { noteSignInProbe(store, pause.provider, (await check(pause.provider, true)).state, new Date()); } catch { /* the next pass asks again */ }
      }
    } catch { /* the next pass asks again */ } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, everyMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** The console's view of every open pause: title, command, one action. */
export function signInNotices(store: Store): { provider: string; title: string; command: string; detail: string; resumeLabel: string; resumeHref: string }[] {
  return openAuthPauses(store).map(pause => ({
    provider: pause.provider,
    title: signInReason(pause),
    command: signInCommand(pause),
    detail: "",
    resumeLabel: `Resume ${providerName(pause.provider)}`,
    resumeHref: `/providers/${pause.provider}/resume`,
  }));
}
