/** The sign-ins grants as each platform renders them (agent-fence.ts signInGrants, macosFenceProfile, linuxFenced). */
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

test("the grants: fixed sign-in files (Claude's credentials file on Linux only), never Codex's, and the checkout's own transcript folder", () => {
  const mac = signInGrants(home, checkout, "darwin");
  expect(mac.read).toEqual([join(home, ".claude.json"), join(home, ".claude", "settings.json"), join(home, ".config", "gh", "hosts.yml"), join(home, ".config", "gh", "config.yml")]);
  expect(mac.transcripts).toEqual([claudeProjectFolder(home, checkout).path]);
  // Bubblewrap can't bind by pattern: no transcript folder on Linux.
  expect(signInGrants(home, checkout, "linux").transcripts).toEqual([]);
  expect(signInGrants(home, checkout, "linux").read).toContain(join(home, ".claude", ".credentials.json"));
});

test("a link anywhere on the way grants nothing: a linked file, or a linked folder above it", () => {
  rmSync(join(home, ".config", "gh", "hosts.yml"));
  symlinkSync(join(home, ".ssh", "id"), join(home, ".config", "gh", "hosts.yml"));
  expect(signInGrants(home, checkout, "darwin").read).not.toContain(join(home, ".config", "gh", "hosts.yml"));
  rmSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "settings.json"), "x");
  symlinkSync(join(dir, "elsewhere"), join(home, ".claude"));
  const grants = signInGrants(home, checkout, "darwin");
  expect(grants.read).not.toContain(join(home, ".claude", "settings.json"));
  expect(grants.transcripts).toEqual([]);
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

test("Linux: each file bound back read-only after the masks; no transcript folder", () => {
  const grants = signInGrants(home, checkout, "linux");
  const credentialsPath = join(home, ".claude", ".credentials.json");
  const copy = join(dir, "copy-0");
  writeFileSync(copy, "x");
  // Bound from the launch's own copy, never the path (a link swapped in after validation is never what is bound).
  const { args } = linuxFenced("/bin/true", [], [join(home, ".claude"), join(home, ".config", "gh")], { ...NO_GRANTS, signIns: { ...grants, copies: { [credentialsPath]: copy } } });
  const mask = args.indexOf(join(home, ".claude"));
  const bound = args.indexOf(copy);
  expect(args[bound - 1]).toBe("--ro-bind");
  expect(args[bound + 1]).toBe(credentialsPath);
  expect(bound).toBeGreaterThan(mask);
  // A file with no copy isn't bound at all.
  expect(args).not.toContain(join(home, ".config", "gh", "hosts.yml"));
  expect(args).not.toContain(claudeProjectFolder(home, checkout).path);
});

test("a sign-in file is read only as the real file it is: never through a link, nor a linked folder above it", async () => {
  const { readGrantedFile } = await import("./agent-fence.js");
  expect(readGrantedFile(join(home, ".claude", "settings.json"))?.toString()).toBe("x");
  symlinkSync(join(home, ".ssh", "id"), join(home, ".claude", "linked.json"));
  expect(readGrantedFile(join(home, ".claude", "linked.json"))).toBeNull();
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "auth.json"), "stolen");
  rmSync(join(home, ".codex"), { recursive: true });
  symlinkSync(join(dir, "elsewhere"), join(home, ".codex"));
  expect(readGrantedFile(join(home, ".codex", "auth.json"))).toBeNull();
});

test("a sign-in file with a second name (a hard link to something else) is never granted or read", async () => {
  const { linkSync } = await import("node:fs");
  const { readGrantedFile } = await import("./agent-fence.js");
  rmSync(join(home, ".config", "gh", "hosts.yml"));
  writeFileSync(join(dir, "database"), "secret");
  linkSync(join(dir, "database"), join(home, ".config", "gh", "hosts.yml"));
  expect(signInGrants(home, checkout, "darwin").read).not.toContain(join(home, ".config", "gh", "hosts.yml"));
  expect(readGrantedFile(join(home, ".config", "gh", "hosts.yml"))).toBeNull();
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
  expect(linuxFenced("/bin/true", [], [], grants).args).not.toContain(join(home, ".codex"));
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

test("a sign-in file's folders are looked at again after the open: one swapped meanwhile reads nothing", async () => {
  const { readGrantedFile } = await import("./agent-fence.js");
  const { renameSync } = await import("node:fs");
  const path = join(home, ".codex", "auth.json");
  expect(readGrantedFile(path, { afterOpen: () => {} })?.toString()).toBe("x");
  // Between the open and the second look, the folder is replaced by another folder holding the same name.
  expect(readGrantedFile(path, { afterOpen: () => {
    renameSync(join(home, ".codex"), join(home, ".codex-was"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, "other");
  } })).toBeNull();
  // Or by a link to a folder elsewhere.
  rmSync(join(home, ".codex"), { recursive: true });
  renameSync(join(home, ".codex-was"), join(home, ".codex"));
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "auth.json"), "stolen");
  expect(readGrantedFile(path, { afterOpen: () => {
    renameSync(join(home, ".codex"), join(home, ".codex-was"));
    symlinkSync(join(dir, "elsewhere"), join(home, ".codex"));
  } })).toBeNull();
  // A folder above it (the home itself) swapped likewise.
  rmSync(join(home, ".codex"));
  renameSync(join(home, ".codex-was"), join(home, ".codex"));
  expect(readGrantedFile(path, { afterOpen: () => {
    renameSync(home, join(dir, "home-was"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(path, "other");
  } })).toBeNull();
});

test("the sign-in copies folder is used only as Toolroll's own private folder: never a link, nor one others may open", async () => {
  const { chmodSync } = await import("node:fs");
  const { signInCopiesRoot, SIGN_IN_COPIES_DIR } = await import("./agent-fence.js");
  const state = join(dir, "state");
  mkdirSync(state);
  expect(signInCopiesRoot(state)).toBeNull();
  mkdirSync(join(state, SIGN_IN_COPIES_DIR), { mode: 0o700 });
  chmodSync(join(state, SIGN_IN_COPIES_DIR), 0o700);
  expect(signInCopiesRoot(state)).toBe(join(state, SIGN_IN_COPIES_DIR));
  chmodSync(join(state, SIGN_IN_COPIES_DIR), 0o755);
  expect(signInCopiesRoot(state)).toBeNull();
  rmSync(join(state, SIGN_IN_COPIES_DIR), { recursive: true });
  mkdirSync(join(dir, "target"), { mode: 0o700 });
  symlinkSync(join(dir, "target"), join(state, SIGN_IN_COPIES_DIR));
  expect(signInCopiesRoot(state)).toBeNull();
});

test("a sign-in copies folder that is a link: fenced by its own name and its target, and nothing in it is ever swept", async () => {
  const { readdirSync } = await import("node:fs");
  const { agentFence, codexFenceArgv, SIGN_IN_COPIES_DIR } = await import("./agent-fence.js");
  const state = join(dir, "state");
  mkdirSync(state);
  const target = join(dir, "precious");
  mkdirSync(join(target, "c-999999-dead"), { recursive: true });
  writeFileSync(join(target, "c-999999-dead", "keep"), "keep");
  symlinkSync(target, join(state, SIGN_IN_COPIES_DIR));
  const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: checkout, home });
  expect(fence).toContain(join(state, SIGN_IN_COPIES_DIR));
  expect(fence).toContain(target);
  expect(readdirSync(join(target, "c-999999-dead"))).toEqual(["keep"]);
  // Codex's sandbox denies it by its own name as well.
  expect(codexFenceArgv(fence, false).join(" ")).toContain(`"${join(state, SIGN_IN_COPIES_DIR)}"="deny"`);
});
