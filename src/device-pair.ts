/**
 * Browser-confirmed CLI device pairing (`toolroll connect <origin> --browser`).
 *
 * Eliminates manual token copy-paste without relaxing Toolroll's credential
 * authority model:
 * - CLI starts a short-lived (5 min), bounded, in-memory pairing session via
 *   `POST /api/connect/pair/start` (no browser headers, source-rate-limited).
 * - User opens `/connect/pair/<code>` in their browser, signs in as a full
 *   account, confirms the 8-character code, selects read/act scope, and proves
 *   their credential (`proveAccountNow(..., { credential: true })` — fresh
 *   password or SSO, never local-owner or remembered password).
 * - On confirmation, the server mints a normal `purpose: "api"` `so_...` token
 *   bounded to the account's current role & projects, and holds it strictly in
 *   memory for a single one-time delivery to `POST /api/connect/pair/poll`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mintApiToken } from "./api-tokens.js";
import { html, htmlString, postForm, scriptElement } from "./html.js";
import type { Admission } from "./request-budget.js";
import { credentialProof, freshFacts, proveAccountNow, type FreshFacts } from "./scope.js";
import { KEY_FILL_SCRIPT, type BrowserKeys } from "./server/mutation-key.js";
import { withFormToken } from "./server/request-context.js";
import type { Who } from "./server/session.js";
import type { Store } from "./store.js";

const PAIR_TTL_MS = 5 * 60_000;
const MAX_PENDING_PAIRS = 64;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_CODE_PATH = /^\/connect\/pair\/([A-Z2-9]{4}-[A-Z2-9]{4})$/;
const POLL_SECRET_RE = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 8 * 1024;
const FORBIDDEN_CLI_HEADERS = ["cookie", "origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];

type PairEntry = {
  userCode: string;
  pollSecret: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "approved";
  account: string | null;
  token: string | null;
};

export type DevicePairOptions = {
  store: Store;
  clock: () => Date;
  allowedHost: (host: string | undefined) => boolean;
  browserKeys: BrowserKeys;
  identify: (request: IncomingMessage, touch?: boolean, limited?: boolean) => Who | null;
  freshFactsOf: (request: IncomingMessage, who: Who | null) => FreshFacts | null;
  admitSource: (request: IncomingMessage) => Admission;
};

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, markup: ReturnType<typeof html>, fillKey = false): void {
  const nonce = fillKey ? randomBytes(16).toString("base64") : null;
  const raw = htmlString(markup);
  const body = nonce === null ? raw : raw.replace(/<\/body><\/html>$/, `${htmlString(scriptElement(KEY_FILL_SCRIPT, { nonce }))}</body></html>`);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline';${nonce === null ? "" : ` script-src 'nonce-${nonce}';`} form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function hasBrowserHeaders(request: IncomingMessage): boolean {
  const keys = Object.keys(request.headers).map(k => k.toLowerCase());
  return keys.some(k => FORBIDDEN_CLI_HEADERS.includes(k));
}

function generateUserCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (let i = 0; i < 8; i += 1) raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function readRawBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function createDevicePairHandlers(options: DevicePairOptions) {
  const { store, clock, allowedHost, browserKeys, identify, freshFactsOf, admitSource } = options;
  const entries = new Map<string, PairEntry>();

  const prune = (nowMs: number) => {
    for (const [code, entry] of entries) {
      if (entry.expiresAt <= nowMs) {
        entry.token = null;
        entries.delete(code);
      }
    }
  };

  /** POST /api/connect/pair/start — CLI starts a short-lived pairing session. */
  async function start(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    if (hasBrowserHeaders(request)) return sendJson(response, 400, { ok: false, error: "browser_headers_forbidden" });
    const budget = admitSource(request);
    if (!budget.ok) {
      const headers: Record<string, string> = {};
      if (budget.status !== 503) headers["retry-after"] = String(budget.retryAfter);
      return sendJson(response, budget.status === 503 ? 503 : 429, { ok: false, error: "rate-limited", message: "Too many pairing attempts. Try again shortly." }, headers);
    }
    // Drain any small body safely.
    await readRawBody(request, 1024);
    const nowMs = clock().getTime();
    prune(nowMs);
    if (entries.size >= MAX_PENDING_PAIRS) {
      return sendJson(response, 429, { ok: false, error: "too_many_pending", message: "Too many pending terminal pairings. Try again shortly." });
    }
    let userCode = generateUserCode();
    while (entries.has(userCode)) userCode = generateUserCode();
    const pollSecret = randomBytes(32).toString("hex");
    const expiresAt = nowMs + PAIR_TTL_MS;
    entries.set(userCode, {
      userCode,
      pollSecret,
      createdAt: nowMs,
      expiresAt,
      state: "pending",
      account: null,
      token: null,
    });
    return sendJson(response, 200, {
      ok: true,
      userCode,
      pollSecret,
      verificationPath: `/connect/pair/${userCode}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /** POST /api/connect/pair/poll — CLI polls with its pollSecret; delivers minted token at most once. */
  async function poll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    if (hasBrowserHeaders(request)) return sendJson(response, 400, { ok: false, error: "browser_headers_forbidden" });
    const raw = await readRawBody(request, 2048);
    if (raw === null) return sendJson(response, 413, { ok: false, error: "too_large" });
    let pollSecret = "";
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["pollSecret"] === "string") pollSecret = parsed["pollSecret"];
    } catch { return sendJson(response, 400, { ok: false, error: "bad_request" }); }
    if (!POLL_SECRET_RE.test(pollSecret)) return sendJson(response, 400, { ok: false, error: "bad_request" });

    const nowMs = clock().getTime();
    prune(nowMs);
    let matched: PairEntry | null = null;
    for (const entry of entries.values()) {
      if (safeEqualHex(entry.pollSecret, pollSecret)) matched = entry;
    }
    if (matched === null) return sendJson(response, 404, { ok: false, status: "expired", message: "Pairing expired or unknown. Start again." });
    if (matched.state === "pending") return sendJson(response, 200, { ok: true, status: "pending" });

    const account = matched.account;
    const token = matched.token;
    matched.token = null;
    entries.delete(matched.userCode);
    if (account === null || token === null) {
      return sendJson(response, 404, { ok: false, status: "expired", message: "Pairing was already claimed." });
    }
    return sendJson(response, 200, { ok: true, status: "approved", account, token });
  }

  function renderPage(code: string, who: Who & { via: "cookie" }, problem: string | null, done: boolean): ReturnType<typeof html> {
    const canAct = who.role === "approver";
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect terminal — Toolroll</title>
      <style>body{font-family:system-ui,-apple-system,sans-serif;background:#0c0e12;color:#f3f4f6;margin:0;padding:32px;display:flex;justify-content:center}main{max-width:440px;width:100%;background:#141821;border:1px solid #262c3a;border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 8px}.code{font-family:ui-monospace,monospace;font-size:28px;letter-spacing:3px;background:#0c0e12;border:1px solid #2e3648;border-radius:8px;padding:12px;text-align:center;margin:16px 0}label{display:block;font-size:13px;margin:12px 0 4px;color:#cbd5e1}input,select{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid #334155;background:#0c0e12;color:#f8fafc;font-size:14px}button{margin-top:16px;width:100%;padding:10px 14px;border-radius:8px;border:none;background:#38bdf8;color:#082f49;font-weight:600;font-size:14px;cursor:pointer}.err{background:#450a0a;border:1px solid #991b1b;color:#fecaca;padding:10px;border-radius:8px;font-size:13px;margin-bottom:12px}.ok{background:#052e16;border:1px solid #166534;color:#bbf7d0;padding:12px;border-radius:8px;font-size:14px}</style></head>
      <body><main>
        <h1>Connect a remote terminal</h1>
        <p style="font-size:13px;color:#94a3b8;margin:0 0 8px">Signed in as <strong>${who.name}</strong>. Confirm the code shown in your terminal to mint a personal API token.</p>
        <div class="code">${code}</div>
        ${problem !== null ? html`<p class="err" role="alert">${problem}</p>` : ""}
        ${done
          ? html`<p class="ok">Terminal connected. You can close this tab and return to your terminal.</p>`
          : withFormToken(who.session.csrf, () => postForm(`/connect/pair/${code}`, html`
              <label for="access">Access level</label>
              <select id="access" name="access">
                <option value="read">Read only (recommended)</option>
                ${canAct ? html`<option value="act">Read &amp; act (steer, revise, hand off, attach live terminals)</option>` : ""}
              </select>
              <label for="password">Confirm your Toolroll password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
              <button type="submit">Approve terminal connection</button>
            `))}
      </main></body></html>`;
  }

  /** GET /connect/pair/:code — browser confirmation page. */
  function page(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const match = PAIR_CODE_PATH.exec(url.pathname);
    if (match === null) return sendHtml(response, 404, html`<p>Unknown pairing code.</p>`);
    const code = match[1]!;
    const who = identify(request, false);
    if (who === null || who.via !== "cookie") {
      response.writeHead(303, { location: `/login?return=${encodeURIComponent(url.pathname)}`, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (who.authority !== "full") {
      return sendHtml(response, 403, html`<p>Set a password and sign in with a full browser session to connect remote terminals.</p>`);
    }
    const nowMs = clock().getTime();
    prune(nowMs);
    const entry = entries.get(code);
    if (entry === undefined || entry.state !== "pending") {
      return sendHtml(response, 404, html`<p>That terminal pairing code has expired or was already used. Run <code>toolroll connect --browser</code> again.</p>`);
    }
    return sendHtml(response, 200, renderPage(code, who, null, false), browserKeys.required());
  }

  /** POST /connect/pair/:code — fresh password/SSO step-up mints a personal API token for the pending CLI pairing. */
  async function confirm(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    const match = PAIR_CODE_PATH.exec(url.pathname);
    if (match === null) return sendHtml(response, 404, html`<p>Unknown pairing code.</p>`);
    const code = match[1]!;
    const who = identify(request, true);
    if (who === null || who.via !== "cookie" || who.authority !== "full") {
      return sendHtml(response, 403, html`<p>Sign in with a full browser session to approve a terminal connection.</p>`);
    }
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
    if (named === null || !allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) {
      return sendHtml(response, 403, html`<p>Same-origin confirmation required.</p>`);
    }
    const raw = await readRawBody(request, MAX_BODY_BYTES);
    if (raw === null) return sendHtml(response, 413, html`<p>Request too large.</p>`);
    const form = new URLSearchParams(raw);
    if (form.get("csrf") !== who.session.csrf) return sendHtml(response, 403, renderPage(code, who, "Invalid form token. Reload and try again.", false), browserKeys.required());
    const keyErr = browserKeys.check(who, request, form);
    if (keyErr !== null) return sendHtml(response, keyErr.status, renderPage(code, who, keyErr.message, false), browserKeys.required());

    const now = clock();
    prune(now.getTime());
    const entry = entries.get(code);
    if (entry === undefined || entry.state !== "pending") {
      return sendHtml(response, 404, html`<p>That terminal pairing code has expired or was already used.</p>`);
    }

    const password = form.get("password") ?? "";
    const proved = freshFacts.run(freshFactsOf(request, who), () => proveAccountNow(store, who.name, password, { credential: true }));
    if (!proved.ok || !credentialProof(proved.method)) {
      return sendHtml(response, 403, renderPage(code, who, "Password did not match. Nothing was connected.", false), browserKeys.required());
    }

    const account = store.accountOf(who.name);
    if (account === null || account.revokedAt !== null || account.generation !== who.session.generation) {
      return sendHtml(response, 401, html`<p>Your session has ended.</p>`);
    }
    const requestedAccess = form.get("access") === "act" && account.role === "approver" ? "act" : "read";
    const minted = mintApiToken();
    store.createApiToken({
      id: minted.id,
      account: who.name,
      name: `remote-tui-${code.toLowerCase()}`,
      secretHash: minted.hash,
      access: requestedAccess,
      purpose: "api",
      by: who.name,
      projects: account.projects,
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    }, now);

    entry.state = "approved";
    entry.account = who.name;
    entry.token = minted.token;

    store.recordAction({
      at: now.toISOString(),
      actor: who.name,
      repo: null,
      taskId: null,
      runId: null,
      action: "connect.pair.approved",
      outcome: "recorded",
      source: "sign-in",
      detail: `paired remote terminal (${requestedAccess}, token ${minted.id})`,
    });

    return sendHtml(response, 200, renderPage(code, who, null, true));
  }

  return { start, poll, page, confirm };
}
