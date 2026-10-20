/**
 * How a webhook proves who sent it (docs/plans/webhook-tasks.md §1). Each sender's check runs over the raw bytes,
 * before anything is parsed; a security header sent more than once, or not at all, is refused. Nothing here reads or
 * writes the store: the caller passes the current generation's secret, and a refusal writes nothing.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SENDERS } from "./contracts/flow.js";

export { WEBHOOK_SENDERS };
export type WebhookSender = (typeof WEBHOOK_SENDERS)[number];
/** The senders whose deliveries carry a signature (everything but `none`). */
export type SigningSender = Exclude<WebhookSender, "none">;

export const SENDER_WORDS: Record<WebhookSender, string> = {
  none: "Unsigned", standard: "Standard Webhooks", "github-style": "GitHub-style signature", sentry: "Sentry", vercel: "Vercel",
};

/** Node's `headersDistinct`: every header's values, one per line it arrived on. */
export type DistinctHeaders = Record<string, string[] | undefined>;
export type Proof = { ok: true; signedId: string | null } | { ok: false; said: string };

/** A Standard Webhooks timestamp may be this far from now, either way. */
export const STANDARD_TOLERANCE_MS = 5 * 60_000;
const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HIDDEN = /[\u0000-\u001f\u007f]/;

/** Exactly one value for a security header, or why not. */
function single(headers: DistinctHeaders, name: string): { ok: true; value: string } | { ok: false; said: string } {
  const values = headers[name] ?? [];
  if (values.length === 0) return { ok: false, said: `The ${name} header is missing.` };
  if (values.length > 1) return { ok: false, said: `The ${name} header was sent more than once.` };
  return { ok: true, value: values[0]! };
}

function same(expected: Buffer, given: Buffer): boolean {
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A `whsec_` secret's key bytes, or null when it isn't one. */
export function standardKey(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return null;
  const encoded = secret.slice("whsec_".length);
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length >= 24 && key.length <= 64 ? key : null;
}

/** Whether a delivery was signed with this secret by this sender. `none` proves nothing and is never passed here. */
export function proveDelivery(sender: SigningSender, secret: string, headers: DistinctHeaders, body: Buffer, now: Date): Proof {
  switch (sender) {
    case "github-style": {
      const header = single(headers, "x-hub-signature-256");
      if (!header.ok) return header;
      const given = header.value.trim().toLowerCase();
      if (!given.startsWith("sha256=") || !HEX(32).test(given.slice(7))) return { ok: false, said: "The signature isn't sha256=<hex>." };
      return same(createHmac("sha256", secret).update(body).digest(), Buffer.from(given.slice(7), "hex")) ? { ok: true, signedId: null } : { ok: false, said: "Signature doesn't match." };
    }
    case "sentry": {
      const header = single(headers, "sentry-hook-signature");
      if (!header.ok) return { ok: false, said: header.said.includes("missing") ? "Sentry didn't sign this: use an Internal Integration's webhook." : header.said };
      const given = header.value.trim().toLowerCase();
      if (!HEX(32).test(given)) return { ok: false, said: "The signature isn't a SHA-256 hex digest." };
      return same(createHmac("sha256", secret).update(body).digest(), Buffer.from(given, "hex")) ? { ok: true, signedId: null } : { ok: false, said: "Signature doesn't match." };
    }
    case "vercel": {
      const header = single(headers, "x-vercel-signature");
      if (!header.ok) return header;
      const given = header.value.trim().toLowerCase();
      if (!HEX(20).test(given)) return { ok: false, said: "The signature isn't a SHA-1 hex digest." };
      return same(createHmac("sha1", secret).update(body).digest(), Buffer.from(given, "hex")) ? { ok: true, signedId: null } : { ok: false, said: "Signature doesn't match." };
    }
    case "standard": {
      const key = standardKey(secret);
      if (key === null) return { ok: false, said: "The saved secret isn't a whsec_ secret." };
      const id = single(headers, "webhook-id"), stamp = single(headers, "webhook-timestamp"), signature = single(headers, "webhook-signature");
      for (const header of [id, stamp, signature]) if (!header.ok) return header;
      const idText = (id as { value: string }).value, stampText = (stamp as { value: string }).value, signatureText = (signature as { value: string }).value;
      if (idText === "" || idText.length > 200 || HIDDEN.test(idText)) return { ok: false, said: "The webhook-id header isn't usable." };
      // Unix seconds, as an integer: milliseconds, decimals and signs are refused, not guessed at.
      if (!/^\d{1,11}$/.test(stampText)) return { ok: false, said: "The webhook-timestamp isn't Unix seconds." };
      if (Math.abs(now.getTime() - Number(stampText) * 1000) > STANDARD_TOLERANCE_MS) return { ok: false, said: "Too old, or from the future." };
      const expected = createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${idText}.${stampText}.`, "utf8"), body])).digest();
      // Any well-formed v1 entry may match; a malformed entry is passed over, and none well-formed is a refusal.
      let wellFormed = 0;
      for (const entry of signatureText.split(" ")) {
        if (!entry.startsWith("v1,")) continue;
        const encoded = entry.slice(3);
        if (!BASE64.test(encoded) || encoded.length % 4 !== 0) continue;
        const given = Buffer.from(encoded, "base64");
        if (given.length !== 32) continue;
        wellFormed++;
        if (same(expected, given)) return { ok: true, signedId: idText };
      }
      return { ok: false, said: wellFormed === 0 ? "The webhook-signature has no v1 signature." : "Signature doesn't match." };
    }
  }
}

/** Whether a pasted secret has its sender's shape (Sentry's and Vercel's come from them; the others can be made here). */
export function secretShapeOk(sender: SigningSender, secret: string): boolean {
  switch (sender) {
    case "sentry": return /^[0-9a-fA-F]{32,128}$/.test(secret);
    case "vercel": return /^[A-Za-z0-9]{16,200}$/.test(secret);
    case "standard": return standardKey(secret) !== null;
    case "github-style": return /^[\x21-\x7e]{16,200}$/.test(secret);
  }
}

/** A new secret for a sender Toolroll can make one for; Sentry's and Vercel's are pasted from them. */
export function makeSecret(sender: "standard" | "github-style"): string {
  return sender === "standard" ? `whsec_${randomBytes(32).toString("base64")}` : randomBytes(32).toString("hex");
}

/** Whether Toolroll makes this sender's secret (and shows it once), rather than asking for the sender's own. */
export const makesSecret = (sender: SigningSender): sender is "standard" | "github-style" => sender === "standard" || sender === "github-style";
