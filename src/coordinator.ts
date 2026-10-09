/**
 * The coordinator principal (MCP gateway spec v6; DESIGN.md §9b).
 *
 * A coordinator is the ONE credential the MCP surface accepts: minted by
 * an operator password ceremony, hashed at rest, repo-scoped at the mint,
 * rate-limited, revocable — and able to do exactly one thing: file a
 * proposal through the canonical door. What it files is an ordinary
 * UNAPPROVED task; admission is the operator's existing scope ceremony,
 * and the quarantine (sealScopeApproval's mode-kind refusal + the claim
 * primitive's exclusion) keeps every pre-seal road shut.
 *
 * The brand: `VerifiedCoordinator` is disjoint from the operator's
 * `VerifiedAuthor` by construction, and its maker is module-private —
 * the exported-cast mistake is named in the spec and not repeated here.
 * Steering and every operator-speech surface cannot accept this type.
 */

import { createHash, randomBytes } from "node:crypto";
import { canonicalRepos } from "./runner.js";
import { fileTaskProposal } from "./proposal.js";
import { describeScope } from "./scope.js";
import { reportSummaryFor } from "./lead-tools.js";
import type { Store } from "./store.js";
import { taskWorkSummaryOf, type WorkSummary } from "./work-summary.js";
import { assignmentOf, assignmentBrief } from "./assignment.js";

declare const verifiedCoordinatorBrand: unique symbol;
export type VerifiedCoordinator = {
  readonly [verifiedCoordinatorBrand]: true;
  readonly cid: string;
  readonly name: string;
  readonly repos: readonly string[];
  readonly perHour: number;
};

/** Module-private: the ONLY maker, reachable only through the token
 * verification below. Never exported, never a cast at a call site. */
function verified(row: { cid: string; name: string; repos: string[]; perHour: number }): VerifiedCoordinator {
  return row as unknown as VerifiedCoordinator;
}

const NAME = /^[a-z0-9-]{1,32}$/;
const CID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY = /^[\x21-\x7e]{8,64}$/;

function hashSecret(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintCid(): string {
  const bytes = randomBytes(12);
  let cid = "";
  for (const b of bytes) cid += CID_ALPHABET[b % CID_ALPHABET.length];
  return cid;
}

export type MintResult =
  | { ok: true; cid: string; token: string; repos: string[] }
  | { ok: false; reason: "bad-name" | "name-taken" | "bad-rate" | "no-repos" };

export function mintCoordinator(
  store: Store,
  input: {
    name: string;
    repos: readonly string[];
    perHour?: number;
    by: string;
    now: Date;
    /** v101: how long it lives (90 days unless said; at most a year). */
    days?: number;
    /** Injected in tests. */
    newToken?: () => string;
    newCid?: () => string;
  },
): MintResult {
  const days = input.days ?? 90;
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: "bad-rate" };
  const expiresAt = new Date(input.now.getTime() + days * 86_400_000).toISOString();
  const name = input.name.normalize("NFC");
  if (!NAME.test(name)) return { ok: false, reason: "bad-name" };
  const perHour = input.perHour ?? 6;
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > 60) return { ok: false, reason: "bad-rate" };
  if (input.repos.length === 0) return { ok: false, reason: "no-repos" };
  const repos = canonicalRepos(input.repos);
  const token = (input.newToken ?? (() => randomBytes(32).toString("base64url")))();

  return store.transact(() => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cid = (input.newCid ?? mintCid)();
      try {
        store.handle
          .prepare(
            `INSERT INTO coordinator_credential (cid, name, credential_hash, repos, per_hour, created_by, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(cid, name, hashSecret(token), JSON.stringify(repos), perHour, input.by, input.now.toISOString(), expiresAt);
        return { ok: true as const, cid, token, repos };
      } catch (error) {
        const said = String(error);
        // The live-name unique index answers "taken"; a cid collision
        // (astronomically rare) retries with a fresh one.
        if (said.includes("coordinator_live_name")) return { ok: false as const, reason: "name-taken" as const };
        if (!said.includes("PRIMARY KEY") && !said.includes("UNIQUE")) throw error;
      }
    }
    return { ok: false as const, reason: "name-taken" as const };
  });
}

export type CoordinatorAuth =
  | { ok: true; who: VerifiedCoordinator }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

/** The token IS the identity — no name travels with it. Verified against
 * the stored hash; the caller re-runs this INSIDE any mutating
 * transaction (the startup check is a courtesy; the txn check is law). */
export function authenticateCoordinator(store: Store, token: string): CoordinatorAuth {
  const row = store.handle
    .prepare("SELECT * FROM coordinator_credential WHERE credential_hash = ?")
    .get(hashSecret(token));
  if (row === undefined) return { ok: false, reason: "unknown" };
  if (row["revoked_at"] !== null) return { ok: false, reason: "revoked" };
  // v101: a credential made with an expiry stops at it (one made before expiry existed lives until it's renewed or revoked).
  if (row["expires_at"] != null && Date.parse(String(row["expires_at"])) <= Date.now()) return { ok: false, reason: "expired" };
  return {
    ok: true,
    who: verified({
      cid: String(row["cid"]),
      name: String(row["name"]),
      repos: JSON.parse(String(row["repos"])) as string[],
      perHour: Number(row["per_hour"]),
    }),
  };
}

export function revokeCoordinator(
  store: Store,
  cid: string,
  by: string,
  now: Date,
): { ok: true } | { ok: false; reason: "unknown" | "already-revoked" } {
  return store.transact(() => {
    const row = store.handle.prepare("SELECT revoked_at FROM coordinator_credential WHERE cid = ?").get(cid);
    if (row === undefined) return { ok: false as const, reason: "unknown" as const };
    if (row["revoked_at"] !== null) return { ok: false as const, reason: "already-revoked" as const };
    store.handle
      .prepare("UPDATE coordinator_credential SET revoked_at = ? WHERE cid = ?")
      .run(now.toISOString(), cid);
    // The revocation event rides the SAME transaction as the state change,
    // and the credential's pending proposals expire with it (mate arc v3).
    store.handle
      .prepare("INSERT INTO coordinator_event (cid, kind, detail, created_at) VALUES (?, 'revoked', ?, ?)")
      .run(cid, `by ${by}`, now.toISOString());
    store.sweepCoordinatorProposals(now, cid);
    return { ok: true as const };
  });
}

export type CoordinatorRow = {
  cid: string;
  name: string;
  repos: string[];
  perHour: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  lastFiledAt: string | null;
  /** v101: when it stops (null: made before expiry existed, until renewed). */
  expiresAt: string | null;
};

export function listCoordinators(store: Store): CoordinatorRow[] {
  return store.handle
    .prepare(
      `SELECT c.*, (SELECT MAX(e.created_at) FROM coordinator_event e WHERE e.cid = c.cid AND e.kind = 'filed') AS last_filed
         FROM coordinator_credential c ORDER BY c.created_at, c.cid`,
    )
    .all()
    .map(row => ({
      cid: String(row["cid"]),
      name: String(row["name"]),
      repos: JSON.parse(String(row["repos"])) as string[],
      perHour: Number(row["per_hour"]),
      createdBy: String(row["created_by"]),
      createdAt: String(row["created_at"]),
      revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
      lastFiledAt: row["last_filed"] === null ? null : String(row["last_filed"]),
      expiresAt: row["expires_at"] == null ? null : String(row["expires_at"]),
    }));
}

/** What each artifact kind IS on the wire — evidence metadata carries a
 * media type so a client knows what it would be asking for (round-2 f4). */
const MEDIA_BY_KIND: Record<string, string> = {
  diff: "text/x-diff",
  "terminal-diff": "text/x-diff",
  "diff-stat": "application/json",
  status: "text/plain",
  "park-payload": "application/json",
  plan: "text/markdown",
  handoff: "application/json",
  "revision-brief": "text/markdown",
  "base-tree": "text/plain",
};

/** Outstanding = filed by this cid, scope UNSEALED (missing seal or a
 * stale digest both count), task not done/cancelled — `failed` COUNTS:
 * dead unsealed filings pressure cleanup, not silence. */
const OUTSTANDING_SQL = `
  SELECT COUNT(*) AS n FROM task_ref
    JOIN task ON task.id = task_ref.external_id AND task_ref.backend = 'built-in'
    LEFT JOIN task_scope ON task_scope.task_id = task_ref.external_id
   WHERE task_ref.coordinator_cid IS NOT NULL
     AND task.state NOT IN ('done','cancelled')
     AND (task_scope.task_id IS NULL
          OR task_scope.approved_at IS NULL
          OR task_scope.approved_digest IS NOT task_scope.digest)`;

export const PER_CID_OUTSTANDING = 10;
export const GLOBAL_OUTSTANDING = 50;

export type FileOutcome =
  | { ok: true; id: string; replayed: boolean }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "revoked"
        | "bad-key"
        | "idempotency-conflict"
        | "rate-limited"
        | "outstanding-cap"
        | "global-cap"
        | string;
      message: string;
    };

/**
 * The one write the MCP surface owns, as ONE transaction: authenticate →
 * revocation re-check → replay lookup → rate window → caps → the
 * canonical door → the cid stamp → idempotency + event rows. The rate
 * window reads the event ledger (filings are events, so the window and
 * the audit cannot disagree), and a replay charges no slot.
 */
export function fileCoordinatorProposal(
  store: Store,
  token: string,
  input: { repo: string; title: string; intent?: string; idempotencyKey: string; deliverable?: "branch" | "report" },
  now: Date,
): FileOutcome {
  if (!KEY.test(input.idempotencyKey)) {
    return { ok: false, reason: "bad-key", message: "idempotency_key is 8–64 printable ASCII characters" };
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ repo: input.repo, title: input.title, intent: input.intent ?? null, ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable }) }), "utf8")
    .digest("hex");

  return store.transact(() => {
    // The law lives here: the token re-verifies INSIDE the transaction.
    const auth = authenticateCoordinator(store, token);
    if (!auth.ok) {
      return auth.reason === "revoked" || auth.reason === "expired"
        ? { ok: false as const, reason: "revoked" as const, message: auth.reason === "expired" ? "this credential expired — ask the operator for a new one" : "this credential was revoked — ask the operator for a new one" }
        : { ok: false as const, reason: "unauthenticated" as const, message: "no live coordinator credential matches this token" };
    }
    const { who } = auth;

    const replay = store.handle
      .prepare("SELECT request_digest, task_id FROM mcp_idempotency WHERE cid = ? AND key = ?")
      .get(who.cid, input.idempotencyKey);
    if (replay !== undefined) {
      if (String(replay["request_digest"]) !== digest) {
        return {
          ok: false as const,
          reason: "idempotency-conflict" as const,
          message: "this idempotency_key was already used for a DIFFERENT request — mint a new key",
        };
      }
      return { ok: true as const, id: String(replay["task_id"]), replayed: true };
    }

    const windowStart = new Date(now.getTime() - 3_600_000).toISOString();
    const filedRow = store.handle
      .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM coordinator_event WHERE cid = ? AND kind = 'filed' AND created_at > ?")
      .get(who.cid, windowStart);
    // Filings and proposals share the hourly window in BOTH directions
    // (v3 review, finding 2).
    const filed = Number(filedRow?.["n"] ?? 0) + store.coordinatorProposalsSince(who.cid, new Date(windowStart));
    if (filed >= who.perHour) {
      const oldest = String(filedRow?.["oldest"] ?? now.toISOString());
      const slotMs = new Date(oldest).getTime() + 3_600_000 - now.getTime();
      const minutes = Math.max(1, Math.ceil(slotMs / 60_000));
      return {
        ok: false as const,
        reason: "rate-limited" as const,
        message: `rate-limited: ${filed} filed in the last hour — next slot in ${minutes}m`,
      };
    }

    const mine = Number(store.handle.prepare(`${OUTSTANDING_SQL} AND task_ref.coordinator_cid = ?`).get(who.cid)?.["n"] ?? 0);
    if (mine >= PER_CID_OUTSTANDING) {
      return {
        ok: false as const,
        reason: "outstanding-cap" as const,
        message: `${mine} of your filings are still waiting on approval or dismissal — the operator resolves them before more file`,
      };
    }
    const everyone = Number(store.handle.prepare(OUTSTANDING_SQL).get()?.["n"] ?? 0);
    if (everyone >= GLOBAL_OUTSTANDING) {
      return {
        ok: false as const,
        reason: "global-cap" as const,
        message: `${everyone} coordinator filings are unresolved across the installation — the backlog resolves before more file`,
      };
    }

    // The canonical door: the credential's repo allowlist IS the ceiling,
    // and (since the empty-repo fix) a repo must be named inside it.
    const made = fileTaskProposal(
      store,
      {
        title: input.title,
        repo: input.repo,
        ...(input.intent === undefined
          ? {}
          : {
              goal: input.intent,
              // v39: a coordinator's intent is provisional pending the
              // operator's own review (the quarantine already refuses to
              // auto-approve anything a coordinator wrote) — a placeholder
              // criterion names that review as the outstanding work,
              // rather than blocking the filing on a rubric a remote
              // caller has no real standing to author.
              acceptance: [
                { id: "c1", statement: "The operator has reviewed this filing's intent and written a real rubric before approving it.", how: null, evidence: ["manual-review"] },
              ],
            }),
        ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable }),
        filedVia: `mcp:${who.name}`, filedBy: { name: (store.handle.prepare("SELECT created_by FROM coordinator_credential WHERE cid = ?").get(who.cid)?.["created_by"] as string | undefined) ?? null, kind: "coordinator" as const },
        admittedRepos: who.repos,
      },
      now,
    );
    if (!made.ok) return { ok: false as const, reason: made.reason, message: made.message };

    // The branded door's OWN write: the authoritative linkage column. No
    // other filer sets it; provenance is a join, never string parsing.
    store.handle
      .prepare("UPDATE task_ref SET coordinator_cid = ? WHERE backend = 'built-in' AND external_id = ? AND coordinator_cid IS NULL")
      .run(who.cid, made.id);
    store.handle
      .prepare("INSERT INTO mcp_idempotency (cid, key, request_digest, task_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(who.cid, input.idempotencyKey, digest, made.id, now.toISOString());
    store.handle
      .prepare("INSERT INTO coordinator_event (cid, kind, task_id, created_at) VALUES (?, 'filed', ?, ?)")
      .run(who.cid, made.id, now.toISOString());
    return { ok: true as const, id: made.id, replayed: false };
  });
}

// ---- credential-scoped reads (MCP spec v6: the allowlist intersected IN
// SQL, before aggregation, ordering, LIMIT, and counts; repo-null rows
// excluded from every result; a foreign ref answers not-found) ----------

function inClause(repos: readonly string[]): { sql: string; args: string[] } {
  return { sql: repos.map(() => "?").join(","), args: [...repos] };
}

export function statusFor(store: Store, who: VerifiedCoordinator, now: Date): {
  waitsOnYou: number;
  waits: { approvals: number; questions: number; incidents: number };
  running: number;
  builtToday: number;
  failedToday: number;
  repos: { repo: string; queued: number; running: number }[];
} {
  const { sql, args } = inClause(who.repos);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const one = (query: string, extra: string[] = []): number =>
    Number(store.handle.prepare(query).get(...args, ...extra)?.["n"] ?? 0);
  // "Waits on you" = the board's attention lanes over this allowlist:
  // unsealed scopes + open decisions on live runs.
  const unsealed = one(
    `SELECT COUNT(*) AS n FROM task_ref JOIN task ON task.id = task_ref.external_id AND task_ref.backend = 'built-in'
      LEFT JOIN task_scope ON task_scope.task_id = task_ref.external_id
      WHERE task_ref.repo IN (${sql}) AND task.state = 'queued'
        AND (task_scope.task_id IS NULL OR task_scope.approved_at IS NULL OR task_scope.approved_digest IS NOT task_scope.digest)`,
  );
  const questions = one(
    `SELECT COUNT(*) AS n FROM decision JOIN run ON run.id = decision.run
      JOIN task_ref ON task_ref.id = run.task_ref AND task_ref.backend = 'built-in'
      WHERE task_ref.repo IN (${sql}) AND decision.answered_at IS NULL AND decision.state IN ('open','expired')`,
  );
  // "Running" is lease-based liveness, never `outcome IS NULL` (review
  // finding 6): a live, unexpired, newest-generation claim.
  const running = one(
    `SELECT COUNT(DISTINCT claim.task_ref) AS n FROM claim
      JOIN task_ref ON task_ref.id = claim.task_ref AND task_ref.backend = 'built-in'
      WHERE task_ref.repo IN (${sql}) AND claim.released_at IS NULL AND claim.expires_at > ?
        AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest WHERE newest.task_ref = claim.task_ref)`,
    [now.toISOString()],
  );
  const incidents = one(
    `SELECT COUNT(*) AS n FROM incident JOIN run ON run.id = incident.run
      JOIN task_ref ON task_ref.id = run.task_ref AND task_ref.backend = 'built-in'
      WHERE task_ref.repo IN (${sql}) AND incident.resolved_at IS NULL`,
  );
  const builtToday = one(
    `SELECT COUNT(*) AS n FROM run JOIN task_ref ON task_ref.id = run.task_ref AND task_ref.backend = 'built-in'
      WHERE task_ref.repo IN (${sql}) AND run.outcome = 'built' AND run.finished_at > ?`,
    [dayAgo],
  );
  const failedToday = one(
    `SELECT COUNT(*) AS n FROM run JOIN task_ref ON task_ref.id = run.task_ref AND task_ref.backend = 'built-in'
      WHERE task_ref.repo IN (${sql}) AND run.outcome = 'failed' AND run.finished_at > ?`,
    [dayAgo],
  );
  const repos = store.handle
    .prepare(
      `SELECT task_ref.repo AS repo,
              SUM(CASE WHEN task.state = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN task.state = 'running' THEN 1 ELSE 0 END) AS running
         FROM task_ref JOIN task ON task.id = task_ref.external_id AND task_ref.backend = 'built-in'
        WHERE task_ref.repo IN (${sql}) GROUP BY task_ref.repo ORDER BY task_ref.repo`,
    )
    .all(...args)
    .map(row => ({ repo: String(row["repo"]), queued: Number(row["queued"]), running: Number(row["running"]) }));
  return {
    waitsOnYou: unsealed + questions + incidents,
    waits: { approvals: unsealed, questions, incidents },
    running,
    builtToday,
    failedToday,
    repos,
  };
}

export function listTasksFor(
  store: Store,
  who: VerifiedCoordinator,
  filter: { state?: string; repo?: string; cursor?: number; limit?: number },
  now: Date,
): { tasks: { ref: string; title: string; state: string; chip: string; repo: string; filedVia: string | null }[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
  const repos = filter.repo === undefined ? [...who.repos] : who.repos.includes(filter.repo) ? [filter.repo] : [];
  if (repos.length === 0) return { tasks: [], nextCursor: null };
  const { sql, args } = inClause(repos);
  const rows = store.handle
    .prepare(
      `SELECT task_ref.id AS rid, task.id AS tid, task.title AS title, task.state AS state, task_ref.repo AS repo, task_ref.filed_via AS via,
              EXISTS(SELECT 1 FROM claim WHERE claim.task_ref = task_ref.id AND claim.released_at IS NULL AND claim.expires_at > ?
                AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest WHERE newest.task_ref = claim.task_ref)) AS live,
              EXISTS(SELECT 1 FROM task_scope WHERE task_scope.task_id = task.id AND task_scope.approved_at IS NOT NULL AND task_scope.approved_digest = task_scope.digest) AS sealed
         FROM task_ref JOIN task ON task.id = task_ref.external_id AND task_ref.backend = 'built-in'
        WHERE task_ref.repo IN (${sql})
          AND (? IS NULL OR task.state = ?)
          AND task_ref.id > ?
        ORDER BY task_ref.id LIMIT ?`,
    )
    .all(now.toISOString(), ...args, filter.state ?? null, filter.state ?? null, filter.cursor ?? 0, limit + 1);
  const chipOf = (state: string, live: boolean, sealed: boolean): string => {
    if (live) return "building";
    if (state === "queued") return sealed ? "ready to build" : "waiting for approval";
    if (state === "running") return "running";
    if (state === "done") return "built";
    if (state === "failed") return "failed";
    return state;
  };
  const page = rows.slice(0, limit).map(row => ({
    ref: String(row["tid"]),
    title: String(row["title"]),
    state: String(row["state"]),
    chip: chipOf(String(row["state"]), Number(row["live"]) === 1, Number(row["sealed"]) === 1),
    repo: String(row["repo"]),
    filedVia: row["via"] === null ? null : String(row["via"]),
  }));
  const nextCursor = rows.length > limit ? Number(rows[limit - 1]?.["rid"] ?? 0) : null;
  return { tasks: page, nextCursor };
}

export function taskDetailFor(
  store: Store,
  who: VerifiedCoordinator,
  taskId: string,
  evidenceRoot?: string,
  now: Date = new Date(),
): {
  ref: string; title: string; state: string; repo: string;
  work: WorkSummary | null;
  assignment: ReturnType<typeof assignmentBrief>;
  deliverable: "branch" | "report";
  /** A finished scout's report (mate arc §10); null when there is none. */
  report: { title: string; summary: string; followUps: { title: string; goal: string }[] } | { problem: string } | null;
  filedBy: string | null;
  scope: { sealed: boolean; goal: string | null; words: string[] };
  waits: string[];
  attempts: {
    outcome: string | null; provider: string; model: string | null;
    startedAt: string; finishedAt: string | null; durationMs: number | null;
    costMicrousd: number | null;
  }[];
  cost: { totalMicrousd: number; measuredRuns: number; totalRuns: number };
  evidence: { id: number; kind: string; bytes: number; sha256: string; captureStatus: string | null; mediaType: string }[];
} | null {
  const { sql, args } = inClause(who.repos);
  const row = store.handle
    .prepare(
      `SELECT task_ref.id AS rid, task.id AS tid, task.title AS title, task.state AS state, task_ref.repo AS repo
         FROM task_ref JOIN task ON task.id = task_ref.external_id AND task_ref.backend = 'built-in'
        WHERE task.id = ? AND task_ref.repo IN (${sql})`,
    )
    .get(taskId, ...args);
  // A foreign or absent ref is the SAME answer: not-found — existence
  // outside the allowlist is not this credential's to learn.
  if (row === undefined) return null;
  const rid = Number(row["rid"]);
  const scope = store.getScope(taskId);
  const attempts = store.handle
    .prepare(
      `SELECT outcome, provider, model, started_at, finished_at, cost_usd FROM run
        WHERE task_ref = ? ORDER BY id`,
    )
    .all(rid)
    .map(one => ({
      outcome: one["outcome"] === null ? null : String(one["outcome"]),
      provider: String(one["provider"]),
      model: one["model"] === null ? null : String(one["model"]),
      startedAt: String(one["started_at"]),
      finishedAt: one["finished_at"] === null ? null : String(one["finished_at"]),
      durationMs:
        one["finished_at"] === null
          ? null
          : new Date(String(one["finished_at"])).getTime() - new Date(String(one["started_at"])).getTime(),
      // Integer micro-USD, never a float (review finding 6); null = unmeasured.
      costMicrousd: one["cost_usd"] === null ? null : Math.round(Number(one["cost_usd"]) * 1_000_000),
    }));
  const measured = attempts.filter(one => one.costMicrousd !== null);
  const waits: string[] = [];
  const question = store.handle
    .prepare(
      `SELECT 1 AS hit FROM decision JOIN run ON run.id = decision.run
        WHERE run.task_ref = ? AND decision.answered_at IS NULL AND decision.state IN ('open','expired') LIMIT 1`,
    )
    .get(rid);
  if (question !== undefined) waits.push("a question waits on the operator");
  if (!store.scopeSealed(taskId)) waits.push("the scope waits on the operator's signature");
  const latestRun = store.handle.prepare("SELECT MAX(id) AS top FROM run WHERE task_ref = ?").get(rid);
  const evidence =
    latestRun?.["top"] === null || latestRun?.["top"] === undefined
      ? []
      : store.handle
          .prepare("SELECT id, kind, bytes_original, sha256, capture_status FROM artifact WHERE run = ? ORDER BY id")
          .all(Number(latestRun["top"]))
          .map(one => ({
            // Opaque metadata only — no filesystem paths, no bodies (spec v6).
            id: Number(one["id"]),
            kind: String(one["kind"]),
            bytes: Number(one["bytes_original"]),
            sha256: String(one["sha256"]),
            captureStatus: one["capture_status"] === null ? null : String(one["capture_status"]),
            mediaType: MEDIA_BY_KIND[String(one["kind"])] ?? "text/plain",
          }));
  const deliverable = store.refForId(rid)?.deliverable ?? "branch";
  return {
    ref: String(row["tid"]),
    work: taskWorkSummaryOf(store, taskId, now, { principal: "coordinator", repos: who.repos }),
    assignment: assignmentBrief(assignmentOf(store, taskId, now, { principal: "coordinator", repos: who.repos }, evidenceRoot)),
    title: String(row["title"]),
    state: String(row["state"]),
    repo: String(row["repo"]),
    deliverable,
    report: reportSummaryFor(store, evidenceRoot, rid),
    filedBy: store.coordinatorProvenanceOf(taskId)?.label ?? null,
    scope: {
      sealed: store.scopeSealed(taskId),
      goal: scope?.goal ?? null,
      // The scope in the console's own words.
      words: scope === null ? [] : describeScope(scope),
    },
    waits,
    attempts,
    cost: {
      totalMicrousd: measured.reduce((sum, one) => sum + (one.costMicrousd ?? 0), 0),
      measuredRuns: measured.length,
      totalRuns: attempts.length,
    },
    evidence,
  };
}
