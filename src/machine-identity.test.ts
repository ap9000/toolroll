/**
 * Which computer is "this one" (machine-identity.ts): the OS's stable machine id is read and hashed per platform; a
 * witness with an id is ours only by that id; one without is ours only under one of this machine's own names; and the
 * boot-change proof and the workspace note follow the same rule. Run 3313 is the case: the hostname moved with the
 * network, and this computer's own witnesses read as another's.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { injectBootIdentity, provenDeadByBootChange } from "./boot-identity.js";
import { hashMachineId, injectMachineIdentity, isThisMachine, readConfiguredHostNames, readMachineIdentity, rememberHostAliases, sameMachineHost, thisMachine } from "./machine-identity.js";
import { MARKER, worktreeProcessOccupancy } from "./worktree.js";
import { fakePid } from "../test/fake-pid.js";

const UUID = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";
const ME = "a".repeat(32), OTHER = "b".repeat(32);
const BOOT_A = "4cdea6bb-1ac8-4e7c-bfcf-646f89b8a8a7", BOOT_B = "9b1d0e2f-3a4b-4c5d-8e6f-a1b2c3d4e5f6";
const dirs: string[] = [];
afterEach(() => {
  injectMachineIdentity(null);
  injectBootIdentity(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reading the machine id", () => {
  test("each platform's own id, hashed: never the raw id, the same id always the same hash", () => {
    const darwin = readMachineIdentity({ platform: "darwin", run: (file, args) => {
      expect([file, ...args]).toEqual(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
      return `+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${UUID}"\n`;
    } });
    expect(darwin).toEqual({ ok: true, id: hashMachineId("darwin-platform-uuid", UUID), source: "darwin-platform-uuid" });
    expect(darwin.ok && darwin.id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(darwin).toLowerCase()).not.toContain(UUID.toLowerCase());
    expect(readMachineIdentity({ platform: "linux", exists: () => false, readFile: () => "0123456789abcdef0123456789abcdef\n" }))
      .toEqual({ ok: true, id: hashMachineId("linux-machine-id", "0123456789abcdef0123456789abcdef"), source: "linux-machine-id" });
    expect(readMachineIdentity({ platform: "win32", run: () => `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    ${UUID}\n` }))
      .toEqual({ ok: true, id: hashMachineId("win32-machine-guid", UUID), source: "win32-machine-guid" });
  });

  test("a missing, unreadable, malformed or shareable id is unknown, never a guess", () => {
    expect(readMachineIdentity({ platform: "darwin", run: () => "nothing here" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(readMachineIdentity({ platform: "darwin", run: () => { throw new Error("ioreg missing"); } })).toMatchObject({ ok: false, reason: "unreadable" });
    expect(readMachineIdentity({ platform: "linux", exists: () => false, readFile: () => { throw new Error("ENOENT"); } })).toMatchObject({ ok: false, reason: "unreadable" });
    expect(readMachineIdentity({ platform: "linux", exists: () => false, readFile: () => "uninitialized\n" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(readMachineIdentity({ platform: "linux", exists: () => false, readFile: () => "0".repeat(32) })).toMatchObject({ ok: false, reason: "malformed" });
    // Containers made from one image can share a machine-id: the id proves nothing there.
    expect(readMachineIdentity({ platform: "linux", exists: path => path === "/.dockerenv", readFile: () => "0123456789abcdef0123456789abcdef" })).toMatchObject({ ok: false, reason: "container" });
    expect(readMachineIdentity({ platform: "freebsd" })).toMatchObject({ ok: false, reason: "unsupported-platform" });
  });

  test("this machine reads a real id where the platform offers one", () => {
    const identity = readMachineIdentity();
    if (process.platform === "darwin" || process.platform === "win32") expect(identity.ok, identity.ok ? "" : identity.detail).toBe(true);
  });

  test("macOS's configured names: HostName when set, LocalHostName.local; anything malformed is dropped", () => {
    const scutil = (answers: Record<string, string | Error>) => (_file: string, args: string[]) => {
      const answer = answers[args[1]!]!;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    expect(readConfiguredHostNames({ platform: "darwin", run: scutil({ HostName: new Error("HostName: not set"), LocalHostName: "Studio-A\n" }) })).toEqual(["Studio-A.local"]);
    expect(readConfiguredHostNames({ platform: "darwin", run: scutil({ HostName: "studio.example.com", LocalHostName: "Studio-A" }) })).toEqual(["studio.example.com", "Studio-A.local"]);
    expect(readConfiguredHostNames({ platform: "darwin", run: scutil({ HostName: "bad name\nx", LocalHostName: "" }) })).toEqual([]);
    expect(readConfiguredHostNames({ platform: "linux" })).toEqual([]);
  });
});

describe("the rule", () => {
  test("an id decides alone; without one, only this machine's own names do", () => {
    injectMachineIdentity({ ok: true, id: ME, source: "injected" }, ["Studio-A.local"]);
    rememberHostAliases(ME, ["seen-here.lan"]);
    rememberHostAliases(OTHER, ["seen-there.lan"]);
    expect(thisMachine().hosts.sort()).toEqual([hostname(), "Studio-A.local", "seen-here.lan"].sort());
    expect(isThisMachine({ host: "anything", machineId: ME })).toBe(true);
    expect(isThisMachine({ host: hostname(), machineId: OTHER })).toBe(false);
    for (const host of [hostname(), "Studio-A.local", "seen-here.lan"]) expect(isThisMachine({ host, machineId: null }), host).toBe(true);
    for (const host of ["seen-there.lan", "other-mac", ""]) expect(isThisMachine({ host }), host).toBe(false);
    // A caller naming another host compares exactly; naming this one, any of this machine's names count.
    expect(sameMachineHost("Studio-A.local", hostname())).toBe(true);
    expect(sameMachineHost("Studio-A.local", "fixture")).toBe(false);
    expect(sameMachineHost("fixture", "fixture")).toBe(true);
    expect(sameMachineHost(hostname(), hostname(), OTHER)).toBe(false);
  });

  test("with this machine's id unknown, an id-bearing witness is never ours and recorded names don't count", () => {
    injectMachineIdentity({ ok: false, reason: "unreadable", detail: "test" }, []);
    rememberHostAliases(ME, ["seen-here.lan"]);
    expect(isThisMachine({ host: hostname(), machineId: ME })).toBe(false);
    expect(isThisMachine({ host: "seen-here.lan" })).toBe(false);
    expect(isThisMachine({ host: hostname() })).toBe(true);
  });

  test("a boot change proves nothing for another machine's witness, even under this machine's name", () => {
    injectMachineIdentity({ ok: true, id: ME, source: "injected" }, ["Studio-A.local"]);
    injectBootIdentity({ ok: true, id: BOOT_B, source: "injected" });
    expect(provenDeadByBootChange({ host: "Studio-A.local", bootId: BOOT_A })).toBe(true);
    expect(provenDeadByBootChange({ host: "renamed", bootId: BOOT_A, machineId: ME })).toBe(true);
    expect(provenDeadByBootChange({ host: hostname(), bootId: BOOT_A, machineId: OTHER })).toBe(false);
    expect(provenDeadByBootChange({ host: "other-mac", bootId: BOOT_A })).toBe(false);
  });

  test("a workspace note: this machine's under an old name or its id is probed; another machine's id holds it", () => {
    injectMachineIdentity({ ok: true, id: ME, source: "injected" }, ["Studio-A.local"]);
    const dir = mkdtempSync(join(tmpdir(), "so-machine-note-"));
    dirs.push(dir);
    const dead = fakePid(1);
    const note = (words: string) => { writeFileSync(join(dir, MARKER), `${dead} worker process unknown ${words}\n`); return worktreeProcessOccupancy(dir); };
    expect(note("Studio-A.local")).toEqual({ held: false });
    expect(note(`moved-with-network.example ${ME}`)).toEqual({ held: false });
    expect(note(`moved-with-network.example unknown`)).toEqual({ held: true, by: dead });
    expect(note(`${hostname()} ${OTHER}`)).toEqual({ held: true, by: dead });
    expect(note("other-mac")).toEqual({ held: true, by: dead });
  });
});
