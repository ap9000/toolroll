/**
 * What a build keeps of the provider's own home, and nothing more.
 *
 * A build loads none of the operator's Claude settings or Codex config
 * (provider.ts), so two things from them are carried explicitly:
 *
 * - A build routed with no model runs as the operator's own CLI would: the
 *   model they chose (Claude's settings.json `model`, Codex's config.toml
 *   `model`), Claude's `alwaysThinkingEnabled` and Codex's reasoning effort.
 *   Nothing else of either file (hooks, plugins, MCP servers) is read.
 * - A Codex build gets its own CODEX_HOME for the launch: links to the
 *   operator's `auth.json` and `sessions/` (so it signs in, and a repair
 *   resumes the same thread), and no skills, AGENTS.md or anything else from
 *   theirs. Links, never copies: a refreshed sign-in lands in the real file.
 *   The folder is fenced from the agent's commands and removed after the run.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { validModelId } from "./provider.js";

/** The operator's own choices a no-model build keeps. */
export type ProviderDefaults = { model?: string; alwaysThinking?: boolean; effort?: string };

const EFFORT = /^[a-z]{1,16}$/;

export function claudeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

export function codexHomeDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return env["CODEX_HOME"] || join(home, ".codex");
}

/** Claude's user settings: its `model` and `alwaysThinkingEnabled`, when valid. */
export function claudeDefaults(configDir: string): ProviderDefaults {
  let settings: unknown;
  try { settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")); } catch { return {}; }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return {};
  const { model, alwaysThinkingEnabled } = settings as Record<string, unknown>;
  return {
    ...(typeof model === "string" && model !== "" && validModelId(model) ? { model } : {}),
    ...(typeof alwaysThinkingEnabled === "boolean" ? { alwaysThinking: alwaysThinkingEnabled } : {}),
  };
}

/** Codex's config.toml: its top-level `model` and `model_reasoning_effort`, or the selected profile's. */
export function codexDefaults(codexHome: string): ProviderDefaults {
  let text: string;
  try { text = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { return {}; }
  const tables = new Map<string, Record<string, string>>([["", {}]]);
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) { table = header[1]!.replace(/"/g, ""); if (!tables.has(table)) tables.set(table, {}); continue; }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line);
    if (pair !== null) tables.get(table)![pair[1]!] = pair[2]!;
  }
  const top = tables.get("")!;
  const profile = top["profile"] === undefined ? {} : tables.get(`profiles.${top["profile"]}`) ?? {};
  const model = profile["model"] ?? top["model"];
  const effort = profile["model_reasoning_effort"] ?? top["model_reasoning_effort"];
  return {
    ...(model !== undefined && model !== "" && validModelId(model) ? { model } : {}),
    ...(effort !== undefined && EFFORT.test(effort) ? { effort } : {}),
  };
}

/**
 * One Codex launch's CODEX_HOME: a private folder linking the operator's
 * sign-in and sessions. A missing `auth.json` stays missing (an API-key
 * build needs none); a missing `sessions/` is made where Codex would make
 * it, so a resumed build finds the thread its first launch wrote.
 */
export function isolatedCodexHome(source: string, root: string = tmpdir()): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(root, "so-codex-"));
  try {
    chmodSync(dir, 0o700);
    if (existsSync(join(source, "auth.json"))) symlinkSync(join(source, "auth.json"), join(dir, "auth.json"));
    mkdirSync(join(source, "sessions"), { recursive: true, mode: 0o700 });
    symlinkSync(join(source, "sessions"), join(dir, "sessions"), "dir");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // rm removes the links themselves, never what they point to.
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
