/**
 * API token notices (v111): 7 days and 1 day before a token expires, its person is told once each, in their own chats
 * and browsers (a personal notification), and the ledger keeps it. Only the nearest notice newly due is sent, so a
 * token made with a day left says so once. Replaced and revoked tokens get none. The same pass records the end of each
 * rotated token whose overlap has passed; it already signs no one in (tokenLive), so a late pass grants nothing.
 */
import { expiryNoticeDue, EXPIRY_NOTICE_DAYS, tokenLive } from "./api-tokens.js";
import type { Store } from "./store.js";

export const TOKEN_NOTICE_KIND = "api-token-expiry";

export function tokenNoticePass(store: Store, now: Date): { sent: { token: string; days: number }[]; ended: number } {
  const ended = store.endRotatedApiTokens(now);
  const sent: { token: string; days: number }[] = [];
  const at = now.getTime();
  for (const token of store.apiTokens(null)) {
    const days = expiryNoticeDue(token, at);
    if (days === null) continue;
    const key = (one: number) => `${TOKEN_NOTICE_KIND}:${token.id}:${one}`;
    // A nearer notice already sent covers this one.
    if (EXPIRY_NOTICE_DAYS.filter(one => one <= days).some(one => store.handle.prepare("SELECT 1 AS hit FROM notification WHERE dedupe_key = ?").get(key(one)) !== undefined)) continue;
    const fresh = store.enqueueNotification({
      dedupeKey: key(days), kind: TOKEN_NOTICE_KIND, pushClass: "attention", link: "/settings/sessions", recipient: token.account,
      subject: `Your API token ${token.name} expires ${days === 1 ? "tomorrow" : `in ${days} days`}`,
      body: `It stops working ${token.expiresAt.slice(0, 16).replace("T", " ")} UTC. Rotate it with toolroll tokens rotate, or make a new one in Settings → Sessions & tokens.`,
      source: { installation: true },
    }, now);
    if (!fresh) continue;
    store.recordAction({ at: now.toISOString(), actor: "system", repo: null, taskId: null, runId: null, action: `API token expiry notice: ${token.name}`, outcome: "notified", source: "access",
      detail: `${token.account}'s · id ${token.id} · ${days} day${days === 1 ? "" : "s"} left` });
    sent.push({ token: token.id, days });
  }
  return { sent, ended };
}

/** Whether a token's console card warns that it expires soon (within the first notice's days). */
export function expiresSoon(token: Parameters<typeof tokenLive>[0] & { replacedBy: string | null }, now: number): boolean {
  return expiryNoticeDue(token, now) !== null;
}

/** The loop beside the console: a pass a minute. */
export function startTokenNotices(store: Store, everyMs = 60_000): () => void {
  let stopped = false;
  const tick = () => { if (stopped) return; try { tokenNoticePass(store, new Date()); } catch { /* the next pass tries again */ } };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  const first = setTimeout(tick, 5_000);
  first.unref?.();
  return () => { stopped = true; clearInterval(timer); clearTimeout(first); };
}
