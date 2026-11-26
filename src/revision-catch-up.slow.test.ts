/**
 * Two tasks built from the same main (stranger 17): land the first, and the second's Land refuses because main moved on.
 * Sending it back must work: its next attempt starts with the current main merged in (revision-catch-up.ts), so its
 * base reads up to date and it lands, as one commit on main's current commit. A merge that conflicts makes nothing,
 * starts the revision from the earlier work as before, and landing then says how to bring the two together instead of
 * advising another send back. Real git; only the agent is a stub.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as exec } from "./exec.js";
import { EXIT, runOperate } from "./operate.js";
import { openStore } from "./store.js";
import { familyStartOf, taskBaseOf } from "./task-base.js";
import { CATCH_UP_ACTION } from "./revision-catch-up.js";
import { mergeChecklistOf } from "./merge-checklist.js";
import type { Runner } from "./builder.js";
import { AGENT_SAID, OK, concludeDone, registerRunner } from "../test/tick-kit.js";
import { termsArgs } from "../test/approval-terms.js";

const T0 = new Date(Date.now() - 60_000);
const PLAN = {
  goal: "Make the change again on the current main",
  outOfScope: "Nothing else",
  touches: ["b.txt"],
  acceptance: [{ id: "c1", statement: "It is done.", evidence: ["manual-review"] }],
  amendment: "The revision keeps the change and checks it against the current main.",
  plan: ["## Approach", "Keep the change.", "## Milestones", "1. Keep it.", "## Dependencies", "- None.", "## Risks", "- None.", "## Proof", "- c1 — read it."].join("\n"),
};
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("work behind main gets a working way forward", () => {
  let base: string, repo: string, db: string, pool: string, lines: string[] = [];
  /** What each attempt's agent saw in its folder when it started: does it have the other task's file? */
  const sawOther: Record<string, boolean> = {};
  const git = async (args: string[], cwd = repo) => (await exec("git", args, { cwd })).stdout.trim();
  /** The stand-in agent: t-b and its revisions write b.txt, anything else a.txt; it notes what it saw. */
  const building: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    // Planning a revision: a plan, and nothing else touched.
    const plan = /STANDING-ORDERS-PLAN-[0-9a-f]{16}\.json/.exec(args[args.indexOf("-p") + 1] ?? "")?.[0];
    if (plan !== undefined && cwd !== "") {
      await writeFile(join(cwd, plan), JSON.stringify(PLAN));
      return { ...OK, stdout: JSON.stringify({ result: "planned" }) };
    }
    const task = (await git(["symbolic-ref", "--short", "HEAD"], cwd)).replace(/^toolroll\//, "");
    sawOther[task] = existsSync(join(cwd, "a.txt"));
    const file = task.startsWith("t-b") ? "b.txt" : "a.txt";
    await writeFile(join(cwd, file), `${task} was here\n`);
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };
  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: building });
  };
  const said = () => lines.join("\n");
  const payload = () => JSON.parse(said());
  let runner = "", approver = "";
  const tick = (now: Date) => run(["tick", "--runner", "builder-1", "--token", runner, "--repo", repo, "--pool", pool, "--json"], now);
  const as = () => ["--as", "alex", "--token", approver];

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "so-catch-up-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "worktrees");
    mkdirSync(repo);
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
    runner = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    approver = payload().token as string;
    for (const phase of ["build", "plan", "review"]) await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", ...as(), "--json"]);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const file = async (id: string) => {
    await run(["task", "add", `the work for ${id}`, "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", `make the change for ${id}`, "--acceptance", "It is done.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    await run(["task", "approve", id, "--yes", "--digest", payload().scope.digest as string, ...termsArgs(db, id), ...as()]);
  };
  const complete = async (id: string, now: Date) => {
    expect(await run(["task", "complete", id, ...as()], now), said()).toBe(EXIT.ok);
  };
  /** Land through the CLI: the look, then the yes; main is checked out in the project folder, so the person brings the
   * kept commit in with the exact command it shows. Returns the look's refusal words, or null when it landed. */
  const land = async (id: string, now: Date): Promise<string | null> => {
    const looked = await run(["task", "land", id, "--into", "main", "--json"], now);
    if (looked !== EXIT.ok) return said();
    const key = payload().plan.key as string;
    expect(await run(["task", "land", id, "--into", "main", "--yes", "--key", key, ...as(), "--json"], now), said()).toBe(EXIT.ok);
    const commit = /merge --ff-only ([0-9a-f]{40})/.exec(said())?.[1];
    expect(commit, said()).toBeDefined();
    await git(["merge", "--ff-only", commit!]);
    return null;
  };
  /** Send back, as the task page's "Ask the agent to fix" does, then plan it and approve the plan: the revision is
   * ready to build. */
  const sendBack = async (id: string, now: Date): Promise<string> => {
    expect(await run(["task", "revise", id, "--feedback", "main moved on since this work started. Make sure the work still fits with main's newer changes.", ...as(), "--json"], now), said()).toBe(EXIT.ok);
    const revision = payload().result.id as string;
    await tick(now);
    expect(payload().dispatched, said()).toMatchObject([{ id: revision, outcome: "planned" }]);
    await run(["task", "approve", revision, "--json"], now);
    expect(await run(["task", "approve", revision, "--yes", "--digest", payload().scope.digest as string, ...termsArgs(db, revision), ...as()], now), said()).toBe(EXIT.ok);
    return revision;
  };
  const headOf = async (id: string) => {
    const store = openStore(db);
    try { return store.runsFor(store.lookupRef(id)!.id).find(one => one.role === "builder")!; } finally { store.close(); }
  };

  test("land one, send the other back: it starts on the current main with its work merged in, reads up to date, and lands", async () => {
    await file("t-a");
    await file("t-b");
    await tick(T0);
    await tick(later(1));
    expect(sawOther["t-b"]).toBe(false);
    await complete("t-a", later(2));
    await complete("t-b", later(2));
    expect(await land("t-a", later(3))).toBeNull();
    const mainAfterA = await git(["rev-parse", "main"]);

    // The dead end: Land refuses, and the advice it gives is the send back.
    const refused = await land("t-b", later(4));
    expect(refused).toContain("moved on since this work started");
    expect(refused).toContain("Send it back");
    // So do the task page's checklist and the step cards a terminal reads.
    {
      const store = openStore(db);
      try {
        const row = mergeChecklistOf(store, "t-b", later(4), { principal: "operator", repos: [repo] })!.rows.find(one => one.key === "up-to-date")!;
        expect(row).toMatchObject({ mark: "no", act: { kind: "fix" } });
        expect(row.say).toContain("Send it back");
      } finally { store.close(); }
    }

    const b = await headOf("t-b");
    const revision = await sendBack("t-b", later(5));
    await tick(later(6));
    const built = await headOf(revision);
    expect(built.outcome, JSON.stringify(built)).toBe("built");
    // Its attempt started from a merge of the earlier work and the current main, made by Toolroll as Toolroll.
    expect(await git(["rev-list", "--parents", "-n", "1", built.baseRevision!])).toBe(`${built.baseRevision} ${b.headRevision} ${mainAfterA}`);
    expect(await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", built.baseRevision!])).toBe("Toolroll <update@toolroll.invalid>|Toolroll <update@toolroll.invalid>");
    expect(sawOther[revision]).toBe(true);
    {
      const store = openStore(db);
      try {
        const ref = store.lookupRef(revision)!.id;
        expect(familyStartOf(store, ref)).toBe(mainAfterA);
        expect(taskBaseOf(store, revision)?.words).toContain("Up to date with main");
        expect(store.actionLedger({ repos: null }).filter(one => one.action === CATCH_UP_ACTION).map(one => [one.taskId, one.outcome])).toEqual([[revision, "merged"]]);
      } finally { store.close(); }
    }

    await complete(revision, later(7));
    expect(await land(revision, later(8))).toBeNull();
    // One commit on main's commit, carrying both tasks' work.
    expect(await git(["rev-parse", "main^"])).toBe(mainAfterA);
    expect(await git(["show", "main:a.txt"])).toBe("t-a was here");
    expect(await git(["show", "main:b.txt"])).toBe(`${revision} was here`);
  });

  test("a merge that conflicts makes nothing: the revision starts from the earlier work, and Land says how to bring them together", async () => {
    await file("t-b");
    await tick(T0);
    await complete("t-b", later(1));
    // Someone else changed the same file on main meanwhile.
    writeFileSync(join(repo, "b.txt"), "main's own b\n");
    await git(["add", "b.txt"]);
    await git(["commit", "-qm", "main's b"]);
    const mainNow = await git(["rev-parse", "main"]);
    expect(await land("t-b", later(2))).toContain("Send it back");

    const b = await headOf("t-b");
    const revision = await sendBack("t-b", later(3));
    await tick(later(4));
    const built = await headOf(revision);
    expect(built.outcome).toBe("built");
    expect(built.baseRevision).toBe(b.headRevision);
    await complete(revision, later(5));
    const refused = await land(revision, later(6));
    expect(refused).toContain("conflict with this work in b.txt");
    expect(refused).toContain("Toolroll can't merge them by itself");
    expect(refused).not.toContain("Send it back");
    const store = openStore(db);
    try {
      expect(store.actionLedger({ repos: null }).filter(one => one.action === CATCH_UP_ACTION).map(one => one.outcome)).toEqual(["conflict"]);
      const row = mergeChecklistOf(store, revision, later(6), { principal: "operator", repos: [repo] })!.rows.find(one => one.key === "up-to-date")!;
      expect(row).toMatchObject({ mark: "no", act: null });
      expect(row.say).toContain("conflict with it in b.txt");
      // Nothing moved main.
      expect((await exec("git", ["rev-parse", "main"], { cwd: repo })).stdout.trim()).toBe(mainNow);
    } finally { store.close(); }
  });
});
