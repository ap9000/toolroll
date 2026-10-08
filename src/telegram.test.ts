/**
 * The Telegram bridge, against a scripted Bot API: decisions out with opaque
 * buttons, taps back through the same authenticated answer path as the CLI
 * and web, and every hostile shape — forged tokens, wrong senders, group
 * chats, replayed updates, racing pollers — refused in silence.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import {
  bridgePass,
  createTransport,
  followBridge,
  hashPairingCode,
  loadBotToken,
  mintPairingCode,
  saveBotToken,
  scrub,
  MAX_POLL_SECONDS,
  PAIRING_TTL_MS,
  TOKEN_ENV,
  keepPushedUpdate,
  pushedByTelegram,
  telegramHookSecret,
  telegramPushUrl,
  type TelegramTransport,
  networkFence,
} from "./telegram.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
// Lifecycle progress facts (task-notifications.test.ts) are settled before
// each pass here: this suite drives the transport with hand-enqueued rows.
const quietLifecycle = (store: Store, now: Date) => store.resolveEpisodes("life", now);
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;
const REPO = "/test/project";
const readProjects = async () => [REPO];

describe("destination-bound authorized outbox", () => {
  let store: Store;
  let dir: string;
  let file: string;
  let now: Date;
  let projects: string[];
  let alexToken = "";
  const OTHER = "/test/other";
  const pair = (chat = CHAT) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: String(USER), updateId: chat }, now).ok).toBe(true);
    return store.liveTelegramBinding(BOT)!;
  };
  const task = (id: string, repo: string) => {
    store.createTask({ id, title: id }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };
  const enqueue = (key: string, ref: number, body = key) => store.enqueueNotification({
    dedupeKey: key, kind: "report-ready", subject: key, body, source: { taskRef: ref },
  }, now);
  const pass = (transport: TelegramTransport, extra: Partial<Parameters<typeof bridgePass>[1]> = {}) => {
    quietLifecycle(store, now);
    return bridgePass(store, { botId: BOT, transport, clock: () => now, readProjects: async () => projects, ...extra });
  };
  const sends = (script: ReturnType<typeof scriptedTransport>) => script.calls.filter(call => call.method === "sendMessage");
  const receipts = () => store.telegramDeliveries(store.liveTelegramBinding(BOT)!);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-telegram-outbox-"));
    file = join(dir, "orders.db");
    now = T0;
    projects = [REPO, OTHER];
    store = openStore(file);
    const alex = addApprover(store, "alex", now);
    expect(alex.ok).toBe(true);
    alexToken = alex.ok ? alex.token : "";
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    pair();
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("two paired people each receive a fact once, under their own project ceiling, and a revoked person's chat goes quiet", async () => {
    // sam: an approver limited to the second project, paired from their own chat.
    expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
    store.setNotificationPreference("sam", { mode: "all" }, "sam", now);
    expect(store.setAccountProjects("sam", [OTHER], "alex", now).ok).toBe(true);
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "sam", by: "sam", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: "8800", userId: "8800", updateId: 8800 }, now).ok).toBe(true);
    const alexBinding = store.liveTelegramBindingFor(BOT, String(USER))!, samBinding = store.liveTelegramBindingFor(BOT, "8800")!;
    const a = task("a", REPO), b = task("b", OTHER);
    enqueue("a-ready", a); enqueue("b-ready", b);
    const script = scriptedTransport();
    // sam's copy of the first-project fact is held under sam's own ceiling and named once.
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 3, problems: [expect.stringContaining("not currently authorized")] } });
    const byChat = (chat: string) => sends(script).filter(call => String(call.params["chat_id"]) === chat).map(call => call.params["text"]);
    expect(byChat(String(CHAT))).toEqual(["project / a · a-ready\n\na-ready", "other / b · b-ready\n\nb-ready"]);
    expect(byChat("8800")).toEqual(["other / b · b-ready\n\nb-ready"]);
    expect(store.telegramDeliveries(samBinding).find(row => row.dedupeKey === "a-ready")).toMatchObject({ deliveredAt: null, lastError: expect.stringContaining("project") });
    expect(store.telegramDeliveries(alexBinding).filter(row => row.deliveredAt !== null)).toHaveLength(2);
    // Revoking sam ends sam's deliveries only; alex's next fact still arrives.
    expect(store.unpairTelegram(BOT, "sam", now)).toBe(true);
    enqueue("b-again", b);
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(byChat("8800")).toHaveLength(1);
    expect(byChat(String(CHAT)).at(-1)).toBe("other / b · b-again\n\nb-again");
  });

  test("two projects carry trusted task identities; forged text and links cannot authorize legacy data", async () => {
    const a = task("a", REPO), b = task("b", OTHER);
    enqueue("a-ready", a); enqueue("b-ready", b);
    store.enqueueNotification({ dedupeKey: "legacy", kind: "report-ready", subject: "a at project", body: "secret", link: "/t/a" }, now);
    const script = scriptedTransport();
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(sends(script).map(call => call.params["text"])).toEqual(["project / a · a-ready\n\na-ready", "other / b · b-ready\n\nb-ready"]);
    expect(receipts().at(-1)).toMatchObject({ scope: "unknown", deliveredAt: null, lastError: "Notification has no trusted project provenance" });
    expect(store.handle.prepare("SELECT task_ref, task_id, project FROM telegram_outbound_message ORDER BY notification").all()).toEqual([
      { task_ref: a, task_id: "a", project: REPO }, { task_ref: b, task_id: "b", project: OTHER },
    ]);
  });

  test("a retry rechecks removed enrollment; a later update cannot overtake it", async () => {
    const a = task("a", REPO);
    enqueue("first", a); enqueue("second", a);
    const script = scriptedTransport();
    const broken: TelegramTransport = async (method, params) => method === "sendMessage" ? { ok: false, description: "offline" } : script.transport(method, params);
    await pass(broken);
    expect(receipts().map(row => row.lastError)).toEqual(["offline", "Earlier task notification is still undelivered"]);
    projects = []; now = later(2_000);
    await pass(script.transport);
    expect(sends(script)).toHaveLength(0);
    projects = [REPO]; now = later(4_000);
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(sends(script).map(call => String(call.params["text"]).split("\n")[0])).toEqual(["project / a · first", "project / a · second"]);
  });

  test("a mixed digest sends the eligible rows now; legacy and unenrolled rows wait with reasons, in task order", async () => {
    const a = task("a", REPO), b = task("b", OTHER);
    store.enqueueNotification({ dedupeKey: "legacy", kind: "report-ready", subject: "legacy", body: "legacy" }, now);
    enqueue("b-first", b); enqueue("b-second", b); enqueue("a-ready", a);
    store.setTelegramDigest(60_000, "alex", now); now = later(61_000); projects = [REPO];
    const script = scriptedTransport();
    const first = await pass(script.transport);
    expect(first).toMatchObject({ ok: true, report: { sent: 1, digests: 1 } });
    expect(first.ok && first.report.problems).toHaveLength(3);
    expect(sends(script)).toHaveLength(1);
    const digest = String(sends(script)[0]!.params["text"]);
    expect(digest).toContain("digest — 1 routine fact(s)");
    expect(digest).toContain("a-ready");
    expect(digest).not.toMatch(/legacy|b-first|b-second/);
    expect(receipts().map(row => [row.dedupeKey, row.deliveredAt !== null, row.lastError])).toEqual([
      ["legacy", false, "Notification has no trusted project provenance"],
      ["b-first", false, "Notification project is not currently authorized and enrolled"],
      ["b-second", false, "Notification project is not currently authorized and enrolled"],
      ["a-ready", true, null],
    ]);
    expect(store.telegramDigest().lastSentAt).toBe(now.toISOString());
    // Enrolling the other project releases its rows on the next retry pass,
    // in one digest and in ID order; the legacy row still waits, never guessed.
    projects.push(OTHER); now = later(63_000);
    // The two filing facts hold ids 1 and 2; the legacy row is 3.
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 2, digests: 1, problems: ["notification 3: Notification has no trusted project provenance"] } });
    expect(sends(script)).toHaveLength(2);
    const second = String(sends(script)[1]!.params["text"]);
    expect(second).toContain("digest — 2 routine fact(s)");
    expect(second.indexOf("b-first")).toBeLessThan(second.indexOf("b-second"));
    expect(receipts().map(row => row.deliveredAt !== null)).toEqual([false, true, true, true]);
    expect(store.countRoutinePending()).toBe(1);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM telegram_outbound_message").get()?.["n"]).toBe(3);
  });

  // The root's three isolated digest cases (legacy only, unenrolled only,
  // both), replayed here as a regression with a restart between passes: the
  // valid update goes out once, every blocked row keeps its reason, and no
  // blocked project content reaches the chat.
  test.each(["legacy", "unauthorized", "both"])("%s digest isolation survives a restart: valid updates flow, blocked rows keep their reason, nothing private leaks", async kind => {
    if (kind !== "unauthorized") store.enqueueNotification({ dedupeKey: "legacy", kind: "report-ready", subject: "legacy private task", body: "unknown authority" }, now);
    if (kind !== "legacy") enqueue("outside", task("outside", OTHER), "not enrolled");
    enqueue("valid", task("valid", REPO), "safe update");
    store.setTelegramDigest(60_000, "alex", now); now = later(61_000); projects = [REPO];
    const script = scriptedTransport();
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 1, digests: 1 } });
    store.close(); store = openStore(file); now = later(63_000);
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 0 } });
    const blocked = kind === "legacy" ? ["legacy"] : kind === "unauthorized" ? ["outside"] : ["legacy", "outside"];
    const rows = receipts();
    expect(rows.find(row => row.dedupeKey === "valid")?.deliveredAt).not.toBeNull();
    for (const key of blocked) expect(rows.find(row => row.dedupeKey === key)).toMatchObject({ deliveredAt: null, lastError: key === "legacy" ? "Notification has no trusted project provenance" : "Notification project is not currently authorized and enrolled" });
    expect(rows.filter(row => row.deliveredAt === null)).toHaveLength(blocked.length);
    expect(sends(script)).toHaveLength(1);
    const text = String(sends(script)[0]!.params["text"]);
    expect(text).toContain("safe update");
    expect(text).not.toMatch(/legacy private task|unknown authority|outside|not enrolled/);
  });

  test.each(["single", "digest"])("%s rechecks enrollment before each part after asynchronous sends", async mode => {
    const a = task("a", REPO);
    if (mode === "single") enqueue("long", a, "word 😀 ".repeat(1500));
    else {
      for (let i = 0; i < 30; i++) enqueue(`fact-${i}`, a, "x".repeat(200));
      store.setTelegramDigest(1_000, "alex", now); now = later(2_000);
    }
    const script = scriptedTransport();
    const transport: TelegramTransport = async (method, params) => {
      const answer = await script.transport(method, params);
      if (method === "sendMessage") projects = [];
      return answer;
    };
    await pass(transport);
    expect(sends(script)).toHaveLength(1);
    expect(String(sends(script)[0]!.params["text"]).length).toBeLessThanOrEqual(3900);
    expect(receipts().every(row => row.deliveredAt === null)).toBe(true);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM telegram_outbound_message").get()?.["n"]).toBeGreaterThan(0);
  });

  test.each(["unpair", "replace", "revoke", "generation", "viewer", "disable"])("%s while a message is in flight cannot acknowledge or send its next part", async change => {
    enqueue("long", task("a", REPO), "long ".repeat(2000));
    const old = store.liveTelegramBinding(BOT)!;
    let enabled = true;
    const script = scriptedTransport();
    const transport: TelegramTransport = async (method, params) => {
      const answer = await script.transport(method, params);
      if (method === "sendMessage") {
        if (change === "disable") enabled = false;
        else if (change === "viewer") store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run();
        else if (change === "generation") store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
        else if (change === "revoke") store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(now.toISOString());
        else { store.unpairTelegram(BOT, "alex", now); if (change === "replace") pair(CHAT + 1); }
      }
      return answer;
    };
    expect(await pass(transport, { canDeliver: () => enabled })).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(sends(script)).toHaveLength(1);
    expect(store.telegramDeliveries(old)[0]?.deliveredAt).toBeNull();
    expect(store.handle.prepare("SELECT binding, chat_id FROM telegram_outbound_message").get()).toEqual({ binding: old.id, chat_id: String(CHAT) });
    if (change === "replace") {
      expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!)).toHaveLength(0);
      now = later(2_000);
      expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 1 } });
      expect(sends(script).slice(1).every(call => call.params["chat_id"] === String(CHAT + 1))).toBe(true);
    }
  });

  test("live config and pairing are checked after the asynchronous registry read", async () => {
    enqueue("ready", task("a", REPO));
    const script = scriptedTransport();
    let enabled = true;
    await pass(script.transport, { canDeliver: () => enabled, readProjects: async () => { enabled = false; return projects; } });
    expect(sends(script)).toHaveLength(0);
    now = later(2_000);
    await pass(script.transport, { readProjects: async () => { store.unpairTelegram(BOT, "alex", now); return projects; } });
    expect(sends(script)).toHaveLength(0);
  });

  test("a pairing revoked while the registry result returns is fenced immediately before transport", async () => {
    enqueue("ready", task("a", REPO));
    const script = scriptedTransport();
    await pass(script.transport, { readProjects: async () => {
      queueMicrotask(() => queueMicrotask(() => store.unpairTelegram(BOT, "alex", now)));
      return projects;
    } });
    expect(sends(script)).toHaveLength(0);
  });

  test("retry_after survives restart, blocks all sends, then resumes in task order", async () => {
    const a = task("a", REPO);
    enqueue("first", a); enqueue("second", a);
    const script = scriptedTransport();
    let attempts = 0;
    const limited: TelegramTransport = async (method, params) => {
      if (method === "sendMessage") { attempts++; return { ok: false, description: "Too Many Requests", parameters: { retry_after: 45 } }; }
      return script.transport(method, params);
    };
    await pass(limited);
    expect(attempts).toBe(1);
    store.close(); store = openStore(file);
    now = later(44_999); await pass(script.transport);
    expect(sends(script)).toHaveLength(0);
    now = later(45_000);
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(sends(script).map(call => call.params["text"])).toEqual(["project / a · first\n\nfirst", "project / a · second\n\nsecond"]);
    enqueue("after-limit", a);
    await pass(async method => method === "sendMessage" ? { ok: false, description: "offline" } : { ok: true, result: [] });
    expect(store.handle.prepare("SELECT next_attempt_at FROM notification_delivery WHERE notification = (SELECT id FROM notification WHERE dedupe_key = 'after-limit')").get()?.["next_attempt_at"]).toBe(later(46_000).toISOString());
  });

  test("the HTTP adapter preserves retry_after without a live request; unconfirmed success stays pending", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "limited", parameters: { retry_after: 7 } }), { status: 429 }));
    try {
      expect(await createTransport("fixture-token")("sendMessage", {})).toMatchObject({ ok: false, parameters: { retry_after: 7 } });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
    enqueue("unconfirmed", task("a", REPO));
    expect(await pass(async method => ({ ok: true, result: method === "getUpdates" ? [] : {} }))).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(receipts()[0]).toMatchObject({ deliveredAt: null, lastError: "Telegram returned no confirmed message identity" });
  });

  test("the HTTP adapter marks lost, aborted and malformed acknowledgements uncertain; a Bot API rejection stays definite", async () => {
    const transport = createTransport("fixture-token");
    const answers: Array<() => Promise<Response>> = [
      async () => { throw new Error("socket hang up fixture-token"); },
      async () => { throw new DOMException("response lost", "AbortError"); },
      async () => new Response("not-json"),
      async () => new Response(JSON.stringify({ result: {} })),
      async () => new Response(JSON.stringify(null)),
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 502 }),
    ];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => answers.shift()!());
    try {
      for (let left = 6; left > 0; left--) {
        const answer = await transport("sendMessage", {});
        expect(answer).toMatchObject({ ok: false, uncertain: true });
        expect(answer.description).not.toContain("fixture-token");
      }
      fetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 }));
      expect(await transport("sendMessage", {})).toEqual({ ok: false, result: undefined, description: "Bad Request: chat not found" });
      fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 9 } })));
      expect(await transport("sendMessage", {})).toEqual({ ok: true, result: { message_id: 9 } });
    } finally { fetch.mockRestore(); }
  });

  test("the HTTP adapter sends a verified image as one multipart document — original bytes, safe name and type, short caption, boundary left to fetch — and keeps JSON calls, redaction, retry_after, abort and uncertainty exactly as they were", async () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 42)]);
    const seen: { url: string; init: RequestInit }[] = [];
    const answers: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 41, document: { file_id: "x" } } })),
      async () => new Response(JSON.stringify({ ok: false, description: "Bad Request: file is too big for fixture-token", parameters: { retry_after: 3 } }), { status: 400 }),
      async () => { throw new Error("socket hang up fixture-token"); },
      async () => new Response("not-json"),
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })),
    ];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      seen.push({ url: String(url), init: init as RequestInit });
      if ((init as RequestInit | undefined)?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return answers.shift()!();
    });
    try {
      const transport = createTransport("fixture-token");
      const upload = { field: "document" as const, fileName: "alpha-result-3-9.png", contentType: "image/png" as const, bytes };
      const params = { chat_id: "4242", caption: "alpha · result #3 · screenshot 1 of 1", reply_parameters: { message_id: 7 } };
      expect(await transport("sendDocument", params, undefined, upload)).toEqual({ ok: true, result: { message_id: 41, document: { file_id: "x" } } });
      const sent = seen[0]!;
      expect(sent.url).toBe("https://api.telegram.org/botfixture-token/sendDocument");
      // No content-type of ours: fetch mints the multipart boundary from the FormData body.
      expect(sent.init.headers).toBeUndefined();
      const form = sent.init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect([...form.keys()]).toEqual(["chat_id", "caption", "reply_parameters", "document"]);
      expect(form.get("chat_id")).toBe("4242");
      expect(form.get("caption")).toBe("alpha · result #3 · screenshot 1 of 1");
      expect(form.get("reply_parameters")).toBe(JSON.stringify({ message_id: 7 }));
      const file = form.get("document") as File;
      expect(file).toBeInstanceOf(File);
      expect([file.name, file.type, file.size]).toEqual(["alpha-result-3-9.png", "image/png", bytes.length]);
      expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
      // The request as it would leave: a multipart boundary of fetch's choosing, the file part under its name, the exact bytes inside — never a path, never a URL for Telegram to fetch.
      const request = new Request(sent.url, sent.init);
      expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const raw = Buffer.from(await request.arrayBuffer());
      expect(raw.includes(bytes)).toBe(true);
      expect(raw.toString("latin1")).toContain('name="document"; filename="alpha-result-3-9.png"');
      expect(raw.toString("latin1")).not.toMatch(/file_id|https?:\/\/|\/Users|\/tmp/);
      // Telegram's rejection of a document is definite, scrubbed of the token, and keeps retry_after; a lost, malformed or aborted answer is uncertain.
      expect(await transport("sendDocument", params, undefined, upload)).toEqual({ ok: false, result: undefined, description: "Bad Request: file is too big for …oken", parameters: { retry_after: 3 } });
      const lost = await transport("sendDocument", params, undefined, upload);
      expect(lost).toMatchObject({ ok: false, uncertain: true });
      expect(lost.description).not.toContain("fixture-token");
      expect(await transport("sendDocument", params, undefined, upload)).toMatchObject({ ok: false, uncertain: true });
      const controller = new AbortController();
      controller.abort();
      expect(await transport("sendDocument", params, controller.signal, upload)).toMatchObject({ ok: false, uncertain: true });
      // The JSON road is byte for byte what it was: the header, the serialized body, no form.
      expect(await transport("sendMessage", { chat_id: "4242", text: "hi" })).toEqual({ ok: true, result: { message_id: 42 } });
      expect(seen.at(-1)!.init.headers).toEqual({ "content-type": "application/json" });
      expect(seen.at(-1)!.init.body).toBe(JSON.stringify({ chat_id: "4242", text: "hi" }));
    } finally { fetch.mockRestore(); }
  });

  test("restart recovers expired claims; same-owner stale generations and replaced destinations cannot settle", async () => {
    enqueue("ready", task("a", REPO));
    quietLifecycle(store, now);
    const oldBinding = store.liveTelegramBinding(BOT)!;
    const [old] = store.claimTelegramDeliveries(oldBinding, "owner", 1_000, now);
    now = later(1_001);
    expect(store.finalizeTelegramDelivery(old!, oldBinding, "owner", { ok: true, receipt: "late" }, now)).toBe(false);
    store.close(); store = openStore(file);
    const [fresh] = store.claimTelegramDeliveries(oldBinding, "owner", 1_000, now);
    expect(fresh!.claimGeneration).toBeGreaterThan(old!.claimGeneration);
    expect(store.finalizeTelegramDelivery(old!, oldBinding, "owner", { ok: true, receipt: "stale" }, now)).toBe(false);
    store.unpairTelegram(BOT, "alex", now); const replaced = pair();
    const [replacement] = store.claimTelegramDeliveries(replaced, "owner", 1_000, now);
    expect(store.finalizeTelegramDelivery(fresh!, oldBinding, "owner", { ok: true, receipt: "old" }, now)).toBe(false);
    expect(store.finalizeTelegramDelivery(fresh!, replaced, "owner", { ok: false, error: "old retry" }, now)).toBe(false);
    expect(store.finalizeTelegramDelivery(replacement!, replaced, "owner", { ok: true, receipt: "new" }, now)).toBe(true);
    enqueue("after-restart", store.lookupRef("a")!.id);
    store.claimTelegramDeliveries(replaced, "crashed", 1_000, now);
    store.close(); store = openStore(file); now = later(2_002);
    expect(await pass(scriptedTransport().transport)).toMatchObject({ ok: true, report: { sent: 1 } });
  });

  test("urgent updates flush earlier task facts in order even before the digest window", async () => {
    const a = task("a", REPO);
    enqueue("routine", a);
    store.enqueueNotification({ source: { taskRef: a }, dedupeKey: "urgent", kind: "attention", pushClass: "attention", subject: "urgent", body: "help" }, now);
    store.setTelegramDigest(60_000, "alex", now);
    const script = scriptedTransport();
    expect(await pass(script.transport)).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(String(sends(script)[0]?.params["text"])).toContain("routine");
    expect(String(sends(script)[1]?.params["text"])).toContain("urgent");
  });

  test("missing registry, changed task placement and mismatched decision provenance all fail closed", async () => {
    const a = task("a", REPO), b = task("b", OTHER);
    enqueue("ready", a);
    const script = scriptedTransport();
    await pass(script.transport, { readProjects: async () => { throw new Error("private registry details"); } });
    expect(receipts()[0]?.lastError).toBe("Current Telegram delivery access could not be read");
    now = later(2_000); store.placeTask(a, OTHER); await pass(script.transport);
    expect(receipts()[0]?.lastError).toBe("Notification task provenance changed");
    const run = store.startRun({ taskRef: b, leaseId: "b", runner: "b", branch: "b", worktree: "/b", ...bareLegacy("build"), now });
    const decision = store.saveDecision({ run, urgency: "blocking", recap: "foreign", question: "secret", options: [{ id: "yes", label: "yes", consequence: "yes", reversible: true }], recommendation: "yes" }, now);
    store.enqueueNotification({ source: { taskRef: task("c", REPO) }, dedupeKey: `decision:${decision}`, kind: "decision", subject: "c", body: "c" }, now);
    now = later(4_000); await pass(script.transport);
    expect(sends(script)).toHaveLength(0);
    expect(receipts().at(-1)?.lastError).toBe("Decision does not match notification provenance");
  });
});

/** A scripted Bot API: records everything, plays back queued updates. */
function scriptedTransport() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const updates: unknown[][] = [];
  let nextMessageId = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") {
      const offset = Number(params["offset"] ?? 0);
      // Serve only updates at or past the offset, like the real API.
      const batch = (updates.shift() ?? []).filter(
        update => Number((update as { update_id: number }).update_id) >= offset,
      );
      return { ok: true, result: batch };
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: nextMessageId++ } };
    }
    return { ok: true, result: true };
  };
  return { transport, calls, updates };
}

const privatePair = (updateId: number, code: string, over: Record<string, unknown> = {}) => ({
  update_id: updateId,
  message: {
    message_id: 1,
    text: `/pair ${code}`,
    chat: { id: CHAT, type: "private" },
    from: { id: USER },
    ...over,
  },
});

const tap = (
  updateId: number,
  token: string,
  messageId = 100,
  over: Record<string, unknown> = {},
) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`,
    data: token,
    from: { id: USER },
    message: { message_id: messageId, chat: { id: CHAT } },
    ...over,
  },
});

describe("the telegram bridge", () => {
  let store: Store;
  let approverToken: string;
  let taskRef: number;

  const decisionWith = (
    options: { id: string; label: string; consequence: string; reversible: boolean }[],
    recommendation: string,
  ): number => {
    const run = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random()}`,
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The payout guard needs a policy call.",
        question: "Fail open or fail closed?",
        options,
        recommendation,
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(id), reason: `decision:${id}`, until: null },
      T0,
    );
    store.enqueueNotification(
      { source: { run }, dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked a decision", body: "q" },
      T0,
    );
    quietLifecycle(store, T0);
    return id;
  };

  const plainOptions = [
    { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
    { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
  ];

  const pairChat = async (script: ReturnType<typeof scriptedTransport>) => {
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(1_000) });
    expect(passed).toMatchObject({ ok: true });
    return code;
  };

  /** Where a token's keyboard actually landed — taps must come from there. */
  const placedOn = (token: string): number => Number(store.getTelegramAction(token)?.messageId ?? 0);

  /** The opaque tokens the last keyboard carried, freshest send first. */
  const keyboardTokens = (script: ReturnType<typeof scriptedTransport>): string[] => {
    const withKeyboards = script.calls.filter(
      call =>
        (call.method === "sendMessage" || call.method === "editMessageText") &&
        call.params["reply_markup"] !== undefined,
    );
    const last = withKeyboards[withKeyboards.length - 1];
    if (last === undefined) return [];
    const keyboard = (last.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    return keyboard.flat().map(button => button.callback_data);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    approverToken = added.token;
    void approverToken;
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    quietLifecycle(store, T0);
  });

  afterEach(() => store.close());

  test("pairing: a private chat with the code becomes the approver's chat, once", async () => {
    const script = scriptedTransport();
    await pairChat(script);

    const binding = store.liveTelegramBinding(BOT);
    expect(binding).toMatchObject({ chatId: String(CHAT), userId: String(USER), approver: "alex" });
    // The confirmation names the approver, so a hijacked code is visible.
    const reply = script.calls.find(call => call.method === "sendMessage");
    expect(String(reply?.params["text"])).toContain("answers as alex");
  });

  test("a wrong code, a group chat, and a second pairing by the same person all get silence; a teammate pairs beside", async () => {
    const script = scriptedTransport();
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([
      privatePair(1, mintPairingCode()), // wrong code
      privatePair(2, code, { chat: { id: CHAT, type: "group" } }), // group
    ]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(1_000) });

    expect(passed).toMatchObject({ ok: true, report: { paired: 0, ignored: 2 } });
    expect(store.liveTelegramBinding(BOT)).toBeNull();
    // No replies to anybody: a guesser learns nothing, including "wrong".
    expect(script.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);

    // The real code from the private chat still works…
    script.updates.push([privatePair(3, code)]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(2_000) });
    expect(store.liveTelegramBinding(BOT)).not.toBeNull();

    // …a second code for the SAME Telegram user cannot bind a second chat
    // while the first lives (silence, nothing changes)…
    const second = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(second), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      later(2_000),
    );
    script.updates.push([privatePair(4, second, { chat: { id: 999, type: "private" }, from: { id: USER } })]);
    const third = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(3_000) });
    expect(third).toMatchObject({ ok: true, report: { paired: 0 } });
    expect(store.liveTelegramBindings(BOT).map(one => one.chatId)).toEqual([String(CHAT)]);
    expect(script.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);

    // …while a teammate's own code, from their own private chat, pairs a
    // second binding beside the first (v72): each person answers as themselves.
    expect(addApprover(store, "sam", later(3_000), { name: "alex", token: approverToken }).ok).toBe(true);
    const sams = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(sams), approver: "sam", by: "sam", ttlMs: PAIRING_TTL_MS },
      later(3_000),
    );
    script.updates.push([privatePair(5, sams, { chat: { id: 999, type: "private" }, from: { id: 999 } })]);
    expect(await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(4_000) })).toMatchObject({ ok: true, report: { paired: 1 } });
    expect(store.liveTelegramBindings(BOT).map(one => [one.approver, one.chatId, one.userId])).toEqual([["alex", String(CHAT), String(USER)], ["sam", "999", "999"]]);
    expect(script.calls.filter(call => call.method === "sendMessage").at(-1)?.params["text"]).toContain("this chat now answers as sam");
    // Unpairing one person leaves the other's chat live.
    expect(store.unpairTelegram(BOT, "alex", later(5_000))).toBe(true);
    expect(store.liveTelegramBindings(BOT).map(one => one.approver)).toEqual(["sam"]);
  });

  test("an expired code is a wrong code", async () => {
    const script = scriptedTransport();
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, {
      readProjects,
      botId: BOT,
      transport: script.transport,
      clock: () => later(PAIRING_TTL_MS + 1_000),
    });
    expect(passed).toMatchObject({ ok: true, report: { paired: 0 } });
    expect(store.liveTelegramBinding(BOT)).toBeNull();
  });

  test("a decision goes out whole, and the buttons carry only opaque tokens", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    decisionWith(plainOptions, "closed");

    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    expect(passed).toMatchObject({ ok: true, report: { sent: 1 } });

    // Every safety-bearing word went out: recap, question, consequences.
    const texts = script.calls
      .filter(call => call.method === "sendMessage")
      .map(call => String(call.params["text"]))
      .join("\n");
    expect(texts).toContain("policy call");
    expect(texts).toContain("Fail open or fail closed?");
    expect(texts).toContain("Payouts pause.");
    // Nothing is parsed, nothing previews.
    for (const call of script.calls.filter(one => one.method === "sendMessage")) {
      expect(call.params["parse_mode"]).toBeUndefined();
      expect(call.params["entities"]).toBeUndefined();
    }

    // The buttons say nothing about what they do.
    const tokens = keyboardTokens(script);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).not.toContain("open");
    }

    // Delivered with a receipt that names bot, chat, and message.
    const [row] = store.telegramDeliveries(store.liveTelegramBinding(BOT)!);
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.receipt).toMatch(new RegExp(`^telegram:${BOT}:${CHAT}:\\d+$`));
  });

  test("a tap answers as the paired approver, and the hold lifts", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });

    const [openToken] = keyboardTokens(script);
    const action = store.getTelegramAction(openToken as string);
    expect(action?.optionId).toBe("open");

    script.updates.push([tap(10, openToken as string, placedOn(openToken as string))]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 1 } });

    expect(store.getDecision(decisionId)).toMatchObject({
      state: "answered",
      choice: "open",
      answeredBy: "alex",
      answeredVia: "telegram",
    });
    expect(store.activeHolds(taskRef, later(11_000))).toHaveLength(0);
    // The message was edited to the answered state and the tap acknowledged.
    expect(script.calls.some(call => call.method === "answerCallbackQuery")).toBe(true);
    const edit = script.calls.find(call => call.method === "editMessageText");
    expect(String(edit?.params["text"])).toBe("✓ Answered: Fail open\nt-1 · by alex via telegram");
  });

  test("a tap from anyone but the paired person is nothing", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    script.updates.push([tap(10, token as string, placedOn(token as string), { from: { id: 666 } })]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(passed).toMatchObject({ ok: true, report: { answered: 0, ignored: 1 } });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    // Not even an acknowledgement: a stranger's tap does not exist.
    expect(script.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(0);
  });

  test("a forged callback token is stale, not a command", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });

    script.updates.push([tap(10, "f".repeat(32))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(store.getDecision(decisionId)?.state).toBe("open");
    const ack = script.calls.find(call => call.method === "answerCallbackQuery");
    expect(String(ack?.params["text"])).toContain("stale");
  });

  test("a callback whose data Toolroll didn't make is answered with why, and does nothing", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });

    script.updates.push([tap(10, "pick:abc"), tap(11, "x".repeat(65))]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(passed).toMatchObject({ ok: true, report: { answered: 0, ignored: 2 } });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    expect(script.calls.filter(call => call.method === "answerCallbackQuery").map(call => call.params["text"])).toEqual([
      "That button couldn't be read (callback_data: not a Toolroll button). Nothing was done.",
      "That button couldn't be read (callback_data: over 64 bytes; callback_data: not a Toolroll button). Nothing was done.",
    ]);
  });

  test("an update in a shape Telegram doesn't send is passed over with a problem, and the next one is read", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    script.updates.push([{ update_id: 10, callback_query: { id: "cb-10", data: token, message: { message_id: "not-a-number" } } } as never, tap(11, token as string, placedOn(token as string))]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(passed).toMatchObject({ ok: true, report: { answered: 1 } });
    expect(passed.ok && passed.report.problems).toContain("an update Telegram sent couldn't be read: callback_query.message.message_id: must be a number (got a string)");
    expect(store.getDecision(decisionId)?.state).toBe("answered");
  });

  test("irreversible: one tap arms, only the minted confirm answers", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(
      [
        { id: "keep", label: "Keep it", consequence: "fine", reversible: true },
        { id: "drop", label: "Drop the table", consequence: "It does not come back.", reversible: false },
      ],
      "keep",
    );
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const dropToken = keyboardTokens(script).find(
      token => store.getTelegramAction(token)?.optionId === "drop",
    ) as string;

    // The arm: nothing answers yet.
    script.updates.push([tap(10, dropToken, placedOn(dropToken))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");

    const challenge = keyboardTokens(script);
    expect(challenge).toHaveLength(2);
    const confirm = challenge.find(token => store.getTelegramAction(token)?.phase === "confirm") as string;
    const cancel = challenge.find(token => store.getTelegramAction(token)?.phase === "cancel") as string;
    expect(confirm).toBeDefined();
    expect(cancel).toBeDefined();

    // The confirm answers — through the same one-time-token discipline.
    script.updates.push([tap(11, confirm, placedOn(confirm))]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(15_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 1 } });
    expect(store.getDecision(decisionId)).toMatchObject({ state: "answered", choice: "drop" });
  });

  test("cancel restores the choices and kills the challenge", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(
      [
        { id: "keep", label: "Keep it", consequence: "fine", reversible: true },
        { id: "drop", label: "Drop the table", consequence: "gone", reversible: false },
      ],
      "keep",
    );
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const dropToken = keyboardTokens(script).find(
      token => store.getTelegramAction(token)?.optionId === "drop",
    ) as string;

    script.updates.push([tap(10, dropToken, placedOn(dropToken))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    const challenge = keyboardTokens(script);
    const confirm = challenge.find(token => store.getTelegramAction(token)?.phase === "confirm") as string;
    const cancel = challenge.find(token => store.getTelegramAction(token)?.phase === "cancel") as string;

    script.updates.push([tap(11, cancel, placedOn(cancel))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(12_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    // The restored keyboard carries fresh choose tokens.
    const restored = keyboardTokens(script);
    expect(restored).toHaveLength(2);
    expect(restored.every(token => store.getTelegramAction(token)?.phase === "choose")).toBe(true);

    // The dead confirm no longer answers anything.
    script.updates.push([tap(12, confirm, placedOn(confirm))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(13_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("a replayed update applies once, and the cursor moves past it", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    // The same update twice in one batch, then again next pass.
    script.updates.push([tap(10, token as string, placedOn(token as string)), tap(10, token as string, placedOn(token as string))]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    script.updates.push([tap(10, token as string, placedOn(token as string))]);
    const third = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(15_000) });

    expect(third).toMatchObject({ ok: true, report: { answered: 0 } });
    // The next poll asks past the applied update — nothing is re-read.
    const polls = script.calls.filter(call => call.method === "getUpdates");
    expect(Number(polls[polls.length - 1]?.params["offset"])).toBeGreaterThan(10);
  });

  test("two pollers cannot both hold the bridge", async () => {
    const script = scriptedTransport();
    // Owner A takes the lease and, mid-pass, owner B tries.
    const a = store.acquireBridgeLease(BOT, "owner-a", 60_000, T0);
    expect(a).toMatchObject({ ok: true });

    const b = await bridgePass(store, {
      readProjects,
      botId: BOT,
      transport: script.transport,
      clock: () => later(1_000),
      owner: "owner-b",
    });
    expect(b).toMatchObject({ ok: false, reason: "bridge-busy" });

    // Expiry hands it over — at the next generation, so A's stale writes die.
    const c = await bridgePass(store, {
      readProjects,
      botId: BOT,
      transport: script.transport,
      clock: () => later(120_000),
      owner: "owner-b",
    });
    expect(c).toMatchObject({ ok: true });
    expect(store.advanceBridgeCursor(BOT, "owner-a", 1, 99, later(121_000))).toBe(false);
  });

  test("credential rotation strands the paired chat and its buttons", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    // The approver's credential rotates: everything derived dies with it.
    const rotated = addApprover(store, "alex", later(6_000), {
      name: "alex",
      token: approverToken,
    });
    expect(rotated.ok).toBe(true);
    expect(store.liveTelegramBinding(BOT)).toBeNull();

    script.updates.push([tap(10, token as string, placedOn(token as string))]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 0, ignored: 1 } });
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("with nothing paired, pending rows wait and the problem is named once", async () => {
    const script = scriptedTransport();
    decisionWith(plainOptions, "closed");

    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(1_000) });

    expect(passed).toMatchObject({ ok: true, report: { sent: 0 } });
    if (!passed.ok) return;
    expect(passed.report.problems.join(" ")).toContain("no chat is paired");
    // The row is still pending for whenever pairing happens.
    expect(store.listNotifications("pending")).toHaveLength(1);
  });
});

describe("the bot token's homes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-tg-token-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the file is owner-only, the shape is checked, and env wins", () => {
    const file = join(dir, "telegram-token");
    expect(saveBotToken(file, "not a token")).toMatchObject({ ok: false });

    const token = "777000:AAExampleExampleExample123";
    expect(saveBotToken(file, token)).toMatchObject({ ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(token);

    expect(loadBotToken({}, file)).toMatchObject({ source: "file", botId: "777000" });
    expect(
      loadBotToken({ [TOKEN_ENV]: "888000:BBOtherOtherOtherOther456" }, file),
    ).toMatchObject({ source: "env", botId: "888000" });
  });

  test("scrub keeps a token out of anything persisted", () => {
    const token = "777000:AAExampleExampleExample123";
    const error = `getUpdates https://api.telegram.org/bot${token}/getUpdates timed out`;
    expect(scrub(error, token)).not.toContain(token);
    expect(scrub(error, token)).toContain("…e123");
  });
});

describe("a fenced network never holds the bridge", () => {
  test("a coding agent's sandbox is known by Codex's variables or Claude Code's proxy on this computer; a person's own proxy is not a fence", () => {
    expect(networkFence({ CODEX_SANDBOX: "seatbelt" })).toBe("a Codex sandbox");
    expect(networkFence({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe("a Codex sandbox");
    expect(networkFence({ CLAUDECODE: "1", HTTPS_PROXY: "http://localhost:51234" })).toBe("a Claude Code sandbox");
    expect(networkFence({ CLAUDE_CODE_ENTRYPOINT: "cli", all_proxy: "socks5h://127.0.0.1:51235" })).toBe("a Claude Code sandbox");
    for (const env of [{}, { CLAUDECODE: "1" }, { HTTPS_PROXY: "http://127.0.0.1:7890" }, { CLAUDECODE: "1", HTTPS_PROXY: "http://proxy.corp.example:3128" }, { CODEX_SANDBOX: "" }]) {
      expect(networkFence(env)).toBeNull();
    }
  });
});

describe("the follower — on the wire until told to stop", () => {
  let store: Store;
  let taskRef: number;

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    quietLifecycle(store, T0);
  });

  afterEach(() => store.close());

  /** The opaque tokens the last keyboard carried. */
  const keyboardTokensOf = (script: ReturnType<typeof scriptedTransport>): string[] => {
    const withKeyboards = script.calls.filter(
      call =>
        (call.method === "sendMessage" || call.method === "editMessageText") &&
        call.params["reply_markup"] !== undefined,
    );
    const last = withKeyboards[withKeyboards.length - 1];
    if (last === undefined) return [];
    const keyboard = (last.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    return keyboard.flat().map(button => button.callback_data);
  };

  const pairDirectly = async (script: ReturnType<typeof scriptedTransport>) => {
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(1_000) });
    expect(passed).toMatchObject({ ok: true, report: { paired: 1 } });
  };

  const parkedDecision = (): number => {
    const run = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random()}`,
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The payout guard needs a policy call.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "slips", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "pauses", reversible: true },
        ],
        recommendation: "closed",
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(id), reason: `decision:${id}`, until: null },
      T0,
    );
    store.enqueueNotification(
      { source: { run }, dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked a decision", body: "q" },
      T0,
    );
    quietLifecycle(store, T0);
    return id;
  };

  test("delivers, long-polls, applies the tap that arrives, and stops on abort", async () => {
    const script = scriptedTransport();
    await pairDirectly(script);
    const decision = parkedDecision();

    const controller = new AbortController();
    const report = await followBridge(store, {
      readProjects,
      botId: BOT,
      transport: script.transport,
      signal: controller.signal,
      clock: () => later(5_000),
      sleep: () => Promise.resolve(),
      onCycle: cycle => {
        if (cycle.sent > 0) {
          // The keyboard just went out — the phone taps back for the next poll.
          const token = keyboardTokensOf(script)[0] ?? "";
          const messageId = Number(store.getTelegramAction(token)?.messageId ?? 0);
          script.updates.push([tap(10, token, messageId)]);
        }
        if (cycle.answered > 0) controller.abort();
      },
    });

    expect(report.sent).toBe(1);
    expect(report.answered).toBe(1);
    expect(store.getDecision(decision)?.state).toBe("answered");
    expect(store.getDecision(decision)?.answeredVia).toBe("telegram");
    // The task is dispatchable again — the loop's wake was bumped by the answer.
    expect(store.activeHolds(taskRef, later(10_000))).toHaveLength(0);

    // The follower's polls asked Telegram to hold the line (the pairing
    // pass's earlier getUpdates used 0 — that is the cron shape).
    const polls = script.calls.filter(call => call.method === "getUpdates");
    expect(polls.some(call => call.params["timeout"] === MAX_POLL_SECONDS)).toBe(true);
  });

  test("with a public address, Telegram pushes: the address is set with its secret, a pushed tap applies through the same door, and nobody asks for updates (v98)", async () => {
    const script = scriptedTransport();
    await pairDirectly(script);
    const decision = parkedDecision();
    const asksBefore = script.calls.filter(call => call.method === "getUpdates").length;
    let hookUrl = "";
    const transport: TelegramTransport = async (method, params, signal, upload) => {
      if (method === "getWebhookInfo") return { ok: true, result: { url: hookUrl, pending_update_count: 0 } };
      if (method === "setWebhook") { hookUrl = String(params["url"]); script.calls.push({ method, params }); return { ok: true, result: true }; }
      return script.transport(method, params, signal, upload);
    };
    const push = { url: "https://example.ts.net/hooks/telegram", secret: "s".repeat(43) };
    const controller = new AbortController();
    let pushedTap: unknown = null;
    const report = await followBridge(store, {
      readProjects, botId: BOT, transport, signal: controller.signal, clock: () => later(5_000), sleep: () => Promise.resolve(), push,
      onCycle: cycle => {
        if (cycle.sent > 0) {
          // The keyboard went out; the tap comes back as a push, kept by the console.
          const token = keyboardTokensOf(script)[0] ?? "";
          pushedTap = tap(10, token, Number(store.getTelegramAction(token)?.messageId ?? 0));
          expect(keepPushedUpdate(store, BOT, Buffer.from(JSON.stringify(pushedTap)), later(5_000))).toEqual({ ok: true, kept: true });
        }
        if (cycle.answered > 0) controller.abort();
      },
    });
    expect(report.answered).toBe(1);
    expect(store.getDecision(decision)?.state).toBe("answered");
    expect(script.calls.find(call => call.method === "setWebhook")?.params).toMatchObject({ url: push.url, secret_token: push.secret, allowed_updates: ["message", "callback_query"] });
    expect(script.calls.filter(call => call.method === "getUpdates")).toHaveLength(asksBefore);
    expect(store.telegramPush(BOT)).toMatchObject({ url: push.url, problem: null });
    // Telegram sending the same update again changes nothing.
    expect(keepPushedUpdate(store, BOT, Buffer.from(JSON.stringify(pushedTap)), later(6_000))).toEqual({ ok: true, kept: false });
    expect(store.telegramInbox(BOT, 10)).toEqual([]);
    expect(keepPushedUpdate(store, BOT, Buffer.from("not json"), later(6_000))).toEqual({ ok: false });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(keepPushedUpdate(store, BOT, Buffer.from('{"update_id": -1}'), later(6_000))).toEqual({ ok: true, kept: false });
      expect(warning).toHaveBeenCalledWith("Ignoring a pushed Telegram update: update_id: at least 1");
    } finally { warning.mockRestore(); }
  });

  test("another program asking for the bot's updates is no problem to report: nothing is logged, and the next ask gets the tap (v98)", async () => {
    const script = scriptedTransport();
    await pairDirectly(script);
    const decision = parkedDecision();
    let conflicts = 0;
    const transport: TelegramTransport = async (method, params, signal, upload) => {
      if (method === "getUpdates" && conflicts < 2) { conflicts++; return { ok: false, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }; }
      return script.transport(method, params, signal, upload);
    };
    const controller = new AbortController();
    const logged: string[] = [];
    const report = await followBridge(store, {
      readProjects, botId: BOT, transport, signal: controller.signal, clock: () => later(5_000), sleep: () => Promise.resolve(),
      onCycle: cycle => {
        logged.push(...cycle.problems);
        if (cycle.sent > 0) {
          const token = keyboardTokensOf(script)[0] ?? "";
          script.updates.push([tap(10, token, Number(store.getTelegramAction(token)?.messageId ?? 0))]);
        }
        if (cycle.answered > 0) controller.abort();
      },
    });
    expect(conflicts).toBe(2);
    expect(logged).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(store.getDecision(decision)?.state).toBe("answered");
  });

  test("pushes that keep failing: it asks for updates itself, then tries pushes again; an address someone took down is set again (v98)", async () => {
    const script = scriptedTransport();
    await pairDirectly(script);
    let hookUrl = "", now = later(0).getTime(), failing = true, sets = 0, deletes = 0;
    const transport: TelegramTransport = async (method, params, signal, upload) => {
      if (method === "getWebhookInfo") return { ok: true, result: failing && hookUrl !== "" ? { url: hookUrl, pending_update_count: 3, last_error_date: Math.floor(now / 1000) - 5, last_error_message: "Connection refused" } : { url: hookUrl, pending_update_count: 0 } };
      if (method === "setWebhook") { sets++; hookUrl = String(params["url"]); return { ok: true, result: true }; }
      if (method === "deleteWebhook") { deletes++; hookUrl = ""; return { ok: true, result: true }; }
      return script.transport(method, params, signal, upload);
    };
    const push = { url: "https://example.ts.net/hooks/telegram", secret: "s".repeat(43) };
    const controller = new AbortController();
    const logged: string[] = [];
    let asked = 0;
    await followBridge(store, {
      readProjects, botId: BOT, transport: async (method, params, signal, upload) => { if (method === "getUpdates") asked++; return transport(method, params, signal, upload); },
      signal: controller.signal, clock: () => new Date(now), sleep: async ms => { now += Math.max(ms, 60_000); if (asked >= 2) controller.abort(); }, push, pushCheckMs: 0,
      onCycle: cycle => logged.push(...cycle.problems),
    });
    expect(sets).toBe(1);
    expect(deletes).toBe(1);
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(logged).toContain("Telegram couldn't reach https://example.ts.net/hooks/telegram (Connection refused). Asking Telegram for updates directly for now.");
    expect(store.telegramPush(BOT)).toMatchObject({ url: null, problem: "Telegram couldn't reach https://example.ts.net/hooks/telegram (Connection refused)" });

    // Later, pushes work again; then something else takes the address down, and it's set again.
    failing = false;
    const again = new AbortController();
    let checks = 0;
    const logged2: string[] = [];
    await followBridge(store, {
      readProjects, botId: BOT, signal: again.signal, clock: () => new Date(now), push, pushCheckMs: 0,
      transport: async (method, params, signal, upload) => {
        if (method === "getWebhookInfo" && ++checks === 3) hookUrl = "";
        if (checks >= 4) again.abort();
        return transport(method, params, signal, upload);
      },
      sleep: async () => { now += 1_000; }, onCycle: cycle => logged2.push(...cycle.problems),
    });
    expect(sets).toBe(3);
    expect(logged2).toContain("Telegram stopped pushing to https://example.ts.net/hooks/telegram (something switched this bot back to being asked for updates); set it again");
    expect(store.telegramPush(BOT)).toMatchObject({ url: push.url, problem: null });
  });

  test("the address: https only, beside the hooks; and only a push with our secret is Telegram's (v98)", () => {
    expect(telegramPushUrl("https://server.example.ts.net")).toBe("https://server.example.ts.net/hooks/telegram");
    expect(telegramPushUrl("https://proxy.example.com/so/")).toBe("https://proxy.example.com/so/hooks/telegram");
    expect(telegramPushUrl("http://server.example.ts.net")).toBeNull();
    expect(telegramPushUrl(null)).toBeNull();
    const home = mkdtempSync(join(tmpdir(), "so-telegram-hook-"));
    expect(telegramHookSecret(home)).toBeNull();
    const secret = telegramHookSecret(home, true)!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(telegramHookSecret(home)).toBe(secret);
    expect(statSync(join(home, "telegram-hook-secret")).mode & 0o777).toBe(0o600);
    rmSync(home, { recursive: true, force: true });
    expect(pushedByTelegram(secret, secret)).toBe(true);
    expect(pushedByTelegram(`${secret}x`, secret)).toBe(false);
    expect(pushedByTelegram(undefined, secret)).toBe(false);
    expect(pushedByTelegram(secret, null)).toBe(false);
  });

  test("a held poll lease is waited out, never raced", async () => {
    const script = scriptedTransport();
    store.acquireBridgeLease(BOT, "cron-pass", 60_000, later(0));

    const controller = new AbortController();
    const sleeps: number[] = [];
    const report = await followBridge(store, {
      readProjects,
      botId: BOT,
      transport: script.transport,
      signal: controller.signal,
      clock: () => later(1_000),
      sleep: ms => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
        return Promise.resolve();
      },
    });

    expect(report.cycles).toBe(0);
    expect(script.calls).toHaveLength(0);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
  });

  test("a dead wire backs off exponentially instead of spinning", async () => {
    const failing: TelegramTransport = async method => {
      if (method === "getUpdates") return { ok: false, description: "connect ETIMEDOUT" };
      return { ok: true, result: true };
    };

    const controller = new AbortController();
    const sleeps: number[] = [];
    const report = await followBridge(store, {
      readProjects,
      botId: BOT,
      transport: failing,
      signal: controller.signal,
      clock: () => later(1_000),
      sleep: ms => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
        return Promise.resolve();
      },
    });

    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(report.problems.length).toBeGreaterThanOrEqual(3);
    // The lease went back on the way out; a cron pass can take over now.
    const lease = store.acquireBridgeLease(BOT, "cron-pass", 60_000, later(2_000));
    expect(lease).toMatchObject({ ok: true });
  });
});

describe("free-text answers — a reply becomes the note, a tap remains the choice", () => {
  let store: Store;
  let taskRef: number;

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    quietLifecycle(store, T0);
  });
  afterEach(() => store.close());

  const decisionWith = (
    options: { id: string; label: string; consequence: string; reversible: boolean }[],
  ): number => {
    const run = store.startRun({
      taskRef, leaseId: `lease-${Math.random()}`, runner: "b",
      branch: "standing-orders/t-1", worktree: "/pool/t-1", ...bareLegacy("build", "claude", null), now: T0,
    });
    const id = store.saveDecision({
      run, urgency: "blocking", recap: "Policy call.", question: "Open or closed?",
      options, recommendation: options[0]?.id ?? "open",
    }, T0);
    store.enqueueNotification(
      { source: { run }, dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked", body: "q" }, T0,
    );
    quietLifecycle(store, T0);
    return id;
  };

  const pair = async (script: ReturnType<typeof scriptedTransport>) => {
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0,
    );
    script.updates.push([privatePair(1, code)]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(1_000) });
  };

  const reply = (updateId: number, replyTo: number, text: string, over: Record<string, unknown> = {}) => ({
    update_id: updateId,
    message: {
      message_id: 9000 + updateId,
      text,
      chat: { id: CHAT, type: "private" },
      from: { id: USER },
      reply_to_message: { message_id: replyTo },
      ...over,
    },
  });

  test("reply → echoed draft → tap answers WITH the note; the wrong shapes stay silent", async () => {
    const script = scriptedTransport();
    await pair(script);
    const decisionId = decisionWith([
      { id: "open", label: "Fail open", consequence: "c", reversible: true },
      { id: "closed", label: "Fail closed", consequence: "c", reversible: true },
    ]);
    // Deliver: the keyboard message id is recorded for reply routing.
    script.updates.push([]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(2_000) });
    const keyboardCall = script.calls.filter(one => one.method === "sendMessage").pop();
    const keyboard = (keyboardCall?.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const chooseOpen = keyboard[0]?.[0]?.callback_data as string;
    // The scripted transport minted message ids from 100; the LAST decision
    // part carried the keyboard.
    const sends = script.calls.filter(one => one.method === "sendMessage").length;
    const keyboardMessageId = 100 + sends - 1;

    // An UNTHREADED message is silence; a FORWARDED reply is silence.
    script.updates.push([
      { update_id: 10, message: { message_id: 9010, text: "cap the store at 10k", chat: { id: CHAT, type: "private" }, from: { id: USER } } },
      reply(11, keyboardMessageId, "forwarded thing", { forward_date: 123 }),
    ]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(3_000) });
    expect(store.liveNoteDraft(1, decisionId, later(3_000))).toBeNull();

    // A real reply drafts, and the bot echoes the EXACT captured text.
    script.updates.push([reply(12, keyboardMessageId, "use per-user but cap the store at 10k entries")]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(4_000) });
    const draft = store.liveNoteDraft(1, decisionId, later(4_000));
    expect(draft?.note).toBe("use per-user but cap the store at 10k entries");
    const echo = script.calls.filter(one => one.method === "sendMessage").pop();
    expect(String(echo?.params["text"])).toContain("| use per-user but cap the store at 10k entries");

    // The tap carries the note into the answer, atomically.
    script.updates.push([{ update_id: 13, callback_query: { id: "cb1", data: chooseOpen, from: { id: USER }, message: { message_id: keyboardMessageId, chat: { id: CHAT } } } }]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const settled = store.getDecision(decisionId);
    expect(settled?.state).toBe("answered");
    expect(settled?.choice).toBe("open");
    expect(settled?.note).toBe("use per-user but cap the store at 10k entries");
    expect(store.liveNoteDraft(1, decisionId, later(5_000))).toBeNull();
  });

  test("an irreversible confirm binds the note it displayed — a newer note strands the armed yes", async () => {
    const script = scriptedTransport();
    await pair(script);
    const decisionId = decisionWith([
      { id: "keep", label: "Keep", consequence: "c", reversible: true },
      { id: "drop", label: "Drop the table", consequence: "gone forever", reversible: false },
    ]);
    script.updates.push([]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(2_000) });
    const keyboard = (script.calls.filter(one => one.method === "sendMessage").pop()?.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const chooseDrop = keyboard[1]?.[0]?.callback_data as string;
    const sends = script.calls.filter(one => one.method === "sendMessage").length;
    const keyboardMessageId = 100 + sends - 1;

    // Note, then arm: the challenge shows the note.
    script.updates.push([reply(20, keyboardMessageId, "only the staging table")]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(3_000) });
    script.updates.push([{ update_id: 21, callback_query: { id: "cb2", data: chooseDrop, from: { id: USER }, message: { message_id: keyboardMessageId, chat: { id: CHAT } } } }]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(4_000) });
    const armEdit = script.calls.filter(one => one.method === "editMessageText").pop();
    expect(String(armEdit?.params["text"])).toContain("| only the staging table");
    const confirmKeyboard = (armEdit?.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const confirmToken = confirmKeyboard[0]?.[0]?.callback_data as string;

    // A NEWER note lands while armed: the confirmation is stranded.
    script.updates.push([reply(22, keyboardMessageId, "actually all of them")]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(5_000) });
    script.updates.push([{ update_id: 23, callback_query: { id: "cb3", data: confirmToken, from: { id: USER }, message: { message_id: keyboardMessageId, chat: { id: CHAT } } } }]);
    await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(6_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    const acks = script.calls.filter(one => one.method === "answerCallbackQuery");
    // The new note consumed the armed challenge, so the confirm tap finds
    // it already dead — the exact stranding the review prescribed.
    expect(String(acks.pop()?.params["text"] ?? "")).toContain("expired");
  });
});

describe("away mode: the digest cadence (mate arc §10)", () => {
  let store: Store;
  let taskRef: number;

  const scripted = () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let failSends = false;
    let nextMessageId = 500;
    const transport: TelegramTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === "getUpdates") return { ok: true, result: [] };
      if (method === "sendMessage") {
        if (failSends) return { ok: false, description: "scripted outage" };
        return { ok: true, result: { message_id: nextMessageId++ } };
      }
      return { ok: true, result: true };
    };
    return { transport, calls, setFail: (on: boolean) => { failSends = on; } };
  };

  const pair = async (script: ReturnType<typeof scripted>) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0);
    const pairing = scriptedTransport();
    pairing.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: pairing.transport, clock: () => later(1_000) });
    expect(passed).toMatchObject({ ok: true, report: { paired: 1 } });
    void script;
  };

  const decision = (): number => {
    const run = store.startRun({ taskRef, leaseId: `lease-${Math.random()}`, runner: "b", branch: "standing-orders/t-1", worktree: "/pool/t-1", ...bareLegacy("build", "claude", null), now: T0 });
    const id = store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "Open or closed?", options: [{ id: "open", label: "Open", consequence: "c", reversible: true }, { id: "closed", label: "Closed", consequence: "c", reversible: true }], recommendation: "open" },
      T0,
    );
    store.enqueueNotification({ source: { run }, dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked a decision", body: "q" }, T0);
    quietLifecycle(store, T0);
    return id;
  };

  const texts = (script: ReturnType<typeof scripted>): string[] =>
    script.calls.filter(one => one.method === "sendMessage").map(one => String(one.params["text"]));

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    quietLifecycle(store, T0);
  });

  afterEach(() => store.close());

  test("off by default: every fact pages as it lands", async () => {
    const script = scripted();
    await pair(script);
    expect(store.telegramDigest().everyMs).toBeNull();
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "merge:1", kind: "merge", subject: "t-1 merged", body: "PR #4 merged." }, T0);
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(2_000) });
    expect(passed).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(texts(script).some(one => one.includes("t-1 merged"))).toBe(true);
    expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(row => row.deliveredAt === null && row.resolvedAt === null)).toHaveLength(0);
  });

  test("with a cadence: routine facts are held unclaimed while a decision and an attention fact page singly; the window elapses and ONE digest carries the routine rows", async () => {
    const script = scripted();
    await pair(script);
    store.setTelegramDigest(60 * 60_000, "alex", later(2_000));
    expect(store.telegramDigest()).toMatchObject({ everyMs: 3_600_000, setBy: "alex" });

    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "merge:1", kind: "merge", subject: "t-1 merged", body: "PR #4 merged.\nsecond line" }, later(3_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "report:1:1", kind: "report-ready", subject: "t-1: report ready", body: "The cookie races." }, later(3_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "stalled:1", kind: "attempts-exhausted", pushClass: "attention", link: "/r/1", subject: "t-1 stalled", body: "three failures" }, later(3_000));
    const decisionId = decision();

    // Inside the window: the decision and the attention fact go out; the
    // routine rows stay pending and UNCLAIMED.
    const first = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(first).toMatchObject({ ok: true, report: { sent: 2 } });
    const sent = texts(script);
    expect(sent.some(one => one.includes("t-1 stalled"))).toBe(true);
    expect(sent.some(one => one.includes("Open or closed?"))).toBe(true);
    expect(sent.some(one => one.includes("t-1 merged"))).toBe(false);
    expect(store.countRoutinePending()).toBe(2);
    expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(row => row.deliveredAt === null && row.resolvedAt === null).map(one => one.dedupeKey).sort()).toEqual(["merge:1", "report:1:1"]);
    expect(store.handle.prepare("SELECT d.claim_owner FROM notification_delivery d JOIN notification n ON n.id = d.notification WHERE n.dedupe_key = 'merge:1'").all().map(row => row["claim_owner"])).toEqual([null]);
    void decisionId;

    // Still inside the window: nothing more goes out.
    const second = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(30 * 60_000) });
    expect(second).toMatchObject({ ok: true, report: { sent: 0 } });

    // The window elapses: one digest, both routine rows finalized with the
    // same receipt, the anchor moved.
    const before = script.calls.length;
    const third = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(61 * 60_000) });
    expect(third).toMatchObject({ ok: true, report: { sent: 2, digests: 1 } });
    const digestSends = script.calls.slice(before).filter(one => one.method === "sendMessage");
    expect(digestSends).toHaveLength(1);
    const digest = String(digestSends[0]?.params["text"]);
    expect(digest).toContain("digest — 2 routine fact(s)");
    expect(digest).toContain("• project · t-1 merged");
    expect(digest).toContain("    PR #4 merged.");
    expect(digest).not.toContain("second line");
    expect(digest).toContain("• project · t-1: report ready");
    expect(digestSends[0]?.params["reply_markup"]).toBeUndefined();
    expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(row => row.deliveredAt === null && row.resolvedAt === null)).toHaveLength(0);
    const receipts = store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(one => one.kind === "merge" || one.kind === "report-ready").map(one => one.receipt);
    expect(new Set(receipts).size).toBe(1);
    expect(store.telegramDigest().lastSentAt).toBe(later(61 * 60_000).toISOString());
  });

  test("a failed digest leaves every row pending and the anchor alone; the next pass sends it whole", async () => {
    const script = scripted();
    await pair(script);
    store.setTelegramDigest(30 * 60_000, "alex", later(2_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "merge:1", kind: "merge", subject: "t-1 merged", body: "PR #4 merged." }, later(3_000));
    script.setFail(true);
    const broken = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(31 * 60_000) });
    expect(broken).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(broken.ok && broken.report.problems.some(one => one.includes("digest of 1"))).toBe(true);
    expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(row => row.deliveredAt === null && row.resolvedAt === null)).toHaveLength(1);
    expect(store.telegramDigest().lastSentAt).toBe(later(2_000).toISOString());
    script.setFail(false);
    const mended = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(32 * 60_000) });
    expect(mended).toMatchObject({ ok: true, report: { sent: 1, digests: 1 } });
    expect(store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(row => row.deliveredAt === null && row.resolvedAt === null)).toHaveLength(0);
  });

  test("a gap that blocks work and a failed publication are attention-class: they page singly under any cadence (v4 review, finding 6)", async () => {
    const script = scripted();
    await pair(script);
    store.setTelegramDigest(24 * 60 * 60_000, "alex", later(2_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "gap:/r:secret:X", kind: "gap", pushClass: "attention", link: "/caps", subject: "X blocks work in /r", body: "set it" }, later(3_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "publication:1:failed", kind: "publication-failed", pushClass: "attention", link: "/r/1", subject: "publication of run #1 gave up", body: "why" }, later(3_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "merge:9", kind: "merge", subject: "t-1 merged", body: "PR #9 merged." }, later(3_000));
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(passed).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(texts(script).some(one => one.includes("X blocks work"))).toBe(true);
    expect(texts(script).some(one => one.includes("publication of run #1"))).toBe(true);
    expect(texts(script).some(one => one.includes("t-1 merged"))).toBe(false);
    expect(store.countRoutinePending()).toBe(1);
  });

  test("a routine row resolved while held never enters a digest; turning the digest off releases everything at the next pass", async () => {
    const script = scripted();
    await pair(script);
    store.setTelegramDigest(60 * 60_000, "alex", later(2_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "gap:/r:secret:X", kind: "gap", subject: "X blocks work", body: "set it" }, later(3_000));
    store.enqueueNotification({ source: { project: REPO }, dedupeKey: "merge:2", kind: "merge", subject: "t-1 merged", body: "PR #5 merged." }, later(3_000));
    store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE dedupe_key = 'gap:/r:secret:X'").run(later(4_000).toISOString());
    store.setTelegramDigest(null, "alex", later(5_000));
    const passed = await bridgePass(store, { readProjects, botId: BOT, transport: script.transport, clock: () => later(6_000) });
    expect(passed).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(texts(script).some(one => one.includes("X blocks work"))).toBe(false);
    expect(texts(script).some(one => one.includes("t-1 merged"))).toBe(true);
  });
});
