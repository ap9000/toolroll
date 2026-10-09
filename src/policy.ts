/**
 * Organisation policy (sprint 8): one policy for the whole installation, set
 * by an instance operator on Settings → Policy or with `toolroll policy
 * set`. It says which providers and models may run, which project tools
 * (MCP servers) agents may use, and the highest permission level any task,
 * project or mode may run with.
 *
 * Nothing set means nothing restricted: no row is the open policy. The
 * permission levels, lowest first:
 *   safe       edits only: Claude accepts edits (acceptEdits), Gemini auto_edit;
 *              Codex and OpenRouter have no setting this low
 *   standard   routine commands: Claude auto, Codex's workspace sandbox
 *   escalated  full access: Claude bypassPermissions, Codex danger-full-access, Gemini yolo
 * Work above the ceiling runs at the highest level beneath it its provider has
 * (lowered), or, when there is none, doesn't run (refused); the words say which.
 *
 * Every road that admits work asks here: scope approval, the tick before a
 * run starts (and build() as the last look), the lead and project chats, subagents and flow steps.
 */
import type { Database } from "./store.js";
import type { ExecutionProfile } from "./scope.js";

export type PermissionLevel = "safe" | "standard" | "escalated";
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ["safe", "standard", "escalated"];
export const POLICY_PROVIDERS = ["claude", "codex", "gemini", "openrouter"] as const;
export type PolicyProvider = (typeof POLICY_PROVIDERS)[number];

/** The policy as saved: null lists allow everything of their kind. */
export type OrgPolicy = {
  providers: PolicyProvider[] | null;
  models: string[] | null;
  tools: string[] | null;
  ceiling: PermissionLevel;
};
export type SavedPolicy = OrgPolicy & { updatedBy: string | null; updatedAt: string | null };

export const OPEN_POLICY: OrgPolicy = { providers: null, models: null, tools: null, ceiling: "escalated" };

/** v105 keeps its version: the policy is a table of its own, made beside the spend tables. One row, or none. */
export const POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_policy (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  providers_json TEXT,
  models_json    TEXT,
  tools_json     TEXT,
  ceiling        TEXT NOT NULL DEFAULT 'escalated' CHECK (ceiling IN ('safe', 'standard', 'escalated')),
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;

const listOf = (value: unknown): string[] | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(one => String(one)) : null;
  } catch {
    return null;
  }
};

/** The policy in force. A missing table (a database not yet opened by this build) reads as open. */
export function readPolicy(db: Database): SavedPolicy {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare("SELECT * FROM org_policy WHERE id = 1").get() as Record<string, unknown> | undefined;
  } catch {
    row = undefined;
  }
  if (row === undefined) return { ...OPEN_POLICY, updatedBy: null, updatedAt: null };
  const ceiling = PERMISSION_LEVELS.includes(row["ceiling"] as PermissionLevel) ? (row["ceiling"] as PermissionLevel) : "escalated";
  return {
    providers: listOf(row["providers_json"])?.filter((one): one is PolicyProvider => (POLICY_PROVIDERS as readonly string[]).includes(one)) ?? null,
    models: listOf(row["models_json"]),
    tools: listOf(row["tools_json"]),
    ceiling,
    updatedBy: row["updated_by"] == null ? null : String(row["updated_by"]),
    updatedAt: row["updated_at"] == null ? null : String(row["updated_at"]),
  };
}

// ---- words -------------------------------------------------------------------------------

export const PROVIDER_NAMES: Record<PolicyProvider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", openrouter: "OpenRouter" };
export const LEVEL_NAMES: Record<PermissionLevel, string> = { safe: "Safe", standard: "Standard", escalated: "Escalated" };
export const LEVEL_HINTS: Record<PermissionLevel, string> = {
  safe: "Edits in the project only. Codex and OpenRouter can't run this low.",
  standard: "Edits and routine commands. Full access is lowered to this.",
  escalated: "Anything a task, project or mode was approved for, full access included.",
};
/** Where a refusal sends people. */
export const WHERE = "An instance operator can change it in Settings → Policy.";

/** A provider id as the policy knows it: chat and key variants count as their provider. */
export function policyProvider(provider: string): PolicyProvider | null {
  const base = provider === "anthropic-api" ? "claude" : provider.replace(/-(subscription|api)$/, "");
  return (POLICY_PROVIDERS as readonly string[]).includes(base) ? (base as PolicyProvider) : null;
}
const providerName = (provider: string): string => {
  const known = policyProvider(provider);
  return known === null ? provider : PROVIDER_NAMES[known];
};

const listWords = (list: readonly string[] | null, names: (one: string) => string = one => one): string => list === null ? "any" : list.length === 0 ? "none" : list.map(names).join(", ");

/** Each rule in words, for the page, the command and the ledger. */
export function policyParts(policy: OrgPolicy): { providers: string; models: string; tools: string; ceiling: string } {
  return {
    providers: listWords(policy.providers, one => PROVIDER_NAMES[one as PolicyProvider] ?? one),
    models: listWords(policy.models),
    tools: listWords(policy.tools),
    ceiling: LEVEL_NAMES[policy.ceiling],
  };
}

export function isOpen(policy: OrgPolicy): boolean {
  return policy.providers === null && policy.models === null && policy.tools === null && policy.ceiling === "escalated";
}

// ---- providers, models and tools -----------------------------------------------------------

/** Whether a model id matches an entry: the same id (any case), or a prefix ending in `*`. */
export function modelMatches(entry: string, model: string): boolean {
  const want = entry.trim().toLowerCase(), have = model.trim().toLowerCase();
  return want.endsWith("*") ? have.startsWith(want.slice(0, -1)) : want === have;
}

/** Why the policy stops an agent on this provider and model, or null. A default model ("default", or none) can't be
 * checked against a model list, so a list stops it. */
export function agentRefusal(policy: OrgPolicy, provider: string, model: string | null): string | null {
  const family = policyProvider(provider);
  if (policy.providers !== null && (family === null || !policy.providers.includes(family))) {
    return `The organisation policy doesn't allow ${providerName(provider)}. ${WHERE}`;
  }
  if (policy.models !== null) {
    if (model === null || model === "" || model === "default") {
      return `The organisation policy allows only listed models, and this uses ${providerName(provider)}'s default model. Choose a listed model, or ${WHERE.charAt(0).toLowerCase()}${WHERE.slice(1)}`;
    }
    if (!policy.models.some(entry => modelMatches(entry, model))) return `The organisation policy doesn't allow the model ${model}. ${WHERE}`;
  }
  return null;
}

/** Why the policy stops agents using a project tool, or null. */
export function toolRefusal(policy: OrgPolicy, tool: string): string | null {
  return policy.tools === null || policy.tools.includes(tool) ? null : `The organisation policy doesn't allow the tool ${tool}. ${WHERE}`;
}

// ---- the permission ceiling ------------------------------------------------------------------

const RANK: Record<PermissionLevel, number> = { safe: 0, standard: 1, escalated: 2 };
export const levelAbove = (level: PermissionLevel, ceiling: PermissionLevel): boolean => RANK[level] > RANK[ceiling];

/** The level a profile runs at. */
export function levelOfProfile(profile: ExecutionProfile): PermissionLevel {
  if (profile.provider === "claude") return profile.permissionArgv === "bypassPermissions" ? "escalated" : profile.permissionArgv === "auto" ? "standard" : "safe";
  if (profile.provider === "gemini") return profile.approvalArgv === "yolo" ? "escalated" : "safe";
  return profile.sandboxMode === "danger-full-access" ? "escalated" : "standard";
}

/** The same profile at a level, or null when its provider has no setting that low. */
function profileAt(profile: ExecutionProfile, level: PermissionLevel): ExecutionProfile | null {
  if (profile.provider === "claude") return { ...profile, permissionArgv: level === "escalated" ? "bypassPermissions" : level === "standard" ? "auto" : "acceptEdits" };
  if (profile.provider === "gemini") return { ...profile, approvalArgv: level === "escalated" ? "yolo" : "auto_edit" };
  return level === "safe" ? null : { ...profile, sandboxMode: level === "escalated" ? "danger-full-access" : "workspace-write" };
}

/** A level's words for one provider: "Full access", "Auto", "Accept edits". */
export function levelWords(profile: ExecutionProfile): string {
  if (profile.provider === "claude") return profile.permissionArgv === "bypassPermissions" ? "full access" : profile.permissionArgv === "auto" ? "auto" : "accept edits";
  if (profile.provider === "gemini") return profile.approvalArgv === "yolo" ? "full access" : "auto edit";
  return profile.sandboxMode === "danger-full-access" ? "full access" : "the workspace sandbox";
}

export type CeilingVerdict =
  | { ok: true; profile: ExecutionProfile; lowered: null }
  | { ok: true; profile: ExecutionProfile; lowered: string }
  | { ok: false; message: string };

/** Hold a profile to the ceiling: as it is, lowered (and the words say so), or refused (and the words say why). */
export function underCeiling(policy: OrgPolicy, profile: ExecutionProfile): CeilingVerdict {
  const level = levelOfProfile(profile);
  if (!levelAbove(level, policy.ceiling)) return { ok: true, profile, lowered: null };
  const ceiling = LEVEL_NAMES[policy.ceiling];
  for (const below of [...PERMISSION_LEVELS].reverse()) {
    if (levelAbove(below, policy.ceiling) || !levelAbove(level, below)) continue;
    const lower = profileAt(profile, below);
    if (lower === null) continue;
    return { ok: true, profile: lower, lowered: `The organisation policy's permission ceiling is ${ceiling}, so this runs with ${levelWords(lower)} instead of ${levelWords(profile)}.` };
  }
  return { ok: false, message: `The organisation policy's permission ceiling is ${ceiling}, and ${providerName(profile.provider)} can't run that low. ${WHERE}` };
}

/** Why the ceiling stops a planner, scout or native coding session on this provider, or null. They carry no sealed
 * profile to lower: on Claude and Gemini they edit only (Safe); on Codex and OpenRouter they run in the workspace
 * sandbox (Standard), those providers' lowest. */
export function sessionCeilingRefusal(policy: OrgPolicy, provider: string, what: string): string | null {
  const known = policyProvider(provider);
  const level: PermissionLevel = known === "claude" || known === "gemini" ? "safe" : "standard";
  if (!levelAbove(level, policy.ceiling)) return null;
  return `The organisation policy's permission ceiling is ${LEVEL_NAMES[policy.ceiling]}, and ${providerName(provider)} ${what} can't run that low. ${WHERE}`;
}

/** Everything the policy says about a profile before it runs: refused (words), or what runs and any lowering. */
export function profileVerdict(policy: OrgPolicy, profile: ExecutionProfile): CeilingVerdict {
  const agent = agentRefusal(policy, profile.provider, profile.model);
  if (agent !== null) return { ok: false, message: agent };
  const repair = profile.repairModel === "inherit" || profile.repairModel === profile.model ? null : agentRefusal(policy, profile.provider, profile.repairModel);
  if (repair !== null) return { ok: false, message: `Its repairs: ${repair.charAt(0).toLowerCase()}${repair.slice(1)}` };
  return underCeiling(policy, profile);
}

/** At approval, a person signs exact terms: anything above the ceiling is refused with words (a new filing is lowered). */
export function approvalRefusal(policy: OrgPolicy, profiles: readonly ExecutionProfile[], legs: readonly { provider: string; model: string | null }[] = []): string | null {
  for (const profile of profiles) {
    const verdict = profileVerdict(policy, profile);
    if (!verdict.ok) return verdict.message;
    if (verdict.lowered !== null) {
      return `This asks for ${levelWords(profile)}, above the organisation policy's permission ceiling (${LEVEL_NAMES[policy.ceiling]}). File it again to run it within the ceiling, or ${WHERE.charAt(0).toLowerCase()}${WHERE.slice(1)}`;
    }
  }
  for (const leg of legs) {
    const refused = agentRefusal(policy, leg.provider, leg.model);
    if (refused !== null) return refused;
  }
  return null;
}

// ---- changes ---------------------------------------------------------------------------------

/** Read a list typed by a person: commas or new lines, trimmed, no repeats; blank is "any". */
export function parseList(text: string | null | undefined): string[] | null {
  const items = [...new Set(String(text ?? "").split(/[,\n]/).map(one => one.trim()).filter(one => one !== ""))];
  return items.length === 0 ? null : items;
}

/** Check a policy before it's saved. */
export function checkPolicy(input: { providers: readonly string[] | null; models: readonly string[] | null; tools: readonly string[] | null; ceiling: string }):
  { ok: true; policy: OrgPolicy } | { ok: false; problem: string } {
  if (!PERMISSION_LEVELS.includes(input.ceiling as PermissionLevel)) return { ok: false, problem: "Choose a permission ceiling: safe, standard or escalated." };
  let providers: PolicyProvider[] | null = null;
  if (input.providers !== null) {
    const unknown = input.providers.filter(one => policyProvider(one.toLowerCase()) === null);
    if (unknown.length > 0) return { ok: false, problem: `${unknown.join(", ")} isn't a provider here. Choose from Claude, Codex, Gemini and OpenRouter.` };
    providers = POLICY_PROVIDERS.filter(one => input.providers!.some(given => policyProvider(given.toLowerCase()) === one));
    if (providers.length === 0) return { ok: false, problem: "Allow at least one provider, or allow any." };
  }
  const clean = (list: readonly string[] | null, what: string, limit: number): string[] | { problem: string } | null => {
    if (list === null) return null;
    const items = [...new Set(list.map(one => one.trim()).filter(one => one !== ""))];
    if (items.length > limit) return { problem: `List at most ${limit} ${what}.` };
    const bad = items.find(one => one.length > 120 || !/^[A-Za-z0-9._:/@~*+-]+$/.test(one));
    if (bad !== undefined) return { problem: `${bad.slice(0, 40)} isn't a ${what.replace(/s$/, "")} name. Use letters, numbers and . _ - : / @ ~ * only.` };
    return items.length === 0 ? null : items;
  };
  const models = clean(input.models, "models", 100);
  if (models !== null && !Array.isArray(models)) return { ok: false, problem: models.problem };
  const tools = clean(input.tools, "tools", 100);
  if (tools !== null && !Array.isArray(tools)) return { ok: false, problem: tools.problem };
  return { ok: true, policy: { providers, models, tools, ceiling: input.ceiling as PermissionLevel } };
}
