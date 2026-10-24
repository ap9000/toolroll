/**
 * Check access in the real fence (check-access.ts, invoke.ts): at `sign-ins` a check reads exactly Claude's and gh's
 * sign-in files and a private copy of Codex's, writes only its own Claude transcript folder, and nothing else of the
 * home configuration; at `sandboxed` none of it; at `unsandboxed` it runs with no OS fence at all.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claudeProjectFolder, linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { run } from "./exec.js";
import { fencedCheckoutCommands } from "./invoke.js";
import { openStore, type Store } from "./store.js";
import { outsideTempDir } from "../test/short-temp.js";

const FENCED = macosFenceAvailable() || linuxFenceAvailable();
let dir: string, home: string, repo: string, checkout: string, store: Store;
let savedHome: string | undefined;

beforeEach(async () => {
  dir = realpathSync(outsideTempDir(".so-check-access-"));
  home = join(dir, "home");
  const file = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text, { mode: 0o600 }); };
  file(join(home, ".claude.json"), "{\"account\":1}\n");
  file(join(home, ".claude", "settings.json"), "{}\n");
  file(join(home, ".claude", "history.jsonl"), "private\n");
  file(join(home, ".claude", "projects", "-some-other-project", "s.jsonl"), "other\n");
  file(join(home, ".codex", "config.toml"), "model = \"x\"\n");
  file(join(home, ".codex", "auth.json"), "{\"token\":\"codex\"}\n");
  file(join(home, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: gh\n");
  file(join(home, ".config", "gh", "config.yml"), "git_protocol: https\n");
  file(join(home, ".ssh", "id_test"), "ssh-key\n");
  file(join(home, ".aws", "credentials"), "aws-key\n");
  savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  const state = join(dir, "toolroll");
  mkdirSync(state);
  store = openStore(join(state, "orders.db"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
  checkout = join(dir, "check-checkout");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", checkout, "main"]);
  checkout = realpathSync(checkout);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const reads = (name: string, path: string) => `cat ${JSON.stringify(path)} >/dev/null 2>&1 && echo ${name}-read || echo ${name}-refused`;
const probe = () => [
  reads("claude-account", join(home, ".claude.json")),
  reads("claude-settings", join(home, ".claude", "settings.json")),
  reads("claude-history", join(home, ".claude", "history.jsonl")),
  reads("other-transcript", join(home, ".claude", "projects", "-some-other-project", "s.jsonl")),
  reads("gh-hosts", join(home, ".config", "gh", "hosts.yml")),
  reads("codex-direct", join(home, ".codex", "auth.json")),
  `cat "$CODEX_HOME/auth.json" >/dev/null 2>&1 && test "$CODEX_HOME" != ${JSON.stringify(join(home, ".codex"))} && echo codex-own-copy || echo codex-none`,
  reads("ssh", join(home, ".ssh", "id_test")),
  reads("aws", join(home, ".aws", "credentials")),
  `touch ${JSON.stringify(join(claudeProjectFolder(home, checkout).path, "t.jsonl"))} 2>/dev/null && echo transcript-written || echo transcript-refused`,
  // Never anything a later real session would load: memory/, another file, a folder.
  `mkdir -p ${JSON.stringify(join(claudeProjectFolder(home, checkout).path, "memory"))} 2>/dev/null; echo x > ${JSON.stringify(join(claudeProjectFolder(home, checkout).path, "memory", "x.md"))} 2>/dev/null && echo memory-written || echo memory-refused`,
  `echo x > ${JSON.stringify(join(claudeProjectFolder(home, checkout).path, "CLAUDE.md"))} 2>/dev/null && echo other-written || echo other-refused`,
  `echo "gh=$GH_CONFIG_DIR"`,
].join("\n");

describe.skipIf(!FENCED)("check access in the fence", () => {
  test("sign-ins: exactly the sign-in files, a private Codex home and its own transcript folder; nothing else", async () => {
    const result = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sign-ins")("/bin/sh", ["-c", probe()], { cwd: checkout, env: { GH_CONFIG_DIR: join(home, ".ssh") } });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "claude-account-read", "claude-settings-read", "claude-history-refused", "other-transcript-refused", "gh-hosts-read",
      "codex-direct-refused", "codex-own-copy", "ssh-refused", "aws-refused",
      ...(process.platform === "darwin" ? ["transcript-written"] : ["transcript-refused"]), "memory-refused", "other-refused",
      // A caller's GH_CONFIG_DIR never points the check (or its grant) elsewhere.
      `gh=${join(home, ".config", "gh")}`,
    ]);
  });

  test("sandboxed: none of the home configuration", async () => {
    const result = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sandboxed")("/bin/sh", ["-c", probe()], { cwd: checkout });
    expect(result.stdout.trim().split("\n").slice(0, 12), result.stderr).toEqual([
      "claude-account-refused", "claude-settings-refused", "claude-history-refused", "other-transcript-refused", "gh-hosts-refused",
      "codex-direct-refused", "codex-none", "ssh-refused", "aws-refused", "transcript-refused", "memory-refused", "other-refused",
    ]);
  });

  test("sign-ins: a sign-in file that is a link is never granted", async () => {
    rmSync(join(home, ".config", "gh", "hosts.yml"));
    symlinkSync(join(home, ".ssh", "id_test"), join(home, ".config", "gh", "hosts.yml"));
    const result = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sign-ins")("/bin/sh", ["-c", [
      reads("gh-hosts", join(home, ".config", "gh", "hosts.yml")), reads("ssh", join(home, ".ssh", "id_test")),
    ].join("\n")], { cwd: checkout });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["gh-hosts-refused", "ssh-refused"]);
  });

  test("unsandboxed: no OS fence at all (it may create a sandbox of its own); another project's sandboxed checks stay fenced", async () => {
    const nested = process.platform === "darwin" ? `/usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true && echo nested-ok || echo nested-refused` : "echo nested-ok";
    const open = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "unsandboxed")("/bin/sh", ["-c", [reads("ssh", join(home, ".ssh", "id_test")), nested].join("\n")], { cwd: checkout });
    expect(open.stdout.trim().split("\n"), open.stderr).toEqual(["ssh-read", "nested-ok"]);
    const fenced = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sandboxed")("/bin/sh", ["-c", reads("ssh", join(home, ".ssh", "id_test"))], { cwd: checkout });
    expect(fenced.stdout.trim(), fenced.stderr).toBe("ssh-refused");
  });
});

const online = (() => { try { execFileSync("curl", ["-sS", "-o", "/dev/null", "--max-time", "5", "https://api.github.com"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!FENCED || !online)("a sign-ins check's network is exactly the project's", () => {
  const reach = `curl -sS -o /dev/null --max-time 10 https://api.github.com 2>/dev/null && echo github-reached || echo github-refused`;
  test("the services the sign-ins are for aren't reachable until the operator adds their hosts", async () => {
    const before = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sign-ins")("/bin/sh", ["-c", reach], { cwd: checkout });
    expect(before.stdout.trim(), before.stderr).toBe("github-refused");
    store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["api.github.com"], loopback: "proxy-only" }, "alex", new Date());
    const after = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sign-ins")("/bin/sh", ["-c", reach], { cwd: checkout });
    expect(after.stdout.trim(), after.stderr).toBe("github-reached");
  });
});

describe.skipIf(!FENCED || process.platform !== "darwin")("a check's short launch folder (macOS)", () => {
  test("its TMPDIR is under /private/tmp and holds a long-named unix socket; other launch folders there stay out of reach; its own can't be replaced", async () => {
    const { mkdtempSync: made } = await import("node:fs");
    const other = realpathSync(made(join("/private/tmp", "so-cmd-")));
    writeFileSync(join(other, "secret"), "x");
    try {
      const socket = "s".repeat(60);
      const result = await fencedCheckoutCommands(store, repo, checkout, run, undefined, "sandboxed")("/bin/sh", ["-c", [
        `case "$TMPDIR" in /private/tmp/so-cmd-*) echo short;; *) echo "long $TMPDIR";; esac`,
        `${JSON.stringify(process.execPath)} -e 'const s=require("net").createServer().listen(require("path").join(process.env.TMPDIR, ${JSON.stringify(socket)}), () => { console.log("socket-ok"); s.close(); }).on("error", e => console.log("socket-" + e.code))'`,
        `cat ${JSON.stringify(join(other, "secret"))} >/dev/null 2>&1 && echo other-read || echo other-refused`,
        `mv "$(dirname "$TMPDIR")" "$(dirname "$TMPDIR")-moved" 2>/dev/null && echo own-moved || echo own-kept`,
      ].join("\n")], { cwd: checkout });
      expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["short", "socket-ok", "other-refused", "own-kept"]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
