/**
 * The browser mutation key (easy-start C2, amendment A1): the second factor every browser mutation carries on a
 * protected loopback install, beside the session's CSRF token.
 *
 * Why: cookies are not isolated by port (RFC 6265 §8.5). Any server on another port of this computer receives the
 * session cookie and can read every page, CSRF token included. So on a console that only this computer can reach, a
 * mutation also needs a key that lives only in the browser's storage for the console's own origin
 * (http://127.0.0.1:<port>): 32 random bytes per session, of which the server keeps only a hash and the console start
 * (key epoch) it was issued under. The key is delivered once, in a response that cannot be fetched again (a one-time
 * link, a password sign-in, an identity-provider finish, a password reconnect), by a no-store page whose one nonce'd
 * script writes it to localStorage and moves on. It is never rendered into a page or JSON.
 *
 * The key is bound to the console start (N3): a process that held the port while Toolroll was stopped could read the
 * saved key, so every restart mints a new epoch and every older key reads as "Toolroll restarted — reconnect".
 *
 * A protected loopback install: the console is bound to a loopback address only, with no --allow-host, no public URL
 * and no tailnet names. Everywhere else nothing here applies.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { html, htmlString, scriptElement } from "../html.js";
import { HANDOFF_STYLE } from "./http.js";
import type { Session, Who } from "./session.js";


/** The request header a fetch carries the key in. */
export const KEY_HEADER = "x-toolroll-key";
/** The form field a server-rendered form carries it in (not `key`: forms already use that for idempotency and API keys). */
export const KEY_FIELD = "toolroll-key";
/** A terminal socket offers `toolroll` (the protocol the server selects) and `toolroll.key.<key>` (never echoed back). */
export const KEY_PROTOCOL = "toolroll";
export const KEY_PROTOCOL_PREFIX = "toolroll.key.";
/** Where the browser keeps it: `{ epoch, key }` in the console origin's localStorage. */
export const KEY_STORAGE = "toolroll.key";
const KEY_SHAPE = /^[0-9a-f]{64}$/;

/** How a person gets a fresh key: their password again (a full session), or the terminal (a local owner). */
export type Reconnect = { kind: "password"; href: string } | { kind: "command"; command: string };
export type KeyRefusal = { status: 403 | 409; message: string; reconnect: Reconnect };

export const RESTARTED = "Toolroll restarted — reconnect to make changes.";
export const RESTARTED_LOCAL = "Toolroll restarted — run `toolroll open` to reconnect.";
export const NOT_CONNECTED = "This tab isn't connected to Toolroll — reconnect to make changes.";
export const NOT_CONNECTED_LOCAL = "This tab isn't connected to Toolroll — run `toolroll open` to reconnect.";

/** The page a request reads, without the workspace read's own parameters: where a reconnect comes back to. */
export function pagePathOf(url: URL): string {
  const page = new URL(url.pathname + url.search, "http://standing-orders.local");
  page.searchParams.delete("format");
  page.searchParams.delete("request");
  return page.pathname + page.search;
}

export const keyHashOf = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/** The one key a request presents (header, form field or socket protocol), or null for none, a malformed one, or two
 * different ones: two keys in one request is a smuggling attempt, never a preference. */
export function presentedKey(request: IncomingMessage, body: { getAll(name: string): string[] } | null): string | null {
  const found: string[] = [];
  const header = request.headers[KEY_HEADER];
  if (Array.isArray(header)) return null;
  if (typeof header === "string" && header !== "") found.push(header);
  if (body !== null) found.push(...body.getAll(KEY_FIELD).filter(one => one !== ""));
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols === "string") {
    for (const one of protocols.split(",").map(part => part.trim())) if (one.startsWith(KEY_PROTOCOL_PREFIX)) found.push(one.slice(KEY_PROTOCOL_PREFIX.length));
  }
  // The same key by two roads (a form's field and its fetch's header) is one key; two different keys is none.
  const distinct = [...new Set(found)];
  if (distinct.length !== 1) return null;
  const key = distinct[0]!;
  return KEY_SHAPE.test(key) ? key : null;
}

/** Constant-time: the presented key's hash against the session's. */
export function keyMatches(presented: string, hash: string | null): boolean {
  if (hash === null || !KEY_SHAPE.test(hash)) return false;
  const a = Buffer.from(keyHashOf(presented), "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BrowserKeys = {
  /** Whether mutations need the key now (a protected loopback install, with the key turned on for this console). */
  required(): boolean;
  /** The console's one browser origin (http://127.0.0.1:<port>) while required, else null. */
  canonicalHost(): string | null;
  /** The one mutation check: null to proceed, else the refusal (with how to reconnect). Bearer callers pass. */
  check(who: Who, request: IncomingMessage, body: { getAll(name: string): string[] } | null): KeyRefusal | null;
  /** A browser session whose key is from an earlier console start (or none at all) while the key is required. */
  stale(who: Who, back?: string): Reconnect | null;
  /** Gives a session being made (or reconnected) a fresh key: its hash and this start's epoch go on the session, the key
   * comes back to deliver once. Null while not required, or off the canonical origin (that origin's storage would hold it). */
  issue(session: Pick<Session, "keyEpoch" | "keyHash">, request: IncomingMessage): string | null;
  /** The no-store page that puts the key in this origin's storage and moves on to `to` (a same-site path). */
  deliver(response: ServerResponse, key: string, to: string, cookies?: readonly string[]): void;
};

export function createBrowserKeys(deps: {
  /** The console turned the key on (a real console start; tests and the demo leave it off unless they ask). */
  enabled: boolean;
  epoch: string;
  /** On a protected loopback install (bound to loopback only, no --allow-host, no public URL, no tailnet names), read
   * per request: the console's one browser host (`127.0.0.1:<port>`, or `[::1]:<port>` for an IPv6-only bind). Else null. */
  protectedHost: () => string | null;
}): BrowserKeys {
  const canonicalHost = (): string | null => deps.enabled ? deps.protectedHost() : null;
  const required = (): boolean => canonicalHost() !== null;
  // A refused post comes back to Home (its own address may answer only posts); a page's notice, to that page.
  const reconnectOf = (who: Extract<Who, { via: "cookie" }>, back = "/"): Reconnect => who.authority === "full"
    ? { kind: "password", href: back === "/" ? "/login/rekey" : `/login/rekey?return=${encodeURIComponent(back)}` }
    : { kind: "command", command: "toolroll open" };
  const stale = (who: Who, back?: string): Reconnect | null => {
    if (!required() || who.via !== "cookie") return null;
    const session = who.session;
    return session.keyEpoch !== deps.epoch || session.keyHash === null ? reconnectOf(who, back) : null;
  };
  return {
    required,
    canonicalHost,
    check(who, request, body) {
      if (!required() || who.via !== "cookie") return null;
      const local = who.authority !== "full";
      const reconnect = reconnectOf(who);
      if (stale(who) !== null) return { status: 409, message: local ? RESTARTED_LOCAL : RESTARTED, reconnect };
      const presented = presentedKey(request, body);
      if (presented === null || !keyMatches(presented, who.session.keyHash)) return { status: 403, message: local ? NOT_CONNECTED_LOCAL : NOT_CONNECTED, reconnect };
      return null;
    },
    stale,
    issue(session, request) {
      const canonical = canonicalHost();
      if (canonical === null || request.headers.host !== canonical) return null;
      const key = randomBytes(32).toString("hex");
      session.keyHash = keyHashOf(key);
      session.keyEpoch = deps.epoch;
      return key;
    },
    deliver(response, key, to, cookies = []) {
      const nonce = randomBytes(16).toString("base64");
      const target = /^\/(?![/\\])/.test(to) ? to : "/";
      // JSON inside a script: `<` escaped so nothing in it can close the element.
      const data = JSON.stringify({ storage: KEY_STORAGE, value: JSON.stringify({ epoch: deps.epoch, key }), to: target }).replace(/</g, "\\u003c");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        ...(cookies.length === 0 ? {} : { "set-cookie": [...cookies] }),
      });
      const script = `(function(){var d=${data};try{localStorage.setItem(d.storage,d.value)}catch(e){}location.replace(d.to)})();`;
      response.end(htmlString(html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Toolroll</title>${HANDOFF_STYLE}<p>Opening Toolroll… <a href="${target}">Continue</a></p>${scriptElement(script, { nonce })}</html>`));
    },
  };
}

/**
 * Every page that can post, while the key is required: fills the key into each same-origin POST form's data (the
 * `formdata` event fires for a native submit, requestSubmit(), submit() and `new FormData(form)` alike) and offers
 * `window.soKeyHeaders(headers)` to the page's own fetches. It reads nothing on the page and sends the key nowhere but
 * this origin. Without a stored key it does nothing, and the server answers "reconnect".
 */
export const KEY_FILL_SCRIPT = `(function(){if(window.soKeyHeaders)return;` +
  `function k(){try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(KEY_STORAGE)})||"null");return v&&typeof v.key==="string"&&/^[0-9a-f]{64}$/.test(v.key)?v.key:null}catch(e){return null}}` +
  `window.soKeyHeaders=function(h){h=h||{};var x=k();if(x)h[${JSON.stringify(KEY_HEADER)}]=x;return h};` +
  `document.addEventListener("formdata",function(e){var f=e.target;if(!f||String(f.method).toLowerCase()!=="post")return;` +
  `try{if(new URL(f.action,location.href).origin!==location.origin)return}catch(x){return}var x=k();if(x)e.formData.set(${JSON.stringify(KEY_FIELD)},x)},true);})();`;
