/** A real repository, plane database and approver for project-memory tests, with runs that freeze context. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, addApprover, propose } from "../src/scope.js";
import { register } from "../src/runner.js";
import { openStore, type Store } from "../src/store.js";

export const MEMORY_NOW = new Date("2026-11-05T12:00:00.000Z");
export type MemoryFixture = { root: string; repo: string; db: string; store: Store; password: string; head: string; start(title?: string): number; close(): void };

export function memoryFixture(): MemoryFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-fixture-")));
  const repo = join(root, "repo"), db = join(root, "test.db");
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "guide.md"), "# Guide\nShort labels.\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed");
  const head = git("rev-parse", "HEAD");
  const store = openStore(db);
  const user = addApprover(store, "alex", MEMORY_NOW);
  if (!user.ok) throw new Error("fixture");
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", MEMORY_NOW);
  register(store, { name: "runner", host: "test", capacity: 100, repos: [repo], now: MEMORY_NOW, newToken: () => "runner-token" });
  let serial = 0;
  const start = (title = "Improve the guide"): number => {
    const id = `memory-${serial++}`;
    store.createTask({ id, title }, MEMORY_NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    propose(store, { taskId: id, goal: title, touches: ["guide.md"], acceptance: [], now: MEMORY_NOW });
    approve(store, id, "alex", MEMORY_NOW, store.getScope(id)!.digest, user.token);
    const route = store.routeAuthorityFor(ref, "builder", { provider: "claude", model: "sonnet" });
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "runner", role: "builder", branch: `toolroll/${id}`, worktree: repo, provider: "claude", model: "sonnet", now: MEMORY_NOW, route: route.stamp });
    store.stampRun(run, { baseRevision: head });
    return run;
  };
  return { root, repo, db, store, password: user.token, head, start, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

