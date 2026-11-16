/**
 * Solo or team through the real console (install-mode.ts): Settings → General says which, in one line; "It's just me"
 * is an instance operator's credential act (a password typed now, never the session), refused while the facts say team;
 * /engine/hello reads the mode the server derived; the approve form's empty password stands only while the install is
 * solo at the moment of the press; and nothing a client sends can claim solo. Isolated stores and fixture sessions only.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addApprover, hashPassword } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { INSTALL_MODE_ACTION, installModeNow } from "../install-mode.js";
import { setPasswordless } from "../passwordless.js";
import { taskSizingOn } from "../task-sizing.js";

let store: Store, server: Server, base: string, dir: string, password = "";
let cookie = "", csrf = "";

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-install-mode-")));
  mkdirSync(join(dir, "config"));
  store = openStore(join(dir, "toolroll.db"));
  const now = new Date();
  // An install from before solo: one person, and no declaration. Team until its owner says otherwise.
  const alex = addApprover(store, "alex", now); if (!alex.ok) throw new Error("bootstrap");
  password = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: join(dir, "main"), configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())![1]!;
  // No remembered password: the step-up must stand on the mode alone, not on the password typed at sign-in.
  expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { cookie, origin: base, ...headers }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
}
const hello = async (headers: Record<string, string> = {}) => (await (await get("/engine/hello", headers)).json()) as { mode: string; defaultChain: string };
/** A task with a scope, and the approve form's nonce as the task page drew it. */
async function drawn(id: string): Promise<{ nonce: string; digest: string; page: string }> {
  store.createTask({ id, title: id }, new Date());
  expect((await post(`/t/${id}/scope`, { acceptance: "c1: ok | manual-review", sawDigest: "", goal: `do ${id}`, not: "", touches: "" })).status).toBe(303);
  const page = await (await get(`/t/${id}`)).text();
  // The form's own digest: the scope, the plan and the summary key it showed (render-tasks.ts approvalFormDigest).
  const form = /<form[^>]*action="\/t\/[^"]+\/approve"[\s\S]*?<\/form>/.exec(page)?.[0] ?? "";
  return { nonce: /name="nonce" value="([0-9a-f]{32})"/.exec(form)?.[1] ?? "", digest: /name="digest" value="([0-9a-f]+)"/.exec(form)?.[1] ?? "", page };
}
const approved = (id: string) => store.getScope(id)?.approvedAt != null;

const said = (answer: Response) => decodeURIComponent(answer.headers.get("location") ?? "").replace(/\+/g, " ");

describe("Settings → General: task sizing by a quick model call", () => {
  test("off by default; on a team install only the password changes it, on its change document", async () => {
    expect(taskSizingOn(store)).toBe(false);
    const page = await (await get("/settings/general")).text();
    expect(page).toContain('data-section="task-sizing"');
    expect(page).toContain("Size tasks with a quick model call (Claude Haiku, on your plan)");
    expect(page).toContain("Off: no model call before you approve; uncertain tasks get a plan first.");
    expect(page).toContain('href="/settings/change/task-sizing"');
    const change = await (await get("/settings/change/task-sizing")).text();
    expect(change).toContain('action="/settings/task-sizing"');
    // Team: the session never stands in, and a wrong password changes nothing.
    for (const typed of ["", "not-it"]) {
      expect(said(await post("/settings/task-sizing", { enabled: "on", password: typed }))).toMatch(/^\/settings\/change\/task-sizing\?problem=Enter your Toolroll password/);
      expect(taskSizingOn(store)).toBe(false);
    }
    expect(said(await post("/settings/task-sizing", { enabled: "maybe", password })).includes("Choose on or off")).toBe(true);
    expect(said(await post("/settings/task-sizing", { enabled: "on", password }))).toContain("Task sizing is on");
    expect(taskSizingOn(store)).toBe(true);
    expect(store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'task sizing by a quick model call'").all()).toEqual([{ actor: "alex", outcome: "on" }]);
    expect(said(await post("/settings/task-sizing", { enabled: "off", password }))).toContain("Task sizing is off");
    expect(taskSizingOn(store)).toBe(false);
    // The password typed here is remembered on this session: forgotten again, so what follows stands on the mode alone.
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
  });
});

describe("an existing install, then It's just me", () => {
  test("General says Team in one line and offers It's just me to its instance operator", async () => {
    const page = await (await get("/settings/general")).text();
    expect(page).toContain('data-section="install-mode"');
    expect(page).toContain("More than one person can use this install.");
    expect(page).toContain('href="/settings/change/just-me"');
    expect(await hello()).toMatchObject({ mode: "team", defaultChain: "plan-first" });
    // Team: the approve form's empty password proves nothing.
    const form = await drawn("team-one");
    expect(form.digest).not.toBe("");
    const pressed = await post(`/t/team-one/approve`, { nonce: form.nonce, digest: form.digest, token: "" });
    expect([pressed.status, await pressed.text()]).toEqual([400, expect.stringContaining("approval requires your password")]);
    expect(approved("team-one")).toBe(false);
  });

  test("It's just me takes a password typed now: an empty one (the session) and a wrong one change nothing", async () => {
    const empty = await post("/settings/install-mode/solo", { password: "" });
    expect(empty.headers.get("location")).toMatch(/^\/settings\/change\/just-me\?problem=/);
    const wrong = await post("/settings/install-mode/solo", { password: "not-it" });
    expect(wrong.headers.get("location")).toMatch(/^\/settings\/change\/just-me\?problem=/);
    expect(installModeNow(store).mode).toBe("team");
    const done = await post("/settings/install-mode/solo", { password });
    expect(done.headers.get("location")).toMatch(/^\/settings\/general\?section=install-mode&said=/);
    expect(installModeNow(store)).toMatchObject({ mode: "solo", declared: { by: "alex", why: "just-me" } });
    expect(store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = ?").all(INSTALL_MODE_ACTION)).toEqual([{ actor: "alex", outcome: "solo" }]);
  });

  test("solo: General says Solo, hello says solo, and the approve form's empty password approves", async () => {
    // The password typed for It's just me is remembered for standard approvals (team rules too): forget it, so what
    // follows stands on the mode alone.
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    const page = await (await get("/settings/general")).text();
    expect(page).toContain("Just you.");
    expect(page).not.toContain('href="/settings/change/just-me"');
    expect(await hello()).toEqual(expect.objectContaining({ mode: "solo", defaultChain: "just-code" }));
    const form = await drawn("solo-one");
    expect(form.page).not.toContain('name="token" type="password"');
    expect((await post(`/t/solo-one/approve`, { nonce: form.nonce, digest: form.digest, token: "" })).status).toBe(303);
    expect(approved("solo-one")).toBe(true);
  });

  test("solo: the session stands in for task sizing's step-up", async () => {
    expect(said(await post("/settings/task-sizing", { enabled: "on", password: "" }))).toContain("Task sizing is on");
    expect(taskSizingOn(store)).toBe(true);
    expect(said(await post("/settings/task-sizing", { enabled: "off", password: "" }))).toContain("Task sizing is off");
    expect(taskSizingOn(store)).toBe(false);
  });

  test("the race: drawn while solo, a person joins, then the press: refused under team rules", async () => {
    const form = await drawn("raced");
    store.saveApprover("robin", hashPassword("robin-pw-1"), new Date());
    const pressed = await post(`/t/raced/approve`, { nonce: form.nonce, digest: form.digest, token: "" });
    expect([pressed.status, await pressed.text()]).toEqual([400, expect.stringContaining("approval requires your password")]);
    expect(approved("raced")).toBe(false);
  });

  test("a client claiming solo is ignored: headers, cookies and query words decide nothing", async () => {
    const claims = { "x-toolroll-mode": "solo", "x-toolroll-install-mode": "solo", cookie: `${cookie}; so-mode=solo; toolroll-mode=solo` };
    expect(await hello(claims)).toMatchObject({ mode: "team" });
    const form = await drawn("claimed");
    const pressed = await post(`/t/claimed/approve?mode=solo`, { nonce: form.nonce, digest: form.digest, token: "" }, claims);
    expect([pressed.status, await pressed.text()]).toEqual([400, expect.stringContaining("approval requires your password")]);
    expect(approved("claimed")).toBe(false);
  });

  test("It's just me refuses while the facts say team, with the words, and writes nothing", async () => {
    const before = store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(INSTALL_MODE_ACTION)!["n"];
    const refused = await post("/settings/install-mode/solo", { password });
    expect(decodeURIComponent(refused.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("Another person has an account here.");
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(INSTALL_MODE_ACTION)!["n"]).toBe(before);
    expect(installModeNow(store).mode).toBe("team");
    const document = await (await get("/settings/change/just-me")).text();
    expect(document).toContain("Another person has an account here.");
    expect(document).not.toContain('action="/settings/install-mode/solo"');
  });

  test("It's just me is a credential act: even with Passwordless on, the session never stands in for the password", async () => {
    setPasswordless(store, true, "alex", new Date());
    const session = await post("/settings/install-mode/solo", { password: "" });
    expect(decodeURIComponent(session.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("Enter your Toolroll password");
    expect(installModeNow(store).mode).toBe("team");
  });
});
