/**
 * Provider API keys, managed instead of ambient (the gap the gemini
 * live-auth work exposed): one 0600 file per provider under
 * ~/.toolroll/keys/ (or an older ~/.standing-orders/keys/), written from the settings card or piped into
 * the CLI — never typed into an argv, never rendered back, never stored
 * in the database a backup might carry.
 *
 * The injection contract lives in the invocation gateway: a stored key is
 * added to EXACTLY its own provider's child environment at spawn, where
 * the adapter's foreign-credential strip has already shed everybody
 * else's. The plane's own process never needs the key in its environment
 * at all — a restart or a rotation is a file write, not a relaunch — and
 * an ambient env var still works as the fallback it always was (the file,
 * being deliberate, wins).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "./provider.js";
import { isAcpProvider, type KeyedProviderId } from "./acp-agents.js";
import { namedPath } from "./names.js";

/** The ONE env name each provider's own harness reads its key from —
 * where a managed key is INJECTED. */
export const PROVIDER_KEY_ENV: Record<KeyedProviderId, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/** EVERY env name a provider reads its OWN key from — what subscription
 * mode STRIPS so an ambient key cannot override the login. gemini reads
 * two; the rest read one. */
export const OWN_KEY_ENV: Record<KeyedProviderId, readonly string[]> = {
  // v105: the bearer-token and Codex-specific aliases bill a key just the same, so a sign-in run sheds them too.
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export function keysDir(home: string = homedir()): string {
  return namedPath(home, ["keys"], { dot: true });
}

/**
 * How a provider authenticates (the operator's ruling 2026-08-29: keep
 * BOTH, prefer the subscription). "subscription" uses the CLI's OWN login
 * — a Claude/ChatGPT plan, a Google cached login — and the API key is
 * kept but NOT handed to the process, so its own auth wins. "api-key"
 * hands the stored (or ambient) key to the process. openrouter has no
 * login and is always api-key. An ACP agent (acp-agents.ts) has neither:
 * it signs in its own way and Toolroll never holds a key for it —
 * "agent-login", which says nothing about how it is billed (that is the
 * agent's billing declaration, per model).
 */
export type AuthMode = "subscription" | "api-key" | "agent-login";

/** Providers that CAN authenticate without an API key (a subscription or
 * cached login). openrouter cannot — it is api-key only. */
export const SUBSCRIPTION_CAPABLE: Record<KeyedProviderId, boolean> = {
  claude: true,
  codex: true,
  gemini: true,
  openrouter: false,
};

/** The default when nothing is set: subscription where it exists (prefer
 * the plan the operator already pays for), api-key otherwise. */
export const DEFAULT_AUTH_MODE: Record<KeyedProviderId, AuthMode> = {
  // Claude and Codex have first-class subscriptions most operators
  // already pay for — prefer them. Gemini support here is key-based (a
  // Google cached login is possible but not our road), and openrouter is
  // key-only — both default to the key. Every default is switchable.
  claude: "subscription",
  codex: "subscription",
  gemini: "api-key",
  openrouter: "api-key",
};

function authModeFileFor(provider: KeyedProviderId, home: string): string {
  return join(keysDir(home), `${provider}.auth`);
}

export function readAuthMode(provider: ProviderId, home: string = homedir()): AuthMode {
  if (isAcpProvider(provider)) return "agent-login";
  if (!SUBSCRIPTION_CAPABLE[provider]) return "api-key";
  try {
    const value = readFileSync(authModeFileFor(provider, home), "utf8").trim();
    return value === "api-key" ? "api-key" : "subscription";
  } catch {
    return DEFAULT_AUTH_MODE[provider];
  }
}

/**
 * The auth mode as an AUTHORITY reads it (raw authority repair): an absent
 * file is the provider's default, but a file that is present and says
 * neither `subscription` nor `api-key` is a stated problem — never the
 * subscription default a lenient read would coerce it to. A provider with
 * no subscription login is the key, whatever the file says.
 */
export function readAuthModeStrict(provider: ProviderId, home: string = homedir()): { ok: true; mode: AuthMode } | { ok: false; problem: string } {
  if (isAcpProvider(provider)) return { ok: true, mode: "agent-login" };
  if (!SUBSCRIPTION_CAPABLE[provider]) return { ok: true, mode: "api-key" };
  let raw: string;
  try {
    raw = readFileSync(authModeFileFor(provider, home), "utf8");
  } catch (error) {
    // Inside the agents' fence the keys folder is out of reach: Linux masks it (the file reads as absent), and macOS
    // refuses it (EPERM), which reads the same way — a Toolroll a flow's check zone starts has only its CLIs' own sign-ins.
    // Any other unreadable file (EACCES: its permissions) is still a stated problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EPERM") return { ok: true, mode: DEFAULT_AUTH_MODE[provider] };
    return { ok: false, problem: `the ${provider} auth-mode file cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}) — run \`keys auth ${provider} subscription|api-key\` to restate it` };
  }
  const value = raw.trim();
  if (value !== "subscription" && value !== "api-key") {
    return { ok: false, problem: `the ${provider} auth-mode file says ${JSON.stringify(value.slice(0, 40))}, not subscription or api-key — run \`keys auth ${provider} subscription|api-key\` to restate it` };
  }
  return { ok: true, mode: value };
}

export function setAuthMode(
  provider: KeyedProviderId,
  mode: "subscription" | "api-key",
  home: string = homedir(),
): { ok: true } | { ok: false; reason: "no-subscription" } {
  if (mode === "subscription" && !SUBSCRIPTION_CAPABLE[provider]) {
    return { ok: false, reason: "no-subscription" };
  }
  mkdirSync(keysDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(authModeFileFor(provider, home), mode, { mode: 0o600 });
  return { ok: true };
}

export function keyFileFor(provider: KeyedProviderId, home: string = homedir()): string {
  return join(keysDir(home), provider);
}

/** Shape check only — never a validity claim. A key is printable ASCII
 * without whitespace, bounded; anything else is a paste accident. */
export function plausibleKey(value: string): boolean {
  return value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function saveProviderKey(
  provider: KeyedProviderId,
  value: string,
  home: string = homedir(),
): { ok: true } | { ok: false; reason: "implausible" } {
  const trimmed = value.trim();
  if (!plausibleKey(trimmed)) return { ok: false, reason: "implausible" };
  mkdirSync(keysDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(keyFileFor(provider, home), trimmed, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync — restate it.
  chmodSync(keyFileFor(provider, home), 0o600);
  return { ok: true };
}

export function readProviderKey(provider: KeyedProviderId, home: string = homedir()): string | null {
  try {
    const value = readFileSync(keyFileFor(provider, home), "utf8").trim();
    return plausibleKey(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearProviderKey(provider: KeyedProviderId, home: string = homedir()): boolean {
  const file = keyFileFor(provider, home);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * A live credential check that spends NO tokens: each provider exposes a
 * cheap authenticated GET (its model list, or a key-info route) whose only
 * job here is to make the provider's own auth boundary answer yes or no.
 * Injectable fetcher (the converse.ts precedent) so tests never touch the
 * network. Distinguishes a REJECTED key (bad/expired/wrong provider) from
 * an UNREACHABLE provider (offline, blocked) — the operator needs to know
 * which, because only one of them means "fix the key".
 */
export type KeyVerdict =
  | { ok: true }
  | { ok: false; reason: "rejected"; status: number }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "unexpected"; status: number };

const VERIFY_ENDPOINT: Record<KeyedProviderId, { url: string; headers: (key: string) => Record<string, string> }> = {
  gemini: {
    // The key rides the x-goog-api-key HEADER (round 2, finding 6):
    // Google's current guidance, and it keeps the secret out of the URL
    // where a diagnostic or intermediary could surface it.
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: key => ({ "x-goog-api-key": key }),
  },
  codex: {
    url: "https://api.openai.com/v1/models",
    headers: key => ({ authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: key => ({ authorization: `Bearer ${key}` }),
  },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

export async function verifyProviderKey(
  provider: KeyedProviderId,
  value: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<KeyVerdict> {
  const key = value.trim();
  if (!plausibleKey(key)) return { ok: false, reason: "rejected", status: 0 };
  const endpoint = VERIFY_ENDPOINT[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(endpoint.url, { headers: endpoint.headers(key), redirect: "error", signal: controller.signal });
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 200) return { ok: true };
  // 401/403 are the auth boundary saying no, on every provider (round 2,
  // finding 6). A 400 is AMBIGUOUS — malformed request vs a bad key — so
  // it is a rejection ONLY when the body names a key/auth failure; our
  // request is a trivial GET, so a 400 that is NOT about the key is a
  // genuine surprise and reads as `unexpected`, not a false rejection.
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected", status: response.status };
  }
  if (response.status === 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 2048).toLowerCase();
    } catch {
      body = "";
    }
    // A 400 is a rejection ONLY with an actual NEGATIVE marker near the
    // key/auth phrase (round 3, finding 6) — "API key not valid" rejects,
    // but "API key accepted; malformed page size" does not.
    const negativeAuth =
      /(api[ _]?key[^.]{0,30}(invalid|not valid|expired|missing|revoked))|((invalid|expired|missing|revoked)[^.]{0,20}api[ _]?key)|unauthenticated|permission[ _]denied|invalid authentication|api_key_invalid/;
    if (negativeAuth.test(body)) {
      return { ok: false, reason: "rejected", status: 400 };
    }
    return { ok: false, reason: "unexpected", status: 400 };
  }
  return { ok: false, reason: "unexpected", status: response.status };
}

/** Words for a verdict, safe to render on any surface (never the key). */
export function verdictWords(provider: KeyedProviderId, verdict: KeyVerdict): string {
  if (verdict.ok) return `the ${provider} key works`;
  if (verdict.reason === "rejected") return `${provider} rejected this key — check the paste, or whether it is the right provider`;
  if (verdict.reason === "unreachable") return `couldn't reach ${provider} to check the key — it is stored; verify later`;
  return `${provider} gave an unexpected response (${verdict.status}) — the key is stored, but unverified`;
}

/** What a surface may say about a key: that it exists and when it last
 * changed — NEVER the value, never a prefix, never a length. */
export function keyStatus(provider: KeyedProviderId, home: string = homedir()): { set: boolean; updatedAt: string | null } {
  try {
    const stat = statSync(keyFileFor(provider, home));
    return { set: true, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { set: false, updatedAt: null };
  }
}
