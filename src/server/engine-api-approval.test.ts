/**
 * The workbench's approval of a sent-back revision (GET /t/<task>/approval, then the task page's own POST
 * /t/<task>/approve), on a laptop install as the terminal client signs in: the result is sent back, the revision is
 * planned, the card reads its exact terms with the digest the page's own form posts and a nonce minted for them, and the
 * yes goes through the browser's route and its checks. A changed or stale digest refuses; a token is never a person
 * (the card and the yes both refuse it, and a lead in the local owner's chain refuses inside the seal); once approved,
 * the build may claim the task.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import { RESULT_T0 } from "../../test/local-owner-results.js";
import { openApprovalWorld, type ApprovalWorld } from "../../test/approval-card-world.js";
import { stepCardsSchema } from "../contracts/engine-api.js";
import { approvalOf, approve, hashPassword } from "../scope.js";
import { approvalCardSchema } from "../contracts/engine-api.js";
import { enrollOwnerPassword } from "../store.js";
import { acquire } from "../claim.js";
import { mintApiToken } from "../api-tokens.js";
import { asLocalOwner, type LocalPrincipal } from "../local-owner.js";
import { withActor } from "../actor.js";
import { approvalTermsOf, APPROVE_IN_BROWSER, NOTHING_TO_APPROVE } from "./engine-api.js";
import type { ApprovalSummary } from "../approval-summary.js";

let world: LocalWorld, terminal: ApprovalWorld["terminal"], sentBack: ApprovalWorld["sentBack"], card: ApprovalWorld["card"];
beforeEach(async () => { ({ world, terminal, sentBack, card } = await openApprovalWorld()); }, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

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
  expect(await card(session, revision)).toEqual({ version: 1, task: revision, key: null, digest: null, nonce: null, terms: [], problem: NOTHING_TO_APPROVE });
  // The build proceeds: a worker may claim the revision now.
  const ref = world.store.lookupRef(revision)!.id;
  expect(acquire(world.store, ref, "worker-1", { token: "tok-worker-1", now: new Date(), ttlMs: 60_000 })).toMatchObject({ ok: true });
});

test("a note sent back with a quoted requirement ahead of it: the card's Sent back row says what the person typed (stranger 17)", async () => {
  const session = await terminal();
  const revision = await sentBack(session, "Rebuild on the current main.", "Not right: “Add a double function to math.js”");
  const read = await card(session, revision);
  expect(read.terms.at(-1)).toEqual({ label: "Sent back", words: "Rebuild on the current main. (alex)" });
});

test("two notes from one person, one holding the other's words: each shows its own typed words, by its saved id (review round 1)", () => {
  const summary: ApprovalSummary = { revision: null, revisionNotes: [], revisionChanges: [], decisions: [], why: null, differs: [], warnings: [], usual: [], usualLabel: "", usualSummary: "", key: "k" };
  const revision = { sourceTask: "t", sourceRun: 3, kind: "annotations" as const, lineage: null, comments: [
    { id: 11, path: null, line: null, note: "Use cents.", author: "alex" },
    { id: 12, path: null, line: null, note: "Not right: “Totals round”\n\nUse cents. Keep refunds negative.", author: "alex" },
    // A brief from before notes named their ids: shown whole.
    { path: null, line: null, note: "Not right: “Old”\n\nUse cents.", author: "alex" },
  ] };
  // The older note's words first: matched by words, the second note would read "Use cents." and lose an instruction.
  const typed = [{ id: 11, author: "alex", note: "Use cents." }, { id: 12, author: "alex", note: "Use cents. Keep refunds negative." }];
  expect(approvalTermsOf(summary, null, revision, typed).at(-1)).toEqual({ label: "Sent back",
    words: "Use cents. (alex)\nUse cents. Keep refunds negative. (alex)\nNot right: “Old”\n\nUse cents. (alex)" });
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
  expect((await session.get(`/t/${revision}/approval`, { ...bearer, "x-toolroll-key": session.key })).status).toBeGreaterThanOrEqual(400);
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

test("the card is a terminal's keyed read: a cookie without the key (or with another) gets no nonce, and reading again holds the same one", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  for (const headers of [{ cookie: session.cookie }, { cookie: session.cookie, "x-toolroll-key": "0".repeat(64) }]) {
    const refused = await session.get(`/t/${revision}/approval`, headers);
    expect(refused).toEqual({ status: 403, body: JSON.stringify({ error: "key" }) });
  }
  const first = await card(session, revision);
  expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(first.key).toMatch(/^[0-9a-f]{32}$/);
  for (let read = 0; read < 3; read += 1) expect((await card(session, revision)).nonce).toBe(first.nonce);
  // Spent by its yes, the next read holds a new one.
  expect((await session.act(`/t/${revision}/approve`, { digest: first.digest!, nonce: first.nonce!, token: "" })).body).toMatchObject({ outcome: "approved" });
});

test("GET /t/<task>/approval?stepup=1 returns digest, nonce, and terms for native password approval, and POST /login JSON upgrades a local client to a full session", async () => {
  const session = await terminal();
  const revision = await sentBack(session);
  // Mark the repo protected so passwordless local-owner approval is refused.
  world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", RESULT_T0);

  // Without ?stepup=1, the TUI contract stays unchanged (no digest/nonce, browser hint).
  const tuiRead = await card(session, revision);
  expect(tuiRead).toMatchObject({ digest: null, nonce: null, terms: [] });
  expect(tuiRead.problem).toContain(APPROVE_IN_BROWSER);

  // With ?stepup=1 before a password exists, the Mac app receives terms + digest + nonce + "Set a password to approve this."
  const noPwRes = await session.get(`/t/${revision}/approval?stepup=1`, { cookie: session.cookie, "x-toolroll-key": session.key });
  expect(noPwRes.status).toBe(200);
  const noPwCard = approvalCardSchema.parse(JSON.parse(noPwRes.body));
  expect(noPwCard.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(noPwCard.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(noPwCard.problem).toBe("Set a password to approve this.");

  // Set a real password on alex (which signs out old local-owner sessions).
  const password = "correct-horse-battery-99";
  expect(enrollOwnerPassword(world.store, "alex", hashPassword(password), 1, new Date()).ok).toBe(true);

  // Native local JSON login upgrades the client to a full password-authenticated session.
  const badLogin = await world.send(
    "/login",
    "POST",
    { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-toolroll-client": "terminal" },
    new URLSearchParams({ name: "alex", token: "wrong-password" }).toString(),
  );
  expect(badLogin.status).toBe(403);
  expect(JSON.parse(badLogin.body)).toMatchObject({ error: "wrong username or password" });

  // Browser-shaped headers never receive the JSON session payload.
  const browserShaped = await world.send(
    "/login",
    "POST",
    { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-toolroll-client": "terminal", origin: "http://evil.example" },
    new URLSearchParams({ name: "alex", token: password }).toString(),
  );
  expect(browserShaped.headers["content-type"] ?? "").not.toContain("application/json");

  const goodLogin = await world.send(
    "/login",
    "POST",
    { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-toolroll-client": "terminal" },
    new URLSearchParams({ name: "alex", token: password }).toString(),
  );
  expect(goodLogin.status).toBe(200);
  const upgraded = JSON.parse(goodLogin.body) as { account: string; cookie: { name: string; value: string }; csrf: string; key: string; passwordSet: boolean };
  expect(upgraded).toMatchObject({ account: "alex", passwordSet: true });
  const fullCookie = `${upgraded.cookie.name}=${upgraded.cookie.value}`;

  // With ?stepup=1, the Mac app receives the full card (digest, nonce, terms) while POST /approve still enforces password step-up.
  const stepupRes = await world.send(`/t/${revision}/approval?stepup=1`, "GET", { cookie: fullCookie, "x-toolroll-key": upgraded.key, accept: "application/json" });
  expect(stepupRes.status).toBe(200);
  const stepupCard = approvalCardSchema.parse(JSON.parse(stepupRes.body));
  expect(stepupCard.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(stepupCard.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(stepupCard.terms.length).toBeGreaterThan(0);

  // Empty password on protected work is refused (step-up still enforced); real password seals or votes cleanly.
  const emptyTry = await world.send(
    `/t/${revision}/approve`,
    "POST",
    { cookie: fullCookie, origin: world.origin, "x-toolroll-key": upgraded.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal", "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    new URLSearchParams({ csrf: upgraded.csrf, digest: stepupCard.digest!, nonce: stepupCard.nonce!, token: "" }).toString(),
  );
  expect(emptyTry.status).toBe(403);
  expect(approved(revision)).toBe(false);

  // Re-read fresh nonce and submit with real password.
  const stepupCard2 = approvalCardSchema.parse(JSON.parse((await world.send(`/t/${revision}/approval?stepup=1`, "GET", { cookie: fullCookie, "x-toolroll-key": upgraded.key, accept: "application/json" })).body));
  const okTry = await world.send(
    `/t/${revision}/approve`,
    "POST",
    { cookie: fullCookie, origin: world.origin, "x-toolroll-key": upgraded.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal", "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    new URLSearchParams({ csrf: upgraded.csrf, digest: stepupCard2.digest!, nonce: stepupCard2.nonce!, token: password }).toString(),
  );
  expect(okTry.status).toBe(200);
  expect(["approved", "vote"]).toContain((JSON.parse(okTry.body) as { outcome: string }).outcome);
});

