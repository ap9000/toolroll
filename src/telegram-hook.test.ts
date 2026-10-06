/**
 * Telegram pushing a bot's updates (v98): the console's /hooks/telegram takes
 * only a request carrying our secret header, keeps each update once for the
 * bridge, and answers at once — through a real HTTP server.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openStore, type Store } from "./store.js";
import { createDecisionServer } from "./serve.js";
import { telegramHookSecret } from "./telegram.js";

const BOT = "777000";
let dir: string, store: Store, server: ReturnType<typeof createDecisionServer>, base: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-telegram-hook-"));
  store = openStore(join(dir, "orders.db"));
  // A token of BotFather's shape, made here: never a real one.
  writeFileSync(join(dir, "telegram-token"), `${BOT}:${"A1b2C3d4".repeat(5)}`, { mode: 0o600 });
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [], clock: () => new Date("2026-09-26T21:00:00.000Z"), configDir: dir, telegramTokenFile: join(dir, "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

const push = (body: string, secret?: string, method = "POST") => fetch(`${base}/hooks/telegram`, { method, headers: { "content-type": "application/json", ...(secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret }) }, ...(method === "POST" ? { body } : {}) });
const update = JSON.stringify({ update_id: 977559800, message: { message_id: 5, text: "Hello are you connected", chat: { id: 4242, type: "private" }, from: { id: 31337 } } });

test("only a push carrying our secret is kept, once; anything else is refused and kept nowhere", async () => {
  // No secret yet (the bridge makes it when it sets the address): nothing is Telegram's.
  expect((await push(update, "x".repeat(43))).status).toBe(401);
  const secret = telegramHookSecret(dir, true)!;
  expect((await push(update)).status).toBe(401);
  expect((await push(update, `${secret}x`)).status).toBe(401);
  expect((await push(update, secret, "GET")).status).toBe(405);
  expect((await push("not json", secret)).status).toBe(400);
  expect(store.telegramInbox(BOT, 10)).toEqual([]);
  const kept = await push(update, secret);
  expect(kept.status).toBe(200);
  expect(await kept.text()).toBe("ok");
  // Telegram sending it again is answered the same way, and kept once.
  expect((await push(update, secret)).status).toBe(200);
  expect(store.telegramInbox(BOT, 10)).toEqual([{ updateId: 977559800, payload: update }]);
});

test("without a bot token there is no push address", async () => {
  rmSync(join(dir, "telegram-token"));
  expect((await push(update, telegramHookSecret(dir, true)!)).status).toBe(404);
});

test("a schema-invalid authenticated push is acknowledged and logged without queuing or resending it", async () => {
  const secret = telegramHookSecret(dir, true)!;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [body, path] of [
      [{ update_id: 12, message: { message_id: "broken" } }, "message.message_id"],
      [{ update_id: 13, callback_query: { id: "tap", message: { message_id: 2, chat: { id: null } } } }, "callback_query.message.chat.id"],
      [{ update_id: -1 }, "update_id"],
    ] as const) {
      const response = await push(JSON.stringify(body), secret);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(warning).toHaveBeenLastCalledWith(expect.stringContaining(`${path}:`));
    }
    expect(store.telegramInbox(BOT, 10)).toEqual([]);
    expect((await push(update, secret)).status).toBe(200);
    expect(store.telegramInbox(BOT, 10)).toEqual([{ updateId: 977559800, payload: update }]);
  } finally { warning.mockRestore(); }
});
