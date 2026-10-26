/**
 * The live file on disk (live.ts): the records writer and the window reader.
 * The reader is the guard on a file the machine running the agent could
 * alter: it never blocks on a non-file, never follows a link, never stalls
 * on a line longer than its window, never reuses an offset across files, and
 * cleans an older plain-text file again on the way out. The sweep never
 * touches an active run's file, whichever name it has.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_FILE_BOUND, LIVE_FILE_CAP, LIVE_SUB_FILE_CAP, LIVE_TOTAL_BYTES, legacyLiveLogPath, liveDir, liveLogPath, liveSubLogPath, liveWindowLines, openLiveLog, readLiveWindow, sweepLiveLogs } from "./live.js";
import { advanceTail } from "./peek-cli.js";
import { parseLiveRecords } from "./live-records.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-live-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

describe("the records file", () => {
  test("its first record keeps what the run's project allowed; a name that already exists is refused, not appended to", () => {
    const log = openLiveLog(root, 7, { base: "/pool/wt", commands: true })!;
    log.observe(say("hello"));
    log.close();
    expect(parseLiveRecords(readFileSync(liveLogPath(root, 7), "utf8"))).toEqual([
      expect.objectContaining({ k: "open", detail: "commands" }), expect.objectContaining({ k: "say", t: ["hello"] }),
    ]);
    expect(openLiveLog(root, 7)).toBeNull();
    // Off unless the run says otherwise.
    openLiveLog(root, 8)!.close();
    expect(parseLiveRecords(readFileSync(liveLogPath(root, 8), "utf8"))[0]).toMatchObject({ k: "open", detail: "base" });
  });
});

describe("the window reader", () => {
  test("a FIFO or a link in the file's place is refused without blocking; a linked live directory reads nothing", () => {
    mkdirSync(liveDir(root), { recursive: true });
    execFileSync("mkfifo", [liveLogPath(root, 1)]);
    expect(readLiveWindow(root, 1, 0)).toEqual({ ok: false, reason: "unreadable" });
    writeFileSync(join(root, "elsewhere.jsonl"), `${JSON.stringify({ k: "say", at: "", t: ["leaked"] })}\n`);
    symlinkSync(join(root, "elsewhere.jsonl"), liveLogPath(root, 2));
    expect(readLiveWindow(root, 2, 0)).toEqual({ ok: false, reason: "unreadable" });
    const other = mkdtempSync(join(tmpdir(), "so-live-other-"));
    try {
      const linked = mkdtempSync(join(tmpdir(), "so-live-linked-"));
      mkdirSync(join(other, "live"));
      writeFileSync(join(other, "live", "3.jsonl"), `${JSON.stringify({ k: "say", at: "", t: ["leaked"] })}\n`);
      symlinkSync(join(other, "live"), join(linked, "live"));
      expect(readLiveWindow(linked, 3, 0)).toEqual({ ok: false, reason: "missing" });
      rmSync(linked, { recursive: true, force: true });
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  test("a line longer than the whole window is skipped through its end, and reading moves on", () => {
    const log = openLiveLog(root, 4)!;
    log.close();
    appendFileSync(liveLogPath(root, 4), `${"x".repeat(200 * 1024)}\n${JSON.stringify({ k: "say", at: "", t: ["after"] })}\n`);
    let offset = 0, lines: string[] = [];
    for (let read = 0; read < 10; read += 1) {
      const window = readLiveWindow(root, 4, offset);
      if (!window.ok) throw new Error(window.reason);
      lines = lines.concat(liveWindowLines(window, false));
      if (window.nextOffset === offset) break;
      offset = window.nextOffset;
    }
    expect(lines).toEqual(["[a line was too long to show]", "after"]);
  });

  test("a line longer than one window's look is still skipped through its end; a finished run's unended tail is cut, not waited on", () => {
    openLiveLog(root, 12)!.close();
    appendFileSync(liveLogPath(root, 12), `${"y".repeat(2 * 1024 * 1024)}\n${JSON.stringify({ k: "say", at: "", t: ["after"] })}\n`);
    const read = (from: number, tail = false) => { const window = readLiveWindow(root, 12, from, tail); if (!window.ok) throw new Error(window.reason); return window; };
    let offset = read(0).nextOffset, lines: string[] = [];
    for (let step = 0; step < 5; step += 1) { const window = read(offset); lines = lines.concat(liveWindowLines(window, false)); if (window.nextOffset === offset) break; offset = window.nextOffset; }
    expect(lines).toEqual(["[a line was too long to show]", "after"]);
    // A finished run's drain over a huge line that never ends moves to the end.
    appendFileSync(liveLogPath(root, 12), "z".repeat(200 * 1024));
    const drained = read(offset, true);
    expect(drained).toMatchObject({ eof: true });
    expect(liveWindowLines(drained, false)).toEqual(["[a line was too long to show]"]);
  });

  test("an offset belongs to its file: a different file is a different generation", () => {
    openLiveLog(root, 5)!.close();
    const first = readLiveWindow(root, 5, 0);
    unlinkSync(liveLogPath(root, 5));
    openLiveLog(root, 5)!.close();
    const second = readLiveWindow(root, 5, 0);
    if (!first.ok || !second.ok) throw new Error("unread");
    expect(first.gen).not.toBe(second.gen);
    // peek starts over visibly instead of reading the new file from the old offset.
    const tail = advanceTail(root, 5, { offset: first.nextOffset, lines: ["old"], state: "live", gen: "records:0:0", commands: false }, false);
    expect(tail).toMatchObject({ offset: 0, state: "replaced" });
  });

  test("an older plain-text file is still read, and cleaned again on the way out", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 6), "plain words\n\u001b[2Jcleared ‮flipped\nexport API_TOKEN=abc123\n");
    const window = readLiveWindow(root, 6, 0);
    if (!window.ok) throw new Error(window.reason);
    expect(window.format).toBe("text");
    expect(liveWindowLines(window, false)).toEqual(["plain words", "cleared flipped", "[a line was hidden]"]);
    // An older writer hid only a key's BEGIN line: its body never shows, even as a finished file's unended tail.
    writeFileSync(legacyLiveLogPath(root, 13), "[a credential-shaped line was redacted]\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY_123");
    const tail = readLiveWindow(root, 13, 0, true);
    if (!tail.ok) throw new Error(tail.reason);
    expect(liveWindowLines(tail, false).join("\n")).not.toMatch(/MIIEvQ|SYNTHETIC_BODY/);
  });

  test("a key block split across reads stays hidden: each read hands the next whether it ended inside one", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 14), "before\n-----BEGIN PRIVATE KEY-----\n");
    const first = readLiveWindow(root, 14, 0);
    if (!first.ok) throw new Error(first.reason);
    const keys = { inKey: false };
    expect(liveWindowLines(first, false, keys)).toEqual(["before", "[a key block was hidden]"]);
    expect(keys.inKey).toBe(true);
    appendFileSync(legacyLiveLogPath(root, 14), "MIIEowIBAAKCAQEA\n-----END PRIVATE KEY-----\nafter\n");
    const second = readLiveWindow(root, 14, first.nextOffset);
    if (!second.ok) throw new Error(second.reason);
    expect(liveWindowLines(second, false, keys)).toEqual(["after"]);
    // peek carries it the same way.
    const tail = advanceTail(root, 14, { offset: 0, lines: [], state: "not-yet" }, false);
    expect(tail.lines.join("\n")).not.toContain("MIIEow");
  });

  test("a key marker split across two reads still opens the block", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 15), "look -----BEG\n");
    const first = readLiveWindow(root, 15, 0);
    if (!first.ok) throw new Error(first.reason);
    const keys = { inKey: false, tail: "" };
    expect(liveWindowLines(first, false, keys)).toEqual(["look -----BEG"]);
    appendFileSync(legacyLiveLogPath(root, 15), "IN PRIVATE KEY-----\nYWJjZGVm\n-----END PRIVATE KEY-----\nafter\n");
    const second = readLiveWindow(root, 15, first.nextOffset);
    if (!second.ok) throw new Error(second.reason);
    expect(liveWindowLines(second, false, keys)).toEqual(["[a key block was hidden]", "after"]);
    // What rides the cursor is only ever a marker fragment, never part of a line — let alone a hidden one.
    const carried = { inKey: false, tail: "" };
    liveWindowLines({ format: "text", text: "-----BEGIN KEY-----\nMIIEowIBAAKCAQEAabcdef12\n" }, false, carried);
    expect(carried.tail).toBe("|||");
    liveWindowLines({ format: "text", text: "-----END KEY-----\nplain words -----BE\n" }, false, carried);
    expect(carried.tail).toBe("-----BE|-----BE|-----BE|");
  });

  test("peek never keeps a key tail it could not have produced", () => {
    expect(advanceTail(root, 99, { offset: 0, lines: [], state: "not-yet", keyTail: "TOPSECRET" }, false).keyTail).toBe("");
  });

  test("peek's cursor moves by the bytes read even when nothing in them shows", () => {
    const log = openLiveLog(root, 9)!;
    log.close();
    const tail = advanceTail(root, 9, { offset: 0, lines: [], state: "not-yet" }, false);
    expect(tail.offset).toBeGreaterThan(0);
    expect(tail.lines).toEqual([]);
  });
});

describe("the sweep", () => {
  test("an active run's records file is never an orphan, and both names age out once finished", () => {
    openLiveLog(root, 10)!.close();
    mkdirSync(liveDir(root), { recursive: true });
    writeFileSync(legacyLiveLogPath(root, 11), "old\n");
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = {
      10: { outcome: null, finishedAt: null },
      11: { outcome: "built", finishedAt: "2026-01-01T00:00:00.000Z" },
    };
    const swept = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, new Date("2026-10-18T12:00:00.000Z"));
    expect(swept.removed).toEqual(["11.log"]);
    expect(existsSync(liveLogPath(root, 10))).toBe(true);
  });

  // docs/plans/agents-view.md N3: a run's subagents' file is the run's own, swept with it and never an orphan.
  const NOW = new Date("2026-10-18T12:00:00.000Z");
  const finishedAt = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const put = (name: string, bytes = 1, mtime = new Date("2026-01-01T00:00:00.000Z")) => {
    mkdirSync(liveDir(root), { recursive: true });
    const path = join(liveDir(root), name);
    writeFileSync(path, "x");
    if (bytes !== 1) truncateSync(path, bytes);
    utimesSync(path, mtime, mtime);
  };

  test("an active run's subagents' file survives age pressure; a finished run's goes with its records", () => {
    for (const name of ["7.jsonl", "7.sub.jsonl", "8.jsonl", "8.sub.jsonl", "9.sub.jsonl"]) put(name);
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = { 7: { outcome: null, finishedAt: null }, 8: { outcome: "built", finishedAt: finishedAt(30) } };
    const swept = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, NOW);
    expect(swept.removed.sort()).toEqual(["8.jsonl", "8.sub.jsonl", "9.sub.jsonl"]); // 9 has no run row: an orphan by age
    expect(existsSync(liveSubLogPath(root, 7))).toBe(true);
    expect(existsSync(liveLogPath(root, 7))).toBe(true);
  });

  test("under file-count pressure a run's two files count once and go together; an active run's never go", () => {
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = { 1: { outcome: null, finishedAt: null } };
    put("1.jsonl"); put("1.sub.jsonl");
    for (let id = 2; id <= LIVE_FILE_BOUND + 3; id += 1) {
      runs[id] = { outcome: "built", finishedAt: finishedAt(10 - id / 1000) }; // oldest first, all within the day
      put(`${id}.jsonl`);
      if (id <= 3) put(`${id}.sub.jsonl`);
    }
    const swept = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, NOW);
    expect(swept.removed.sort()).toEqual(["2.jsonl", "2.sub.jsonl", "3.jsonl", "3.sub.jsonl"]);
    expect(existsSync(liveSubLogPath(root, 1))).toBe(true);
  });

  test("a finished file far past its cap goes at once, the total stays bounded oldest first, and an active run is exempt", () => {
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = { 1: { outcome: null, finishedAt: null } };
    put("1.sub.jsonl", LIVE_SUB_FILE_CAP * 2); // active: its writer owns the cap
    runs[2] = { outcome: "built", finishedAt: finishedAt(1) };
    put("2.sub.jsonl", LIVE_SUB_FILE_CAP * 2); // finished and no file this plane writes: gone now
    const count = Math.ceil(LIVE_TOTAL_BYTES / LIVE_SUB_FILE_CAP) + 2;
    for (let id = 10; id < 10 + count; id += 1) { runs[id] = { outcome: "built", finishedAt: finishedAt(5 - id / 1000) }; put(`${id}.sub.jsonl`, LIVE_SUB_FILE_CAP); }
    const swept = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, NOW);
    expect(swept.removed.sort()).toEqual(["10.sub.jsonl", "11.sub.jsonl", "2.sub.jsonl"]);
    expect(existsSync(liveSubLogPath(root, 1))).toBe(true);
  });

  test("a file replaced, or whose run turned active, between classifying and removing is kept (Codex av2 #1)", () => {
    put("900.sub.jsonl"); put("901.sub.jsonl");
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = {};
    let locked = 0;
    const store = { getRun: (id: number) => runs[id] ?? null, transact: <T>(body: () => T): T => { locked += 1; return body(); } };
    const swept = sweepLiveLogs(store, root, NOW, { beforeRemove: name => {
      // Another process admits run 900 and its writer replaces the old file; run 901's file is swapped under the same name.
      if (name === "900.sub.jsonl") { runs[900] = { outcome: null, finishedAt: null }; unlinkSync(join(liveDir(root), name)); writeFileSync(join(liveDir(root), name), "new run's own records\n"); }
      if (name === "901.sub.jsonl") { unlinkSync(join(liveDir(root), name)); writeFileSync(join(liveDir(root), name), "someone else's\n"); }
    } });
    expect(swept.removed).toEqual([]);
    expect(readFileSync(liveSubLogPath(root, 900), "utf8")).toBe("new run's own records\n");
    expect(existsSync(liveSubLogPath(root, 901))).toBe(true);
    expect(locked).toBe(2); // each removal re-proves under the store's write lock
  });

  test("a removal that fails stays counted: the sweep goes on until the bound and the total are really met (Codex av2 #3)", () => {
    const denied = (name: string) => (path: string) => { if (path.endsWith(name)) throw Object.assign(new Error("denied"), { code: "EACCES" }); unlinkSync(path); };
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = {};
    for (let id = 2; id <= LIVE_FILE_BOUND + 3; id += 1) { runs[id] = { outcome: "built", finishedAt: finishedAt(10 - id / 1000) }; put(`${id}.jsonl`); }
    const counted = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, NOW, { unlink: denied("/2.jsonl") });
    expect(counted.removed.sort()).toEqual(["3.jsonl", "4.jsonl"]);
    rmSync(liveDir(root), { recursive: true, force: true });
    const count = Math.ceil(LIVE_TOTAL_BYTES / LIVE_SUB_FILE_CAP) + 2;
    for (let id = 10; id < 10 + count; id += 1) { runs[id] = { outcome: "built", finishedAt: finishedAt(5 - id / 1000) }; put(`${id}.sub.jsonl`, LIVE_SUB_FILE_CAP); }
    const bytes = sweepLiveLogs({ getRun: id => runs[id] ?? null }, root, NOW, { unlink: denied("/10.sub.jsonl") });
    expect(bytes.removed.sort()).toEqual(["11.sub.jsonl", "12.sub.jsonl"]);
  });

  test("files are measured after their run is settled finished: grown, or created, before it finished (Codex av2 #4)", () => {
    const count = Math.ceil(LIVE_TOTAL_BYTES / LIVE_SUB_FILE_CAP) + 1;
    const runs: Record<number, { outcome: string | null; finishedAt: string | null }> = {};
    for (let id = 10; id < 10 + count; id += 1) { runs[id] = { outcome: "built", finishedAt: finishedAt(5 - id / 1000) }; put(`${id}.jsonl`); }
    const seen = new Set<number>();
    const store = { getRun: (id: number) => {
      // The first look at each run: its writer was still finishing — the oldest grows its records, the rest add a subagents' file.
      if (!seen.has(id)) { seen.add(id); if (id === 10) truncateSync(liveLogPath(root, id), LIVE_FILE_CAP); else put(`${id}.sub.jsonl`, LIVE_SUB_FILE_CAP); }
      return runs[id] ?? null;
    } };
    const swept = sweepLiveLogs(store, root, NOW);
    // 64 subagent files of 16 MiB plus 4 MiB of records: over 1 GiB, so the oldest runs go until it isn't.
    expect(swept.removed.sort()).toEqual(["10.jsonl", "11.jsonl", "11.sub.jsonl"]);
  });

  test("a run that can't be looked up is kept this pass; the rest are swept", () => {
    for (const name of ["4.jsonl", "4.sub.jsonl", "5.jsonl"]) put(name);
    const swept = sweepLiveLogs({ getRun: id => { if (id === 4) throw new Error("busy"); return { outcome: "built", finishedAt: finishedAt(30) }; } }, root, NOW);
    expect(swept.removed).toEqual(["5.jsonl"]);
    expect(existsSync(liveSubLogPath(root, 4))).toBe(true);
  });
});
