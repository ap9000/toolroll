import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "./store.js";

export type DirectChatCatalogProvider = "claude" | "codex" | "gemini";

export const DIRECT_CHAT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"] as const);
export type DirectChatEffort = (typeof DIRECT_CHAT_EFFORTS)[number];

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GEMINI_DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type DirectChatModelOption = {
  provider: DirectChatCatalogProvider;
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
};

export function normalizeDirectChatEffort(raw: string | null | undefined, provider?: DirectChatCatalogProvider): DirectChatEffort | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (!(DIRECT_CHAT_EFFORTS as readonly string[]).includes(lower)) return null;
  const effort = lower as DirectChatEffort;
  if (provider === "claude" && effort === "ultra") return "max";
  if (provider === "gemini" && effort === "ultra") return "max";
  return effort;
}

function prettyCodexLabel(slug: string, displayName?: string): string {
  if (typeof displayName === "string" && displayName.trim() !== "") {
    const trimmed = displayName.trim();
    if (/[A-Z]/.test(trimmed)) return trimmed.slice(0, 80);
  }
  return slug
    .split("-")
    .map(part => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^[0-9]/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ")
    .replace(/^GPT /, "GPT-");
}

function prettyClaudeLabel(id: string): string {
  switch (id) {
    case "opus": return "Claude Opus 5.5";
    case "sonnet": return "Claude Sonnet 5.5";
    case "haiku": return "Claude Haiku 5.5";
    case "fable": return "Claude Fable";
    default:
      return id
        .replace(/^claude-/, "Claude ")
        .replace(/-([0-9]+)-([0-9]+)$/, " $1.$2")
        .replace(/-/g, " ")
        .replace(/\b[a-z]/g, c => c.toUpperCase());
  }
}

type CodexCacheEntry = {
  slug: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
};

export function readCodexSubscriptionModels(homeDir = homedir()): CodexCacheEntry[] {
  const path = join(homeDir, ".codex", "models_cache.json");
  try {
    if (!existsSync(path)) return [];
    if (lstatSync(path).size >= 2_000_000) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rawModels = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["models"])
        ? (parsed as Record<string, unknown>)["models"] as unknown[]
        : []);
    const out: CodexCacheEntry[] = [];
    const seen = new Set<string>();
    for (const raw of rawModels) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const slug = typeof entry["slug"] === "string" ? entry["slug"].trim() : "";
      if (slug === "" || seen.has(slug)) continue;
      if (slug === "codex-auto-review" || entry["visibility"] === "hide") continue;
      seen.add(slug);

      const rawLevels = Array.isArray(entry["supported_reasoning_levels"])
        ? entry["supported_reasoning_levels"]
        : [];
      const efforts: string[] = [];
      for (const lvl of rawLevels) {
        const eff = typeof lvl === "string"
          ? lvl
          : (lvl && typeof lvl === "object" && typeof (lvl as Record<string, unknown>)["effort"] === "string"
            ? String((lvl as Record<string, unknown>)["effort"])
            : "");
        const norm = normalizeDirectChatEffort(eff, "codex");
        if (norm && !efforts.includes(norm)) efforts.push(norm);
      }
      const effectiveEfforts = efforts.length > 0 ? efforts : [...CODEX_DEFAULT_EFFORTS];
      const rawDefault = normalizeDirectChatEffort(
        typeof entry["default_reasoning_level"] === "string" ? entry["default_reasoning_level"] : null,
        "codex",
      );
      const defaultEffort = (rawDefault && effectiveEfforts.includes(rawDefault))
        ? rawDefault
        : (effectiveEfforts.includes("high") ? "high" : effectiveEfforts[0] ?? null);
      const ctxRaw = entry["context_window"];
      const contextWindow = typeof ctxRaw === "number" && Number.isFinite(ctxRaw) && ctxRaw > 0
        ? Math.round(ctxRaw)
        : null;
      const displayName = typeof entry["display_name"] === "string" ? entry["display_name"] : undefined;
      out.push({
        slug,
        label: prettyCodexLabel(slug, displayName),
        efforts: effectiveEfforts,
        defaultEffort,
        contextWindow,
      });
      if (out.length >= 24) break;
    }
    return out;
  } catch {
    return [];
  }
}

type AgyParsedCatalog = {
  models: DirectChatModelOption[];
  variantMap: Map<string, string>;
};

const AGY_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

export function parseAgyModelsOutput(stdout: string): AgyParsedCatalog {
  const variantMap = new Map<string, string>();
  const grouped = new Map<string, { id: string; label: string; efforts: string[]; contextWindow: number | null }>();
  const order: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.toLowerCase().startsWith("fetching ")) continue;
    const parts = line.split(/\t+/);
    const rawId = (parts[0] ?? "").trim();
    const rawLabel = (parts[1] ?? "").trim();
    if (rawId === "" || /\s/.test(rawId)) continue;

    // Only expose Gemini / Antigravity native models under the Gemini provider section
    // (avoid duplicating Claude models under Gemini since Claude has its own section).
    if (rawId.startsWith("claude-")) continue;

    const suffixMatch = /^(.+)-(low|medium|high|xhigh|max)$/.exec(rawId);
    if (suffixMatch) {
      const baseId = suffixMatch[1]!;
      const eff = suffixMatch[2]!;
      variantMap.set(`${baseId}:${eff}`, rawId);
      const cleanLabel = (rawLabel !== "" ? rawLabel : baseId)
        .replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, "")
        .trim();
      let entry = grouped.get(baseId);
      if (!entry) {
        entry = {
          id: baseId,
          label: cleanLabel || baseId,
          efforts: [],
          contextWindow: baseId.startsWith("gemini-") ? 1_000_000 : null,
        };
        grouped.set(baseId, entry);
        order.push(baseId);
      }
      if (!entry.efforts.includes(eff)) entry.efforts.push(eff);
    } else {
      if (!grouped.has(rawId)) {
        grouped.set(rawId, {
          id: rawId,
          label: rawLabel || rawId,
          efforts: [...GEMINI_DEFAULT_EFFORTS],
          contextWindow: rawId.startsWith("gemini-") ? 1_000_000 : null,
        });
        order.push(rawId);
      }
    }
  }

  const models: DirectChatModelOption[] = order.map(id => {
    const g = grouped.get(id)!;
    const sortedEfforts = [...g.efforts].sort(
      (a, b) => AGY_EFFORT_ORDER.indexOf(a as (typeof AGY_EFFORT_ORDER)[number]) - AGY_EFFORT_ORDER.indexOf(b as (typeof AGY_EFFORT_ORDER)[number]),
    );
    const defaultEffort = sortedEfforts.includes("high") ? "high" : (sortedEfforts[0] ?? null);
    return {
      provider: "gemini",
      id: g.id,
      label: g.label,
      efforts: sortedEfforts,
      defaultEffort,
      contextWindow: g.contextWindow,
    };
  });

  return { models, variantMap };
}

let cachedAgy: { fetchedAt: number; parsed: AgyParsedCatalog } | null = null;
let agyFetchInFlight = false;
const AGY_CACHE_TTL_MS = 10 * 60 * 1_000;

function locateAgyBinary(homeDir = homedir()): string | null {
  for (const candidate of [`${homeDir}/.local/bin/agy`, `${homeDir}/.gemini/bin/agy`, "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function warmAgyCatalog(homeDir = homedir()): void {
  if (agyFetchInFlight) return;
  if (cachedAgy !== null && Date.now() - cachedAgy.fetchedAt < AGY_CACHE_TTL_MS) return;
  const bin = locateAgyBinary(homeDir);
  if (bin === null) return;
  agyFetchInFlight = true;
  execFile(bin, ["models"], { timeout: 6_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
    agyFetchInFlight = false;
    if (err || typeof stdout !== "string" || stdout.trim() === "") return;
    const parsed = parseAgyModelsOutput(stdout);
    if (parsed.models.length > 0) {
      cachedAgy = { fetchedAt: Date.now(), parsed };
    }
  });
}

export function resolveAgyModelForEffort(modelId: string, effort: DirectChatEffort | null): string {
  const trimmed = modelId.trim();
  if (trimmed === "") return trimmed;
  const eff = effort ?? "high";
  const baseMatch = /^(.+)-(low|medium|high|xhigh|max)$/.exec(trimmed);
  const baseId = baseMatch ? baseMatch[1]! : trimmed;
  const variant = cachedAgy?.parsed.variantMap.get(`${baseId}:${eff}`);
  if (variant) return variant;
  // If user chose an explicit effort on a known Gemini 4/3.8 base ID before cache warmed, map cleanly.
  if (baseId === "gemini-4-neon" || baseId === "gemini-4-hydrogen") {
    const allowed = eff === "max" ? "xhigh" : eff;
    return `${baseId}-${allowed}`;
  }
  if (baseId === "gemini-4-carbon" || baseId === "gemini-4-argon" || baseId === "gemini-3.8-flash") {
    const allowed = (eff === "xhigh" || eff === "max") ? "high" : eff;
    return `${baseId}-${allowed}`;
  }
  return trimmed;
}

export function listDirectChatSubscriptionModels(store?: Store, homeDir = homedir()): DirectChatModelOption[] {
  warmAgyCatalog(homeDir);

  const claudeModels: DirectChatModelOption[] = [
    { provider: "claude", id: "opus", label: "Claude Opus 5.5", efforts: [...CLAUDE_EFFORTS], defaultEffort: "high", contextWindow: 1_000_000 },
    { provider: "claude", id: "sonnet", label: "Claude Sonnet 5.5", efforts: [...CLAUDE_EFFORTS], defaultEffort: "high", contextWindow: 1_000_000 },
    { provider: "claude", id: "haiku", label: "Claude Haiku 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200_000 },
    { provider: "claude", id: "fable", label: "Claude Fable", efforts: [...CLAUDE_EFFORTS], defaultEffort: "high", contextWindow: 1_000_000 },
  ];

  if (store) {
    try {
      const rows = store.handle
        .prepare(`SELECT id, name, context FROM model_seen WHERE source = 'claude' ORDER BY last_seen_at DESC LIMIT 12`)
        .all() as Array<{ id: string; name: string; context: number | null }>;
      const seenClaude = new Set(["opus", "sonnet", "haiku", "fable", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
      for (const row of rows) {
        if (!row.id || seenClaude.has(row.id)) continue;
        seenClaude.add(row.id);
        claudeModels.push({
          provider: "claude",
          id: row.id,
          label: row.name && row.name.trim() !== "" ? row.name.trim() : prettyClaudeLabel(row.id),
          efforts: [...CLAUDE_EFFORTS],
          defaultEffort: "high",
          contextWindow: typeof row.context === "number" && row.context > 0 ? row.context : 200_000,
        });
      }
    } catch {
      // Ignore catalog read errors on stripped test stores.
    }
  }

  const codexCache = readCodexSubscriptionModels(homeDir);
  const codexModels: DirectChatModelOption[] = codexCache.length > 0
    ? codexCache.map(one => ({
      provider: "codex",
      id: one.slug,
      label: one.label,
      efforts: one.efforts,
      defaultEffort: one.defaultEffort,
      contextWindow: one.contextWindow,
    }))
    : [
      { provider: "codex", id: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: [...CODEX_DEFAULT_EFFORTS, "ultra"], defaultEffort: "high", contextWindow: 500_000 },
      { provider: "codex", id: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: [...CODEX_DEFAULT_EFFORTS, "ultra"], defaultEffort: "high", contextWindow: 272_000 },
      { provider: "codex", id: "gpt-6-astra", label: "GPT-6 Astra", efforts: [...CODEX_DEFAULT_EFFORTS, "ultra"], defaultEffort: "high", contextWindow: 272_000 },
      { provider: "codex", id: "gpt-6-sol", label: "GPT-6 Sol", efforts: [...CODEX_DEFAULT_EFFORTS, "ultra"], defaultEffort: "high", contextWindow: 272_000 },
      { provider: "codex", id: "gpt-6-luna", label: "GPT-6 Luna", efforts: [...CODEX_DEFAULT_EFFORTS], defaultEffort: "high", contextWindow: 272_000 },
    ];

  const geminiModels: DirectChatModelOption[] = cachedAgy && cachedAgy.parsed.models.length > 0
    ? cachedAgy.parsed.models
    : [
      { provider: "gemini", id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", contextWindow: 1_000_000 },
      { provider: "gemini", id: "gemini-4-carbon", label: "Gemini 4 Carbon", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000 },
      { provider: "gemini", id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000 },
      { provider: "gemini", id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", contextWindow: 1_000_000 },
      { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000 },
    ];

  return [...claudeModels, ...codexModels, ...geminiModels];
}

export function defaultContextWindowFor(provider: DirectChatCatalogProvider, modelId: string, homeDir = homedir()): number | null {
  const lower = modelId.trim().toLowerCase();
  if (provider === "claude") {
    if (lower.includes("haiku")) return 200_000;
    return 1_000_000;
  }
  if (provider === "codex") {
    const fromCache = readCodexSubscriptionModels(homeDir).find(m => m.slug.toLowerCase() === lower);
    if (fromCache?.contextWindow) return fromCache.contextWindow;
    if (lower.includes("6.2-sol") || lower.includes("6.1-sol") || lower.includes("6.1-terra")) return 500_000;
    return 272_000;
  }
  if (provider === "gemini") {
    return 1_000_000;
  }
  return null;
}
