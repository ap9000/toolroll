/**
 * The lead's per-turn bundle (lead-context.ts): who it is, who it is talking to, the channel, what needs them, then
 * projects by name with their active decisions, then the rest, within 8 KB with the least important dropped first.
 * The flow detail lives in the flow tools' descriptions, not the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { firstNameOf, leadChannelOf, leadContext, LEAD_CONTEXT_MAX_BYTES } from "./lead-context.js";
import { firstSentenceOf } from "./assignment-brief.js";
import { register } from "./runner.js";
import { acquire, finalize } from "./claim.js";
import { leadClaim } from "./lead-voice.js";
import { checkLeadIdentity, DEFAULT_LEAD_NAME, DEFAULT_LEAD_PERSONA, leadIdentityOf } from "./lead-identity.js";
import { LEAD_CONTRACT, LEAD_CONTRACT_VERSION } from "./lead-contract.js";
import { LEAD_TOOL_SCHEMAS, projectLabelForLead, redactForLead } from "./lead-tools.js";

const T0 = new Date("2026-10-02T13:05:00.000Z");
const WEB = "/repo/web-shop", API = "/repo/payments-api";

describe("the lead's bundle", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex.pelletier", "h".repeat(64), T0);
  });
  afterEach(() => store.close());

  const file = (id: string, repo: string, title: string) => {
    const filed = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
  };
  // A saved active decision as project memory stores it (recording one needs a real repository).
  const decide = (repo: string, claim: string, why: string, at: Date) => store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,decided_by,decided_at,source_kind,recorded_by,sha)
    VALUES (?,'i',1,?,?,'active','alex.pelletier',?,'manual','alex.pelletier','s')`).run(repo, claim, why, at.toISOString());
  const names = (path: string) => path.split("/").pop()!;
  const bundle = (options: Parameters<typeof leadContext>[3] = {}) =>
    JSON.parse(leadContext(store, [WEB, API], T0, { owner: "alex.pelletier", channel: "telegram", timeZone: "Europe/London", projectName: names, ...options }));

  test("c2: ordered who I am, who you are, the channel, what needs you, projects by name with active decisions, then the rest", () => {
    file("checkout-fix", WEB, "Fix the checkout button");
    decide(WEB, "Use Stripe Checkout", "Hosted pages keep card data off our servers.\nWe looked at Adyen too.", T0);
    decide(WEB, "Ship on Tuesdays", "Support is fully staffed then. Fridays are quiet.", new Date(T0.getTime() + 60_000));
    const data = bundle();
    expect(Object.keys(data).slice(2, 10)).toEqual(["me", "you", "aboutYou", "people", "channel", "needsYou", "projects", "rest"]);
    expect(data.me).toEqual({ name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA });
    expect(data.you).toEqual({ firstName: "Alex", timeZone: "Europe/London", today: "Friday 2026-10-02 14:05" });
    expect(data.channel).toMatchObject({ id: "telegram", fit: expect.stringContaining("Telegram") });
    expect(data.needsYou.map((one: { title: string }) => one.title)).toEqual(["Fix the checkout button"]);
    // Projects by name, never r1..rN alone; decisions newest first, each a title and its reason in one line.
    expect(data.projects).toEqual([
      { repo: "r1", name: "web-shop", decisions: [
        { id: 2, title: "Ship on Tuesdays", why: "Support is fully staffed then." },
        { id: 1, title: "Use Stripe Checkout", why: "Hosted pages keep card data off our servers." },
      ] },
      { repo: "r2", name: "payments-api", decisions: [] },
    ]);
    expect(data.rest).toMatchObject({ tasks: [] });
  });

  test("c2: over 8 KB, the rest goes first, then the oldest decisions, then Needs you; who I am, who you are and the channel stay", () => {
    for (let index = 0; index < 5; index++) file(`task-${index}`, index % 2 ? WEB : API, `Task ${index}`);
    // Finished work is the rest: it goes before anything else.
    for (let index = 0; index < 3; index++) { file(`old-${index}`, WEB, `Task old ${index}`); expect(store.cancelTask(`old-${index}`, T0, "Not needed")).toEqual({ ok: true }); }
    for (let index = 0; index < 8; index++) decide(WEB, `Decision ${index + 1} ${"about the checkout ".repeat(6)}`, "Because the reason is long.", new Date(T0.getTime() + index * 1000));
    const sized = (padding: number) => {
      const document = leadContext(store, [WEB, API], T0, { owner: "alex.pelletier", channel: "slack", projectName: names,
        redact: text => text.replace(/^(Task|Decision) /, one => `${one}${"padding ".repeat(padding)}`) });
      expect(Buffer.byteLength(document)).toBeLessThanOrEqual(LEAD_CONTEXT_MAX_BYTES);
      const data = JSON.parse(document);
      expect(data.me.name).toBe("Lead");
      expect(data.you.firstName).toBe("Alex");
      expect(data.channel.id).toBe("slack");
      return data;
    };
    // Growing past the cap: the oldest decisions go first (the newest stay), and Needs you is trimmed only once
    // no decision is left, from its least pressing end, and counted.
    let rest = false, partial = false, trimmed = false;
    for (let padding = 0; padding <= 200; padding += 5) {
      const data = sized(padding);
      if (data.rest.tasks.length > 0) { expect(data.projects[0].decisions).toHaveLength(8); expect(data.needsYou).toHaveLength(5); rest = true; continue; }
      const kept = data.projects[0].decisions.map((one: { id: number }) => one.id);
      expect(kept).toEqual([8, 7, 6, 5, 4, 3, 2, 1].slice(0, kept.length));
      if (data.needsYou.length < 5) {
        expect(data.projects.every((one: { decisions: unknown[] }) => one.decisions.length === 0)).toBe(true);
        expect(data.omissions.assignments).toBeGreaterThanOrEqual(5 - data.needsYou.length);
        trimmed = true;
      } else if (kept.length > 0 && kept.length < 8) partial = true;
    }
    expect([rest, partial, trimmed]).toEqual([true, true, true]);
  });

  test("c2: the whole bundle is scrubbed; only the lead's name, the person's first name and the project labels are put back", () => {
    file("ask-alex", WEB, "Ask alex.pelletier about /repo/web-shop/src");
    decide(WEB, "Keep web-shop on Node", "alex.pelletier wants one runtime.", T0);
    store.setLeadConfig("alex.pelletier", "Alex", "Answer alex.pelletier briefly.", T0);
    const view = { repos: [WEB, API], names: ["alex.pelletier", "alex"] };
    const data = bundle({ redact: text => redactForLead(text, view), projectName: (path, index) => projectLabelForLead(path, index, view.names) });
    const document = JSON.stringify(data);
    // Titles, decisions, the persona and the omission notes are all scrubbed; the lead's own name is the owner's choice...
    expect(data.needsYou[0].title).toBe("Ask [approver] about [path]");
    expect(data.projects[0].decisions[0]).toMatchObject({ title: "Keep [path] on Node", why: "[approver] wants one runtime." });
    expect(data.me).toEqual({ name: "Alex", persona: "Answer [approver] briefly." });
    expect(document).not.toContain("alex.pelletier");
    expect(document).not.toContain("/repo/");
    // ...and the two names carried on purpose come back.
    expect(data.you.firstName).toBe("Alex");
    expect(data.projects.map((one: { name: string }) => one.name)).toEqual(["web-shop", "payments-api"]);
  });

  test("c2: failed and stopped tasks waiting on the person are in Needs you; one their lead is on is not", () => {
    register(store, { name: "w", host: "t", capacity: 9, repos: [WEB], now: T0, newToken: () => "tok" });
    const failed = (id: string, title: string) => {
      file(id, WEB, title);
      const ref = store.refFor("built-in", id).id;
      const took = acquire(store, ref, "w", { now: T0, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
      if (!took.ok) throw new Error(took.reason);
      const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "w", branch: "so/t", worktree: "/pool/t",
        route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
      store.finishRun(run, { outcome: "failed", reason: "agent", now: T0 });
      expect(finalize(store, `lease-${id}`, { kind: "complete", state: "failed", now: T0 }).ok).toBe(true);
    };
    failed("release", "Release 0.9.16");
    failed("flags", "Drop old flags");
    file("paused", WEB, "Paused migration");
    store.hold(store.refFor("built-in", "paused").id, "Paused by alex.pelletier", null, T0);
    expect(leadClaim(store, { account: "alex.pelletier", lead: true }, "flags", T0).ok).toBe(true);
    const data = bundle();
    expect(data.needsYou.map((one: { title: string }) => one.title).sort()).toEqual(["Paused migration", "Release 0.9.16"]);
    // The lead took this one on: it waits on nobody, so it is the rest.
    expect(data.rest.tasks.map((one: { title: string }) => one.title)).toEqual(["Drop old flags"]);
  });

  test("c2: a decision's reason is its first sentence, never cut at an abbreviation", () => {
    expect(firstSentenceOf("Small payment providers, e.g. Stripe or Adyen, keep card data off our servers. We looked at more.")).toBe("Small payment providers, e.g. Stripe or Adyen, keep card data off our servers.");
    expect(firstSentenceOf("Faster builds, i.e. under 5 minutes. Also cheaper.")).toBe("Faster builds, i.e. under 5 minutes.");
    expect(firstSentenceOf("One line\nsecond line")).toBe("One line");
    // Abbreviations in any case; "No." ends a sentence unless a number follows it.
    expect(firstSentenceOf("Card data stays off our servers, E.g. Stripe holds it. We looked at more.")).toBe("Card data stays off our servers, E.g. Stripe holds it.");
    expect(firstSentenceOf("Faster builds, I.E. Under 5 minutes. Also cheaper.")).toBe("Faster builds, I.E. Under 5 minutes.");
    expect(firstSentenceOf("No. The old page confuses people.")).toBe("No.");
    expect(firstSentenceOf("We said no. It confuses people.")).toBe("We said no.");
    expect(firstSentenceOf("Ticket No. 5 settled it. Also cheaper.")).toBe("Ticket No. 5 settled it.");
    decide(API, "Use Postgres", "Mature tooling, e.g. Postgres has pg_dump. Also familiar.", T0);
    expect(bundle().projects[1].decisions[0].why).toBe("Mature tooling, e.g. Postgres has pg_dump.");
  });

  test("c1: the name and persona the owner saved are who the lead is; a shared team conversation keeps its own lead's name", () => {
    store.setLeadConfig("alex.pelletier", "Maya", "Dry humour. Keep it short.", T0);
    expect(bundle().me).toEqual({ name: "Maya", persona: "Dry humour. Keep it short." });
    expect(leadIdentityOf(store, "someone-else")).toEqual({ name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA });
    expect(bundle({ leadName: "Ops lead" }).me.name).toBe("Ops lead");
    // The owner's settings are checked: blank means the default, and the name is plain words.
    expect(checkLeadIdentity("  ", "")).toEqual({ ok: true, identity: { name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA } });
    expect(checkLeadIdentity("<b>Maya</b>", "x")).toMatchObject({ ok: false });
    expect(checkLeadIdentity("M".repeat(41), "x")).toMatchObject({ ok: false });
    expect(checkLeadIdentity("Maya", "p".repeat(601))).toMatchObject({ ok: false });
    expect(firstNameOf("sam@example.com")).toBe("Sam");
  });

  test("c3: the lead is told the channel, and the flow detail lives in the flow tools' descriptions", () => {
    expect(bundle({ channel: "console" }).channel.id).toBe("console");
    // Each chat surface names its own channel; an unknown one names none rather than being called Teams.
    expect(["Slack", "Discord", "Teams", "Telegram"].map(leadChannelOf)).toEqual(["slack", "discord", "teams", "telegram"]);
    expect(leadChannelOf("Mattermost")).toBeUndefined();
    expect(bundle({ channel: undefined }).channel).toBeNull();
    expect(LEAD_CONTRACT_VERSION).toBe(48);
    expect(LEAD_CONTRACT).toContain("channel: where this conversation is; fit your replies to it");
    // The contract names the flow tools and no longer carries their detail.
    expect(LEAD_CONTRACT).toContain("Read get_flows");
    for (const detail of ["Jev", "soul file", "goto: <answer>", "Issues to PRs", "Holding, Build and Research"]) expect(LEAD_CONTRACT).not.toContain(detail);
    const description = (name: string) => LEAD_TOOL_SCHEMAS.find(one => one.name === name)!.description;
    expect(description("get_flows")).toContain("Holding, Build and Research (each files an ordinary task), Person decides, Message, Done");
    expect(description("get_flows")).toContain("soul file");
    expect(description("get_flows")).toContain("'flow <the flow's number>'");
    expect(description("propose_flow")).toContain("use decider 'me' when they decide");
    expect(description("propose_flow")).toContain("The Issues to PRs template");
    expect(description("propose_flow")).toContain("propose_subagent use_tool, stop_tool and tool_rule");
    // D5: the lead delegates to its named subagents; a message naming one is the lead's to pass on, with a card.
    expect(LEAD_CONTRACT).toContain("When the operator says 'ask Rosa to …' or writes to one by name ('@rosa, …'), delegate with propose_subagent ask");
    expect(description("propose_subagent")).toContain("ask: delegate to a subagent");
    expect(description("get_flows")).toContain("propose_subagent ask puts it on its desk once they confirm");
  });
});
