/**
 * The deploy check's console (docs/plans/release-from-main.md, part C): `serve --rehearsal` on a copy of someone's
 * database answers pages and starts nothing else — however much in that copy is due or waiting (a backup due, webhooks
 * and a Telegram bot set up, a phone notification and a lead delivery pending). Every loop that acts on the world is
 * watched at the module that starts it, and the network at fetch.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { started, watch } = vi.hoisted(() => {
  const started: string[] = [];
  return { started, watch: (name: string) => (..._args: unknown[]) => { started.push(name); return () => {}; } };
});
vi.mock("./monitoring.js", async real => ({ ...await real<typeof import("./monitoring.js")>(), startMonitoring: watch("monitoring") }));
vi.mock("./budget-alerts.js", async real => ({ ...await real<typeof import("./budget-alerts.js")>(), startBudgetAlerts: watch("budget alerts") }));
vi.mock("./token-notices.js", async real => ({ ...await real<typeof import("./token-notices.js")>(), startTokenNotices: watch("token notices") }));
vi.mock("./provider-auth.js", async real => ({ ...await real<typeof import("./provider-auth.js")>(), startSignInProbes: watch("sign-in probes") }));
vi.mock("./backup.js", async real => ({ ...await real<typeof import("./backup.js")>(), startBackups: watch("backups") }));
vi.mock("./codex-limits.js", async real => ({ ...await real<typeof import("./codex-limits.js")>(), startCodexLimits: watch("codex limits") }));
vi.mock("./releases.js", async real => ({ ...await real<typeof import("./releases.js")>(), startUpdateChecks: watch("update checks") }));
vi.mock("./git-incident.js", async real => ({ ...await real<typeof import("./git-incident.js")>(), noticeGitIncidents: () => { started.push("git incidents"); } }));
vi.mock("./maintenance.js", async real => {
  const original = await real<typeof import("./maintenance.js")>();
  return { ...original, startMaintenance: (...args: Parameters<typeof original.startMaintenance>) => { started.push("maintenance"); return original.startMaintenance(...args); } };
});
vi.mock("./team-runtime.js", async real => {
  const original = await real<typeof import("./team-runtime.js")>();
  return { ...original, createTeamRuntime: (...args: Parameters<typeof original.createTeamRuntime>) => { const team = original.createTeamRuntime(...args); return { ...team, start: () => { started.push("team"); } }; } };
});
vi.mock("./lead-queue-runtime.js", async real => {
  const original = await real<typeof import("./lead-queue-runtime.js")>();
  return { ...original, createPersonalQueueRuntime: (...args: Parameters<typeof original.createPersonalQueueRuntime>) => { const queue = original.createPersonalQueueRuntime(...args); return { ...queue, start: () => { started.push("personal queue"); } }; } };
});

import { spawn, type ChildProcess } from "node:child_process";
import { startConsole } from "./operate.js";
import { openStore, type Store } from "./store.js";
import { DirectChatHost } from "./direct-chat.js";
import { defaultCustodyIO } from "./flexible-launch.js";
import { inRehearsal } from "./rehearsal.js";

const outbound: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); started.length = 0; outbound.length = 0; });

/** A copy of someone's database with everything that would act on the world due or waiting. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "so-rehearsal-"));
  const databaseFile = join(dir, "orders.db");
  const store = openStore(databaseFile);
  const now = new Date("2026-11-25T09:00:00.000Z");
  // Backups on and never run: due at once. Webhooks and a Telegram bot set up beside the database.
  store.setBackupSettings({ enabled: true, everyHours: 1, keep: 3, folder: null }, "alex", now);
  writeFileSync(join(dir, "slack-webhook"), "https://hooks.slack.com/services/T000/B000/xxxx\n", { mode: 0o600 });
  writeFileSync(join(dir, "discord-webhook"), "https://discord.com/api/webhooks/1/x\n", { mode: 0o600 });
  writeFileSync(join(dir, "telegram-token"), "123456:ABCDEF\n", { mode: 0o600 });
  // A notification waiting to go out (a phone push, a chat message).
  expect(store.enqueueNotification({ dedupeKey: "release:0.9.119", kind: "attempts-exhausted", pushClass: "attention", subject: "A release waits for you", body: "Release 0.9.119" }, now)).toBe(true);
  const context = { store, write: () => {}, json: true, now, clock: () => now, evidenceRoot: join(dir, "evidence"), databaseFile, telegramTokenFile: join(dir, "telegram-token") };
  return { dir, store, context };
}

describe("serve --rehearsal: the deploy check's console", () => {
  test("answers /healthz and starts nothing that acts on the world, with everything due or waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => { outbound.push(String(input)); throw new Error("no network in a rehearsal"); }));
    const { dir, store, context } = world();
    const { server, port } = await startConsole({ context: context as never, host: "127.0.0.1", port: 0, poolRoot: join(dir, "worktrees"), rehearsal: true });
    try {
      const health = await new Promise<number>((resolve, reject) => {
        import("node:http").then(http => http.get(`http://127.0.0.1:${port}/healthz`, response => { response.resume(); resolve(response.statusCode ?? 0); }).on("error", reject), reject);
      });
      expect(health).toBe(200);
      expect(started).toEqual([]);
      expect(outbound).toEqual([]);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
      store.close();
    }
  });

  test("the same database without --rehearsal starts them (so the test above sees them when they start)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => { outbound.push(String(input)); throw new Error("no network in a test"); }));
    const { dir, store, context } = world();
    const { server } = await startConsole({ context: context as never, host: "127.0.0.1", port: 0, poolRoot: join(dir, "worktrees") });
    try {
      await new Promise<void>(done => server.listening ? done() : server.once("listening", () => done()));
      for (const one of ["monitoring", "budget alerts", "token notices", "sign-in probes", "backups", "codex limits", "update checks", "git incidents", "team", "personal queue", "maintenance"]) expect(started).toContain(one);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
      store.close();
    }
  });
});

/** A real process of this test's own, standing in for an agent the real computer runs (a copy records its pid). */
async function liveProcess(): Promise<{ child: ChildProcess; pid: number; start: string }> {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('up\\n'); setInterval(() => {}, 1 << 30);"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(done => child.stdout!.once("data", () => done()));
  const start = defaultCustodyIO().table()?.find(row => row.pid === child.pid)?.start ?? null;
  if (start === null || child.pid === undefined) throw new Error("no start identity for the stand-in process");
  return { child, pid: child.pid, start };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A running Direct Chat turn of `pid` whose Stop was asked an hour ago: a reconciler's SIGKILL is due. */
function runningTurn(store: Store, dir: string, pid: number, start: string): void {
  const at = "2026-11-25T08:00:00.000Z";
  store.handle.prepare(`INSERT INTO direct_chat_thread (id, owner, account_generation, title, repo, clone_path, branch, base_sha, provider, model_id, created_at, updated_at)
    VALUES ('th-1', 'alex', 1, 'A chat', ?, ?, 'main', ?, 'claude', 'sonnet', ?, ?)`).run(dir, join(dir, "clone"), "a".repeat(40), at, at);
  store.handle.prepare(`INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, pid, start_identity, pgid, boot_id, status, stop_requested_at, created_at)
    VALUES ('turn-1', 'th-1', 1, 'hi', ?, ?, ?, ?, ?, NULL, 'running', ?, ?)`).run(join(dir, "turn.log"), join(dir, "turn.err"), pid, start, pid, at, at);
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("a rehearsal never signals a process its copy records", () => {
  test("a running Direct Chat turn past its Stop and a thread's process stay alive through a rehearsal; outside one, the reconciler kills", async () => {
    const turn = await liveProcess(), thread = await liveProcess(), control = await liveProcess();
    try {
      // Outside a rehearsal (the control): the reconciler SIGKILLs the turn's recorded process.
      {
        const { dir, store } = world();
        runningTurn(store, dir, control.pid, control.start);
        new DirectChatHost(store, { stateRoot: dir, now: () => new Date("2026-11-25T09:00:00.000Z") }).reconcileRunningTurns();
        await new Promise<void>(done => control.child.exitCode !== null || control.child.signalCode !== null ? done() : control.child.once("exit", () => done()));
        expect(control.child.signalCode).toBe("SIGKILL");
        store.close();
      }
      const { dir, store, context } = world();
      runningTurn(store, dir, turn.pid, turn.start);
      const { server } = await startConsole({ context: context as never, host: "127.0.0.1", port: 0, poolRoot: join(dir, "worktrees"), rehearsal: true });
      try {
        expect(inRehearsal()).toBe(true);
        // What a poller or a thread's stop would do, were one running: every road refuses.
        new DirectChatHost(store, { stateRoot: dir, now: () => new Date("2026-11-25T09:00:00.000Z") }).reconcileRunningTurns();
        expect([...defaultCustodyIO().signal([{ pid: thread.pid, start: thread.start }], "SIGKILL").values()]).toEqual(["denied"]);
        expect(() => process.kill(thread.pid, "SIGKILL")).toThrow(/never signals a process/);
        expect(() => process.kill(-turn.pid, "SIGTERM")).toThrow(/never signals a process/);
        expect(alive(turn.pid)).toBe(true);
        expect(alive(thread.pid)).toBe(true);
      } finally {
        await new Promise<void>(done => server.close(() => done()));
        store.close();
      }
      expect(inRehearsal()).toBe(false);
      expect(alive(turn.pid) && alive(thread.pid)).toBe(true);
    } finally {
      for (const one of [turn, thread, control]) one.child.kill("SIGKILL");
    }
  });
});
