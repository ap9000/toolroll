/** The sign-ins grants as each platform renders them (agent-fence.ts signInGrants, macosFenceProfile, linuxFenced). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  expect(mac.write).toEqual([claudeProjectFolder(home, checkout).path]);
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
  expect(grants.write).toEqual([]);
});

test("macOS: the files come back by exact path after the home fence, the transcript folder writable; nothing without the grant", () => {
  const grants = signInGrants(home, checkout, "darwin");
  const profile = macosFenceProfile([join(home, ".claude"), join(home, ".config", "gh"), join(home, ".ssh")], { ...NO_GRANTS, signIns: grants });
  const deny = profile.indexOf(`(deny file-read* file-write* (subpath "${join(home, ".claude")}")`);
  const allow = profile.indexOf(`(allow file-read* (literal "${join(home, ".claude.json")}")`);
  expect(deny).toBeGreaterThan(-1);
  expect(allow).toBeGreaterThan(deny);
  expect(profile).toContain(`(allow file-read* file-write* (subpath "${claudeProjectFolder(home, checkout).path}"))`);
  expect(profile).not.toContain(join(home, ".ssh", "id"));
  expect(macosFenceProfile([join(home, ".claude")], NO_GRANTS)).not.toContain(".claude.json");
});

test("Linux: each file bound back read-only and the transcript folder writable, after the masks", () => {
  const grants = signInGrants(home, checkout, "linux");
  const { args } = linuxFenced("/bin/true", [], [join(home, ".claude"), join(home, ".config", "gh")], { ...NO_GRANTS, signIns: grants });
  const mask = args.indexOf(join(home, ".claude"));
  const credentials = args.indexOf(join(home, ".claude", ".credentials.json"));
  expect(args[credentials - 1]).toBe("--ro-bind");
  expect(args[credentials + 1]).toBe(join(home, ".claude", ".credentials.json"));
  expect(credentials).toBeGreaterThan(mask);
  const transcript = args.lastIndexOf(claudeProjectFolder(home, checkout).path);
  expect(args[transcript - 2]).toBe("--bind");
});
