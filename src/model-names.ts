/**
 * One name per model, on every screen that names one (Settings revamp S4): the label the Models editor offers for a
 * Claude id (`CLAUDE_EXACT`), the same words for a Claude id that list doesn't carry yet, and the id itself for
 * anything else. Display only: saved rows, approvals, JSON and the CLI keep the exact id.
 */
import { CLAUDE_EXACT } from "./model-catalog.js";
import { providerName } from "./provider-auth.js";

const CLAUDE_PROVIDERS = new Set(["claude", "claude-subscription", "anthropic-api"]);
const LABELS: ReadonlyMap<string, string> = new Map(CLAUDE_EXACT.map(one => [one.value, one.label]));
const FAMILY = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+(?:-\d+)*))?$/;

/** The display name for a model id: "claude-opus-5-5" → "Claude Opus 5.5", "opus" → "Claude Opus"; an id it doesn't
 * know stays the id. `null`, empty or "default": the provider's own default. */
export function modelName(provider: string | null, id: string | null): string {
  if (id === null || id.trim() === "" || id === "default") return "the default model";
  const known = LABELS.get(id);
  if (known !== undefined) return known;
  if (provider === null || CLAUDE_PROVIDERS.has(provider)) {
    const family = FAMILY.exec(id);
    if (family !== null) return `Claude ${family[1]!.charAt(0).toUpperCase()}${family[1]!.slice(1)}${family[2] === undefined ? "" : ` ${family[2].replaceAll("-", ".")}`}`;
  }
  return id;
}

/** The agent and its model in one phrase: "Claude Opus 5.5", "Codex · gpt-5.5", or the agent alone when no model is
 * pinned. A model name that already says its agent isn't said twice. */
export function agentModelName(provider: string, id: string | null): string {
  const agent = providerName(provider);
  if (id === null || id.trim() === "" || id === "default") return agent;
  const name = modelName(provider, id);
  return name.startsWith(`${agent} `) ? name : `${agent} · ${name}`;
}
