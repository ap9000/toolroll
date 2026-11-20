/** Launch-scoped authority only. No production caller in slice 1; no turn or accounting operations. */
import { randomBytes } from "node:crypto";
import { flexibleDelegationAtUse, flexibleRuntime } from "./flexible.js";
import { flexibleStartCard } from "./flexible-start.js";
import { threadLevelAllowed } from "./flexible-levels.js";
import { flexibleLaunch, reserveLaunchOpen } from "./flexible-launch.js";
import { signInForInteractiveStands, signInEpochOf } from "./flexible-sign-in.js";
import type { Store } from "./store.js";

export function interactiveSession(store: Store, id: string): Record<string, unknown> | null {
  return store.handle.prepare("SELECT * FROM flexible_interactive_session WHERE id = ?").get(id) ?? null;
}

/** Approve and prepare against current trusted records, in one transaction. The launch's fence is its approved
 * launch configuration, never a caller-supplied replacement. The exact start key also binds runtime and helpers. */
export function prepareInteractiveSession(store: Store, input: { thread: string; launch: string; holder: string;
  by: { name: string; generation: number }; startKey: string; model: string; helperModels: string[]; message: string; now: Date }): string | null {
  return store.transact(() => {
    const thread = store.handle.prepare("SELECT * FROM flexible_thread WHERE id = ?").get(input.thread);
    const launch = flexibleLaunch(store, input.launch);
    if (thread === undefined || thread["state"] !== "ready" || thread["created_by"] !== input.by.name
      || flexibleRuntime(store, input.thread) !== "interactive" || launch === null || launch.thread !== input.thread || launch.holder !== input.holder
      || launch.provider !== "claude" || launch.level !== "full" || launch.turn !== null || launch.state !== "spawning") return null;
    if (store.handle.prepare("SELECT 1 FROM flexible_thread_meta WHERE thread = ? AND ended_at IS NOT NULL").get(input.thread)
      || store.handle.prepare("SELECT 1 FROM flexible_interactive_session WHERE launch = ?").get(input.launch)) return null;
    const made = flexibleStartCard(store, { repo: String(thread["repo"]), by: input.by, runtime: "interactive", model: input.model, helperModels: input.helperModels, message: input.message });
    if (!made.ok || made.card.summary.key !== input.startKey) return null;
    const approved = flexibleDelegationAtUse(store, { repo: String(thread["repo"]), starter: input.by, digest: made.card.digest, level: "full", freshProof: false });
    if (!approved.ok || !interactiveLaunchRoom(store, input.thread, String(thread["repo"]), approved.terms.caps.liveThreads)) return null;
    const id = randomBytes(16).toString("hex");
    store.handle.prepare(`INSERT INTO flexible_interactive_session
      (id, thread, launch, holder, owner, account_generation, runtime, provider, billing, terms_id, terms_digest, start_key, message, level, model,
       helper_models, fence_digest, network_digest, sign_in_epoch, state, prepared_at)
      VALUES (?, ?, ?, ?, ?, ?, 'interactive', 'claude', 'subscription', ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, 'prepared', ?)`)
      .run(id, input.thread, input.launch, input.holder, input.by.name, input.by.generation, approved.termsId, approved.digest, input.startKey, input.message,
        made.card.model, JSON.stringify(made.card.helperModels), launch.fenceDigest, made.card.network, signInEpochOf(store, input.by.name), input.now.toISOString());
    return id;
  });
}

/** Recheck all non-accounting authority immediately before activation. Registration must already be durable.
 * Slice 3 supplies the real final launch authorization callback; it runs here inside the same transaction.
 * A boolean supplied earlier, a viewer permit or a controller lease is never an authorization input. */
export function activateInteractiveSession(store: Store, input: { session: string; holder: string; now: Date; authorizeLaunch: () => string | null }): boolean {
  return store.transact(() => {
    const session = interactiveSession(store, input.session);
    if (session === null || session["state"] !== "prepared" || session["holder"] !== input.holder) return false;
    const threadId = String(session["thread"]), owner = String(session["owner"]);
    const thread = store.handle.prepare("SELECT * FROM flexible_thread WHERE id = ?").get(threadId);
    const launch = flexibleLaunch(store, String(session["launch"]));
    if (thread === undefined || thread["state"] !== "ready" || thread["created_by"] !== owner || flexibleRuntime(store, threadId) !== "interactive"
      || launch === null || launch.thread !== threadId || launch.holder !== input.holder || launch.state !== "live" || launch.leaderPid === null || launch.leaderStart === null
      || launch.turn !== null || launch.provider !== "claude" || launch.level !== "full" || launch.fenceDigest !== session["fence_digest"]
      || thread["live_pid"] !== launch.leaderPid || signInEpochOf(store, owner) !== session["sign_in_epoch"]
      || store.handle.prepare("SELECT 1 FROM flexible_stop_request WHERE launch = ?").get(launch.id)
      || store.handle.prepare("SELECT 1 FROM flexible_thread_meta WHERE thread = ? AND ended_at IS NOT NULL").get(threadId)) return false;
    const by = { name: owner, generation: Number(session["account_generation"]) };
    if (!signInForInteractiveStands(store, input.session)) return false;
    const approved = flexibleDelegationAtUse(store, { repo: String(thread["repo"]), starter: by, digest: String(session["terms_digest"]), level: "full", freshProof: false });
    if (!approved.ok || approved.termsId !== session["terms_id"] || !interactiveLaunchRoom(store, threadId, String(thread["repo"]), approved.terms.caps.liveThreads)) return false;
    const level = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(threadId);
    if (level !== undefined && level["level"] !== "full") return false;
    const made = flexibleStartCard(store, { repo: String(thread["repo"]), by, runtime: "interactive", model: String(session["model"]),
      helperModels: JSON.parse(String(session["helper_models"])) as string[], message: String(session["message"]) });
    if (!made.ok || made.card.summary.key !== session["start_key"] || made.card.network !== session["network_digest"]) return false;
    const why = reserveLaunchOpen(store, { launch: launch.id, thread: threadId, turn: null, clock: () => input.now, check: input.authorizeLaunch });
    if (why !== null) return false;
    return Number(store.handle.prepare("UPDATE flexible_interactive_session SET state = 'active', activated_at = ? WHERE id = ? AND state = 'prepared'")
      .run(input.now.toISOString(), input.session).changes) === 1;
  });
}

/** Explicit revocation, monotonic and idempotent; the first reason is retained. */
export function endInteractiveSession(store: Store, input: { session: string; reason: string; now: Date }): boolean {
  return store.transact(() => {
    const session = interactiveSession(store, input.session);
    if (session === null || session["state"] === "ended") return false;
    store.handle.prepare("UPDATE flexible_interactive_session SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND state <> 'ended'")
      .run(input.now.toISOString(), input.reason, input.session);
    store.handle.prepare("INSERT INTO flexible_stop_request (launch, thread, reason, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT (launch) DO NOTHING")
      .run(session["launch"], session["thread"], input.reason, input.now.toISOString());
    return true;
  });
}

/** Retain concurrent-thread and proven-level safeguards, without daily turns, spend, reservations or accounting. */
function interactiveLaunchRoom(store: Store, thread: string, repo: string, projectLimit: number): boolean {
  if (!threadLevelAllowed(store.orgPolicy(), "claude", "full").ok) return false;
  const working = store.handle.prepare(`SELECT DISTINCT t.id, t.repo FROM flexible_thread t WHERE t.id <> ? AND (
    EXISTS (SELECT 1 FROM flexible_thread_launch l WHERE l.thread = t.id AND l.state <> 'exited') OR
    EXISTS (SELECT 1 FROM thread_turn x WHERE x.thread = t.id AND x.status IN ('admitted', 'running')))`)
    .all(thread);
  if (working.filter(one => one["repo"] === repo).length >= projectLimit) return false;
  const installation = store.handle.prepare("SELECT live_threads FROM flexible_installation_caps WHERE id = 1").get()?.["live_threads"];
  return installation === null || installation === undefined || working.length < Number(installation);
}
