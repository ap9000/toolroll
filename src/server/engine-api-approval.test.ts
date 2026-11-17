/**
 * The workbench's approval of a sent-back revision (GET /t/<task>/approval, then the task page's own POST
 * /t/<task>/approve), on a laptop install as the terminal client signs in: the result is sent back, the revision is
 * planned, the card reads its exact terms with the digest the page's own form posts and a nonce minted for them, and the
 * yes goes through the browser's route and its checks. A changed or stale digest refuses; a token is never a person
 * (the card and the yes both refuse it, and a lead in the local owner's chain refuses inside the seal); once approved,
 * the build may claim the task.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import { resultFixtures, RESULT_T0 } from "../../test/local-owner-results.js";
import { plannerKeptTerms } from "../../test/serve-kit.js";
import { approvalCardSchema, linkRedemptionSchema, stepCardsSchema } from "../contracts/engine-api.js";
import { approvalOf, approve } from "../scope.js";
import { acquire } from "../claim.js";
import { mintApiToken } from "../api-tokens.js";
import { asLocalOwner, type LocalPrincipal } from "../local-owner.js";
import { withActor } from "../actor.js";
import { APPROVE_IN_BROWSER, NOTHING_TO_APPROVE } from "./engine-api.js";

let world: LocalWorld, fx: ReturnType<typeof resultFixtures>;
beforeEach(async () => {
  world = await openLocalWorld({ browserKey: true });
  fx = resultFixtures(world, join(world.root, "evidence"));
  fx.prepare();
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

/** The local owner's terminal session, as the workbench redeems it (POST /login/once). */
async function terminal() {
  const link = world.server.mintLocalLink()!;
  const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
  const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
  const cookie = `${body.cookie.name}=${body.cookie.value}`;
  const get = async (path: string, headers: Record<string, string> = { cookie }) => {
    const answer = await world.send(path, "GET", { accept: "application/json", ...headers });
    return { status: answer.status, body: answer.body };
  };
  // An act as the workbench posts it (client.rs act): form token, mutation key, its answer asked for in place.
  const act = async (path: string, fields: Record<string, string>) => {
    const answer = await world.send(path, "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json",
      "x-toolroll-key": body.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }, new URLSearchParams({ csrf: body.csrf, ...fields }).toString());
    return { status: answer.status, body: JSON.parse(answer.body) as { outcome: string; words: string } };
  };
  return { cookie, get, act };
}

/** A Ready result sent back from the workbench (its own road), and the revision planned with the terms kept. */
async function sentBack(session: Awaited<ReturnType<typeof terminal>>): Promise<string> {
  const result = fx.ready("ordinary");
  const steps = stepCardsSchema.parse(JSON.parse((await session.get(`/t/${result.id}/steps`)).body));
  expect(steps.review?.run).toBe(result.runId);
  const sent = await session.act(`/r/${result.runId}/comment`, { intent: "revise", note: "Round the tax to cents.", request: randomBytes(16).toString("hex"), batch: "", source: steps.review!.source });
  expect(sent.body).toEqual({ outcome: "done", words: "Sent back. The revision is filed." });
  const revision = world.store.handle.prepare("SELECT consumed_by AS id FROM diff_comment WHERE run = ?").get(result.runId)?.["id"] as string;
  plannerKeptTerms(world.store, revision);
  return revision;
}

const card = async (session: Awaited<ReturnType<typeof terminal>>, task: string) => {
  const answer = await session.get(`/t/${encodeURIComponent(task)}/approval`);
  expect(answer.status).toBe(200);
  return approvalCardSchema.parse(JSON.parse(answer.body));
};
const approved = (task: string) => approvalOf(world.store.getScope(task)).approved;

test("send back, the revision waits, the workbench reads its exact terms and approves them on the page's own route; the build may then claim it", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  // The step cards say it waits for this person's yes, with the terms on the Approval card.
  const steps = stepCardsSchema.parse(JSON.parse((await session.get(`/t/${revision}/steps`)).body));
  const approveCard = steps.cards?.find(one => one.key === "approve");
  expect(approveCard).toMatchObject({ state: "current", needsYou: true });
  expect(approveCard?.terms?.revision).toMatch(/^This revises build #/);
  const read = await card(session, revision);
  expect(read).toMatchObject({ task: revision, problem: null });
  // The terms: the summary's rows (the revision's own sentence first), then the note it was sent back with.
  expect(read.terms[0]).toMatchObject({ label: "Revision", words: approveCard!.terms!.revision });
  expect(read.terms.at(-1)).toEqual({ label: "Sent back", words: "Round the tax to cents. (alex)" });
  // The digest is the one the task page's own approval form carries for this person.
  const moved = await world.send(`/t/${revision}`, "GET", { cookie: session.cookie });
  const page = (await world.send(String(moved.headers.location ?? `/t/${revision}`), "GET", { cookie: session.cookie })).body;
  expect(page).toContain(`name="digest" value="${read.digest}"`);
  expect(approved(revision)).toBe(false);
  // The yes: the page's route, its digest and nonce, no password (the laptop's owner on eligible work).
  const yes = await session.act(`/t/${revision}/approve`, { digest: read.digest!, nonce: read.nonce!, token: "" });
  expect(yes).toEqual({ status: 200, body: { outcome: "approved", words: "Approved." } });
  expect(world.store.getScope(revision)).toMatchObject({ approvedBy: "alex" });
  expect(approved(revision)).toBe(true);
  // Spent: the same nonce again is a stale form, and the card now has nothing to approve (no nonce minted).
  expect((await session.act(`/t/${revision}/approve`, { digest: read.digest!, nonce: read.nonce!, token: "" })).body).toMatchObject({ outcome: "refused", words: "that approval form is stale — read it again" });
  expect(await card(session, revision)).toEqual({ version: 1, task: revision, digest: null, nonce: null, terms: [], problem: NOTHING_TO_APPROVE });
  // The build proceeds: a worker may claim the revision now.
  const ref = world.store.lookupRef(revision)!.id;
  expect(acquire(world.store, ref, "worker-1", { token: "tok-worker-1", now: new Date(), ttlMs: 60_000 })).toMatchObject({ ok: true });
});

test("a stale or changed digest refuses and approves nothing", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  const first = await card(session, revision);
  // Another digest than the one the nonce was minted for: a stale form (and the nonce stays its own).
  expect((await session.act(`/t/${revision}/approve`, { digest: "0".repeat(64), nonce: first.nonce!, token: "" })).body)
    .toMatchObject({ outcome: "refused", words: "that approval form is stale — read it again" });
  // The terms change after they were read (the installation's checks level, one of the usual settings the summary names): the yes refuses.
  world.store.setQualityDefault("strict", "alex", RESULT_T0);
  const changed = await session.act(`/t/${revision}/approve`, { digest: first.digest!, nonce: first.nonce!, token: "" });
  expect(changed).toEqual({ status: 409, body: { outcome: "refused", words: "the scope or plan changed while this form was open — read the latest version and approve again" } });
  expect(approved(revision)).toBe(false);
  // Read again: a new digest for the new terms, and that yes stands.
  const again = await card(session, revision);
  expect(again.digest).not.toBe(first.digest);
  expect((await session.act(`/t/${revision}/approve`, { digest: again.digest!, nonce: again.nonce!, token: "" })).body).toMatchObject({ outcome: "approved" });
});

test("a token is never a person: no card and no yes for an API token, and a lead in the local owner's chain refuses inside the seal", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  const minted = mintApiToken();
  world.store.createApiToken({ id: minted.id, account: "alex", name: "lead", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  const bearer = { authorization: `Bearer ${minted.token}` };
  expect((await session.get(`/t/${revision}/approval`, bearer)).status).toBeGreaterThanOrEqual(400);
  const read = await card(session, revision);
  const posted = await world.send(`/t/${revision}/approve`, "POST", { ...bearer, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    new URLSearchParams({ digest: read.digest!, nonce: read.nonce!, token: "" }).toString());
  expect(posted.status).toBeGreaterThanOrEqual(400);
  // The lead, inside the owner's own approve-plan act: still not a person.
  const owner: LocalPrincipal = { account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "terminal", act: "approve-plan", sessionHash: null, request: null };
  const scope = world.store.getScope(revision)!;
  const lead = asLocalOwner(owner, () => withActor({ account: "alex", lead: true }, () => approve(world.store, revision, "alex", new Date(), scope.digest, "")));
  expect(lead).toMatchObject({ ok: false });
  expect(approved(revision)).toBe(false);
  // The person's own yes, with the card read before, still stands.
  expect((await session.act(`/t/${revision}/approve`, { digest: read.digest!, nonce: read.nonce!, token: "" })).body).toMatchObject({ outcome: "approved" });
});

test("work the local owner can't approve without a password gets no nonce: the card says to use the browser", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  // Protected work needs a password and a second person (localApprovalEligible): never the workbench's yes.
  world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", RESULT_T0);
  const read = await card(session, revision);
  expect(read).toMatchObject({ digest: null, nonce: null, terms: [] });
  expect(read.problem).toContain(APPROVE_IN_BROWSER);
  expect(approved(revision)).toBe(false);
});
