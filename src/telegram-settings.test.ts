/** The console's own-phone pairing card (v72): each approver mints and revokes
 * their own Telegram pairing under their password; nobody else's changes. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { hashPairingCode, saveBotToken } from "./telegram.js";

const BOT_TOKEN = "777000:AAEfixture-token-value-for-tests-1234567890";
let dir: string, store: Store, password: string, samPassword: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-telegram-settings-"));
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex fixture");
  password = alex.token;
  const sam = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!sam.ok) throw new Error("sam fixture");
  samPassword = sam.token;
  expect(saveBotToken(join(dir, "telegram-token"), BOT_TOKEN).ok).toBe(true);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("each teammate pairs and unpairs their own phone from the console; a code shows once and the other person's pairing is untouched", async () => {
  const server = createDecisionServer({ store, evidenceRoot: dir, repos: [], configDir: dir, telegramTokenFile: join(dir, "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  const signIn = async (name: string, token: string) => {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    return login.headers.get("set-cookie")!.split(";")[0]!;
  };
  try {
    const cookie = await signIn("alex", password);
    const page = await (await fetch(`${base}/settings/telegram`, { headers: { cookie } })).text();
    expect(page).toContain("Your phone is not paired.");
    expect(page).toContain("Pair my phone");
    expect(page).toContain("a conversation manager sends <code>/team</code>");
    expect(page).toContain("Everyone in the group can read its replies.");
    expect(page).not.toContain("People settings");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const post = (path: string, fields: Record<string, string>, who = cookie) =>
      fetch(`${base}${path}`, { method: "POST", headers: { cookie: who, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
    expect((await post("/settings/telegram/pair", { csrf, password: "wrong" })).status).toBe(403);
    const minted = await post("/settings/telegram/pair", { csrf, password });
    expect(minted.status).toBe(200);
    const shown = await minted.text();
    const code = /\/pair ([0-9a-f]{32})/.exec(shown)![1]!;
    // The code pairs alex's own chat; sam's simultaneous code pairs sam's.
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "4242", updateId: 1 }, new Date())).toMatchObject({ ok: true });
    // A project-scoped subagent can manage their own phone without gaining
    // installation bot settings or affecting another person's pairing.
    expect(store.setAccountProjects("sam", [], "alex", new Date()).ok).toBe(true);
    const samCookie = await signIn("sam", samPassword);
    const samPage = await (await fetch(`${base}/settings/telegram`, { headers: { cookie: samCookie } })).text();
    expect(samPage).toContain("Your phone is not paired.");
    expect(samPage).toContain("1 teammate is paired.");
    const samCsrf = /name="csrf" value="([^"]+)"/.exec(samPage)![1]!;
    const samSettings = await (await fetch(`${base}/settings`, { headers: { cookie: samCookie } })).text();
    expect(samSettings).toContain('href="/settings/telegram"');
    expect((await post("/settings/telegram-token", { csrf: samCsrf, password: samPassword, token: BOT_TOKEN }, samCookie)).status).toBe(403);
    const samResponse = await post("/settings/telegram/pair", { csrf: samCsrf, password: samPassword }, samCookie);
    expect(samResponse.status).toBe(200);
    const samMinted = await samResponse.text();
    const samCode = /\/pair ([0-9a-f]{32})/.exec(samMinted)![1]!;
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(samCode), botId: "777000", chatId: "8800", userId: "8800", updateId: 2 }, new Date())).toMatchObject({ ok: true });
    expect(store.liveTelegramBindings("777000").map(one => one.approver)).toEqual(["alex", "sam"]);
    // Paired: the card offers unpair, and a second pairing is refused until then.
    const paired = await (await fetch(`${base}/settings/telegram`, { headers: { cookie } })).text();
    expect(paired).toContain("Your phone is paired.");
    expect(paired).toContain("Unpair my phone");
    expect((await post("/settings/telegram/pair", { csrf, password })).status).toBe(409);
    expect((await post("/settings/telegram/unpair", { csrf, password })).status).toBe(303);
    expect(store.liveTelegramBindings("777000").map(one => one.approver)).toEqual(["sam"]);
    expect(await (await fetch(`${base}/settings/telegram`, { headers: { cookie } })).text()).toContain("Your phone is not paired.");
    expect((await post("/settings/telegram/unpair", { csrf: samCsrf, password: samPassword }, samCookie)).status).toBe(303);
    expect(store.liveTelegramBindings("777000")).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a reply unsent for two minutes shows on the person's own Telegram page and in status, each with a Retry", async () => {
  const written = new Date(Date.now() - 5 * 60_000);
  const code = "c".repeat(32);
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: 600_000 }, written);
  expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "4242", updateId: 1 }, written)).toMatchObject({ ok: true });
  const binding = store.liveTelegramBinding("777000")!;
  const id = store.enqueueTelegramConversation({ binding, updateId: 2, messageId: "1002", replyTo: null, request: "r".repeat(32), text: "what's new?", context: null, taskId: null, sourceRun: null }, written);
  expect(store.claimTelegramConversation("777000", "owner", 120_000, written)?.id).toBe(id);
  const session = store.mintLeadSession({ approver: "alex", approverGeneration: binding.approverGeneration, credentialKey: "k", ceilingMicrousd: 0, ceilingDigest: "d", termsDigest: "t" }, written);
  expect(store.planTelegramConversationParts(id, "owner", { session, turn: 0 }, [{ kind: "reply", text: "0.9.9 is out.", replyTo: "1002" }], written)).toBe(true);
  expect(store.settleTelegramConversationPart(id, 0, "owner", { ok: false, error: "fetch failed; delivery may be uncertain", uncertain: true, retryAt: new Date(Date.now() + 3_600_000).toISOString() }, written)).toBe(true);
  expect(store.finishTelegramConversation(id, "owner", { state: "queued", outcome: "delivering", nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() }, written)).toBe(true);
  // Status names it, with the command that retries it.
  const lines: string[] = [];
  const { runOperate } = await import("./operate.js");
  store.close();
  expect(await runOperate("status", [], line => lines.push(line), { databaseFile: join(dir, "orders.db"), telegramTokenFile: join(dir, "telegram-token"), releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never)).toBe(0);
  expect(lines.join("\n")).toContain(`A Telegram reply hasn't been sent since ${written.toISOString().slice(11, 16)} UTC (fetch failed; delivery may be uncertain). Retry: toolroll bridge telegram retry`);
  store = openStore(join(dir, "orders.db"));
  const server = createDecisionServer({ store, evidenceRoot: dir, repos: [], configDir: dir, telegramTokenFile: join(dir, "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
  try {
    // Sam's page says nothing about alex's reply.
    expect(await (await fetch(`${base}/settings/telegram`, { headers: { cookie: await signIn("sam", samPassword) } })).text()).not.toContain("data-unsent-replies");
    const cookie = await signIn("alex", password);
    const page = await (await fetch(`${base}/settings/telegram`, { headers: { cookie } })).text();
    expect(page).toContain("A reply hasn't reached your phone");
    expect(page).toContain("fetch failed; delivery may be uncertain");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const retried = await fetch(`${base}/settings/telegram/retry`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(retried.status).toBe(303);
    expect(Date.parse(store.getTelegramConversation(id)!.nextAttemptAt!)).toBeLessThanOrEqual(Date.now());
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
