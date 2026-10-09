import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { TeamLeads } from "./team-leads.js";

const NOW = new Date("2026-09-21T18:00:00Z");
const BOT = "777000";

describe("Telegram team selection transactions", () => {
  let store: Store, binding: number, first: string, second: string;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "fixture-hash", NOW);
    store.createTelegramPairing({ codeHash: "fixture-code", approver: "alex", by: "alex", ttlMs: 60_000 }, NOW);
    const paired = store.consumeTelegramPairing({ codeHash: "fixture-code", botId: BOT, chatId: "4242", userId: "4242", updateId: 1 }, NOW);
    if (!paired.ok) throw new Error("pairing fixture");
    binding = store.liveTelegramBindingFor(BOT, "4242")!.id;
    const domain = new TeamLeads(store, () => ["/test/project"]);
    const actor = { name: "alex", generation: 1 };
    const lead = domain.execute(actor, { operation: "create-lead", args: { name: "Engineering", projects: ["/test/project"] } }, NOW);
    if (!lead.ok) throw new Error(lead.message);
    const leadId = (lead.result as { leadId: string }).leadId;
    const room = (title: string) => {
      const made = domain.execute(actor, { operation: "create-conversation", args: { leadId, title, visibility: "team", projects: ["/test/project"] } }, NOW);
      if (!made.ok) throw new Error(made.message);
      return (made.result as { conversationId: string }).conversationId;
    };
    first = room("Website"); second = room("Release");
  });
  afterEach(() => store.close());
  const select = (chatId: string, conversation: string, exactBinding = binding) => store.bindTelegramTeamChat({ botId: BOT, chatId, binding: exactBinding, kind: "group", conversation, by: "alex" }, NOW);

  test("switching to a conversation already followed by another group preserves both selections", () => {
    expect(select("-1001", first)).toMatchObject({ ok: true, chat: { binding } });
    expect(select("-1002", second).ok).toBe(true);
    const before = store.handle.prepare("SELECT * FROM chat_room WHERE provider = 'telegram' ORDER BY id").all();
    expect(select("-1001", second)).toEqual({ ok: false, reason: "group-taken" });
    expect(store.handle.prepare("SELECT * FROM chat_room WHERE provider = 'telegram' ORDER BY id").all()).toEqual(before);
    expect(store.telegramTeamChat(BOT, "-1001")?.conversation).toBe(first);
    expect(store.telegramTeamChat(BOT, "-1002")?.conversation).toBe(second);
    expect(select("-1001", first)).toMatchObject({ ok: true, chat: { conversation: first, binding } });
  });

  test("an invalid pairing rolls back the switch even if an enclosing transaction catches the failure", () => {
    expect(select("-1001", first).ok).toBe(true);
    const before = store.handle.prepare("SELECT * FROM chat_room WHERE provider = 'telegram' ORDER BY id").all();
    store.transact(() => {
      expect(() => select("-1001", second, binding + 1)).toThrow(/FOREIGN KEY/);
    });
    expect(store.handle.prepare("SELECT * FROM chat_room WHERE provider = 'telegram' ORDER BY id").all()).toEqual(before);
    expect(store.telegramTeamChat(BOT, "-1001")).toMatchObject({ conversation: first, binding });
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
