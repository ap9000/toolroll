/** Follow-through through the console: the task page shows it, an approver's forms act on it, and a form can't reach
 * another task's finding. Starting a repair lands on its draft, whose plan still needs approving. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { BrowserTaskView } from "./browser-workspace.js";
import { findingsOfTask, sendFinding } from "./findings.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { T0, workspaceOf } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, evidenceRoot: string, repo: string, token: string, cookie: string;

async function login(): Promise<string> {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const page = async (path: string) => workspaceOf(await (await fetch(`${base}${path}`, { headers: { cookie } })).text());
const post = async (path: string, fields: Record<string, string>) => {
  const { csrf } = await page("/t/t-1");
  return fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }).toString(), redirect: "manual" });
};
const task = (id: string) => { store.createTask({ id, title: `Work ${id}` }, T0); store.placeTask(store.refFor("built-in", id, "ours").id, repo); };

beforeEach(async () => {
  store = openStore(":memory:");
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-ft-ev-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-ft-repo-")));
  execFileSync("git", ["init", "-q", repo]);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  token = alex.token;
  server = createDecisionServer({ store, evidenceRoot, repos: [repo], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
  cookie = await login();
  task("t-1");
  task("t-2");
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, repo]) rmSync(dir, { recursive: true, force: true });
});

test("a person sends a finding from the task page, it shows there as text, and they close it", async () => {
  const sent = await post("/t/t-1/follow-through", { act: "send", note: "<img src=x> the cache never clears", file: "src/a.ts", line: "3" });
  expect(sent.status).toBe(303);
  const [finding] = findingsOfTask(store, "t-1");
  expect(finding).toMatchObject({ source: "person", sentBy: "alex", file: "src/a.ts", line: 3, state: "open" });
  const view = (await page("/t/t-1")).view as BrowserTaskView;
  const section = view.sections.find(one => one.id === "findings")!;
  expect(section.open).toBe(true);
  expect(section.html).toContain("&lt;img src=x&gt;");
  expect(section.html).not.toContain("<img src=x>");
  expect((await post("/t/t-1/follow-through", { act: "close", finding: String(finding!.id), note: "fixed elsewhere" })).status).toBe(303);
  expect(findingsOfTask(store, "t-1")[0]?.state).toBe("closed");
});

test("a form can't reach another task's finding or a result it doesn't own", async () => {
  const other = sendFinding(store, { taskId: "t-2", source: "person", by: "alex", summary: "not yours" }, T0);
  if (!other.ok) throw new Error(other.message);
  expect((await post("/t/t-1/follow-through", { act: "close", finding: String(other.id), note: "x" })).status).toBe(409);
  expect(findingsOfTask(store, "t-2")[0]?.state).toBe("open");
  expect((await post("/t/t-1/follow-through", { act: "repair", run: "4242" })).status).toBe(409);
  expect((await post("/t/t-1/follow-through", { act: "nonsense" })).status).toBe(409);
});

test("a project-limited person can't pull another project's review or failed check into their own task", async () => {
  const hidden = realpathSync(mkdtempSync(join(tmpdir(), "so-ft-hidden-")));
  try {
    const lim = addApprover(store, "lim", T0, { name: "alex", token });
    if (!lim.ok) throw new Error("lim");
    store.createTask({ id: "t-hidden", title: "Hidden" }, T0);
    const ref = store.refFor("built-in", "t-hidden", "ours");
    store.placeTask(ref.id, hidden);
    const run = store.startRun({ taskRef: ref.id, leaseId: "h", runner: "r", branch: "x", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    store.handle.prepare("INSERT INTO build_review (run, task_id, repo, state, findings_json, queued_at) VALUES (?, 't-hidden', ?, 'reviewed', ?, ?)").run(run, hidden, JSON.stringify({ version: 1, findings: [{ severity: "LOW", file: "secret.ts", line: 1, scenario: "the hidden project's words" }] }), T0.toISOString());
    expect(store.setAccountProjects("lim", [repo], "alex", T0)).toEqual({ ok: true });
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "lim", token: lim.token }), redirect: "manual" });
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const refused = await post("/t/t-1/follow-through", { act: "send", pointer: `${run}:1` });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("on this task");
    expect(findingsOfTask(store, "t-1")).toEqual([]);
  } finally { rmSync(hidden, { recursive: true, force: true }); }
});

test("the handover note reads on the task page", async () => {
  sendFinding(store, { taskId: "t-1", source: "person", by: "alex", summary: "the cache never clears" }, T0);
  const view = (await page("/t/t-1")).view as BrowserTaskView;
  expect(view.sections.find(one => one.id === "handover-note")?.html).toContain("Next action: Answer 1 open finding.");
});
