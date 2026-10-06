/**
 * Trigger payloads (item 15): each outside payload is read by its one schema, non-strict, and a delivery, poll or form
 * gets the answer it got from the 0.9.41 hand readers — pinned here against a real store, and the item readers against
 * a frozen copy of those hand readers over odd values in every field they read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore, type Store } from "../store.js";
import { flowFromSteps } from "../flows.js";
import { addFlowTriggerTo, githubItem, githubRunItem, linearItem, receiveFlowForm, receiveFlowHook, saveLinearSigningSecret, shareFlowButton, type TriggerConfig } from "../flow-triggers.js";
import { parseObservationCases } from "../observations.js";
import { jsonSchemaKeywords } from "./contract-test.js";
import { formSubmissionSchema, githubEventSchema, githubIssueEventListSchema, githubIssueListSchema, githubRunListSchema, inboundMailSchema, linearAnswerSchema, linearEventSchema, readFormSubmission, readInboundMail } from "./trigger-payloads.js";
import { observationRequestSchema } from "./observation-request.js";

const T0 = new Date("2026-10-06T09:00:00.000Z");

// ------------------------------------------------------------- the 0.9.41 hand readers, frozen
const text = (value: unknown) => typeof value === "string" ? value : "";
const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const TEAM = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
type GithubConfig = Extract<TriggerConfig, { kind: "github" }>;
type LinearConfig = Extract<TriggerConfig, { kind: "linear" }>;
function legacyGithubItem(config: GithubConfig, raw: unknown, what: "issue" | "pull") {
  const item = record(raw);
  const number = Number(item["number"]);
  if (!Number.isSafeInteger(number)) return null;
  if (what === "issue" && item["pull_request"] !== undefined) return null;
  if (what === "pull" && item["draft"] === true) return null;
  const labels = Array.isArray(item["labels"]) ? item["labels"].map(one => text(record(one)["name"]).toLowerCase()) : [];
  if (config.label !== null && !labels.includes(config.label.toLowerCase())) return null;
  const label = what === "issue" ? `GitHub issue #${number}` : `Pull request #${number}`;
  const key = `${what}:${number}`, at = text(item["updated_at"]) || null;
  if (config.from === "team" && !TEAM.has(text(item["author_association"]))) return { key, skip: "opened by someone without write access", label, at };
  const login = text(record(item["user"])["login"]) || "someone";
  const branches = what === "pull" ? ` (${text(record(item["head"])["ref"])} → ${text(record(item["base"])["ref"])})` : "";
  return { key, at, title: text(item["title"]) || label,
    description: `From ${what === "issue" ? "GitHub issue" : "pull request"} #${number} by @${login}${branches}:\n\n${text(item["body"])}`.trim().slice(0, 4000),
    source: { kind: "github", label, url: text(item["html_url"]) || null } };
}
function legacyGithubRunItem(config: GithubConfig, raw: unknown) {
  const run = record(raw);
  if (text(run["conclusion"]) !== "failure" || (config.branch !== null && text(run["head_branch"]) !== config.branch)) return null;
  const sha = text(run["head_sha"]);
  if (sha === "") return null;
  const name = text(run["name"]) || "Checks";
  const commit = text(run["display_title"]);
  return { key: `checks:${sha}`, at: text(run["created_at"]) || null, title: `Checks failed on ${config.branch}: ${name}`,
    description: `From GitHub: “${name}” failed on ${config.branch} at ${sha.slice(0, 7)}${commit === "" ? "" : ` (${commit})`}.\nRun: ${text(run["html_url"])}`,
    source: { kind: "github", label: `Failed check on ${config.branch}`, url: text(run["html_url"]) || null } };
}
function legacyLinearItem(config: LinearConfig, raw: unknown) {
  const issue = record(raw);
  const identifier = text(issue["identifier"]);
  if (identifier === "") return null;
  const labelNodes = Array.isArray(issue["labels"]) ? issue["labels"] : Array.isArray(record(issue["labels"])["nodes"]) ? record(issue["labels"])["nodes"] as unknown[] : [];
  const labels = labelNodes.map(one => text(record(one)["name"]).toLowerCase());
  if (config.team !== null && text(record(issue["team"])["key"]).toUpperCase() !== config.team) return null;
  if (config.state !== null && text(record(issue["state"])["name"]).toLowerCase() !== config.state.toLowerCase()) return null;
  if (config.label !== null && !labels.includes(config.label.toLowerCase())) return null;
  return { key: `linear:${identifier}`, at: text(issue["updatedAt"]) || null, title: text(issue["title"]) || identifier,
    description: `From Linear ${identifier}:\n\n${text(issue["description"])}`.trim().slice(0, 4000),
    source: { kind: "linear", label: `Linear ${identifier}`, url: text(issue["url"]) || null } };
}

/** Odd values in every place a hand reader looked: missing, null, wrong types, empty, nested. */
const ODD: unknown[] = [undefined, null, 0, 7, "7", "", "x", true, false, [], {}, [{ name: "Bug" }], { name: "Bug" }, { nodes: [{ name: "bug" }, null, 3] }];
function variants(base: Record<string, unknown>, keys: readonly string[]): unknown[] {
  const out: unknown[] = [base, null, undefined, 3, "text", [base]];
  for (const key of keys) for (const value of ODD) out.push(value === undefined ? Object.fromEntries(Object.entries(base).filter(([one]) => one !== key)) : { ...base, [key]: value, extra: { ignored: true } });
  return out;
}

const issue = { number: 12, title: "Checkout breaks", body: "Steps", html_url: "https://github.com/acme/shop/issues/12", author_association: "MEMBER", user: { login: "sam" },
  labels: [{ name: "Bug" }, "loose", null], created_at: "2026-10-06T08:00:00Z", updated_at: "2026-10-06T08:05:00Z", head: { ref: "fix" }, base: { ref: "main" }, draft: false };
const run = { conclusion: "failure", head_branch: "main", head_sha: "0123456789abcdef", name: "CI", display_title: "Fix it", created_at: "2026-10-06T08:00:00Z", html_url: "https://github.com/acme/shop/actions/runs/1" };
const linear = { identifier: "ENG-4", title: "Slow page", description: "Detail", url: "https://linear.app/acme/issue/ENG-4", updatedAt: "2026-10-06T08:00:00Z",
  state: { name: "Todo" }, team: { key: "eng" }, labels: { nodes: [{ name: "Bug" }] } };

describe("trigger payload readers match the 0.9.41 hand readers", () => {
  const github = (over: Partial<GithubConfig>): GithubConfig => ({ kind: "github", repo: "acme/shop", watch: "issues", label: null, branch: null, from: "team", delivery: "poll", zone: null, ...over });
  const linearConfig = (over: Partial<LinearConfig>): LinearConfig => ({ kind: "linear", team: null, state: null, label: null, delivery: "poll", zone: null, ...over });

  it("reads every odd issue, pull request, run and Linear issue exactly as before", () => {
    let compared = 0;
    for (const config of [github({}), github({ label: "bug", from: "anyone" }), github({ from: "anyone" })]) {
      for (const raw of variants(issue, Object.keys({ ...issue, pull_request: 1 }))) {
        for (const what of ["issue", "pull"] as const) { expect(githubItem(config, raw, what)).toEqual(legacyGithubItem(config, raw, what)); compared++; }
      }
    }
    for (const config of [github({ watch: "checks", branch: "main" }), github({ watch: "checks", branch: null })]) {
      for (const raw of variants(run, Object.keys(run))) { expect(githubRunItem(config, raw)).toEqual(legacyGithubRunItem(config, raw)); compared++; }
    }
    for (const config of [linearConfig({}), linearConfig({ team: "ENG", state: "todo", label: "bug" }), linearConfig({ label: "bug" })]) {
      for (const raw of [...variants(linear, Object.keys(linear)), { ...linear, labels: [{ name: "bug" }] }]) { expect(linearItem(config, raw)).toEqual(legacyLinearItem(config, raw)); compared++; }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("keeps the legacy coercions: a numeric string or null number is still a number", () => {
    expect(githubItem(github({ from: "anyone" }), { ...issue, number: "7" }, "issue")).toMatchObject({ key: "issue:7" });
    expect(githubItem(github({ from: "anyone" }), { ...issue, number: null }, "issue")).toMatchObject({ key: "issue:0" });
    expect(githubItem(github({ from: "anyone" }), { ...issue, pull_request: null }, "issue")).toBeNull();
  });

  it("each schema's JSON Schema survives the round trip and ignores unknown keys", () => {
    for (const schema of [githubIssueListSchema, githubIssueEventListSchema, githubRunListSchema, githubEventSchema, linearAnswerSchema, linearEventSchema, inboundMailSchema, formSubmissionSchema, observationRequestSchema] as z.ZodType[]) {
      const json = z.toJSONSchema(schema, { io: "input" });
      const kept = new Set(jsonSchemaKeywords(z.toJSONSchema(z.fromJSONSchema(json), { io: "input" })));
      expect(jsonSchemaKeywords(json).filter(keyword => !kept.has(keyword))).toEqual([]);
    }
    expect(githubEventSchema.parse({ action: "opened", zen: "Keep it simple", hook: { id: 1 } })).toEqual({ action: "opened" });
    expect(linearEventSchema.parse({ type: 4, action: "create", organizationId: "o" })).toEqual({ type: undefined, action: "create" });
  });
});

describe("mail and form readers", () => {
  it("a mailbox message reads whole, without its unknown keys", () => {
    const mail = { uid: 3, messageId: "<m@example.com>", inReplyTo: null, references: [], from: "sam@example.com", fromName: null, subject: "Hi", text: "Body", automatic: false };
    expect(readInboundMail({ ...mail, raw: "x" } as typeof mail)).toEqual(mail);
  });

  it("a form reads the first value of each field and leaves a missing one null", () => {
    const fields = new URLSearchParams("a0=first&a0=second&t=5&a2=third");
    expect(readFormSubmission(fields, 3)).toEqual({ t: "5", website: null, answers: ["first", null, "third"] });
  });
});

let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-trigger-payloads-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const flowNow = () => store.createFlow({ repo, name: "Intake", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)), by: "alex" }, T0);
function hookOf(settings: Record<string, unknown>) {
  const made = addFlowTriggerTo(store, store.getFlow(flowNow())!, settings, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  return { id: made.id, token: made.reveal!.path.split("/").at(-1)!, secret: made.reveal!.secret };
}
const deliver = (token: string, body: string, headers: Record<string, string> = {}, now = T0) => receiveFlowHook(store, token, { headers, body: Buffer.from(body) }, dir, now);

describe("deliveries get today's answers", () => {
  it("a plain webhook takes any JSON and refuses what isn't", () => {
    const hook = hookOf({ kind: "webhook", titleField: "event.name" });
    expect(deliver(hook.token, "not json")).toEqual({ status: 400, said: "Send JSON." });
    expect(deliver(hook.token, "x".repeat(1_000_001))).toEqual({ status: 413, said: "Too large." });
    expect(deliver(hook.token, "null")).toEqual({ status: 202, said: "Added 1 card." });
    expect(deliver(hook.token, "[1,2]")).toEqual({ status: 202, said: "Added 1 card." });
    expect(deliver(hook.token, JSON.stringify({ event: { name: "Deploy failed" }, extra: true }))).toEqual({ status: 202, said: "Added 1 card." });
    expect(deliver(hook.token, JSON.stringify({ event: { name: 5 }, summary: "ignored" }))).toEqual({ status: 202, said: "Added 1 card." });
    expect(store.flowCards(store.getFlowTrigger(hook.id)!.flow, true).map(card => [card.title, card.description]).sort()).toEqual([
      ["Webhook", "From a webhook:\n\nnull"], ["Webhook", "From a webhook:\n\n[\n  1,\n  2\n]"],
      ["Deploy failed", "From a webhook:\n\n{\n  \"event\": {\n    \"name\": \"Deploy failed\"\n  },\n  \"extra\": true\n}"],
      ["Webhook", "From a webhook:\n\n{\n  \"event\": {\n    \"name\": 5\n  },\n  \"summary\": \"ignored\"\n}"]].sort());
  });

  it("GitHub: JSON before the signature, then the event, with odd bodies read as empty", () => {
    const hook = hookOf({ kind: "github", repo: "acme/shop", watch: "issues", delivery: "webhook", from: "anyone" });
    const signed = (body: string, event: string) => deliver(hook.token, body, { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", hook.secret!).update(body).digest("hex")}` });
    expect(deliver(hook.token, "{", { "x-github-event": "issues" })).toEqual({ status: 400, said: "Send JSON." });
    expect(deliver(hook.token, "{}", { "x-github-event": "issues", "x-hub-signature-256": "sha256=00" })).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(signed("{}", "ping")).toEqual({ status: 200, said: "Connected." });
    expect(signed("null", "issues")).toEqual({ status: 202, said: "Not this repository." });
    expect(signed(JSON.stringify({ action: "opened", repository: "acme/shop" }), "issues")).toEqual({ status: 202, said: "Not this repository." });
    expect(signed(JSON.stringify({ action: "opened", repository: { full_name: "ACME/shop" }, issue: "nope" }), "issues")).toEqual({ status: 202, said: "Nothing for this flow." });
    expect(signed(JSON.stringify({ action: "opened", repository: { full_name: "ACME/shop" }, issue: { ...issue, number: "9" }, sender: { login: "sam" } }), "issues")).toEqual({ status: 202, said: "Added 1 card." });
  });

  it("Linear: secret, signature and age first; then only issue creates and updates", () => {
    const hook = hookOf({ kind: "linear", team: "ENG", delivery: "webhook" });
    expect(deliver(hook.token, "{}")).toEqual({ status: 401, said: "Paste Linear's signing secret on the flow's Triggers panel first." });
    expect(saveLinearSigningSecret(store.getFlowTrigger(hook.id)!, "s".repeat(32), dir)).toEqual({ ok: true });
    const signed = (body: unknown) => { const bytes = JSON.stringify(body); return deliver(hook.token, bytes, { "linear-signature": createHmac("sha256", "s".repeat(32)).update(bytes).digest("hex") }); };
    expect(deliver(hook.token, "{}", { "linear-signature": "00" })).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(signed({ type: "Issue", action: "create" })).toEqual({ status: 401, said: "Too old." });
    expect(signed(null)).toEqual({ status: 401, said: "Too old." });
    expect(signed({ type: "Comment", action: "create", webhookTimestamp: T0.getTime() })).toEqual({ status: 202, said: "Ignored." });
    expect(signed({ type: "Issue", action: "update", webhookTimestamp: String(T0.getTime()), data: "nope" })).toEqual({ status: 202, said: "Nothing for this flow." });
    expect(signed({ type: "Issue", action: "update", webhookTimestamp: T0.getTime(), updatedFrom: { stateId: null }, data: { ...linear, labels: [{ name: "Bug" }] } })).toEqual({ status: 202, said: "Added 1 card." });
  });

  it("a shared form: first values, a missing timestamp thanks and makes nothing", () => {
    const made = addFlowTriggerTo(store, store.getFlow(flowNow())!, { kind: "button", label: "Report", questions: ["What?", "Where?"] }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const shared = shareFlowButton(store, store.getFlowTrigger(made.id)!, T0, dir);
    if (!shared.ok) throw new Error(shared.message);
    const token = shared.reveal!.path.split("/").at(-1)!;
    const later = new Date(T0.getTime() + 60_000);
    expect(receiveFlowForm(store, token, new URLSearchParams("a0=Nothing"), later)).toMatchObject({ status: 200 });
    expect(receiveFlowForm(store, token, new URLSearchParams(`t=${T0.getTime()}&a0=&a0=ignored`), later)).toMatchObject({ status: 400 });
    expect(receiveFlowForm(store, token, new URLSearchParams(`t=${T0.getTime()}&a0=First&a0=second&a1=Here`), later)).toMatchObject({ status: 200 });
    expect(store.flowCards(store.getFlowTrigger(made.id)!.flow, true).map(card => [card.title, card.description])).toEqual([["First", "From the “Report” form:\n\nWhere?\nHere"]]);
  });
});

describe("a focused observation request", () => {
  const one = { criterion: "c1", at: "head", testPath: "src/a.test.ts", testName: "works" };
  const parse = (body: unknown, ids = ["c1"]) => { try { return parseObservationCases(JSON.stringify(body), ids); } catch (error) { return (error as Error).message; } };
  const SHAPE = "Use one to four focused test observations.";
  const CASE = "An observation must name a requested criterion, base/head, one test file and one test name. Shell commands are not accepted.";
  const COVER = "Every requested criterion needs a distinct observation.";

  it("reads version 1, and a request without a version as version 1", () => {
    expect(parse({ version: 1, observations: [one] })).toEqual([one]);
    expect(parse({ observations: [one] })).toEqual([one]);
  });

  it("refuses with the same three plain reasons as before", () => {
    for (const body of [null, [], { version: 2, observations: [one] }, { version: "1", observations: [one] }, { version: null, observations: [one] }, { version: 1, observations: [] },
      { version: 1, observations: [one, one, one, one, one] }, { version: 1, observations: [one], extra: 1 }, { version: 1, observations: [{ ...one, at: "x" }], extra: 1 }]) expect(parse(body)).toBe(SHAPE);
    for (const item of [null, 3, ["x"], { ...one, extra: 1 }, { ...one, criterion: "c9" }, { ...one, at: "tip" }, { ...one, testPath: "../a.test.ts" }, { ...one, testPath: "src/a.ts" },
      { ...one, testName: " " }, { ...one, testName: "a\nb" }, { ...one, testName: 4 }, { ...one, testPath: "npm test; rm -rf /" }]) expect(parse({ version: 1, observations: [item] })).toBe(CASE);
    expect(parse({ version: 1, observations: [one, one] })).toBe(COVER);
    expect(parse({ version: 1, observations: [one] }, ["c1", "c2"])).toBe(COVER);
    // Written in another key order, the same case was distinct before; it still is.
    expect(parse({ version: 1, observations: [one, { at: "head", criterion: "c1", testPath: "src/a.test.ts", testName: "works" }] })).toHaveLength(2);
    expect(() => parseObservationCases("{", ["c1"])).toThrow(SyntaxError);
    expect(() => parseObservationCases(" ".repeat(16 * 1024 + 1), ["c1"])).toThrow("The observation request is too large.");
  });
});

it("Item 15 is marked done in the Zod revamp plan, with its Done entry", () => {
  const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
  expect(plan).toContain("| 15 ✅ | **Trigger payloads**: webhooks, GitHub, Linear, email, forms |");
  const done = plan.slice(plan.indexOf("## Done"));
  expect(done).toMatch(/^- \*\*15\. Trigger payloads\*\* \(2026-10-06\)/m);
  for (const contract of ["trigger-payloads.ts", "observation-request.ts"]) expect(done).toContain(`\`src/contracts/${contract}\``);
});
