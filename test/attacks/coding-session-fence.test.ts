/**
 * Attack: an interactive Codex coding session's command reading Toolroll's state or another session's worktree
 * (docs/plans/sandbox-parity.md C3). Sessions ran under Codex's plain `workspace-write`, which reads everything. Now
 * each thread is started and resumed with Toolroll's permission profile as its config (coding-provider.ts
 * codingSessionPermissions). This proves that profile natively under `codex sandbox`, with a positive control; that a
 * real app-server thread honours the same config was checked by hand (a model turn) and is in the release evidence.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { codingSessionPermissions } from "../../src/coding-provider.js";
import { openStore, type Store } from "../../src/store.js";
import { codexSandbox, git, marker, needs, repository, useScratch, write } from "./harness.js";

const scratch = useScratch("coding-session");
const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** The thread's config overrides as `codex sandbox` takes them: the same keys, as `-c key=value`. */
function configArgv(config: Record<string, unknown>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? toml(value) : typeof value === "boolean" ? String(value)
    : `{${Object.entries(value as Record<string, string>).map(([path, mode]) => `${toml(path)}=${toml(mode)}`).join(",")}}`}`]);
}

let root: string, repo: string, sessions: string, own: string, sibling: string, store: Store;
const secrets: Record<string, string> = {};
beforeEach(() => {
  root = scratch();
  repo = repository(join(root, "shop"));
  const state = join(root, "toolroll");
  sessions = join(state, "coding-worktrees");
  mkdirSync(sessions, { recursive: true });
  store = openStore(join(state, "orders.db"));
  own = join(sessions, "own");
  sibling = join(sessions, "sibling");
  git(repo, "worktree", "add", "-q", "-b", "code-own", own);
  git(repo, "worktree", "add", "-q", "-b", "code-sibling", sibling);
  secrets["state"] = marker("coding-state");
  secrets["sibling"] = marker("coding-sibling");
  write(join(state, "up-login.txt"), secrets["state"]);
  write(join(sibling, "notes.txt"), secrets["sibling"]);
});

describe("attack: a coding session reaching past its worktree", () => {
  test("its profile denies the state and another session's worktree, and writes its own worktree; without it both are read", ctx => {
    needs(ctx, codexSandbox());
    const made = codingSessionPermissions(store, sessions)({ repo, worktree: own });
    if (!("config" in made)) throw new Error(JSON.stringify(made));
    expect(made.config).toMatchObject({ default_permissions: "standing-orders", "permissions.standing-orders.extends": ":workspace" });
    const script = [
      ...Object.entries({ state: join(root, "toolroll", "up-login.txt"), sibling: join(sibling, "notes.txt") })
        .map(([name, path]) => `if cat ${JSON.stringify(path)}; then echo ${name}:read; else echo ${name}:denied; fi`),
      "echo made > own-file.txt && echo own:written",
    ].join("\n");
    const home = join(root, "codex-home");
    mkdirSync(home);
    const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: home };
    const fenced = spawnSync("codex", ["sandbox", ...configArgv(made.config), "-P", "standing-orders", "--", "/bin/sh", "-c", script], { cwd: own, encoding: "utf8", env, timeout: 60_000 });
    expect(fenced.stdout, fenced.stderr).toContain("state:denied");
    expect(fenced.stdout).toContain("sibling:denied");
    expect(fenced.stdout).toContain("own:written");
    for (const secret of Object.values(secrets)) expect(fenced.stdout + fenced.stderr).not.toContain(secret);
    // Positive control: plain workspace-write (what sessions had) reads both.
    const plain = spawnSync("codex", ["sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "/bin/sh", "-c", script], { cwd: own, encoding: "utf8", env, timeout: 60_000 });
    expect(plain.stdout, plain.stderr).toContain("state:read");
    expect(plain.stdout).toContain("sibling:read");
  });

  test("a worktree that isn't one of the project's own refuses the session", () => {
    const stray = join(sessions, "stray");
    mkdirSync(stray);
    expect(codingSessionPermissions(store, sessions)({ repo, worktree: stray })).toMatchObject({ problem: expect.stringMatching(/couldn't be bound/) });
  });
});
