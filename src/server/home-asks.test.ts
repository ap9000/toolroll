/** Home's other asks (docs/plans/home-other-asks.md): a flow card is a row only for the person it waits on (the flow
 * page's own rule, flows-ui.ts flowCardWaitsOn), only in a project they may see, and only with approver standing; a
 * first-run step is a row only while it has something to do. Over a throwaway store, never a person's setup. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FirstRunStep } from "../first-run.js";
import { addApprover } from "../scope.js";
import { openStore, type Store } from "../store.js";
import { decisionsFlow, FLOW_NOW as NOW, FLOW_REPO as REPO } from "../../test/flow-decisions.js";
import { flowAsks, setupAsks } from "./home-asks.js";

const OTHER = "/repos/elsewhere";

describe("flow decisions", () => {
  let store: Store, flow: ReturnType<typeof decisionsFlow>;
  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", NOW);
    if (!alex.ok || !addApprover(store, "sam", NOW, { name: "alex", token: alex.token }).ok) throw new Error("approvers");
    flow = decisionsFlow(store);
  });
  afterEach(() => store.close());
  const ids = (name: string, approver = true, repos: readonly string[] = [REPO], project: string | null = null) =>
    flowAsks(store, repos, { name, approver }, project).map(row => row.id).sort();
  const of = (...names: (keyof ReturnType<typeof decisionsFlow>["cards"])[]) => names.map(name => `flow:${flow.cards[name]}`).sort();

  test("a card is a row only for the person it waits on", () => {
    // Named decider, the owner deciding, any approver, a reply wait that ran out (the flow's owner moves it on), a choice
    // waiting on its card's owner, and a question asked of them; never a subagent's zone while it decides, a reply
    // still awaited, or a question asked of someone else.
    expect(ids("alex")).toEqual(of("owner", "anyone", "mayaHanded", "replied"));
    expect(ids("sam")).toEqual(of("sam", "anyone", "mayaHanded", "pick", "askedSam"));
    // Approver standing on every branch.
    expect(ids("sam", false)).toEqual([]);
    expect(ids("jo")).toEqual([]);
  });

  test("only flows in projects this person may see", () => {
    expect(ids("sam", true, [])).toEqual([]);
    expect(ids("sam", true, [REPO], OTHER)).toEqual([]);
    // The account's own project grants, checked again per flow.
    expect(store.setAccountProjects("sam", [OTHER], "alex", NOW).ok).toBe(true);
    expect(ids("sam")).toEqual([]);
    expect(ids("alex")).toEqual(of("owner", "anyone", "mayaHanded", "replied"));
  });

  test("each row opens its card on the flow page, with the card's waiting words; nothing is decided here", () => {
    const row = flowAsks(store, [REPO], { name: "sam", approver: true }, null).find(one => one.id === `flow:${flow.cards.sam}`)!;
    expect(row).toMatchObject({ title: "Refund $30", href: `/flows/${flow.flow}?card=${flow.cards.sam}`, repo: REPO, line: "Refunds: Waiting for sam",
      action: { label: "Open the card", href: `/flows/${flow.flow}?card=${flow.cards.sam}` } });
    expect(row.at).not.toBeNull();
  });
});

describe("finish setting up", () => {
  const step = (key: FirstRunStep["key"], over: Partial<FirstRunStep> = {}): FirstRunStep => ({ key, title: key, done: false, action: { kind: "link", label: `Do ${key}`, href: `/${key}` }, ...over });

  test("a step to do is a row with its own action; done, being checked, or no steps at all is none", () => {
    expect(setupAsks(null, true)).toEqual([]);
    const rows = setupAsks([
      step("agent", { action: { kind: "command", command: "claude auth login" } }), step("project", { done: true, action: null }),
      step("builder"), step("task", { done: false, action: null, checking: true }),
    ], true);
    expect(rows.map(one => one.id)).toEqual(["setup:agent", "setup:builder"]);
    expect(rows[0]).toMatchObject({ title: "Sign in to a coding agent", line: "Run claude auth login in a terminal.", action: { label: "Open setup", href: "/welcome" }, at: null });
    expect(rows[1]).toMatchObject({ title: "Connect a builder", action: { label: "Do builder", href: "/builder" } });
    // Approvers only.
    expect(setupAsks([step("builder")], false)).toEqual([]);
  });
});
