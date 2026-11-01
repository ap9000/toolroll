/**
 * After research, a flow's message explains each example (flow-items.ts): every report item numbered under the summary,
 * its title in bold, its why in plain lines and its link named by its source, within each chat app's limit with every
 * link kept; each screenshot captioned with its item's number, title and how it plugs in; and the console card shows
 * the same. Its words go through each channel's cleaner; past a limit it splits into parts rather than send over it.
 * A report with no items reads as before. Scripted Telegram transport and a real store; no live account.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { advanceFlows } from "./flow-engine.js";
import { readFlowSend } from "./flow-send.js";
import { cleanFlowMessage, fitFlowMessage, type FlowSendItem } from "./flow-items.js";
import { flowFromSteps } from "./flows.js";
import { flowSendParts } from "./chat-flow.js";
import { renderReply } from "./reply-shape.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";

const T0 = new Date("2026-10-04T09:00:00.000Z");
const ALPHA = "/projects/alpha";
const BOT = "777000", CHAT = 4242, ORIGIN = "https://console.example";
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

function png(width: number, height: number, fill: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(300, fill)]);
}

let dir: string, root: string, store: Store, now: Date;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-items-")));
  root = join(dir, "evidence");
  mkdirSync(root);
  store = openStore(join(dir, "state.db"));
  now = T0;
  if (!addApprover(store, "alex", now).ok) throw new Error("approver");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A long why in the research's three parts, padded to about `size` characters. */
const longWhy = (pattern: string, plug: string, size = 990) => {
  const fits = "it fits us because the settings page has the same long list of unrelated toggles and people get lost in it";
  const filler = " and it keeps every control one tap away".repeat(40);
  const middle = `${fits}${filler}`.slice(0, Math.max(10, size - pattern.length - plug.length - 4));
  return `${pattern}; ${middle}; ${plug}`;
};

const ITEMS = [
  { title: "Linear groups settings under five headings", why: longWhy("Grouped settings with a short heading per group", "plugs into our Settings page as five sections"), url: "https://mobbin.com/screens/linear-settings-1", image: "linear.png" },
  { title: "Notion keeps the search box at the top", why: longWhy("A search box above every setting", "plugs in as one search field over the groups"), url: "https://www.notion.so/help/settings", image: "notion.png" },
  { title: "Apple shows one primary action per row", why: longWhy("One action per row, details on tap", "plugs in by moving rare controls into disclosures"), url: "https://developer.apple.com/design/human-interface-guidelines/settings", image: "apple.png" },
];

/** A research task whose report has `items`, with a screenshot each (and one extra, saved first, that no item uses). */
function research(id: string, items: typeof ITEMS, summary = "Three products group long settings well; each pattern below fits our Settings page.") {
  store.createTask({ id, title: "Find UI inspiration" }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, ALPHA, {}, now);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "worker-1", branch: `so-scout/${id}`, worktree: `/pool/${id}`, role: "scout", ...legacy, now });
  const files = ["extra.png", ...items.flatMap(one => one.image === null ? [] : [one.image])];
  const stored = files.map((file, n) => storeEvidence(store, root, run, "screenshot", `report-image-${n + 1}.png`, png(1200, 800, n + 1), `scout screenshot ${file} (validated png)`, now));
  const sha = (artifact: number) => store.artifactsFor(run).find(one => one.id === artifact)!.sha256;
  const images = files.map((file, n) => ({ file, caption: `The ${file.replace(".png", "")} page`, url: "https://example.com/page", sha256: sha(stored[n]!), artifact: stored[n]! }));
  const report = { title: "Settings inspiration", summary, report: "## Findings", followUps: [], items, images };
  storeEvidence(store, root, run, "report", "report.json", Buffer.from(JSON.stringify(report)), "scout handoff (verified tree)", now);
  store.finishRun(run, { outcome: "built", reason: "report-delivered", now });
  store.setTaskState(id, "done", now);
  return { run, shots: stored };
}

/** A flow whose research step just handed its task to a Send (or Choose) step. */
function cardAfterResearch(task: string, next: "send" | "choose" = "send", summary = "Three products group long settings well; each pattern below fits our Settings page."): { flow: number; card: number } {
  const step = next === "send" ? { id: "tell", title: "Send me the result", kind: "send" } : { id: "tell", title: "Your pick", kind: "choose", options: [{ label: "Implement", goesTo: "end" }, { label: "Ignore", goesTo: "end" }] };
  const flow = store.createFlow({ repo: ALPHA, name: "UI inspiration", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ id: "find", title: "Find UI inspiration", kind: "report" }, step], null)) }, now);
  const card = store.addFlowCard({ flow, title: "Settings", description: null, stage: "find", by: "alex", byKind: "person" }, now);
  store.updateFlowCard(card, { outputs: { find: summary } }, now);
  store.moveFlowCard(card, { to: "tell", outcome: "ok", actor: "flow", task }, now);
  advanceFlows(store, ALPHA, now, { evidenceRoot: root });
  return { flow, card };
}

type Call = { method: string; params: Record<string, unknown>; messageId?: number };
function pair(): void {
  const code = mintPairingCode();
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
  expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(CHAT), updateId: 1 }, now).ok).toBe(true);
}
function scripted() {
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let id = 500;
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") return { ok: true, result: updates.shift() ?? [] };
    const messageId = method === "sendMessage" || method === "sendPhoto" ? id++ : undefined;
    calls.push({ method, params, ...(messageId === undefined ? {} : { messageId }) });
    if (method === "sendMediaGroup") return { ok: true, result: (params["media"] as unknown[]).map(() => ({ message_id: id++ })) };
    if (messageId !== undefined) return { ok: true, result: { message_id: messageId } };
    return { ok: true, result: true };
  };
  return { transport, calls, updates };
}
const pass = (script: ReturnType<typeof scripted>) => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [ALPHA],
  conversation: { evidenceRoot: root, phoneOrigin: () => ORIGIN } });

describe("reading an item", () => {
  test("when head, links and tail alone are over the limit, it goes in parts within it, nothing cut and every link whole", () => {
    const items: FlowSendItem[] = [1, 2, 3].map(n => ({ title: `Item ${n}`, why: `pattern ${n}; fits us; plugs in ${n}`, url: `https://site${n}.example/${"p".repeat(300)}`, source: `Site${n}`, plug: "", shot: null }));
    const head = `Flow: ${"a very long card title ".repeat(60)}`;
    const message = { head, summary: "The summary.", items, tail: ["Choose one."] };
    const measure = (shaped: string) => renderReply(shaped, "discord").length;
    const parts = fitFlowMessage(message, 1000, measure);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(measure(part)).toBeLessThanOrEqual(1000);
    const all = parts.join("");
    for (const one of items) expect(parts.some(part => part.includes(`[${one.source}](${one.url})`))).toBe(true);
    for (const n of [1, 2, 3]) expect(all).toContain(`Plugs in ${n}`);
    expect(all.replace(/\s/g, "")).toContain(head.replace(/\s/g, ""));
    expect(parts.at(-1)!.endsWith("Choose one.")).toBe(true);
  });

  test("its words go through the channel's cleaner; links do not", () => {
    const item: FlowSendItem = { title: "A\u0007 title", why: "why\r\nmore", url: "https://mobbin.com/x\u0007", source: "Mobbin", plug: "", shot: null };
    const clean = (text: string) => text.replace(/[\u0000-\u001f]/g, "");
    const cleaned = cleanFlowMessage({ head: "h\u0007", summary: "s\u0007", items: [item], tail: ["t\u0007"] }, clean);
    expect(cleaned).toEqual({ head: "h", summary: "s", items: [{ ...item, title: "A title", why: "whymore" }], tail: ["t"] });
  });
});

describe("c1: the items' words are cleaned and the message is never over a limit", () => {
  test("Slack, Discord and Teams: a kept content's words go through chatFlowText before fitting", () => {
    research("look-8", ITEMS);
    const { card } = cardAfterResearch("look-8");
    const kept = readFlowSend(store.flowSend(card, 2)!.contentJson)!;
    const dirty = { ...kept, summary: `Summary\u0007 line\r\n\r\n\r\n\r\nnext`, items: kept.items!.map(one => ({ ...one, title: `${one.title}\u0007`, why: `${one.why}\u0001` })) };
    store.recordFlowSend({ card, entry: 9, stage: "tell", person: "alex", contentJson: JSON.stringify(dirty) }, now);
    for (const app of ["slack", "discord", "teams"] as const) {
      const parts = flowSendParts(store, { dedupeKey: `flow-send:${card}:9`, subject: "Settings\u0007 · Find UI inspiration", body: "" }, app)!;
      const text = parts.map(one => one.text).join("\n");
      expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\r]/);
      expect(text).toContain("Summary line\n\nnext");
      expect(text).toContain(`**${ITEMS[0]!.title}**`);
    }
  });

  test("Telegram: the same, as several messages each within 4096, each with its own bold and links, the buttons on the last", async () => {
    pair();
    const { run } = research("look-10", ITEMS);
    const { card } = cardAfterResearch("look-10");
    const script = scripted();
    await pass(script);
    store.recordFlowSend({ card, entry: 9, stage: "tell", person: "alex", contentJson: store.flowSend(card, 2)!.contentJson }, now);
    const huge = `Huge ${"Settings · Find UI inspiration for a very long settings page ".repeat(80)}`;
    store.enqueueNotification({ dedupeKey: `flow-send:${card}:9`, kind: "flow-card", recipient: "alex", subject: huge, body: "", source: { run } }, now);
    const before = script.calls.length;
    await pass(script);
    const sends = script.calls.slice(before).filter(one => one.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    for (const one of sends) expect(String(one.params["text"]).length).toBeLessThanOrEqual(4096);
    const links = sends.flatMap(one => ((one.params["entities"] ?? []) as Array<{ type: string; offset: number; length: number; url?: string }>)
      .filter(entity => entity.type === "text_link").map(entity => [String(one.params["text"]).slice(entity.offset, entity.offset + entity.length), entity.url]));
    expect(links).toEqual([["Mobbin", ITEMS[0]!.url], ["Notion", ITEMS[1]!.url], ["Apple", ITEMS[2]!.url]]);
    expect(sends.slice(0, -1).every(one => one.params["reply_markup"] === undefined)).toBe(true);
    expect(sends.at(-1)!.params["reply_markup"]).toBeDefined();
  });

});

