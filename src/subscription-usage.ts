import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveExecutable } from "./attest.js";
import { codingEnvironment } from "./coding-provider.js";
import { readCodexLimits } from "./codex-limits.js";
import { claudeLimitsOf, type LimitReading } from "./provider-limits.js";
import { billingOf } from "./spend.js";
import type { Store } from "./store.js";

export type GeminiSubscriptionStatus = {
  connected: boolean;
  provider: "antigravity";
  topModel: string | null;
  modelCount: number;
  observedAt: string;
  note: string | null;
};

export type SubscriptionRefreshResult = {
  claude: LimitReading | null;
  codex: LimitReading | null;
  gemini: GeminiSubscriptionStatus;
  refreshedAt: string;
};

const CLAUDE_STALE_MS = 30 * 60_000;
const GEMINI_STALE_MS = 15 * 60_000;

export function subscriptionStatusPath(databaseFile: string): string {
  return join(dirname(databaseFile), ".toolroll-run", "subscription-status.json");
}

export function readStoredGeminiStatus(databaseFile: string): GeminiSubscriptionStatus | null {
  const path = subscriptionStatusPath(databaseFile);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { gemini?: GeminiSubscriptionStatus };
    if (!parsed || typeof parsed !== "object" || !parsed.gemini) return null;
    return parsed.gemini;
  } catch {
    return null;
  }
}

export function writeStoredGeminiStatus(databaseFile: string, gemini: GeminiSubscriptionStatus): void {
  const path = subscriptionStatusPath(databaseFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, gemini }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readClaudeLimits(options: { command?: string; timeoutMs?: number } = {}): Promise<LimitReading | null> {
  return new Promise(resolve => {
    const bin = options.command ?? resolveExecutable("claude");
    if (!bin) {
      resolve(null);
      return;
    }
    const env = codingEnvironment();
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
      delete env[key];
    }
    let settled = false;
    let buffered = "";
    let found: LimitReading | null = null;
    let child;
    try {
      child = spawn(
        bin,
        ["-p", ".", "--model", "haiku", "--max-turns", "1", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
        { cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }
    const finish = (reading: LimitReading | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
      resolve(reading);
    };
    const timer = setTimeout(() => finish(found), options.timeoutMs ?? 15_000);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(found));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        try {
          const reading = claudeLimitsOf(JSON.parse(line));
          if (reading !== null) {
            found = reading;
            finish(reading);
            return;
          }
        } catch {}
      }
    });
  });
}

export function readGeminiSubscription(options: { command?: string; timeoutMs?: number; now?: Date } = {}): Promise<GeminiSubscriptionStatus> {
  const nowIso = (options.now ?? new Date()).toISOString();
  return new Promise(resolve => {
    const bin = options.command ?? resolveExecutable("agy");
    if (!bin) {
      resolve({
        connected: false,
        provider: "antigravity",
        topModel: null,
        modelCount: 0,
        observedAt: nowIso,
        note: "Install Antigravity CLI (agy)",
      });
      return;
    }
    const env = codingEnvironment();
    let child;
    try {
      child = spawn(bin, ["models"], { cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ connected: false, provider: "antigravity", topModel: null, modelCount: 0, observedAt: nowIso, note: "Could not start agy" });
      return;
    }
    let settled = false;
    let out = "";
    let err = "";
    const finish = (status: GeminiSubscriptionStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
      resolve(status);
    };
    const timer = setTimeout(() => finish({
      connected: false,
      provider: "antigravity",
      topModel: null,
      modelCount: 0,
      observedAt: nowIso,
      note: "Timed out checking Antigravity",
    }), options.timeoutMs ?? 12_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { out += chunk; });
    child.stderr?.on("data", chunk => { err += chunk; });
    child.once("error", () => finish({
      connected: false,
      provider: "antigravity",
      topModel: null,
      modelCount: 0,
      observedAt: nowIso,
      note: "Could not run agy",
    }));
    child.once("close", code => {
      const cleaned = out.replace(/\r/g, "\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      const modelLines = cleaned.split("\n").map(l => l.trim()).filter(l => /^gemini-/i.test(l));
      const hasNeon = modelLines.some(l => /gemini-4-neon/i.test(l));
      const topModel = hasNeon ? "Gemini 4 Neon" : (modelLines[0]?.split(/\s{2,}/)[1] ?? modelLines[0]?.split(/\s+/)[0] ?? null);
      if (code === 0 && modelLines.length > 0) {
        finish({
          connected: true,
          provider: "antigravity",
          topModel,
          modelCount: modelLines.length,
          observedAt: nowIso,
          note: null,
        });
      } else {
        const msg = err.trim().split("\n").pop()?.slice(0, 120) || "Sign in with `agy acp --login`";
        finish({
          connected: false,
          provider: "antigravity",
          topModel: null,
          modelCount: 0,
          observedAt: nowIso,
          note: msg,
        });
      }
    });
  });
}

function claudeNeedsRefresh(store: Store, now: Date): boolean {
  if (billingOf("claude") !== "subscription") return false;
  const recent = new Date(now.getTime() - 6 * 3_600_000).toISOString();
  if (store.handle.prepare("SELECT 1 AS live FROM run WHERE provider = 'claude' AND outcome IS NULL AND started_at > ? LIMIT 1").get(recent) !== undefined) {
    return false;
  }
  const rows = store.providerLimits().filter(one => one.provider === "claude");
  if (rows.length === 0) return true;
  return rows.some(one => {
    const expired = one.resetsAt !== null && Date.parse(one.resetsAt) <= now.getTime();
    const stale = now.getTime() - Date.parse(one.observedAt) > CLAUDE_STALE_MS;
    return expired || stale;
  });
}

function geminiNeedsRefresh(databaseFile: string | null, now: Date): boolean {
  if (databaseFile === null) return false;
  const stored = readStoredGeminiStatus(databaseFile);
  if (stored === null) return true;
  return now.getTime() - Date.parse(stored.observedAt) > GEMINI_STALE_MS;
}

export async function refreshSubscriptions(
  store: Store,
  databaseFile: string | null,
  options: { forceClaude?: boolean; forceGemini?: boolean; skipCodex?: boolean; now?: Date } = {},
): Promise<SubscriptionRefreshResult> {
  const now = options.now ?? new Date();
  const shouldCodex = options.skipCodex !== true && billingOf("codex") === "subscription";
  const shouldClaude = options.forceClaude === true || claudeNeedsRefresh(store, now);
  const shouldGemini = options.forceGemini === true || geminiNeedsRefresh(databaseFile, now);

  const [codex, claude, gemini] = await Promise.all([
    shouldCodex ? readCodexLimits() : Promise.resolve(null),
    shouldClaude ? readClaudeLimits() : Promise.resolve(null),
    shouldGemini
      ? readGeminiSubscription({ now })
      : Promise.resolve(
          (databaseFile !== null ? readStoredGeminiStatus(databaseFile) : null) ?? {
            connected: false,
            provider: "antigravity" as const,
            topModel: null,
            modelCount: 0,
            observedAt: now.toISOString(),
            note: null,
          },
        ),
  ]);

  if (codex !== null) store.recordProviderLimits(codex, now);
  if (claude !== null) store.recordProviderLimits(claude, now);
  if (databaseFile !== null && shouldGemini) writeStoredGeminiStatus(databaseFile, gemini);

  return { claude, codex, gemini, refreshedAt: now.toISOString() };
}
