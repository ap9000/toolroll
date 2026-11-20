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
import { Store, openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { mintCoordinator, authenticateCoordinator } from "./coordinator.js";
import { reproveRemote, type Principal } from "./operate-remote.js";
import { oauthTokenAllowed } from "./mcp-oauth.js";
import { permitsPublication, publishPass, type PublishExec } from "./publish.js";
import { PersistentSessions, FULL_SESSION } from "./server/session.js";
import { MAX_STAGE_BYTES, copyCentralRecoveryStage, retireCentralRecoveryStage, closeCentralRecoveryStage, type RecoveryStageHandle } from "./central-recovery-stage.js";

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
afterEach(() => { copyFault.afterRead = undefined; copyFault.beforeOpen = undefined; vi.restoreAllMocks(); for (const h of handles.splice(0)) closeCentralRecoveryStage(h); if (root !== undefined) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });
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
  expect(report.entries.filter(e => e.status === "retired")).toHaveLength(6);
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
