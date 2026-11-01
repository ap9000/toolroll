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
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { resultHoldUpSentence } from "./needs-you.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { MISMATCH_HEADLINE } from "./workspace-ui.js";

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

});

describe("honest review reasons (c3)", () => {
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

});
