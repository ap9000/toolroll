/**
 * Approve in place (docs/plans/live-pages-and-home.md B2.3): `x-toolroll-act: in-place` changes only the SHAPE of the
 * approve route's answer. Every proof gives the same result with and without it: one table, run both ways, compares
 * what was kept in the store and the status, and checks each outcome's JSON. What the dispatcher answers before the
 * route (a refused form token, a signed-out caller) is answered as today. Isolated stores and fixture sessions only.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { answersInPlace } from "./server/http.js";

let dir: string, store: Store, server: Server, base: string, password: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-approve-in-place-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date());
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const IN_PLACE = { "x-toolroll-act": "in-place", accept: "application/json" };
const cookieOf = (answer: Response) => answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";

async function signIn(name: string, token: string) {
  const cookie = cookieOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }));
  const csrf = csrfOf(await (await fetch(`${base}/tasks`, { headers: { cookie } })).text());
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, ...headers }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
  const page = async (id: string) => (await fetch(`${base}/t/${id}`, { headers: { cookie } })).text();
  return { cookie, csrf, post, page };
}

type Session = Awaited<ReturnType<typeof signIn>>;
async function filed(alex: Session, id: string) {
  store.createTask({ id, title: id }, new Date());
  expect((await alex.post(`/t/${id}/scope`, { acceptance: "c1: ok | manual-review", sawDigest: "", goal: `do ${id}`, not: "", touches: "" })).status).toBe(303);
  const page = await alex.page(id);
  return { digest: store.getScope(id)?.digest ?? "", nonce: nonceOf(page) };
}

type Case = {
  name: string;
  /** Files the task and returns the fields the approve form would send (one click, no password, unless it says). */
  setup: (alex: Session, id: string) => Promise<Record<string, string>>;
  outcome: "approved" | "vote" | "approved-not-rebuilt" | "refused";
  /** Today's status without the header (the success redirect is 303; in place it is 200). */
  status: number | "4xx";
  approved: boolean;
  words?: RegExp;
};

const CASES: Case[] = [
  { name: "a fresh one-click yes", outcome: "approved", status: 303, approved: true, words: /^Approved\.$/,
    setup: async (alex, id) => { const plan = await filed(alex, id); return { nonce: plan.nonce, digest: plan.digest }; } },
  { name: "a stale nonce", outcome: "refused", status: 409, approved: false, words: /stale/,
    setup: async (alex, id) => { const plan = await filed(alex, id); return { nonce: "0".repeat(32), digest: plan.digest }; } },
  { name: "a spent nonce", outcome: "refused", status: 409, approved: false, words: /stale/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      // Spent by an earlier send (refused for its digest): the nonce is gone either way.
      expect((await alex.post(`/t/${id}/approve`, { nonce: plan.nonce, digest: "f".repeat(64) })).status).toBe(409);
      return { nonce: plan.nonce, digest: plan.digest };
    } },
  { name: "a plan that changed after the form was drawn (wrong digest)", outcome: "refused", status: 409, approved: false, words: /changed while this form was open/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      expect((await alex.post(`/t/${id}/scope`, { acceptance: "c1: ok | manual-review", sawDigest: plan.digest, goal: `do ${id} differently`, not: "", touches: "" })).status).toBe(303);
      expect(store.getScope(id)?.digest).not.toBe(plan.digest);
      return { nonce: plan.nonce, digest: plan.digest };
    } },
  { name: "another viewer's nonce", outcome: "refused", status: 409, approved: false, words: /stale/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      const sam = addApprover(store, `sam-${id}`, new Date(), { name: "alex", token: password });
      if (!sam.ok) throw new Error("sam");
      const theirs = nonceOf(await (await signIn(`sam-${id}`, sam.token)).page(id));
      expect(theirs).not.toBe("");
      return { nonce: theirs, digest: plan.digest };
    } },
  { name: "a password needed (no remembered password)", outcome: "refused", status: 400, approved: false, words: /requires your password/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      // Sixteen minutes on: the sign-in's password no longer stands in. The form is drawn then, so its nonce is current.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
      return { nonce: nonceOf(await alex.page(id)), digest: plan.digest };
    } },
  { name: "a closed door (the task was cancelled)", outcome: "refused", status: "4xx", approved: false, words: /cancelled/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      expect(store.cancelTask(id, new Date(), "not needed")).toEqual({ ok: true });
      return { nonce: plan.nonce, digest: plan.digest };
    } },
  { name: "a revision brief that no longer verifies", outcome: "refused", status: 409, approved: false, words: /approval is blocked: the revision brief/,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      // Its brief goes missing after the form was drawn.
      store.handle.exec("PRAGMA foreign_keys = OFF");
      store.handle.prepare("UPDATE task_ref SET revision_brief_artifact = 999999 WHERE external_id = ?").run(id);
      store.handle.exec("PRAGMA foreign_keys = ON");
      return { nonce: plan.nonce, digest: plan.digest };
    } },
  { name: "a first yes on protected work (a vote)", outcome: "vote", status: 200, approved: false,
    setup: async (alex, id) => {
      const plan = await filed(alex, id);
      vi.spyOn(store, "approvalGate").mockReturnValue({ verdict: "vote", have: 1, need: 2, already: false, protectedWork: true } as never);
      // Protected work takes a password typed now (a remembered one doesn't count): Home sends it to the task page.
      return { nonce: plan.nonce, digest: plan.digest, token: password };
    } },
  { name: "approved, but building again did not start", outcome: "approved-not-rebuilt", status: 200, approved: true, words: /^Approved\. The task changed while this page was open/,
    setup: async (alex, id) => { const plan = await filed(alex, id); return { nonce: plan.nonce, digest: plan.digest, rebuild: "999999" }; } },
];

describe("every proof gives the same result with and without the header", () => {
  for (const one of CASES) {
    test(one.name, async () => {
      const seen: { status: number; approvedBy: string | null; votes: unknown }[] = [];
      for (const inPlace of [false, true]) {
        const alex = await signIn("alex", password);
        const id = `t-${CASES.indexOf(one)}-${inPlace ? "p" : "n"}`;
        const fields = await one.setup(alex, id);
        const answer = await alex.post(`/t/${id}/approve`, { ...fields, return: "next" }, inPlace ? IN_PLACE : {});
        vi.restoreAllMocks();
        const type = answer.headers.get("content-type") ?? "";
        if (inPlace) {
          expect(type).toContain("application/json");
          const body = await answer.json() as { outcome: string; words: string };
          expect(Object.keys(body).sort()).toEqual(["outcome", "words"]);
          expect(body.outcome).toBe(one.outcome);
          expect(typeof body.words).toBe("string");
          if (one.words) expect(body.words).toMatch(one.words);
        } else {
          expect(type).not.toContain("application/json");
          // Today's page says the same words (somewhere in its HTML).
          if (one.words && one.outcome !== "approved") expect(await answer.text()).toMatch(new RegExp(one.words.source.replace(/^\^/, "")));
        }
        seen.push({ status: answer.status, approvedBy: store.getScope(id)?.approvedBy ?? null,
          votes: store.handle.prepare("SELECT COUNT(*) AS n FROM scope_approval_vote WHERE task_id = ?").get(id)?.["n"] });
      }
      const [plain, placed] = seen as [typeof seen[number], typeof seen[number]];
      // The same store effect both ways.
      expect(placed.approvedBy).toBe(plain.approvedBy);
      expect(placed.votes).toBe(plain.votes);
      expect(plain.approvedBy).toBe(one.approved ? "alex" : null);
      // The same status, except that a kept yes answers 200 in place instead of redirecting.
      if (one.status === "4xx") expect(plain.status).toBeGreaterThanOrEqual(400);
      else expect(plain.status).toBe(one.status);
      expect(placed.status).toBe(one.outcome === "approved" ? 200 : plain.status);
    });
  }
});

test("what the dispatcher answers before the route stays as it is today, header or not", async () => {
  const alex = await signIn("alex", password);
  const plan = await filed(alex, "t-door");
  // A refused form token: not the route's JSON, and nothing kept.
  const forged = await fetch(`${base}/t/t-door/approve`, { method: "POST", redirect: "manual", headers: { cookie: alex.cookie, origin: base, ...IN_PLACE },
    body: new URLSearchParams({ csrf: "0".repeat(64), nonce: plan.nonce, digest: plan.digest, return: "next" }) });
  expect(forged.status).toBeGreaterThanOrEqual(300);
  expect(forged.headers.get("content-type") ?? "").not.toContain("application/json");
  // Signed out: not the route's JSON either.
  const signedOut = await fetch(`${base}/t/t-door/approve`, { method: "POST", redirect: "manual", headers: { origin: base, ...IN_PLACE },
    body: new URLSearchParams({ csrf: alex.csrf, nonce: plan.nonce, digest: plan.digest, return: "next" }) });
  expect(signedOut.headers.get("content-type") ?? "").not.toContain("application/json");
  expect(store.getScope("t-door")?.approvedBy ?? null).toBeNull();
});

test("the header is read by one helper, for its exact value only", () => {
  const request = (headers: Record<string, string>) => ({ headers }) as never;
  expect(answersInPlace(request({ "x-toolroll-act": "in-place" }))).toBe(true);
  expect(answersInPlace(request({ "x-toolroll-act": "In-Place" }))).toBe(false);
  expect(answersInPlace(request({ "x-toolroll-act": "in-place " }))).toBe(false);
  expect(answersInPlace(request({}))).toBe(false);
  expect(answersInPlace(null)).toBe(false);
});

test("Home's road against the real console (Passwordless on): a selection read mints nothing and carries a sheet with no form control; the press's read mints; one post in place approves", async () => {
  const alex = await signIn("alex", password);
  const plan = await filed(alex, "t-home");
  const read = async (headers: Record<string, string>) => {
    const answer = await fetch(`${base}/t/t-home?format=workspace`, { headers: { cookie: alex.cookie, accept: "application/json", ...headers } });
    expect(answer.status).toBe(200);
    return (await answer.json() as { sensitive: boolean; view: { approve: { action: string; fields: Record<string, string>; planHtml: string; sheetHtml?: string } } });
  };
  // A page that carries a password field (here, the approval's own, for a remembered password) is a password page:
  // Home offers only the link to it there.
  expect((await read({ "x-toolroll-read": "prefetch" })).sensitive).toBe(true);
  const { setPasswordless } = await import("./passwordless.js");
  setPasswordless(store, true, "alex", new Date());
  const selection = await read({ "x-toolroll-read": "prefetch" });
  expect(selection.sensitive).toBe(false);
  expect(selection.view.approve.fields["nonce"]).toBe("unminted");
  expect(selection.view.approve.fields["digest"]).toMatch(/^[0-9a-f]{32,64}$/);
  expect(selection.view.approve.action).toBe("/t/t-home/approve");
  // The task page's plan carries its editor; Home's sheet is the plan alone.
  expect(selection.view.approve.planHtml).toMatch(/<(textarea|input|form)\b/);
  expect(selection.view.approve.sheetHtml).toContain("data-plan-sheet");
  expect(selection.view.approve.sheetHtml).not.toMatch(/<\s*(input|form|button|select|textarea)\b/i);
  // An unminted value never approves.
  const unminted = await alex.post("/t/t-home/approve", { nonce: "unminted", digest: selection.view.approve.fields["digest"]!, return: "next" }, IN_PLACE);
  expect(await unminted.json()).toMatchObject({ outcome: "refused" });
  expect(store.getScope("t-home")?.approvedBy ?? null).toBeNull();
  // The press: a header-less read mints for the digest shown, then one post in place, no password field.
  const press = await read({});
  expect(press.view.approve.fields["digest"]).toBe(selection.view.approve.fields["digest"]);
  expect(press.view.approve.fields["nonce"]).toMatch(/^[0-9a-f]{32}$/);
  const posted = await alex.post("/t/t-home/approve", { nonce: press.view.approve.fields["nonce"]!, digest: plan.digest, return: "next" }, IN_PLACE);
  expect(posted.status).toBe(200);
  expect(await posted.json()).toEqual({ outcome: "approved", words: "Approved." });
  expect(store.getScope("t-home")?.approvedBy).toBe("alex");
});
