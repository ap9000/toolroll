/**
 * Easy-start C3: the terminal UI runs CLI commands as the local owner (runAsLocalOwner), bound to local mode when the
 * database opens. Every declared command not marked for the local owner (surface.ts LOCAL_POLICY) is refused before
 * any of its code runs; credentials on the command line are refused; local mode off refuses everything; an allowed act
 * runs as the local owner, approving eligible work with no password and no prompt.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate } from "../../src/operate.js";
import { runAsLocalOwner } from "../../src/local-owner.js";
import { COMMAND_GUIDE, LOCAL_POLICY } from "../../src/surface.js";
import { initLocalMode, openStore, setLocalModeOff } from "../../src/store.js";
import { propose } from "../../src/scope.js";

const now = new Date("2026-11-03T12:00:00Z");
let root: string, file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-local-cli-")));
  file = join(root, "state.db");
  const store = openStore(file, { createdBy: "laptop" });
  try {
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now }).ok) throw Error("local mode");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const made = store.createConsoleTask({ id: "one", title: "task one", repo: root, goal: "do one", acceptance: [{ id: "c1", statement: "one is done.", evidence: ["manual-review"] }], filedVia: "cli" }, now);
    if (!made.ok) throw Error(made.reason);
  } finally { store.close(); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** One command as the terminal UI runs it: its envelope and exit code. */
async function asOwner(invocation: string, extra: string[] = []): Promise<{ code: number; envelope: Record<string, unknown> }> {
  const [command = "", ...words] = invocation.split(" ");
  let out = "";
  const code = await runAsLocalOwner(() => runOperate(command, [...words, ...extra, "--json", "--db", file], text => { out += text; }, { now }));
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}

describe("CLI commands as the local owner", () => {
  test("every command is decided; each one not marked for the local owner is refused before it runs", async () => {
    const rows = COMMAND_GUIDE.filter(row => row.invocation !== "");
    expect([...LOCAL_POLICY.keys()].sort()).toEqual(COMMAND_GUIDE.map(row => row.invocation).sort());
    const wrong: string[] = [];
    for (const row of rows.filter(one => LOCAL_POLICY.get(one.invocation)?.local === "deny")) {
      const { code, envelope } = await asOwner(row.invocation);
      if (code === 0 || envelope["reason"] !== "refused" || !/^Set a password/.test(String(envelope["message"]))) wrong.push(`${row.invocation}: ${code} ${JSON.stringify(envelope).slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  test("the allowed set is exactly this, each with its act: a new row for the local owner is a reviewed change here", () => {
    const allowed = Object.fromEntries([...LOCAL_POLICY].flatMap(([invocation, mark]) => mark.local === "allow" ? [[invocation, mark.act]] : []));
    expect(allowed).toEqual({
      pulls: "read", graph: "read", repos: "read", map: "read", "map area": "read", "map file": "read", "map search": "read", status: "read", ready: "read", gaps: "read",
      contract: "read", "skills list": "read", "skills get": "read", "flaky list": "read", "flaky show": "read", card: "read", "memory review": "read", "memory status": "read",
      "memory decisions": "read", "memory show": "read", "memory apply": "memory-review", "memory tidy": "memory-review", "memory restore": "memory-review",
      "memory unmerge": "memory-review", "task list": "read", "task show": "read", "task state": "read", "task wait": "read", "check-progress": "read", "review show": "read",
      welcome: "read", "task add": "file-task", "task new": "build-now", chat: "lead-send", "task steer": "lead-send", "task approve": "approve-plan", decide: "answer-question",
      "task stop": "stop-run", "task pause": "pause-run", "task hold": "pause-run", "task resume": "resume-run", "task continue": "resume-run", "task unhold": "resume-run",
      // Slice 1: the terminal's Accept is this row's own road (task-outcome-cli.ts runLocalCompletion), never the password road.
      "task complete": "complete-task", "task revise": "request-revision",
      // Slice 2: asking for a plan is its own road (operate.ts localPlanCommand): no password, no pins, no pre-authorization.
      "task plan": "request-plan",
      // Slice 3: retrying its own approved build is its own road too (operate.ts localRetryCommand).
      "task requeue": "retry-build", "task archive": "archive-task", "task restore": "archive-task", "repos add": "add-project",
      "models suggestions": "read", "models turn-off": "routing-turn-off", "models dismiss": "dismiss-suggestion", "models stop": "trial-stop",
      "map on": "code-map-switch", "map off": "code-map-switch",
    });
    // Not the local owner's: Accept's other spelling, merging, and re-running a check.
    for (const invocation of ["task accept", "task merge", "task regate"]) expect(LOCAL_POLICY.get(invocation), invocation).toEqual({ local: "deny" });
  });

  test("an unknown or undeclared command is refused too", async () => {
    expect((await asOwner("not-a-command")).envelope).toMatchObject({ ok: false, reason: "refused" });
    expect((await asOwner("tokens create")).envelope).toMatchObject({ ok: false, reason: "refused" });
  });

  test("credentials named on the command line are refused: the local owner's authority is its own", async () => {
    for (const flags of [["--token", "so_x"], ["--as", "alex"], ["--token-file", join(root, "t")], ["--token-env", "X"]]) {
      expect((await asOwner("task list", flags)).envelope, flags[0]).toMatchObject({ ok: false, reason: "refused" });
      // The terminal's Accept too: its road never takes a credential, so naming one refuses before any of it runs.
      expect((await asOwner("task complete one", ["--run", "1", "--digest", "a".repeat(64), "--checked", ...flags])).envelope, `complete ${flags[0]}`).toMatchObject({ ok: false, reason: "refused" });
      expect((await asOwner("task plan one", ["--digest", "a".repeat(64), ...flags])).envelope, `plan ${flags[0]}`).toMatchObject({ ok: false, reason: "refused" });
      expect((await asOwner("task requeue one", ["--run", "1", "--digest", "a".repeat(32), ...flags])).envelope, `requeue ${flags[0]}`).toMatchObject({ ok: false, reason: "refused" });
    }
    // Adding a project is the local owner's; naming its trusted remote (whose main may complete landed work) is not.
    expect((await asOwner("repos add", [root, "--remote", "https://github.com/someone/else.git"])).envelope).toMatchObject({ ok: false, reason: "refused" });
  });

  test("allowed: a read, and approving eligible work with no password and no prompt (recorded from the terminal)", async () => {
    expect((await asOwner("task list")).code).toBe(0);
    const store = openStore(file);
    let digest: string;
    try {
      digest = propose(store, { now, taskId: "one", goal: "Make the footer link work." }).digest;
    } finally { store.close(); }
    // The terminal UI's yes: the exact digest it showed, and no --as or --token (the local owner's authority is its own).
    const approved = await asOwner("task approve one", ["--yes", "--digest", digest]);
    expect(approved.envelope, JSON.stringify(approved.envelope)).toMatchObject({ ok: true });
    const check = openStore(file);
    try {
      const proof = check.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = 'one' AND action = 'approval proved'").get()!;
      expect(proof["outcome"]).toBe("local-owner");
      expect(String(proof["detail"])).toContain(" · local 1 terminal · ");
    } finally { check.close(); }
  });

  test("local mode off: every command is refused, reads included", async () => {
    const store = openStore(file);
    try { expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true }); } finally { store.close(); }
    expect((await asOwner("task list")).envelope).toMatchObject({ ok: false, reason: "refused", message: "Local mode is off. Sign in with your password in the browser." });
  });

  test("outside the terminal UI's door nothing changes: the same command runs as before", async () => {
    let out = "";
    const code = await runOperate("task", ["list", "--json", "--db", file], text => { out += text; }, { now });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });
});
