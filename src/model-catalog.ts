/**
 * The live model and tool catalog. OpenRouter's public list (no key, nothing
 * about the person sent) names what Anthropic, OpenAI and Google currently
 * ship and what each costs; the Codex CLI's own cache names what this
 * account may run; `--version` and the npm registry say whether the
 * installed CLIs are current. Everything lands in orders.db so pickers,
 * spend pins and "new model" notices read one saved snapshot.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Store } from "./store.js";
import { fetchOpenRouterModels, type OpenRouterModel } from "./openrouter-models.js";
import { codexModelSchema, codexModelsCacheSchema, npmLatestSchema } from "./contracts/model-catalog.js";
import { readCappedBody } from "./converse.js";
import { validModelId, type ProviderId } from "./provider.js";
import { activeUpdateWork } from "./desktop-update-gate.js";

export const MODELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_seen (
  source        TEXT NOT NULL CHECK (source IN ('claude','codex','gemini','openrouter')),
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  input_usd     REAL,
  output_usd    REAL,
  context       INTEGER,
  tools         INTEGER NOT NULL DEFAULT 0,
  released_at   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (source, id)
);
CREATE TABLE IF NOT EXISTS runtime_check (
  tool           TEXT PRIMARY KEY CHECK (tool IN ('claude','codex','gemini')),
  installed      TEXT,
  latest         TEXT,
  update_command TEXT,
  problem        TEXT,
  checked_at     TEXT NOT NULL,
  updated_at     TEXT,
  updated_by     TEXT
);
CREATE TABLE IF NOT EXISTS model_watch (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  problem    TEXT,
  changed_by TEXT,
  changed_at TEXT
);`;

export type ModelSource = "claude" | "codex" | "gemini" | "openrouter";
export type SeenModel = {
  source: ModelSource; id: string; name: string; inputUsd: number | null; outputUsd: number | null;
  context: number | null; tools: boolean; releasedAt: string | null; firstSeenAt: string;
};
export type RuntimeTool = "claude" | "codex" | "gemini";
export type RuntimeState = {
  tool: RuntimeTool; name: string; installed: string | null; latest: string | null;
  updateCommand: string[] | null; problem: string | null; checkedAt: string; updatedAt: string | null; updatedBy: string | null;
  behind: boolean;
};
export type VersionRunner = (command: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;
export type CatalogSeams = { fetcher?: typeof fetch; runner?: VersionRunner; home?: string; path?: string };

export const RUNTIME_TOOLS: Record<RuntimeTool, { name: string; command: string; pkg: string }> = {
  claude: { name: "Claude Code", command: "claude", pkg: "@anthropic-ai/claude-code" },
  codex: { name: "Codex", command: "codex", pkg: "@openai/codex" },
  gemini: { name: "Gemini CLI", command: "gemini", pkg: "@google/gemini-cli" },
};
export const WATCH_EVERY_MS = 6 * 3_600_000;
/** A model counts as new for two weeks after its release. */
const NEW_FOR_MS = 14 * 86_400_000;
const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
const ALIAS_WORDS: Record<string, string> = { opus: "complex tasks", sonnet: "everyday coding", haiku: "smaller tasks" };

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const stripVendor = (name: string) => name.replace(/^(Anthropic|OpenAI|Google): /, "");

/** `anthropic/claude-opus-5.5` → `claude-opus-5-5`, the name the Claude CLI and API use. */
export function claudeIdOf(openrouterId: string): string | null {
  const hit = /^anthropic\/(claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9.]*)$/.exec(openrouterId);
  return hit === null ? null : hit[1]!.replaceAll(".", "-");
}
function geminiIdOf(openrouterId: string): string | null {
  const hit = /^google\/(gemini-[0-9][0-9a-z.-]*)$/.exec(openrouterId);
  return hit === null || /image|tts|audio|embed/.test(hit[1]!) ? null : hit[1]!;
}

/** The Codex CLI's own list — account-specific, maintained by the CLI. */
export function codexCatalog(home = homedir()): { id: string; name: string }[] {
  try {
    const path = join(home, ".codex", "models_cache.json");
    if (lstatSync(path).size >= 2_000_000) return [];
    const data = codexModelsCacheSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return (data.success ? data.data.models : []).flatMap(entry => {
      const one = codexModelSchema.safeParse(entry);
      return one.success ? [one.data] : [];
    }).slice(0, 30).map(one => ({ id: one.slug, name: typeof one.display_name === "string" ? one.display_name.slice(0, 80) : one.slug }));
  } catch { return []; }
}

type Row = Omit<SeenModel, "firstSeenAt">;
/** Pure: the catalog rows each source should hold after a fetch. */
export function catalogRows(openrouter: OpenRouterModel[], codex: { id: string; name: string }[]): Row[] {
  const released = (model: OpenRouterModel) => model.created === null ? null : new Date(model.created * 1000).toISOString();
  const base = (model: OpenRouterModel) => ({ inputUsd: model.input, outputUsd: model.output, context: model.context, tools: model.tools, releasedAt: released(model) });
  const rows: Row[] = [];
  const byId = new Map(openrouter.map(model => [model.id, model]));
  for (const model of openrouter) {
    if (model.id.includes(":")) continue;
    rows.push({ source: "openrouter", id: model.id, name: model.name, ...base(model) });
    const claude = claudeIdOf(model.id);
    if (claude !== null) rows.push({ source: "claude", id: claude, name: stripVendor(model.name), ...base(model) });
    const gemini = geminiIdOf(model.id);
    if (gemini !== null) rows.push({ source: "gemini", id: gemini, name: stripVendor(model.name), ...base(model) });
  }
  for (const one of codex) {
    const priced = byId.get(`openai/${one.id}`);
    rows.push({ source: "codex", id: one.id, name: one.name, ...(priced === undefined
      ? { inputUsd: null, outputUsd: null, context: null, tools: true, releasedAt: null } : base(priced)) });
  }
  return rows;
}

const readRow = (row: Record<string, unknown>): SeenModel => ({
  source: row["source"] as ModelSource, id: String(row["id"]), name: String(row["name"]),
  inputUsd: row["input_usd"] == null ? null : Number(row["input_usd"]), outputUsd: row["output_usd"] == null ? null : Number(row["output_usd"]),
  context: row["context"] == null ? null : Number(row["context"]), tools: Number(row["tools"]) === 1,
  releasedAt: row["released_at"] == null ? null : String(row["released_at"]), firstSeenAt: String(row["first_seen_at"]),
});

/** Upsert a fetch. Returns models first seen now, except on a source's first
 * fetch (the baseline would otherwise announce every model at once). */
export function recordCatalog(store: Store, rows: Row[], now: Date): SeenModel[] {
  const stamp = now.toISOString();
  return store.transact(() => {
    const had = new Set((store.handle.prepare("SELECT DISTINCT source FROM model_seen").all() as Record<string, unknown>[]).map(row => String(row["source"])));
    const added: SeenModel[] = [];
    const exists = store.handle.prepare("SELECT 1 AS hit FROM model_seen WHERE source = ? AND id = ?");
    const upsert = store.handle.prepare(
      `INSERT INTO model_seen (source, id, name, input_usd, output_usd, context, tools, released_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET name = excluded.name, input_usd = excluded.input_usd, output_usd = excluded.output_usd,
         context = excluded.context, tools = excluded.tools, released_at = COALESCE(excluded.released_at, model_seen.released_at), last_seen_at = excluded.last_seen_at`);
    for (const row of rows) {
      const fresh = exists.get(row.source, row.id) === undefined;
      upsert.run(row.source, row.id, row.name.slice(0, 150), row.inputUsd, row.outputUsd, row.context, row.tools ? 1 : 0, row.releasedAt, stamp, stamp);
      if (fresh && had.has(row.source)) added.push({ ...row, firstSeenAt: stamp });
    }
    // A model the source no longer lists stops being offered; its row stays
    // so a saved choice can still be named.
    return added;
  });
}

export function seenModels(store: Store, source: ModelSource, options: { current?: boolean } = {}): SeenModel[] {
  const latest = options.current === false ? null : store.handle.prepare("SELECT MAX(last_seen_at) AS at FROM model_seen WHERE source = ?").get(source) as Record<string, unknown> | undefined;
  return (store.handle.prepare(
    `SELECT * FROM model_seen WHERE source = ? AND (? IS NULL OR last_seen_at = ?) ORDER BY COALESCE(released_at, '') DESC, name`,
  ).all(source, latest?.["at"] ?? null, latest?.["at"] ?? null) as Record<string, unknown>[]).map(readRow);
}
export function seenModel(store: Store, source: ModelSource, id: string): SeenModel | null {
  const row = store.handle.prepare("SELECT * FROM model_seen WHERE source = ? AND id = ?").get(source, id) as Record<string, unknown> | undefined;
  return row === undefined ? null : readRow(row);
}
export function isNewModel(model: SeenModel, now: Date): boolean {
  return model.releasedAt !== null && now.getTime() - Date.parse(model.releasedAt) < NEW_FOR_MS;
}

/** What the Claude CLI's short name currently runs: the newest of its family. */
export function aliasTarget(store: Store, alias: string): SeenModel | null {
  if (!(FAMILIES as readonly string[]).includes(alias)) return null;
  return seenModels(store, "claude").find(model => model.id.startsWith(`claude-${alias}-`)) ?? null;
}

export function dollars(amount: number | null): string {
  if (amount === null) return "price not listed";
  if (amount === 0) return "free";
  return `$${Number(amount.toPrecision(3))}`;
}
export function priceWords(model: SeenModel): string {
  return model.inputUsd === null && model.outputUsd === null ? "price not listed" : `${dollars(model.inputUsd)} / ${dollars(model.outputUsd)} per 1M tokens`;
}
/** The friendly name for a saved provider + model, e.g. "opus" → "Claude Opus 5.5". */
export function modelWords(store: Store, provider: string, model: string | null): string {
  if (model === null || model === "" || model === "default") return "its default model";
  if (provider === "claude" || provider === "claude-subscription" || provider === "anthropic-api") {
    const alias = aliasTarget(store, model);
    if (alias !== null) return `${title(model)} (now ${alias.name})`;
    return seenModel(store, "claude", model)?.name ?? model;
  }
  const source: ModelSource | null = provider === "codex" || provider === "codex-subscription" ? "codex" : provider === "gemini" ? "gemini" : provider === "openrouter" || provider === "openrouter-api" ? "openrouter" : null;
  return source === null ? model : seenModel(store, source, model)?.name ?? model;
}

export type ModelOption = { value: string; label: string; isNew: boolean };
/** Every model a provider can run, newest first, with prices. */
export function modelOptions(store: Store, provider: ProviderId, now: Date, home = homedir()): ModelOption[] {
  const option = (model: SeenModel): ModelOption => ({ value: model.id, label: `${model.name} · ${priceWords(model)}${isNewModel(model, now) ? " · New" : ""}`, isNew: isNewModel(model, now) });
  if (provider === "claude") {
    const aliases = ["sonnet", "opus", "haiku"].map(alias => {
      const target = aliasTarget(store, alias);
      // Short enough that a phone's select still shows which model it means.
      return { value: alias, label: target === null ? `${title(alias)} — ${ALIAS_WORDS[alias]}` : `${title(alias)} · latest (${target.name.replace(/^Claude /, "")})`, isNew: false };
    });
    return [...aliases, ...seenModels(store, "claude").slice(0, 20).map(option)];
  }
  if (provider === "codex") {
    const live = codexCatalog(home);
    return live.map(one => {
      const seen = seenModel(store, "codex", one.id);
      return seen === null ? { value: one.id, label: one.name, isNew: false } : option({ ...seen, name: one.name });
    });
  }
  if (provider === "gemini") return seenModels(store, "gemini").slice(0, 20).map(option);
  return seenModels(store, "openrouter").filter(model => model.tools).sort((a, b) => a.name.localeCompare(b.name)).map(option);
}

/** Chat reserves worst-case spend: price per token in whole micro-dollars,
 * rounded UP from the live list price. null = no live price. */
export function livePin(store: Store, chatProvider: string, model: string): { inMicrousd: number; outMicrousd: number } | null {
  const seen = chatProvider === "anthropic-api" ? seenModel(store, "claude", model) : chatProvider === "openrouter-api" ? seenModel(store, "openrouter", model) : null;
  if (seen === null || seen.inputUsd === null || seen.outputUsd === null) return null;
  // USD per million tokens is micro-dollars per token.
  const pin = (usd: number) => usd === 0 ? 0 : Math.ceil(usd - 1e-9);
  return { inMicrousd: pin(seen.inputUsd), outMicrousd: pin(seen.outputUsd) };
}

// ---------------------------------------------------------------- runtimes

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
const versionIn = (text: string) => /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;

const defaultRunner: VersionRunner = (command, args, options) => new Promise(resolve => {
  execFile(command, args, { timeout: options.timeoutMs, maxBuffer: 1_000_000, ...(options.env === undefined ? {} : { env: options.env }) }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

function onPath(command: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* next */ }
  }
  return null;
}
/** How this copy was installed decides the one safe update command. */
export function updateCommandFor(tool: RuntimeTool, resolved: string): string[] | null {
  const pkg = RUNTIME_TOOLS[tool].pkg;
  if (tool === "claude" && /\/\.local\/share\/claude\/versions\//.test(resolved)) return ["claude", "update"];
  if (resolved.includes(`/node_modules/${pkg}/`)) return ["npm", "install", "-g", `${pkg}@latest`];
  return null;
}

async function latestVersion(pkg: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${pkg}/latest`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await readCappedBody(response, 2_000_000);
    if (body === null) return null;
    const latest = npmLatestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return latest.success ? latest.data.version : null;
  } catch { return null; }
}

function readRuntime(row: Record<string, unknown>): RuntimeState {
  const tool = row["tool"] as RuntimeTool;
  const installed = row["installed"] == null ? null : String(row["installed"]);
  const latest = row["latest"] == null ? null : String(row["latest"]);
  let command: string[] | null = null;
  try { command = row["update_command"] == null ? null : JSON.parse(String(row["update_command"])) as string[]; } catch { command = null; }
  return {
    tool, name: RUNTIME_TOOLS[tool].name, installed, latest, updateCommand: command,
    problem: row["problem"] == null ? null : String(row["problem"]), checkedAt: String(row["checked_at"]),
    updatedAt: row["updated_at"] == null ? null : String(row["updated_at"]), updatedBy: row["updated_by"] == null ? null : String(row["updated_by"]),
    behind: installed !== null && latest !== null && compareVersions(latest, installed) > 0,
  };
}
export function runtimeStates(store: Store): RuntimeState[] {
  return (store.handle.prepare("SELECT * FROM runtime_check WHERE installed IS NOT NULL ORDER BY CASE tool WHEN 'claude' THEN 0 WHEN 'codex' THEN 1 ELSE 2 END").all() as Record<string, unknown>[]).map(readRuntime);
}

export async function checkRuntimes(store: Store, now: Date, seams: CatalogSeams = {}): Promise<RuntimeState[]> {
  const runner = seams.runner ?? defaultRunner, fetcher = seams.fetcher ?? fetch, path = seams.path ?? process.env["PATH"] ?? "";
  for (const tool of Object.keys(RUNTIME_TOOLS) as RuntimeTool[]) {
    const spec = RUNTIME_TOOLS[tool];
    const resolved = onPath(spec.command, path);
    let installed: string | null = null, problem: string | null = null;
    if (resolved !== null) {
      const ran = await runner(spec.command, ["--version"], { timeoutMs: 15_000 });
      installed = ran.code === 0 ? versionIn(ran.stdout) : null;
      if (installed === null) problem = `${spec.name} did not report its version.`;
    }
    const latest = resolved === null ? null : await latestVersion(spec.pkg, fetcher);
    if (resolved !== null && latest === null && problem === null) problem = "The latest version could not be checked.";
    store.handle.prepare(
      `INSERT INTO runtime_check (tool, installed, latest, update_command, problem, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool) DO UPDATE SET installed = excluded.installed, latest = COALESCE(excluded.latest, runtime_check.latest),
         update_command = excluded.update_command, problem = excluded.problem, checked_at = excluded.checked_at`,
    ).run(tool, installed, latest, resolved === null ? null : JSON.stringify(updateCommandFor(tool, resolved)), problem, now.toISOString());
  }
  return runtimeStates(store);
}

/** Update one CLI, only while nothing is running, then read its version again. */
export async function updateRuntime(store: Store, tool: RuntimeTool, by: string, now: Date, seams: CatalogSeams = {}): Promise<{ ok: boolean; message: string }> {
  const state = runtimeStates(store).find(one => one.tool === tool);
  if (state === undefined) return { ok: false, message: `${RUNTIME_TOOLS[tool].name} is not installed on this computer.` };
  if (state.updateCommand === null) return { ok: false, message: `${state.name} was installed in a way Toolroll cannot update. Update it the way you installed it.` };
  const work = activeUpdateWork(store.handle);
  const busy = Object.values(work).reduce((sum, n) => sum + n, 0);
  if (busy > 0) return { ok: false, message: `Work is running (${busy} item${busy === 1 ? "" : "s"}). Update ${state.name} when it finishes.` };
  const runner = seams.runner ?? defaultRunner;
  const [command, ...args] = state.updateCommand;
  const env = { ...process.env };
  delete env["NODE_OPTIONS"];
  const ran = await runner(command!, args, { timeoutMs: 300_000, env });
  const after = (await checkRuntimes(store, now, seams)).find(one => one.tool === tool);
  if (ran.code !== 0) return { ok: false, message: `${state.name} did not update. ${(ran.stderr || ran.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`.trim() };
  store.handle.prepare("UPDATE runtime_check SET updated_at = ?, updated_by = ? WHERE tool = ?").run(now.toISOString(), by, tool);
  return after?.installed === state.installed
    ? { ok: true, message: `${state.name} is already at ${after?.installed ?? state.installed}.` }
    : { ok: true, message: `${state.name} updated to ${after?.installed ?? "the latest version"}. New work uses it; nothing running was touched.` };
}

// ---------------------------------------------------------------- the watch

export type WatchState = { enabled: boolean; checkedAt: string | null; problem: string | null; changedBy: string | null };
export function watchState(store: Store): WatchState {
  const row = store.handle.prepare("SELECT * FROM model_watch WHERE id = 1").get() as Record<string, unknown> | undefined;
  return { enabled: Number(row?.["enabled"] ?? 0) === 1, checkedAt: row?.["checked_at"] == null ? null : String(row["checked_at"]),
    problem: row?.["problem"] == null ? null : String(row["problem"]), changedBy: row?.["changed_by"] == null ? null : String(row["changed_by"]) };
}
export function setWatch(store: Store, enabled: boolean, by: string, now: Date): void {
  store.handle.prepare(`INSERT INTO model_watch (id, enabled, changed_by, changed_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at`).run(enabled ? 1 : 0, by, now.toISOString());
}

/** One full check: the catalog, the CLIs, and a notice for each new model or
 * newly available update. Idempotent per model and per released version. */
export async function checkModels(store: Store, now: Date, seams: CatalogSeams = {}): Promise<{ ok: boolean; added: SeenModel[]; runtimes: RuntimeState[]; problem: string | null }> {
  const fetched = await fetchOpenRouterModels(null, seams.fetcher ?? fetch);
  let added: SeenModel[] = [];
  if (fetched.ok) added = recordCatalog(store, catalogRows(fetched.models, codexCatalog(seams.home)), now);
  const runtimes = await checkRuntimes(store, now, seams);
  const problem = fetched.ok ? null : fetched.problem;
  store.handle.prepare(`INSERT INTO model_watch (id, checked_at, problem) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at, problem = excluded.problem`).run(now.toISOString(), problem);
  for (const model of added.filter(one => one.source !== "openrouter")) {
    const maker = model.source === "claude" ? "Anthropic" : model.source === "codex" ? "OpenAI" : "Google";
    const alias = model.source === "claude" ? FAMILIES.find(family => model.id.startsWith(`claude-${family}-`)) : undefined;
    const using = alias !== undefined && ["opus", "sonnet", "haiku"].includes(alias) && aliasTarget(store, alias)?.id === model.id
      ? ` Agents set to "${alias}" use it from now on.` : "";
    store.enqueueNotification({ dedupeKey: `model-new:${model.source}:${model.id}`, kind: "model-available",
      subject: `New model: ${model.name}`, body: `${maker} released ${model.name} (${priceWords(model)}).${using} Choose it in Settings → Models.`,
      link: "/settings/models", source: { installation: true } }, now);
  }
  for (const runtime of runtimes.filter(one => one.behind)) {
    store.enqueueNotification({ dedupeKey: `runtime-update:${runtime.tool}:${runtime.latest}`, kind: "runtime-update",
      subject: `${runtime.name} ${runtime.latest} is available`, body: `This computer has ${runtime.installed}. ${runtime.updateCommand === null ? "Update it the way you installed it." : "Update it in Settings → Models when no work is running."}`,
      link: "/settings/models", source: { installation: true } }, now);
  }
  return { ok: fetched.ok, added, runtimes, problem };
}

/** The background pass: runs only when the person turned checks on. */
export async function modelWatchPass(store: Store, now: Date, seams: CatalogSeams = {}): Promise<boolean> {
  const state = watchState(store);
  if (!state.enabled) return false;
  if (state.checkedAt !== null && now.getTime() - Date.parse(state.checkedAt) < WATCH_EVERY_MS) return false;
  await checkModels(store, now, seams);
  return true;
}
