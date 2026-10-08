/**
 * Web push, zero-dependency (arc 3).
 *
 * Three layers, kept apart: CRYPTO (RFC 8291 aes128gcm message encryption
 * and RFC 8292 VAPID authorization, byte-exact, node:crypto only),
 * TRANSPORT (one hardened fetch to an allow-listed push service), and the
 * PASS (claim pairs from the store's ledger, fence, send, settle by the
 * full outcome table). The payload that transits Apple's and Google's
 * servers is a fixed phrase keyed on the notification's CLASS plus a
 * machine-minted console path. Check progress may also send one validated
 * suite/count line; task titles, branches and repository names stay local.
 *
 * 'accepted' means the push service took the message (RFC 8030). Nothing
 * here ever claims a phone displayed anything, and delivery is
 * AT-LEAST-ONCE: a crash between acceptance and settlement re-sends after
 * the pair's lease expires (the payload's tag collapses the duplicate on
 * the lock screen).
 */

import { closeSync, constants as fsConstants, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, createHash, sign as cryptoSign } from "node:crypto";
import type { Notification, PushSubscription, Store } from "./store.js";
import { isCheckProgressLine } from "./check-progress.js";

export const VAPID_FILE = "vapid-keys.json";
/** RFC 8291 §4: rs 4096 leaves room for the record's delimiter and tag. */
const RECORD_SIZE = 4096;
/** The plaintext ceiling that keeps one record inside rs (RFC 8291 §4). */
export const PLAINTEXT_CEILING = 3993;
const REQUEST_TIMEOUT_MS = 10_000;
/** The pair lease strictly exceeds the request timeout (finding 12). */
export const PUSH_CLAIM_TTL_MS = 30_000;
const BACKOFF_MS = [60_000, 300_000, 1_500_000, 7_200_000] as const;
const MAX_ATTEMPTS = 8;

const b64url = (buffer: Buffer): string => buffer.toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

// ---- keys -------------------------------------------------------------------

export type VapidKeys = {
  /** 65-byte uncompressed P-256 point, base64url. */
  publicKey: string;
  /** 32-byte scalar, base64url. */
  privateKey: string;
  fingerprint: string;
};

export function vapidFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}

/**
 * Mint-or-load, atomically across processes (finding 29): exclusive
 * creation; the loser of a race re-reads the winner's file; and a loaded
 * pair is VALIDATED — the stored public key must derive from the stored
 * private key, or the file is refused rather than trusted.
 */
export function loadOrCreateVapidKeys(dir: string): VapidKeys {
  const path = join(dir, VAPID_FILE);
  const read = (): VapidKeys | null => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const parsed = JSON.parse(raw) as { publicKey?: unknown; privateKey?: unknown };
    if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") {
      throw new Error(`${VAPID_FILE} is not a key file`);
    }
    const check = createECDH("prime256v1");
    check.setPrivateKey(fromB64url(parsed.privateKey));
    if (b64url(check.getPublicKey()) !== parsed.publicKey) {
      throw new Error(`${VAPID_FILE} holds a mismatched key pair — refusing to sign with it`);
    }
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, fingerprint: vapidFingerprint(parsed.publicKey) };
  };

  const existing = read();
  if (existing !== null) return existing;

  const minted = createECDH("prime256v1");
  minted.generateKeys();
  const fresh = { publicKey: b64url(minted.getPublicKey()), privateKey: b64url(minted.getPrivateKey()) };
  try {
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, JSON.stringify(fresh, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ...fresh, fingerprint: vapidFingerprint(fresh.publicKey) };
  } catch {
    // Another process won the exclusive create — its keys are the keys.
    const winner = read();
    if (winner === null) throw new Error(`could not create or read ${VAPID_FILE}`);
    return winner;
  }
}

// ---- RFC 8291 encryption ----------------------------------------------------

/**
 * The deterministic core, exported for the Appendix A vector test: given
 * the subscriber's materials, an application-server ECDH object, and a
 * salt, produce the complete aes128gcm body — header || ciphertext.
 */
export function encryptWithMaterials(
  uaPublic: Buffer,
  authSecret: Buffer,
  asKeys: ReturnType<typeof createECDH>,
  salt: Buffer,
  plaintext: Buffer,
): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("subscriber key is not a 65-byte uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret is not 16 bytes");
  if (salt.length !== 16) throw new Error("salt is not 16 bytes");
  if (plaintext.length > PLAINTEXT_CEILING) throw new Error(`payload over ${PLAINTEXT_CEILING} bytes`);

  const asPublic = asKeys.getPublicKey();
  // computeSecret rejects off-curve points — the caller maps that throw to
  // an invalid subscription, never a crash.
  const ecdhSecret = asKeys.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info", "ascii"), Buffer.from([0]), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm", "ascii"), Buffer.from([0])]), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce", "ascii"), Buffer.from([0])]), 12));

  // One record: plaintext, the last-record delimiter 0x02, zero padding.
  const record = Buffer.concat([plaintext, Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The production wrapper: fresh ephemeral keys and a fresh salt per message. */
export function encryptPushPayload(p256dh: string, auth: string, plaintext: string): Buffer {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  return encryptWithMaterials(fromB64url(p256dh), fromB64url(auth), ephemeral, randomBytes(16), Buffer.from(plaintext, "utf8"));
}

// ---- RFC 8292 VAPID ---------------------------------------------------------

/**
 * The VAPID authorization header: an ES256 JWT over { aud, exp, sub? },
 * signed with the STABLE server key (distinct from every message's
 * ephemeral key), in JWS P1363 form — never DER (finding 4).
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date, contact?: string): string {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now.getTime() / 1000) + 12 * 60 * 60; // ≤ 24h per RFC 8292
  const claims: Record<string, unknown> = { aud, exp };
  if (contact !== undefined && (contact.startsWith("mailto:") || contact.startsWith("https:"))) claims["sub"] = contact;

  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${header}.${body}`;

  const publicPoint = fromB64url(keys.publicKey);
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(publicPoint.subarray(1, 33)),
      y: b64url(publicPoint.subarray(33, 65)),
    },
  });
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

// ---- endpoint discipline ----------------------------------------------------

/** The closed allow-list of push services (finding 7): SSRF dies here. */
const PUSH_HOSTS: readonly { exact?: string; suffix?: string }[] = [
  { exact: "fcm.googleapis.com" },
  { suffix: ".push.apple.com" },
  { exact: "updates.push.services.mozilla.com" },
  { suffix: ".push.services.mozilla.com" },
  { suffix: ".notify.windows.com" },
];

export function validatePushEndpoint(raw: string): { ok: true; url: URL } | { ok: false; problem: string } {
  if (raw.length > 1024) return { ok: false, problem: "the endpoint is too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "the endpoint is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "push endpoints are https" };
  if (url.username !== "" || url.password !== "" || url.hash !== "") return { ok: false, problem: "the endpoint carries parts a push URL never has" };
  if (url.port !== "" && url.port !== "443") return { ok: false, problem: "push services answer on 443" };
  if (/^[0-9.[]/.test(url.hostname)) return { ok: false, problem: "push endpoints are named services, not addresses" };
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOSTS.some(one => (one.exact !== undefined ? host === one.exact : host.endsWith(one.suffix as string)));
  if (!known) return { ok: false, problem: "that host is not a known push service — extending the list is a code change, deliberately" };
  return { ok: true, url };
}

// ---- the payload ------------------------------------------------------------

/** Fixed words, except for one validated machine-only suite/count line. */
export const PUSH_WORDS: Record<NonNullable<Notification["pushClass"]>, { title: string; body: string }> = {
  decision: { title: "Toolroll", body: "a decision needs you" },
  pick: { title: "Toolroll", body: "agents finished — pick a winner" },
  merge: { title: "Toolroll", body: "a pull request needs a person" },
  attention: { title: "Toolroll", body: "the plane needs attention" },
  progress: { title: "Toolroll", body: "checks in progress" },
};

const LINK_SHAPES = [/^\/next$/, /^\/review$/, /^\/system$/, /^\/routines$/, /^\/routines\/[0-9]{1,15}$/, /^\/d\/[0-9]{1,15}$/, /^\/r\/[0-9]{1,15}$/];
const CLASS_FALLBACK: Record<NonNullable<Notification["pushClass"]>, string> = {
  decision: "/next",
  pick: "/next",
  merge: "/review",
  attention: "/next",
  progress: "/next",
};

/** Static words and machine-minted numbers only — re-proved at send time. */
export function safePushLink(pushClass: NonNullable<Notification["pushClass"]>, link: string | null): string {
  if (link !== null && LINK_SHAPES.some(shape => shape.test(link))) return link;
  return CLASS_FALLBACK[pushClass];
}

export function buildPushPayload(notification: Notification, waiting: number | null = null): string {
  const pushClass = notification.pushClass as NonNullable<Notification["pushClass"]>;
  const words = PUSH_WORDS[pushClass];
  return JSON.stringify({
    title: words.title,
    body: pushClass === "progress" && isCheckProgressLine(notification.body) ? notification.body : words.body,
    url: safePushLink(pushClass, notification.link),
    // The opaque tag collapses a crash-duplicate on the lock screen.
    tag: pushClass === "progress" && notification.run !== null ? `so-run-${notification.run}` : `so-${notification.id}`,
    // The app-icon badge (Phase 2E, v2 S4): the server-computed
    // waiting-on-you COUNT at send time — a number, never content, so the
    // closed-class discipline holds. The console page recomputes and
    // clears; a stale push never outranks a fresh page.
    ...(waiting === null ? {} : { waiting }),
  });
}

// ---- the pass ---------------------------------------------------------------

export type PushFetch = (url: string, init: Record<string, unknown>) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export type PushPassReport = {
  seeded: number;
  accepted: number;
  rescheduled: number;
  rejected: number;
  retired: number;
  credentialProblem: boolean;
};

function backoffFor(attempts: number, retryAfter: string | null, now: Date): Date {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(now.getTime() + Math.min(seconds, 7_200) * 1000);
  }
  const step = BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)] as number;
  return new Date(now.getTime() + step);
}

/**
 * One pass: seed, claim, and for each pair — renew, fence, encrypt, send,
 * settle by the outcome table. Every settle is conditional on the claim's
 * owner AND generation; a lapsed claim writes nothing.
 */
export async function pushPass(
  store: Store,
  options: {
    configDir: string;
    fetchImpl?: PushFetch;
    clock?: () => Date;
    owner?: string;
    contact?: string;
  },
): Promise<PushPassReport> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? `push-${randomBytes(4).toString("hex")}`;
  const doFetch: PushFetch = options.fetchImpl ?? (async (url, init) => fetch(url, init as never));
  const report: PushPassReport = { seeded: 0, accepted: 0, rescheduled: 0, rejected: 0, retired: 0, credentialProblem: false };

  if (store.isDemo()) return report; // a sandbox never pushes

  const keys = loadOrCreateVapidKeys(options.configDir);
  // Subscriptions are bound to the key they enrolled under (finding 27):
  // after a regeneration they reject every message — retire them visibly.
  report.retired += store.retirePushSubscriptionsOfOtherKeys(keys.fingerprint, clock());
  report.seeded = store.seedPushPairs(clock());

  const pairs = store.claimPushPairs(owner, PUSH_CLAIM_TTL_MS, 32, clock());
  let sawAccepted = false;
  for (const pair of pairs) {
    // Renew and re-fence immediately before the network (finding 12).
    if (!store.renewPushClaim(pair.id, owner, pair.claimGeneration, PUSH_CLAIM_TTL_MS, clock())) continue;
    const fenced = store.pushSendFence(pair.id, owner, pair.claimGeneration);
    if (fenced === null) continue; // resolved, retired, rotated, or lost — nothing to send
    const subscription = fenced.subscriptionRow;

    const endpoint = validatePushEndpoint(subscription.endpoint);
    if (!endpoint.ok) {
      store.retirePushSubscription(subscription.id, "invalid-endpoint", clock());
      report.retired += 1;
      continue;
    }

    let body: Buffer;
    try {
      body = encryptPushPayload(
        subscription.p256dh,
        subscription.auth,
        // The badge count rides every push: the same inbox classifier the
        // console's own sidebar badge reads, unscoped (a phone has no
        // project pane), computed at send time.
        buildPushPayload(fenced.notificationRow, store.countInboxScoped(null, clock(), 100, null).count),
      );
    } catch {
      // Off-curve or malformed subscriber material: the device, not us.
      store.retirePushSubscription(subscription.id, "invalid-keys", clock());
      report.retired += 1;
      continue;
    }

    let status: number;
    let retryAfter: string | null = null;
    try {
      const answer = await doFetch(subscription.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: vapidAuthorization(subscription.endpoint, keys, clock(), options.contact),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "300",
          Urgency: "high",
        },
        body,
      });
      status = answer.status;
      retryAfter = answer.headers.get("retry-after");
    } catch {
      status = 0; // network / timeout / redirect refusal
    }

    // The outcome table (finding 18).
    if (status >= 200 && status < 300) {
      if (store.settlePushPair(pair.id, owner, pair.claimGeneration, { kind: "accepted" }, clock())) report.accepted += 1;
      sawAccepted = true;
    } else if (status === 404 || status === 410) {
      store.retirePushSubscription(subscription.id, "gone", clock());
      report.retired += 1;
    } else if (status === 400 || status === 413) {
      if (store.settlePushPair(pair.id, owner, pair.claimGeneration, { kind: "rejected", error: `push service answered ${status}` }, clock())) {
        report.rejected += 1;
      }
    } else if (status === 401 || status === 403) {
      // A CREDENTIAL problem, never a device problem: no retirement, and
      // one deduped, UNSTAMPED operator episode (finding 27).
      report.credentialProblem = true;
      store.enqueueEpisode(
        `push-credentials:${keys.fingerprint}`,
        {
          source: { installation: true },
          kind: "push-credentials",
          subject: "push credentials were rejected",
          body: "the push service refused this console's signing key — if the key file was replaced, phones must re-enroll from /settings",
        },
        clock().toISOString(),
        clock(),
      );
      settleRetryOrGiveUp(store, pair.id, owner, pair.claimGeneration, pair.attempts, `push service answered ${status}`, retryAfter, clock(), report);
    } else {
      settleRetryOrGiveUp(store, pair.id, owner, pair.claimGeneration, pair.attempts, status === 0 ? "the push service could not be reached" : `push service answered ${status}`, retryAfter, clock(), report);
    }
  }
  // A working credential closes the episode (finding 27).
  if (sawAccepted) store.resolveEpisodes(`push-credentials:${keys.fingerprint}`, clock());
  return report;
}

function settleRetryOrGiveUp(
  store: Store,
  pairId: number,
  owner: string,
  generation: number,
  attempts: number,
  error: string,
  retryAfter: string | null,
  now: Date,
  report: PushPassReport,
): void {
  if (attempts + 1 >= MAX_ATTEMPTS) {
    if (store.settlePushPair(pairId, owner, generation, { kind: "undeliverable", error }, now)) report.rejected += 1;
    return;
  }
  if (store.settlePushPair(pairId, owner, generation, { kind: "backoff", nextAttemptAt: backoffFor(attempts + 1, retryAfter, now), error }, now)) {
    report.rescheduled += 1;
  }
}
