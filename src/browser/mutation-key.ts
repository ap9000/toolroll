/**
 * The browser mutation key (easy-start C2), as every request builder in the bundle reads it.
 *
 * On a protected loopback install the console delivers each browser session a key once, into this origin's
 * localStorage (server/mutation-key.ts); every mutation carries it as the `x-toolroll-key` header (a fetch), the
 * `toolroll-key` field (a native form: the page's key fill adds it) or a `toolroll.key.<key>` protocol (a terminal
 * socket). Anywhere else nothing is stored, and every helper here leaves its request as it was.
 */

const STORAGE = "toolroll.key";
const HEADER = "x-toolroll-key";
const SHAPE = /^[0-9a-f]{64}$/;

/** The key this origin holds, or null (none, unreadable storage, or a malformed value). */
export function mutationKey(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE) ?? null;
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const key = typeof value === "object" && value !== null ? (value as { key?: unknown }).key : null;
    return typeof key === "string" && SHAPE.test(key) ? key : null;
  } catch { return null; }
}

/** The headers a mutation's fetch sends: these, plus the key when this origin holds one. */
export function keyed<T extends Record<string, string>>(headers: T): T & { "x-toolroll-key"?: string } {
  const key = mutationKey();
  return key === null ? headers : { ...headers, [HEADER]: key };
}

/** A terminal socket's protocols: `toolroll` (the one the server selects), and the key when held (never echoed back). */
export function socketProtocols(): string[] {
  const key = mutationKey();
  return key === null ? ["toolroll"] : ["toolroll", `toolroll.key.${key}`];
}

/** Opening a finished agent's record is viewing it: it leaves this person's unread Done (a keyed POST, not the page read).
 * Quiet: a refusal or an older console without the route changes nothing on the page. */
export function markAgentSeen(run: number, csrf: string): void {
  if (csrf === "" || !Number.isSafeInteger(run) || run <= 0) return;
  void fetch("/agents/seen", { method: "POST", credentials: "same-origin", headers: keyed({ accept: "application/json" }), body: new URLSearchParams({ csrf, run: String(run) }) }).catch(() => undefined);
}

/** While an agent's page is open this person is watching it (chat pings hold off): a short lease, renewed every
 * `everyMs` and released when the page goes. Returns the stop. */
export function watchAgent(run: number, csrf: string, everyMs = 15_000): () => void {
  if (csrf === "" || !Number.isSafeInteger(run) || run <= 0) return () => undefined;
  const view = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
  const post = (release: boolean) => fetch("/agents/watch", { method: "POST", credentials: "same-origin", keepalive: release, headers: keyed({ accept: "application/json" }),
    body: new URLSearchParams({ csrf, run: String(run), view, op: release ? "release" : "hold" }) }).catch(() => undefined);
  void post(false);
  const timer = setInterval(() => { void post(false); }, everyMs);
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); window.removeEventListener("pagehide", stop); void post(true); };
  window.addEventListener("pagehide", stop);
  return stop;
}
