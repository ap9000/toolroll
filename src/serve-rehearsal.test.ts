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

import { startConsole } from "./operate.js";
import { openStore } from "./store.js";

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
