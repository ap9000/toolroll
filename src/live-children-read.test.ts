/** Reading the subagents' file (live-children-read.ts; docs/plans/agents-view.md §2.3, N1): what the writer wrote, in
 * order, from a sealed cursor or the newest checkpoint; never a forged record, never a guess, never command detail the
 * run's own answer withholds. */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readChildWindow, CURSOR_CAP, type ChildView } from "./live-children-read.js";
import { HIDDEN_KEY_BLOCK } from "./live-records.js";
import { liveDir, liveSubLogPath, openLiveLog } from "./live.js";
import { openLiveTrusted } from "./live-open.js";

const T = new Date("2026-10-27T12:00:00.000Z");
const at = T.toISOString();
const KEY = Buffer.alloc(32, 7);
type Event = Record<string, unknown>;
const task = (id: string, description: string): Event => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Task", input: { description } }] } });
const say = (text: string, parent: string): Event => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } });
const bash = (id: string, command: string, parent: string): Event => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const answer = (id: string, content: string, parent: string): Event => ({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-child-read-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (run: number, events: Event[], commands = false) => {
  const log = openLiveLog(root, run, { base: "/w", commands, clock: () => T })!;
  for (const event of events) log.observe(event);
  return log;
};
const read = (run: number, cursor: string | null = null, commands = false) => {
  const got = readChildWindow(root, run, cursor, { key: KEY, commands });
  if (!got.ok) throw new Error(got.reason);
  return got;
};
const line = (record: Record<string, unknown>) => `${JSON.stringify({ at, ...record })}\n`;
const kinds = (records: ChildView[]) => records.map(record => record.k);

describe("reading what the writer wrote", () => {
  test("from the start, then on from the cursor: each record once, in order, with its stream", () => {
    const log = write(1, [task("t1", "Fix the login bug"), say("looking", "t1"), bash("b1", "ls", "t1")]);
    const first = read(1);
    expect(first).toMatchObject({ restarted: false, earlier: false, quarantined: 0, more: false });
    expect(first.records).toEqual([
      { k: "child", s: 1, parent: "s1", desc: "Fix the login bug" },
      { k: "say", at, t: ["looking"], s: 1 },
      { k: "step", at, id: "c1s1", kind: "command", s: 1 },
    ]);
    log.observe(answer("b1", "ok", "t1"));
    log.close();
    const next = read(1, first.cursor);
    expect(next.records).toEqual([{ k: "done", at, id: "c1s1", ok: true, s: 1 }, { k: "end", s: 1, ok: null }]);
  });

  test("missing and unavailable say so", () => {
    expect(readChildWindow(root, 9, null, { key: KEY, commands: false })).toEqual({ ok: false, reason: "missing" });
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "elsewhere"), line({ k: "over" }));
    symlinkSync(join(root, "elsewhere"), liveSubLogPath(root, 9));
    expect(readChildWindow(root, 9, null, { key: KEY, commands: false })).toEqual({ ok: false, reason: "unavailable" });
  });

  test("command detail follows the run's own answer, never the file's", () => {
    write(2, [task("t1", "a"), bash("b1", "cat ~/.ssh/id_ed25519", "t1"), answer("b1", "ssh-ed25519 AAAA", "t1")], true).close();
    expect(JSON.stringify(read(2, null, false).records)).not.toMatch(/id_ed25519|AAAA/);
    expect(JSON.stringify(read(2, null, true).records)).toMatch(/id_ed25519/);
  });
});

describe("the cursor", () => {
  test("a forged, oversized, another run's or a replaced file's cursor starts over visibly", () => {
    write(3, [task("t1", "a"), say("one", "t1")]).close();
    write(4, [task("t1", "b"), say("two", "t1")]).close();
    const good = read(3).cursor;
    const [body, mac] = good.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), off: 0 })).toString("base64url")}.${mac}`;
    for (const cursor of [forged, `${good}x`, "x".repeat(CURSOR_CAP + 1), `${body}.${mac}.${mac}`]) {
      expect(read(3, cursor)).toMatchObject({ restarted: true, earlier: false });
    }
    expect(read(4, good)).toMatchObject({ restarted: true }); // another run's
    rmSync(liveSubLogPath(root, 3));
    writeFileSync(liveSubLogPath(root, 3), line({ k: "child", s: 1, parent: null }), { mode: 0o600 });
    expect(read(3, good)).toMatchObject({ restarted: true, records: [{ k: "child", s: 1, parent: null }] }); // the file was replaced
  });

  test("each stream's key state rides the cursor: one stream's open block hides only its own lines across reads", () => {
    const log = write(5, [task("t1", "a"), task("t2", "b"), say("before", "t1"), say("from b", "t2")]);
    const first = read(5);
    log.observe(say("plain", "t1"));
    const second = read(5, first.cursor);
    expect(JSON.stringify(second.records)).toContain("plain");
    log.close();
    // A file whose writer never redacted (forged): the reader's own per-stream state still hides a block's body.
    mkdirSync(liveDir(root), { recursive: true });
    writeFileSync(liveSubLogPath(root, 6), [line({ k: "child", s: 1, parent: null }), line({ k: "child", s: 2, parent: null }),
      line({ k: "say", s: 1, t: ["-----BEGIN PRIVATE KEY-----"] })].join(""), { mode: 0o600 });
    const a = read(6);
    appendFileSync(liveSubLogPath(root, 6), line({ k: "say", s: 2, t: ["-----END PRIVATE KEY-----", "b is fine"] }) + line({ k: "say", s: 1, t: ["MIIEvQsecret"] }));
    const b = read(6, a.cursor);
    expect(JSON.stringify(b.records)).toContain("b is fine");
    expect(JSON.stringify(b.records)).not.toContain("MIIEvQsecret");
    // Stream 2's END never closes stream 1's block; stream 1's line, inside its block, shows nothing.
    expect(b.records).toHaveLength(1);
    expect(b.records[0]).toMatchObject({ s: 2, t: expect.arrayContaining(["b is fine"]) });
    expect(a.records.at(-1)).toMatchObject({ s: 1, t: [HIDDEN_KEY_BLOCK] });
  });
});

describe("starting mid-file", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => line({ k: "say", s: 1, t: [`${"filler ".repeat(100)}${i}`] })).join("");

  test("from the newest checkpoint in the last 256 KiB, with its state: a step opened before it closes, a key block stays hidden", () => {
    mkdirSync(liveDir(root), { recursive: true });
    writeFileSync(liveSubLogPath(root, 7), [line({ k: "child", s: 1, parent: "s1", desc: "long" }), line({ k: "step", s: 1, id: "c1s1", kind: "read" }),
      big(500), line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: "s1", open: ["c1s1"], inKey: true }] }),
      line({ k: "say", s: 1, t: ["still inside the key"] }), line({ k: "done", s: 1, id: "c1s1", ok: true })].join(""), { mode: 0o600 });
    let got = read(7);
    const seen: ChildView[] = [...got.records];
    for (let n = 0; n < 10 && got.more; n += 1) { got = read(7, got.cursor); seen.push(...got.records); }
    expect(got.earlier).toBe(true);
    expect(seen).toEqual([{ k: "done", at, id: "c1s1", ok: true, s: 1 }]); // the line inside the key block shows nothing
  });

  test("with no checkpoint in reach nothing is shown until one comes (fails closed)", () => {
    mkdirSync(liveDir(root), { recursive: true });
    writeFileSync(liveSubLogPath(root, 8), line({ k: "child", s: 1, parent: null }) + big(500) + line({ k: "over" }), { mode: 0o600 });
    let got = read(8);
    const seen: ChildView[] = [...got.records];
    let quarantined = got.quarantined;
    for (let n = 0; n < 10 && got.more; n += 1) { got = read(8, got.cursor); seen.push(...got.records); quarantined += got.quarantined; }
    expect(seen).toEqual([]); // not even the `over`: nothing until a checkpoint
    expect(quarantined).toBe(0); // waited out, not taken for forgeries
    expect(got.earlier).toBe(true);
    // A checkpoint brings the stream back, but its key state is the file's word: unknown until an END marker.
    appendFileSync(liveSubLogPath(root, 8), line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }] })
      + line({ k: "say", s: 1, t: ["not yet"] }) + line({ k: "say", s: 1, t: ["-----END PRIVATE KEY-----"] }) + line({ k: "say", s: 1, t: ["now"] }));
    expect(read(8, got.cursor).records).toEqual([{ k: "say", at, t: ["now"], s: 1 }]);
  });
});

describe("quarantine", () => {
  test("records that fail a check are counted, never shown, never the run's own", () => {
    mkdirSync(liveDir(root), { recursive: true });
    const lines = [
      line({ k: "child", s: 1, parent: null }), line({ k: "child", s: 2, parent: null }),
      line({ k: "step", s: 1, id: "c1s1", kind: "read" }),
      line({ k: "say", s: 3, t: ["unknown stream"] }),
      line({ k: "say", t: ["no stream: the run's own?"] }),
      line({ k: "done", s: 2, id: "c1s1", ok: true }),
      line({ k: "done", s: 2, id: "c2s1", ok: true }),
      line({ k: "step", s: 1, id: "s5", kind: "read" }),
      line({ k: "child", s: 1, parent: null }),
      line({ k: "child", s: 3, parent: "../etc" }),
      "{not json\n",
      line({ k: "say", s: "1", t: ["string stream"] }),
    ];
    writeFileSync(liveSubLogPath(root, 9), lines.join(""), { mode: 0o600 });
    const got = read(9);
    expect(kinds(got.records)).toEqual(["child", "child", "step"]);
    expect(got.quarantined).toBe(lines.length - 3);
    expect(got.records.every(record => record.k === "over" || record.k === "cap" || "s" in record)).toBe(true);
  });

  test("open steps are bounded across streams on read too", () => {
    mkdirSync(liveDir(root), { recursive: true });
    const lines = [line({ k: "child", s: 1, parent: null }), ...Array.from({ length: 40 }, (_, i) => line({ k: "step", s: 1, id: `c1s${i + 1}`, kind: "read" }))];
    writeFileSync(liveSubLogPath(root, 10), lines.join(""), { mode: 0o600 });
    expect(read(10)).toMatchObject({ quarantined: 8 });
  });
});

describe("review round 1 (Codex av4)", () => {
  const file = (run: number, lines: string[]) => { mkdirSync(liveDir(root), { recursive: true }); writeFileSync(liveSubLogPath(root, run), lines.join(""), { mode: 0o600 }); };
  const BEGIN = "-----BEGIN PRIVATE KEY-----";

  test("#1 a checkpoint never clears a key block this reader saw open, nor a half-seen marker", () => {
    file(20, [line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: [BEGIN] }),
      line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }] }), line({ k: "say", s: 1, t: ["MIIEvQsecret"] })]);
    expect(JSON.stringify(read(20).records)).not.toContain("MIIEvQsecret");
    file(21, [line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: ["look -----BE"] }),
      line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }] }), line({ k: "say", s: 1, t: ["GIN PRIVATE KEY-----", "MIIEvQsecret"] })]);
    expect(JSON.stringify(read(21).records)).not.toContain("MIIEvQsecret");
  });

  test("#1 from a mid-file start a stream's key state is unknown: a BEGIN before the scan region still hides its body", () => {
    const filler = Array.from({ length: 500 }, (_, i) => line({ k: "say", s: 2, t: [`${"filler ".repeat(100)}${i}`] }));
    file(22, [line({ k: "child", s: 1, parent: null }), line({ k: "child", s: 2, parent: null }), line({ k: "say", s: 1, t: [BEGIN] }), ...filler,
      line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }, { s: 2, parent: null, open: [], inKey: false }] }),
      line({ k: "say", s: 1, t: ["MIIEvQsecret"] })]);
    let got = read(22);
    let text = "";
    for (let n = 0; n < 10; n += 1) { text += JSON.stringify(got.records); if (!got.more) break; got = read(22, got.cursor); }
    expect(text).not.toContain("MIIEvQsecret");
  });

  test("#2 a rejected record never changes key state: a forged close carrying an END keeps the block closed", () => {
    file(23, [line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: [BEGIN] })]);
    const first = read(23);
    appendFileSync(liveSubLogPath(root, 23), line({ k: "done", s: 1, id: "c1s1", ok: true, out: ["-----END PRIVATE KEY-----"] }) + line({ k: "say", s: 1, t: ["MIIEvQsecret"] }));
    const next = read(23, first.cursor);
    expect(next.quarantined).toBe(1);
    expect(JSON.stringify(next.records)).not.toContain("MIIEvQsecret");
  });

  test("#2 a line that can't be read makes every stream's key state unknown", () => {
    file(24, [line({ k: "child", s: 1, parent: null }), '{"k":"say","s":1,"t":["-----BEGIN PRIVATE KEY-----" broken\n', line({ k: "say", s: 1, t: ["MIIEvQsecret"] })]);
    expect(JSON.stringify(read(24).records)).not.toContain("MIIEvQsecret");
  });

  test("#3 an unfinished last line doesn't ask for another read until it grows; once finished it is read once", () => {
    file(25, [line({ k: "child", s: 1, parent: null }), `{"k":"say","at":"${at}","s":1,"t":["half`]);
    const first = read(25);
    expect(first.more).toBe(false);
    expect(read(25, first.cursor)).toMatchObject({ more: false, records: [] });
    appendFileSync(liveSubLogPath(root, 25), ` done"]}\n`);
    expect(read(25, first.cursor).records).toEqual([{ k: "say", at, t: ["half done"], s: 1 }]);
  });

  test("#4 a live directory loosened right after the open is unavailable", () => {
    file(26, [line({ k: "child", s: 1, parent: null })]);
    expect(openLiveTrusted(root, "26.sub.jsonl", { afterOpen: () => chmodSync(liveDir(root), 0o777) })).toBe("unavailable");
    chmodSync(liveDir(root), 0o700);
  });

  test("#5 a step id already open, and its second close, are quarantined", () => {
    file(27, [line({ k: "child", s: 1, parent: null }), line({ k: "step", s: 1, id: "c1s1", kind: "read" }), line({ k: "step", s: 1, id: "c1s1", kind: "read" }),
      line({ k: "done", s: 1, id: "c1s1", ok: true }), line({ k: "done", s: 1, id: "c1s1", ok: true })]);
    const got = read(27);
    expect(kinds(got.records)).toEqual(["child", "step", "done"]);
    expect(got.quarantined).toBe(2);
  });

  test("checkpoint validation: a dangling or cyclic nesting, duplicate open ids or a non-boolean `ended` are refused", () => {
    for (const streams of [[{ s: 1, parent: null, via: 2, open: [], inKey: false }], [{ s: 1, parent: null, open: ["c1s1", "c1s1"], inKey: false }],
      [{ s: 1, parent: null, open: [], inKey: false, ended: "yes" }]]) {
      file(28, [line({ k: "ckpt", dropped: 0, streams })]);
      expect(read(28).quarantined).toBe(1);
    }
  });

  test("one request reads within one budget: a bootstrap that scanned the end reads nothing more now", () => {
    const filler = Array.from({ length: 600 }, (_, i) => line({ k: "say", s: 1, t: [`${"filler ".repeat(100)}${i}`] }));
    file(29, [line({ k: "child", s: 1, parent: null }), ...filler, line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }] }), line({ k: "child", s: 2, parent: null })]);
    const first = read(29);
    expect(first).toMatchObject({ records: [], earlier: true, more: true });
    expect(read(29, first.cursor).records).toEqual([{ k: "child", s: 2, parent: null }]);
  });
});


describe("review round 2 (Codex av4)", () => {
  const file = (run: number, lines: string[]) => { mkdirSync(liveDir(root), { recursive: true }); writeFileSync(liveSubLogPath(root, run), lines.join(""), { mode: 0o600 }); };
  const BEGIN = "-----BEGIN PRIVATE KEY-----";

  test("a checkpoint that drops a stream this reader follows is refused: its number and open block can't be reused", () => {
    file(30, [line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: [BEGIN] }), line({ k: "ckpt", dropped: 0, streams: [] }),
      line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: ["MIIEvQsecret"] })]);
    const got = read(30);
    expect(JSON.stringify(got.records)).not.toContain("MIIEvQsecret");
    expect(got.quarantined).toBe(2); // the checkpoint, and the second child 1
  });

  test("an explicit null is not a default: ended or unknown null refuse the checkpoint", () => {
    for (const extra of [{ ended: null }, { unknown: null }]) {
      file(31, [line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false, ...extra }] })]);
      expect(read(31).quarantined).toBe(1);
    }
  });

  test("a block seen open stays open until a valid END: records that carry no text never run it down", () => {
    file(32, [line({ k: "child", s: 1, parent: null }), line({ k: "say", s: 1, t: [BEGIN] }), "{broken\n",
      ...Array.from({ length: 9 }, () => line({ k: "cut", s: 1, pad: "x".repeat(8000) })), line({ k: "say", s: 1, t: ["MIIEvQsecret"] })]);
    let got = read(32);
    let text = JSON.stringify(got.records);
    for (let n = 0; n < 5 && got.more; n += 1) { got = read(32, got.cursor); text += JSON.stringify(got.records); }
    expect(text).not.toContain("MIIEvQsecret");
  });

  test("a bootstrap over a tail of bare newlines finishes and fails closed", () => {
    file(33, [line({ k: "child", s: 1, parent: null }), "\n".repeat(300 * 1024)]);
    expect(read(33)).toMatchObject({ records: [], earlier: true });
  });
});
