/**
 * A Google account for email (v89): sign in with Google instead of an app
 * password, for Send email steps and Inbox triggers alike.
 *
 * The person makes an OAuth client in their own Google Cloud project (a
 * "Web application", with this console's callback as its redirect address)
 * and pastes its ID and secret into Settings → Email. Connecting sends them
 * to Google's consent screen; Google sends them back here with a one-time
 * code (checked against a state and a PKCE verifier made for that visit),
 * which becomes a refresh token. The client secret and refresh token are
 * kept by Toolroll (tool-secret-store.ts: the keychain, or an owner-only file
 * beside the database where there's none), never in a column, a log or a page.
 * Mail itself goes over IMAP and SMTP with XOAUTH2, so reading and sending
 * are the same code as for any other mail server.
 */
import { createHash, randomBytes } from "node:crypto";
import { SecretStoreError, readHeldSecret, writeHeldSecret } from "./tool-secret-store.js";

const HELD = { name: "google-mail", file: ["google-mail.json"] };
export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
/** Full mail access is what IMAP and SMTP sign-in needs; "email" says which address it is. */
export const GOOGLE_SCOPE = "https://mail.google.com/ openid email";
export const GOOGLE_CALLBACK = "/settings/google/callback";

export type GoogleMail = { clientId: string; clientSecret: string; refreshToken: string | null; address: string | null };

/** The saved client and connection; null when there's none. A keychain that refuses throws (SecretStoreError). */
export function readGoogleMail(dir: string | null): GoogleMail | null {
  if (dir === null) return null;
  const text = readHeldSecret(dir, HELD.name, HELD.file);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw === null || typeof raw["clientId"] !== "string" || typeof raw["clientSecret"] !== "string") return null;
    return { clientId: raw["clientId"], clientSecret: raw["clientSecret"], refreshToken: typeof raw["refreshToken"] === "string" ? raw["refreshToken"] : null, address: typeof raw["address"] === "string" ? raw["address"] : null };
  } catch { return null; }
}

/** Connected: a refresh token and the address it belongs to. */
export function googleConnected(dir: string | null): { address: string } | null {
  let saved: GoogleMail | null;
  try { saved = readGoogleMail(dir); } catch { saved = null; }
  return saved?.refreshToken && saved.address ? { address: saved.address } : null;
}

function write(dir: string, value: GoogleMail): void {
  writeHeldSecret(dir, HELD.name, HELD.file, JSON.stringify(value));
}

/** Save the OAuth client from Settings; an empty secret keeps the saved one. A new client forgets the old connection. */
export function saveGoogleClient(dir: string, input: { clientId: unknown; clientSecret: unknown }): { ok: true } | { ok: false; message: string } {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (!/^[0-9]{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/.test(clientId)) return { ok: false, message: "That doesn't look like a Google OAuth client ID. It ends in .apps.googleusercontent.com." };
  let before: GoogleMail | null;
  try { before = readGoogleMail(dir); } catch (error) { return { ok: false, message: error instanceof SecretStoreError ? error.message : "The saved client couldn't be read." }; }
  const clientSecret = typeof input.clientSecret === "string" && input.clientSecret.trim() !== "" ? input.clientSecret.trim() : before?.clientId === clientId ? before.clientSecret : "";
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(clientSecret)) return { ok: false, message: "Paste the client secret from the same OAuth client." };
  try { write(dir, { clientId, clientSecret, refreshToken: before?.clientId === clientId ? before.refreshToken : null, address: before?.clientId === clientId ? before.address : null }); }
  catch (error) { return { ok: false, message: error instanceof SecretStoreError ? error.message : "The client couldn't be saved." }; }
  return { ok: true };
}

export type GoogleVisit = { state: string; verifier: string; redirectUri: string; by: string; expires: number };

/** Where to send the person to consent, and what to remember to check their return against. */
export function googleConsent(client: GoogleMail, redirectUri: string, by: string, now = Date.now()): { url: string; visit: GoogleVisit } {
  const state = randomBytes(24).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, code_challenge: challenge, code_challenge_method: "S256",
  })}`;
  return { url, visit: { state, verifier, redirectUri, by, expires: now + 10 * 60_000 } };
}

const post = async (fetcher: typeof fetch, url: string, form: Record<string, string>) => {
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* an empty or broken answer */ }
  return { status: response.status, body };
};

/** The address an ID token names; it came straight from Google's token endpoint over TLS. */
function addressOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof claims["email"] === "string" && claims["email_verified"] !== false ? claims["email"] : null;
  } catch { return null; }
}

/** The one-time code from Google's redirect, exchanged for a refresh token and saved. */
export async function finishGoogleConsent(dir: string, visit: GoogleVisit, code: string, fetcher: typeof fetch): Promise<{ ok: true; address: string } | { ok: false; message: string }> {
  let client: GoogleMail | null;
  try { client = readGoogleMail(dir); } catch (error) { return { ok: false, message: error instanceof SecretStoreError ? error.message : "The saved client couldn't be read." }; }
  if (client === null) return { ok: false, message: "Save the Google OAuth client first." };
  let answer: Awaited<ReturnType<typeof post>>;
  try {
    answer = await post(fetcher, GOOGLE_TOKEN, { code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: visit.redirectUri, grant_type: "authorization_code", code_verifier: visit.verifier });
  } catch { return { ok: false, message: "Couldn't reach Google. Try connecting again." }; }
  const refresh = answer.body["refresh_token"], scope = String(answer.body["scope"] ?? "");
  if (answer.status !== 200 || typeof refresh !== "string") return { ok: false, message: `Google didn't connect it${typeof answer.body["error_description"] === "string" ? `: ${String(answer.body["error_description"]).slice(0, 160)}` : "."}` };
  if (!scope.split(" ").includes("https://mail.google.com/")) return { ok: false, message: "Google didn't allow mail access. Connect again and tick the box to read, compose, send and delete mail." };
  const address = addressOf(answer.body["id_token"]);
  if (address === null) return { ok: false, message: "Google didn't say which address this is. Connect again." };
  try { write(dir, { ...client, refreshToken: refresh, address }); }
  catch (error) { return { ok: false, message: error instanceof SecretStoreError ? error.message : "The connection couldn't be saved." }; }
  cached.delete(client.clientId);
  return { ok: true, address };
}

const cached = new Map<string, { token: string; until: number; refresh: string }>();

/** A fresh access token for IMAP and SMTP (kept in memory until a minute before it ends). */
export async function googleAccessToken(dir: string | null, fetcher: typeof fetch, now = Date.now()): Promise<{ ok: true; token: string; address: string } | { ok: false; said: string; permanent: boolean }> {
  let saved: GoogleMail | null;
  try { saved = readGoogleMail(dir); } catch (error) { return { ok: false, said: error instanceof SecretStoreError ? error.message : "The Google connection couldn't be read.", permanent: false }; }
  if (saved?.refreshToken == null || saved.address === null) return { ok: false, said: "The Google account isn't connected. Connect it in Settings → Email.", permanent: true };
  const hit = cached.get(saved.clientId);
  if (hit !== undefined && hit.refresh === saved.refreshToken && hit.until > now) return { ok: true, token: hit.token, address: saved.address };
  let answer: Awaited<ReturnType<typeof post>>;
  try {
    answer = await post(fetcher, GOOGLE_TOKEN, { client_id: saved.clientId, client_secret: saved.clientSecret, refresh_token: saved.refreshToken, grant_type: "refresh_token" });
  } catch { return { ok: false, said: "Couldn't reach Google to sign in.", permanent: false }; }
  const token = answer.body["access_token"];
  if (answer.status !== 200 || typeof token !== "string") {
    // invalid_grant: the person removed access, or the client changed. It won't fix itself.
    const lost = answer.body["error"] === "invalid_grant";
    return { ok: false, said: lost ? "Google no longer accepts this connection. Connect the account again in Settings → Email." : "Google didn't sign in just now.", permanent: lost };
  }
  cached.set(saved.clientId, { token, refresh: saved.refreshToken, until: now + Math.max(60, Number(answer.body["expires_in"]) || 3600) * 1000 - 60_000 });
  return { ok: true, token, address: saved.address };
}

/** Disconnect: Google forgets the grant (best effort), and the file goes. */
export async function disconnectGoogle(dir: string, fetcher: typeof fetch): Promise<void> {
  let saved: GoogleMail | null;
  try { saved = readGoogleMail(dir); } catch { saved = null; }
  if (saved?.refreshToken) {
    try { await fetcher(`${GOOGLE_REVOKE}?${new URLSearchParams({ token: saved.refreshToken })}`, { method: "POST", signal: AbortSignal.timeout(10_000) }); } catch { /* the file goes either way */ }
  }
  if (saved !== null) cached.delete(saved.clientId);
  writeHeldSecret(dir, HELD.name, HELD.file, null);
}
