/**
 * Toolroll cards (docs/plans/toolroll-cards.md), against a real store: what a lead can and can't put on a card, what each
 * app receives, and that the message survives anything going wrong.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCardSpec } from "./card-catalog.js";
import { runCardCommand } from "./card-cli.js";
import { cardPlainText, discordCardEmbed, slackCardBlocks, telegramCardMessage, webCardHtml } from "./card-render.js";
import { readCardSource } from "./card-sources.js";
import { cardOfProposal, cardsFirst, cardWithin } from "./chat-card.js";
import { cardPart, withoutCard } from "./chat-card-part.js";
import { readChatCard, type ChatCard } from "./contracts/chat-card.js";
import { readChatPart, savedChatPart } from "./contracts/chat-content.js";
import { htmlString } from "./html.js";
import { addCardToFlow, flowCardHref } from "./flow-engine.js";
import { flowDoneCard, flowResultCard } from "./flow-result-card.js";
import { flowSendContent, readFlowSend } from "./flow-send.js";
import { flowSendForStore } from "./contracts/flow-send.js";
import { flowFromSteps } from "./flows.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { executeLeadTool } from "./lead-tools.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { discordPlain } from "./reply-shape.js";
import { fileTaskProposal } from "./proposal.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-11-07T09:00:00Z");
const spec = (...parts: { type: string; props?: Record<string, unknown>; children?: string[] }[]) => {
  const elements: Record<string, unknown> = { c: { type: "Card", props: {}, children: parts.flatMap((one, at) => one.type === "Button" ? [] : [`p${at}`]) } };
  parts.forEach((one, at) => { elements[`p${at}`] = { type: one.type, props: one.props ?? {}, children: one.children ?? [] }; });
  return { root: "c", elements };
};
const table = { type: "Table", props: { source: "tasks" } };

describe("what a spec may say", () => {
  test.each<[string, unknown]>([
    ["a typed table row", spec({ type: "Table", props: { source: "tasks", rows: [["Revenue", "$1,000,000"]] } })],
    ["a typed chart value", spec({ type: "Chart", props: { source: "tasks", chart: "bar", data: [{ label: "Done", value: 999 }] } })],
    ["a typed fact", spec({ type: "Fields", props: { source: "tasks", items: [{ label: "Spend", value: "$0" }] } })],
    ["a model title", spec({ type: "Card", props: { title: "Spend: $0" } }, table)],
    ["a source that isn't one", spec({ type: "Table", props: { source: "database" } })],
    ["a URL on a button", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t", "a"] }, t: { type: "Table", props: { source: "tasks" }, children: [] }, a: { type: "Actions", props: {}, children: ["b"] }, b: { type: "Button", props: { url: "https://evil.example", label: "Open" }, children: [] } } }],
    ["a label on a button", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t", "a"] }, t: { type: "Table", props: { source: "tasks" }, children: [] }, a: { type: "Actions", props: {}, children: ["b"] }, b: { type: "Button", props: { control: "flows", label: "Delete everything" }, children: [] } } }],
    ["an action name on a button", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t", "a"] }, t: { type: "Table", props: { source: "tasks" }, children: [] }, a: { type: "Actions", props: {}, children: ["b"] }, b: { type: "Button", props: { action: "scope_approve" }, children: [] } } }],
    ["an image", spec({ type: "Image", props: { src: "https://evil.example/x.png" } }, table)],
    ["json-render state", spec({ type: "Text", props: { text: { $state: "/secret" } } }, table)],
    ["a repeat", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t"] }, t: { type: "Table", props: { source: "tasks" }, children: [], repeat: { statePath: "/rows" } } } }],
    ["a visible condition", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t"] }, t: { type: "Table", props: { source: "tasks" }, children: [], visible: true } } }],
    ["a cycle", { root: "c", elements: { c: { type: "Card", props: {}, children: ["a"] }, a: { type: "Actions", props: {}, children: ["c"] } } }],
    ["a prototype key", JSON.parse('{"root":"__proto__","elements":{"__proto__":{"type":"Card","props":{},"children":[]}}}')],
    ["a card with only words", spec({ type: "Text", props: { text: "Revenue is $1,000,000." } })],
    ["an unreachable element", { root: "c", elements: { c: { type: "Card", props: {}, children: ["t"] }, t: { type: "Table", props: { source: "tasks" }, children: [] }, u: { type: "Text", props: { text: "hidden" }, children: [] } } }],
  ])("refuses %s", (_name, raw) => {
    expect(readCardSpec(raw).ok).toBe(false);
  });

  test("accepts data with plain words beside it", () => {
    const read = readCardSpec(spec({ type: "Text", props: { text: "These are stuck." } }, { type: "Divider" }, table, { type: "Chart", props: { source: "tasks", chart: "pie" } }));
    expect(read.ok).toBe(true);
  });
});

describe("a saved card", () => {
  const card: ChatCard = { version: 1, title: "Tasks", asOf: now.toISOString(), repos: ["/p/a"], blocks: [
    { kind: "text", text: "Two are stuck." }, { kind: "facts", heading: "Tasks", items: [{ label: "Total", value: "2" }] },
    { kind: "table", heading: "Tasks", origin: "records", columns: [{ label: "Task", numeric: false }, { label: "Cost", numeric: true }], rows: [["<script>alert(1)</script> `x` <!channel> @everyone [a](https://evil.example)", "$1.00"]], more: 3 },
    { kind: "chart", heading: "By state", chart: "pie", points: [{ label: "Done", value: 2, shown: "2" }, { label: "Failed", value: 1, shown: "1" }] },
  ], buttons: [{ label: "Open flows", path: "/flows" }], actions: [{ proposal: 7, label: "Try again" }] };

  test("a value can't become markup, a mention, a link or an early end to its code block, in any app", () => {
    const web = htmlString(webCardHtml(card));
    expect(web).not.toContain("<script>");
    expect(web).toContain("&lt;script&gt;");
    expect(web).not.toContain('href="https://evil.example');
    const blocks = slackCardBlocks({ ...card, blocks: card.blocks.concat(card.blocks[2]!) }, []);
    const coded = blocks.filter(one => (one["text"] as { type?: string } | undefined)?.type === "mrkdwn").map(one => (one["text"] as { text: string }).text).join("");
    expect(coded).toContain("&lt;!channel&gt;");
    expect(coded.replace(/^```|```$/g, "")).not.toContain("`");
    for (const block of blocks) if (block["type"] === "data_table") expect(JSON.stringify(block)).not.toContain("mrkdwn");
    const embed = JSON.stringify(discordCardEmbed(card, discordPlain));
    expect(embed.match(/```/g)).toHaveLength(4);
    const telegram = telegramCardMessage(card);
    expect(telegram.entities.every(one => one.type === "pre" || one.type === "bold")).toBe(true);
    expect(telegram.entities.every(one => one.offset + one.length <= telegram.text.length)).toBe(true);
  });

  test("Slack and Discord get their native forms, and a chart stays readable where there is none", () => {
    const types = slackCardBlocks(card, [{ type: "button" }]).map(one => one["type"]);
    expect(types).toEqual(["header", "context", "section", "section", "data_table", "context", "data_visualization", "context", "actions"]);
    const embed = discordCardEmbed(card, discordPlain) as { fields: { name: string; value: string }[]; footer: { text: string } };
    expect(embed.fields.some(one => one.value.includes("█"))).toBe(true);
    expect(embed.footer.text).toContain("Confirm below: Try again");
    expect(telegramCardMessage(card).text).toContain("█");
  });

  test("the lead's words never borrow the records' standing: labelled as its note in every app, and the records line names only sourced parts", () => {
    const mixed: ChatCard = { ...card, blocks: [{ kind: "text", text: "Verified spend this month: $0.00" }, card.blocks[2]!], actions: [] };
    const lead = "The lead's note, not Toolroll's records";
    const records = "Tables, fields, notes and charts are from Toolroll's records";
    // Plain, and so every fallback: the label sits right above the words, and the records line names the parts it covers.
    const plain = cardPlainText(mixed);
    expect(plain).toContain(`${lead}:\nVerified spend this month: $0.00`);
    expect(plain).toContain(records);
    expect(plain).not.toMatch(/^From Toolroll's records/m);
    // Web: set apart in its own box, labelled.
    const web = htmlString(webCardHtml(mixed));
    expect(web).toContain(`<div class="tc-lead"><p class="tc-note">The lead&#39;s note, not Toolroll&#39;s records</p><p class="tc-text">Verified spend this month: $0.00</p></div>`);
    expect(web).toContain(records.replace("'", "&#39;"));
    // Slack: a context label right before the words.
    const slack = slackCardBlocks(mixed, []);
    const at = slack.findIndex(one => JSON.stringify(one).includes("Verified spend"));
    expect(slack[at - 1]).toEqual({ type: "context", elements: [{ type: "plain_text", text: lead, emoji: false }] });
    expect(JSON.stringify(slack.at(-1))).toContain(records);
    // Discord: the label leads the words in the description; the footer names the sourced parts.
    const embed = discordCardEmbed(mixed, discordPlain) as { description: string; footer: { text: string } };
    expect(embed.description).toBe(`${discordPlain(lead)}:\nVerified spend this month: $0.00`.replace("$", discordPlain("$")));
    expect(embed.footer.text).toContain(discordPlain(records).slice(0, 20));
    // Telegram: the label in bold, then the words.
    const telegram = telegramCardMessage(mixed);
    const label = telegram.text.indexOf(lead);
    expect(telegram.text.slice(label)).toMatch(/^The lead's note, not Toolroll's records\n\nVerified spend this month: \$0\.00/);
    expect(telegram.entities).toContainEqual({ type: "bold", offset: label, length: lead.length });
    // A card with no lead's words keeps the short records line.
    expect(cardPlainText({ ...mixed, blocks: [card.blocks[2]!] })).toContain("From Toolroll's records · ");
  });

  test("the plain version holds everything a card says", () => {
    const plain = cardPlainText(card);
    for (const words of ["Two are stuck.", "Total: 2", "$1.00", "and 3 more", "Failed", "Confirm below: Try again"]) expect(plain).toContain(words);
  });

  test("an app that refuses a card still has the whole message", () => {
    const content = cardPart({ kind: "control", payload: { control: "card", card, plain: cardPlainText(card) } });
    expect(content.link).toEqual({ label: "Open flows", path: "/flows" });
    const saved = readChatPart(savedChatPart(content));
    expect(saved.ok && saved.value.rich?.title).toBe("Tasks");
    const plain = withoutCard(content);
    expect(plain.rich).toBeUndefined();
    expect(plain.text).toBe(cardPlainText(card));
    expect(plain.link).toEqual(content.link);
  });

  test("a changed or unreadable card shows its saved words, and a changed button address never reads", () => {
    expect(cardPart({ kind: "control", payload: { control: "card", card: { ...card, version: 2 }, plain: "The words." } })).toEqual({ text: "The words." });
    expect(readChatCard({ ...card, buttons: [{ label: "x", path: "https://evil.example" }] })).toBeNull();
    expect(readChatCard({ ...card, buttons: [{ label: "x", path: "//evil.example" }] })).toBeNull();
    expect(readChatCard({ ...card, blocks: [{ kind: "table", heading: "h", origin: "records", columns: [{ label: "a", numeric: false }], rows: [["1", "2"]], more: 0 }] })).toBeNull();
  });

  test("a card goes only where every project behind it is reachable", () => {
    expect(cardWithin(card, ["/p/a", "/p/b"])).toBe(true);
    expect(cardWithin(card, ["/p/b"])).toBe(false);
  });

  test("cards come before the proposals they lead to", () => {
    const ordered = cardsFirst([{ kind: "action", payload: {} }, { kind: "control", payload: { control: "card" } }]);
    expect(ordered.map(one => one.kind)).toEqual(["control", "action"]);
  });
});

describe("the lead shows a card", () => {
  let root: string, repo: string, other: string, token: string, store: Store, who: VerifiedApprover, thread: number, session: number;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chat-card-")));
    repo = join(root, "shop"); other = join(root, "bank");
    mkdirSync(repo); mkdirSync(other);
    store = openStore(join(root, "orders.db"));
    const account = addApprover(store, "operator", now);
    if (!account.ok) throw Error("account");
    token = account.token;
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "cards", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
    thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
    const filed = fileTaskProposal(store, { id: "fix-login", title: "Fix the /Users/someone/login page", repo, filedVia: "cli" }, now);
    if (!filed.ok) throw Error(filed.message);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  function lead(name: string, args: Record<string, unknown>) {
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "cards", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const result = executeLeadTool({ store, who, now, step: 1, readDecisions: new Map(), evidenceRoot: root, thread, turn: turn.id, integrations: () => [],
      draft: (kind, payload) => store.draftLeadProposal({ thread, turn: turn.id, kind, payload, ceilingDigest: who.ceilingDigest }, now) }, name, args);
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return result;
  }
  const keptCard = (result: ReturnType<typeof lead>) => {
    if (!result.ok) throw Error(result.message);
    const id = (result.body as { card: number }).card;
    return { id, card: cardOfProposal(store.getLeadProposal(id)!) };
  };

  test("Toolroll fills the card from its records, scrubbed", () => {
    const { card } = keptCard(lead("show_card", { spec: spec(table, { type: "Chart", props: { source: "tasks", chart: "bar" } }) }));
    expect(card?.repos).toEqual([repo]);
    const rows = card!.blocks.find(one => one.kind === "table");
    expect(JSON.stringify(rows)).toContain("Fix the");
    expect(JSON.stringify(rows)).not.toContain("/Users/someone");
    expect(card!.blocks.find(one => one.kind === "chart")).toMatchObject({ points: [{ label: "queued", value: 1, shown: "1" }] });
  });

  test("a card confirms nothing, and no road confirms it", () => {
    const { id } = keptCard(lead("show_card", { spec: spec(table) }));
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "not-confirmable" });
  });

  test("a card can't reach a project outside this person's access", () => {
    expect(lead("show_card", { spec: spec({ type: "Table", props: { source: "tasks", repo: "r9" } }) })).toMatchObject({ ok: false });
    expect(readCardSource({ store, now, who }, "tasks", { repo: other })).toEqual({ problem: "That project is outside your access." });
  });

  test("a project-limited person sees no instance-wide source, as the console's pages refuse them", () => {
    if (!addApprover(store, "sam", now, { name: who.name, token }).ok) throw Error("account");
    expect(store.setAccountProjects("sam", [repo], who.name, now)).toEqual({ ok: true });
    const sam = { name: "sam", repos: [repo] };
    for (const source of ["workers", "mode", "integrations"] as const) expect(readCardSource({ store, now, who: sam, integrations: () => [], workers: () => [] }, source, { repo: null })).toHaveProperty("problem");
    expect(readCardSource({ store, now, who: sam }, "tasks", { repo: null })).toHaveProperty("heading");
  });

  test("spend is an instance operator's, as the Spend page is", () => {
    expect(readCardSource({ store, now, who: { name: "someone-else", repos: [repo] } }, "spend", { repo: null })).toEqual({ problem: "Only an instance operator sees spend." });
  });

  test("a Button's control takes show_control's checks, and its proposal must be this reply's own action", () => {
    const withButton = (props: Record<string, unknown>) => ({ root: "c", elements: { c: { type: "Card", props: {}, children: ["t", "a"] }, t: { type: "Table", props: { source: "tasks" }, children: [] }, a: { type: "Actions", props: {}, children: ["b"] }, b: { type: "Button", props, children: [] } } });
    const shown = keptCard(lead("show_card", { spec: withButton({ control: "flows" }) }));
    expect(shown.card?.buttons).toEqual([{ label: "Open flows", path: "/flows" }]);
    expect(lead("show_card", { spec: withButton({ control: "task", task: "not-a-task" }) })).toMatchObject({ ok: false });
    // An earlier reply's card, or any proposal that isn't this reply's, is refused.
    expect(lead("show_card", { spec: withButton({ proposal: shown.id }) })).toMatchObject({ ok: false });
  });
});

describe("a flow's result", () => {
  let root: string, store: Store;
  const repo = "/projects/shop";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-card-")));
    store = openStore(join(root, "orders.db"));
    if (!addApprover(store, "operator", now).ok) throw Error("account");
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  test("is built from what the flow recorded, with an agent's report marked as a report", () => {
    const definition = flowFromSteps([{ title: "Requests", kind: "inbox" }, { title: "Tell me", kind: "send" }], null);
    const row = store.getFlow(store.createFlow({ repo, name: "Requests", by: "operator", definitionJson: JSON.stringify(definition) }, now))!;
    expect(addCardToFlow(store, row, { title: "Ask /Users/someone", description: null, stage: null }, "operator", now)).toMatchObject({ ok: true });
    const card = store.flowCards(row.id, true)[0]!;
    const result = flowResultCard(store, row, definition, card, new Date(now.getTime() + 120_000), { items: [{ title: "$9 a month", source: "Example" }] })!;
    expect(result.repos).toEqual([repo]);
    expect(JSON.stringify(result)).not.toContain("/Users/someone");
    expect(result.blocks.find(one => one.kind === "table" && one.origin === "records")).toMatchObject({ columns: [{ label: "Step" }, { label: "Result" }, { label: "Took" }] });
    expect(result.blocks.find(one => one.kind === "table" && one.origin === "report")).toMatchObject({ heading: "Found" });
    expect(cardPlainText(result)).toContain("Reported by the agent, not Toolroll's records");
    expect(result.buttons[0]).toEqual({ label: "Open card", path: flowCardHref(row.id, card.id) });
    // What a "Send to me" keeps reads back with its card, so every app shows the same one.
    const stage = definition.stages.find(one => one.kind === "send")!;
    const content = flowSendContent(store, row, definition, stage, card, now);
    expect(readFlowSend(flowSendForStore(content))?.card?.title).toBe(content.card?.title);
    expect(flowDoneCard(store, { dedupeKey: `flow-card:${card.id}:done:1:operator` }, now)?.repos).toEqual([repo]);
    expect(flowDoneCard(store, { dedupeKey: `flow-card:${card.id}:comment:1:operator` }, now)).toBeNull();
  });
});

describe("toolroll card", () => {
  let root: string, store: Store;
  const repo = "/projects/shop";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "card-cli-")));
    store = openStore(join(root, "orders.db"));
    if (!addApprover(store, "operator", now).ok) throw Error("account");
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (positional: string[], options: [string, string][] = [], actor: string | null = "operator", json = false) => {
    const lines: string[] = [];
    return { code: runCardCommand(positional, new Map(options), { store, write: line => lines.push(line), json, now, actor, repos: [repo] }), lines };
  };

  test("shows the same card chat does, and refuses what the person can't see", () => {
    expect(run(["projects"]).code).toBe(0);
    expect(run(["projects"]).lines.join("\n")).toContain("Projects: 1");
    expect(JSON.parse(run(["projects"], [], "operator", true).lines[0]!).card.repos).toEqual([repo]);
    expect(run(["nothing"]).code).toBe(2);
    expect(run(["projects"], [], null).code).toBe(2);
    expect(run(["projects"], [["repo", "/projects/bank"]]).lines.join("")).toContain("outside your access");
  });
});
