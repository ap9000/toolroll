import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import type { ContractResult } from "./contract.js";
import { CHAT_ACTION_FIELDS, CHAT_ACTION_OPERATIONS, chatActionRequestSchemas, readChatActionRequest, readSharedAction, sharedActionSchema, type ChatActionOperation } from "./chat-actions.js";
import { CHAT_ACTIONS } from "../chat-actions.js";

type Sample = { name: string; payload: Record<string, unknown>; reads?: Record<string, unknown> };
const saved = ["shared-actions.json", "shared-actions-null-optionals.json"].flatMap(file =>
  (JSON.parse(readFileSync(new URL(`../../test/fixtures/chat/${file}`, import.meta.url), "utf8")) as { samples: Sample[] }).samples);

const verdict = <T>(read: ContractResult<T>): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One request each action takes, as the lead (or a saved proposal) gives it. */
const REQUESTS: Record<ChatActionOperation, Record<string, unknown>> = {
  skill_import: { repo: "/work/app", content: "---\nname: notes\n---\nWrite notes." },
  skill_enable: { repo: "/work/app", version: "a".repeat(20) },
  skill_disable: { repo: "/work/app", version: "a".repeat(20) },
  skill_restore: { repo: "/work/app", restore: 2 },
  skill_test: { repo: "/work/app", version: "a".repeat(20), sample: "Write release notes", nonce: "00000000-0000-4000-8000-000000000000" },
  knowledge_instructions: { repo: "/work/app" },
  knowledge_save: { repo: "/work/app", title: "Notes", content: "Short.", id: "r1" },
  knowledge_remove: { repo: "/work/app", id: "r1" },
  knowledge_restore: { repo: "/work/app", restore: 1 },
  tool_add: { repo: "/work/app", name: "shop", command: "node", args: ["server.js"], secrets: [], about: "Orders." },
  tool_remove: { repo: "/work/app", name: "shop" },
  flow_create: { repo: "/work/app", name: "Fixes", definition: { steps: [{ kind: "task", title: "Build" }] } },
  flow_starter: { repo: "/work/app", starter: "ci-fix" },
  flow_edit: { flow: 3, name: "Fixes" },
  flow_card_add: { flow: 3, title: "Footer year", description: null },
  flow_card_move: { card: 12, zone: "review" },
  flow_card_approve: { card: 12 },
  flow_card_send_back: { card: 12, note: "Shorter, please." },
  flow_card_choose: { card: 12, choice: 1 },
  flow_card_cancel: { card: 12 },
  flow_card_comment: { card: 12, note: "@sam can you look?" },
  flow_card_assign: { card: 12, owner: "sam" },
  flow_card_watch: { card: 12, watching: false },
  flow_script_save: { repo: "/work/app", script: { name: "check", about: "Checks.", body: "true", language: "shell", timeoutMinutes: 5 } },
  flow_trigger_add: { flow: 3, trigger: { kind: "schedule", schedule: "daily 09:00", title: "Morning" } },
  flow_trigger_pause: { trigger: 5 },
  flow_trigger_resume: { trigger: 5 },
  flow_trigger_remove: { trigger: 5 },
  teammate_create: { repo: "/work/app", template: "support", name: "Maya" },
  teammate_soul: { teammate: 3, soul: "---\nname: Maya\nrole: support\n---" },
  teammate_state: { teammate: 3, state: "paused" },
  teammate_note: { teammate: 3, note: "Order 1043 is a gift." },
  teammate_answer: { question: 4, choice: "yes" },
  teammate_tools: { teammate: 3, tool: "shop", change: "grant" },
  teammate_memory: { teammate: 3, memory: 8, change: "forget" },
  teammate_routine: { teammate: 3, change: "add", schedule: "weekdays 09:00", text: "Check the inbox." },
  teammate_undo: { teammate: 3, call: 21 },
  kit_setup: { repo: "/work/app", kit: "support-desk" },
  decision_record: { repo: "/work/app", claim: "Dates are UTC.", why: "Support reads them across zones.", source: "chat" },
  decision_retire: { repo: "/work/app", decision: 9, reason: "Superseded." },
  lead_about_you: { line: "Prefers short replies.", replaces: 0 },
  scope_approve: { task: "fix-footer" },
  result_accept: { task: "fix-footer", run: 41 },
  task_cancel: { task: "fix-footer" },
  task_resume: { task: "fix-footer", run: 40 },
};

/** Values the 0.9.36 preparation branches ignored, defaulted or delegated to their owning reader. */
const COMPATIBLE_REQUESTS: Partial<Record<ChatActionOperation, Record<string, unknown>[]>> = {
  teammate_create: [
    { repo: "/work/app", template: "support", name: null, soul: null },
    { repo: "/work/app", template: null, name: null, soul: "---\nname: Maya\nrole: Support\n---\nHelpful." },
    { repo: "/work/app", template: "support", name: false, soul: 0 },
  ],
  teammate_tools: [
    { teammate: 3, tool: "shop", change: "grant", action: null, use: null, undoWith: null, limitField: null, limitOver: null },
    { teammate: 3, tool: "shop", change: "revoke", action: 0, use: false, undoWith: [], limitField: {}, limitOver: "unused" },
    { teammate: 3, tool: "shop", change: "rule", action: "refund_order", use: "free", undoWith: null, limitField: "amount", limitOver: "100" },
  ],
  tool_add: [
    { repo: "/work/app", catalog: null, about: null, url: null },
    { repo: "/work/app", name: "shop", command: "node", about: null, url: null, args: null, secrets: null },
    { repo: "/work/app", catalog: "github", name: false, command: 3, args: {}, about: [], url: false, secrets: false },
  ],
  teammate_memory: [{ teammate: 3, memory: 8, change: "forget", text: null }],
  teammate_routine: [
    { teammate: 3, change: "remove", routine: 2, schedule: null, text: false },
    { teammate: 3, change: "add", routine: null, schedule: "daily 09:00", text: "Check the inbox." },
  ],
  teammate_answer: [{ question: 4, choice: "yes", text: false }, { question: 4, choice: 0, text: "Refund it." }],
  flow_card_add: [{ flow: 3, title: "Footer year", description: false }],
  flow_card_choose: [{ card: 12, choice: 1, note: null }],
  flow_card_watch: [null, "false", 0, {}, [], false, true].map(watching => ({ card: 12, watching })),
};

describe("the chat action contracts", () => {
  it("every action has one schema, and its fields are the schema's", () => {
    expect([...CHAT_ACTION_OPERATIONS].sort()).toEqual(Object.keys(CHAT_ACTIONS).sort());
    for (const operation of CHAT_ACTION_OPERATIONS) expect(CHAT_ACTION_FIELDS[operation]).toEqual(Object.keys(chatActionRequestSchemas[operation].shape));
    // The lead reads these in get_actions, in this order.
    expect(CHAT_ACTION_FIELDS.tool_add).toEqual(["repo", "catalog", "name", "command", "args", "url", "secrets", "about"]);
    expect(CHAT_ACTION_FIELDS.teammate_tools).toEqual(["teammate", "tool", "change", "action", "use", "limitField", "limitOver", "undoWith"]);
  });

  it.each(CHAT_ACTION_OPERATIONS)("%s holds: round trip, a request it takes, and fields of another action refused by path", operation => {
    const extra = operation === "task_cancel" ? "run" : "restore";
    assertContract({
      schema: chatActionRequestSchemas[operation],
      read: input => verdict(readChatActionRequest(operation, input)),
      valid: [{ name: "its request", input: REQUESTS[operation] }, ...(COMPATIBLE_REQUESTS[operation] ?? []).map(input => ({ name: "0.9.36 request", input }))],
      invalid: [
        ...(CHAT_ACTION_FIELDS[operation].includes(extra) ? [] : [{ name: "another action's field", input: { ...REQUESTS[operation], [extra]: 1 }, paths: ["payload"] }]),
        { name: "not an object", input: [], paths: ["payload"] },
      ],
    });
  });

  it("names the field and what is wrong with it", () => {
    const lines = (operation: ChatActionOperation, input: unknown) => {
      const read = readChatActionRequest(operation, input);
      return read.ok ? [] : read.issues.map(issue => issue.line);
    };
    expect(lines("flow_card_move", { zone: "review" })).toEqual(["card: required"]);
    expect(lines("flow_card_move", { card: "12", zone: "review" })).toEqual(["card: must be a number (got a string)"]);
    expect(lines("result_accept", { task: "fix-footer", run: 0 })).toEqual(["run: at least 1"]);
    expect(lines("teammate_state", { teammate: 3, state: "asleep" })).toEqual(['state: must be one of "active", "paused", "removed"']);
    expect(lines("skill_enable", { repo: "/work/app", version: "abc", restore: 1 })).toEqual(["payload: unknown key 'restore'"]);
    expect(lines("flow_card_move", { cards: 12, zone: "review" })).toEqual(["card: required", "payload: unknown key 'cards' (did you mean card?)"]);
  });
});

describe("a saved proposal's action", () => {
  it("holds: round trip, saved and current proposals read, malformed ones refused by path", () => {
    const current = { version: 1, ...saved[0]!.payload };
    assertContract({
      schema: sharedActionSchema,
      read: input => verdict(readSharedAction(input)),
      valid: [...saved.map(one => ({ name: one.name, input: one.payload })), { name: "version 1", input: current }],
      invalid: [
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, label: "Save reference" }, paths: ["payload"] },
        { name: "not an action", input: { ...current, operation: "deploy" }, paths: ["operation"] },
        { name: "terms are lines", input: { ...current, terms: [1] }, paths: ["terms[0]"] },
        { name: "no stamp", input: { ...current, stamp: undefined }, paths: ["stamp"] },
        { name: "its request by its action's schema", input: { ...current, request: { repo: "/work/app", titel: "x", content: "y" } }, paths: ["request.title", "request"] },
        { name: "a versioned request field of the wrong kind", input: { ...saved[3]!.payload, version: 1, request: { card: "12", choice: 2 } }, paths: ["request.card"] },
      ],
    });
  });

  it("reads every saved proposal as before: the same fields, and the same request bytes, so its stamp still matches", () => {
    expect(saved).toHaveLength(16);
    for (const one of saved) {
      const read = readSharedAction(one.payload);
      if (!read.ok) throw Error(`${one.name}: ${read.issues.map(issue => issue.line).join("; ")}`);
      expect(read.value, one.name).toEqual(one.reads ?? { version: 1, ...one.payload });
      // The stamp is a hash over the request as saved: key order and values are kept exactly.
      expect(JSON.stringify(read.value.request), one.name).toBe(JSON.stringify(one.payload["request"]));
      expect(sha(read.value.state), one.name).toBe(sha(one.payload["state"]));
    }
  });

  it("reads unversioned requests without adding field checks the old reader never made", () => {
    for (const request of [{ card: "12", choice: 2 }, { card: 12, choice: 2, ignored: null }, {}]) {
      const payload = { ...saved[3]!.payload, request };
      expect(readSharedAction(payload)).toEqual({ ok: true, value: { version: 1, ...payload } });
      expect(readSharedAction({ ...payload, version: 0 })).toEqual({ ok: true, value: { version: 1, ...payload } });
    }
  });
});

describe("the plan", () => {
  it("marks item 11 done, with its Done entry", () => {
    const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(plan).toContain("| 11 ✅ | **Chat actions and channel callbacks**");
    expect(plan).toMatch(/^- \*\*11\. Chat actions and channel callbacks\*\* \(2026-10-06\)/m);
  });
});
