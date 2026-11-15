/** Microsoft Teams through the Bot Framework REST surface: app credentials
 * kept in an owner-only file, an outbound token per call, and inbound
 * activities proved by the Bot Framework's signed token. No SDK. */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardTeams } from "./outbound-privacy.js";
import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { ChatDeliveryError, chatHash, withheldPart, type ChatIdentity } from "./chat-delivery-state.js";
import { chatObject as object } from "./chat-delivery.js";

export type TeamsCredentials = ChatIdentity & { tenant: string; secret: string };
export class TeamsError extends ChatDeliveryError {}
export const teamsCredentialFile = (dir: string) => join(dir, "teams-connection.json");
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const teamsGuid = (v: unknown): v is string => typeof v === "string" && GUID.test(v);
const validSecret = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._~-]{16,200}$/.test(v);

export function teamsIdentity(app: string, tenant: string): ChatIdentity {
  return { installation: chatHash(`teams:${app.toLowerCase()}:${tenant.toLowerCase()}`), team: tenant.toLowerCase(), app: app.toLowerCase(), bot: `28:${app.toLowerCase()}`, workspace: "Microsoft Teams" };
}
export function loadTeamsCredentials(dir: string): TeamsCredentials | null {
  try {
    const v = JSON.parse(readFileSync(teamsCredentialFile(dir), "utf8")) as TeamsCredentials;
    const identity = teamsGuid(v.app) && teamsGuid(v.tenant) ? teamsIdentity(v.app, v.tenant) : null;
    return identity !== null && validSecret(v.secret) && v.installation === identity.installation && v.bot === identity.bot ? { ...identity, tenant: identity.team!, secret: v.secret } : null;
  } catch {
    return null;
  }
}
export function saveTeamsCredentials(dir: string, value: TeamsCredentials): void {
  const target = teamsCredentialFile(dir), temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function clearTeamsCredentials(dir: string): void {
  rmSync(teamsCredentialFile(dir), { force: true });
}

const TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUERS = new Set(["https://api.botframework.com"]);
let cachedToken: { app: string; value: string; expires: number } | null = null;

/** A bot access token for outbound calls (client credentials), cached until shortly before expiry. */
export async function teamsAccessToken(credentials: Pick<TeamsCredentials, "app" | "secret">, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  if (cachedToken !== null && cachedToken.app === credentials.app && cachedToken.expires > now + 60_000) return cachedToken.value;
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.app, client_secret: credentials.secret, scope: "https://api.botframework.com/.default" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TeamsError("Microsoft sign-in is unreachable", 15_000, true);
  }
  if (response.status === 401 || response.status === 400) throw new TeamsError("Microsoft rejected the app credentials. Check the app id, tenant and secret.", 300_000);
  if (!response.ok) throw new TeamsError("Microsoft sign-in failed", 15_000, true);
  const data = object(await response.json().catch(() => ({})));
  if (typeof data.access_token !== "string") throw new TeamsError("Microsoft returned no access token", 15_000, true);
  cachedToken = { app: credentials.app, value: data.access_token, expires: now + Math.max(60, Number(data.expires_in ?? 3600)) * 1000 };
  return cachedToken.value;
}
export function forgetTeamsToken(): void { cachedToken = null; }

export type TeamsApi = (method: "GET" | "POST" | "PUT", serviceUrl: string, path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Outbound Bot Framework calls: only conversation routes, only under an https service URL Microsoft named in a signed token. */
export function teamsApi(credentials: TeamsCredentials, fetcher: typeof fetch = fetch): TeamsApi {
  // Every call passes the outbound privacy guard (outbound-privacy.ts) first.
  return guardTeams<TeamsApi>(async (method, serviceUrl, path, body) => {
    if (!/^\/v3\/conversations\/[A-Za-z0-9:@._%-]+(?:\/activities(?:\/[A-Za-z0-9:._%-]+)?|\/members(?:\/[A-Za-z0-9:._%-]+)?)$/.test(path)) throw new TeamsError("Invalid Teams request");
    let base: URL;
    try { base = new URL(serviceUrl); } catch { throw new TeamsError("Invalid Teams service URL"); }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new TeamsError("Invalid Teams service URL");
    const token = await teamsAccessToken(credentials, fetcher);
    let response: Response;
    try {
      response = await fetcher(`${base.origin}${base.pathname.replace(/\/$/, "")}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TeamsError("Teams is unreachable", 15_000, true);
    }
    if (response.status === 401) { forgetTeamsToken(); throw new TeamsError("Teams rejected the bot token", 30_000); }
    if (response.status === 429) throw new TeamsError("Teams asked to slow down", Math.max(5, Number(response.headers.get("retry-after") ?? 5)) * 1000);
    if (!response.ok) throw new TeamsError(`Teams refused the request (${response.status})`, 15_000, response.status >= 500);
    const text = await response.text();
    if (text.trim() === "") return {};
    try { return object(JSON.parse(text)); } catch { return {}; }
  }, withheldPart);
}

/** Confirm the app can sign in; the tenant and app id shape the installation identity. */
export async function checkTeamsCredentials(app: string, tenant: string, secret: string, fetcher: typeof fetch = fetch): Promise<TeamsCredentials> {
  if (!teamsGuid(app) || !teamsGuid(tenant)) throw new TeamsError("Enter the app (client) id and the directory (tenant) id from Microsoft Entra");
  if (!validSecret(secret)) throw new TeamsError("Enter the app's client secret");
  const identity = teamsIdentity(app, tenant);
  forgetTeamsToken();
  await teamsAccessToken({ app: identity.app, secret }, fetcher);
  return { ...identity, tenant: identity.team!, secret };
}

// ---- inbound proof ---------------------------------------------------------------

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; x5c?: string[]; endorsements?: string[] };
let keyCache: { fetched: number; keys: Jwk[] } | null = null;

async function signingKeys(fetcher: typeof fetch, now: number): Promise<Jwk[]> {
  if (keyCache !== null && keyCache.fetched + 86_400_000 > now) return keyCache.keys;
  const config = object(await (await fetcher(OPENID, { signal: AbortSignal.timeout(15_000) })).json());
  if (typeof config.jwks_uri !== "string" || !config.jwks_uri.startsWith("https://")) throw new TeamsError("Bot Framework key metadata is unavailable", 15_000, true);
  const jwks = object(await (await fetcher(config.jwks_uri, { signal: AbortSignal.timeout(15_000) })).json());
  const keys = Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : [];
  keyCache = { fetched: now, keys };
  return keys;
}
export function forgetTeamsKeys(): void { keyCache = null; }

const b64url = (value: string): Buffer => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export type TeamsClaims = { appId: string; serviceUrl: string | null };

/**
 * Prove an inbound activity came from the Bot Framework for this app: an
 * RS256 token from the Bot Framework issuer, for this app id, not expired,
 * signed by a published key. The serviceurl claim must match the activity
 * so a stolen token cannot redirect replies.
 */
export async function verifyTeamsToken(header: string | undefined, appId: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<TeamsClaims | null> {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (match === null) return null;
  let head: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    head = object(JSON.parse(b64url(match[1]!).toString("utf8")));
    claims = object(JSON.parse(b64url(match[2]!).toString("utf8")));
  } catch { return null; }
  if (head.alg !== "RS256" || typeof head.kid !== "string") return null;
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return null;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.some(one => typeof one === "string" && one.toLowerCase() === appId.toLowerCase())) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 300_000) return null;
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 300_000) return null;
  let keys: Jwk[];
  try { keys = await signingKeys(fetcher, now); } catch { return null; }
  let key = keys.find(one => one.kid === head.kid);
  if (key === undefined && keyCache !== null) { keyCache = null; try { key = (await signingKeys(fetcher, now)).find(one => one.kid === head.kid); } catch { return null; } }
  if (key === undefined || key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    const ok = verifySignature("RSA-SHA256", Buffer.from(`${match[1]}.${match[2]}`, "utf8"), publicKey, b64url(match[3]!));
    if (!ok) return null;
  } catch { return null; }
  return { appId, serviceUrl: typeof claims.serviceurl === "string" ? claims.serviceurl : null };
}
