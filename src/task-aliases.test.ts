/** People's names for task commands are exactly the commands they name (docs/plans/plain-toolroll.md P1.3): the
 * alias is read before anything else, so the command, its rules and its answer are the original's. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";
import { runOperate } from "./operate.js";
import { TASK_ALIASES, withTaskAlias } from "./task-aliases.js";

let dir = "", db = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-task-aliases-")); db = join(dir, "orders.db"); openStore(db).close(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const answer = async (argv: string[]) => {
  const lines: string[] = [];
  const code = await runOperate("task", [...argv, "--db", db, "--json"], line => lines.push(line), { now: new Date("2026-11-05T12:00:00Z") });
  const envelope = JSON.parse(lines.join("\n")) as Record<string, unknown>;
  return { code, reason: envelope["reason"], message: envelope["message"] };
};

describe("task aliases", () => {
  test("each alias names exactly one existing command, and nothing else is touched", () => {
    expect(TASK_ALIASES).toEqual({ "send-back": "revise", retry: "requeue", recheck: "regate" });
    expect(withTaskAlias(["task", "send-back", "t-1", "--feedback", "x"])).toEqual(["task", "revise", "t-1", "--feedback", "x"]);
    expect(withTaskAlias(["task", "retry", "t-1"])).toEqual(["task", "requeue", "t-1"]);
    expect(withTaskAlias(["task", "accept", "t-1"])).toEqual(["task", "accept", "t-1"]);
    expect(withTaskAlias(["status", "retry"])).toEqual(["status", "retry"]);
  });

  test("an alias answers exactly as the command it names", async () => {
    for (const [alias, original] of Object.entries(TASK_ALIASES)) {
      expect(await answer([alias, "no-such-task"]), alias).toEqual(await answer([original, "no-such-task"]));
    }
  });
});
