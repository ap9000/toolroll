/**
 * Separation of duties (v102): who filed each task is kept; a project can
 * refuse the requester's own approval; protected work needs two people to
 * approve the same scope, and never a mode, a subagent or a watched run;
 * an instance operator sets the rules with a step-up, and the ledger keeps
 * every change.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { decideFlowCard } from "./flow-engine.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";
import { isProtectedWork, touchesProtected } from "./approval-policy.js";
import { createScheduledFlow } from "./flow-schedule.js";
import { runScheduleNow, setFlowTriggerOn } from "./flow-triggers.js";
import { createHash } from "node:crypto";
import { writeEvidenceFile } from "./evidence.js";
import { changedFilesOf, familyChangedFiles } from "./result-completion.js";
import { storeEvidence } from "./evidence.js";

const REPO = "/repo/main";
let dir: string, store: Store, server: Server, base: string;
const passwords: Record<string, string> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-approval-rules-"));
  store = openStore(join(dir, "orders.db"));
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  passwords["alex"] = alex.token;
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  passwords["sam"] = sam.token;
  // sam approves on the project but isn't an instance operator.
  expect(store.setAccountProjects("sam", [REPO], "alex", now)).toEqual({ ok: true });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async (name: string) => {
  const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: passwords[name]! }), redirect: "manual" });
  return answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
};
const page = async (cookie: string, path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const post = (cookie: string, path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });

/** alex files a task on the project and writes its scope. */
async function fileAsAlex(cookie: string, title: string, touches: string[], goal = "the goal"): Promise<string> {
  const made = store.createConsoleTask({ title, repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date());
  if (!made.ok) throw new Error(made.reason);
  const csrf = csrfOf(await page(cookie, "/tasks"));
  const scoped = await post(cookie, `/t/${made.id}/scope`, { csrf, acceptance: "c1: ok | manual-review", sawDigest: store.getScope(made.id)?.digest ?? "", goal, not: "", touches: touches.join("\n") });
  expect(scoped.status).toBe(303);
  return made.id;
}
async function approveAs(name: string, cookie: string, id: string): Promise<{ status: number; text: string }> {
  const html = await page(cookie, `/t/${id}`);
  const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
  const answer = await post(cookie, `/t/${id}/approve`, { csrf: csrfOf(html), nonce, digest: store.getScope(id)?.digest ?? "", token: passwords[name]! });
  return { status: answer.status, text: await answer.text() };
}

test("an instance operator sets a project's rules with a step-up, nobody else can, and the ledger keeps before → after", async () => {
  const alex = await signIn("alex");
  const form = await page(alex, `/settings/approval?repo=${encodeURIComponent(REPO)}`);
  expect(form).toContain("Save rules");
  const fields = { csrf: csrfOf(form), repo: REPO, not_requester: "1", protect: "paths", paths: "infra/**\nmigrations/**" };
  const wrong = await post(alex, "/settings/approval", { ...fields, password: "not-it" });
  expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("didn't match");
  expect(store.approvalRules(REPO)).toMatchObject({ notRequester: false, protectedPaths: [] });
  expect((await post(alex, "/settings/approval", { ...fields, password: passwords["alex"]! })).status).toBe(303);
  expect(store.approvalRules(REPO)).toMatchObject({ notRequester: true, protectProject: false, protectedPaths: ["infra/**", "migrations/**"], updatedBy: "alex" });
  expect(store.actionLedger({ repos: null, source: "policy" }).find(one => one.action === "approval rules changed")).toMatchObject({
    actor: "alex", repo: REPO, detail: "no rules → requester can't approve; protected: infra/**, migrations/**" });
  // Settings is an instance operator's area: sam (a project approver) can't change the rules there, and reads them on each task instead.
  const sam = await signIn("sam");
  const read = await fetch(`${base}/settings/approval?repo=${encodeURIComponent(REPO)}`, { headers: { cookie: sam } });
  expect(read.status).toBe(403);
  const tasks = await page(sam, "/tasks");
  expect((await post(sam, "/settings/approval", { csrf: csrfOf(tasks), repo: REPO, protect: "none", password: passwords["sam"]! })).status).toBe(403);
  expect(store.approvalRules(REPO).notRequester).toBe(true);
});

test("the requester can't approve their own task; someone else can, and the task says who filed it", async () => {
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", new Date());
  const alex = await signIn("alex"), sam = await signIn("sam");
  const id = await fileAsAlex(alex, "Tidy the logging", ["src/log.ts"]);
  expect(store.taskFiler(id)).toEqual({ name: "alex", kind: "person" });
  expect(store.actionLedger({ repos: null, source: "work" }).find(one => one.taskId === id && one.action === "task filed")).toMatchObject({ actor: "alex" });
  const own = await approveAs("alex", alex, id);
  expect(own.status).toBe(403);
  expect(own.text).toContain("You filed this task, and this project needs someone else to approve it.");
  expect(await page(sam, `/t/${id}`)).toContain("The person who filed a task can");
  expect(store.getScope(id)?.approvedBy ?? null).toBeNull();
  expect((await approveAs("sam", sam, id)).status).toBe(303);
  expect(store.getScope(id)?.approvedBy).toBe("sam");
  // A signed operating mode approves only its signer's own filings, so here it approves nothing of alex's.
  expect(store.approvalGate(id, "alex", "mode")).toEqual({ verdict: "refuse", reason: "requester" });
});

test("protected work needs two people to approve the same scope; a changed scope starts over; clear work needs one", async () => {
  store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["migrations/**"] }, "alex", new Date());
  const alex = await signIn("alex"), sam = await signIn("sam");
  const id = await fileAsAlex(alex, "Add a column", ["migrations/002_add_column.sql"]);
  const first = await approveAs("alex", alex, id);
  expect(first.status).toBe(200);
  expect(first.text).toContain("Your approval is recorded (1 of 2).");
  expect(store.getScope(id)?.approvedBy ?? null).toBeNull();
  expect(store.approvalVotes(id).map(one => one.approver)).toEqual(["alex"]);
  expect((await approveAs("alex", alex, id)).text).toContain("You&#39;ve already approved this.");
  expect(await page(sam, `/t/${id}`)).toContain("approved by alex · needs one more");
  // A rewritten scope is different bytes: the earlier yes doesn't count for it.
  const csrf = csrfOf(await page(alex, "/tasks"));
  expect((await post(alex, `/t/${id}/scope`, { csrf, acceptance: "c1: ok | manual-review", sawDigest: store.getScope(id)!.digest, goal: "a different goal", not: "", touches: "migrations/002_add_column.sql" })).status).toBe(303);
  expect(store.approvalVotes(id)).toEqual([]);
  expect((await approveAs("sam", sam, id)).text).toContain("(1 of 2)");
  expect((await approveAs("alex", alex, id)).status).toBe(303);
  expect(store.getScope(id)?.approvedBy).toBe("alex");
  expect(store.approvalVotes(id).map(one => one.approver).sort()).toEqual(["alex", "sam"]);
  // Work that stays clear of the protected paths takes one approval; work that doesn't say is protected.
  const clear = await fileAsAlex(alex, "Fix a typo", ["docs/readme.md"]);
  expect((await approveAs("alex", alex, clear)).status).toBe(303);
  const unsaid = await fileAsAlex(alex, "Tidy things", []);
  expect((await approveAs("alex", alex, unsaid)).status).toBe(200);
});

test("on a protected project no mode or subagent stands in for two people", async () => {
  store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", new Date());
  const alex = await signIn("alex");
  const id = await fileAsAlex(alex, "Rotate the keys", ["src/keys.ts"]);
  const now = new Date();
  expect(store.sealScopeApproval(id, "Maya (AI)", now)).toBe(false);
  expect(store.sealScopeApproval(id, "alex", now, {}, { kind: "mode", modeDigest: "any" })).toBe(false);
  expect(store.sealScopeApproval(id, "alex", now)).toBe(false);
  expect(store.approvalGate(id, "Maya (AI)", "ai")).toEqual({ verdict: "refuse", reason: "person-required" });
  // A flow's decision zone staffed by a subagent: the person decides instead.
  const stage = (sid: string, kind: string, rest: Record<string, unknown> = {}) => ({ id: sid, title: sid, kind, zone: {}, next: null, onFail: null, ...rest });
  const flow = store.createFlow({ repo: REPO, name: "Refunds", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya-decides", stages: [
    stage("maya-decides", "approval", { subagent: "maya", toOwner: true, next: "done", onFail: "done" }), stage("done", "inbox")] }) }, now);
  store.createSubagent({ repo: REPO, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, now);
  const card = store.addFlowCard({ flow, title: "Refund $30", description: null, stage: "maya-decides", by: "alex" }, now);
  expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "Maya (AI)", repos: [REPO], subagent: "maya" }, now)).toEqual({ ok: false, message: "This project is protected: a person decides here." });
  expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [REPO] }, now)).toMatchObject({ ok: true });
});

test("protected paths match what a task says it touches, erring toward protecting", () => {
  expect(touchesProtected("migrations/002.sql", "migrations/**")).toBe(true);
  expect(touchesProtected("migrations", "migrations")).toBe(true);
  expect(touchesProtected("docs/readme.md", "migrations/**")).toBe(false);
  expect(touchesProtected("src/**", "src/db/schema.sql")).toBe(true);
  expect(touchesProtected("src/app.ts", "*.sql")).toBe(false);
  expect(touchesProtected("schema.sql", "*.sql")).toBe(true);
  // The review's bypasses: a bare directory, a trailing slash, "..", case, braces, any-depth patterns, leaving the checkout.
  for (const touch of ["infra", "infra/", "docs/../infra/main.tf", "INFRA/main.tf", "{infra,docs}/**", "../elsewhere"]) expect(touchesProtected(touch, "infra/**"), touch).toBe(true);
  expect(touchesProtected("secrets", "**/secrets/**")).toBe(true);
  expect(touchesProtected("src/db/schema.sql", "*.sql")).toBe(true);
  expect(touchesProtected("infrastructure/x", "infra/**")).toBe(false);
  // A folder may hold whatever a pattern reaches; a file is only itself.
  expect(touchesProtected("infra", "*.tf")).toBe(true);
  expect(touchesProtected("src", "**/secrets/**")).toBe(true);
  expect(touchesProtected("docs/readme.md", "*.tf")).toBe(false);
  // A folder whose name looks like a file still holds what's under it.
  expect(touchesProtected(".github", ".github/workflows/**")).toBe(true);
  expect(touchesProtected("nginx.d", "nginx.d/**")).toBe(true);
  expect(isProtectedWork({ notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, [])).toBe(true);
  expect(isProtectedWork({ notRequester: true, protectProject: false, protectedPaths: [] }, ["infra/x"])).toBe(false);
});

test("the command line shows a project's rules, and only an instance operator changes them", async () => {
  const { runOperate } = await import("./operate.js");
  await fileAsAlex(await signIn("alex"), "Anything", ["src/a.ts"]);
  const lines: string[] = [];
  const run = (args: string[]) => runOperate("project", ["rules", "--repo", REPO, "--json", ...args], line => lines.push(line), { databaseFile: join(dir, "orders.db"), now: new Date() });
  // A registered project with no tasks yet is known too.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "repos.json"), JSON.stringify({ version: 1, repos: ["/repo/fresh"] }));
  expect(await run([])).toBe(0);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, repo: REPO, rules: { notRequester: false, protectProject: false, protectedPaths: [] } });
  expect(await run(["--not-requester", "on", "--as", "sam", "--token", passwords["sam"]!])).toBe(3);
  expect(store.approvalRules(REPO).notRequester).toBe(false);
  expect(await run(["--not-requester", "on", "--protect-paths", "infra/**,migrations/**", "--as", "alex", "--token", passwords["alex"]!])).toBe(0);
  expect(store.approvalRules(REPO)).toMatchObject({ notRequester: true, protectProject: false, protectedPaths: ["infra/**", "migrations/**"], updatedBy: "alex" });
  expect(await runOperate("project", ["rules", "--repo", "/repo/fresh", "--json"], line => lines.push(line), { databaseFile: join(dir, "orders.db"), now: new Date() })).toBe(0);
});

test("whoever wrote the scope counts as a requester, and a revision's root filer does too", async () => {
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", new Date());
  const alex = await signIn("alex"), sam = await signIn("sam");
  // sam files a placeholder; alex rewrites its scope, then tries to approve their own words.
  const made = store.createConsoleTask({ title: "Placeholder", repo: REPO, filedVia: "console", filedBy: { name: "sam", kind: "person" } }, new Date());
  if (!made.ok) throw new Error(made.reason);
  const csrf = csrfOf(await page(alex, "/tasks"));
  expect((await post(alex, `/t/${made.id}/scope`, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "alex's words", not: "", touches: "src/a.ts" })).status).toBe(303);
  expect([...store.requestersOf(made.id)].sort()).toEqual(["alex", "sam"]);
  expect((await approveAs("alex", alex, made.id)).text).toContain("You filed this task");
  expect((await approveAs("sam", sam, made.id)).status).toBe(403);
});

test("a scheduled flow's tasks are filed as its maker's, so the maker can't approve them", () => {
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", new Date());
  const made = createScheduledFlow(store, { repo: REPO, name: "Nightly deps", stem: "nightly-deps", schedule: "daily:03:30", by: "alex",
    terms: { goal: "refresh the lockfile", outOfScope: null, touches: [], requirements: [], acceptance: [{ id: "c1", statement: "The lockfile is refreshed.", how: null, evidence: ["check"] }], budgetPerRunMicrousd: null, costCeilingUsd: null } }, new Date());
  if (!made.ok) throw new Error(made.message);
  setFlowTriggerOn(store, store.getFlowTrigger(made.trigger)!, true, new Date());
  expect(runScheduleNow(store, store.getFlowTrigger(made.trigger)!, "alex", new Date())).toMatchObject({ ok: true });
  const task = store.listTasks().find(one => one.id.startsWith("nightly-deps-"))!;
  expect(store.getScope(task.id)?.approvedAt ?? null).toBeNull();
  expect([...store.requestersOf(task.id)]).toEqual(["alex"]);
});

test("votes count only while their people can still approve; the diff decides completion", async () => {
  store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", new Date());
  const alex = await signIn("alex"), sam = await signIn("sam");
  const id = await fileAsAlex(alex, "Rotate the keys", ["src/keys.ts"]);
  expect((await approveAs("sam", sam, id)).text).toContain("(1 of 2)");
  const now = new Date();
  // sam moves off the project: their vote no longer counts, so alex's is the first.
  expect(store.setAccountProjects("sam", ["/elsewhere"], "alex", now)).toEqual({ ok: true });
  expect((await approveAs("alex", alex, id)).text).toContain("(1 of 2)");
  expect(store.getScope(id)?.approvedBy ?? null).toBeNull();
});

test("a result that changed protected files on a one-person approval completes only by someone else", async () => {
  const alex = await signIn("alex");
  const id = await fileAsAlex(alex, "Tidy config", ["src/config.ts"]);
  expect((await approveAs("alex", alex, id)).status).toBe(303);
  // The rule arrives (or the build strays) after a single approval.
  store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, "alex", new Date());
  expect(store.protectedResultProblem(id, ["docs/readme.md"], "alex")).toBeNull();
  expect(store.protectedResultProblem(id, ["infra/main.tf"], "alex")).toContain("Someone else has to mark it complete.");
  expect(store.protectedResultProblem(id, null, "alex")).toContain("couldn't be read");
  expect(store.protectedResultProblem(id, ["infra/main.tf"], null)).toContain("a person other than its approver");
  expect(store.protectedResultProblem(id, ["infra/main.tf"], "sam")).toBeNull();
});

test("a rename counts on both sides of the build's diff", () => {
  const root = join(dir, "evidence");
  const bytes = Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: "docs/policy.rego", renamedFrom: "infra/policy.rego", added: 0, deleted: 0 }] }));
  const key = writeEvidenceFile(root, 7, "terminal-diff-stat.json", bytes);
  const stat = { id: 1, run: 7, kind: "diff-stat", key, sha256: createHash("sha256").update(bytes).digest("hex"), bytesStored: bytes.length, bytesOriginal: bytes.length, truncated: false, captureStatus: "ok" };
  expect(changedFilesOf({ artifactsFor: () => [stat] } as never, 7, root)).toEqual(["docs/policy.rego", "infra/policy.rego"]);
  expect(changedFilesOf({ artifactsFor: () => [] } as never, 7, root)).toBeNull();
});

test("the requester is never the second pair of eyes, and a route edit makes its editor an author", async () => {
  const alex = await signIn("alex");
  const id = await fileAsAlex(alex, "Tidy config", ["src/config.ts"]);
  expect((await approveAs("alex", alex, id)).status).toBe(303);
  // Protected paths only, no requester rule: sam approved nothing, so alex (the filer) can't complete a protected change either.
  store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, "alex", new Date());
  store.recordScopeAuthor(id, "an-older-digest", "sam", new Date());
  expect(store.requestersOf(id).has("sam")).toBe(true);
  expect(store.protectedResultProblem(id, ["infra/main.tf"], "sam")).toContain("Someone else");
});

test("a revision's branch carries its source's changes, so the family's diffs decide", () => {
  const root = join(dir, "evidence");
  const now = new Date();
  const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };
  const build = (taskId: string, files: string[]) => {
    const ref = store.lookupRef(taskId)!.id;
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${taskId}`, runner: "b1", branch: `b-${taskId}`, worktree: `/w/${taskId}`, ...legacy, now });
    const artifact = storeEvidence(store, root, run, "diff-stat", "terminal-diff-stat.json", Buffer.from(JSON.stringify({ filesTruncated: false, files: files.map(path => ({ path, added: 1, deleted: 0 })) })), "git diff --numstat", now, { captureStatus: "ok" });
    return { run, artifact };
  };
  store.createTask({ id: "source", title: "source" }, now);
  const source = build("source", ["infra/main.tf"]);
  store.createTask({ id: "revision", title: "revision" }, now);
  store.markRevision(store.lookupRef("revision")!.id, "source", source.artifact);
  const revision = build("revision", ["docs/x.md"]);
  expect(familyChangedFiles(store, "revision", revision.run, root)?.sort()).toEqual(["docs/x.md", "infra/main.tf"]);
  expect(familyChangedFiles(store, "source", source.run, root)).toEqual(["infra/main.tf"]);
  // Whoever wrote the source's words is a requester of every revision that copies them.
  store.recordScopeAuthor("source", "any-digest", "sam", now);
  expect(store.requestersOf("revision").has("sam")).toBe(true);
});
