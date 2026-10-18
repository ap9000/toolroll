import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import type { Server } from "node:http";

// Every process the demo could start is counted (git init while seeding is
// expected; nothing after the sandbox exists).
const { spawned, outward } = vi.hoisted(() => {
  const spawned = { count: 0, outside: [] as string[] };
  // Every way out of this machine the demo could reach for is recorded too.
  const outward = async (real: Record<string, (...args: unknown[]) => unknown>, name: string, fns: readonly string[]) => {
    const wrapped = Object.fromEntries(fns.map(fn => [fn, (...args: unknown[]) => { spawned.outside.push(`${name}.${fn}`); return real[fn]!(...args); }]));
    return { ...real, ...wrapped, default: { ...real, ...wrapped } };
  };
  return { spawned, outward };
});
vi.mock("node:https", async original => outward(await original(), "node:https", ["request", "get"]));
vi.mock("node:tls", async original => outward(await original(), "node:tls", ["connect"]));
vi.mock("node:dns", async original => outward(await original(), "node:dns", ["lookup", "resolve"]));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const counted = <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: Parameters<T>) => { spawned.count++; return fn(...args); }) as T;
  return { ...real, spawn: counted(real.spawn), execFile: counted(real.execFile), execFileSync: counted(real.execFileSync), exec: counted(real.exec), execSync: counted(real.execSync), spawnSync: counted(real.spawnSync), fork: counted(real.fork) };
});

import { createDemoSandbox, createDemoLead, type DemoLead } from "./demo.js";
import { createDecisionServer } from "./serve.js";
import { assignmentOf } from "./assignment.js";
import type { Store } from "./store.js";

describe("the scripted demo lead", () => {
  let sandbox: string;
  let store: Store;
  let lead: DemoLead;
  let server: Server;
  let base: string;
  let password: string;
  let repos: string[];
  let evidenceRoot: string;
  let now: Date;
  const modelCalls: string[] = [];

  beforeEach(async () => {
    now = new Date("2026-10-06T09:00:00.000Z");
    const made = createDemoSandbox(now);
    made.lead.stop();
    sandbox = made.sandbox;
    store = made.store;
    password = made.seed.login.password;
    repos = made.seed.repos;
    evidenceRoot = made.evidenceRoot;
    lead = createDemoLead({ store, repos: { api: repos[0]!, web: repos[1]! }, evidenceRoot: made.evidenceRoot, approver: "demo", token: password, stepMs: 1_000, clock: () => now });
    server = createDecisionServer({
      store, evidenceRoot: made.evidenceRoot, clock: () => now, repos, demoLead: lead,
      chatFetcher: (async (input: unknown) => { modelCalls.push(String(input)); throw new Error("the demo must never call a model"); }) as typeof fetch,
    });
    await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
    spawned.count = 0;
  });

  afterEach(async () => {
    lead.stop();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
    rmSync(sandbox, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const login = async (): Promise<string> => {
    const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "demo", token: password }), redirect: "manual" });
    expect(answer.status).toBe(303);
    return (answer.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const page = async (cookie: string, path = "/chat"): Promise<string> => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const csrfIn = (html: string): string => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
  const post = async (cookie: string, path: string, fields: Record<string, string>): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
  const lastId = (html: string): string => [...html.matchAll(/action="\/chat\/demo\/([0-9]+)\/approve"/g)].at(-1)![1]!;
  const later = (ms: number): void => { now = new Date(now.getTime() + ms); };

  test("any request gets a plan; Approve builds to Ready with a diff, a passing check and a screenshot; Complete works", async () => {
    const cookie = await login();

    const first = await page(cookie);
    expect(first).toContain("Ask for something, like “fix the flaky refund test”");
    expect(first).toContain('value="Fix the flaky refund test"');
    expect(first).toContain("Nothing calls a model, reaches outside or spends.");
    expect(first).not.toContain("Chat isn’t available in demo mode");

    expect((await post(cookie, "/chat/demo/ask", { csrf: csrfIn(first), message: "please fix the flaky refund test" })).status).toBe(303);
    const planned = await page(cookie);
    expect(planned).toContain("Fix the flaky refund test");
    expect(planned).toContain("Boundaries");
    expect(planned).toContain(">Approve</button>");
    expect(planned).toContain("Change it");

    const id = lastId(planned);
    expect((await post(cookie, `/chat/demo/${id}/approve`, { csrf: csrfIn(planned) })).status).toBe(303);
    const live = await (await fetch(`${base}/chat/demo/live`, { headers: { cookie } })).json() as { working: boolean; html: string };
    expect(live.working).toBe(true);
    expect(live.html).toContain("Planning");
    const taskId = lead.exchanges().at(-1)!.taskId!;
    expect(store.getTask(taskId)?.state).toBe("queued");

    later(1_500);
    expect(await page(cookie)).toContain("Building…");
    expect(store.getTask(taskId)?.state).toBe("running");
    later(1_500);
    expect(await page(cookie)).toContain("Running checks…");

    later(2_000);
    const ready = await page(cookie);
    expect(ready).toContain(">Ready for review</span>");
    expect(ready).toContain("Checks passed.");
    expect(ready).toContain("+  vi.useFakeTimers();");
    expect(ready).toContain("216 passed");
    const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: [store.lookupRef(taskId)!.repo!] }, evidenceRoot);
    expect(assignment?.state).toBe("ready-to-check");
    expect(assignment?.receipt?.checks.status).toBe("passed");
    const shot = /<img src="(\/r\/[0-9]+\/evidence\/[0-9]+)"/.exec(ready)![1]!;
    const image = await fetch(`${base}${shot}`, { headers: { cookie } });
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

    expect((await post(cookie, `/chat/demo/${id}/complete`, { csrf: csrfIn(ready) })).status).toBe(303);
    const completed = await page(cookie);
    expect(completed).toContain(">Complete</span>");
    expect(completed).toContain("That's the whole loop");
    expect(store.handle.prepare("SELECT 1 FROM action_ledger WHERE task_id = ? AND actor = 'operator:demo'").get(taskId)).toBeDefined();

    // Never a model, never outside, never a process, never spend.
    expect(modelCalls).toEqual([]);
    expect(spawned.count).toBe(0);
    expect(spawned.outside).toEqual([]);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_turn").get()!["n"]).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()!["n"]).toBe(0);
  });

  test("a second request works the same way; Change it and Request changes carry the note into a new plan", async () => {
    const cookie = await login();
    let html = await page(cookie);
    await post(cookie, "/chat/demo/ask", { csrf: csrfIn(html), message: "the payouts page copy is confusing" });
    html = await page(cookie);
    await post(cookie, `/chat/demo/${lastId(html)}/change`, { csrf: csrfIn(html), note: "Keep the link text short." });
    html = await page(cookie);
    expect(html).toContain("Replaced by the updated plan below.");
    expect(html).toContain("Also: Keep the link text short.");

    const id = lastId(html);
    await post(cookie, `/chat/demo/${id}/approve`, { csrf: csrfIn(html) });
    later(4_500);
    html = await page(cookie);
    expect(html).toContain(">Ready for review</span>");
    expect(html).toContain("+      &lt;h2&gt;No payouts yet&lt;/h2&gt;");

    expect((await post(cookie, `/chat/demo/${id}/revise`, { csrf: csrfIn(html), note: "Say payments, not payouts." })).status).toBe(303);
    html = await page(cookie);
    expect(html).toContain(">Building</span>");
    expect(html).toContain("Also: Keep the link text short. Say payments, not payouts.");
    const runId = lead.exchanges().find(one => one.id === Number(id))!.runId!;
    expect(store.notesForRun(runId).map(one => one.note)).toContain("Say payments, not payouts.");

    const revised = lastId(html);
    expect(revised).not.toBe(id);
    await post(cookie, `/chat/demo/${revised}/approve`, { csrf: csrfIn(html) });
    later(4_500);
    html = await page(cookie);
    expect(html.match(/>Ready for review<\/span>/g)?.length).toBe(1);
    const tasks = lead.exchanges().filter(one => one.taskId !== null).map(one => one.taskId);
    expect(new Set(tasks).size).toBe(2);

    // A repeated or stale act is refused in words, not repeated.
    const again = await post(cookie, `/chat/demo/${id}/approve`, { csrf: csrfIn(html) });
    expect(decodeURIComponent(again.headers.get("location") ?? "")).toContain("That plan was already handled.");
    expect((await post(cookie, "/chat/demo/ask", { csrf: "0".repeat(64), message: "hi" })).status).toBe(403);
  });
});
