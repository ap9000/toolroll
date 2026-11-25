/**
 * Attack: from a Codex build launched the way production launches it (invoke.ts invokeAgent → runFence → fenceFor,
 * under fence policy 1 and the current policy 2), read the operator's own Codex sessions, history or sign-in, or
 * write that sign-in. Guard: every launch is denied the operator's Codex home by name under every policy
 * (agent-fence.ts operatorCodexHomes); the build reads and writes only its own private CODEX_HOME. On a Mac the probe
 * runs in exactly the fence and grants invokeAgent handed its runner, through the real sandbox; elsewhere (Codex in its
 * own permission profile) the launch's own argv must deny the folder, and the probe runs under exactly that profile
 * through `codex sandbox` where Codex is installed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { macosFenceAvailable, sandboxedSpawn, type FenceGrants, type LaunchSandbox } from "../../src/agent-fence.js";
import { acquire } from "../../src/claim.js";
import { invokeAgent } from "../../src/invoke.js";
import { register } from "../../src/runner.js";
import { openStore, type Store } from "../../src/store.js";
import { boundCheckout } from "../bound-checkout.js";
import { codexSandbox, needs, osFence } from "./harness.js";

const T0 = new Date("2026-11-25T12:00:00.000Z");
// Whether the real Codex can sandbox here, asked before any test puts its stand-in `codex` (which runs a command bare)
// on PATH: the probe below runs the real one by its own path, never the stand-in.
const realCodex = codexSandbox().available ? spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim() : "";

describe("attack: a production-fenced Codex build reaching the operator's Codex home", () => {
  let dir: string, home: string, worktree: string, store: Store, savedPath: string | undefined;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-home-prod-")));
    home = join(dir, "home");
    worktree = join(dir, "standing-orders", "worktrees", "app", "task");
    mkdirSync(join(home, ".codex", "sessions", "2026"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), '{"operator":"sign-in"}');
    writeFileSync(join(home, ".codex", "history.jsonl"), "operator history\n");
    writeFileSync(join(home, ".codex", "sessions", "2026", "rollout-operator.jsonl"), "operator session\n");
    store = openStore(join(dir, "standing-orders", "orders.db"));
    boundCheckout(store, join(dir, "app"), worktree);
    // The launch's fence self-check runs `codex sandbox -- git ...` first: a stand-in runs the command as given.
    savedPath = process.env["PATH"];
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n');
    chmodSync(join(bin, "codex"), 0o755);
    process.env["PATH"] = `${bin}${delimiter}${savedPath ?? ""}`;
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [dir], now: T0, newToken: () => "tok" });
  });
  afterEach(() => {
    store.close();
    if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test.for([1, 2] as const)("fence policy %i: the operator's sessions, history and sign-in are refused; its own home is its own", async (policy, ctx) => {
    needs(ctx, osFence());
    store.createTask({ id: `t-${policy}`, title: "codex" }, T0);
    const ref = store.refFor("built-in", `t-${policy}`).id;
    store.placeTask(ref, dir);
    const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => `lease-${policy}`, ttlMs: 10 * 365 * 24 * 3600 * 1000 });
    if (!took.ok) throw new Error("claim");
    const id = store.startRun({ taskRef: ref, leaseId: `lease-${policy}`, runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "codex", model: null, chosen: "legacy" }, now: T0 });
    const sandbox: LaunchSandbox = { policy, readDeny: [], machLookup: [] };
    const operator = join(home, ".codex");
    let probe: string[] | null = null;
    let road: "os-fence" | "codex-profile" | null = null;
    const runner = async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined>; fence?: readonly string[]; fenceGrants?: FenceGrants; onSessionId?: (id: string) => void }) => {
      const own = options?.env?.["CODEX_HOME"] ?? "";
      const script = [
        `cat "${operator}/sessions/2026/rollout-operator.jsonl" 2>/dev/null || echo operator-session-refused`,
        `cat "${operator}/history.jsonl" 2>/dev/null || echo operator-history-refused`,
        `cat "${operator}/auth.json" 2>/dev/null || echo operator-sign-in-read-refused`,
        `printf x >> "${operator}/auth.json" 2>/dev/null || echo operator-sign-in-write-refused`,
        `touch "${operator}/sessions/2026/planted.jsonl" 2>/dev/null || echo operator-session-write-refused`,
        `cat "${own}/auth.json" 2>/dev/null && echo || echo own-sign-in-read-refused`,
        `touch "${own}/sessions/rollout-mine.jsonl" 2>/dev/null && echo own-session-written || echo own-session-write-refused`,
      ].join("\n");
      if ((options?.fence?.length ?? 0) > 0) {
        // On a Mac Codex runs whole inside the OS fence: the probe runs in exactly the fence and grants handed over.
        road = "os-fence";
        const launch = sandboxedSpawn("/bin/sh", ["-c", script], options!.fence!, options!.fenceGrants!, worktree);
        probe = spawnSync(launch.file, launch.args, { cwd: worktree, env: { ...process.env, ...launch.env }, encoding: "utf8", timeout: 60_000 }).stdout.trim().split("\n");
      } else {
        // Elsewhere Codex's harness runs outside, its commands in Codex's own permission profile, which the launch's own
        // argv carries: it must deny the operator's Codex home, and the probe runs under exactly those settings.
        road = "codex-profile";
        const table = args.find(one => one.startsWith("permissions.standing-orders.filesystem=")) ?? "";
        expect(table).toContain(`"${realpathSync(operator)}"="deny"`);
        const profile = args.flatMap((one, at) => args[at - 1] === "-c" && (one.startsWith("default_permissions=") || one.startsWith("permissions.")) ? ["-c", one] : []);
        if (realCodex !== "") {
          probe = spawnSync(realCodex, ["sandbox", ...profile, "-P", "standing-orders", "--", "/bin/sh", "-c", script],
            { cwd: worktree, env: { ...process.env, CODEX_HOME: own }, encoding: "utf8", timeout: 60_000 }).stdout.trim().split("\n");
        }
      }
      options?.onSessionId?.("thread-1");
      return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n` };
    };
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, { phase: "build", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null },
      { keyHome: home, clock: () => T0, cwd: worktree, sandbox, runner: runner as never });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: expect.not.stringMatching(/^refused$/) });
    expect(road).toBe(macosFenceAvailable() ? "os-fence" : "codex-profile");
    const operatorRefused = ["operator-session-refused", "operator-history-refused", "operator-sign-in-read-refused", "operator-sign-in-write-refused", "operator-session-write-refused"];
    if (road === "os-fence") expect(probe).toEqual([...operatorRefused, '{"operator":"sign-in"}', "own-session-written"]);
    // Codex's own profile also denies its commands the run's private home (only the harness, outside, reads it).
    else if (probe !== null) expect(probe).toEqual([...operatorRefused, "own-sign-in-read-refused", "own-session-write-refused"]);
    expect(readFileSync(join(operator, "auth.json"), "utf8")).toBe('{"operator":"sign-in"}');
  });
});
