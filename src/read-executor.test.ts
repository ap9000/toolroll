/** Heavy reads on read-only worker connections (read-executor.ts): same pages, same errors, a free request loop. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { ReadExecutor, ReadExecutorError, attachReadExecutor, readExecutorOf } from "./read-executor.js";
import { workCountsByProject, workIndexPage, WorkIndexCursorError } from "./work-index.js";
import { projectSummaryOf } from "./console-chrome.js";
import { addApprover } from "./scope.js";
import { serverRequest } from "../test/server-request.js";
import { PersistentSessions, SESSION_COOKIE } from "./server/session.js";

let dir: string, store: Store, file: string, project: string;
const stamp = "2026-10-07T10:00:00.000Z";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-read-executor-")));
  file = join(dir, "orders.db");
  project = join(dir, "project");
  mkdirSync(project);
  store = openStore(file);
  store.transact(() => {
    store.handle.prepare("INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)").run(project, "Read project", stamp, stamp);
    const task = store.handle.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)");
    const ref = store.handle.prepare("INSERT INTO task_ref(backend,external_id,repo) VALUES('built-in',?,?)");
    const run = store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,started_at,phase,branch,worktree) VALUES(?,?,'reader-agent',?,'build','reader',?)");
    for (let i = 0; i < 60; i++) {
      task.run(`read-task-${i}`, `Read task ${i}`, i < 5 ? "running" : i < 10 ? "done" : "queued", stamp, stamp);
      const id = ref.run(`read-task-${i}`, i % 7 === 0 ? null : project).lastInsertRowid;
      if (i < 5) run.run(id, `read-lease-${i}`, stamp, project);
    }
  });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const now = new Date("2026-10-07T12:00:00.000Z");
const access = { principal: "operator" as const, repos: null, includeUnplaced: true };

test("a worker's read-only page equals the in-process page, page by page and per view", async () => {
  const reads = new ReadExecutor(file, 2);
  try {
    for (const view of ["all", "needs-you", "running", "completed"] as const) {
      let cursor: string | null = null;
      do {
        const options = { view, limit: 7, cursor };
        const local = workIndexPage(store, now, access, options);
        expect(await reads.workIndexPage(now, access, options)).toEqual(local);
        cursor = local.nextCursor;
      } while (cursor !== null);
    }
    const limited = { principal: "operator" as const, repos: [project], includeUnplaced: false };
    expect(await reads.workIndexPage(now, limited, { state: "queued", limit: 100 })).toEqual(workIndexPage(store, now, limited, { state: "queued", limit: 100 }));
    // The same cursor refusal, as the same error class the CLI turns into a usage message.
    await expect(reads.workIndexPage(now, access, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(WorkIndexCursorError);
  } finally { await reads.close(); }
});

test("the console's chrome on a worker equals it in process, for each reader's own scope", async () => {
  const reads = new ReadExecutor(file, 2);
  try {
    const projects = [{ path: project, name: "Read project" }];
    for (const one of [{ ...access, viewer: "alex" }, { principal: "operator" as const, repos: [project], includeUnplaced: false, viewer: "robin" }]) {
      expect(await reads.workCounts(now, one)).toEqual(workCountsByProject(store, now, one));
      expect(await reads.projectSummary(now, one, one.viewer, projects, undefined)).toEqual(projectSummaryOf(store, now, one, one.viewer, projects, undefined));
    }
  } finally { await reads.close(); }
});

test("a worker reads committed writes, never writes, and fails rather than falling back", async () => {
  const reads = new ReadExecutor(file, 1);
  try {
    expect((await reads.workIndexPage(now, access, { limit: 100 })).totals.all).toBe(60);
    store.handle.prepare("UPDATE task SET title='Renamed after commit' WHERE id='read-task-20'").run();
    const page = await reads.workIndexPage(now, access, { limit: 100 });
    expect(page.items.find(item => item.rootId === "read-task-20")?.title).toBe("Renamed after commit");
  } finally { await reads.close(); }
  // A file that is not this schema's database: one terminal error, no in-process answer.
  const missing = new ReadExecutor(join(dir, "missing.db"), 1);
  try { await expect(missing.workIndexPage(now, access, {})).rejects.toThrow(/read-only at the current schema/); }
  finally { await missing.close(); }
});

test("close fails queued and running reads once and refuses new ones", async () => {
  const reads = new ReadExecutor(file, 1);
  const queued = [reads.workIndexPage(now, access, {}), reads.workIndexPage(now, access, {}), reads.workIndexPage(now, access, {})];
  const settled = Promise.allSettled(queued);
  await reads.close();
  for (const result of await settled) expect(result.status === "rejected" && result.reason instanceof ReadExecutorError).toBe(true);
  await expect(reads.workIndexPage(now, access, {})).rejects.toThrow(/closing/);
  const detach = attachReadExecutor(store, reads);
  expect(readExecutorOf(store)).toBe(reads);
  detach();
  expect(readExecutorOf(store)).toBeNull();
});

test("remote task list: identical output through the worker, and the request loop stays free while it reads", async () => {
  store.saveApprover("reader", "unused-password", now);
  const token = mintApiToken();
  store.createApiToken({ id: token.id, account: "reader", name: "reader-laptop", secretHash: token.hash, access: "read", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), by: "reader" }, new Date());
  const serve = async (readWorkers: number) => {
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir, readWorkers });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const list = async (argv: string[]) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
      return { status: response.status, body: await response.json() as { exitCode: number; stdout: string } };
    };
    return { server, list, attached: readExecutorOf(store) };
  };
  const commands = [["task", "list", "--limit", "40", "--json"], ["task", "list", "--view", "running"], ["task", "list", "--cursor", "bad", "--json"], ["task", "list", "--state", "done", "--json"]];
  const inProcess = await serve(0);
  expect(inProcess.attached).toBeNull();
  const expected = [];
  try { for (const argv of commands) expected.push(await inProcess.list(argv)); }
  finally { await new Promise(resolve => inProcess.server.close(resolve)); }
  expect(expected[0]!.body.exitCode).toBe(0);
  expect(expected[2]!.body.stdout).toContain("Invalid page cursor");

  const offloaded = await serve(2);
  expect(offloaded.attached).toBeInstanceOf(ReadExecutor);
  try {
    for (const [index, argv] of commands.entries()) expect(await offloaded.list(argv)).toEqual(expected[index]);
    // The loop stays free while a read is outstanding, proven by events rather than a wall-clock budget (a 1 s
    // event-loop-delay cap failed at 2 s on a loaded CI runner): one list's worker read is held open, and while it is
    // held a timer fires and 24 more lists are answered through the worker, identical to the in-process pages.
    const executor = offloaded.attached!;
    const read = executor.workIndexPage.bind(executor);
    let calls = 0;
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    executor.workIndexPage = async (...args) => {
      const page = read(...args);
      if (calls++ === 0) { entered(); await gate; }
      return page;
    };
    let heldAnswered = false;
    const first = offloaded.list(commands[0]!).then(result => { heldAnswered = true; return result; });
    await held;
    await new Promise(resolve => setTimeout(resolve, 0));
    const results = await Promise.all(Array.from({ length: 24 }, () => offloaded.list(commands[0]!)));
    expect(heldAnswered).toBe(false);
    for (const result of results) expect(result).toEqual(expected[0]);
    expect(calls).toBe(25);
    release();
    expect(await first).toEqual(expected[0]);
  } finally { await new Promise(resolve => offloaded.server.close(resolve)); }
  // Close detaches the executor from the store, so later local commands read in-process again.
  expect(readExecutorOf(store)).toBeNull();
});

test.each(["session ended", "account revoked", "project access removed", "console ceiling narrowed"])("chrome prefetch rechecks authority after the worker returns: %s", async change => {
  const added = addApprover(store, "alex", now);
  if (!added.ok) throw new Error("account fixture");
  expect(addApprover(store, "admin", now, { name: "alex", token: added.token }).ok).toBe(true);
  const sessionId = "a".repeat(64), at = Date.now();
  store.saveWebSession({ idHash: PersistentSessions.hash(sessionId), account: "alex", csrf: "b".repeat(64), role: "approver",
    generation: store.approverGeneration("alex")!, createdAt: at, lastSeen: at, project, projectRevision: 0, ssoAt: null, agent: null, address: null });
  let admitted = [project];
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [project], admittedRepos: () => admitted, allowedHosts: ["127.0.0.1:4180"], readWorkers: 1 });
  let release!: () => void;
  try {
    const reads = readExecutorOf(store)!;
    const read = reads.projectSummary.bind(reads);
    let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    reads.projectSummary = async (...args) => { const value = await read(...args); entered(); await resume; return value; };
    const response = serverRequest(server, "/t/read-task-1?format=workspace", { cookie: `${SESSION_COOKIE}=${sessionId}` });
    await Promise.race([held, response.then(result => { throw new Error(`answered before prefetch: ${result.status} ${result.body}`); })]);
    if (change === "session ended") store.dropWebSession(PersistentSessions.hash(sessionId));
    else if (change === "account revoked") expect(store.revokeAccount("alex", "admin", now).ok).toBe(true);
    else if (change === "project access removed") expect(store.setAccountProjects("alex", [], "admin", now).ok).toBe(true);
    else admitted = [];
    release();
    const result = await response;
    expect(result.status).toBe(change === "console ceiling narrowed" ? 404 : 303);
    if (change !== "console ceiling narrowed") expect(result.headers.get("location")).toContain("/login");
    expect(result.headers.has("etag")).toBe(false);
    expect(result.body).not.toContain('"title":"Read task 1"');
  } finally { release?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("chrome completed before another worker job is revalidated at render after an approval state changes", async () => {
  const added = addApprover(store, "alex", now);
  if (!added.ok) throw new Error("account fixture");
  const sessionId = "a".repeat(64), at = Date.now();
  store.saveWebSession({ idHash: PersistentSessions.hash(sessionId), account: "alex", csrf: "b".repeat(64), role: "approver",
    generation: store.approverGeneration("alex")!, createdAt: at, lastSeen: at, project, projectRevision: 0, ssoAt: null, agent: null, address: null });
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [project], allowedHosts: ["127.0.0.1:4180"], readWorkers: 2, clock: () => now });
  let release!: () => void;
  try {
    const reads = readExecutorOf(store)!;
    const count = reads.workCounts.bind(reads), summary = reads.projectSummary.bind(reads);
    let countEntered!: () => void, summaryReturned!: () => void;
    const waiting = new Promise<void>(resolve => { countEntered = resolve; });
    const summaryReady = new Promise<void>(resolve => { summaryReturned = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    reads.workCounts = async (...args) => { const value = await count(...args); countEntered(); await resume; return value; };
    reads.projectSummary = async (...args) => { const value = await summary(...args); summaryReturned(); return value; };
    const response = serverRequest(server, "/board?format=workspace", { cookie: `${SESSION_COOKIE}=${sessionId}` });
    await Promise.race([Promise.all([waiting, summaryReady]), response.then(result => { throw new Error(`answered before prefetch: ${result.status}`); })]);
    // Let the resolved summary finish filling while counts remain outstanding; this is an event boundary, not a delay.
    await new Promise<void>(resolve => setImmediate(resolve));
    // Cancel the tasks whose unapproved plans contribute Needs you. The next page must not retain their old asks.
    for (let i = 10; i < 60; i++) expect(store.cancelTask(`read-task-${i}`, now).ok).toBe(true);
    release();
    const result = await response;
    expect(result.status).toBe(200);
    const workspace = JSON.parse(result.body);
    const current = projectSummaryOf(store, now, { ...access, repos: [project], viewer: "alex" }, "alex", [{ path: project, name: "Read project" }], join(dir, "evidence"));
    expect(workspace.projectStates).toEqual(current);
    expect(workspace.navigation.find((one: { label: string }) => one.label === "Tasks").count).toBe(workCountsByProject(store, now, { ...access, repos: [project], viewer: "alex" }).filter(one => one.repo === project).reduce((n, one) => n + one.totals["needs-you"], 0));
  } finally { release?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
