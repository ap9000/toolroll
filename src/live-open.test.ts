/** The Agents view's opener and line reader (live-open.ts; docs/plans/agents-view.md N4, N5): only this user's own
 * plain file, still where it was opened, in a real live directory; reads bounded by the window and the scan budget. */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { liveDir } from "./live.js";
import { openLiveTrusted, readLiveLines, READ_WINDOW, SCAN_BUDGET, type LiveOpened } from "./live-open.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-live-open-")); mkdirSync(liveDir(root), { mode: 0o700 }); });
afterEach(() => { try { chmodSync(liveDir(root), 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });
const put = (name: string, text: string) => writeFileSync(join(liveDir(root), name), text, { mode: 0o600 });
const opened = (name: string): LiveOpened => { const got = openLiveTrusted(root, name); if (typeof got === "string") throw new Error(got); return got; };

describe("the opener", () => {
  test("this run's own plain file opens; a missing one says so; a name we never write is refused", () => {
    put("7.sub.jsonl", "{}\n");
    const file = opened("7.sub.jsonl");
    expect(file.size).toBe(3);
    closeSync(file.fd);
    expect(openLiveTrusted(root, "8.sub.jsonl")).toBe("missing");
    expect(openLiveTrusted(root, "../7.sub.jsonl")).toBe("unavailable");
    expect(openLiveTrusted(root, ".sweep-claim-ab")).toBe("unavailable");
  });

  test.each([
    ["a symlink to another run's file", () => { put("1.jsonl", "secret\n"); symlinkSync(join(liveDir(root), "1.jsonl"), join(liveDir(root), "7.sub.jsonl")); }],
    ["a hard link to another run's file", () => { put("1.jsonl", "secret\n"); linkSync(join(liveDir(root), "1.jsonl"), join(liveDir(root), "7.sub.jsonl")); }],
    ["a FIFO (never blocks)", () => { execFileSync("mkfifo", [join(liveDir(root), "7.sub.jsonl")]); }],
    ["a directory", () => { mkdirSync(join(liveDir(root), "7.sub.jsonl")); }],
    ["a live directory others may write", () => { put("7.sub.jsonl", "x\n"); chmodSync(liveDir(root), 0o777); }],
    ["a live directory that is a link", () => { const other = join(root, "elsewhere"); renameSync(liveDir(root), other); symlinkSync(other, liveDir(root)); writeFileSync(join(other, "7.sub.jsonl"), "x\n"); }],
  ])("%s is unavailable", (_name, arrange) => {
    arrange();
    expect(openLiveTrusted(root, "7.sub.jsonl")).toBe("unavailable");
  });

  test("a directory swapped, or the file replaced, right after the open is unavailable", () => {
    put("7.sub.jsonl", "mine\n");
    expect(openLiveTrusted(root, "7.sub.jsonl", { afterOpen: () => {
      renameSync(liveDir(root), join(root, "old"));
      mkdirSync(liveDir(root), { mode: 0o700 });
      writeFileSync(join(liveDir(root), "7.sub.jsonl"), "theirs\n", { mode: 0o600 });
    } })).toBe("unavailable");
    rmSync(join(root, "old"), { recursive: true });
    expect(openLiveTrusted(root, "7.sub.jsonl", { afterOpen: () => {
      rmSync(join(liveDir(root), "7.sub.jsonl"));
      writeFileSync(join(liveDir(root), "7.sub.jsonl"), "theirs\n", { mode: 0o600 });
    } })).toBe("unavailable");
  });
});

describe("the line reader", () => {
  test("whole lines only; an unfinished last line stays pending", () => {
    put("7.sub.jsonl", "one\ntwo\nthr");
    const file = opened("7.sub.jsonl");
    const read = readLiveLines(file.fd, file.size, 0);
    expect(read.lines.map(line => line.text)).toEqual(["one", "two"]);
    expect(read.next).toBe(8);
    closeSync(file.fd);
  });

  test("a line longer than the window is skipped within the scan budget; past the budget the next read resumes discarding", () => {
    put("7.sub.jsonl", `${"x".repeat(READ_WINDOW + 10)}\nafter\n`);
    let file = opened("7.sub.jsonl");
    const long = readLiveLines(file.fd, file.size, 0);
    expect(long).toMatchObject({ lines: [], skipped: 1, skipping: false, next: READ_WINDOW + 11 });
    expect(readLiveLines(file.fd, file.size, long.next).lines.map(line => line.text)).toEqual(["after"]);
    closeSync(file.fd);

    put("7.sub.jsonl", `${"y".repeat(SCAN_BUDGET * 2)}\nbeyond\n`);
    file = opened("7.sub.jsonl");
    let read = readLiveLines(file.fd, file.size, 0);
    expect(read).toMatchObject({ skipped: 1, skipping: true, next: SCAN_BUDGET });
    const seen: string[] = [];
    for (let guard = 0; guard < 20 && read.next < file.size; guard += 1) { read = readLiveLines(file.fd, file.size, read.next, read.skipping); seen.push(...read.lines.map(line => line.text)); }
    expect(seen).toEqual(["beyond"]);
    closeSync(file.fd);
  });
});
