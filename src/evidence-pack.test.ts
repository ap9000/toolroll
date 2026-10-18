/**
 * A change's evidence pack (v103): who asked, the approved terms and who
 * approved them under which rules, the agents and their cost, what changed,
 * and every ledger entry about it with a seal anyone can recompute. As a
 * printable page and as JSON; only for people who can see the task; and in
 * bulk for a date range.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { storeEvidence } from "./evidence.js";
import { entryHash } from "./ledger-chain.js";
import { packDigest, type EvidencePack, type LedgerExport } from "./evidence-pack.js";
import { runOperate } from "./operate.js";

const REPO = "/repo/main";
const OTHER = "/repo/other";
let dir: string, file: string, store: Store, server: Server, base: string;
const passwords: Record<string, string> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-evidence-pack-"));
  file = join(dir, "orders.db");
  store = openStore(file);
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  passwords["alex"] = alex.token;
  for (const name of ["sam", "kim"]) {
    const made = addApprover(store, name, now, { name: "alex", token: alex.token });
    if (!made.ok) throw new Error(name);
    passwords[name] = made.token;
  }
  expect(store.setAccountProjects("sam", [REPO], "alex", now)).toEqual({ ok: true });
  // kim works on another project only.
  expect(store.setAccountProjects("kim", [OTHER], "alex", now)).toEqual({ ok: true });
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
const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
const page = async (cookie: string, path: string) => (await get(cookie, path)).text();
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const post = (cookie: string, path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });

/** alex files and scopes a task on the project; sam approves it (the project won't let alex); a build changes two files. */
async function approvedBuild(): Promise<{ id: string; run: number }> {
  store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", new Date());
  const alex = await signIn("alex");
  const made = store.createConsoleTask({ title: "Rotate the signing key", repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date());
  if (!made.ok) throw new Error(made.reason);
  const scoped = await post(alex, `/t/${made.id}/scope`, { csrf: csrfOf(await page(alex, "/tasks")), acceptance: "c1: the old key stops working | manual-review", sawDigest: store.getScope(made.id)?.digest ?? "", goal: "Rotate the key", not: "", touches: "infra/keys" });
  expect(scoped.status).toBe(303);
  const sam = await signIn("sam");
  const html = await page(sam, `/t/${made.id}`);
  const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
  const approved = await post(sam, `/t/${made.id}/approve`, { csrf: csrfOf(html), nonce, digest: store.getScope(made.id)?.digest ?? "", token: passwords["sam"]! });
  expect(approved.status).toBe(303);
  const now = new Date();
  const ref = store.lookupRef(made.id)!.id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route fixture");
  const run = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "b1", branch: "b-1", worktree: "/w/1", route: authority.stamp, now });
  store.stampRun(run, { scopeDigest: store.getScope(made.id)!.digest, baseRevision: "b".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Rotated." });
  storeEvidence(store, join(dir, "evidence"), run, "diff-stat", "terminal-diff-stat.json",
    Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: "infra/keys/current.pem", added: 1, deleted: 1 }, { path: "docs/keys.md", added: 3, deleted: 0 }] })), "git diff --numstat", now, { captureStatus: "ok" });
  store.recordUsage(run, { tokensIn: 1200, tokensOut: 300, costUsd: 0.42 });
  store.finishRun(run, { outcome: "built", committed: true, now });
  return { id: made.id, run };
}

test("the pack says who asked, who approved under which rules, what ran and changed, and seals every entry", async () => {
  const { id, run } = await approvedBuild();
  const alex = await signIn("alex");
  const answer = await get(alex, `/t/${id}/evidence?format=json`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get("content-disposition")).toBe(`attachment; filename="evidence-${id}.json"`);
  const pack = await answer.json() as EvidencePack;
  expect(pack.format).toBe("standing-orders/evidence-pack/v1");
  expect(pack.task).toMatchObject({ id, title: "Rotate the signing key", repo: REPO, project: "main" });
  expect(pack.rules?.now).toBe("requester can't approve");
  expect(pack.rules?.changes.at(-1)).toMatchObject({ by: "alex", change: "no rules → requester can't approve" });
  const [version] = pack.versions;
  expect(version!.filedBy).toEqual({ name: "alex", kind: "person" });
  expect(version!.scope).toMatchObject({ goal: "Rotate the key", touches: ["infra/keys"], acceptance: [{ id: "c1", statement: "the old key stops working" }] });
  expect(version!.scope!.approved).toMatchObject({ by: "sam", basis: "person", current: true });
  expect(version!.scope!.writtenBy.map(one => one.author)).toContain("alex");
  expect(version!.runs).toHaveLength(1);
  expect(version!.runs[0]).toMatchObject({ id: run, role: "builder", agent: "claude", outcome: "built", costUsd: 0.42, tokensIn: 1200, changedFiles: ["infra/keys/current.pem", "docs/keys.md"] });
  expect(pack.totals).toEqual({ runs: 1, costUsd: 0.42, tokensIn: 1200, tokensOut: 300 });
  // The ledger entries about it: filing, approval, the run; each seal recomputes from the entry itself.
  const actions = pack.ledger.entries.map(one => one.action);
  expect(actions).toEqual(expect.arrayContaining(["task filed", "scope approved"]));
  expect(pack.ledger.entries.every(one => one.taskId === id || one.runId === run)).toBe(true);
  for (const one of pack.ledger.entries) {
    expect(one.seal).not.toBeNull();
    const row = { id: one.id, at: one.at, actor: one.actor, repo: one.repo, task_id: one.taskId, run_id: one.runId, action: one.action, outcome: one.outcome, source: one.source, detail: one.detail };
    expect(entryHash(one.seal!.prev, row)).toBe(one.seal!.hash);
  }
  expect(pack.ledger.chain).toMatchObject({ ok: true, problem: null });
  // The pack's digest covers everything else in it.
  const { digest, ...body } = pack;
  expect(packDigest(body)).toBe(digest);
});

test("the printable page shows the same facts, with no script, and the task page links to it", async () => {
  const { id } = await approvedBuild();
  const alex = await signIn("alex");
  const html = await page(alex, `/t/${id}/evidence`);
  expect(html).toContain(`data-evidence-pack="${id}"`);
  expect(html).toContain('data-evidence-chain="ok"');
  expect(html).toContain("<dt>Approval rules</dt><dd>requester can&#39;t approve<ul");
  expect(html).toContain("alex: no rules → requester can&#39;t approve");
  expect(html).toMatch(/Approved<\/dt><dd>sam · /);
  expect(html).toContain("infra/keys/current.pem");
  expect(html).toContain("$0.4200");
  expect(html).toContain(`href="/t/${id}/evidence?format=json" download`);
  expect(/<article class="evidence-pack"[\s\S]*<\/article>/.exec(html)![0]).not.toMatch(/<script/i);
  expect(await page(alex, `/t/${id}`)).toContain(`/t/${id}/evidence`);
  // A broken chain says so, on the page and in the JSON.
  store.handle.exec("DROP TRIGGER action_ledger_no_update");
  const first = store.handle.prepare("SELECT MIN(id) AS id FROM action_ledger WHERE task_id = ?").get(id)!["id"];
  store.handle.prepare("UPDATE action_ledger SET actor = 'mallory' WHERE id = ?").run(first);
  // Page views check what's new; the next whole walk (here, asked for) finds the old entry changed, and the pages say so from then on.
  expect(store.ledgerChain({ full: true }).ok).toBe(false);
  expect(await page(alex, `/t/${id}/evidence`)).toContain('data-evidence-chain="broken"');
  expect(((await (await get(alex, `/t/${id}/evidence?format=json`)).json()) as EvidencePack).ledger.chain.ok).toBe(false);
});

test("requests made about a task before it existed, or a flood of them since, never push its own entries out", async () => {
  const at = new Date().toISOString();
  const forged = (fields: { repo?: string | null; taskId?: string | null; runId?: number | null; outcome: string }) =>
    store.recordAction({ at, actor: "kim", repo: fields.repo ?? null, taskId: fields.taskId ?? null, runId: fields.runId ?? null, action: "task approve", outcome: fields.outcome, source: "request" });
  // Before the task exists: its id (a slug of its title) and the next run's number are easy to guess.
  for (let i = 0; i < 50; i++) { forged({ taskId: "rotate-the-signing-key", outcome: "refused" }); forged({ runId: 1, outcome: "refused" }); }
  const { id, run } = await approvedBuild();
  expect(id).toBe("rotate-the-signing-key");
  // After it exists: more than a pack carries.
  for (let i = 0; i < 600; i++) forged({ repo: REPO, taskId: id, outcome: "refused" });
  const alex = await signIn("alex");
  const pack = await (await get(alex, `/t/${id}/evidence?format=json`)).json() as EvidencePack;
  const own = pack.ledger.entries.filter(one => one.source !== "request");
  expect(own.map(one => one.action)).toEqual(expect.arrayContaining(["task registered", "task filed", "scope approved", "run started", "run finished"]));
  expect(pack.ledger.entries.filter(one => one.source === "request")).toHaveLength(500);
  expect(pack.ledger.truncated).toBe(true);
  // Nothing from before it existed, and nothing named only by its run's number from a request.
  expect(pack.ledger.entries.some(one => one.repo === null && one.source === "request")).toBe(false);
  expect(pack.ledger.entries.filter(one => one.runId === run).every(one => one.source !== "request" || one.taskId === id)).toBe(true);
  expect(await page(alex, `/t/${id}/evidence`)).toContain("the newest 500 requests");
});

test("only people who can see the task get its pack", async () => {
  const { id } = await approvedBuild();
  const kim = await signIn("kim");
  expect((await get(kim, `/t/${id}/evidence`)).status).toBe(404);
  expect((await get(kim, `/t/${id}/evidence?format=json`)).status).toBe(404);
  const sam = await signIn("sam");
  expect((await get(sam, `/t/${id}/evidence?format=json`)).status).toBe(200);
  expect((await fetch(`${base}/t/${id}/evidence?format=json`, { redirect: "manual" })).status).not.toBe(200);
  expect((await get(sam, "/t/no-such-task/evidence")).status).toBe(404);
});

test("the audit export covers a date range: sealed entries and a pack per task, within the reader's projects, and is itself in the ledger", async () => {
  const { id } = await approvedBuild();
  store.recordAction({ at: new Date().toISOString(), actor: "kim", repo: OTHER, taskId: null, runId: null, action: "elsewhere", outcome: "done", source: "policy" });
  const today = new Date().toISOString().slice(0, 10);
  const sam = await signIn("sam");
  const answer = await get(sam, `/ledger/export?from=${today}&to=${today}`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get("content-disposition")).toBe(`attachment; filename="standing-orders-audit-${today}-to-${today}.json"`);
  const bundle = await answer.json() as LedgerExport;
  expect(bundle.format).toBe("standing-orders/ledger-export/v1");
  expect(bundle.entries.length).toBeGreaterThan(0);
  expect(bundle.entries.every(one => one.repo === REPO && one.seal !== null)).toBe(true);
  expect(bundle.entries.some(one => one.action === "elsewhere")).toBe(false);
  expect(bundle.packs.map(one => one.task.id)).toEqual([id]);
  expect(store.actionLedger({ repos: null, instance: true, limit: 5 }).find(one => one.action === "ledger exported")).toMatchObject({ actor: "sam", source: "access" });
  expect((await get(sam, "/ledger/export?from=2026-02-30&to=2026-03-01")).status).toBe(400);
  expect((await get(sam, `/ledger/export?from=${today}&to=2020-01-01`)).status).toBe(400);
  // The ledger page offers it.
  expect(await page(sam, "/ledger")).toContain('action="/ledger/export"');
});

test("the command line writes a task's pack as JSON or a printable page", async () => {
  const { id } = await approvedBuild();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  let lines: string[] = [];
  const write = (line: string) => { lines.push(line); };
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("task", argv, write, { databaseFile: file, evidenceRoot: join(dir, "evidence") }); return { code, out: lines.join("\n") }; };
  const json = await run(["evidence", id]);
  expect(json.code).toBe(0);
  expect((JSON.parse(json.out) as EvidencePack).versions[0]!.scope!.approved!.by).toBe("sam");
  const out = join(dir, "pack.html");
  expect((await run(["evidence", id, "--html", "--out", out])).code).toBe(0);
  const html = readFileSync(out, "utf8");
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain("Rotate the signing key");
  expect(html).not.toMatch(/<script/i);
  expect((await run(["evidence", "no-such-task", "--json"])).code).toBe(3);
  const enveloped = JSON.parse((await run(["evidence", id, "--json"])).out) as { ok: boolean; command: string; pack: EvidencePack };
  expect(enveloped).toMatchObject({ ok: true, command: "task evidence", pack: { task: { id } } });
  store = openStore(file);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
});
