/** The terminal's follow-through commands: a write takes a verified person, and each answers in the envelope. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modeWords, type ModeTerms } from "./modes.js";
import { runOperate } from "./operate.js";
import { addApprover } from "./scope.js";
import { openStore } from "./store.js";

const T0 = new Date("2026-11-07T12:00:00.000Z");
let dir: string, db: string, token: string;
const run = async (...argv: string[]) => {
  const lines: string[] = [];
  const code = await runOperate(argv[0]!, [...argv.slice(1), "--db", db, "--json"], line => lines.push(line), { databaseFile: db, now: T0 });
  return { code, body: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
};
const as = () => ["--as", "alex", "--token", token];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-ft-cli-"));
  db = join(dir, "orders.db");
  const store = openStore(db);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("no approver");
  token = alex.token;
  store.createTask({ id: "t-1", title: "the work" }, T0);
  store.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("finding", () => {
  test("send, list, close, by a verified person; a wrong password writes nothing", async () => {
    expect((await run("finding", "send", "t-1", "--note", "wrong", "--as", "alex", "--token", "nope")).body).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect((await run("finding", "list")).body["findings"]).toEqual([]);
    const sent = await run("finding", "send", "t-1", "--note", "the cache never clears", "--path", "src/a.ts", "--line", "3", ...as());
    expect(sent.body).toMatchObject({ ok: true, standing: "next-attempt", round: 1 });
    const id = String(sent.body["finding"]);
    expect((await run("finding", "list", "--task", "t-1")).body["findings"]).toMatchObject([{ summary: "the cache never clears", state: "open", sentBy: "alex" }]);
    expect((await run("finding", "show", id)).body["finding"]).toMatchObject({ file: "src/a.ts", line: 3 });
    expect((await run("finding", "close", id, ...as())).code).toBe(2);
    expect((await run("finding", "close", id, "--note", "fixed elsewhere", ...as())).body).toMatchObject({ ok: true, closedBy: "alex" });
    expect((await run("finding", "list")).body["findings"]).toEqual([]);
  });

  test("a send names exactly one source", async () => {
    expect((await run("finding", "send", "t-1", "--note", "x", "--from-check", "1", ...as())).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await run("finding", "send", "t-1", "--from-check", "99", ...as())).body).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("mode set", () => {
  test("repairs by themselves take the flag and a limit from 1 to 3; the terms a person signs say so", async () => {
    const repo = realpathSync(dir);
    const mode = (...extra: string[]) => run("mode", "set", "--repo", repo, "--days", "1", ...extra, ...as());
    expect((await mode("--repair-max-attempts", "2")).body).toMatchObject({ ok: false, reason: "invalid" });
    expect((await mode("--repair-auto", "--repair-max-attempts", "4")).body).toMatchObject({ ok: false, reason: "invalid" });
    expect((await mode("--review-auto", "on")).body).toMatchObject({ ok: false, reason: "invalid" });
    const signed = await mode("--repair-auto", "--repair-max-attempts", "3");
    expect(signed.body).toMatchObject({ ok: true });
    const store = openStore(db);
    const terms = JSON.parse(store.activeMode(repo, T0)!.termsJson) as ModeTerms;
    expect(terms).toMatchObject({ repairAuto: true, repairMaxAttempts: 3 });
    expect(modeWords(terms).join(" ")).toContain("at most 3 tries");
    store.close();
  });
});

describe("the task's own views", () => {
  test("handover reads with no credential; evidence and failing-first write only with one", async () => {
    expect((await run("task", "handover", "t-1")).body).toMatchObject({ ok: true, note: { taskId: "t-1", revision: null } });
    expect((await run("task", "handover", "nope")).body).toMatchObject({ ok: false, reason: "unknown-task" });
    expect((await run("task", "before-after", "t-1")).body).toMatchObject({ ok: true, pairs: [] });
    expect((await run("task", "before-after", "t-1", "save", ...as())).body).toMatchObject({ ok: false, reason: "refused" });
    expect((await run("task", "failing-first", "t-1", "on", "--as", "alex", "--token", "nope")).body).toMatchObject({ ok: false });
    expect((await run("task", "failing-first", "t-1", "on", ...as())).body).toMatchObject({ ok: true, on: true });
    expect((await run("task", "before-after", "t-1")).body).toMatchObject({ failingFirst: { askedBy: "alex" } });
  });

  test("captures list reads, and there's nothing to mark that isn't saved", async () => {
    expect((await run("captures", "list")).body).toMatchObject({ ok: true, captures: [] });
    expect((await run("captures", "mark", "1", "exhausted", ...as())).body).toMatchObject({ ok: false, reason: "unknown-task" });
  });
});
