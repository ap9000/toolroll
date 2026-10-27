/** Reading the subagents' file (live-children-read.ts; docs/plans/agents-view.md §2.3, N1): what the writer wrote, in
 * order, from a sealed cursor or the newest checkpoint; never a forged record, never a guess, never command detail the
 * run's own answer withholds. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readChildWindow, CURSOR_CAP, type ChildView } from "./live-children-read.js";
import { HIDDEN_KEY_BLOCK } from "./live-records.js";
import { liveDir, liveSubLogPath, openLiveLog } from "./live.js";

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
    appendFileSync(liveSubLogPath(root, 8), line({ k: "ckpt", dropped: 0, streams: [{ s: 1, parent: null, open: [], inKey: false }] }) + line({ k: "say", s: 1, t: ["now"] }));
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
