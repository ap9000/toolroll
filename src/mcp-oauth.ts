/**
 * MCP sign-in: OAuth 2.1 for /mcp, as the MCP authorization spec describes, so an engineer's MCP client connects
 * without a pasted token. This console is both the authorization server and the protected resource.
 *
 *   /mcp's 401 names /.well-known/oauth-protected-resource/mcp (RFC 9728), which names this console's
 *   /.well-known/oauth-authorization-server (RFC 8414). A client registers itself (RFC 7591, public clients only),
 *   sends the person to /oauth/authorize with a S256 PKCE challenge and resource=<origin>/mcp, and trades the code
 *   at /oauth/token for a short-lived access token and a refresh secret that rotates on every use.
 *
 * The person signs in with the console's own sign-in (password or identity provider, unchanged), then consents on
 * one page: read or act, and which of their projects, confirmed with their password or a fresh provider check, the
 * same step-up as making an API token. Nothing is granted without that form, its session CSRF value and a same-site
 * post.
 *
 * A grant is an ordinary API token (api-tokens.ts): its access token is `so_<id>_<secret>`, it is listed and revoked
 * with every other token (console Sessions & tokens, `toolroll tokens`), and /mcp runs it through the same person
 * path. Its v113 binding (store.oauthGrant) adds what an ordinary token doesn't have: it works only at /mcp, its
 * access secret lasts an hour, it is tied to the account generation that consented, and it reaches only the projects
 * chosen (still intersected with the person's live access on every call). Only hashes are kept: of codes, access
 * secrets and refresh secrets. Approvals, people and policy are never reachable: those have no tool and no scope.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.js";
import { hashSecret, mintApiToken, type TokenAccess } from "./api-tokens.js";
import { PKCE_CHALLENGE, readOAuthRegistration, readOAuthTokenRequest } from "./contracts/mcp-oauth.js";

/** How long each piece lives. A code is spent at once; a grant ends after 30 days and the person consents again. */
export const OAUTH_TIMES = { requestMs: 10 * 60_000, codeMs: 60_000, accessSeconds: 3600, grantDays: 30 } as const;
/** The most sign-ins waiting at once, and registered clients kept. */
const MAX_REQUESTS = 200, MAX_CLIENTS = 500;
/** The most a registration or form body may be. */
const MAX_BODY = 16 * 1024;
export const OAUTH_SCOPES = ["read", "act"] as const;
const REFRESH_SHAPE = /^sor_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

export const RESOURCE_PATH = "/mcp";
export const resourceMetadataUrl = (origin: string): string => `${origin}/.well-known/oauth-protected-resource${RESOURCE_PATH}`;

// ---- what a bearer may do -------------------------------------------------------------------------------------------

/**
 * Whether an API token may sign in to this request's path now. An ordinary token: yes (its own checks are elsewhere).
 * An MCP sign-in's token: only at /mcp, only while its access secret is fresh and the account is at the generation
 * that consented.
 */
export function oauthTokenAllowed(store: Store, tokenId: string, path: string, now: Date): boolean {
  const grant = store.oauthGrant(tokenId);
  if (grant === null) return true;
  if (path !== RESOURCE_PATH || Date.parse(grant.accessExpiresAt) <= now.getTime()) return false;
  const account = store.accountOf(grant.account);
  return account !== null && account.revokedAt === null && account.generation === grant.generation;
}

/** The projects an MCP sign-in's token was granted (the person's live access still applies), or null for an ordinary token. */
export const oauthProjects = (store: Store, tokenId: string): string[] | null => store.oauthGrant(tokenId)?.projects ?? null;

// ---- the HTTP side --------------------------------------------------------------------------------------------------

export type OAuthSession = { name: string; role: "approver" | "viewer"; csrf: string;
  /** Signed in with an identity provider: its name, and whether it checked the person in the last ten minutes. */
  sso: { label: string; fresh: boolean } | null };

export type OAuthHttpOptions = {
  store: Store;
  clock: () => Date;
  /** This console's canonical origin for the request (the https public address, or this computer's loopback one); null: no sign-in here. */
  originOf: (request: IncomingMessage) => string | null;
  /** The browser session signed in by cookie, or null. A bearer never consents. */
  session: (request: IncomingMessage) => OAuthSession | null;
  /** A posted form came from a page of this console (its Origin, or Referer, names an allowed host). */
  sameSite: (request: IncomingMessage) => boolean;
  /** The step-up: the person's password, or (empty) a fresh identity-provider check. */
  confirm: (session: OAuthSession, typed: string) => boolean;
  /** The projects this person may choose: each a project the server knows that they can use now. */
  projectsFor: (account: string) => string[];
};

type Waiting = { client: string; redirectUri: string; challenge: string; state: string | null; resource: string; act: boolean; expires: number };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const escape = (text: string) => text.replace(/[&<>"']/g, one => `&#${one.charCodeAt(0)};`);
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A redirect a client may register: https anywhere, or http on 127.0.0.1 / [::1] (RFC 8252 §7.3), with no
 * credentials or fragment.
 */
export function redirectAllowed(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username !== "" || url.password !== "" || value.includes("#")) return false;
  return url.protocol === "https:" || url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** A redirect matches a registered one exactly; on a loopback http address any port does (RFC 8252 §7.3). */
export function redirectMatches(presented: string, registered: readonly string[]): string | null {
  if (registered.includes(presented)) return presented;
  let url: URL;
  try { url = new URL(presented); } catch { return null; }
  if (url.protocol !== "http:" || !redirectAllowed(presented)) return null;
  for (const one of registered) {
    const kept = new URL(one);
    if (kept.protocol === "http:" && kept.hostname === url.hostname && kept.pathname === url.pathname && kept.search === url.search) return presented;
  }
  return null;
}

export function createOAuthHttp(options: OAuthHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  const { store } = options;
  const waiting = new Map<string, Waiting>();

  const json = (response: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", "x-content-type-options": "nosniff", ...headers });
    response.end(JSON.stringify(body));
  };
  const oauthError = (response: ServerResponse, status: number, error: string, description: string): void => json(response, status, { error, error_description: description });

  /** A page of this sign-in: script-free, never framed, posting only to this console. */
  const page = (response: ServerResponse, status: number, html: string): void => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(html);
  };
  /**
   * On to an address by a page that moves on by itself, never a redirect: a redirect answering a form is held to
   * the consent page's form-action 'self', so the browser would stop it on the way to the client. Also how a
   * sign-in that arrived from another app reaches this console's own pages with the session cookie (SameSite=Strict).
   */
  const moveOn = (response: ServerResponse, to: string, words: string): void => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escape(to)}"><title>Toolroll</title>${STYLE}<main><p>${escape(words)} <a href="${escape(to)}">Continue</a></p></main></html>`);
  };
  const problemPage = (response: ServerResponse, status: number, title: string, said: string): void =>
    page(response, status, shell(title, `<h1>${escape(title)}</h1><p>${escape(said)}</p>`));

  /** Back to the client with an answer: the code, or an error, and its state; `iss` names this console (RFC 9207). */
  const backToClient = (response: ServerResponse, origin: string, redirectUri: string, state: string | null, answer: Record<string, string>, words: string): void => {
    const to = new URL(redirectUri);
    for (const [key, value] of Object.entries(answer)) to.searchParams.set(key, value);
    if (state !== null) to.searchParams.set("state", state);
    to.searchParams.set("iss", origin);
    moveOn(response, to.toString(), words);
  };

  const readBody = async (request: IncomingMessage): Promise<string | null> => {
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > MAX_BODY) return null;
      chunks.push(bytes);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return null; }
  };
  const media = (request: IncomingMessage) => String(request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();

  const prune = (now: number): void => {
    for (const [id, one] of waiting) if (one.expires <= now) waiting.delete(id);
    while (waiting.size >= MAX_REQUESTS) waiting.delete(waiting.keys().next().value!);
  };

  // ---- discovery ----

  const resourceMetadata = (origin: string) => ({
    resource: `${origin}${RESOURCE_PATH}`, authorization_servers: [origin], scopes_supported: [...OAUTH_SCOPES], bearer_methods_supported: ["header"], resource_name: "Toolroll",
  });
  const serverMetadata = (origin: string) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });

  // ---- registration ----

  async function register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") return oauthError(response, 405, "invalid_request", "Register with a POST.");
    if (media(request) !== "application/json") return oauthError(response, 400, "invalid_client_metadata", "Send the client's metadata as application/json.");
    const text = await readBody(request);
    if (text === null) return oauthError(response, 400, "invalid_client_metadata", "The registration is over 16 KiB.");
    let body: unknown;
    try { body = JSON.parse(text); } catch { return oauthError(response, 400, "invalid_client_metadata", "Send JSON."); }
    const read = readOAuthRegistration(body);
    if (!read.ok) {
      const redirects = read.issues.some(one => one.path.startsWith("redirect_uris"));
      return oauthError(response, 400, redirects ? "invalid_redirect_uri" : "invalid_client_metadata", read.issues.map(one => one.line).join("; ").slice(0, 300));
    }
    const redirects = [...new Set(read.value.redirect_uris)];
    if (!redirects.every(redirectAllowed)) return oauthError(response, 400, "invalid_redirect_uri", "Redirects are https, or http on 127.0.0.1 or [::1], with no fragment or credentials.");
    if (read.value.grant_types !== undefined && !read.value.grant_types.includes("authorization_code")) return oauthError(response, 400, "invalid_client_metadata", "This server issues codes: include authorization_code.");
    const name = clean(read.value.client_name ?? "") || "MCP client";
    const now = options.clock();
    const kept = store.registerOAuthClient({ id: randomBytes(16).toString("hex"), name, redirectUris: redirects }, now, MAX_CLIENTS);
    if (kept === null) return oauthError(response, 503, "temporarily_unavailable", "Too many clients are registered right now. Try again tomorrow.");
    return json(response, 201, {
      client_id: kept.id, client_id_issued_at: Math.floor(Date.parse(kept.createdAt) / 1000), client_name: kept.name, redirect_uris: kept.redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    });
  }

  // ---- the sign-in and consent ----

  function authorizeStart(request: IncomingMessage, response: ServerResponse, url: URL, origin: string): void {
    const params = url.searchParams;
    for (const key of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope"]) {
      if (params.getAll(key).length > 1) return problemPage(response, 400, "This sign-in link isn't valid", "Start again from your MCP client.");
    }
    const client = store.oauthClient(params.get("client_id") ?? "");
    const redirectUri = client === null ? null : redirectMatches(params.get("redirect_uri") ?? "", client.redirectUris);
    // Until the client and its redirect are proved, nothing goes back to any address.
    if (client === null || redirectUri === null) return problemPage(response, 400, "This sign-in link isn't valid", "Your MCP client isn't registered here, or asked to return somewhere it didn't register. Start again from the client.");
    const state = params.get("state");
    const fail = (error: string, description: string) => backToClient(response, origin, redirectUri, state !== null && state.length <= 1024 ? state : null, { error, error_description: description }, "Returning to your MCP client…");
    if (state !== null && (state.length > 1024 || /[\u0000-\u001f]/.test(state))) return fail("invalid_request", "state is too long");
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "only code is supported");
    if (params.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE.test(params.get("code_challenge") ?? "")) return fail("invalid_request", "PKCE with S256 is required");
    if (params.get("resource") !== `${origin}${RESOURCE_PATH}`) return fail("invalid_target", `resource must be ${origin}${RESOURCE_PATH}`);
    const scopes = (params.get("scope") ?? "").split(" ").filter(one => one !== "");
    if (!scopes.every(one => (OAUTH_SCOPES as readonly string[]).includes(one))) return fail("invalid_scope", "scopes are read and act");
    const now = Date.now();
    prune(now);
    const id = randomBytes(24).toString("base64url");
    waiting.set(id, { client: client.id, redirectUri, challenge: params.get("code_challenge")!, state, resource: `${origin}${RESOURCE_PATH}`, act: scopes.includes("act"), expires: now + OAUTH_TIMES.requestMs });
    return moveOn(response, `/oauth/authorize?request=${id}`, "Opening Toolroll…");
  }

  const consentHtml = (session: OAuthSession, id: string, one: Waiting, problem: string | null, chosen: { access: TokenAccess; projects: string[] } | null): string => {
    const client = store.oauthClient(one.client)!;
    const host = new URL(one.redirectUri).host;
    const projects = options.projectsFor(session.name);
    const mayAct = session.role === "approver";
    const access: TokenAccess = chosen?.access ?? (one.act && mayAct ? "act" : "read");
    const checked = new Set(chosen?.projects ?? []);
    const title = `Allow ${client.name} to use Toolroll?`;
    const projectList = projects.length === 0 ? "" : projects.map(path => {
      const name = path.split("/").filter(part => part !== "").pop() ?? path;
      return `<label class="pick"><input type="checkbox" name="project" value="${escape(path)}"${checked.has(path) ? " checked" : ""}><span><b>${escape(name)}</b><small>${escape(path)}</small></span></label>`;
    }).join("");
    const step = session.sso?.fresh === true
      ? `<p class="meta">Confirmed with ${escape(session.sso.label)}.</p><input type="hidden" name="password" value="">`
      : `<label class="field">Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>${session.sso === null ? "" : `<p class="meta"><a href="/login/sso?reauth=1&amp;return=${escape(encodeURIComponent(`/oauth/authorize?request=${id}`))}">Confirm with ${escape(session.sso.label)}</a> instead.</p>`}`;
    const body = [
      `<h1>${escape(title)}</h1>`,
      `<p class="client"><b>${escape(client.name)}</b> <span class="tag">unverified</span> <span class="meta">returns to ${escape(host)}</span></p>`,
      problem === null ? "" : `<div class="problem" role="alert">${escape(problem)}</div>`,
      projects.length === 0
        ? `<p>You don't have access to any projects yet, so there's nothing to allow. Ask whoever runs Toolroll to add you to one.</p>`
          + `<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button name="decision" value="deny" class="secondary">Cancel</button></form>`
        : [
          `<p>It will run Toolroll commands as you, ${escape(session.name)}, in the projects you choose, until you revoke it in Settings → Sessions &amp; tokens. It can't approve work or change people or policy.</p>`,
          `<form method="post" action="/oauth/authorize">`,
          `<input type="hidden" name="request" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(session.csrf)}">`,
          `<fieldset><legend>Access</legend>`,
          `<label class="pick"><input type="radio" name="access" value="read"${access === "read" ? " checked" : ""}><span><b>Read</b><small>See tasks, results and status.</small></span></label>`,
          mayAct ? `<label class="pick"><input type="radio" name="access" value="act"${access === "act" ? " checked" : ""}><span><b>Act</b><small>Also file tasks under your name. Approving stays with you in the console or chat.</small></span></label>` : `<p class="meta">Your account can watch, so the client can only read.</p>`,
          `</fieldset>`,
          `<fieldset><legend>Projects</legend>${projectList}</fieldset>`,
          step,
          `<div class="actions"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny" class="secondary" formnovalidate>Cancel</button></div>`,
          `</form>`,
        ].join(""),
      `<details><summary>Client details</summary><p class="meta">Client ID <code>${escape(client.id)}</code><br>Returns to <code>${escape(one.redirectUri)}</code><br>Toolroll doesn't know who made this client; its name is what it says about itself.</p></details>`,
    ].join("");
    return shell(title, body);
  };

  async function authorizeConsent(request: IncomingMessage, response: ServerResponse, url: URL, origin: string): Promise<void> {
    const now = options.clock();
    if (request.method === "GET" || request.method === "HEAD") {
      const id = url.searchParams.get("request") ?? "";
      const one = waiting.get(id);
      if (one === undefined || one.expires <= Date.now()) return problemPage(response, 410, "This sign-in has expired", "Start again from your MCP client.");
      const session = options.session(request);
      if (session === null) {
        response.writeHead(303, { location: `/login?return=${encodeURIComponent(`/oauth/authorize?request=${id}`)}`, "cache-control": "no-store" });
        return void response.end();
      }
      return page(response, 200, consentHtml(session, id, one, null, null));
    }
    if (request.method !== "POST") return problemPage(response, 405, "This sign-in isn't valid", "Start again from your MCP client.");
    const session = options.session(request);
    if (session === null) return problemPage(response, 403, "Sign in first", "Your console session ended. Start again from your MCP client.");
    if (media(request) !== "application/x-www-form-urlencoded") return problemPage(response, 400, "This form isn't valid", "Start again from your MCP client.");
    const text = await readBody(request);
    const form = new URLSearchParams(text ?? "");
    // The person's own act: their session's CSRF value, posted from this console's own page.
    if (text === null || !options.sameSite(request) || !same(form.get("csrf") ?? "", session.csrf)) return problemPage(response, 403, "This form expired", "Nothing was allowed. Start again from your MCP client.");
    const id = form.get("request") ?? "";
    const one = waiting.get(id);
    if (one === undefined || one.expires <= Date.now()) return problemPage(response, 410, "This sign-in has expired", "Nothing was allowed. Start again from your MCP client.");
    const client = store.oauthClient(one.client);
    if (client === null || redirectMatches(one.redirectUri, client.redirectUris) === null) { waiting.delete(id); return problemPage(response, 400, "This client is no longer registered", "Nothing was allowed. Start again from your MCP client."); }
    if (form.get("decision") !== "allow") {
      waiting.delete(id);
      return backToClient(response, origin, one.redirectUri, one.state, { error: "access_denied", error_description: "the person declined" }, "Cancelled. Returning to your MCP client…");
    }
    const account = store.accountOf(session.name);
    if (account === null || account.revokedAt !== null) return problemPage(response, 403, "Sign in first", "Your account can't sign in. Nothing was allowed.");
    const access: TokenAccess = form.get("access") === "act" ? "act" : "read";
    const chosen = [...new Set(form.getAll("project"))];
    const again = (status: number, problem: string) => page(response, status, consentHtml(session, id, one, problem, { access, projects: chosen }));
    if (access === "act" && account.role !== "approver") return again(403, "Your account can watch, so the client can only read.");
    const mine = options.projectsFor(session.name);
    if (chosen.length === 0) return again(400, "Choose at least one project.");
    // Never named back: a project outside the person's access is refused without saying whether it exists.
    if (!chosen.every(path => mine.includes(path))) return again(403, "Choose from your own projects.");
    if (!options.confirm(session, form.get("password") ?? "")) return again(403, "Enter your Toolroll password to allow access.");
    waiting.delete(id);
    const code = randomBytes(32).toString("base64url");
    store.saveOAuthCode(sha256(code), { client: client.id, account: session.name, generation: account.generation, access, projects: chosen, redirectUri: one.redirectUri, resource: one.resource,
      challenge: one.challenge, expiresAt: new Date(now.getTime() + OAUTH_TIMES.codeMs).toISOString() });
    return backToClient(response, origin, one.redirectUri, one.state, { code }, "Allowed. Returning to your MCP client…");
  }

  // ---- tokens ----

  async function token(request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> {
    if (request.method !== "POST") return oauthError(response, 405, "invalid_request", "Use POST.");
    if (media(request) !== "application/x-www-form-urlencoded") return oauthError(response, 400, "invalid_request", "Send application/x-www-form-urlencoded.");
    const text = await readBody(request);
    if (text === null) return oauthError(response, 400, "invalid_request", "The request is over 16 KiB.");
    const read = readOAuthTokenRequest(new URLSearchParams(text));
    if (!read.ok) {
      const unsupported = !("repeated" in read) && read.issues.some(one => one.path === "grant_type");
      return unsupported ? oauthError(response, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.") : oauthError(response, 400, "invalid_request", "The token request isn't complete.");
    }
    const ask = read.value;
    const now = options.clock();
    const resource = `${origin}${RESOURCE_PATH}`;
    if (ask.resource !== undefined && ask.resource !== resource) return oauthError(response, 400, "invalid_target", `resource must be ${resource}`);
    const client = store.oauthClient(ask.client_id);
    if (client === null) return oauthError(response, 401, "invalid_client", "This client isn't registered here.");
    const invalid = () => oauthError(response, 400, "invalid_grant", "This sign-in is no longer valid. Sign in again from your MCP client.");
    /** The projects still in the person's reach, of those granted; a grant that reaches none is over. */
    const reachable = (account: string, projects: readonly string[]) => { const mine = options.projectsFor(account); return projects.filter(path => mine.includes(path)); };

    if (ask.grant_type === "authorization_code") {
      const codeHash = sha256(ask.code);
      const taken = store.takeOAuthCode(codeHash, now);
      if (taken === null) return invalid();
      // A code spent twice: whatever it made ends too (RFC 6749 §4.1.2).
      if ("used" in taken) { if (taken.used !== null) store.revokeApiToken(taken.used, "toolroll", now, "its sign-in code was used twice"); return invalid(); }
      const code = taken.taken;
      const proof = createHash("sha256").update(ask.code_verifier, "ascii").digest("base64url");
      if (code.client !== client.id || code.redirectUri !== ask.redirect_uri || code.resource !== resource || !same(proof, code.challenge)) return invalid();
      const account = store.accountOf(code.account);
      if (account === null || account.revokedAt !== null || account.generation !== code.generation) return invalid();
      if (code.access === "act" && account.role !== "approver") return invalid();
      if (reachable(code.account, code.projects).length === 0) return invalid();
      const minted = mintApiToken();
      const refresh = randomBytes(32).toString("base64url");
      const accessExpiresAt = new Date(now.getTime() + OAUTH_TIMES.accessSeconds * 1000).toISOString();
      store.createOAuthGrant(codeHash, { id: minted.id, account: code.account, name: `MCP: ${client.name}`.slice(0, 60), secretHash: minted.hash, access: code.access, expiresAt: new Date(now.getTime() + OAUTH_TIMES.grantDays * 86_400_000).toISOString() },
        { client: client.id, account: code.account, generation: code.generation, projects: code.projects, resource, accessExpiresAt, refreshHash: hashSecret(refresh) }, now);
      return json(response, 200, { access_token: minted.token, token_type: "Bearer", expires_in: OAUTH_TIMES.accessSeconds, refresh_token: `sor_${minted.id}_${refresh}`, scope: code.access });
    }

    const parsed = REFRESH_SHAPE.exec(ask.refresh_token);
    if (parsed === null) return invalid();
    const [, id, secret] = parsed as unknown as [string, string, string];
    const grant = store.oauthGrant(id);
    const kept = store.apiTokenSecret(id)?.row ?? null;
    if (grant === null || kept === null || grant.client !== client.id) return invalid();
    const presented = hashSecret(secret);
    const end = (why: string) => { store.revokeApiToken(id, "toolroll", now, why); return invalid(); };
    // A refresh secret used again after it rotated: someone else has it. The whole grant ends.
    if (grant.priorRefreshHash !== null && same(presented, grant.priorRefreshHash)) return end("its refresh secret was used twice");
    if (!same(presented, grant.refreshHash)) return invalid();
    if (kept.revokedAt !== null || Date.parse(kept.expiresAt) <= now.getTime()) return invalid();
    const account = store.accountOf(grant.account);
    if (account === null || account.revokedAt !== null || account.generation !== grant.generation) return end("the person's sign-in changed");
    if (reachable(grant.account, grant.projects).length === 0) return end("its projects are no longer the person's");
    if (ask.scope !== undefined && !ask.scope.split(" ").every(one => one === kept.access || one === "read")) return oauthError(response, 400, "invalid_scope", "A refresh can't widen access.");
    const accessSecret = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const accessExpiresAt = new Date(now.getTime() + OAUTH_TIMES.accessSeconds * 1000).toISOString();
    if (!store.rotateOAuthGrant(id, grant.refreshHash, { refreshHash: hashSecret(refresh), accessHash: hashSecret(accessSecret), accessExpiresAt })) return invalid();
    return json(response, 200, { access_token: `so_${id}_${accessSecret}`, token_type: "Bearer", expires_in: OAUTH_TIMES.accessSeconds, refresh_token: `sor_${id}_${refresh}`, scope: kept.access });
  }

  /** Handles the sign-in's addresses; false for any other path. */
  return async (request, response, url) => {
    const path = url.pathname;
    const discovery = path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${RESOURCE_PATH}` || path === "/.well-known/oauth-authorization-server";
    if (!discovery && !path.startsWith("/oauth/")) return false;
    const origin = options.originOf(request);
    if (origin === null) {
      request.resume();
      if (discovery || path !== "/oauth/authorize") { oauthError(response, 404, "invalid_request", "MCP sign-in needs this console's https public address (--public-url)."); return true; }
      problemPage(response, 404, "MCP sign-in isn't available at this address", "Open Toolroll at its public https address.");
      return true;
    }
    if (discovery) {
      if (request.method !== "GET" && request.method !== "HEAD") { oauthError(response, 405, "invalid_request", "Use GET."); return true; }
      json(response, 200, path.startsWith("/.well-known/oauth-protected-resource") ? resourceMetadata(origin) : serverMetadata(origin), { "cache-control": "public, max-age=300" });
      return true;
    }
    if (path === "/oauth/register") { await register(request, response); return true; }
    if (path === "/oauth/token") { await token(request, response, origin); return true; }
    if (path === "/oauth/authorize") {
      if ((request.method === "GET" || request.method === "HEAD") && !url.searchParams.has("request")) authorizeStart(request, response, url, origin);
      else await authorizeConsent(request, response, url, origin);
      return true;
    }
    request.resume();
    oauthError(response, 404, "invalid_request", "No such address.");
    return true;
  };
}

/** The sign-in's pages stand alone: no stylesheet, script or font loads here, so the palette rides inline. */
const STYLE = [
  `<style>`,
  `:root{color-scheme:light dark;--ground:#efefef;--paper:#fff;--ink:#171717;--muted:#666;--line:#e6e6e6;--soft:#f2f2f2;--accent:#171717;--on-accent:#fff;--problem:#b42318}`,
  `@media (prefers-color-scheme:dark){:root{--ground:#0b0b0b;--paper:#161616;--ink:#ededed;--muted:#a1a1a1;--line:#262626;--soft:#1f1f1f;--accent:#ededed;--on-accent:#0b0b0b;--problem:#ff8a80}}`,
  `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--ground);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}`,
  `main{width:100%;max-width:520px;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:28px}`,
  `.mark{font-weight:600;color:var(--muted);margin:0 0 16px}h1{font-size:19px;line-height:1.35;margin:0 0 10px;overflow-wrap:anywhere}p{margin:0 0 14px}`,
  `.client{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:baseline;overflow-wrap:anywhere}.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}`,
  `.meta,small{color:var(--muted);font-size:13px}fieldset{border:0;margin:0 0 16px;padding:0}legend{font-weight:600;margin-bottom:6px}`,
  `.pick{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;cursor:pointer;min-height:44px}`,
  `.pick input{margin-top:4px;width:18px;height:18px;flex:none}.pick span{display:flex;flex-direction:column;min-width:0}.pick small{overflow-wrap:anywhere}`,
  `.field{display:flex;flex-direction:column;gap:6px;font-weight:600;margin-bottom:14px}.field input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);min-height:44px}`,
  `.actions{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 0}button{font:inherit;font-weight:600;min-height:44px;padding:0 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer;white-space:nowrap}`,
  `button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #2563eb;outline-offset:2px}`,
  `form{margin:0 0 16px}`,
  `.problem{border:1px solid var(--problem);color:var(--problem);border-radius:8px;padding:10px 12px;margin-bottom:14px}a{color:inherit;text-underline-offset:3px}`,
  `details{border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;color:var(--muted);font-size:13px}code{font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace;background:var(--soft);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere}`,
  `@media (max-width:480px){main{padding:20px}.actions button{flex:1 1 auto}}`,
  `</style>`,
].join("");

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>${STYLE}</head><body><main><p class="mark">Toolroll</p>${body}</main></body></html>`;
