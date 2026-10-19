/** Non-spending account checks. Only normalized facts leave this module. */
import { homedir } from "node:os";
import { run, type ExecResult } from "./exec.js";
import { ALL_CREDENTIAL_ENV, inspectionOf, type ProviderId } from "./provider.js";
import { isAcpProvider, type KeyedProviderId } from "./acp-agents.js";
import { keyStatus, PROVIDER_KEY_ENV, readAuthMode, readProviderKey, verifyProviderKey, type AuthMode, type KeyVerdict } from "./keys.js";

export type ProviderConnection = {
  state: "connected" | "signed-out" | "not-installed" | "unverified" | "key-present" | "key-works" | "key-refused" | "missing-key";
  /** A saved key that was just tested: what the provider said. */
  verdict?: KeyVerdict;
  mode: AuthMode;
  email?: string;
  plan?: string;
  method?: string;
  checkedAt: string;
};
export type ConnectionChecker = (provider: ProviderId, fresh?: boolean) => Promise<ProviderConnection>;

export function signInFacts(provider: ProviderId, result: ExecResult, now = new Date()): ProviderConnection {
  const base = { mode: "subscription" as const, checkedAt: now.toISOString() };
  if (result.notFound) return { ...base, state: "not-installed" };
  if (result.timedOut) return { ...base, state: "unverified" };
  if (provider === "claude") {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown> | null;
      if (value?.loggedIn === false && (result.code === 0 || result.code === 1)) return { ...base, state: "signed-out" };
      if (value?.loggedIn !== true || result.code !== 0) return { ...base, state: "unverified" };
      const email = typeof value.email === "string" && value.email.length <= 254 && /^[\x21-\x7e]+$/.test(value.email) && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(value.email) ? value.email : undefined;
      const plans: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };
      const methods: Record<string, string> = { "claude.ai": "Claude account", api_key: "API key", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI" };
      const plan = typeof value.subscriptionType === "string" && Object.hasOwn(plans, value.subscriptionType) ? plans[value.subscriptionType] : undefined;
      const method = typeof value.authMethod === "string" && Object.hasOwn(methods, value.authMethod) ? methods[value.authMethod] : undefined;
      return { ...base, state: value.authMethod === "claude.ai" ? "connected" : "unverified", ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(method ? { method } : {}) };
    } catch { return { ...base, state: "unverified" }; }
  }
  if (provider === "codex") {
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /^Logged in using ChatGPT\s*$/m.test(text)) return { ...base, state: "connected", method: "ChatGPT account" };
    if (result.code === 0 && /^Logged in using an? API key\b/m.test(text)) return { ...base, state: "unverified", method: "API key; subscription sign-in is not verified" };
    if (result.code === 1 && /^Not logged in\s*$/m.test(text)) return { ...base, state: "signed-out" };
  }
  return { ...base, state: "unverified" };
}

export function createConnectionChecker(options: { probe?: typeof run; home?: string; clock?: () => Date; env?: NodeJS.ProcessEnv; verify?: (provider: KeyedProviderId, key: string) => Promise<KeyVerdict> } = {}): ConnectionChecker {
  const probe = options.probe ?? run;
  const verify = options.verify ?? ((provider: KeyedProviderId, key: string) => verifyProviderKey(provider, key));
  const home = options.home ?? homedir();
  const clock = options.clock ?? (() => new Date());
  const cache = new Map<ProviderId, { key: string; until: number; value: ProviderConnection }>();
  const pending = new Map<string, Promise<ProviderConnection>>();
  return async (provider, fresh = false) => {
    // An ACP agent is never run to ask how it is signed in (nothing executes it outside the gateway): what is known
    // of it is its conformance check, read elsewhere. Here it is simply unverified.
    if (isAcpProvider(provider)) return { state: "unverified", mode: "agent-login", checkedAt: clock().toISOString() };
    const mode = readAuthMode(provider, home);
    const keyFacts = keyStatus(provider, home);
    const ambient = !!(options.env ?? process.env)[PROVIDER_KEY_ENV[provider]];
    const key = JSON.stringify([provider, mode, keyFacts.set, keyFacts.updatedAt, ambient]);
    const now = clock();
    const existing = cache.get(provider);
    if (!fresh && existing?.key === key && existing.until > now.getTime()) return existing.value;
    const inFlight = pending.get(key); if (inFlight) return inFlight;
    const check = (async (): Promise<ProviderConnection> => {
      if (mode === "api-key") {
        // A saved key is tested only when asked (Check again, or just after it is saved): one small request to the provider, never a model.
        const stored = fresh && keyFacts.set ? readProviderKey(provider, home) : null;
        if (stored === null) return { state: keyFacts.set || ambient ? "key-present" : "missing-key", mode, checkedAt: now.toISOString() };
        const verdict = await verify(provider, stored);
        return { state: verdict.ok ? "key-works" : verdict.reason === "rejected" ? "key-refused" : "key-present", mode, checkedAt: clock().toISOString(), verdict };
      }
      const facts = inspectionOf(provider);
      const identityProbe = provider === "claude" ? ["auth", "status", "--json"] : facts.identityProbe;
      if (identityProbe === null) return { state: "unverified", mode, checkedAt: now.toISOString() };
      try {
        // Same subscription credential stripping as provider invocations.
        // No model prompt, repository scripts, or stored API keys are used.
        const result = await probe(facts.binary, [...identityProbe], { cwd: home, timeoutMs: 5000, maxBuffer: 32 * 1024, omitEnv: ALL_CREDENTIAL_ENV });
        return signInFacts(provider, result, clock());
      } catch { return { state: "unverified", mode, checkedAt: clock().toISOString() }; }
    })();
    pending.set(key, check);
    try {
      const value = await check;
      // Only cache against the same credential mode that began this check.
      // A slow subscription probe must not overwrite a newer API-key result.
      const currentKeyFacts = keyStatus(provider, home);
      const currentKey = JSON.stringify([provider, readAuthMode(provider, home), currentKeyFacts.set, currentKeyFacts.updatedAt, !!(options.env ?? process.env)[PROVIDER_KEY_ENV[provider]]]);
      if (currentKey === key) cache.set(provider, { key, until: value.verdict !== undefined ? Number.POSITIVE_INFINITY : clock().getTime() + 30_000, value });
      return value;
    }
    finally { pending.delete(key); }
  };
}
