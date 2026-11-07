/**
 * A code map world: a project with a recorded network remote that maps, through the runner's transport seam, onto a bare
 * fixture repository. Production keeps file transport refused; only this fixture's reads opt in.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundedRun, type BoundedRunner } from "../src/bounded-spawn.js";
import type { MapDeps } from "../src/code-map-build.js";
import { openStore, type Store } from "../src/store.js";

export const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const URL_A = "https://trusted.example/shop.git";
export const URL_B = "https://moved.example/shop.git";

export type MapWorld = {
  dir: string; repo: string; origin: string; work: string; store: Store; scratch: string; now: { at: Date };
  deps: (extra?: Partial<MapDeps>) => MapDeps;
  commit: (files: Record<string, string | Buffer>, message?: string) => string;
  git: (...args: string[]) => string;
  seam: BoundedRunner;
  close: () => void;
};

export function mapWorld(files: Record<string, string | Buffer> = { "src/a.ts": "export const a = 1;\n" }): MapWorld {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-map-")));
  const origin = join(dir, "origin.git"), work = join(dir, "work"), repo = join(dir, "shop"), scratch = join(dir, "state", ".code-map");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env: GIT_ENV, stdio: "pipe", encoding: "utf8" }).trim();
  mkdirSync(repo); mkdirSync(work); mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(work, "init", "-q", "-b", "main");
  sh(work, "remote", "add", "origin", origin);
  sh(repo, "init", "-q", "-b", "main");
  const commit = (next: Record<string, string | Buffer>, message = "change") => {
    for (const [file, text] of Object.entries(next)) { mkdirSync(dirname(join(work, file)), { recursive: true }); writeFileSync(join(work, file), text); }
    sh(work, "add", "-A"); sh(work, "commit", "-qm", message, "--allow-empty"); sh(work, "push", "-q", "origin", "main");
    return sh(work, "rev-parse", "HEAD");
  };
  if (Object.keys(files).length > 0) commit(files, "seed");
  const store = openStore(join(dir, "orders.db"));
  const now = { at: new Date("2026-11-06T12:00:00.000Z") };
  store.upsertProject(repo, "shop", now.at, { remoteUrl: URL_A });
  const fileUrl = `file://${origin}`;
  // The transport seam: the recorded URLs read the fixture.
  const seam: BoundedRunner = (file, args, options) => boundedRun(file, args.map(arg => arg === URL_A || arg === URL_B ? fileUrl : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg), options);
  const deps = (extra: Partial<MapDeps> = {}): MapDeps => ({ scratch, bounded: seam, lookup: async () => ["93.184.216.34"], pinWorks: async () => true, env: {}, owner: "worker-a", clock: () => now.at, ...extra });
  return { dir, repo, origin, work, store, scratch, now, deps, commit, git: (...args) => sh(work, ...args), seam, close: () => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

/** Record a new remote as the project-admission transaction does. */
export function changeRemote(world: MapWorld, url: string): void {
  world.store.transact(() => {
    const previous = world.store.projectRemote(world.repo);
    world.store.upsertProject(world.repo, "shop", world.now.at, { remoteUrl: url });
    world.store.recordProjectRemote("alex", world.repo, previous, url, world.now.at);
  });
}
