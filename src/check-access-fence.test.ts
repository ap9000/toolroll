/** The sign-ins grants and how the sandbox runtime is given them (agent-fence.ts signInGrants, srtTermsOf). */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claudeProjectFolder, NO_GRANTS, signInGrants, srtTermsOf } from "./agent-fence.js";

let dir: string, home: string, checkout: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-signins-")));
  home = join(dir, "home");
  checkout = join(dir, "checkout");
  mkdirSync(checkout);
  for (const name of [".claude.json", ".claude/settings.json", ".claude/.credentials.json", ".config/gh/hosts.yml", ".config/gh/config.yml", ".codex/auth.json", ".ssh/id"]) {
    mkdirSync(join(home, name, ".."), { recursive: true });
    writeFileSync(join(home, name), "x");
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the grants: fixed sign-in files by name (Claude's credentials file on Linux only, Codex's config and sign-in), the checkout's own transcript folder, Codex's session and log folders", () => {
  const mac = signInGrants(home, checkout, "darwin");
  // Those that are there (this home has no ~/.codex/config.toml).
  expect(mac.read).toEqual([join(home, ".claude.json"), join(home, ".claude", "settings.json"), join(home, ".config", "gh", "hosts.yml"), join(home, ".config", "gh", "config.yml"),
    join(home, ".codex", "auth.json")]);
  expect(mac.transcripts).toEqual([claudeProjectFolder(home, checkout).path]);
  expect(mac.writes).toEqual([join(home, ".codex", "sessions"), join(home, ".codex", "log")]);
  // Bubblewrap can't bind by pattern: no transcript folder on Linux.
  expect(signInGrants(home, checkout, "linux").transcripts).toEqual([]);
  expect(signInGrants(home, checkout, "linux").read).toContain(join(home, ".claude", ".credentials.json"));
});

test("only a name that is itself is granted: never a link, a hard link to something else, or one under a linked folder (the sandbox resolves it again)", async () => {
  const { linkSync } = await import("node:fs");
  rmSync(join(home, ".config", "gh", "hosts.yml"));
  symlinkSync(join(home, ".ssh", "id"), join(home, ".config", "gh", "hosts.yml"));
  expect(signInGrants(home, checkout, "darwin").read).not.toContain(join(home, ".config", "gh", "hosts.yml"));
  // A hard link to Toolroll's database (a second name for it) is never granted.
  writeFileSync(join(dir, "orders.db"), "secret");
  rmSync(join(home, ".config", "gh", "config.yml"));
  linkSync(join(dir, "orders.db"), join(home, ".config", "gh", "config.yml"));
  expect(signInGrants(home, checkout, "darwin").read).not.toContain(join(home, ".config", "gh", "config.yml"));
  // Under a linked folder: neither its files nor Codex's session folders.
  rmSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "auth.json"), "stolen");
  symlinkSync(join(dir, "elsewhere"), join(home, ".codex"));
  const grants = signInGrants(home, checkout, "darwin");
  expect(grants.read).not.toContain(join(home, ".codex", "auth.json"));
  expect(grants.writes).toEqual([]);
  expect(grants.read).toContain(join(home, ".claude.json"));
});

test("the sandbox runtime is given the files by exact path inside the home denies; nothing without the grant", () => {
  const grants = signInGrants(home, checkout, "darwin");
  const terms = srtTermsOf([join(home, ".claude"), join(home, ".config", "gh"), join(home, ".ssh")], { ...NO_GRANTS, signIns: grants });
  expect(terms.readConfig.denyOnly).toEqual(expect.arrayContaining([join(home, ".claude"), join(home, ".ssh")]));
  expect(terms.readConfig.allowWithinDeny).toEqual(expect.arrayContaining([join(home, ".claude.json"), join(home, ".config", "gh", "hosts.yml")]));
  expect(JSON.stringify(terms)).not.toContain(join(home, ".ssh", "id"));
  // Its gh needs certificate checking (trustd) on a Mac.
  expect(terms.allowMachLookup).toContain("com.apple.trustd.agent");
  expect(srtTermsOf([join(home, ".claude")], NO_GRANTS).readConfig.allowWithinDeny).not.toContain(join(home, ".claude.json"));
  // Under a write allowlist, its Codex folders and its transcript session files are written.
  const listed = srtTermsOf([], { ...NO_GRANTS, signIns: grants, writes: { subpaths: [checkout], prefixes: [] } });
  expect(listed.writeConfig.allowOnly).toEqual(expect.arrayContaining([...grants.writes, join(claudeProjectFolder(home, checkout).path, "*.jsonl")]));
});

test("the home configuration is denied by name under policy v1, there or not: a build started while ~/.codex is absent can't read or make it", async () => {
  const { fenceGrants, taskBoundary } = await import("./agent-fence.js");
  rmSync(join(home, ".codex"), { recursive: true });
  const boundary = taskBoundary({ worktree: checkout, provider: "command", home });
  expect(boundary.homeNames).toContain(join(home, ".codex"));
  expect(boundary.homeNames).toContain(join(home, ".config", "gh"));
  // A provider's own home stays its own (Claude keeps ~/.claude), the rest is still denied by name.
  const claude = taskBoundary({ worktree: checkout, provider: "claude", home });
  expect(claude.homeNames).not.toContain(join(home, ".claude"));
  expect(claude.homeNames).toContain(join(home, ".codex"));
  const terms = srtTermsOf([], fenceGrants({ databaseFile: null, worktree: checkout, boundary }));
  expect(terms.readConfig.denyOnly).toContain(join(home, ".codex"));
  expect(terms.writeConfig.denyWithinAllow).toContain(join(home, ".codex"));
  // Policy v2: the home folder is read, as in the sandbox runtime.
  expect(taskBoundary({ worktree: checkout, provider: "command", home, policy: 2 }).homeNames).toEqual([]);
});
