/** One vocabulary for a task's state: the same fixture tasks walk through the
 * Tasks list, the task page, the result page and Crew and read the same state
 * words; requirements, Project checks and PR CI read one source each; every
 * time goes through one formatter; each Review row says its own reason, one
 * verb opens a result, nothing else is called Details, and labels are sentence
 * case. Real HTTP against an ephemeral port over a seeded throwaway store. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Window } from "happy-dom";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { taskStatusOf, CHECKS_LABEL, PR_CI_LABEL, OPEN_RESULT, statusWhyHtml } from "./task-status.js";
import { askChipOf, ASK_LABEL, resultHoldUpSentence } from "./needs-you.js";
import { fullWhen, localizeTimes, shortWhen } from "./when-html.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { MISMATCH_HEADLINE } from "./workspace-ui.js";
import { htmlString } from "./html.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MismatchHeadline } from "./browser/views/result-view.js";
import { workIndexPage } from "./work-index.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/storefront";
const BOILERPLATE = "Inspect the saved result and resolve its remaining execution or scope issue.";
let store: Store;
let server: Server;
let base: string;
let root: string;
let password: string;
let cookie: string;
const runs: Record<string, number> = {};

type TasksView = Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
type TaskView = Extract<BrowserWorkspace["view"], { kind: "task" }>;
type ResultView = Extract<BrowserWorkspace["view"], { kind: "result" }>;
function workspaceOf(html: string): BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}
const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();

function filed(id: string, title: string, at: Date): number {
  store.createTask({ id, title }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  const proposed = propose(store, { taskId: id, goal: title, touches: ["src/"], acceptance: [
    { id: "c1", statement: `${title}, first part`, how: null, evidence: ["check"] }, { id: "c2", statement: `${title}, second part`, how: null, evidence: ["check"] }], now: at });
  const ok = approve(store, id, "sam", at, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  return ref;
}

/** A finished build: `failed` stops before a result; `refuted` saves one whose report is refuted with both requirements marked met. */
function built(id: string, title: string, at: Date, kind: "verified" | "refuted" | "failed" = "verified"): number {
  const ref = filed(id, title, at);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  runs[id] = run;
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  if (kind === "failed") {
    store.finishRun(run, { outcome: "failed", reason: "agent", now: at });
    store.setTaskState(id, "failed", at);
    return run;
  }
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: `${title}, with a regression test.` });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const row = (n: number) => ({ id: `c${n}`, statement: `${title}, ${n === 1 ? "first" : "second"} part`, requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null });
  store.saveProofVerdict(run, kind, kind === "refuted" ? ["the report claims a file the diff doesn't change"] : [], at, [row(1), row(2)] as never, kind);
  storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, root, run, "check-log", "checks.txt", Buffer.from("612 passed\n"), "npm test", at, { captureStatus: "ok" });
  sealVerificationReceipt(store, root, run, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, at);
  return run;
}

beforeAll(async () => {
  store = openStore(":memory:");
  root = mkdtempSync(join(tmpdir(), "one-vocabulary-"));
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(900));
  const sam = addApprover(store, "sam", ago(900));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(900));
  built("search-typo-tolerance", "Let search tolerate one typo", ago(60));
  built("gift-card-hold", "Show gift card balance at checkout", ago(50));
  store.hold(store.lookupRef("gift-card-hold")!.id, "Waiting on legal sign-off", null, ago(49));
  built("coupon-plan-changed", "Stop coupons stacking on sale items", ago(45));
  {
    const proposed = propose(store, { taskId: "coupon-plan-changed", goal: "Stop coupons stacking on sale and clearance items", touches: ["src/"],
      acceptance: [{ id: "c1", statement: "Coupons never stack on clearance", how: null, evidence: ["check"] }], now: ago(44) });
    const ok = approve(store, "coupon-plan-changed", "sam", ago(44), proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
  }
  built("order-export-refuted", "Export order history as CSV", ago(40), "refuted");
  built("agent-gave-up", "Serve smaller product images", ago(30), "failed");

  server = createDecisionServer({ store, evidenceRoot: root, repo: REPO, clock: () => NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: password }), redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const tasksView = async () => workspaceOf(await page("/work"));
const taskHeadline = async (id: string) => {
  const view = workspaceOf(await page(`/t/${id}`)).view as TaskView;
  return view.status!.status.headline;
};
const resultOf = async (id: string) => (workspaceOf(await page(`/review?result=${id}&run=${runs[id]}`)).view as ResultView).selected!;

describe("one state per task, the same words on every surface (c1)", () => {
  test("each fixture task reads the same state in the list, on its task page, on its result page and in Crew", async () => {
    const workspace = await tasksView();
    const rows = (workspace.view as TasksView).rows;
    const expected: Record<string, string> = {
      "search-typo-tolerance": "Ready for review", "gift-card-hold": "Needs you", "coupon-plan-changed": "Needs you",
      // A refuted report verifies none of its requirements: Complete is refused until they are resolved, so it needs you.
      "order-export-refuted": "Needs you", "agent-gave-up": "Failed",
    };
    for (const [id, words] of Object.entries(expected)) {
      const row = rows.find(one => one.id === id)!;
      const crew = workspace.crew.find(one => one.id === id)!;
      expect(row.status.label, `${id} list`).toBe(words);
      expect(crew.label, `${id} Crew`).toBe(words);
      expect(await taskHeadline(id), `${id} task page`).toBe(words);
      if (id !== "agent-gave-up") {
        const result = await resultOf(id);
        expect(result.status.label, `${id} result`).toBe(words);
        expect(result.panel?.status?.headline ?? result.status.label, `${id} result card`).toBe(words);
      }
    }
  });

  test("Crew reads each task's headline, never its list group or chip", async () => {
    const workspace = await tasksView();
    const rows = (workspace.view as TasksView).rows;
    const crew = Object.fromEntries(workspace.crew.map(one => [one.id, one.label]));
    expect(crew).toEqual({ "search-typo-tolerance": "Ready for review", "gift-card-hold": "Needs you", "coupon-plan-changed": "Needs you", "order-export-refuted": "Needs you", "agent-gave-up": "Failed" });
    for (const row of rows) expect(crew[row.id], row.id).toBe(row.status.label);
    const groupWords = new Set<string>(Object.values(ASK_LABEL));
    for (const item of workspace.crew) expect(groupWords.has(item.label), item.id).toBe(false);
  });

  test("Crew reasons preserve the server's existing status detail", async () => {
    const workspace = await tasksView();
    const index = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { root });
    for (const item of workspace.crew) {
      if (['Needs you', 'Failed', 'Waiting'].includes(item.label)) {
        expect(item.detail, item.id).toBe(index.items.find(row => row.rootId === item.id)!.status.detail);
      } else expect(item.detail, item.id).toBeUndefined();
    }
  });

  test("a report that doesn't match its changes is Mismatch; a plan changed after building is Plan changed", async () => {
    const rows = ((await tasksView()).view as TasksView).rows;
    const chip = (id: string) => rows.find(one => one.id === id)!.chip;
    expect(chip("order-export-refuted")).toBe("Mismatch");
    expect(chip("coupon-plan-changed")).toBe("Plan changed");
    // The result page agrees: the refuted one's headline is the mismatch, the plan-changed one has none.
    const refuted = await resultOf("order-export-refuted");
    expect(refuted.mismatch?.headline).toBe(MISMATCH_HEADLINE);
    const changed = await resultOf("coupon-plan-changed");
    expect(changed.mismatch?.headline ?? null).toBeNull();
    expect(await page(`/review?result=coupon-plan-changed&run=${runs["coupon-plan-changed"]}`)).not.toContain(MISMATCH_HEADLINE);
    // The mismatch headline's dot is amber (a warning), never the quiet green of Ready for review.
    const headline = renderToStaticMarkup(createElement(MismatchHeadline, { headline: MISMATCH_HEADLINE }));
    expect(headline).toContain("bg-warning");
    expect(headline).not.toMatch(/success/);
  });

  test("group headings stay; a row's chip is the specific ask, never its heading", async () => {
    const view = (await tasksView()).view as TasksView;
    const headings = new Set(Object.values(ASK_LABEL));
    for (const row of view.rows.filter(one => one.ask !== null)) {
      expect(headings.has(row.chip ?? ""), row.id).toBe(false);
      expect(row.group).toBe(row.ask);
    }
    const chips = Object.fromEntries(view.rows.map(row => [row.id, row.chip]));
    expect(chips).toEqual({ "search-typo-tolerance": "Result", "gift-card-hold": "Result", "coupon-plan-changed": "Plan changed", "order-export-refuted": "Mismatch", "agent-gave-up": "Failed" });
    expect(askChipOf({ headline: "Needs you", need: "approval" })).toBe("Plan");
    expect(askChipOf({ headline: "Needs you", need: "start-builder" })).toBe("Builder offline");
    expect(askChipOf({ headline: "Needs you", need: "answer" })).toBeNull();
  });
});

describe("one source for requirements, checks and times (c2)", () => {
  test("a refuted report's requirements read Unverified on the card and in the Checks tab alike", async () => {
    const result = await resultOf("order-export-refuted");
    expect(result.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "Unverified" });
    const checks = result.panel!.views.find(one => one.key === "checks")!.html;
    const words = [...checks.matchAll(/data-matrix-state="[^"]+">([^<]+)</g)].map(match => match[1]);
    expect(words).toEqual(["Unverified", "Unverified"]);
    // A verified one agrees the other way: 2 of 2 met on the card, Met ×2 in the tab.
    const met = await resultOf("search-typo-tolerance");
    expect(met.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "2 of 2 met" });
    expect([...met.panel!.views.find(one => one.key === "checks")!.html.matchAll(/data-matrix-state="[^"]+">([^<]+)</g)].map(match => match[1])).toEqual(["Met", "Met"]);
  });

  test("the project's checks and the pull request's CI are labelled apart", () => {
    const status = taskStatusOf({ stage: "finished", checks: { status: "not-run", exitCode: null, head: null },
      pullRequest: { state: "open", number: 47, url: "https://github.com/acme/shop/pull/47", ci: "passing", error: null } });
    const rows = Object.fromEntries(status.details.map(one => [one.key, [one.label, one.text]]));
    expect(rows["checks"]).toEqual([CHECKS_LABEL, "Didn't run"]);
    expect(rows["pull-request"]).toEqual(["Pull request", `#47 open · ${PR_CI_LABEL} passed`]);
    expect(CHECKS_LABEL).toBe("Project checks");
    expect(PR_CI_LABEL).toBe("PR CI");
    for (const one of status.details) expect(one.label === "Checks" || /(?<!PR )\bCI\b/.test(one.text), one.key).toBe(false);
  });

  test("every time goes through one formatter, in the viewer's zone", async () => {
    const at = "2026-10-01T21:16:00.000Z";
    const zone = "America/Los_Angeles";
    const now = new Date("2026-10-02T19:00:00.000Z");
    expect(shortWhen(at, now, zone)).toBe("Yesterday 14:16");
    expect(fullWhen(at, zone)).toBe("2026-10-01 14:16");
    expect(shortWhen(at, now)).toBe("Yesterday 21:16");
    // The server's own <time> words are rewritten by the same formatter: the result's approval and a task page agree.
    const result = await resultOf("search-typo-tolerance");
    expect(result.intent!.approval).toBe("Approved by sam");
    expect(result.intent!.approvedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const task = await page("/t/search-typo-tolerance");
    const window = new Window();
    try {
      window.document.body.innerHTML = task;
      // Every stamp on the page, not only the ones already marked: none is left in UTC words beside the viewer's.
      const times = [...window.document.querySelectorAll("time[datetime]")];
      expect(times.length).toBeGreaterThan(0);
      localizeTimes(window.document as unknown as ParentNode, now, zone);
      for (const node of times) {
        const iso = node.getAttribute("datetime")!;
        expect(node.textContent, iso).toBe(shortWhen(iso, now, zone));
        expect(node.getAttribute("title"), iso).toBe(fullWhen(iso, zone));
      }
    } finally { await window.happyDOM.close(); }
  });
});

describe("plain, consistent words (c3)", () => {
  test("each Review row says its own reason", async () => {
    const view = (await tasksView()).view as TasksView;
    const review = view.rows.filter(row => row.group === "review" && row.detail !== null);
    expect(Object.fromEntries(review.map(row => [row.id, row.detail]))).toEqual({
      "gift-card-hold": "On hold: Waiting on legal sign-off. Release the hold to accept it.",
      "coupon-plan-changed": "The plan changed after this was built. Build it again to the current plan.",
      "order-export-refuted": "2 requirements couldn't be verified (c1, c2). Ask for changes, or accept the result with a reason.",
    });
    const html = await page("/work");
    expect(html).not.toContain(BOILERPLATE);
    for (const id of ["gift-card-hold", "coupon-plan-changed"]) expect(await page(`/t/${id}`), id).not.toContain(BOILERPLATE);
    expect(resultHoldUpSentence({ unfinished: true })).not.toBe(resultHoldUpSentence({ noCommit: true }));
  });

  test("one verb opens a result, and nothing but the side panel is called Details", async () => {
    expect(OPEN_RESULT).toBe("Open result");
    const pages = [await page("/work"), await page("/t/search-typo-tolerance"), await page(`/review?result=search-typo-tolerance&run=${runs["search-typo-tolerance"]}`),
      await page(`/chat?task=search-typo-tolerance&result=${runs["search-typo-tolerance"]}`), await page("/t/gift-card-hold")];
    for (const html of pages) {
      expect(html).not.toMatch(/Open the result|Inspect the result|Result details|Review result\b/);
      expect(html).not.toMatch(/<summary>Details<\/summary>|aria-label="Details"/);
    }
    const view = (await tasksView()).view as TasksView;
    expect(view.rows.find(row => row.id === "search-typo-tolerance")!.action!.label).toBe("Open result");
    const status = taskStatusOf({ stage: "finished", checks: { status: "passed", exitCode: 0, head: "a".repeat(40) }, why: ["Check output kept"] });
    expect(htmlString(statusWhyHtml(status))).toContain("<summary>More</summary>");
  });

  test("badges, labels, buttons and fold names are sentence case", async () => {
    const pages = [await page("/work"), await page("/t/search-typo-tolerance"), await page("/t/coupon-plan-changed"),
      await page(`/chat?task=search-typo-tolerance&result=${runs["search-typo-tolerance"]}`), await page(`/review?result=order-export-refuted&run=${runs["order-export-refuted"]}`)];
    // Words a person wrote or named (a project, an account) keep their own case; everything Toolroll says is sentence case.
    const data = new Set(["storefront", "sam"]);
    const lower = /(?:<(?:button|label|summary|h[1-4]|legend|th)(?:\s[^>]*)?>|class="badge[^"]*"[^>]*>|<strong>|<p class="meta">)([a-z][\w'-]*)/g;
    const named = new Set(["goal", "not", "touches", "acceptance"]);
    for (const html of pages) {
      const bodies = [html, ...[...html.matchAll(/"(?:html|pageHtml|statusHtml|approval|questions)":"((?:[^"\\]|\\.)*)"/g)].map(match => JSON.parse(`"${match[1]}"`) as string)];
      for (const one of bodies) {
        const hits = [...one.matchAll(lower)].filter(hit => !data.has(hit[1]!) && (!hit[0].startsWith("<strong>") && !hit[0].startsWith("<p class") || named.has(hit[1]!)));
        expect(hits.map(hit => one.slice(Math.max(0, hit.index - 80), hit.index + hit[0].length + 20))).toEqual([]);
      }
    }
  });
});
