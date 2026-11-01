/** The first-account form's same-site gate and setup-code comparison (Settings revamp S3, Codex round 1).
 *
 * The form is signed out, so it has no session CSRF token. Instead, the page that shows it sets a signed, HttpOnly,
 * SameSite=Strict cookie scoped to /signup; a browser never sends it on a post from another site. A post must carry
 * it, and a present Sec-Fetch-Site or Origin must name this console. Opaque `Origin: null` is not refused here: the
 * console's own pages are `Referrer-Policy: no-referrer`, so their same-origin form posts send exactly that, and the
 * cookie carries the proof. A refusal here never spends a setup-code try. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SIGNUP_COOKIE = "so-signup";
const SECRET = randomBytes(32);
const NONCE = /^[A-Za-z0-9_-]{24}$/;
const macOf = (nonce: string): Buffer => createHmac("sha256", SECRET).update(`signup:${nonce}`).digest();

/** A fresh Set-Cookie value for the page that shows the form. */
export function signupCookie(secure: string): string {
  const nonce = randomBytes(18).toString("base64url");
  return `${SIGNUP_COOKIE}=${nonce}.${macOf(nonce).toString("base64url")}; HttpOnly; SameSite=Strict; Path=/signup${secure}`;
}

/** Whether this post came from the console's own first-account page. */
export function signupFromHere(request: IncomingMessage, allowedHost: (host: string | undefined) => boolean): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin, referer = request.headers.referer;
  const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
  if (named !== null && !allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) return false;
  const held = new RegExp(`(?:^|;\\s*)${SIGNUP_COOKIE}=([^;.]*)\\.([^;]*)`).exec(request.headers.cookie ?? "");
  if (held === null || !NONCE.test(held[1]!)) return false;
  const given = Buffer.from(held[2]!, "base64url"), wanted = macOf(held[1]!);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The typed code against the printed one, in constant time over fixed-length digests: any input (empty, too long,
 * non-ASCII) is an ordinary wrong code, never a throw. */
export function setupCodeMatches(typed: string, printed: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return typed !== "" && timingSafeEqual(digest(typed), digest(printed));
}
