/**
 * Runs the worker (src/index.ts, bundled the way wrangler bundles it) under Miniflare on a real local port, with the
 * Durable Object on SQLite and the rate-limit bindings from wrangler.jsonc. Nothing here talks to Cloudflare.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { unstable_readConfig } from "wrangler";
import type { RelayTarget, RelayTargetOptions } from "../../conformance/client.js";

const root = fileURLToPath(new URL("..", import.meta.url));

let bundled: Promise<{ dir: string; script: string }> | null = null;

function bundle(): Promise<{ dir: string; script: string }> {
  bundled ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-relay-worker-"));
    const script = join(dir, "index.js");
    await build({ entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", target: "es2022", platform: "neutral", external: ["cloudflare:*"], outfile: script, logLevel: "silent" });
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return { dir, script };
  })();
  return bundled;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A secret long enough for the worker's 32-character minimum (tests only). */
export const TEST_CHALLENGE_SECRET = "conformance-challenge-secret-0123456789";

export interface WorkerOptions extends RelayTargetOptions {
  bindings?: Record<string, string>;
}

export interface RunningWorker extends RelayTarget {
  mf: Miniflare;
  /** The worker's name in wrangler.jsonc (Miniflare's script name). */
  scriptName: string;
  /** Every line the worker logged. */
  logs: string[];
}

export async function startWorker(opts: WorkerOptions = {}): Promise<RunningWorker> {
  const config = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
  const { script } = await bundle();
  const port = await freePort();
  const publicHost = `127.0.0.1:${port}`;
  const sqlite = new Set(config.migrations.flatMap(m => m.new_sqlite_classes ?? []));
  const limits: Record<string, number | undefined> = { RL_REGISTER: opts.registerPerMin, RL_CONNECT: opts.connectPerMin };
  const timing = {
    phoneFirstFrameMs: opts.timing?.phoneFirstFrameMs ?? 10_000,
    phoneIdleMs: opts.timing?.phoneIdleMs ?? 90_000,
    daemonSilenceMs: opts.timing?.daemonSilenceMs ?? 60_000,
  };
  const logs: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1",
    port,
    log: new Log(LogLevel.WARN),
    handleStructuredLogs: entry => { logs.push(entry.message); },
    // Tests read the room's SQLite tables (unsafeGetDurableObjectStorage).
    unsafeInspectDurableObjects: true,
    workers: [{
      name: config.name,
      modules: true,
      scriptPath: script,
      modulesRoot: dirname(script),
      compatibilityDate: config.compatibility_date!,
      compatibilityFlags: config.compatibility_flags,
      durableObjects: Object.fromEntries(config.durable_objects.bindings.map(b => [b.name, { className: b.class_name, useSQLite: sqlite.has(b.class_name) }])),
      ratelimits: Object.fromEntries(config.ratelimits.map(r => [r.name, { namespace_id: r.namespace_id, simple: { limit: limits[r.name] ?? r.simple.limit, period: r.simple.period } }])),
      bindings: {
        RELAY_PUBLIC_HOST: publicHost,
        CHALLENGE_SECRET: TEST_CHALLENGE_SECRET,
        BUILD_ID: "test",
        RELAY_PHONE_FIRST_FRAME_MS: String(timing.phoneFirstFrameMs),
        RELAY_PHONE_IDLE_MS: String(timing.phoneIdleMs),
        RELAY_DAEMON_SILENCE_MS: String(timing.daemonSilenceMs),
        ...opts.bindings,
      },
    }],
  }));
  const url = (await mf.ready).toString().replace(/\/$/, "");
  return {
    name: "cloudflare",
    silentSocketMissesClose: true,
    url,
    wsUrl: `${url.replace(/^http/, "ws")}/v1/connect`,
    publicHost,
    timing,
    mf,
    scriptName: config.name,
    logs,
    replayRows: async machineId => {
      const storage = await mf.unsafeGetDurableObjectStorage(config.name, "MachineRoomDO", { name: machineId });
      const rows = await storage.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jti");
      return rows[0]?.n ?? 0;
    },
    close: () => mf.dispose(),
  };
}
