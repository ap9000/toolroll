import { describe, expect, test } from "vitest";
import { leadChatSchema } from "./contracts/engine-api.js";
import { leadChatOf, parseLeadLink } from "./engine-chat.js";
import type { LeadMessage, LeadProposal } from "./store.js";

describe("parseLeadLink", () => {
  test("maps fixed internal task routes to task id and preferred Peek tab", () => {
    expect(parseLeadLink("Inspect diff", "/t/t-review/diff")).toEqual({
      label: "Inspect diff",
      href: "/t/t-review/diff",
      task: "t-review",
      tab: "diff",
    });
    expect(parseLeadLink("Open steps", "/t/t-1/steps#plan")).toEqual({
      label: "Open steps",
      href: "/t/t-1/steps#plan",
      task: "t-1",
      tab: "steps",
    });
    expect(parseLeadLink("Open task", "/t/t-1")).toEqual({
      label: "Open task",
      href: "/t/t-1",
      task: "t-1",
      tab: null,
    });
    expect(parseLeadLink("Result in chat", "/chat?task=t-done&result=2")).toEqual({
      label: "Result in chat",
      href: "/chat?task=t-done&result=2",
      task: "t-done",
      tab: "diff",
    });
    expect(parseLeadLink("Settings", "/settings/lead")).toEqual({
      label: "Settings",
      href: "/settings/lead",
      task: null,
      tab: null,
    });
  });
});

describe("leadChatOf", () => {
  test("projects structured ChatCard and confirmable proposals with zero raw HTML", () => {
    const messages: LeadMessage[] = [
      { id: 1, thread: 1, turn: 10, role: "operator", text: "What needs my attention?", activity: null, createdAt: "2026-04-12T10:00:00.000Z" },
      { id: 2, thread: 1, turn: 10, role: "assistant", text: "One task is ready to review.", activity: "read tasks (2s)", createdAt: "2026-04-12T10:00:02.000Z" },
    ];
    const proposals: LeadProposal[] = [
      {
        id: 11,
        thread: 1,
        turn: 10,
        kind: "control",
        payload: {
          control: "card",
          card: {
            version: 1,
            title: "Fleet status",
            asOf: "2026-04-12T10:00:02.000Z",
            repos: ["/projects/shop"],
            blocks: [{ kind: "facts", heading: "Counts", items: [{ label: "Ready", value: "1" }] }],
            buttons: [{ label: "Inspect diff", path: "/t/t-done/diff" }],
            actions: [],
          },
          plain: "Fleet status",
        },
        state: "pending",
        outcome: null,
        createdAt: "2026-04-12T10:00:02.000Z",
        decidedAt: null,
        decidedBy: null,
      },
      {
        id: 12,
        thread: 1,
        turn: 10,
        kind: "task",
        payload: { title: "Add retry tests", goal: "Cover backoff behavior.", repoId: "shop", checks: "quick" },
        state: "pending",
        outcome: null,
        createdAt: "2026-04-12T10:00:02.000Z",
        decidedAt: null,
        decidedBy: null,
      },
    ];

    const out = leadChatOf({
      room: "chat",
      session: 7,
      leadName: "Lead",
      canSend: true,
      problem: null,
      project: null,
      messages,
      proposals,
      decisions: new Map(),
      pending: null,
      ask: null,
      staleAsk: null,
      asks: new Map(),
      queue: new Map(),
    });

    const parsed = leadChatSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(out.pendingProposals).toBe(1);
    const assistant = out.messages[1]!;
    expect(assistant.cards).toHaveLength(2);
    expect(assistant.cards[0]!.data).toBe(true);
    expect(assistant.cards[0]!.links[0]).toMatchObject({ task: "t-done", tab: "diff" });
    expect(assistant.cards[1]!.data).toBe(false);
    expect(assistant.cards[1]!.primary).toMatchObject({ kind: "confirm", label: "File task", irreversible: false });
    expect(assistant.cards[1]!.lines).toContain("Add retry tests");
  });
});
