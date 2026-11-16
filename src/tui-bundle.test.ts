/**
 * The terminal workbench's bundled binaries (scripts/tui-build.mjs): publish.yml publishes only when each of the four is
 * a regular 0755 file of exactly its platform's architecture, a macOS one signed and a Linux one static, answering the
 * self-check with this build's contract digest, and `npm pack` lists exactly those four. Each way to get it wrong is
 * one row here; the real binaries are checked by the publish job itself and by tui-bundle.yml.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { adopt, binaryProblems, headerOf, packProblems, PLATFORMS, reportMismatches, selfCheckProblems, verify } from "../scripts/tui-build.mjs";

type Problems = (name: string, input: { mode: number; isFile: boolean; bytes: Buffer; file?: string | null; lipo?: string | null; codesign?: string | null }) => string[];
const problems = binaryProblems as Problems;

/** A minimal 64-bit Mach-O: its CPU, and one load command (a code signature, or a plain segment). */
const macho = (cpu: number, signed: boolean): Buffer => {
  const buf = Buffer.alloc(128);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeInt32LE(cpu, 4);
  buf.writeUInt32LE(1, 16);
  buf.writeUInt32LE(signed ? 0x1d : 0x19, 32);
  buf.writeUInt32LE(16, 36);
  return buf;
};
/** A minimal 64-bit little-endian ELF: its machine, and one program header (a program interpreter, or a load). */
const elf = (machine: number, interp: boolean): Buffer => {
  const buf = Buffer.alloc(128);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2; buf[5] = 1;
  buf.writeUInt16LE(machine, 18);
  buf.writeBigUInt64LE(64n, 32);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(1, 56);
  buf.writeUInt32LE(interp ? 3 : 1, 64);
  return buf;
};
const ARM64 = 0x0100000c, X64 = 0x01000007;
const GOOD: Record<string, Buffer> = { "darwin-arm64": macho(ARM64, true), "darwin-x64": macho(X64, true), "linux-x64": elf(62, false), "linux-arm64": elf(183, false) };
const ok = (name: string, more: Partial<Parameters<Problems>[1]> = {}) => problems(name, { mode: 0o100755, isFile: true, bytes: GOOD[name]!, ...more });
const CONTRACT = "c".repeat(64);

describe("each bundled binary", () => {
  test("the four platforms, each its own header, pass", () => {
    expect(Object.keys(PLATFORMS as object).sort()).toEqual(Object.keys(GOOD).sort());
    for (const name of Object.keys(GOOD)) {
      expect(ok(name), name).toEqual([]);
      expect(headerOf(GOOD[name]!)).toMatchObject({ platform: name });
    }
    // What this computer's tools say, as macOS and Linux word it, passes too.
    expect(ok("darwin-arm64", { file: "Mach-O 64-bit executable arm64", lipo: "arm64", codesign: "valid" })).toEqual([]);
    expect(ok("darwin-x64", { file: "Mach-O 64-bit x86_64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>" })).toEqual([]);
    expect(ok("linux-x64", { file: "ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), static-pie linked, stripped" })).toEqual([]);
    expect(ok("linux-arm64", { file: "ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, stripped" })).toEqual([]);
  });

  test.each([
    ["another platform's binary in its folder", "darwin-arm64", { bytes: GOOD["darwin-x64"] }, /its header says darwin-x64/],
    ["a Linux binary in a macOS folder", "darwin-x64", { bytes: GOOD["linux-x64"] }, /its header says linux-x64/],
    ["x64 where arm64 belongs", "linux-arm64", { bytes: GOOD["linux-x64"] }, /its header says linux-x64/],
    ["an unsigned macOS binary", "darwin-x64", { bytes: macho(X64, false) }, /no code signature/],
    ["a dynamically linked Linux binary", "linux-x64", { bytes: elf(62, true) }, /not a static binary/],
    ["a universal (fat) binary", "darwin-arm64", { bytes: Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.alloc(124)]) }, /universal/],
    ["a script, not a program", "linux-x64", { bytes: Buffer.from(`#!/bin/sh\necho "toolroll-tui 1 contract ${CONTRACT}"\n${" ".repeat(64)}`) }, /not a Mach-O or ELF/],
    ["an empty file", "linux-arm64", { bytes: Buffer.alloc(0) }, /too short/],
    ["another CPU's Mach-O", "darwin-arm64", { bytes: macho(0x12, true) }, /another CPU/],
    ["not executable (0644)", "linux-x64", { mode: 0o100644 }, /mode 644, not 755/],
    ["writable by its group (0775)", "linux-x64", { mode: 0o100775 }, /mode 775, not 755/],
    ["a symlink or folder, not a file", "darwin-arm64", { isFile: false }, /not a regular file/],
    ["file says another architecture", "darwin-arm64", { file: "Mach-O 64-bit executable x86_64" }, /file says/],
    ["file says dynamically linked", "linux-x64", { file: "ELF 64-bit LSB pie executable, x86-64, dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2" }, /file says/],
    ["lipo says another architecture", "darwin-x64", { lipo: "arm64" }, /lipo -archs says/],
    ["codesign refuses its signature", "darwin-arm64", { codesign: "invalid signature (code or signature have been modified)" }, /codesign -v says/],
  ] as const)("refused: %s", (_what, name, more, problem) => {
    expect(ok(name, more as Partial<Parameters<Problems>[1]>).join("; ")).toMatch(problem);
  });
});

describe("the self-check and the package listing", () => {
  test("the self-check must name THIS build's contract digest, in the launcher's exact shape", () => {
    expect(selfCheckProblems("linux-x64", `toolroll-tui 0.1.0 contract ${CONTRACT}\n`, CONTRACT)).toEqual([]);
    for (const line of [`toolroll-tui 0.1.0 contract ${"d".repeat(64)}`, "", null, "exit 43", `toolroll-tui 0.1.0 contract ${CONTRACT} extra`, `something toolroll-tui 0.1.0 contract ${CONTRACT}`]) {
      expect(selfCheckProblems("linux-x64", line, CONTRACT), String(line)).not.toEqual([]);
    }
  });

  test("npm pack must list exactly the bundled binaries under dist/tui, each 0755", () => {
    const names = Object.keys(GOOD);
    const files = names.map(name => ({ path: `dist/tui/${name}/toolroll-tui`, mode: 0o755 }));
    const other = [{ path: "dist/bin.js", mode: 0o755 }, { path: "dist/tui.js", mode: 0o644 }];
    expect(packProblems([...files, ...other], names)).toEqual([]);
    expect(packProblems([...files.slice(1), ...other], names)).toEqual(["the package doesn't hold dist/tui/darwin-arm64/toolroll-tui"]);
    expect(packProblems([{ ...files[0]!, mode: 0o644 }, ...files.slice(1)], names)).toEqual(["the package holds dist/tui/darwin-arm64/toolroll-tui as mode 644, not 755"]);
    // Anything else under dist/tui (a build report, another binary) refuses.
    expect(packProblems([...files, { path: "dist/tui/linux-x64.json", mode: 0o644 }], names)).toEqual(["the package holds an unexpected file dist/tui/linux-x64.json"]);
    // One platform's lane checks only its own binary, and nothing else may ride along.
    expect(packProblems([files[2]!], ["linux-x64"])).toEqual([]);
    expect(packProblems(files, ["linux-x64"]).length).toBe(3);
  });
});

describe("downloaded binaries are matched to their build's report before anything runs", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-tui-bundle-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const host = `${process.platform}-${process.arch}`;
  const marker = join(dir, "ran.txt");
  /** A stand-in that, if anything ever runs it, leaves a marker. */
  const standIn = `#!/bin/sh\necho ran > '${marker}'\necho "toolroll-tui 1.0.0 contract ${CONTRACT}"\n`;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const lay = (folder: string, names: string[], text: string) => {
    for (const name of names) { mkdirSync(join(folder, name), { recursive: true }); writeFileSync(join(folder, name, "toolroll-tui"), text); chmodSync(join(folder, name, "toolroll-tui"), 0o755); }
  };
  const report = (folder: string, name: string, digest: string) => { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${name}.json`), JSON.stringify({ platform: name, sha256: digest, self_check: `toolroll-tui 1.0.0 contract ${CONTRACT}` })); };

  test.skipIf(!Object.hasOwn(PLATFORMS, host))("a hash mismatch refuses --adopt and --verify before the binary is ever run", async () => {
    const from = join(dir, "from"), reports = join(dir, "reports"), into = join(dir, "pkg", "dist", "tui");
    lay(from, [host], standIn);
    report(reports, host, sha("a different build"));
    expect(reportMismatches(from, reports, [host])).toEqual([expect.stringMatching(new RegExp(`^${host}: not the file its build reported`))]);
    // No report at all refuses too, and so does --adopt without --reports.
    expect(reportMismatches(from, join(dir, "no-reports"), [host])).toEqual([`${host}: no build report`]);
    expect(adopt({ targets: [host], from, reports: null, into })).toBe(1);
    expect(adopt({ targets: [host], from, reports, into })).toBe(1);
    expect(existsSync(into)).toBe(false);
    // In place (as verify sees the package): refused first, before the self-check or anything else runs.
    lay(into, [host], standIn);
    mkdirSync(join(dir, "pkg", "dist", "contracts"), { recursive: true });
    writeFileSync(join(dir, "pkg", "dist", "contracts", "engine-api.js"), `export const engineContractDigest = () => "${CONTRACT}";\n`);
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await verify({ targets: [host], reports, packageRoot: join(dir, "pkg") })).toBe(1);
      // Refused for the hash alone, before any other check (or the self-check, or npm pack) ran.
      expect(said.mock.calls.map(call => String(call[0]))).toEqual([expect.stringMatching(new RegExp(`^REFUSED: ${host}: not the file its build reported`))]);
      expect(logged).not.toHaveBeenCalled();
    } finally { said.mockRestore(); logged.mockRestore(); }
    expect(existsSync(marker)).toBe(false);
    // The matching report: --adopt copies it in (0755) and still runs nothing.
    rmSync(into, { recursive: true });
    report(reports, host, sha(standIn));
    expect(adopt({ targets: [host], from, reports, into })).toBe(0);
    expect(readdirSync(join(into, host))).toEqual(["toolroll-tui"]);
    expect(statSync(join(into, host, "toolroll-tui")).mode & 0o777).toBe(0o755);
    expect(existsSync(marker)).toBe(false);
  });
});
