/**
 * The release authority record, read (docs/plans/release-once.md, schema v135): one generation of a release a person
 * approved, its carried commits and its deploy and merge operations. Kept apart from store.ts so the one live-release
 * reader (scope.ts liveReleaseOf) can read it without a module cycle; every write is in store.ts.
 */
import { readReleasePolicy, type ReleasePolicy, type ReleaseTerms } from "./contracts/release-terms.js";
import type { Store } from "./store.js";

export type ReleaseState = "open" | "deploying" | "merge-reserved" | "merged" | "revoked" | "expired" | "superseded";
export const LIVE_RELEASE_STATES: readonly ReleaseState[] = ["open", "deploying", "merge-reserved"];

/** One generation of a release a person approved: the single source of truth for it. */
export type ReleaseAuthority = {
  id: number; repo: string; generation: number; previous: number | null; version: string; pr: number; branch: string; base: string;
  anchorTask: string; anchorDigest: string; approvedSha: string; approvedTree: string; artifactDigest: string | null;
  tipSha: string; tipTask: string; policyJson: string; policy: ReleasePolicy | null; policyDigest: string;
  verifyCommand: number; verifyDigest: string; accessDigest: string; state: ReleaseState; rev: number;
  leaseOwner: string | null; leaseEpoch: number; leaseExpires: string | null; expiresAt: string; createdAt: string; endedAt: string | null; endedBy: string | null;
};

/** One later commit carried under an authority. */
export type ReleaseCarry = {
  id: number; authority: number; taskId: string; scopeDigest: string; requestId: string; fromSha: string; toSha: string; toTree: string;
  artifactDigest: string; commits: { sha: string; files: { path: string; added: number; deleted: number }[] }[]; changedLines: number; files: number; churn: number;
  runtime: string; provedAt: string;
};

/** A deploy or merge that can't be undone, fenced by the lease epoch that reserved it. */
export type ReleaseOperation = {
  id: string; authority: number; kind: "deploy" | "merge"; taskId: string; candidate: string; epoch: number;
  state: "reserved" | "running" | "succeeded" | "failed" | "unknown"; externalRef: string | null; reservedAt: string; finishedAt: string | null; detail: string | null;
  /** Reserved by a person's own deploy run, with no coordinator holding the release. */
  direct: boolean;
  /** The process that reserved, then issued, it (store.ts currentReleaseIssuer); null when none was recorded. */
  issuer: { pid: number; started: string | null; at: string } | null;
  /** A direct deploy's staging folder. */
  stage: string | null;
};

function readReleaseAuthority(row: Record<string, unknown>): ReleaseAuthority {
  const text = (key: string) => row[key] == null ? null : String(row[key]);
  let policy: ReleasePolicy | null = null;
  try {
    const parsed = readReleasePolicyStrict(String(row["policy_json"]));
    policy = parsed;
  } catch { policy = null; }
  const state = String(row["state"]) as ReleaseState;
  return {
    id: Number(row["id"]), repo: String(row["repo"]), generation: Number(row["generation"]), previous: row["previous"] == null ? null : Number(row["previous"]),
    version: String(row["version"]), pr: Number(row["pr"]), branch: String(row["branch"]), base: String(row["base"]),
    anchorTask: String(row["anchor_task"]), anchorDigest: String(row["anchor_digest"]), approvedSha: String(row["approved_sha"]), approvedTree: String(row["approved_tree"]),
    artifactDigest: text("artifact_digest"), tipSha: String(row["tip_sha"]), tipTask: String(row["tip_task"]), policyJson: String(row["policy_json"]), policy,
    policyDigest: String(row["policy_digest"]), verifyCommand: Number(row["verify_command"]), verifyDigest: String(row["verify_digest"]), accessDigest: String(row["access_digest"]),
    state: (["open", "deploying", "merge-reserved", "merged", "revoked", "expired", "superseded"] as const).includes(state) ? state : "revoked",
    rev: Number(row["rev"]), leaseOwner: text("lease_owner"), leaseEpoch: Number(row["lease_epoch"]), leaseExpires: text("lease_expires"),
    expiresAt: String(row["expires_at"]), createdAt: String(row["created_at"]), endedAt: text("ended_at"), endedBy: text("ended_by"),
  };
}

/** A sealed policy read strictly; null when this runtime doesn't know it (and so refuses to carry under it). */
function readReleasePolicyStrict(json: string): ReleasePolicy | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const read = readReleasePolicy(parsed);
  return read.ok && JSON.stringify(read.value) === json ? read.value : null;
}

function readReleaseCarry(row: Record<string, unknown>): ReleaseCarry {
  let commits: ReleaseCarry["commits"] = [];
  try { const parsed = JSON.parse(String(row["commits_json"])) as unknown; if (Array.isArray(parsed)) commits = parsed as ReleaseCarry["commits"]; } catch { commits = []; }
  return {
    id: Number(row["id"]), authority: Number(row["authority"]), taskId: String(row["task_id"]), scopeDigest: String(row["scope_digest"]), requestId: String(row["request_id"]),
    fromSha: String(row["from_sha"]), toSha: String(row["to_sha"]), toTree: String(row["to_tree"]), artifactDigest: String(row["artifact_digest"]), commits,
    changedLines: Number(row["changed_lines"]), files: Number(row["files"]), churn: Number(row["churn"]), runtime: String(row["runtime"]), provedAt: String(row["proved_at"]),
  };
}

function readReleaseOperation(row: Record<string, unknown>): ReleaseOperation {
  const text = (key: string) => row[key] == null ? null : String(row[key]);
  return {
    id: String(row["id"]), authority: Number(row["authority"]), kind: row["kind"] === "merge" ? "merge" : "deploy", taskId: String(row["task_id"]), candidate: String(row["candidate"]),
    epoch: Number(row["epoch"]), state: String(row["state"]) as ReleaseOperation["state"], externalRef: text("external_ref"), reservedAt: String(row["reserved_at"]),
    finishedAt: text("finished_at"), detail: text("detail"), direct: Number(row["direct"] ?? 0) === 1,
    issuer: row["issuer_pid"] == null || row["issued_at"] == null ? null : { pid: Number(row["issuer_pid"]), started: text("issuer_started"), at: String(row["issued_at"]) },
    stage: text("stage"),
  };
}

export function releaseAuthority(store: Store, id: number): ReleaseAuthority | null {
  const row = store.handle.prepare("SELECT * FROM release_authority WHERE id = ?").get(id);
  return row === undefined ? null : readReleaseAuthority(row);
}

/** The newest generation of a release, whatever its state. */
export function newestReleaseGeneration(store: Store, repo: string, version: string, pr: number): ReleaseAuthority | null {
  const row = store.handle.prepare("SELECT * FROM release_authority WHERE repo = ? AND version = ? AND pr = ? ORDER BY generation DESC LIMIT 1").get(repo, version, pr);
  return row === undefined ? null : readReleaseAuthority(row);
}

/** The release authority a task belongs to — as an anchor (any generation) or as a carried commit — or null. */
export function releaseAuthorityOfTask(store: Store, taskId: string): { authority: ReleaseAuthority; carry: ReleaseCarry | null } | null {
  const carryRow = store.handle.prepare("SELECT * FROM release_carry WHERE task_id = ?").get(taskId);
  if (carryRow !== undefined) {
    const carry = readReleaseCarry(carryRow);
    const authority = releaseAuthority(store, carry.authority);
    return authority === null ? null : { authority, carry };
  }
  const row = store.handle.prepare("SELECT * FROM release_authority WHERE anchor_task = ? ORDER BY id DESC LIMIT 1").get(taskId);
  return row === undefined ? null : { authority: readReleaseAuthority(row), carry: null };
}

/** Whether a task belongs to any release authority (anchor or carried), from the records alone. */
export function belongsToRelease(store: Store, taskId: string): boolean {
  return store.handle.prepare("SELECT 1 AS hit FROM release_authority WHERE anchor_task = ? UNION ALL SELECT 1 FROM release_carry WHERE task_id = ? LIMIT 1").get(taskId, taskId) !== undefined;
}

export function releaseCarries(store: Store, authority: number): ReleaseCarry[] {
  return store.handle.prepare("SELECT * FROM release_carry WHERE authority = ? ORDER BY id").all(authority).map(readReleaseCarry);
}

export function releaseCarryTo(store: Store, authority: number, toSha: string): ReleaseCarry | null {
  const row = store.handle.prepare("SELECT * FROM release_carry WHERE authority = ? AND to_sha = ?").get(authority, toSha);
  return row === undefined ? null : readReleaseCarry(row);
}

export function releaseOperations(store: Store, authority: number): ReleaseOperation[] {
  return store.handle.prepare("SELECT * FROM release_operation WHERE authority = ? ORDER BY reserved_at, id").all(authority).map(readReleaseOperation);
}

export function releaseOperation(store: Store, id: string): ReleaseOperation | null {
  const row = store.handle.prepare("SELECT * FROM release_operation WHERE id = ?").get(id);
  return row === undefined ? null : readReleaseOperation(row);
}

/** Operations nobody has settled yet: until each is reconciled, nothing new starts. */
export function outstandingReleaseOperations(store: Store, authority: number): ReleaseOperation[] {
  return releaseOperations(store, authority).filter(one => one.state === "reserved" || one.state === "running" || one.state === "unknown");
}

/**
 * Why a person's seal of these release terms can't open a new generation now, in words, or null. A live generation is
 * superseded by the new one — but never while one of its operations is unsettled, and never once its merge started.
 */
export function releaseSealProblem(store: Store, terms: ReleaseTerms): string | null {
  const live = newestReleaseGeneration(store, terms.repo, terms.packageVersion, terms.pr);
  if (live === null) return null;
  if (live.state === "merged") return `Release ${terms.packageVersion} from pull request #${terms.pr} was already merged.`;
  if (live.state === "merge-reserved") return `The merge of release ${terms.packageVersion} already started; it can't be approved again.`;
  if (LIVE_RELEASE_STATES.includes(live.state) && outstandingReleaseOperations(store, live.id).length > 0) {
    return `Release ${terms.packageVersion} has a deploy that hasn't been settled yet. Run \`toolroll release ${live.branch}\` to finish or recover it first.`;
  }
  return null;
}

