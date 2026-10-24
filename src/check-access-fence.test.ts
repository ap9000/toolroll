/** The sign-ins grants as each platform renders them (agent-fence.ts signInGrants, macosFenceProfile, linuxFenced). */
import { argsOnlySeccomp } from "../test/seccomp-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claudeProjectFolder, linuxFenced, macosFenceProfile, NO_GRANTS, signInGrants } from "./agent-fence.js";

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

test("no launch but its own agent's may write the sign-in folders and files, so nothing can be planted there", async () => {
  const { mandatoryWriteDenies } = await import("./agent-fence.js");
  const build = mandatoryWriteDenies({ worktree: checkout, home, binding: null, provider: "command" });
  expect(build.homeSignIns).toEqual([".codex", ".claude.json", ".claude/.credentials.json"]);
  expect(build.existing).toEqual(expect.arrayContaining([join(home, ".codex"), join(home, ".claude.json"), join(home, ".config", "gh")]));
  expect(mandatoryWriteDenies({ worktree: checkout, home, binding: null, provider: "claude" }).homeSignIns).toEqual([".codex"]);
});

test("macOS: the files come back by exact path after the home fence, the transcript folder writable; nothing without the grant", () => {
  const grants = signInGrants(home, checkout, "darwin");
  const profile = macosFenceProfile([join(home, ".claude"), join(home, ".config", "gh"), join(home, ".ssh")], { ...NO_GRANTS, signIns: grants });
  const deny = profile.indexOf(`(deny file-read* file-write* (subpath "${join(home, ".claude")}")`);
  const allow = profile.indexOf(`(allow file-read* (literal "${join(home, ".claude.json")}")`);
  expect(deny).toBeGreaterThan(-1);
  expect(allow).toBeGreaterThan(deny);
  // Only the session files directly in its transcript folder: never the folder whole, never memory/ or a subfolder.
  const escaped = claudeProjectFolder(home, checkout).path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(profile).toContain(`(allow file-read* file-write* (regex #"^${escaped}/[^/]+\\.jsonl$"))`);
  expect(profile).not.toContain(`(subpath "${claudeProjectFolder(home, checkout).path}")`);
  expect(profile).not.toContain(join(home, ".ssh", "id"));
  expect(macosFenceProfile([join(home, ".claude")], NO_GRANTS)).not.toContain(".claude.json");
});

test("Linux: a fenced folder that holds a sign-in file is masked entry by entry, the file left where it is; nothing bound from its path", () => {
  const grants = signInGrants(home, checkout, "linux");
  writeFileSync(join(home, ".claude", "history.jsonl"), "private");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const { args } = linuxFenced("/bin/true", [], [join(home, ".claude"), join(home, ".ssh")], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), signIns: grants });
  // The folder isn't masked whole; its other entries are, each by name; the sign-in files are never named at all.
  expect(args).not.toContain(join(home, ".claude"));
  expect(args).toContain(join(home, ".claude", "history.jsonl"));
  expect(args[args.indexOf(join(home, ".claude", "projects")) - 1]).toBe("--tmpfs");
  for (const file of grants.read) expect(args).not.toContain(file);
  // Codex's session and log folders, written.
  expect(args.flatMap((arg, at) => arg === "--bind" ? [args[at + 1]] : [])).toEqual(expect.arrayContaining(grants.writes));
  // A folder with no sign-in file is masked whole as before.
  expect(args[args.indexOf(join(home, ".ssh")) - 1]).toBe("--tmpfs");
});

test("the home configuration is denied by name on a Mac, there or not: a build started while ~/.codex is absent can't make it", async () => {
  const { fenceGrants, taskBoundary } = await import("./agent-fence.js");
  rmSync(join(home, ".codex"), { recursive: true });
  const boundary = taskBoundary({ worktree: checkout, provider: "command", home });
  expect(boundary.homeNames).toContain(join(home, ".codex"));
  expect(boundary.homeNames).toContain(join(home, ".config", "gh"));
  // A provider's own home stays its own (Claude keeps ~/.claude), the rest is still denied by name.
  const claude = taskBoundary({ worktree: checkout, provider: "claude", home });
  expect(claude.homeNames).not.toContain(join(home, ".claude"));
  expect(claude.homeNames).toContain(join(home, ".codex"));
  const grants = fenceGrants({ databaseFile: null, worktree: checkout, boundary });
  const profile = macosFenceProfile([], grants);
  expect(profile).toMatch(new RegExp(`\\(deny file-read\\* file-write\\* [^\\n]*\\(subpath "${join(home, ".codex").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\)`));
  // The sign-ins grants still come after it (a later Seatbelt rule wins), so exactly their files are read.
  const withSignIns = macosFenceProfile([], { ...grants, signIns: signInGrants(home, checkout, "darwin") });
  expect(withSignIns.indexOf("(allow file-read* (literal")).toBeGreaterThan(withSignIns.indexOf(`(subpath "${join(home, ".codex")}")`));
  // Bubblewrap and Codex's sandbox never see a path that isn't there.
  expect(linuxFenced("/bin/true", [], [], { ...grants, seccomp: argsOnlySeccomp() }).args).not.toContain(join(home, ".codex"));
});

test("a home name's folders can't be swapped on a Mac: ~/.config is held when there and can't be made when not", async () => {
  const { fenceGrants, taskBoundary } = await import("./agent-fence.js");
  const literalDeny = (profile: string, path: string) =>
    profile.split("\n").some(line => line.startsWith("(deny file-write* ") && !line.includes("file-read") && line.includes(`(literal "${path}")`));
  const boundary = taskBoundary({ worktree: checkout, provider: "command", home });
  const there = macosFenceProfile([], fenceGrants({ databaseFile: null, worktree: checkout, boundary }));
  expect(literalDeny(there, join(home, ".config"))).toBe(true);
  rmSync(join(home, ".config"), { recursive: true });
  const gone = macosFenceProfile([], fenceGrants({ databaseFile: null, worktree: checkout, boundary: taskBoundary({ worktree: checkout, provider: "command", home }) }));
  expect(literalDeny(gone, join(home, ".config"))).toBe(true);
  expect(literalDeny(gone, join(home, ".docker")) || existsSync(join(home, ".docker"))).toBe(true);
});
