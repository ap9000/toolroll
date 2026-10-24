/**
 * Attack: a link planted at a sign-in name, leading into Toolroll's own state, read by a `sign-ins` check (docs/plans/
 * sandbox-parity.md C10). Sign-ins used to be off: a privileged reader resolved the name before the sandbox, and a
 * folder swapped between its checks and its read leaked. Now nothing privileged reads a sign-in file: the check reads
 * it by name, through its sandbox, which resolves the link inside its own view — into the denied state. Positive
 * control: unsandboxed, the same read follows the link to the database. Both platforms, under policy v1 and v2.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/exec.js";
import { fencedCheckoutCommands } from "../../src/invoke.js";
import { openStore, type Store } from "../../src/store.js";
import { marker, needs, osFence, write } from "./harness.js";
import { outsideTempDir } from "../short-temp.js";

const OPEN = { version: 1 as const, mode: "open" as const, hosts: [], loopback: "proxy-only" as const };
let root: string, home: string, repo: string, checkout: string, store: Store, secret: string, savedHome: string | undefined;

beforeEach(() => {
  // A check's launch folder is short on a Mac; the state stays in this test's own (short) folder.
  root = realpathSync(outsideTempDir(".so-signins-link-"));
  home = join(root, "home");
  const state = join(root, "toolroll");
  mkdirSync(state, { recursive: true });
  store = openStore(join(state, "orders.db"));
  secret = marker("database");
  write(join(state, "up-login.txt"), secret);
  write(join(home, ".claude.json"), "{}\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  // The planted name: gh's hosts file, a link into Toolroll's state.
  symlinkSync(join(state, "up-login.txt"), join(home, ".config", "gh", "hosts.yml"));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
  checkout = join(root, "check");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", checkout, "main"]);
  savedHome = process.env["HOME"];
  process.env["HOME"] = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
  store.close();
  const { rmSync } = await import("node:fs");
  rmSync(root, { recursive: true, force: true });
});

describe("attack: a sign-in name planted as a link into Toolroll's state", () => {
  test("unsandboxed the read follows it; a sign-ins check (v1 and v2) is refused it, and still reads its other sign-in files", async ctx => {
    needs(ctx, osFence());
    expect(execFileSync("cat", [join(home, ".config", "gh", "hosts.yml")], { encoding: "utf8" })).toBe(secret);
    const script = [
      `if cat ${JSON.stringify(join(home, ".config", "gh", "hosts.yml"))} 2>/dev/null; then :; else echo hosts-refused; fi`,
      `cat ${JSON.stringify(join(home, ".claude.json"))} >/dev/null 2>&1 && echo account-read || echo account-refused`,
    ].join("\n");
    for (const policy of [1, 2] as const) {
      const result = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sign-ins", OPEN, { policy, readDeny: [], machLookup: [], unlock: [] })("/bin/sh", ["-c", script], { cwd: checkout });
      expect(result.stdout, `${policy}: ${result.stderr}`).not.toContain(secret);
      expect(result.stdout.trim().split("\n"), `${policy}: ${result.stderr}`).toEqual(["hosts-refused", "account-read"]);
    }
  });
});
