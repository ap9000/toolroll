/**
 * A run's own sign-in for a service connected by signing in (mcp-connect.ts).
 *
 * The service's secrets are an access token and the refresh token that renews
 * it. A run never gets the refresh token. When it launches, Toolroll — outside
 * the fence — trades the refresh token for a fresh access token of the run's
 * own, no broader than the saved grant (a research step asks for only its read
 * scopes, where the service takes a narrower one), and only that access token
 * enters the run's broker. When the run ends the token is revoked, where the
 * service said how at sign-in, and otherwise runs out at its own expiry. A
 * service that gave no refresh token has only its one access token: the broker
 * holds it, as it holds an API key.
 */
import { SCOPE_TOKEN, readTokenResponse } from "./contracts/integration-metadata.js";
import type { ToolSpec } from "./contracts/integration-metadata.js";

/** The secrets a connected tool keeps: the bearer the MCP server takes, and what renewing it needs. */
export const ACCESS = "OAUTH_ACCESS_TOKEN", REFRESH = "OAUTH_REFRESH_TOKEN", CLIENT = "OAUTH_CLIENT_ID", CLIENT_SECRET = "OAUTH_CLIENT_SECRET",
  TOKEN_URL = "OAUTH_TOKEN_URL", EXPIRES = "OAUTH_EXPIRES_AT", RESOURCE = "OAUTH_RESOURCE";
/** The scope the sign-in granted, kept beside its token. Not one of the spec's secrets, so it never reaches a launch. */
export const GRANTED = "OAUTH_GRANTED_SCOPE";
/** Where the service revokes a token (RFC 7009), when its sign-in said. Not one of the spec's secrets either. */
export const REVOKE_URL = "OAUTH_REVOKE_URL";

/** A tool connected by signing in: a web tool whose sign-in is the access token. */
export const signedIn = (spec: Pick<ToolSpec, "transport" | "bearer">): boolean => spec.transport === "http" && spec.bearer === ACCESS;

/** Whether runs of a signed-in tool get their own token: only when there is a refresh token to make one with. */
export const mintsRunTokens = (values: Readonly<Record<string, string>> | readonly string[]): boolean => {
  const has = (name: string) => Array.isArray(values) ? values.includes(name) : ((values as Record<string, string>)[name] ?? "") !== "";
  return has(REFRESH) && has(TOKEN_URL) && has(CLIENT);
};

const loopback = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
/** A sign-in address Toolroll will send a token to: https, or a stand-in on this computer. */
export const signInAddress = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" || loopback(url); } catch { return false; }
};

/** Identity scopes a read-only grant may carry beside `<resource>:read` ones. */
const IDENTITY_SCOPES = new Set(["openid", "profile", "email"]);
const READ_SCOPE = /^[a-z][a-z0-9_]{0,63}:read$/;
export const readScope = (scope: string) => IDENTITY_SCOPES.has(scope) || READ_SCOPE.test(scope);
/** An OAuth `scope` value as scope tokens (RFC 6749), sorted and deduplicated; null when absent, empty or malformed. */
export function scopeList(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const tokens = value.split(" ").filter(one => one !== "");
  if (tokens.length === 0 || tokens.length > 512 || !tokens.every(one => SCOPE_TOKEN.test(one))) return null;
  return [...new Set(tokens)].sort();
}

/**
 * The scope a run asks for: none (the saved grant, never more) for a build; for a research step, only the grant's
 * read scopes when it has some and others besides. A grant never said is left as it is.
 */
export function runScope(granted: readonly string[] | null, readOnly: boolean): string[] | null {
  if (!readOnly || granted === null) return null;
  const reads = granted.filter(readScope);
  return reads.length > 0 && reads.length < granted.length ? reads : null;
}

const busy = new Map<string, Promise<unknown>>();
/**
 * One renewal of a sign-in at a time (per project and tool, in this process): a service that rotates its refresh
 * token on every use would otherwise see the same one twice, and whichever answer was saved last would be the
 * newest only by luck.
 */
export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const ran = (busy.get(key) ?? Promise.resolve()).then(work, work);
  const settled = ran.then(() => undefined, () => undefined);
  busy.set(key, settled);
  void settled.then(() => { if (busy.get(key) === settled) busy.delete(key); });
  return ran;
}

type Fetch = typeof fetch;

/** A run's token: the access token alone, its expiry, a rotated refresh token to keep, and how to revoke it. */
export type RunToken = { access: string; expires: string | null; rotated: string | null; revoke: (() => Promise<void>) | null };

/**
 * Trade the saved refresh token for an access token of this run's own. Plain reasons only: a service's answer is
 * never repeated, so no token can ride an error into a log or the run's record.
 */
export async function mintRunToken(values: Readonly<Record<string, string>>, options: { scope: readonly string[] | null; now: Date; fetcher?: Fetch }): Promise<{ ok: true; token: RunToken } | { ok: false; reason: string }> {
  const fetcher = options.fetcher ?? fetch;
  const refresh = values[REFRESH], tokenUrl = values[TOKEN_URL], client = values[CLIENT];
  if (!refresh || !client || !signInAddress(tokenUrl)) return { ok: false, reason: "its sign-in can't be renewed for this run; connect it again on the Tools page" };
  const ask = async (scope: readonly string[] | null) => {
    const answer = await fetcher(tokenUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: client,
        ...(values[CLIENT_SECRET] ? { client_secret: values[CLIENT_SECRET] } : {}), ...(values[RESOURCE] ? { resource: values[RESOURCE] } : {}),
        ...(scope === null ? {} : { scope: scope.join(" ") }) }) });
    let body: ReturnType<typeof readTokenResponse> = null;
    try { body = readTokenResponse(await answer.json()); } catch { body = null; }
    return { ok: answer.ok, body };
  };
  try {
    let answered = await ask(options.scope);
    // A service that won't narrow a grant on renewal gets asked for the grant as saved; the broker still offers the
    // step only its read-only actions.
    if (!answered.ok && options.scope !== null && answered.body?.error === "invalid_scope") answered = await ask(null);
    const access = answered.body?.access_token;
    if (!answered.ok || typeof access !== "string" || access === "") return { ok: false, reason: "its sign-in ran out; connect it again on the Tools page" };
    const body = answered.body!;
    const expires = body.expires_in === undefined ? null : new Date(options.now.getTime() + body.expires_in * 1000).toISOString();
    const rotated = typeof body.refresh_token === "string" && body.refresh_token !== "" && body.refresh_token !== refresh ? body.refresh_token : null;
    const revokeUrl = values[REVOKE_URL];
    const revoke = signInAddress(revokeUrl) ? async () => {
      try {
        const answer = await fetcher(revokeUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ token: access, token_type_hint: "access_token", client_id: client, ...(values[CLIENT_SECRET] ? { client_secret: values[CLIENT_SECRET] } : {}) }) });
        await answer.body?.cancel();
      } catch { /* it runs out at its own expiry */ }
    } : null;
    return { ok: true, token: { access, expires, rotated, revoke } };
  } catch {
    return { ok: false, reason: "its service couldn't be reached to sign this run in" };
  }
}
