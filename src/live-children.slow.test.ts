/** Subagents' file at its size cap (live-children.ts; Codex av3 #3): a checkpoint is always within the reader's
 * 256 KiB bootstrap reach, however large an event, up to and at the cap. Slow: it writes the whole 16 MiB. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LIVE_SUB_FILE_CAP, liveSubLogPath, openLiveLog } from "./live.js";

const T = new Date("2026-10-26T12:00:00.000Z");
type Event = Record<string, unknown>;
const task = (id: string, description: string): Event => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Task", input: { description, prompt: "p" } }] } });
const say = (text: string, parent: string): Event => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-children-slow-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("review round 1 (Codex av3)", () => {
  test("#3 checkpoints stay within reach of every position, however large an event, and at the cap", () => {
    const log = openLiveLog(root, 4, { clock: () => T })!;
    log.observe(task("t1", "huge"));
    const big = `${"a line of a subagent's very long answer ".repeat(3)}\n`.repeat(3_000);
    let events = 0;
    while (events < 300) { log.observe(say(`${big}${events}`, "t1")); events += 1; }
    log.close();
    const text = readFileSync(liveSubLogPath(root, 4), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_SUB_FILE_CAP);
    let offset = 0, last = 0, widest = 0;
    for (const line of text.split("\n")) {
      if (line.includes('"k":"ckpt"')) { widest = Math.max(widest, offset - last); last = offset; }
      offset += Buffer.byteLength(line) + 1;
    }
    widest = Math.max(widest, offset - last);
    expect(text).toContain('"k":"cap"');
    expect(widest).toBeLessThan(256 * 1024);
  }, 60_000);

});
