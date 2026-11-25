/**
 * Attack: make `toolroll handoff` run a program of the repository's choosing. The handoff's git runs in the developer's
 * repository and in a worktree whose content came from the central server, so a hook, a command-naming setting (an
 * fsmonitor, a clean or smudge filter, a diff textconv) or an attributes file planted there would run as the developer
 * the moment handoff ran git with their inherited config. Guard: every handoff git command goes through
 * teardown-git.ts teardownGit (a view of the repository whose config is read once and refused when it names a
 * command, hooks off, no system or global config, an allowlisted environment).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../../src/store.js";
import { addApprover } from "../../src/scope.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { createDecisionServer } from "../../src/serve.js";
import { maybeRunConnectCommand } from "../../src/connect-cli.js";
import { maybeRunHandoffCommand } from "../../src/handoff-cli.js";

let store: Store;
let dir: string;
let server: Server | undefined;
let localRepo: string;
let markers: string;
let profileFile: string;
const now = () => new Date();

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

/** A program that, if anything ever runs it, leaves a file named `name` in the markers folder. */
function planted(name: string): string {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null 2>&1\necho ran > '${join(markers, name)}'\n`);
  chmodSync(path, 0o755);
  return path;
}

async function handoff(args: string[], cwd?: string): Promise<{ code: number | null; said: string }> {
  const lines: string[] = [];
  const code = await maybeRunHandoffCommand(["handoff", ...args], line => lines.push(line), { profileFile, ...(cwd === undefined ? {} : { cwd }) });
  return { code, said: lines.join("\n") };
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-handoff-attack-")));
  markers = join(dir, "markers");
  mkdirSync(markers);
  store = openStore(join(dir, "orders.db"));
  const centralRepo = join(dir, "central-repo");
  mkdirSync(centralRepo);
  git(centralRepo, ["init", "-b", "main"]);
  writeFileSync(join(centralRepo, "hello.txt"), "hello world\n");
  git(centralRepo, ["add", "hello.txt"]);
  git(centralRepo, ["commit", "-m", "initial"]);
  localRepo = join(dir, "local-repo");
  git(dir, ["clone", centralRepo, localRepo]);

  if (!addApprover(store, "alice", now()).ok) throw new Error("alice");
  const token = mintApiToken();
  store.createApiToken({ id: token.id, account: "alice", name: "act", secretHash: token.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alice", projects: [centralRepo], purpose: "api" }, now());
  store.createTask({ id: "t-attack", title: "Handoff attack" }, now());
  store.placeTask(store.refFor("built-in", "t-attack", "ours").id, centralRepo);
  server = createDecisionServer({ store, configDir: dir, evidenceRoot: join(dir, "evidence"), repos: [centralRepo] });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("address");
  profileFile = join(dir, "remote", "profiles.json");
  expect(await maybeRunConnectCommand(["connect", `http://127.0.0.1:${address.port}`, "--as", "alice", "--token-stdin"], () => {},
    { profileFile, readStdin: async () => token.token, stderr: () => {} })).toBe(0);
});

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((done, fail) => server!.close(error => error ? fail(error) : done()));
  server = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attack: a repository's own hooks, settings and attributes running during handoff", () => {
  test("planted hooks never run: pull makes its worktree with post-checkout and reference-transaction hooks in place", async () => {
    for (const hook of ["post-checkout", "reference-transaction", "pre-commit", "post-commit"]) {
      const path = join(localRepo, ".git", "hooks", hook);
      writeFileSync(path, `#!/bin/sh\necho ran > '${join(markers, hook)}'\n`);
      chmodSync(path, 0o755);
    }
    const pulled = await handoff(["pull", "t-attack", "--repo", localRepo]);
    expect(pulled.code, pulled.said).toBe(0);
    expect(existsSync(join(localRepo, ".git", "toolroll-handoff", "t-attack", "hello.txt"))).toBe(true);
    expect(readdirSync(markers)).toEqual([]);
  });

  test("a core.fsmonitor command in the repository's config is refused before git runs anything", async () => {
    git(localRepo, ["config", "core.fsmonitor", planted("fsmonitor")]);
    const pulled = await handoff(["pull", "t-attack", "--repo", localRepo]);
    expect(pulled.code).toBe(1);
    expect(pulled.said).toContain("core.fsmonitor");
    expect(readdirSync(markers)).toEqual([]);
  });

  test("clean/smudge filters and a diff textconv planted after the pull never run on status, push, rebase or clean", async () => {
    const pulled = await handoff(["pull", "t-attack", "--repo", localRepo]);
    expect(pulled.code, pulled.said).toBe(0);
    const worktree = join(localRepo, ".git", "toolroll-handoff", "t-attack");
    git(localRepo, ["config", "filter.evil.clean", planted("clean")]);
    git(localRepo, ["config", "filter.evil.smudge", planted("smudge")]);
    git(localRepo, ["config", "diff.evil.textconv", planted("textconv")]);
    git(localRepo, ["config", "diff.evil.command", planted("extdiff")]);
    writeFileSync(join(worktree, ".gitattributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(worktree, "hello.txt"), "changed locally\n");
    for (const args of [["status"], ["push", "--note", "x"], ["rebase"], ["clean"], ["clean", "t-attack", "--repo", localRepo, "--force"]]) {
      const ran = await handoff(args, worktree);
      expect(ran.code, `${args.join(" ")}: ${ran.said}`).toBe(1);
      expect(ran.said, args.join(" ")).toMatch(/can run a command/);
    }
    expect(readdirSync(markers)).toEqual([]);
    expect(existsSync(worktree)).toBe(true);
  });
});
