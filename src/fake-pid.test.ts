import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_PID_BASE, FAKE_PID_MAX_OFFSET, fakePid } from "../test/fake-pid.js";

const root = join(import.meta.dirname, "..");

// A PID field: a name ending in pid, pgid or process group (ppid, supervisorPid, native_pid, MainPID, processGroup, "pid" inside
// JSON or SQL text, pid=4242 in fixture output) given a number, a list of numbers, or a number after "pid " in prose.
const PID_FIELD = /\b[A-Za-z_$]*(?:pid|pgid|process_?group)s?\b\\?["']?\s*(?:===|!==|==|=(?![=>])|:|\s)\s*(\[[^\]\n]*\]?|-?\d[\d_]*)/gi;

/** Every literal PID from 2 to 99,999 in a PID field, as path:line: the IDs a real process can hold. 0, 1 and negatives stay. */
export function lowPidLiterals(path: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(PID_FIELD)) {
      const values = match[1]!.replace(/[[\]]/g, "").split(",").map(value => value.trim().replace(/_/g, "")).filter(Boolean);
      if (values.some(value => /^\d+$/.test(value) && Number(value) >= 2 && Number(value) < 100_000)) found.push(`${path}:${index + 1}`);
    }
  });
  return [...new Set(found)];
}

describe("fake process IDs", () => {
  it("are deterministic, distinct and above every platform's PID limit", () => {
    expect(fakePid(0)).toBe(FAKE_PID_BASE);
    expect(fakePid(1)).toBe(fakePid(1));
    expect(new Set(Array.from({ length: 50 }, (_, n) => fakePid(n))).size).toBe(50);
    for (const pid of [fakePid(0), fakePid(1), fakePid(FAKE_PID_MAX_OFFSET)]) {
      expect(pid).toBeGreaterThan(99_999); // macOS
      expect(pid).toBeGreaterThan(4_194_304); // Linux PID_MAX_LIMIT
      expect(pid % 4).not.toBe(0); // Windows hands out multiples of 4
      expect(pid).toBeLessThanOrEqual(0x7fffffff); // the largest PID the code accepts
      expect(Number.isSafeInteger(pid)).toBe(true);
    }
    for (const offset of [-1, 1.5, FAKE_PID_MAX_OFFSET + 1, Number.NaN]) expect(() => fakePid(offset)).toThrow(RangeError);
  });

  it("are never held by a real process", () => {
    for (const pid of [fakePid(0), fakePid(1), fakePid(FAKE_PID_MAX_OFFSET)]) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("finds a literal low PID in code and in fixture text, with its file and line", () => {
    const fixture = [
      "const pid = 4242;",
      "spawn({ pid: fakePid(1), ppid: 4243 });",
      "status: { supervisorPid: 70_000, controllerPid: fakePid(2) },",
      "const anchorPids = [fakePid(3), 812];",
      "const out = `{\\\"pid\\\":4244}` + 'native_pid=4245';",
      "db.prepare('UPDATE runs SET pid = 4246, process_group = 4250 WHERE id = ?');",
      "expect(err).toBe('process pid 4247 is still running');",
      "if (owner.pid === 4248) return;",
      "Environment: MainPID=4249",
      "store.markSlotRunning(slot, { run, processGroup: 4251 });",
      "const handle = { supervisorPid: fakePid(1), agentPgid: 4252 };",
    ].join("\n");
    expect(lowPidLiterals("src/example.test.ts", fixture)).toEqual(Array.from({ length: 11 }, (_, n) => `src/example.test.ts:${n + 1}`));
  });

  it("allows helper values, real processes, 0, 1, negatives, null and non-PID numbers", () => {
    const fixture = [
      "const pid = fakePid(1);",
      "const child = spawn(process.execPath); const pid = child.pid!;",
      "expect(owner.pid).toBe(process.pid);",
      "{ pid: 0, ppid: 1, pgid: -1 }",
      "launchd: { pid: 1 }",
      "{ pid: null, port: 4242, runId: 4243 }",
      "const pidVersion = 2;",
      "const pid = 4_200_003;",
      "if (pid % 2) return;",
    ].join("\n");
    expect(lowPidLiterals("src/example.test.ts", fixture)).toEqual([]);
  });

  it("no test uses a literal low PID for a fake process", () => {
    const files = [
      ...readdirSync(join(root, "src")).filter(name => name.endsWith(".test.ts") && name !== "fake-pid.test.ts").map(name => `src/${name}`),
      ...readdirSync(join(root, "test")).filter(name => name.endsWith(".ts")).map(name => `test/${name}`),
    ];
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap(file => lowPidLiterals(file, readFileSync(join(root, file), "utf8")));
    expect(found, `Use fakePid() from test/fake-pid.ts for a process that is not real, or spawn one:\n${found.join("\n")}`).toEqual([]);
  });
});
