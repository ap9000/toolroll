/** Subagents' records (live-children.ts; docs/plans/agents-view.md §2.3): their own file, the parent's untouched;
 * routing that outlives a delegation's result; streams that never close or redact each other; bounded everywhere. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CHILD_OPEN_STEPS_CAP, CHILD_STREAMS_CAP, createChildRecorder, type ChildRecord } from "./live-children.js";
import { createLiveRecorder, HIDDEN_TARGET, serializeLiveRecord, type LiveRecord } from "./live-records.js";
import { liveLogPath, liveSubLogPath, openLiveLog } from "./live.js";

const T = new Date("2026-10-26T12:00:00.000Z");
const at = T.toISOString();
type Event = Record<string, unknown>;
const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null): Event =>
  ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } });
const answer = (id: string, content: string, parent: string | null = null): Event =>
  ({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const say = (text: string, parent: string | null = null): Event => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } });
const done = (parent: string | null = null): Event => ({ type: "result", subtype: "success", is_error: false, parent_tool_use_id: parent });
const task = (id: string, description: string, parent: string | null = null) => call(id, "Task", { description, prompt: "p" }, parent);

const recorder = (commands = false, seen: LiveRecord[] = []) => {
  const child = createChildRecorder({ base: "/w", commands, clock: () => T });
  const parent = createLiveRecorder({ base: "/w", commands, clock: () => T, onStep: child.parentStep });
  return (events: Event[]): ChildRecord[] => events.flatMap(event => { seen.push(...parent.observe(event)); return child.observe(event); });
};
const of = (records: ChildRecord[], s: number) => records.filter(record => "s" in record && record.s === s);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-children-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the run's own file is untouched", () => {
  test("byte for byte what the recorder alone writes, with subagent traffic past every child cap; no subagents, no second file", () => {
    const events: Event[] = [{ type: "system", subtype: "init" }, say("planning")];
    for (let n = 0; n < CHILD_STREAMS_CAP + 2; n += 1) events.push(task(`t${n}`, `job ${n}`), say(`child ${n}`, `t${n}`), call(`b${n}`, "Bash", { command: "ls" }, `t${n}`));
    events.push(answer("t0", "ok"), say("all done"), done());
    const log = openLiveLog(root, 1, { base: "/w", commands: false, clock: () => T })!;
    for (const event of events) log.observe(event);
    log.close();
    const alone = createLiveRecorder({ base: "/w", commands: false, clock: () => T });
    const expected = [{ k: "open", at, detail: "base" }, ...events.flatMap(event => alone.observe(event)), ...alone.end()];
    expect(readFileSync(liveLogPath(root, 1), "utf8")).toBe(expected.map(record => `${serializeLiveRecord(record as never)}\n`).join(""));
    expect(readFileSync(liveSubLogPath(root, 1), "utf8")).toContain('"k":"over"');

    const quiet = openLiveLog(root, 2, { clock: () => T })!;
    quiet.observe(say("no subagents here"));
    quiet.close();
    expect(existsSync(liveSubLogPath(root, 2))).toBe(false);
  });
});

describe("routing and ownership", () => {
  test("a subagent opens a stream named for the parent's step; its ids are its own; a checkpoint follows", () => {
    const records = recorder()([say("hi"), task("t1", "Fix the login bug"), say("looking", "t1"), call("r1", "Read", { file_path: "/w/a.ts" }, "t1"), answer("r1", "x", "t1")]);
    expect(records[0]).toEqual({ k: "child", s: 1, at, parent: "s1", desc: "Fix the login bug" });
    expect(records[1]).toMatchObject({ k: "say", s: 1, t: ["looking"] });
    expect(records[2]).toMatchObject({ k: "ckpt", streams: [{ s: 1, parent: "s1", open: [], inKey: false }] });
    expect(records.slice(3)).toEqual([
      { k: "step", at, id: "c1s1", kind: "read", target: "a.ts", s: 1 },
      { k: "done", at, id: "c1s1", ok: true, s: 1 },
    ]);
  });

  test("a background subagent keeps streaming after its Task call returns; one that ended stays ended", () => {
    const run = recorder();
    const records = run([task("t1", "bg"), answer("t1", "started in the background"), say("still going", "t1"), done("t1"), say("late", "t1")]);
    expect(of(records, 1).map(record => record.k)).toEqual(["child", "say", "end"]);
    expect(records.find(record => record.k === "end")).toMatchObject({ ok: true });
  });

  test("a close never reaches another stream's step, and a collision is ignored", () => {
    const records = recorder()([task("t1", "a"), task("t2", "b"), call("x", "Read", { file_path: "/w/a" }, "t1"), answer("x", "y", "t2"), task("t1", "again")]);
    expect(records.filter(record => record.k === "done")).toEqual([]); // t2's answer can't close t1's step
    expect(records.filter(record => record.k === "child").map(record => record.s)).toEqual([1, 2]);
    expect(records.filter(record => record.k === "ckpt").at(-1)).toMatchObject({ streams: [{ s: 1, open: ["c1s1"] }, { s: 2, open: [] }] });
    expect(records.filter(record => record.k === "child" && record.desc === "again")).toEqual([]); // the second Task "t1" is ignored
  });

  test("nesting is shown one level down, never past depth 2; the 17th subagent writes one `over`", () => {
    const nested = recorder()([task("t1", "outer"), task("t2", "inner", "t1"), say("deep", "t2"), task("t3", "too deep", "t2"), say("lost", "t3")]);
    expect(nested.filter(record => record.k === "child")).toEqual([
      { k: "child", s: 1, at, parent: "s1", desc: "outer" },
      { k: "child", s: 2, at, parent: "c1s1", via: 1, desc: "inner" },
    ]);
    expect(JSON.stringify(nested)).not.toContain("lost");
    const many: Event[] = [];
    for (let n = 0; n < CHILD_STREAMS_CAP + 3; n += 1) many.push(task(`t${n}`, `${n}`), say(`hi ${n}`, `t${n}`));
    const over = recorder()(many);
    expect(over.filter(record => record.k === "child")).toHaveLength(CHILD_STREAMS_CAP);
    expect(over.filter(record => record.k === "over")).toHaveLength(1);
  });

  test("open steps are bounded across streams; past the bound a step shows once and its close is dropped", () => {
    const events: Event[] = [task("t1", "a"), task("t2", "b")];
    for (let n = 0; n < CHILD_OPEN_STEPS_CAP; n += 1) events.push(call(`a${n}`, "Read", { file_path: `/w/${n}` }, n % 2 === 0 ? "t1" : "t2"));
    events.push(call("extra", "Read", { file_path: "/w/x" }, "t1"), answer("extra", "y", "t1"));
    const records = recorder()(events);
    expect(records.find(record => record.k === "step" && record.target === "x")).toMatchObject({ once: true });
    expect(records.filter(record => record.k === "done")).toEqual([]);
  });

  test("the main query's result ends every subagent; a subagent's own result ends only it", () => {
    const records = recorder()([task("t1", "a"), task("t2", "b"), say("one", "t1"), say("two", "t2"), done("t1"), say("still", "t2"), done()]);
    expect(records.filter(record => record.k === "end")).toEqual([{ k: "end", s: 1, at, ok: true }, { k: "end", s: 2, at, ok: null }]);
    expect(of(records, 2).map(record => record.k)).toContain("say");
  });
});

describe("redaction and consent", () => {
  test("each stream keeps its own key-block state: one subagent's BEGIN or END never hides or reveals another's", () => {
    const records = recorder()([task("t1", "a"), task("t2", "b"),
      say("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg", "t1"), say("plain words from b", "t2"), say("-----END PRIVATE KEY-----", "t2"), say("MIIEsecondhalf", "t1")]);
    const text = JSON.stringify(records);
    expect(text).toContain("plain words from b");
    expect(text).not.toMatch(/MIIEvQIBADANBg|MIIEsecondhalf/);
    expect(records.filter(record => record.k === "ckpt").at(-1)).toMatchObject({ streams: [{ s: 1, inKey: true }, { s: 2, inKey: false }] });
  });

  test("a subagent's command text and output follow the run's captured answer", () => {
    const events = [task("t1", "a"), call("b", "Bash", { command: "cat ~/.ssh/id_ed25519" }, "t1"), answer("b", "ssh-ed25519 AAAA", "t1")];
    expect(JSON.stringify(recorder(false)(events))).not.toMatch(/id_ed25519|AAAA/);
    expect(JSON.stringify(recorder(true)(events))).toMatch(/id_ed25519/);
  });
});

describe("the subagents' file", () => {
  test("a checkpoint at least every 32 KiB, so a reader starting mid-file has each stream's state", () => {
    const log = openLiveLog(root, 3, { clock: () => T })!;
    log.observe(task("t1", "chatty"));
    for (let n = 0; n < 40; n += 1) log.observe(say(`${"word ".repeat(400)}${n}`, "t1"));
    log.close();
    const lines = readFileSync(liveSubLogPath(root, 3), "utf8").trim().split("\n").map(line => JSON.parse(line) as ChildRecord);
    const at = lines.flatMap((record, index) => (record.k === "ckpt" ? [index] : []));
    expect(at.length).toBeGreaterThanOrEqual(2);
    const bytes = (from: number, to: number) => lines.slice(from, to).reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0);
    for (let n = 1; n < at.length; n += 1) expect(bytes(at[n - 1]! + 1, at[n]!)).toBeLessThan(32 * 1024 + 8 * 1024);
    expect(lines.at(-1)).toEqual({ k: "end", s: 1, at: T.toISOString(), ok: null }); // the process ended with it open
    expect(lines[0]).toMatchObject({ k: "child", s: 1, parent: "s1", desc: "chatty" }); // named for the run's own step
  });
});

describe("review round 1 (Codex av3)", () => {
  test("#1 a nested delegation's description goes through its owner's redaction, key state included", () => {
    const records = recorder()([task("t1", "outer"), say("-----BEGIN PRIVATE KEY-----\nMIIEvQ", "t1"), task("t2", "SECRET-DESCRIPTION", "t1"), say("x", "t2")]);
    expect(JSON.stringify(records)).not.toContain("SECRET-DESCRIPTION");
    expect(records.find(record => record.k === "child" && record.s === 2)).toMatchObject({ desc: HIDDEN_TARGET });
  });

  test("#2 a reference that isn't a plain string id routes nowhere; an id two callers used is quarantined", () => {
    const coerced = recorder()([task("7", "seven"), say("number", 7 as never), say("array", ["7"] as never)]);
    expect(coerced).toEqual([]);
    const siblings = recorder()([task("t1", "a"), task("t2", "b"), say("a speaks", "t1"), say("b speaks", "t2"),
      task("same", "from a", "t1"), task("same", "from b", "t2"), say("whose?", "same")]);
    expect(JSON.stringify(siblings)).not.toContain("whose?");
    expect(siblings.filter(record => record.k === "child").map(record => record.s)).toEqual([1, 2]);
  });

  test("#4 a delegation that never spoke before the main query ended never opens", () => {
    const records = recorder()([task("a", "never started"), done(), say("too late", "a")]);
    expect(records).toEqual([]);
  });

  test("#5 a subagent is named for the step the parent really wrote for its call", () => {
    const seen: LiveRecord[] = [];
    const records = recorder(false, seen)([task("A", "first"), answer("A", "ok"),
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "A", name: "Task", input: { description: "first again" } }, { type: "tool_use", id: "B", name: "Task", input: { description: "second" } }] } },
      say("b speaks", "B")]);
    const bStep = seen.find(record => record.k === "step" && record.target === "second");
    expect(records.find(record => record.k === "child")).toMatchObject({ parent: bStep?.k === "step" ? bStep.id : "missing", desc: "second" });
    // A duplicate ordinary call before a Task never shifts the naming either.
    const seen2: LiveRecord[] = [];
    const two = recorder(false, seen2)([call("r", "Read", { file_path: "/w/a" }),
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/w/a" } }, { type: "tool_use", id: "C", name: "Task", input: { description: "third" } }] } },
      say("c speaks", "C")]);
    const cStep = seen2.find(record => record.k === "step" && record.target === "third");
    expect(two.find(record => record.k === "child")).toMatchObject({ parent: cStep?.k === "step" ? cStep.id : "missing" });
  });

  test("#6 a subagent repeating a delegation id opens no new step", () => {
    const records = recorder()([task("t1", "outer"), task("n1", "inner", "t1"), answer("n1", "ok", "t1"), task("n1", "inner again", "t1"), task("n1", "and again", "t1")]);
    expect(records.filter(record => record.k === "step").map(record => record.k === "step" && record.id)).toEqual(["c1s1"]);
  });

  test("#7 a subagent's init forgets a half-seen key marker", () => {
    const records = recorder()([task("t1", "a"), say("look -----BE", "t1"), { type: "system", subtype: "init", parent_tool_use_id: "t1" }, say("GIN harmless", "t1"), say("still visible", "t1")]);
    expect(JSON.stringify(records)).toContain("still visible");
  });
});

