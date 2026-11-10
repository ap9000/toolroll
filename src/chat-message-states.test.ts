/**
 * Contracts for an incoming chat message's result words and the one unsent() answer: the typed list is exactly the
 * set of fixed words the code writes, the detailed forms are stored byte-identical to the old string joins, and
 * unsent() picks the same rows the hand-written queries it replaced picked, on a small real store.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { ChatState } from "./chat-delivery-state.js";
import { CHAT_ADMITTED_WAITS, CHAT_LEAD_WAITS, CHAT_MESSAGE_OUTCOMES, CHAT_WAIT_OUTCOMES, chatOutcome, unsent } from "./chat-message-states.js";

describe("result words", () => {
  const source = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8");
  /** Every quoted word inside a call that writes a result (finish, requeue, deliver, sendOrHandOff), minus state names. */
  const writtenWords = (text: string): string[] => {
    const calls = text.match(/finish\(\{[^}]*\}\)|(?:requeue|deliver|sendOrHandOff)\([^;]*?\);|const REVOKED[^;]*;/g) ?? [];
    return calls.flatMap(call => [...call.replace(/state: "[a-z]+"/g, "").matchAll(/"([^"\s]+)"/g)].map(match => match[1]!));
  };

  test("the typed list is exactly the fixed words the code writes, and no word is listed twice", () => {
    const listed = new Set<string>(CHAT_MESSAGE_OUTCOMES);
    expect(listed.size).toBe(CHAT_MESSAGE_OUTCOMES.length);
    const written = new Set([...writtenWords(source("telegram-lead.ts")), ...writtenWords(source("chat-core.ts"))]);
    expect([...written].sort()).toEqual([...listed].sort());
  });

  test("the wait groups are part of the list", () => {
    for (const word of [...CHAT_WAIT_OUTCOMES, ...CHAT_LEAD_WAITS, ...CHAT_ADMITTED_WAITS]) expect(CHAT_MESSAGE_OUTCOMES).toContain(word);
  });

  test("the detailed forms are stored exactly as the old string joins wrote them", () => {
    expect(chatOutcome.gaveUp("busy")).toBe("busy:gave-up");
    expect(chatOutcome.gaveUp("registry-unavailable")).toBe("registry-unavailable:gave-up");
    expect(chatOutcome.refused("daily-cap")).toBe("refused:daily-cap");
    expect(chatOutcome.refused("no-session")).toBe("refused:no-session");
    expect(chatOutcome.failed("timeout")).toBe("failed:timeout");
    expect(chatOutcome.replayedFailed("crashed")).toBe("replayed:crashed");
    expect(chatOutcome.replayedFailed(null)).toBe("replayed:failed");
    expect(chatOutcome.unsent("this chat is no longer paired")).toBe("unsent:this chat is no longer paired");
    expect(chatOutcome.unsentGaveUp("Too Many Requests")).toBe("unsent:gave-up:Too Many Requests");
    expect(chatOutcome.unsentGaveUp(null)).toBe("unsent:gave-up:unsent");
  });
});

describe("unsent()", () => {
  let dir: string;
  let store: Store;
  const T0 = "2026-10-08T09:00:00.000Z";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-chat-states-"));
    store = openStore(join(dir, "orders.db"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  /** Two people on one installation, events in every state, each with no parts, all sent, or some still pending. */
  const seed = (chat: ChatState) => {
    chat.prepare("INSERT INTO chat_binding (provider, id, installation, team, app, member, channel, approver, generation, created) VALUES (:provider, 1, 'bot', 'bot', 'bot', 'u1', 'c1', 'alex', 1, ?)").run(T0);
    chat.prepare("INSERT INTO chat_binding (provider, id, installation, team, app, member, channel, approver, generation, created) VALUES (:provider, 2, 'bot', 'bot', 'bot', 'u2', 'c2', 'sam', 1, ?)").run(T0);
    const parts: Record<string, string[]> = { none: [], sent: ["sent", "sent"], mixed: ["sent", "pending", "pending"], dropped: ["dropped"], late: ["dropped", "pending"] };
    let id = 1, part = 1;
    for (const state of ["queued", "running", "done", "failed", "dropped"]) {
      for (const [shape, states] of Object.entries(parts)) {
        const event = `m${id++}`, binding = id % 2 === 0 ? 1 : 2;
        chat.prepare("INSERT INTO chat_event (provider, id, installation, binding, kind, channel, member, ts, thread, payload, created, state) VALUES (:provider, ?, 'bot', ?, 'message', 'c', 'u', '1', '', '{}', ?, ?)")
          .run(event, binding, T0, state);
        states.forEach((one, ordinal) => {
          const created = new Date(Date.parse(T0) + (shape === "late" ? 3_600_000 : 0) + ordinal * 1_000).toISOString();
          chat.prepare("INSERT INTO chat_part (provider, id, event, ordinal, payload, state, created, problem) VALUES (:provider, ?, ?, ?, '{}', ?, ?, ?)")
            .run(part++, event, ordinal, one, created, one === "pending" ? `error ${ordinal}` : null);
        });
      }
    }
  };

  test.each(["telegram", "slack"] as const)("matches the hand-written pending-part check on every event (%s)", provider => {
    const chat = new ChatState(store, provider);
    seed(chat);
    const old = "EXISTS (SELECT 1 FROM chat_part p WHERE p.provider = e.provider AND p.event = e.id AND p.state = 'pending')";
    const rows = chat.prepare(`SELECT e.id, ${old} AS before, ${unsent("e")} AS after FROM chat_event e WHERE e.provider = :provider ORDER BY e.id`).all();
    expect(rows.length).toBe(25);
    expect(rows.filter(row => Number(row["before"]) === 1).length).toBeGreaterThan(0);
    for (const row of rows) expect([row["id"], Number(row["after"])]).toEqual([row["id"], Number(row["before"])]);
  });

  test("unsent replies, the retry count and the settings counts give what the old queries gave", () => {
    const state = new ChatState(store, "telegram");
    const chat = state;
    seed(state);
    const since = new Date(Date.parse(T0) + 60_000);
    const oldUnsent = state.prepare(
      `SELECT c.id, b.approver, MIN(p.created) AS since,
         (SELECT q.problem FROM chat_part q WHERE q.provider = c.provider AND q.event = c.id AND q.state = 'pending' ORDER BY q.ordinal LIMIT 1) AS error
        FROM chat_event c JOIN chat_binding b ON b.provider = c.provider AND b.id = c.binding
        JOIN chat_part p ON p.provider = c.provider AND p.event = c.id AND p.state = 'pending'
       WHERE c.provider = :provider AND c.kind = 'message' AND c.state IN ('queued','running') AND (? IS NULL OR c.installation = ?) AND (? IS NULL OR b.approver = ?)
       GROUP BY c.id HAVING MIN(p.created) <= ? ORDER BY CAST(substr(c.id, 2) AS INTEGER)`,
    ).all(null, null, null, null, since.toISOString())
      .map(row => ({ conversation: Number(String(row["id"]).slice(1)), approver: String(row["approver"]), since: String(row["since"]), error: row["error"] === null ? null : String(row["error"]) }));
    const now = chat.unsentReplies(null, null, since);
    expect(now).toEqual(oldUnsent);
    expect(now.length).toBeGreaterThan(0);
    expect(chat.unsentReplies("bot", "alex", new Date(Date.parse(T0) + 7_200_000))).toEqual(
      chat.unsentReplies(null, null, new Date(Date.parse(T0) + 7_200_000)).filter(one => one.approver === "alex"));

    const oldCounts = (binding: number) => state.prepare(`SELECT SUM(p.state = 'pending') AS pending, SUM(p.state = 'dropped') AS dropped FROM chat_part p
      JOIN chat_event e ON e.provider = p.provider AND e.id = p.event WHERE p.provider = :provider AND e.binding = ?`).get(binding);
    for (const binding of [1, 2]) {
      const before = oldCounts(binding);
      expect(state.partCounts(binding)).toEqual({ pending: Number(before?.["pending"] ?? 0), dropped: Number(before?.["dropped"] ?? 0) });
    }

    const oldRetry = state.prepare(`SELECT COUNT(*) AS n FROM chat_event WHERE provider = :provider AND kind = 'message' AND state = 'queued'
      AND EXISTS (SELECT 1 FROM chat_part p WHERE p.provider = chat_event.provider AND p.event = chat_event.id AND p.state = 'pending')`).get();
    expect(chat.retryReplies(null, new Date(T0))).toBe(Number(oldRetry?.["n"]));
  });
});
