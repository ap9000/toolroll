/** Lead tiles (agents-view slice 8): the owner's own live chat turns only, through the chat room's admission, and their
 * words through one stateful redactor per turn. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LeadLiveStep } from "../lead-progress.js";
import { HIDDEN_KEY_BLOCK, HIDDEN_LINE } from "../live-records.js";
import type { VerifiedApprover } from "../principal.js";
import { addApprover } from "../scope.js";
import { openStore, type LeadThreadScope, type Store, type TaskFamily } from "../store.js";
import { LEAD_LINES, leadLines, leadsStillAdmitted, leadTilesFor } from "./agents-live-lead.js";
import type { LiveTurn } from "./render-chat.js";
import type { Session, Who } from "./session.js";

const T0 = new Date("2026-10-27T12:00:00.000Z");
const REPO = "/work/app", OTHER = "/work/other";
const step = (text: string, toolCalls: LeadLiveStep["toolCalls"] = []): LeadLiveStep => ({ tools: toolCalls.map(tool => tool.label), toolCalls, text });
const turnOf = (steps: LeadLiveStep[], done = false): LiveTurn => ({ steps, done, ok: done, listeners: new Set(), turn: 7, startedAt: T0.getTime(), stepAt: steps.map((_, index) => T0.getTime() + index * 1000) });

describe("the lead redactor", () => {
  test("a key block opened in one step stays hidden into the next, and lines after its end show", () => {
    const { lines } = leadLines([step("Here it is\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA"), step("c2VjcmV0Ym9keQ\n-----END OPENSSH PRIVATE KEY-----\nAll done.\n")]);
    expect(lines).toEqual(["Here it is", HIDDEN_KEY_BLOCK, "All done."]);
  });

  test("a marker split across steps still opens the block", () => {
    const { lines } = leadLines([step("start -----BEG"), step("IN RSA PRIVATE KEY-----\nMIIEsecretbody\n-----END RSA PRIVATE KEY-----\nafter\n")]);
    expect(lines.join("\n")).not.toContain("MIIEsecretbody");
    expect(lines.at(-1)).toBe("after");
  });

  test("a step's last word waits for the space after it, so a credential is never shown half-written", () => {
    const half = leadLines([step("The key is AKIAIOSFODNN7EX")]).lines;
    expect(half.join("\n")).not.toContain("AKIA");
    expect(half).toEqual(["The key is"]);
    expect(leadLines([step("The key is AKIAIOSFODNN7EXAMPLE and more")]).lines).toEqual([HIDDEN_LINE]);
    expect(leadLines([step("Done here.\n")]).lines).toEqual(["Done here."]);
  });

  test("Codex av8 #2: ending the turn or starting the next step confirms nothing: an unconfirmed tail stays held", () => {
    // lead.ts drops the snapshot that completes the token, so the one kept ends one character short of it.
    const almost = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c`;
    expect(leadLines([step(`Here is ${almost}`)]).lines.join("\n")).not.toContain("ghp_");
    expect(leadLines([step(`Here is ${almost}`), step("Next step.\n")]).lines.join("\n")).not.toContain("ghp_");
  });

  test("Codex av8 r2 #1: a key block earlier in the step never moves the check off the step's actual last line", () => {
    const almost = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c`;
    const { lines } = leadLines([step(`-----BEGIN CERTIFICATE-----\nbody \n-----END CERTIFICATE-----\nHere is ${almost}`)]);
    expect(lines.join("\n")).not.toContain("ghp_");
    expect(lines).toEqual([HIDDEN_KEY_BLOCK, "Here is"]);
  });

  test("Codex av8 r2 #2: a confirmed finished answer shows its last word; ending alone confirms nothing", () => {
    expect(leadLines([step("All 24 tests passed.")], [true]).lines).toEqual(["All 24 tests passed."]);
    expect(leadLines([step("All 24 tests passed.")], [false]).lines).toEqual(["All 24 tests"]);
    // Confirmation is per step: a later step's does not release an earlier step's tail.
    expect(leadLines([step("first ghp_partial"), step("Done.")], [false, true]).lines).toEqual(["first", "Done."]);
    // A confirmed answer is still redacted.
    expect(leadLines([step(`token=${"x".repeat(20)}`)], [true]).lines).toEqual([HIDDEN_LINE]);
  });

  test("Codex av8 #3: an invisible character never stands in for the space", () => {
    const almost = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c`;
    for (const invisible of ["\uFEFF", "\u200B", "\u2060", "\u202E"]) {
      expect(leadLines([step(`Here is ${almost}${invisible}9`)]).lines.join("\n")).not.toContain("ghp_");
    }
  });

  test("each snapshot is redacted from the turn's start: a shorter later snapshot shows nothing of the longer one", () => {
    const first = leadLines([step("one\ntwo\nthree ")]).lines;
    expect(first).toEqual(["one", "two", "three"]);
    expect(leadLines([step("again ")]).lines).toEqual(["again"]);
  });

  test("controls, escapes and direction overrides are stripped; tools are fixed words", () => {
    const { lines } = leadLines([step("\u001b[31mred\u001b[0m ‮evil‬\n", [
      { id: "1", label: "Reading the task", state: "running" },
      { id: "2", label: "Checking an action", state: "failed", reason: "That step didn't work (Checking an action)." },
      { id: "3", label: "Listing projects", state: "succeeded" },
    ])]);
    expect(lines).toEqual(["· Reading the task…", "· That step didn't work (Checking an action).", "· Listing projects", "red evil"]);
  });

  test("only the newest lines are kept, within the cap", () => {
    const many = Array.from({ length: LEAD_LINES + 50 }, (_, index) => `line ${index}\n`).join("");
    const { lines, earlier } = leadLines([step(many)]);
    expect(lines).toHaveLength(LEAD_LINES);
    expect(lines.at(-1)).toBe(`line ${LEAD_LINES + 49}`);
    expect(earlier).toBe(true);
  });
});

describe("lead tiles: the owner's own turns only", () => {
  let store: Store;
  let liveTurns: Map<number, LiveTurn>;
  let digest: string | null;
  const who = (name: string, role: "approver" | "viewer" = "approver"): Who => ({ name, via: "cookie", role, session: {} as Session });
  const families = new Map<string, TaskFamily>();
  const deps = () => ({
    store, liveTurns, managedRepos: () => [REPO, OTHER], visible: (repo: string | null) => repo === REPO || repo === OTHER,
    familyOf: (id: string) => families.get(id) ?? null,
    leadPrincipal: (one: Who & { via: "cookie" }) => digest === null || one.role !== "approver" ? null : ({ ceilingDigest: digest } as VerifiedApprover),
  });
  const open = (approver: string, scope?: LeadThreadScope) => store.openLeadThread(approver, "D1", T0, scope).thread.id;

  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    if (!addApprover(store, "robin", T0, { name: "alex", token: alex.token }).ok) throw new Error("robin");
    liveTurns = new Map();
    digest = "D1";
    families.clear();
    families.set("t-1", { root: { id: "t-1", repo: REPO, title: "Fix the login" }, problem: null } as unknown as TaskFamily);
  });
  afterEach(() => store.close());

  test("the owner sees their running turn: its id, start, step times and words; nobody else does", () => {
    const thread = open("alex");
    liveTurns.set(thread, turnOf([step("Looking\n"), step("Here is the plan.\n")]));
    const [tile] = leadTilesFor(deps(), who("alex"));
    expect(tile).toMatchObject({ thread, turn: 7, scope: "lead", title: "Lead chat", state: "working", startedAt: T0.toISOString(), endedAt: null,
      stepAt: [T0.toISOString(), new Date(T0.getTime() + 1000).toISOString()], chatHref: "/chat", taskHref: null, lines: ["Looking", "Here is the plan."] });
    expect(leadTilesFor(deps(), who("robin"))).toEqual([]);
    expect(leadTilesFor(deps(), who("alex", "viewer"))).toEqual([]);
    expect(leadTilesFor(deps(), { name: "alex", via: "bearer", role: "approver" } as Who)).toEqual([]);
  });

  test("a turn that ended reads done or failed, with its end", () => {
    const thread = open("alex");
    liveTurns.set(thread, { ...turnOf([step("Done.")], true), endedAt: T0.getTime() + 5000 });
    expect(leadTilesFor(deps(), who("alex"))[0]).toMatchObject({ state: "done", endedAt: new Date(T0.getTime() + 5000).toISOString(), doing: null });
    liveTurns.set(thread, { ...turnOf([step("Oops.")], true), ok: false, endedAt: T0.getTime() + 5000 });
    expect(leadTilesFor(deps(), who("alex"))[0]!.state).toBe("failed");
  });

  test("no lead standing, another ceiling, a closed or replaced thread: no tile", () => {
    const thread = open("alex");
    liveTurns.set(thread, turnOf([step("hi")]));
    digest = null;
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
    digest = "D2";
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
    digest = "D1";
    store.handle.prepare("UPDATE lead_thread SET closed_at = ? WHERE id = ?").run(T0.toISOString(), thread);
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
    const next = open("alex");
    store.handle.prepare("UPDATE lead_thread SET closed_at = NULL WHERE id = ?").run(thread);
    expect(store.liveLeadThreadFor("alex")?.id).toBe(next);
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
  });

  test("a team conversation's thread waits for its own admission", () => {
    const thread = open("alex");
    liveTurns.set(thread, turnOf([step("team words")]));
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO team_conversation(id,lead,title,visibility,projects_json,thread,created_by,created_at) VALUES('c1','l1','Team','team','[]',?,'alex',?)").run(thread, T0.toISOString());
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
  });

  test("a project's chat needs the project; a task's chat needs the task, and links to both", () => {
    const project = open("alex", { kind: "project", key: REPO });
    const task = open("alex", { kind: "task", key: "t-1" });
    liveTurns.set(project, turnOf([step("p")]));
    liveTurns.set(task, turnOf([step("t")]));
    expect(leadTilesFor(deps(), who("alex"))).toMatchObject([
      { thread: project, scope: "project", title: "Project chat", project: REPO, chatHref: `/chat?project=${encodeURIComponent(REPO)}`, taskHref: null },
      { thread: task, scope: "task", title: "Fix the login", project: REPO, chatHref: "/chat?task=t-1", taskHref: "/t/t-1" },
    ]);
    // The account narrowed to another project: neither shows.
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify([OTHER]));
    expect(leadTilesFor(deps(), who("alex"))).toEqual([]);
    // The task gone from view (its family unreadable): no tile.
    store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    families.clear();
    expect(leadTilesFor(deps(), who("alex")).map(tile => tile.scope)).toEqual(["project"]);
  });

  test("Codex av8 #1: what was projected is proved again at delivery: a thread closed, a turn gone or a narrowed account delivers nothing", () => {
    const thread = open("alex"), project = open("alex", { kind: "project", key: REPO });
    liveTurns.set(thread, turnOf([step("private words\n")]));
    liveTurns.set(project, turnOf([step("project words\n")]));
    const projected = leadTilesFor(deps(), who("alex"));
    expect(projected).toHaveLength(2);
    store.handle.prepare("UPDATE lead_thread SET closed_at = ? WHERE id = ?").run(T0.toISOString(), thread);
    expect(leadsStillAdmitted(deps(), who("alex"), projected).map(tile => tile.thread)).toEqual([project]);
    liveTurns.delete(project);
    expect(leadsStillAdmitted(deps(), who("alex"), projected)).toEqual([]);
    liveTurns.set(project, turnOf([step("project words\n")]));
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify([OTHER]));
    expect(leadsStillAdmitted(deps(), who("alex"), projected)).toEqual([]);
    store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    digest = null;
    expect(leadsStillAdmitted(deps(), who("alex"), projected)).toEqual([]);
  });
});
