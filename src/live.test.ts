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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyLiveLogPath, liveDir, liveLogPath, liveWindowLines, openLiveLog, readLiveWindow, sweepLiveLogs } from "./live.js";
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
      lines = lines.concat(liveWindowLines(window));
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
    for (let step = 0; step < 5; step += 1) { const window = read(offset); lines = lines.concat(liveWindowLines(window)); if (window.nextOffset === offset) break; offset = window.nextOffset; }
    expect(lines).toEqual(["[a line was too long to show]", "after"]);
    // A finished run's drain over a huge line that never ends moves to the end.
    appendFileSync(liveLogPath(root, 12), "z".repeat(200 * 1024));
    const drained = read(offset, true);
    expect(drained).toMatchObject({ eof: true });
    expect(liveWindowLines(drained)).toEqual(["[a line was too long to show]"]);
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
    const tail = advanceTail(root, 5, { offset: first.nextOffset, lines: ["old"], state: "live", gen: "records:0:0" });
    expect(tail).toMatchObject({ offset: 0, state: "replaced" });
  });

  test("an older plain-text file is still read, and cleaned again on the way out", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 6), "plain words\n\u001b[2Jcleared ‮flipped\nexport API_TOKEN=abc123\n");
    const window = readLiveWindow(root, 6, 0);
    if (!window.ok) throw new Error(window.reason);
    expect(window.format).toBe("text");
    expect(liveWindowLines(window)).toEqual(["plain words", "cleared flipped", "[a line was hidden]"]);
    // An older writer hid only a key's BEGIN line: its body never shows, even as a finished file's unended tail.
    writeFileSync(legacyLiveLogPath(root, 13), "[a credential-shaped line was redacted]\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY_123");
    const tail = readLiveWindow(root, 13, 0, true);
    if (!tail.ok) throw new Error(tail.reason);
    expect(liveWindowLines(tail).join("\n")).not.toMatch(/MIIEvQ|SYNTHETIC_BODY/);
  });

  test("a key block split across reads stays hidden: each read hands the next whether it ended inside one", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 14), "before\n-----BEGIN PRIVATE KEY-----\n");
    const first = readLiveWindow(root, 14, 0);
    if (!first.ok) throw new Error(first.reason);
    const keys = { inKey: false };
    expect(liveWindowLines(first, keys)).toEqual(["before", "[a key block was hidden]"]);
    expect(keys.inKey).toBe(true);
    appendFileSync(legacyLiveLogPath(root, 14), "MIIEowIBAAKCAQEA\n-----END PRIVATE KEY-----\nafter\n");
    const second = readLiveWindow(root, 14, first.nextOffset);
    if (!second.ok) throw new Error(second.reason);
    expect(liveWindowLines(second, keys)).toEqual(["after"]);
    // peek carries it the same way.
    const tail = advanceTail(root, 14, { offset: 0, lines: [], state: "not-yet" });
    expect(tail.lines.join("\n")).not.toContain("MIIEow");
  });

  test("a key marker split across two reads still opens the block", () => {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(legacyLiveLogPath(root, 15), "look -----BEG\n");
    const first = readLiveWindow(root, 15, 0);
    if (!first.ok) throw new Error(first.reason);
    const keys = { inKey: false, tail: "" };
    expect(liveWindowLines(first, keys)).toEqual(["look -----BEG"]);
    appendFileSync(legacyLiveLogPath(root, 15), "IN PRIVATE KEY-----\nYWJjZGVm\n-----END PRIVATE KEY-----\nafter\n");
    const second = readLiveWindow(root, 15, first.nextOffset);
    if (!second.ok) throw new Error(second.reason);
    expect(liveWindowLines(second, keys)).toEqual(["[a key block was hidden]", "after"]);
    // What rides the cursor is only ever a marker fragment, never part of a line — let alone a hidden one.
    const carried = { inKey: false, tail: "" };
    liveWindowLines({ format: "text", text: "-----BEGIN KEY-----\nMIIEowIBAAKCAQEAabcdef12\n" }, carried);
    expect(carried.tail).toBe("|||");
    liveWindowLines({ format: "text", text: "-----END KEY-----\nplain words -----BE\n" }, carried);
    expect(carried.tail).toBe("-----BE|-----BE|-----BE|");
  });

  test("peek never keeps a key tail it could not have produced", () => {
    expect(advanceTail(root, 99, { offset: 0, lines: [], state: "not-yet", keyTail: "TOPSECRET" }).keyTail).toBe("");
  });

  test("peek's cursor moves by the bytes read even when nothing in them shows", () => {
    const log = openLiveLog(root, 9)!;
    log.close();
    const tail = advanceTail(root, 9, { offset: 0, lines: [], state: "not-yet" });
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
});
