import { TASK_TEXT_LIMITS, validateScopeText } from "./task-text.js";
/**
 * Proposals over the MCP gateway (mate arc v3, §9). A coordinator may
 * propose what the mate may propose — next, reserve, hold, unhold, scope,
 * cancel, answer — and a row is all it writes: any approver whose ceiling
 * admits the repo confirms it through `confirmCoordinatorProposal`. The
 * token re-authenticates INSIDE the transaction (the session's `who` is a
 * courtesy, exactly as for filing); the proposal counts against the
 * credential's hourly filing rate and a per-credential pending cap; the
 * payload carries the same CAS material the mate's does, so a stale row
 * refuses at the door in the same words.
 */
import type { CoordinatorProposalKind, Store } from "./store.js";
import { authenticateCoordinator, type VerifiedCoordinator } from "./coordinator.js";
import { decisionOver, honestText, readTouches, readAcceptanceArg } from "./mate-tools.js";

export const PER_CID_PENDING_PROPOSALS = 20;

export type ProposeOutcome =
  | { ok: true; id: number; kind: CoordinatorProposalKind; awaiting: string }
  | { ok: false; reason: "unauthenticated" | "revoked" | "rate-limited" | "pending-cap" | "not-found" | "bad-args" | "not-proposable"; message: string };

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The coordinator's proposal as a row; the shape of `args` is the MCP tool's. */
export function proposeAsCoordinator(
  store: Store,
  token: string,
  kind: CoordinatorProposalKind,
  args: Record<string, unknown>,
  now: Date,
  /** The decisions this connection has read with get_decision — an answer needs one (v3 review, finding 6). */
  seen: { readDecisions: ReadonlySet<number> } = { readDecisions: new Set() },
): ProposeOutcome {
  return store.transact(() => {
    store.sweepCoordinatorProposals(now);
    const auth = authenticateCoordinator(store, token);
    if (!auth.ok) {
      return auth.reason === "revoked" || auth.reason === "expired"
        ? { ok: false as const, reason: "revoked" as const, message: auth.reason === "expired" ? "this credential expired — ask the operator for a new one" : "this credential was revoked — ask the operator for a new one" }
        : { ok: false as const, reason: "unauthenticated" as const, message: "no live coordinator credential matches this token" };
    }
    const { who } = auth;
    // Filings and proposals share the hourly window: both are asks of the
    // operator's attention.
    const windowStart = new Date(now.getTime() - 3_600_000);
    const filed = Number(
      store.handle.prepare("SELECT COUNT(*) AS n FROM coordinator_event WHERE cid = ? AND kind = 'filed' AND created_at > ?").get(who.cid, windowStart.toISOString())?.["n"] ?? 0,
    );
    const proposed = store.coordinatorProposalsSince(who.cid, windowStart);
    if (filed + proposed >= who.perHour) {
      return { ok: false as const, reason: "rate-limited" as const, message: `rate-limited: ${filed + proposed} filed or proposed in the last hour — try later` };
    }
    const pending = store.listCoordinatorProposals({ repos: null, cid: who.cid, states: ["pending"], limit: PER_CID_PENDING_PROPOSALS + 1 }).length;
    if (pending >= PER_CID_PENDING_PROPOSALS) {
      return { ok: false as const, reason: "pending-cap" as const, message: `${pending} of your proposals are still waiting on the operator — they resolve before more file` };
    }
    const built = buildPayload(store, who, kind, args, now, seen);
    if (!built.ok) return built;
    const id = store.fileCoordinatorProposalRow({ cid: who.cid, name: who.name, repo: built.repo, kind, payload: built.payload }, now);
    return { ok: true as const, id, kind, awaiting: built.awaiting };
  });
}

type Built = { ok: true; repo: string; payload: Record<string, unknown>; awaiting: string } | (ProposeOutcome & { ok: false });

function admittedTask(store: Store, who: VerifiedCoordinator, args: Record<string, unknown>): { taskId: string; refId: number; repo: string } | null {
  const raw = args["ref"];
  if (typeof raw !== "string" || !TASK_ID.test(raw)) return null;
  const ref = store.lookupRef(raw);
  if (ref === null || ref.repo === null || !who.repos.includes(ref.repo)) return null;
  return { taskId: raw, refId: ref.id, repo: ref.repo };
}

function buildPayload(store: Store, who: VerifiedCoordinator, kind: CoordinatorProposalKind, args: Record<string, unknown>, now: Date, seen: { readDecisions: ReadonlySet<number> }): Built {
  const notFound = (): Built => ({ ok: false, reason: "not-found", message: "not-found: no such task in your repositories" });
  const bad = (message: string): Built => ({ ok: false, reason: "bad-args", message });
  const confirmation = "the operator's confirmation";

  if (kind === "answer") {
    const decisionId = args["decision"];
    if (typeof decisionId !== "number" || !Number.isInteger(decisionId) || decisionId < 1) return bad("decision is its id");
    const found = decisionOver(store, who.repos, decisionId, now);
    if (found === null) return { ok: false, reason: "not-found", message: "not-found: no such decision in your repositories" };
    if (found["state"] !== "open") return { ok: false, reason: "not-proposable", message: "that decision is no longer open" };
    if (!seen.readDecisions.has(decisionId)) return { ok: false, reason: "not-proposable", message: "read the decision first with get_decision — an answer chosen without its consequences is a guess" };
    const options = found["options"] as { id: string; label: string; reversible: boolean }[];
    const chosen = options.find(one => one.id === args["option"]);
    if (chosen === undefined) return bad(`option must be one of ${options.map(one => one.id).join(", ")}`);
    if (!honestText(args["rationale"], 400)) return bad("rationale is plain text ≤400");
    const repo = who.repos[found["repoIndex"] as number] as string;
    return {
      ok: true,
      repo,
      payload: { decision: decisionId, task: found["task"], option: chosen.id, optionLabel: chosen.label, reversible: chosen.reversible, rationale: args["rationale"], readConsequences: true },
      awaiting: chosen.reversible ? confirmation : "the operator's explicit confirmation — this option is irreversible",
    };
  }

  const task = admittedTask(store, who, args);
  if (task === null) return notFound();

  if (kind === "next") {
    const position = store.queuePosition(task.taskId);
    if (position === null) return { ok: false, reason: "not-proposable", message: "that task is not queued" };
    if (position.position === 1) return { ok: false, reason: "not-proposable", message: "that task is already at the front of its column" };
    return { ok: true, repo: task.repo, payload: { task: task.taskId, queueRevision: store.queueRevision(), position: position.position, of: position.total, column: position.column }, awaiting: confirmation };
  }
  if (kind === "reserve") {
    const worker = args["worker"];
    if (worker !== null && (typeof worker !== "string" || !store.listRunners().some(one => one.name === worker && one.retiredAt === null))) {
      return bad("worker must be a registered, active worker name, or null for the shared queue");
    }
    const position = store.queuePosition(task.taskId);
    if (position === null) return { ok: false, reason: "not-proposable", message: "that task is not queued" };
    if ((position.column ?? null) === worker) return { ok: false, reason: "not-proposable", message: "that task is already in that column" };
    return { ok: true, repo: task.repo, payload: { task: task.taskId, worker, queueRevision: store.queueRevision(), position: position.position, column: position.column }, awaiting: confirmation };
  }
  if (kind === "hold") {
    if (!honestText(args["reason"], 200)) return bad("reason is plain text ≤200");
    const existing = store.activeHolds(task.refId, now).find(one => one.ownerKind === "operator");
    return { ok: true, repo: task.repo, payload: { task: task.taskId, reason: args["reason"], sawHold: existing?.id ?? null }, awaiting: confirmation };
  }
  if (kind === "unhold") {
    const hold = store.activeHolds(task.refId, now).find(one => one.ownerKind === "operator");
    if (hold === undefined) return { ok: false, reason: "not-proposable", message: "the operator holds no hold on that task" };
    return { ok: true, repo: task.repo, payload: { task: task.taskId, holdId: hold.id }, awaiting: confirmation };
  }
  if (kind === "scope") {
    if (typeof args["goal"] !== "string" || (args["not"] != null && typeof args["not"] !== "string")) return bad("Goal and exclusions must be text.");
    const badText = validateScopeText({ goal: args["goal"], outOfScope: args["not"] as string | null | undefined ?? null });
    if (badText !== null) return bad(badText.message);
    const not = args["not"] as string | null | undefined ?? null;
    if (!honestText(args["goal"], TASK_TEXT_LIMITS.text) || (not !== null && not.trim() !== "" && !honestText(not, TASK_TEXT_LIMITS.text))) return bad("Task text cannot contain credentials.");
    const touches = readTouches(args["touches"]);
    if (touches === null) return bad("touches is up to 50 plain paths");
    const acceptance = readAcceptanceArg(args["acceptance"]);
    if (acceptance === null) return bad("acceptance is required: at least one criterion with an id, statement, and evidence kinds");
    if (store.hasLiveClaim(task.refId, now)) return { ok: false, reason: "not-proposable", message: "a worker is building that task right now — its scope cannot change under it" };
    const scope = store.getScope(task.taskId);
    return { ok: true, repo: task.repo, payload: { task: task.taskId, goal: args["goal"], not, touches, acceptance, sawDigest: scope?.digest ?? null }, awaiting: "the operator's confirmation, then a password to approve" };
  }
  if (kind === "cancel") {
    if (!honestText(args["reason"], 200)) return bad("reason is plain text ≤200");
    return { ok: true, repo: task.repo, payload: { task: task.taskId, reason: args["reason"] }, awaiting: "the operator arming the cancel on the task" };
  }
  return bad("unknown proposal kind");
}
