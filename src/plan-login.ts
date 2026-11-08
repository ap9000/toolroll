/**
 * How a CLI says it is signed in, read live, right before a run: the gateway's billing evidence, and the proof a
 * plan-pinned fallback agent needs before it runs (fallback.ts). Only providers listed in PLAN_LOGIN_PROVABLE can be a
 * plan fallback: for any other there is no live proof, so filing and the chain setting refuse it.
 */
import { run as runCommand } from "./exec.js";
import type { Billing } from "./spend.js";

/** How Codex says it's signed in (`codex login status`): a ChatGPT sign-in is its plan; a key or Bedrock is a key;
 * null when it says neither (not signed in, or it didn't answer). */
export async function codexLoginBilling(binary: string, omitEnv: readonly string[], env?: Record<string, string | undefined>): Promise<Billing | null> {
  try {
    const status = await runCommand(binary, ["login", "status"], { timeoutMs: 15_000, omitEnv, processGroup: true,
      ...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env).filter((one): one is [string, string] => one[1] !== undefined)) }) });
    const said = `${status.stdout}\n${status.stderr}`;
    // Strict: the status line itself, at the start of a line. A line naming both is never read as a plan.
    if (/^Logged in using ChatGPT\s*$/m.test(said) && !/api key|bedrock/i.test(said)) return "subscription";
    // Anything naming a key or Bedrock is read as a key (never a plan): that only ever narrows.
    return /api key|bedrock/i.test(said) ? "api-key" : null;
  } catch {
    return null;
  }
}

/** Providers whose CLI can say, live and machine-readably, that the credential a run will use is a plan. */
export const PLAN_LOGIN_PROVABLE: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * How Claude says it is signed in (`claude auth status --json`), read with the run's own environment so it reads the
 * credential the child will use. Strict: a plan only for a first-party claude.ai login with a named subscription; any
 * other shape, a key, a cloud provider or no answer is not a plan.
 */
export async function claudeLoginBilling(binary: string, omitEnv: readonly string[], env: Record<string, string | undefined>): Promise<Billing | null> {
  try {
    const status = await runCommand(binary, ["auth", "status", "--json"], { timeoutMs: 15_000, omitEnv, processGroup: true,
      env: Object.fromEntries(Object.entries(env).filter((one): one is [string, string] => one[1] !== undefined)) });
    if (status.code !== 0) return null;
    const read: unknown = JSON.parse(status.stdout);
    if (read === null || typeof read !== "object" || Array.isArray(read)) return null;
    const said = read as Record<string, unknown>;
    if (said["loggedIn"] !== true) return null;
    if (said["authMethod"] === "claude.ai" && said["apiProvider"] === "firstParty" && typeof said["subscriptionType"] === "string" && /^[a-z0-9_-]{1,32}$/.test(said["subscriptionType"])) return "subscription";
    return "api-key";
  } catch {
    return null;
  }
}

/** The live plan proof for a provider, or null where none exists (the caller refuses). */
export async function livePlanLogin(provider: string, binary: string, omitEnv: readonly string[], env: Record<string, string | undefined>): Promise<Billing | null> {
  if (provider === "codex") return codexLoginBilling(binary, omitEnv, env);
  if (provider === "claude") return claudeLoginBilling(binary, omitEnv, env);
  return null;
}
