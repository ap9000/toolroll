/** Heavy reads on read-only worker connections (read-executor.ts): same pages, same errors, a free request loop. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openStore, type Store } from "./store.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { ReadExecutor, ReadExecutorError, attachReadExecutor, readExecutorOf } from "./read-executor.js";
import { workIndexPage, WorkIndexCursorError } from "./work-index.js";

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
    // Many concurrent lists: the loop keeps answering timers (each read is on a worker connection).
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const results = await Promise.all(Array.from({ length: 24 }, () => offloaded.list(commands[0]!)));
    delay.disable();
    for (const result of results) expect(result).toEqual(expected[0]);
    expect(delay.max / 1e6).toBeLessThan(1_000);
  } finally { await new Promise(resolve => offloaded.server.close(resolve)); }
  // Close detaches the executor from the store, so later local commands read in-process again.
  expect(readExecutorOf(store)).toBeNull();
});
