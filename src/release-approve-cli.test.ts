/**
 * `toolroll release approve [<branch>]` (docs/plans/trusted-release-reports.md, slice A, A8) through the real CLI over
 * a real plane database: release journals are discovery only, read strictly; the plane's sealed release identity
 * decides which release it is (feature/foo never stands in for feature_foo); --json never prompts; the card is built
 * again after the prompt and a change refuses; a lead's token or a remote API token is never a person.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { releaseFixture, FIXTURE_PASSWORD, RELEASE_REFUSALS, VERSION, type ReleaseFixture } from "../test/release-fixture.js";
import { EXIT, runOperate } from "./operate.js";
import { journalFile } from "./release.js";
import { personApprovalOf, propose } from "./scope.js";
import { releaseCheckPurposeFor } from "./release-carry.js";
import { recordReleaseCi } from "./release-approval.js";
import { withRemote, type RemoteRun } from "./remote-run.js";

/** A test's hook between the card shown and the card built again after the prompt. */
const hooks = vi.hoisted(() => ({ afterShown: null as null | (() => void), calls: 0 }));
vi.mock("./release-approval.js", async original => {
  const real = await original<typeof import("./release-approval.js")>();
  return { ...real, releaseApprovalCard: (...args: Parameters<typeof real.releaseApprovalCard>) => {
    const answer = real.releaseApprovalCard(...args);
    hooks.calls += 1;
    if (hooks.calls === 1) hooks.afterShown?.();
    return answer;
  } };
});

const NOW = new Date("2026-10-25T12:00:00.000Z");
let f: ReleaseFixture, lines: string[] = [];
const stateDir = () => dirname(f.databaseFile);
const run = async (args: string[]) => { lines = []; hooks.calls = 0; return runOperate("release", args, line => lines.push(line), { databaseFile: f.databaseFile, now: NOW }); };
const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
const said = () => lines.join("\n");

/** A journal as `toolroll release` writes one, at the file its own branch maps to unless `file` names another. */
function journal(branch: string, taskId: string, over: Record<string, unknown> = {}, file = journalFile(stateDir(), branch)): void {
  mkdirSync(dirname(file), { recursive: true });
  const scope = f.store.getScope(taskId)!;
  writeFileSync(file, JSON.stringify({ version: 1, id: "j", github: "example/project", checkout: f.repo, branch, candidate: { sha: scope.candidate, tree: "t" }, packageName: "fixture-app",
    packageVersion: VERSION, tag: `v${VERSION}`, pr: scope.releaseCheck!.pr, step: "approval", task: { id: taskId, scopeDigest: scope.digest }, approval: null, intents: {}, ...over }));
}
/** A second release of the project, on another branch, for another commit. */
function anotherRelease(branch: string, taskId: string, pr = 250): string {
  const head = f.commit({ [`src/${taskId}.js`]: "1\n" }, `work on ${branch}`);
  const purpose = releaseCheckPurposeFor(f.store, { repo: f.repo, version: VERSION, branch, pr, candidate: head });
  if (!purpose.ok) throw new Error(purpose.why);
  f.store.createTask({ id: taskId, title: `Release ${VERSION}` }, NOW);
  f.store.placeTask(f.store.refFor("built-in", taskId).id, f.repo, {}, NOW);
  propose(f.store, { taskId, goal: "Verify", candidate: head, acceptance: [{ id: "c1", statement: "passes", how: null, evidence: ["check"] }], releaseCheck: purpose.purpose, now: NOW });
  return taskId;
}
const credentials = ["--as", "alex", "--token", FIXTURE_PASSWORD];

beforeEach(() => {
  f = releaseFixture({ termsless: true, approve: false, candidate: { "src/card.js": "1\n" } });
  // A verified earlier release, so the change list reads Git and never GitHub.
  const id = Number(f.store.handle.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree, tip_sha, tip_task,
    policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at) VALUES (?,1,'0.9.70',1,'b','main','t','d',?,?,?,'t','{}','p',1,'v','a','merged',?,?)`)
    .run(f.repo, f.base, f.base, f.base, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  f.store.handle.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, external_ref, reserved_at, finished_at) VALUES (?,?, 'merge', 't', ?, 1, 'succeeded', ?, ?, ?)")
    .run(`op-${id}`, id, f.base, f.base, NOW.toISOString(), NOW.toISOString());
  journal("release-0.9.71", f.taskId);
  hooks.afterShown = null;
});
afterEach(() => { vi.unstubAllEnvs(); f.close(); });

describe("toolroll release approve", () => {
  test("--json never prompts: it needs who agrees and the card they read, then approves exactly that", async () => {
    expect(await run(["approve", "--json"])).toBe(EXIT.usage);
    expect(payload()).toMatchObject({ ok: false, reason: "credentials", release: { task: f.taskId, version: VERSION, branch: "release-0.9.71", candidate: f.approved } });
    const digest = (payload()["release"] as { digest: string }).digest;
    expect(await run(["approve", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "unconfirmed" });
    expect(await run(["approve", "--json", ...credentials, "--digest", "0".repeat(64)])).toBe(EXIT.refused);
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
    expect(await run(["approve", "release-0.9.71", "--json", ...credentials, "--digest", digest])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, release: { task: f.taskId, digest } });
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, by: "alex", method: "password-now" });
    // Approved: nothing is waiting any more.
    expect(await run(["approve", "--json", ...credentials, "--digest", digest])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "none" });
  });

  test("at a terminal without a prompt it prints the card, control-free, and the exact command; the password is never echoed", async () => {
    f.commit({ "src/x.js": "2\n" }, "noop");
    expect(await run(["approve", "--as", "alex", "--token", FIXTURE_PASSWORD])).toBe(EXIT.refused);
    const text = said();
    expect(text).toContain(`Release ${VERSION} · pull request #240 · release-0.9.71`);
    expect(text).toContain("The release check runs this commit's code with full access to this computer.");
    expect(text).toContain("toolroll release approve release-0.9.71 --yes --digest ");
    expect(text).not.toContain(FIXTURE_PASSWORD);
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("the card built again after the prompt: a change refuses, and nothing else is approved in its place", async () => {
    expect(await run(["approve", "--json"])).toBe(EXIT.usage);
    const digest = (payload()["release"] as { digest: string }).digest;
    hooks.afterShown = () => recordReleaseCi(f.store, { taskId: f.taskId, candidate: f.approved, state: "running", failed: [], runs: [{ id: 10, name: "Unit tests", status: "queued", conclusion: null }], now: NOW });
    expect(await run(["approve", "--json", ...credentials, "--digest", digest])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "changed" });
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("a journal that disagrees with the plane's sealed release refuses", async () => {
    journal("release-0.9.71", f.taskId, { task: { id: f.taskId, scopeDigest: "e".repeat(32) } });
    expect(await run(["approve", "release-0.9.71", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "mismatch", message: expect.stringContaining("terms changed") });
    journal("release-0.9.71", f.taskId, { pr: 241 });
    expect(await run(["approve", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "mismatch" });
    journal("release-0.9.71", f.taskId);
    expect(await run(["approve", "--repo", join(f.dir, "elsewhere"), "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "mismatch" });
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("feature/foo and feature_foo share a journal file name and never stand in for each other", async () => {
    const slash = anotherRelease("feature/foo", "release-slash");
    journal("feature/foo", slash);
    expect(journalFile(stateDir(), "feature/foo")).toBe(journalFile(stateDir(), "feature_foo"));
    expect(await run(["approve", "feature_foo", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "none" });
    // The same file claiming the other spelling: the plane's sealed branch is feature/foo.
    journal("feature_foo", slash);
    expect(await run(["approve", "feature_foo", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "mismatch" });
    // A journal saved under a file its own branch doesn't map to is not read at all.
    journal("feature/foo", slash, {}, join(stateDir(), "releases", "renamed.json"));
    expect(await run(["approve", "feature/foo", "--json", ...credentials])).toBe(EXIT.refused);
    expect(f.store.getScope(slash)!.approvedAt).toBeNull();
  });

  test("two releases waiting: both are named, and the branch decides", async () => {
    const slash = anotherRelease("feature/foo", "release-slash");
    journal("feature/foo", slash);
    expect(await run(["approve", "--json", ...credentials])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "ambiguous", releases: [{ branch: "feature/foo" }, { branch: "release-0.9.71" }] });
    expect(await run(["approve", "feature/foo", "--json"])).toBe(EXIT.usage);
    const digest = (payload()["release"] as { digest: string }).digest;
    expect(await run(["approve", "feature/foo", "--json", ...credentials, "--digest", digest])).toBe(EXIT.ok);
    expect(personApprovalOf(f.store, slash)).toMatchObject({ ok: true });
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("a lead's token or a remote API token is never a person", async () => {
    expect(await run(["approve", "--json"])).toBe(EXIT.usage);
    const digest = (payload()["release"] as { digest: string }).digest;
    lines = [];
    expect(await runOperate("lead", ["token", "--as", "alex", "--token", FIXTURE_PASSWORD, "--json"], line => lines.push(line), { databaseFile: f.databaseFile, now: NOW })).toBe(EXIT.ok);
    const lead = payload()["token"] as string;
    // Named as the credential: refused before anything is read (a lead token works only for the lead's commands).
    expect(await run(["approve", "--json", "--as", "alex", "--token", lead, "--digest", digest])).toBe(EXIT.usage);
    expect(payload()).toMatchObject({ ok: false, reason: "usage", message: expect.stringContaining("Use your own sign-in") });
    // In the environment: it names nobody here.
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", lead);
    expect(await run(["approve", "--json", "--digest", digest])).toBe(EXIT.usage);
    expect(payload()).toMatchObject({ reason: "credentials" });
    vi.unstubAllEnvs();
    const remote: RemoteRun = { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} };
    expect(await withRemote(remote, () => run(["approve", "--json", "--digest", digest]))).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "machine-proof" });
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });
});

describe("toolroll task approve on a release", () => {
  const taskApprove = async (digest: string) => { lines = []; return runOperate("task", ["approve", f.taskId, "--yes", "--digest", digest, ...credentials, "--json"], line => lines.push(line), { databaseFile: f.databaseFile, now: NOW }); };

  test.each(RELEASE_REFUSALS.map(one => [one.name, one] as const))("%s: refused in the sheet's words, nothing sealed", async (_name, one) => {
    one.apply(f, NOW);
    expect(await taskApprove(f.store.getScope(f.taskId)!.digest)).toBe(EXIT.refused);
    const said = payload() as { ok: boolean; command: string; reason: string; message: string };
    expect(said).toMatchObject({ ok: false, command: "task approve", reason: "policy" });
    expect(said.message.startsWith(`${f.taskId}: `)).toBe(true);
    expect(said.message.slice(`${f.taskId}: `.length)).toMatch(one.words);
    const scope = f.store.getScope(f.taskId)!;
    expect(scope.approvedAt === null || scope.approvedDigest !== scope.digest).toBe(true);
  });

  test("a clean release still approves through it", async () => {
    expect(await taskApprove(f.store.getScope(f.taskId)!.digest)).toBe(EXIT.ok);
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, by: "alex", method: "password-now" });
  });
});
