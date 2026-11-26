import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
// @ts-expect-error plain ESM isolation kit
import { isolatedEnvironment } from "../scripts/isolated-env.mjs";
// @ts-expect-error plain ESM isolation kit
import { checkedEnv, ownRoot } from "../scripts/e2e-kit.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runOperate, EXIT } from "./operate.js";
import { flexibleSignInBilling, signInForTurn, signInStandsAt, signInHoldsFor, signInForInteractiveStands, signInEpochOf } from "./flexible-sign-in.js";
import { onRelayCancel } from "./flexible-relay-cancel.js";
import * as storeModule from "./store.js";
import { Store, openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { mintCoordinator, authenticateCoordinator } from "./coordinator.js";
import { reproveRemote, type Principal } from "./operate-remote.js";
import { oauthTokenAllowed } from "./mcp-oauth.js";
import { holdAutoPublish, autoPublishHeld, PUBLISH_ALLOWED_ACTION, PUBLISH_HELD_ACTION } from "./release-auto.js";
import { resumeAllowedReleases, RELEASE_RESUMED_ACTION } from "./release-next.js";
import { verifyLedgerChain } from "./ledger-chain.js";
import { permitsPublication, publishPass, type PublishExec } from "./publish.js";
import { PersistentSessions, FULL_SESSION } from "./server/session.js";
import { MAX_STAGE_BYTES, copyCentralRecoveryStage, retireCentralRecoveryStage, closeCentralRecoveryStage, type RecoveryStageHandle } from "./central-recovery-stage.js";

const signInSecretCalls = vi.hoisted(() => ({ reads: 0, deletes: 0 }));
vi.mock("./tool-secret-store.js", async importOriginal => ({ ...await importOriginal<typeof import("./tool-secret-store.js")>(),
  readSignInSecret: () => { signInSecretCalls.reads += 1; throw Error("Forbidden snapshot secret read"); },
  removeSignInSecret: () => { signInSecretCalls.deletes += 1; throw Error("Forbidden snapshot secret deletion"); },
}));
const copyFault = vi.hoisted(() => ({ afterRead: undefined as ((path: unknown) => void) | undefined, beforeOpen: undefined as ((path: unknown, flags: unknown) => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const bytes = actual.readSync(...args); copyFault.afterRead?.(args[0]); return bytes;
  }, openSync: (...args: Parameters<typeof actual.openSync>) => {
    copyFault.beforeOpen?.(args[0], args[1]); return actual.openSync(...args);
  } };
});
let root: string | undefined;
const handles: RecoveryStageHandle[] = [];
afterEach(() => { signInSecretCalls.reads = 0; signInSecretCalls.deletes = 0; copyFault.afterRead = undefined; copyFault.beforeOpen = undefined; vi.restoreAllMocks(); for (const h of handles.splice(0)) closeCentralRecoveryStage(h); if (root !== undefined) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });
function fixture(prepare?: (store: Store, now: Date) => void) {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "so-central-stage-"))); fs.chmodSync(root, 0o700);
  const source = join(root, "backup.db"), store = openStore(source), now = new Date();
  const who = addApprover(store, "synthetic", now); if (!who.ok) throw Error("fixture");
  store.createTask({ id: "history", title: "Preserve the saved result" }, now);
  const api = mintApiToken(), oauth = mintApiToken();
  store.createApiToken({ id: api.id, account: "synthetic", name: "synthetic api", secretHash: api.hash, access: "read", expiresAt: new Date(Date.now()+86_400_000).toISOString(), by: "synthetic", projects: null, purpose: "api" }, now);
  const lead = store.mintLeadCredential("synthetic", "synthetic", now);
  const coordinator = mintCoordinator(store, { name: "synthetic", repos: [root], by: "synthetic", now }); if (!coordinator.ok) throw Error("coordinator");
  store.handle.prepare("INSERT INTO coordinator_proposal (cid,name,repo,kind,payload_json,state,created_at) VALUES (?,?,?,'next','{}','pending',?)").run(coordinator.cid, "synthetic", root, now.toISOString());
  const account = store.accountOf("synthetic")!, code = "code-hash", refresh = "refresh-hash", client = "synthetic-client", resource = "http://127.0.0.1:1/mcp";
  store.registerOAuthClient({ id: client, name: "Synthetic", redirectUris: ["http://127.0.0.1:1/callback"], source: "synthetic" }, now, 10, 10);
  store.saveOAuthCode(code, { client, account: "synthetic", generation: account.generation, access: "read", projects: [root], redirectUri: "http://127.0.0.1:1/callback", resource, challenge: "synthetic", expiresAt: new Date(Date.now()+60_000).toISOString() });
  store.createOAuthGrant(code, { id: oauth.id, account: "synthetic", name: "synthetic oauth", secretHash: oauth.hash, access: "read", expiresAt: new Date(Date.now()+86_400_000).toISOString() },
    { client, account: "synthetic", generation: account.generation, projects: [root], resource, accessExpiresAt: new Date(Date.now()+60_000).toISOString(), refreshHash: refresh }, now);
  const cookie = "a".repeat(64), sessions = new PersistentSessions(store);
  sessions.set(cookie, { ...FULL_SESSION, name: "synthetic", csrf: "synthetic", role: "approver", generation: account.generation, createdAt: Date.now(), lastSeen: Date.now(), project: null, projectRevision: 0, sawBoardAt: null });
  const principal: Principal = { kind: "person", account: "synthetic", generation: account.generation, scope: "read", tokenId: api.id, projects: null };
  expect(reproveRemote(store, principal, now).ok).toBe(true); expect(store.leadFor(lead.token)).not.toBeNull(); expect(authenticateCoordinator(store, coordinator.token).ok).toBe(true);
  expect(oauthTokenAllowed(store, oauth.id, "/mcp", now)).toBe(true); expect(sessions.load(cookie)).not.toBeNull();
  prepare?.(store, now);
  store.handle.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  store.close(); return { source, api, oauth, lead, coordinator, principal, code, refresh, client, resource, cookie, now };
}
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function copy(source: string) { const h = copyCentralRecoveryStage(source, root!); handles.push(h); return h; }

test("private copied retirement denies actual API/OAuth/code/refresh/cookie/lead/coordinator verifiers and preserves the original", () => {
  const f = fixture(), original = hash(f.source), sourceStat = fs.statSync(f.source), h = copy(f.source);
  expect(fs.statSync(h.copyPath).ino).not.toBe(sourceStat.ino);
  const report = retireCentralRecoveryStage(h); expect(report).toMatchObject({ outcome: "retired-partial", schemaSupported: true, complete: false, recoveryReady: false });
  expect(report.entries.filter(e => e.status === "retired")).toHaveLength(10);
  expect(report.entries.filter(e => e.status === "unsupported").length).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain(f.api.hash); expect(JSON.stringify(report)).not.toContain(f.api.token);
  expect(retireCentralRecoveryStage(h)).toEqual({ ...report, repeated: true });
  const stage = openStore(h.copyPath);
  expect(reproveRemote(stage, f.principal, f.now).ok).toBe(false);
  expect(stage.leadFor(f.lead.token)).toBeNull(); expect(authenticateCoordinator(stage, f.coordinator.token).ok).toBe(false);
  expect(stage.handle.prepare("SELECT state FROM coordinator_proposal WHERE cid = ?").get(f.coordinator.cid)?.["state"]).toBe("expired");
  expect(oauthTokenAllowed(stage, f.oauth.id, "/mcp", f.now)).toBe(false);
  expect(stage.takeOAuthCode(f.code, f.now)).toBeNull();
  expect(stage.rotateOAuthGrant(f.oauth.id, { client: f.client, resource: f.resource, refreshHash: f.refresh }, { refreshHash: "new-refresh", accessHash: "new-access", accessExpiresAt: new Date(Date.now()+60_000).toISOString() }, f.now, () => [root!])).toEqual({ ok: false, reason: "invalid_grant" });
  expect(new PersistentSessions(stage).load(f.cookie)).toBeNull(); expect(stage.getTask("history")?.title).toBe("Preserve the saved result");
  expect(stage.accountOf("synthetic")?.revokedAt).toBeNull(); // Password/SSO/account standing explicitly remains unsupported.
  stage.close(); expect(hash(f.source)).toBe(original); expect(fs.statSync(f.source).ino).toBe(sourceStat.ino);
});

test("forged, copied, live-Store and source-alias handles cannot authorize mutation", () => {
  const f = fixture(), original = hash(f.source), h = copy(f.source);
  const live = openStore(":memory:");
  for (const fake of [{ copyPath: f.source }, { ...h }, live, null]) expect(() => retireCentralRecoveryStage(fake as RecoveryStageHandle)).toThrow(/internally constructed/);
  live.close(); closeCentralRecoveryStage(h);
  fs.unlinkSync(h.copyPath); fs.linkSync(f.source, h.copyPath);
  expect(() => retireCentralRecoveryStage(h)).toThrow(/changed/); expect(hash(f.source)).toBe(original);
});

test("symlinks, WAL/journal sidecars, nonprivate parents and partial files are refused without changing sources", () => {
  const f = fixture(), original = hash(f.source), alias = join(root!, "alias.db"); fs.symlinkSync(f.source, alias);
  expect(() => copy(alias)).toThrow(/canonical|symlink/);
  for (const suffix of ["-wal", "-shm", "-journal"]) { fs.writeFileSync(f.source+suffix, "partial"); expect(() => copy(f.source)).toThrow(/sidecar/); fs.unlinkSync(f.source+suffix); }
  fs.chmodSync(root!, 0o755); expect(() => copy(f.source)).toThrow(/owner-private/); fs.chmodSync(root!, 0o700);
  const partial = join(root!, "partial.db"); fs.writeFileSync(partial, fs.readFileSync(f.source).subarray(0, 200));
  expect(() => copy(partial)).toThrow(); expect(fs.readFileSync(partial)).toHaveLength(200); expect(hash(f.source)).toBe(original);
});

test("unknown schema inventory never retires or claims completeness", () => {
  const f = fixture(), raw = new DatabaseSync(f.source); raw.exec("CREATE TABLE unknown_authority (secret TEXT)"); raw.close();
  const original = hash(f.source), h = copy(f.source), before = hash(h.copyPath), report = retireCentralRecoveryStage(h);
  expect(report).toMatchObject({ outcome: "unsupported-schema", schemaSupported: false, complete: false, recoveryReady: false });
  expect(report.entries.every(e => e.status === "unsupported" && e.affected === null)).toBe(true);
  expect(hash(h.copyPath)).toBe(before); expect(hash(f.source)).toBe(original);
});

test("helper failure rolls back the private transaction, preserves the source and truthfully repeats failed status", () => {
  const f = fixture(), original = hash(f.source), h = copy(f.source);
  vi.spyOn(Store.prototype, "revokeLeadCredentials").mockImplementation(() => { throw Error("synthetic failure"); });
  const failed = retireCentralRecoveryStage(h); expect(failed.outcome).toBe("failed"); expect(failed.entries.every(e => e.status === "unsupported")).toBe(true);
  expect(retireCentralRecoveryStage(h)).toEqual({ ...failed, repeated: true }); vi.restoreAllMocks();
  const stage = openStore(h.copyPath); expect(reproveRemote(stage, f.principal, f.now).ok).toBe(true); expect(stage.leadFor(f.lead.token)).not.toBeNull();
  expect(authenticateCoordinator(stage, f.coordinator.token).ok).toBe(true); expect(stage.oauthGrant(f.oauth.id)).not.toBeNull(); expect(new PersistentSessions(stage).load(f.cookie)).not.toBeNull();
  stage.close(); expect(hash(f.source)).toBe(original);
});

test("changed original or replaced private stage is refused before any retirement", () => {
  const f = fixture(), h = copy(f.source); closeCentralRecoveryStage(h);
  const before = hash(h.copyPath); fs.appendFileSync(f.source, Buffer.from([0]));
  expect(() => retireCentralRecoveryStage(h)).toThrow(/changed/); expect(hash(h.copyPath)).toBe(before);
});

test("a source changed during the bounded FD copy is refused and no private stage survives", () => {
  const f = fixture(); let reads = 0;
  copyFault.afterRead = path => { if (typeof path === "number" && ++reads === 2) fs.appendFileSync(f.source, Buffer.from([0])); };
  expect(() => copy(f.source)).toThrow(/changed/); copyFault.afterRead = undefined;
  expect(fs.readdirSync(root!).filter(name => name.startsWith("central-recovery-"))).toEqual([]);
  expect(fs.statSync(f.source).size).toBeGreaterThan(0); // The injected external edit is preserved, never repaired.
});


test("oversized sparse backups refuse before any byte read or private copy", () => {
  fixture(); const sparse = join(root!, "oversized.db"), fd = fs.openSync(sparse, "w");
  fs.ftruncateSync(fd, MAX_STAGE_BYTES + 1); fs.closeSync(fd); let reads = 0;
  copyFault.afterRead = () => { reads += 1; };
  expect(() => copy(sparse)).toThrow(/byte limit/); copyFault.afterRead = undefined;
  expect(reads).toBe(0); expect(fs.statSync(sparse).size).toBe(MAX_STAGE_BYTES + 1);
  expect(fs.readdirSync(root!).filter(name => name.startsWith("central-recovery-"))).toEqual([]);
});

test("growth beyond the byte ceiling during bounded reads refuses without continuing allocation or copy", () => {
  const f = fixture(); let reads = 0;
  copyFault.afterRead = () => {
    if (++reads === 1) { const fd = fs.openSync(f.source, "r+"); fs.ftruncateSync(fd, MAX_STAGE_BYTES + 1); fs.closeSync(fd); }
  };
  expect(() => copy(f.source)).toThrow(/byte limit/); copyFault.afterRead = undefined;
  expect(reads).toBe(1); expect(fs.statSync(f.source).size).toBe(MAX_STAGE_BYTES + 1);
  expect(fs.readdirSync(root!).filter(name => name.startsWith("central-recovery-"))).toEqual([]);
});

test("regular source swapped to FIFO between lstat and open refuses synchronously without a reader or writer", () => {
  const f = fixture(), original = hash(f.source), fifo = join(root!, "fifo"), saved = join(root!, "saved.db");
  ownRoot(root!); const isolated = isolatedEnvironment({ root: join(root!, "fifo-env"), outer: {} });
  execFileSync("mkfifo", [fifo], { env: checkedEnv(isolated.env) }); let reads = 0, flagsSeen = 0;
  copyFault.afterRead = () => { reads += 1; };
  copyFault.beforeOpen = (path, flags) => {
    if (path !== f.source) return;
    copyFault.beforeOpen = undefined; flagsSeen = Number(flags);
    fs.renameSync(f.source, saved); fs.renameSync(fifo, f.source);
  };
  expect(() => copy(f.source)).toThrow(/not a regular file/);
  copyFault.afterRead = undefined;
  expect(flagsSeen & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  expect(flagsSeen & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  expect(reads).toBe(0); expect(fs.lstatSync(f.source).isFIFO()).toBe(true); expect(hash(saved)).toBe(original);
});


function publications(store: Store, now: Date) {
  const repo = root!;
  const args = { repo, githubRepo: "synthetic/example", remote: "origin", headPrefix: "toolroll/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "all" as const, draft: true, grantedBy: "synthetic" };
  store.savePublicationGrant(args, now); store.revokePublicationGrant(repo, "earlier", now);
  store.savePublicationGrant(args, now); // A historic revoked grant and the restored live grant both survive.
  for (const state of ["intended", "pushed"] as const) {
    store.createTask({ id: state, title: "Synthetic publication " + state }, now);
    const ref = store.refFor("built-in", state).id; store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(repo, ref);
    const run = store.startRun({ taskRef: ref, leaseId: "synthetic-" + state, runner: "synthetic", branch: "toolroll/" + state, worktree: join(repo, state),
      route: { routeDigest: "legacy", phase: "build", provider: "codex", model: null, chosen: "legacy" }, now });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Preserve actual evidence" });
    const id = store.createPublicationIntent({ run, taskRef: ref, githubRepo: args.githubRepo, remote: args.remote, base: args.base, head: "toolroll/" + state, headSha: "a".repeat(40), bodyHash: "synthetic-body", draft: true }, now);
    if (state === "pushed") store.markPublicationPushed(id, now);
  }
}
const publicationHistory = (store: Store) => ({
  publications: store.handle.prepare("SELECT * FROM publication ORDER BY id").all(),
  runs: store.handle.prepare("SELECT * FROM run ORDER BY id").all(),
  tasks: store.handle.prepare("SELECT * FROM task ORDER BY id").all(),
});

test("publication grants retire on the copy; real intended/pushed publish passes make zero external calls", async () => {
  let before: ReturnType<typeof publicationHistory>, oldGrant: Record<string, unknown> | undefined;
  const f = fixture((s, now) => { publications(s, now); before = publicationHistory(s); oldGrant = s.handle.prepare("SELECT * FROM publication_grant WHERE revoked_by = 'earlier'").get();
    for (const publication of s.pendingPublications()) expect(permitsPublication(s.publicationGrantFor(root!), publication).ok).toBe(true);
  });
  const original = hash(f.source), h = copy(f.source), retired = retireCentralRecoveryStage(h);
  expect(retired.entries.find(e => e.id === "publication-grant-verifier")).toMatchObject({ status: "retired", affected: 1, remaining: 0 });
  expect(retired.entries.find(e => e.id === "execution-and-publication")?.status).toBe("unsupported");
  expect(retired).toMatchObject({ complete: false, recoveryReady: false });
  const stage = openStore(h.copyPath); expect(stage.publicationGrantFor(root!)).toBeNull();
  expect(publicationHistory(stage)).toEqual(before!); // Retirement preserves actual publication/result provenance.
  expect(stage.handle.prepare("SELECT * FROM publication_grant WHERE revoked_by = 'earlier'").get()).toEqual(oldGrant);
  expect(stage.handle.prepare("SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL").get()?.["n"]).toBe(0);
  for (const publication of stage.pendingPublications()) expect(permitsPublication(stage.publicationGrantFor(root!), publication).ok).toBe(false);
  const calls: string[] = []; const exec: PublishExec = async file => { calls.push(file); throw Error("Unexpected external call"); };
  const proof = await publishPass(stage, { repo: root!, evidenceRoot: join(root!, "evidence"), clock: () => f.now, exec });
  expect(calls).toEqual([]); expect(proof).toMatchObject({ pushed: 0, opened: 0, adopted: 0 }); expect(proof.problems).toHaveLength(2);
  // The verifier may truthfully record diagnostic errors/attempts; don't misrepresent those as unchanged history.
  expect(stage.pendingPublications().map(p => p.state)).toEqual(["intended", "pushed"]);
  stage.close(); expect(hash(f.source)).toBe(original);
});

test("a failure after publication retirement rolls back grant revocation with every other staged write", () => {
  const f = fixture(publications), original = hash(f.source), h = copy(f.source);
  vi.spyOn(Store.prototype, "dropWebSession").mockImplementation(() => { throw Error("synthetic post-grant failure"); });
  expect(retireCentralRecoveryStage(h).outcome).toBe("failed"); vi.restoreAllMocks();
  const stage = openStore(h.copyPath); expect(stage.publicationGrantFor(root!)).not.toBeNull();
  expect(stage.handle.prepare("SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL").get()?.["n"]).toBe(1);
  for (const publication of stage.pendingPublications()) expect(permitsPublication(stage.publicationGrantFor(root!), publication).ok).toBe(true);
  expect(reproveRemote(stage, f.principal, f.now).ok).toBe(true);
  stage.close(); expect(hash(f.source)).toBe(original);
});


function releaseStanding(store: Store, now: Date) {
  const log = (taskId: string | null, action: string, at: string) => store.recordAction({ at, actor: "synthetic", repo: taskId === "release-publish" ? "/synthetic/other" : null, taskId, runId: null, action, outcome: action === PUBLISH_ALLOWED_ACTION ? "allowed" : "held", source: "work", detail: "Synthetic historical record" });
  for (const task of ["release-tag", "release-publish", "orphan-homebrew", "", "previously-resumed"]) {
    log(task, PUBLISH_HELD_ACTION, "2099-01-01T00:00:00.000Z");
    log(task, PUBLISH_ALLOWED_ACTION, "1990-01-01T00:00:00.000Z"); // Higher id wins, never timestamp.
  }
  store.createTask({ id: "release-tag", title: "Synthetic release" }, now);
  store.createTask({ id: "release-publish", title: "Other project release" }, now);
  const previous = store.handle.prepare("SELECT id FROM action_ledger WHERE task_id='previously-resumed' AND action=? ORDER BY id DESC LIMIT 1").get(PUBLISH_ALLOWED_ACTION)!;
  store.recordAction({ at: now.toISOString(), actor: "system", repo: null, taskId: "previously-resumed", runId: null, action: RELEASE_RESUMED_ACTION, outcome: String(previous["id"]), source: "work", detail: "Historical resume, not new execution" });
  log("already-held", PUBLISH_ALLOWED_ACTION, "2099-01-01T00:00:00.000Z");
  holdAutoPublish(store, { taskId: "already-held", why: "Existing hold", now: new Date("1990-01-01T00:00:00.000Z") });
  log(null, PUBLISH_ALLOWED_ACTION, now.toISOString()); // Unaddressable taskless event is preserved, outside this leaf.
  store.recordAction({ at: now.toISOString(), actor: "synthetic", repo: null, taskId: "release-tag", runId: null, action: "checks requested", outcome: "full", source: "work", detail: "Keep this outstanding check request" });
  store.sealLedger();
}
function releaseJournals() {
  const folder = join(root!, "releases"); fs.mkdirSync(folder);
  return (["tag", "publish", "homebrew"] as const).map((step, i) => {
    const file = join(folder, step + ".json"), taskId = ["release-tag", "release-publish", "orphan-homebrew"][i]!;
    fs.writeFileSync(file, JSON.stringify({ version: 1, id: "synthetic-"+step, github: "synthetic/example", checkout: root, branch: "synthetic-"+step, candidate: { sha: "a".repeat(40), tree: "b".repeat(40) }, packageName: "synthetic", packageVersion: "1.0.0", tag: "v1.0.0", pr: 1, step,
      task: { id: taskId, scopeDigest: null }, approval: null, check: null, completion: null, deploy: null, ci: null, merge: { sha: "c".repeat(40), tree: null }, tagged: null, published: null, homebrew: null, intents: {}, stopped: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }));
    return file;
  });
}

test("restored ledger permissions receive prospective holds by latest id and real tag/publish/Homebrew resumes stay idle", async () => {
  let history: Record<string, unknown>[] = [], seals: Record<string, unknown>[] = [];
  const f = fixture((s, now) => { releaseStanding(s, now); history = s.handle.prepare("SELECT * FROM action_ledger ORDER BY id").all(); seals = s.handle.prepare("SELECT * FROM ledger_seal ORDER BY id").all(); });
  const original = hash(f.source), journals = releaseJournals(), journalBytes = journals.map(file => fs.readFileSync(file));
  // Establish that these synthetic journals really reach the existing callback on a separate owned copy.
  const probeFile = join(root!, "probe.db"); fs.copyFileSync(f.source, probeFile); const probe = openStore(probeFile), probeCalls: string[] = [];
  expect(await resumeAllowedReleases(probe, root!, async j => { probeCalls.push(j.step); }, f.now)).toBe(3);
  expect(probeCalls.sort()).toEqual(["homebrew", "publish", "tag"]); probe.close();
  const h = copy(f.source), report = retireCentralRecoveryStage(h);
  expect(report.entries.find(e => e.id === "release-publish-ledger-hold")).toMatchObject({ status: "retired", affected: 5, remaining: 0 });
  expect(report.entries.find(e => e.id === "execution-and-publication")?.status).toBe("unsupported");
  expect(report).toMatchObject({ complete: false, recoveryReady: false });
  const beforeRepeat = hash(h.copyPath); expect(retireCentralRecoveryStage(h)).toEqual({ ...report, repeated: true }); expect(hash(h.copyPath)).toBe(beforeRepeat);
  const stage = openStore(h.copyPath);
  const prefix = stage.handle.prepare("SELECT * FROM action_ledger WHERE id <= ? ORDER BY id").all(history.at(-1)!["id"] as number);
  expect(prefix).toEqual(history); expect(stage.handle.prepare("SELECT * FROM ledger_seal WHERE id <= ? ORDER BY id").all(seals.at(-1)!["id"] as number)).toEqual(seals);
  for (const task of ["release-tag", "release-publish", "orphan-homebrew", "", "previously-resumed", "already-held"]) expect(autoPublishHeld(stage, task)).not.toBeNull();
  const calls: string[] = []; expect(await resumeAllowedReleases(stage, root!, async j => { calls.push(j.step); }, f.now)).toBe(0); expect(calls).toEqual([]);
  expect(stage.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action=?").get(RELEASE_RESUMED_ACTION)?.["n"]).toBe(1); // Historical only.
  expect(stage.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action IN ('checks started','checks finished')").get()?.["n"]).toBe(0);
  expect(stage.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action='checks requested'").get()?.["n"]).toBe(1);
  expect(verifyLedgerChain(stage.handle).ok).toBe(true); stage.sealLedger(); expect(verifyLedgerChain(stage.handle)).toMatchObject({ ok: true, unsealed: 0 });
  stage.close(); expect(hash(f.source)).toBe(original); expect(journals.map(file => fs.readFileSync(file))).toEqual(journalBytes);
});

test("failure after hold append rolls back ledger permissions and seals without inventing check or custody outcomes", () => {
  let history: Record<string, unknown>[] = [], seals: Record<string, unknown>[] = [];
  const f = fixture((s, now) => { releaseStanding(s, now); history = s.handle.prepare("SELECT * FROM action_ledger ORDER BY id").all(); seals = s.handle.prepare("SELECT * FROM ledger_seal ORDER BY id").all(); });
  const original = hash(f.source), h = copy(f.source);
  vi.spyOn(Store.prototype, "dropWebSession").mockImplementation(() => { throw Error("synthetic post-hold failure"); });
  expect(retireCentralRecoveryStage(h).outcome).toBe("failed"); vi.restoreAllMocks();
  const stage = openStore(h.copyPath); expect(stage.handle.prepare("SELECT * FROM action_ledger ORDER BY id").all()).toEqual(history);
  expect(stage.handle.prepare("SELECT * FROM ledger_seal ORDER BY id").all()).toEqual(seals);
  expect(autoPublishHeld(stage, "release-tag")).toBeNull(); expect(verifyLedgerChain(stage.handle).ok).toBe(true);
  stage.close(); expect(hash(f.source)).toBe(original);
});


function intakeStanding(store: Store, now: Date) {
  const first = store.setIntakeGrant({ repo: root!, github: "synthetic/source", label: "agent-ok", reviewers: ["synthetic"], approvedBy: "synthetic" }, now);
  store.setIntakeGrant({ repo: root!, github: "synthetic/source", label: "agent-ok", reviewers: ["synthetic"], approvedBy: "synthetic" }, now);
  store.setIntakeGrant({ repo: join(root!, "other-project"), github: "synthetic/other", label: "other-ok", reviewers: null, approvedBy: "synthetic" }, now);
  expect(store.establishMirror({ localTaskId: "history", backend: "github-issues", remoteRepo: "synthetic/source", remoteId: "1", provenance: "intake", intakeGrant: first.id, establishedBy: "intake" }, now).ok).toBe(true);
  expect(store.liveIntakeGrant(root!)).not.toBeNull(); expect(store.liveIntakeGrant(join(root!, "other-project"))).not.toBeNull();
}
const intakeHistory = (store: Store) => ({
  grants: store.handle.prepare("SELECT * FROM intake_grant ORDER BY id").all(),
  mirrors: store.handle.prepare("SELECT * FROM external_mirror ORDER BY local_task_id").all(),
  tasks: store.handle.prepare("SELECT * FROM task ORDER BY id").all(),
  comments: store.handle.prepare("SELECT * FROM diff_comment ORDER BY id").all(),
});

test("intake fresh-command grants retire without changing prior imports; real commands refuse no-grant before external reads", async () => {
  let history: ReturnType<typeof intakeHistory>;
  const f = fixture((s, now) => { intakeStanding(s, now); history = intakeHistory(s); expect(s.isDemo()).toBe(false); });
  const original = hash(f.source), h = copy(f.source), retired = retireCentralRecoveryStage(h);
  expect(retired.entries.find(e => e.id === "intake-grant-fresh-command-admission")).toMatchObject({ status: "retired", affected: 2, remaining: 0 });
  expect(retired.entries.find(e => e.id === "public-hooks-and-triggers")?.status).toBe("unsupported"); expect(retired).toMatchObject({ complete: false, recoveryReady: false });
  const stage = openStore(h.copyPath), after = intakeHistory(stage);
  expect(stage.liveIntakeGrant(root!)).toBeNull(); expect(stage.liveIntakeGrant(join(root!, "other-project"))).toBeNull();
  expect(stage.handle.prepare("SELECT count(*) AS n FROM intake_grant WHERE revoked_at IS NULL").get()?.["n"]).toBe(0);
  expect(after.grants[0]).toEqual(history!.grants[0]);
  expect(after.grants.map(({ revoked_at: _at, revoked_by: _by, ...terms }) => terms)).toEqual(history!.grants.map(({ revoked_at: _at, revoked_by: _by, ...terms }) => terms));
  expect(after.mirrors).toEqual(history!.mirrors); expect(after.tasks).toEqual(history!.tasks); expect(after.comments).toEqual(history!.comments); stage.close();
  const calls: string[] = [];
  for (const action of ["preview", "run", "pr-comments"]) {
    const lines: string[] = [];
    const code = await runOperate("intake", [action, "--repo", root!, "--json"], line => lines.push(line), { databaseFile: h.copyPath, now: f.now,
      gitRunner: async file => { calls.push(file); throw Error("Unexpected external intake read"); } });
    expect(code).toBe(EXIT.refused); expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "no-grant" });
  }
  expect(calls).toEqual([]); const verified = openStore(h.copyPath); expect(intakeHistory(verified).mirrors).toEqual(history!.mirrors); expect(intakeHistory(verified).tasks).toEqual(history!.tasks); verified.close();
  expect(hash(f.source)).toBe(original);
});

test("post-intake failure restores original live grant standing and imported provenance in the private transaction", () => {
  let history: ReturnType<typeof intakeHistory>;
  const f = fixture((s, now) => { intakeStanding(s, now); history = intakeHistory(s); }), original = hash(f.source), h = copy(f.source);
  vi.spyOn(Store.prototype, "dropWebSession").mockImplementation(() => { throw Error("synthetic post-intake failure"); });
  expect(retireCentralRecoveryStage(h).outcome).toBe("failed"); vi.restoreAllMocks();
  const stage = openStore(h.copyPath); expect(intakeHistory(stage)).toEqual(history!); expect(stage.liveIntakeGrant(root!)).not.toBeNull();
  expect(stage.liveIntakeGrant(join(root!, "other-project"))).not.toBeNull(); expect(reproveRemote(stage, f.principal, f.now).ok).toBe(true);
  stage.close(); expect(hash(f.source)).toBe(original);
});


const snapshotIds = { thread: "1".repeat(32), turn: "2".repeat(32), interactiveThread: "3".repeat(32), launch: "4".repeat(32), session: "5".repeat(32), active: "6".repeat(32) };
function flexibleSnapshot(store: Store, now: Date, captured = 7) {
  const generation = store.accountOf("synthetic")!.generation, at = now.toISOString(), i = snapshotIds;
  for (const [suffix, state] of [[i.active, "active"], ["7".repeat(32), "staged"], ["8".repeat(32), "retiring"]]) {
    store.handle.prepare(`INSERT INTO flexible_sign_in (person,account_generation,generation,kind,state,save_op,proof,staged_at,retire_after,activated_at,retired_at)
      VALUES ('synthetic',?,?,'setup-token',?,?,'password-now',?,?,?,?)`).run(generation, suffix!, state!, state === "staged" ? "a".repeat(32) : null, at, state === "staged" ? at : null, state === "active" ? at : null, state === "retiring" ? at : null);
  }
  store.handle.prepare("INSERT INTO flexible_sign_in_epoch(person,epoch) VALUES ('synthetic',7),('epoch-only',3)").run();
  for (const thread of [i.thread, i.interactiveThread]) {
    store.handle.prepare("INSERT INTO flexible_thread (id,repo,base_sha,keep_ref,folder,created_by,created_at,state) VALUES (?,?,?, ?,?,'synthetic',?,'preparing')").run(thread, root!, "1".repeat(40), `refs/toolroll/threads/${thread}/base`, join(root!,thread), at);
    if (thread === i.interactiveThread) store.handle.prepare("UPDATE flexible_thread_runtime SET runtime='interactive',chosen=1 WHERE thread=?").run(thread);
    store.handle.prepare("UPDATE flexible_thread SET state='ready' WHERE id=?").run(thread);
  }
  store.handle.prepare(`INSERT INTO thread_turn (id,thread,seq,repo,owner,owner_generation,terms_id,terms_digest,level,provider,model,billing,request_key,holder,admitted_at,utc_day,status,started_at)
    VALUES (?,?,1,?,'synthetic',?,1,?,'full','claude','synthetic','subscription','request','holder',?,?,'running',?)`).run(i.turn,i.thread,root!,generation,"a".repeat(32),at,at.slice(0,10),at);
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id,thread,provider,level,fence_digest,holder,host,marker,state,started_at)
    VALUES (?,?,'claude','full',?,'holder','synthetic',?,'spawning',?)`).run(i.launch,i.interactiveThread,"a".repeat(32),"b".repeat(32),at);
  store.handle.prepare(`INSERT INTO flexible_interactive_session (id,thread,launch,holder,owner,account_generation,runtime,provider,billing,terms_id,terms_digest,start_key,message,level,model,helper_models,fence_digest,network_digest,sign_in_epoch,state,prepared_at)
    VALUES (?,?,?,'holder','synthetic',?,'interactive','claude','subscription',1,?,?,'Synthetic authority','full','synthetic','[]',?,?,?,'prepared',?)`).run(i.session,i.interactiveThread,i.launch,generation,"a".repeat(32),"b".repeat(32),"a".repeat(32),"c".repeat(32),captured,at);
  store.handle.prepare("INSERT INTO flexible_stop_request(launch,thread,reason,requested_at) VALUES (?,?,?,?)").run("e".repeat(32),i.thread,"Existing unresolved stop",at);
  store.handle.prepare(`INSERT INTO thread_relay_pending(thread,turn,launch,holder,relay,route,reserved_at,sign_in_person,sign_in_generation,sign_in_epoch)
    VALUES (?,?,?,'holder',?,'messages',?,'synthetic',?,?)`).run(i.thread,i.turn,i.launch,"d".repeat(32),at,i.active,captured);
  store.handle.prepare(`INSERT INTO thread_relay_call(thread,turn,launch,upstream,at,ended_at,route,streamed,status,cost_basis,sign_in_person,sign_in_generation,sign_in_epoch)
    VALUES (?,?,?,'claude',?,?,'messages',0,'incomplete','unknown','synthetic',?,?)`).run(i.thread,i.turn,i.launch,at,at,i.active,captured);
  return generation;
}
const flexibleCustody = (store: Store) => Object.fromEntries(["thread_turn","flexible_thread","flexible_thread_launch","flexible_interactive_session","flexible_stop_request","thread_relay_call","thread_relay_pending","thread_decision","thread_request","thread_answer"].map(table => {
  const exists = store.handle.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return [table, exists === undefined ? null : store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()];
}));

test("snapshot sign-in rows and captured epochs lose admission without changing custody or issuing cancellation", () => {
  let generation = 0, custody: ReturnType<typeof flexibleCustody>, retiring: Record<string, unknown> | undefined;
  const f = fixture((s,now) => { generation=flexibleSnapshot(s,now); custody=flexibleCustody(s); retiring=s.handle.prepare("SELECT * FROM flexible_sign_in WHERE state='retiring'").get();
    expect(flexibleSignInBilling(s,{name:"synthetic",generation}).ok).toBe(true);
    expect(signInStandsAt(s,{thread:snapshotIds.thread,turn:snapshotIds.turn,person:"synthetic",generation:snapshotIds.active})).toBeNull();
    expect(signInHoldsFor(s,{turn:snapshotIds.turn,person:"synthetic",epoch:7})).toBe(true); expect(signInForInteractiveStands(s,snapshotIds.session)).toBe(true);
  });
  const original=hash(f.source),h=copy(f.source), events: unknown[]=[];
  const unlisten=onRelayCancel(event=>events.push(event),()=>events.push("failure")); let report;
  try { report=retireCentralRecoveryStage(h); } finally { unlisten(); }
  expect(events).toEqual([]); expect(report.entries.find(e=>e.id==='flexible-snapshot-sign-in-admission')).toMatchObject({status:'retired',affected:2,remaining:0});
  expect(report.entries.find(e=>e.id==='flexible-authority')?.status).toBe('unsupported'); expect(report).toMatchObject({complete:false,recoveryReady:false});
  const retiredBytes=hash(h.copyPath); expect(retireCentralRecoveryStage(h)).toEqual({...report,repeated:true}); expect(hash(h.copyPath)).toBe(retiredBytes);
  const s=openStore(h.copyPath); expect(flexibleCustody(s)).toEqual(custody!); expect(s.handle.prepare("SELECT * FROM flexible_sign_in WHERE generation=?").get("8".repeat(32))).toEqual(retiring);
  expect(signInEpochOf(s,'synthetic')).toBe(8); expect(signInEpochOf(s,'epoch-only')).toBe(4);
  expect(flexibleSignInBilling(s,{name:'synthetic',generation})).toEqual({ok:false,reason:'no-sign-in'});
  expect(signInStandsAt(s,{thread:snapshotIds.thread,turn:snapshotIds.turn,person:'synthetic',generation:snapshotIds.active})).toBe('no-sign-in');
  expect(signInForTurn(s,join(root!,'never-read-secrets'),{owner:'synthetic',ownerGeneration:generation})).toEqual({ok:false,reason:'no-sign-in'});
  expect(signInForInteractiveStands(s,snapshotIds.session)).toBe(false); expect(signInSecretCalls).toEqual({reads:0,deletes:0});
  // Fresh synthetic DB standing does not revive captured snapshot7; unseen post-backup8 COLLIDES and is unsupported.
  const at=f.now.toISOString(); s.handle.prepare("INSERT INTO flexible_sign_in(person,account_generation,generation,kind,state,proof,staged_at,activated_at) VALUES ('synthetic',?,?,'setup-token','active','password-now',?,?)").run(generation,"9".repeat(32),at,at);
  expect(signInHoldsFor(s,{turn:snapshotIds.turn,person:'synthetic',epoch:7})).toBe(false);
  expect(signInHoldsFor(s,{turn:snapshotIds.turn,person:'synthetic',epoch:8})).toBe(true); // Explicit recovery limitation, never claimed fenced.
  expect(flexibleCustody(s)).toEqual(custody!); s.close(); expect(hash(f.source)).toBe(original);
});

test.each(['future-captured','overflow','unsafe-captured','missing-counter'] as const)("snapshot sign-in %s refuses before Flexible writes and rolls back prior retirements", kind => {
  let before: unknown;
  const f=fixture((s,now)=>{ flexibleSnapshot(s,now,kind==='future-captured'?8:kind==='unsafe-captured'?7.5:7);
    if(kind==='missing-counter') s.handle.prepare("DELETE FROM flexible_sign_in_epoch WHERE person='synthetic'").run();
    if(kind==='overflow') s.handle.prepare("UPDATE flexible_sign_in_epoch SET epoch=? WHERE person='synthetic'").run(Number.MAX_SAFE_INTEGER);
    before={rows:s.handle.prepare("SELECT * FROM flexible_sign_in ORDER BY generation").all(),epochs:s.handle.prepare("SELECT * FROM flexible_sign_in_epoch ORDER BY person").all(),custody:flexibleCustody(s)};
  });
  const original=hash(f.source),h=copy(f.source); expect(retireCentralRecoveryStage(h).outcome).toBe('failed');
  const s=openStore(h.copyPath); expect({rows:s.handle.prepare("SELECT * FROM flexible_sign_in ORDER BY generation").all(),epochs:s.handle.prepare("SELECT * FROM flexible_sign_in_epoch ORDER BY person").all(),custody:flexibleCustody(s)}).toEqual(before);
  expect(reproveRemote(s,f.principal,f.now).ok).toBe(true); s.close(); expect(hash(f.source)).toBe(original);
});

test("late failure rolls back snapshot sign-in changes and epochs without custody edits",()=>{
  let before: unknown; const f=fixture((s,now)=>{flexibleSnapshot(s,now);before={rows:s.handle.prepare("SELECT * FROM flexible_sign_in ORDER BY generation").all(),epochs:s.handle.prepare("SELECT * FROM flexible_sign_in_epoch ORDER BY person").all(),custody:flexibleCustody(s)};});
  const original=hash(f.source),h=copy(f.source);vi.spyOn(Store.prototype,'dropWebSession').mockImplementation(()=>{throw Error('synthetic post-signin failure');});
  expect(retireCentralRecoveryStage(h).outcome).toBe('failed');vi.restoreAllMocks();const s=openStore(h.copyPath);
  expect({rows:s.handle.prepare("SELECT * FROM flexible_sign_in ORDER BY generation").all(),epochs:s.handle.prepare("SELECT * FROM flexible_sign_in_epoch ORDER BY person").all(),custody:flexibleCustody(s)}).toEqual(before);
  s.close();expect(hash(f.source)).toBe(original);
});


test("only exact178/709 is admitted; old177, missing, extra, ordinary and variant indexes stay untouched", () => {
  for (const change of ["old177", "missing", "extra", "ordinary", "variant"] as const) {
    const f = fixture(), raw = new DatabaseSync(f.source);
    if (change !== "extra") raw.exec("DROP INDEX action_ledger_action");
    if (change === "old177") raw.exec("UPDATE schema_version SET version = 177");
    if (change === "extra") raw.exec("CREATE INDEX unexpected_index ON action_ledger(action)");
    if (change === "ordinary") raw.exec("CREATE INDEX action_ledger_action ON action_ledger(action,id)");
    if (change === "variant") raw.exec("CREATE INDEX action_ledger_action ON action_ledger(id) WHERE action = 'checks recovery held'");
    raw.close(); const before = hash(f.source), h = copy(f.source), copied = hash(h.copyPath);
    expect(retireCentralRecoveryStage(h)).toMatchObject({ outcome: "unsupported-schema", schemaSupported: false, complete: false, recoveryReady: false });
    expect(hash(f.source)).toBe(before); expect(hash(h.copyPath)).toBe(copied);
    const after = new DatabaseSync(h.copyPath, { readOnly: true });
    expect(after.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(change === "old177" ? 177 : 187); after.close();
    closeCentralRecoveryStage(h); handles.splice(handles.indexOf(h), 1); fs.rmSync(root!, { recursive: true, force: true }); root = undefined;
  }
});

test.each(["catalog", "version", "binding"] as const)("post-open %s of the actual retained Store is revalidated", change => {
  const f = fixture(), before = hash(f.source), original = storeModule.openStore;
  vi.spyOn(storeModule, "openStore").mockImplementation((file, options) => {
    const s = original(change === "binding" && file.endsWith("/stage.db") ? ":memory:" : file, options);
    if (file.endsWith("/stage.db") && change !== "binding") s.handle.exec(change === "catalog" ? "CREATE INDEX post_open_variant ON action_ledger(action)" : "UPDATE schema_version SET version=177");
    return s;
  });
  expect(() => copy(f.source)).toThrow(/Retained stage (schema|database file) changed/); expect(hash(f.source)).toBe(before);
});

test("a restored backup's automatic updates are off in the stage until a person turns them on again; attempts are kept as found", () => {
  const f = fixture((store, now) => {
    store.handle.prepare("INSERT INTO auto_update_policy (id, enabled, revision, updated_by, updated_at) VALUES (1, 1, 3, 'synthetic', ?)").run(now.toISOString());
    store.handle.prepare("INSERT INTO auto_update_attempt (version, from_version, enabled_by, policy_revision, reserved_at) VALUES ('9.9.9', '9.9.8', 'synthetic', 3, ?)").run(now.toISOString());
  });
  const before = hash(f.source), h = copy(f.source);
  const report = retireCentralRecoveryStage(h);
  expect(report.entries.find(e => e.id === "automatic-updates")).toMatchObject({ status: "retired", affected: 1, remaining: 0 });
  expect(hash(f.source)).toBe(before);
  const after = new DatabaseSync(h.copyPath, { readOnly: true });
  expect(after.prepare("SELECT enabled, revision, updated_by FROM auto_update_policy").all().map(row => ({ ...row }))).toEqual([{ enabled: 0, revision: 4, updated_by: "central-recovery-stage" }]);
  expect(after.prepare("SELECT count(*) AS n FROM auto_update_attempt WHERE version = '9.9.9'").get()?.["n"]).toBe(1);
  after.close();
});
