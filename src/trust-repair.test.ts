/**
 * The trust repair (trust-repair.ts): it names the exact canonical paths that fail a trust check and why, prints
 * commands that make the unchanged check pass when run, never recurses outside Toolroll's own install, never follows or
 * names a symlink, and never prints a command for a path it can't quote safely. The checks themselves are never
 * loosened: each case rechecks with trusted-path.ts / sandbox-tools.ts as they are.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { protectTree, trustFaults, trustRepair, trustRepairLines } from "./trust-repair.js";
import { agentTrustWords } from "./agent-detect.js";
import { hasUnsafeText, shownText } from "./shown-text.js";
import { checkSeccompHelper, seccompHelperRepair } from "./sandbox-tools.js";
import { rootOwnedBinary, trustedBinary } from "./trusted-path.js";
import { outsideTempDir } from "../test/short-temp.js";

const me = process.getuid?.() ?? 0;
const noAcl = () => "none" as const;
let world: string;
beforeEach(() => { world = outsideTempDir("so-trust-repair-"); chmodSync(world, 0o755); });
afterEach(() => { rmSync(world, { recursive: true, force: true }); });

/** A folder chain under the world, each with `mode`, and an executable at its end. */
function tree(names: readonly string[], mode: number, fileMode = 0o755): { dirs: string[]; file: string } {
  const dirs: string[] = [];
  let at = world;
  for (const name of names) { at = join(at, name); mkdirSync(at); chmodSync(at, mode); dirs.push(realpathSync(at)); }
  const file = join(at, "tool");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, fileMode);
  return { dirs, file: realpathSync(file) };
}
const run = (commands: readonly string[]): void => { for (const one of commands) execFileSync("/bin/sh", ["-c", one], { stdio: "ignore" }); };
const mode = (path: string): number => lstatSync(path).mode & 0o777;

describe("trust repair: exact canonical paths, by kind, with commands that make the unchanged check pass", () => {
  test("a group-writable file and ancestors (umask 0002): one quoted command per path, outermost first, then the check passes", () => {
    const { dirs, file } = tree(["npm global", "lib", "node_modules"], 0o775, 0o775);
    expect(trustedBinary(file, me, null).ok).toBe(false);
    const repair = trustRepair(file, { owners: [me, 0], stickyAbove: true, acl: noAcl, euid: me })!;
    expect(repair.faults).toEqual([{ path: file, kind: "group-write" }, ...[...dirs].reverse().map(path => ({ path, kind: "group-write" }))]);
    expect(repair.commands).toEqual([...dirs, file].map(path => `chmod go-w '${path}'`));
    expect(repair.commands.some(one => one.includes(" -R "))).toBe(false);
    run(repair.commands);
    expect(trustedBinary(file, me, null).ok).toBe(true);
    expect(trustRepair(file, { owners: [me, 0], stickyAbove: true, acl: noAcl })).toBeNull();
  });

  test("world-writable is named as such; a path that can't be read has nothing to repair", () => {
    const { file } = tree(["shared"], 0o777);
    expect(trustFaults(file, { owners: [me, 0], acl: noAcl })).toContainEqual({ path: realpathSync(join(world, "shared")), kind: "world-write" });
    expect(trustFaults(join(world, "missing"), { owners: [me, 0], acl: noAcl })).toBeNull();
  });

  test("Toolroll's own install gets one recursive command; folders above it get their own; nothing recurses above it", () => {
    const { dirs, file } = tree(["prefix", "toolroll", "node_modules", "dep"], 0o775, 0o775);
    const own = dirs[1]!;
    const repair = trustRepair(file, { owners: [me, 0], ownTree: own, acl: noAcl, euid: me })!;
    expect(repair.commands).toEqual([`chmod go-w '${dirs[0]}'`, `chmod -R go-w '${own}'`]);
    run(repair.commands);
    expect(rootOwnedBinary(file, null, [0, me]).ok).toBe(true);
  });

  test("an extended ACL: removed by its own command (Linux only where its mask allows writing; macOS always)", () => {
    const { dirs, file } = tree(["acl"], 0o775);
    const acl = (path: string) => path === dirs[0] ? "acl" as const : "none" as const;
    const linux = trustRepair(file, { owners: [me, 0], acl, platform: "linux", euid: me })!;
    expect(linux.faults).toEqual(expect.arrayContaining([{ path: dirs[0], kind: "group-write" }, { path: dirs[0], kind: "acl" }]));
    expect(linux.commands).toEqual([`setfacl -b '${dirs[0]}'`, `chmod go-w '${dirs[0]}'`]);
    expect(trustRepair(file, { owners: [me, 0], acl, platform: "darwin", euid: me })!.commands).toEqual([`chmod -N '${dirs[0]}'`, `chmod go-w '${dirs[0]}'`]);
    chmodSync(dirs[0]!, 0o755);
    // Linux: an ACL whose mask allows no writing passes the mode check, so it isn't a fault.
    expect(trustRepair(file, { owners: [me, 0], acl, platform: "linux", euid: me })).toBeNull();
    expect(trustRepair(file, { owners: [me, 0], acl, platform: "darwin", euid: me })!.faults).toEqual([{ path: dirs[0], kind: "acl" }]);
  });

  test("a symlink is resolved, never named or followed: commands name the real target's folders, and -R skips links inside", () => {
    const { dirs, file } = tree(["real"], 0o775);
    const outside = tree(["outside"], 0o775);
    const links = join(world, "links");
    mkdirSync(links, { mode: 0o755 });
    chmodSync(links, 0o755);
    symlinkSync(file, join(links, "tool"));
    symlinkSync(outside.dirs[0]!, join(dirs[0]!, "escape"));
    const repair = trustRepair(join(links, "tool"), { owners: [me, 0], ownTree: dirs[0]!, acl: noAcl, euid: me })!;
    expect(repair.commands).toEqual([`chmod -R go-w '${dirs[0]}'`]);
    expect(repair.commands.join("\n")).not.toContain(links);
    run(repair.commands);
    expect(mode(dirs[0]!)).toBe(0o755);
    expect(mode(outside.dirs[0]!)).toBe(0o775);
  });

  test("never a chown, even as root: a path someone else owned is reinstalled, never handed to root", () => {
    const { file } = tree(["theirs-as-root"], 0o755);
    const asRoot = trustRepair(file, { owners: [0], acl: noAcl, euid: 0 })!;
    expect(asRoot.commands.some(one => one.includes("chown"))).toBe(false);
    expect(asRoot.notes.join(" ")).toContain("can't be trusted: reinstall into a folder that you or root own");
  });

  test("owned by another user: no chmod or chown for someone who can't, just why; a control character gets no command", () => {
    const { file } = tree(["theirs"], 0o755);
    const other = trustRepair(file, { owners: [me + 1], acl: noAcl, euid: me })!;
    expect(other.faults.every(one => one.kind === "owner")).toBe(true);
    expect(other.commands).toEqual([]);
    expect(other.notes.join(" ")).toContain("belongs to another user");
    const odd = tree(["bad\nname"], 0o775);
    const unsafe = trustRepair(odd.file, { owners: [me, 0], acl: noAcl, euid: me })!;
    expect(unsafe.commands.some(one => one.includes("bad"))).toBe(false);
    expect(unsafe.notes.join(" ")).toContain("control or invisible character");
  });

  test("the seccomp helper in a group-writable install: the refusal stands, the repair names it, and after it the unchanged check passes", () => {
    const { dirs, file } = tree(["pkg", "vendor", "seccomp", "x64"], 0o775, 0o775);
    const trust = { root: [0], codeOwner: me, acl: null, seccomp: file };
    expect(checkSeccompHelper(file, { all: [] }, trust).ok).toBe(false);
    // Toolroll's own package folder (here the stand-in "pkg") gets the recursive command.
    const repair = seccompHelperRepair(trust, dirs[0]!)!;
    expect(repair.commands).toEqual([`chmod -R go-w '${dirs[0]}'`]);
    run(repair.commands);
    expect(checkSeccompHelper(file, { all: [] }, trust).ok).toBe(true);
    expect(seccompHelperRepair(trust, dirs[0]!)).toBeNull();
  });
});

describe("a name can't forge a line of what is shown", () => {
  test.each([
    ["a newline", "\n", "\\n"],
    ["a carriage return", "\r", "\\r"],
    ["an escape sequence", "\u001b[2K", "\\x1b[2K"],
    ["a right-to-left override", "\u202e", "\\u202e"],
    ["a line separator", "\u2028", "\\u2028"],
    ["a zero-width space", "\u200b", "\\u200b"],
    ["a C1 control", "\u009b", "\\x9b"],
  ])("%s is shown escaped, and gets no command", (_, char, escaped) => {
    expect(shownText(`a${char}b`)).toBe(`a${escaped}b`);
    const forged = `x${char}Fix it with:${char}  rm -rf ~`;
    const { file } = tree([forged], 0o775);
    const lines = trustRepairLines(trustRepair(file, { owners: [me + 1], acl: noAcl, euid: me })!);
    for (const line of lines) expect(hasUnsafeText(line), JSON.stringify(line)).toBe(false);
    expect(lines.filter(line => line === "Fix it with:")).toEqual([]);
    expect(lines.some(line => /^\s*rm -rf/.test(line))).toBe(false);
    const writable = trustRepairLines(trustRepair(file, { owners: [me, 0], acl: noAcl, euid: me })!);
    expect(writable.join("\n")).not.toContain(forged);
    expect(writable.some(line => line.includes("chmod") && line.includes("rm -rf"))).toBe(false);
    for (const line of writable) expect(hasUnsafeText(line)).toBe(false);
    const words = agentTrustWords({ why: `others can change /opt/${forged}`, repair: null })!;
    expect(words.split("\n")).toHaveLength(1);
    expect(hasUnsafeText(words)).toBe(false);
  });
});

describe("protectTree: an install Toolroll makes itself is writable by its user alone, whatever the umask", () => {
  test("every file and folder loses group and world write; a symlink inside is never followed", () => {
    const { dirs, file } = tree(["runtime", "node_modules", "toolroll"], 0o777, 0o666);
    const outside = tree(["elsewhere"], 0o777, 0o666);
    symlinkSync(outside.file, join(dirs[2]!, "link"));
    protectTree(dirs[0]!);
    for (const one of dirs) expect(mode(one)).toBe(0o755);
    expect(mode(file)).toBe(0o644);
    expect(mode(outside.file)).toBe(0o666);
  });
});
