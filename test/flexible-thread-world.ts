/**
 * A plane with one project for Flexible thread tests (flexible-thread.ts): a state folder named as Toolroll's own or
 * as a shared folder, its database, a project repository with two commits (a branch at the first) registered in the
 * store, and git with a fixed identity and no global or system config. The test file's own HOME (test/setup-state.ts)
 * is the home every fence denies credentials in.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.js";

export const THREAD_GIT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Thread test", GIT_AUTHOR_EMAIL: "thread@example.invalid", GIT_COMMITTER_NAME: "Thread test", GIT_COMMITTER_EMAIL: "thread@example.invalid",
};

export function tgit(cwd: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: THREAD_GIT_ENV });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${ran.stderr}`);
  return ran.stdout.trim();
}

/** Every object file and pack in a repository's objects folder, with its size: equal before and after means unchanged. */
export function objectsInventory(objects: string): string[] {
  return (readdirSync(objects, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter(one => one.isFile()).map(one => join(one.parentPath, one.name).slice(objects.length)).sort();
}

export type ThreadWorld = { dir: string; state: string; databaseFile: string; store: Store; project: string; objects: string; first: string; second: string; other: string };

export function threadWorld(options: { stateName?: string } = {}): ThreadWorld {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flex-thread-")));
  const state = join(dir, options.stateName ?? "toolroll");
  mkdirSync(state);
  const databaseFile = join(state, "orders.db");
  const store = openStore(databaseFile);
  const project = join(dir, "projects", "shop");
  mkdirSync(project, { recursive: true });
  tgit(project, "init", "-q");
  writeFileSync(join(project, "README.md"), "shop\n");
  tgit(project, "add", "README.md");
  tgit(project, "commit", "-qm", "first");
  const first = tgit(project, "rev-parse", "HEAD");
  tgit(project, "branch", "release");
  writeFileSync(join(project, "app.js"), "console.log('shop');\n");
  tgit(project, "add", "app.js");
  tgit(project, "commit", "-qm", "second");
  const second = tgit(project, "rev-parse", "HEAD");
  // Packed, so the shared objects include a pack a thread could try to destroy.
  tgit(project, "gc", "-q");
  writeFileSync(join(project, "loose.txt"), "loose\n");
  tgit(project, "add", "loose.txt");
  const other = join(dir, "projects", "other");
  mkdirSync(other, { recursive: true });
  tgit(other, "init", "-q");
  writeFileSync(join(other, "secret.txt"), "other project\n");
  const now = new Date();
  store.upsertProject(project, "shop", now);
  store.upsertProject(other, "other", now);
  return { dir, state, databaseFile, store, project, objects: realpathSync(join(project, ".git", "objects")), first, second, other };
}
