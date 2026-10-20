/**
 * The rollout reader a Codex continuation trusts for its boundary (plan C1):
 * the last turn's end, bound to the thread and to the segment's spawn, with
 * its tokens from the running totals — and "none" for anything it cannot
 * read exactly. Records are shaped as codex-cli 0.156.1 writes them (C0).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRollout, lastTurnOf, readRollout } from "./codex-rollout.js";

const THREAD = "01a159b8-a7d7-76c1-81e3-a904d98fc2f9";
const SPAWN = Date.parse("2026-10-20T14:30:36.000Z");
const at = (ms: number) => new Date(SPAWN + ms).toISOString();
const meta = (id = THREAD) => ({ timestamp: at(0), type: "session_meta", payload: { id, session_id: id } });
const started = (turn: string, ms: number) => ({ timestamp: at(ms), type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const tokens = (input: number, output: number, ms: number) => ({ timestamp: at(ms), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } } });
const aborted = (turn: string, ms: number, reason = "interrupted") => ({ timestamp: at(ms), type: "event_msg", payload: { type: "turn_aborted", turn_id: turn, reason } });
const complete = (turn: string, ms: number) => ({ timestamp: at(ms), type: "event_msg", payload: { type: "task_complete", turn_id: turn } });
const text = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

describe("the last turn of a rollout", () => {
  test("an interrupted turn after the spawn is a boundary, with its own tokens", () => {
    const turn = lastTurnOf(text(meta(), started("t1", 500), tokens(100, 5, 2000), tokens(250, 9, 4000), aborted("t1", 5000)), THREAD, SPAWN);
    expect(turn).toEqual({ boundary: "interrupted", turnId: "t1", usage: { tokensIn: 250, tokensOut: 9 } });
  });

  test("a resumed turn counts only its own tokens; a completed turn is a boundary too", () => {
    const rows = text(meta(), started("t1", -60_000), tokens(300, 10, -59_000), aborted("t1", -58_000), started("t2", 1000), tokens(420, 14, 2000), complete("t2", 3000));
    expect(lastTurnOf(rows, THREAD, SPAWN)).toEqual({ boundary: "completed", turnId: "t2", usage: { tokensIn: 120, tokensOut: 4 } });
  });

  test("a turn that started before the segment's spawn is not this segment's boundary", () => {
    expect(lastTurnOf(text(meta(), started("t1", -30_000), aborted("t1", -1000)), THREAD, SPAWN).boundary).toBe("none");
  });

  test("an unended turn, another reason, an end naming another turn, or two ends are no boundary", () => {
    expect(lastTurnOf(text(meta(), started("t1", 100)), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf(text(meta(), started("t1", 100), aborted("t1", 200, "replaced")), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf(text(meta(), started("t1", 100), aborted("t0", 200)), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf(text(meta(), started("t1", 100), aborted("t1", 200), complete("t1", 300)), THREAD, SPAWN).boundary).toBe("none");
  });

  test("another thread, a malformed line, or no session header is no boundary", () => {
    expect(lastTurnOf(text(meta("01a159b8-0000-76c1-81e3-a904d98fc2f9"), started("t1", 100), aborted("t1", 200)), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf(text(meta(), started("t1", 100)) + "{not json\n" + text(aborted("t1", 200)), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf(text(started("t1", 100), aborted("t1", 200)), THREAD, SPAWN).boundary).toBe("none");
    expect(lastTurnOf("", THREAD, SPAWN).boundary).toBe("none");
  });

  test("tokens are unmeasured, never guessed, when the totals are missing or run backwards", () => {
    expect(lastTurnOf(text(meta(), started("t1", 100), aborted("t1", 200)), THREAD, SPAWN).usage).toBeNull();
    expect(lastTurnOf(text(meta(), tokens(500, 5, -500), started("t1", 100), tokens(400, 6, 150), aborted("t1", 200)), THREAD, SPAWN).usage).toBeNull();
  });
});

describe("finding and reading a rollout", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-rollout-"))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const day = new Date(2026, 9, 20, 7, 30);
  const folder = () => { const path = join(dir, "2026", "10", "20"); mkdirSync(path, { recursive: true }); return path; };

  test("found by exact thread id in its local day folder", () => {
    const path = join(folder(), `rollout-2026-10-20T07-30-36-${THREAD}.jsonl`);
    writeFileSync(path, text(meta()));
    writeFileSync(join(folder(), "rollout-2026-10-20T07-31-00-01a159b9-bfcf-7e33-87bc-785064491630.jsonl"), "");
    expect(findRollout(dir, THREAD, day, day)).toBe(path);
    expect(readRollout(path)).toBe(text(meta()));
  });

  test("a later day's search still finds a session started days before", () => {
    const path = join(folder(), `rollout-2026-10-20T07-30-36-${THREAD}.jsonl`);
    writeFileSync(path, "");
    expect(findRollout(dir, THREAD, day, new Date(2026, 9, 23))).toBe(path);
  });

  test("a link, two matches, a bad id or a file over the cap are not read", () => {
    const real = join(dir, "elsewhere.jsonl");
    writeFileSync(real, text(meta()));
    const link = join(folder(), `rollout-2026-10-20T07-30-36-${THREAD}.jsonl`);
    symlinkSync(real, link);
    expect(findRollout(dir, THREAD, day, day)).toBeNull();
    expect(readRollout(link)).toBeNull();
    rmSync(link);
    writeFileSync(join(folder(), `rollout-2026-10-20T07-30-36-${THREAD}.jsonl`), "");
    writeFileSync(join(folder(), `rollout-2026-10-20T08-00-00-${THREAD}.jsonl`), "");
    expect(findRollout(dir, THREAD, day, day)).toBeNull();
    expect(findRollout(dir, "../../etc", day, day)).toBeNull();
    expect(readRollout(real, 4)).toBeNull();
  });
});
