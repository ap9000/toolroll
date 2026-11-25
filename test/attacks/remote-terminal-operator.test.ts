/**
 * A central Live Terminal started over the remote API runs native tools under the installation's login, which reach past
 * any one project. So, as for the console's own terminals and the coding workspace, only an installation-wide operator
 * on a project the coding workspace admits may start or reuse one: a project-scoped approver with an act token is
 * refused before anything is reserved or spawned, and an operator whose access changes after admission is refused at
 * the spawn itself.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fakePid } from "../fake-pid.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { TerminalHost, type Pty, type PtySpawn } from "../../src/live-terminal.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer } from "../../src/serve.js";
import { openStore, type Store } from "../../src/store.js";
import { teardownGit, type Git } from "../../src/teardown-git.js";

const dirs: string[] = [];
const servers: http.Server[] = [];
const hosts: TerminalHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.stop();
  while (servers.length > 0) { const s = servers.pop()!; await new Promise<void>(resolve => s.close(() => resolve())); }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = new Date("2026-11-20T18:00:00Z");

function fakeSpawn(spawned: { count: number }): PtySpawn {
  return () => {
    spawned.count++;
    const exits: Array<(exit: { exitCode: number }) => void> = [];
    let exited = false;
    const pty: Pty = {
      pid: fakePid(spawned.count), tty: null, pendingInput: () => 0, onData: () => undefined, onExit: fn => { exits.push(fn); },
      write: () => undefined, resize: () => undefined,
      kill: () => { if (!exited) { exited = true; for (const fn of exits) fn({ exitCode: 0 }); } },
    };
    return pty;
  };
}

function post(origin: string, path: string, token: string, identity: { id: string; recoveryGeneration: string }): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin), body = JSON.stringify({ program: "shell" });
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: {
      accept: "application/json", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
      authorization: `Bearer ${token}`, "x-toolroll-client": "terminal-remote", "x-toolroll-workspace": identity.id, "x-toolroll-recovery": identity.recoveryGeneration,
    } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function world(onHostGit: (store: Store, repo: string) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-rt-op-")));
  dirs.push(root);
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "app.txt"), "v1\n");
  execFileSync("git", ["-C", repo, "add", "app.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const store = openStore(join(root, "state.db"));
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw Error("sam");
  // Sam is an approver on this one project only: not an installation-wide operator.
  expect(store.setAccountProjects("sam", [repo], "alex", NOW)).toEqual({ ok: true });
  store.createTask({ id: "t-1", title: "Fix it" }, NOW);
  store.placeTask(store.refFor("built-in", "t-1", "ours").id, repo);
  const tokens: Record<string, string> = {};
  for (const name of ["alex", "sam"]) {
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: name, name: `${name}-act`, secretHash: minted.hash, access: "act", purpose: "api", by: name, projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, NOW);
    tokens[name] = minted.token;
  }
  const spawned = { count: 0 };
  const hardened = teardownGit();
  const git: Git = async (cwd, args) => { onHostGit(store, repo); return hardened(cwd, args); };
  const host = new TerminalHost({ spawn: fakeSpawn(spawned), worktreeRoot: join(root, "live-worktrees"), closeGraceMs: 50, maxSessions: 1, git,
    processes: () => [], programs: { shell: { file: "/bin/sh", args: [] } }, env: () => ({ PATH: process.env["PATH"] ?? "", HOME: root }) });
  hosts.push(host);
  const server = createDecisionServer({ store, configDir: root, evidenceRoot: join(root, "evidence"), repos: [repo], clock: () => NOW, terminalHost: host });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("address");
  const identity = store.workspaceIdentity();
  const start = (who: string) => post(`http://127.0.0.1:${address.port}`, "/api/handoff/task/t-1/terminal", tokens[who]!, identity);
  return { store, repo, host, spawned, start };
}

test("a project-scoped approver is refused: no process, no slot; an operator then starts and reuses one", async () => {
  const w = await world();
  const refused = await w.start("sam");
  expect(refused).toMatchObject({ status: 403, json: { ok: false, error: "operator_required" } });
  expect(w.spawned.count).toBe(0);
  expect(w.host.listAll()).toEqual([]);
  // The only slot (maxSessions: 1) is still free: the operator's start takes it.
  const started = await w.start("alex");
  expect(started).toMatchObject({ status: 200, json: { ok: true, reused: false } });
  expect(w.spawned.count).toBe(1);
  // A running terminal is never handed to a project-scoped approver either.
  expect(await w.start("sam")).toMatchObject({ status: 403, json: { error: "operator_required" } });
  expect(await w.start("alex")).toMatchObject({ status: 200, json: { ok: true, reused: true, id: started.json["id"] } });
  expect(w.spawned.count).toBe(1);
});

test("operator access lost between admission and spawn: refused at the spawn, nothing runs, the slot is free again", async () => {
  let revoke = true;
  const w = await world((store, repo) => {
    // While the host makes the worktree (after admission, before spawn), the operator's account becomes project-scoped.
    // Written without a generation bump, so only the operator rule itself can catch it.
    if (revoke) store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify([repo]));
  });
  const refused = await w.start("alex");
  expect(refused.status).toBe(409);
  expect(refused.json).toMatchObject({ ok: false, error: "start_failed" });
  expect(String(refused.json["message"])).toMatch(/operator access/);
  expect(w.spawned.count).toBe(0);
  expect(w.host.listAll()).toEqual([]);
  // Access restored: the one slot was given back.
  revoke = false;
  w.store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
  expect(await w.start("alex")).toMatchObject({ status: 200, json: { ok: true, reused: false } });
  expect(w.spawned.count).toBe(1);
});
