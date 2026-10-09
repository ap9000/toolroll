/**
 * Invites, roles, and the severing revocation (v29, U1–U3/D6/D7/E3):
 * the single-use join door with its metered attempts and one
 * indistinguishable dead page, the pinned-role account creation in one
 * transaction, the cascade that ends everything a removed person's
 * signature held up — and the People surface over real HTTP.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateAccount, authenticateApprover, fileAndSealUnderMode, hashPassword, type AcceptanceCriterion } from "./scope.js";

const RUBRIC: AcceptanceCriterion[] = [{ id: "c1", statement: "the change is reviewed", how: null, evidence: ["manual-review"] }];

import { acquire, acquireIfReady } from "./claim.js";
import { register } from "./runner.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "./modes.js";
import { createDecisionServer } from "./serve.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-27T12:00:00.000Z");
const REPO = "/repos/thing";
const later = (hours: number) => new Date(T0.getTime() + hours * 60 * 60_000);


function evidenceRootOf(): string {
  return mkdtempSync(joinPath(tmpdir(), "so-live-shape-"));
}

describe("invites in the store", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  test("the whole door: mint, live, admit, consume — role pinned, single winner, then dead", () => {
    const minted = store.mintInvite("viewer", "alex", T0);
    expect(minted.token.length).toBeGreaterThanOrEqual(16);
    expect(store.inviteIsLive(minted.token, T0)).toBe(true);
    expect(store.inviteIsLive("not-a-real-token-at-all", T0)).toBe(false);

    const admitted = store.admitInviteAttempt(minted.token, T0);
    expect(admitted).toEqual({ role: "viewer", mintedBy: "alex" });

    const made = store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "casey", credentialHash: hashPassword("a-long-password") }, T0);
    expect(made).toEqual({ ok: true, role: "viewer" });
    // The account authenticates with the PINNED role — and cannot approve.
    expect(authenticateAccount(store, "casey", "a-long-password")).toMatchObject({ ok: true, role: "viewer" });
    expect(authenticateApprover(store, "casey", "a-long-password")).toEqual({ ok: false, reason: "not-an-approver" });

    // Spent is spent: the CAS has one winner, the door reads dead.
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "dana", credentialHash: hashPassword("another-pass") }, T0)).toEqual({ ok: false, reason: "gone" });
    expect(store.inviteIsLive(minted.token, T0)).toBe(false);
    expect(store.admitInviteAttempt(minted.token, T0)).toBeNull();
  });

  test("attempts meter admission and never refund: the door dies at ten", () => {
    const minted = store.mintInvite("viewer", "alex", T0);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(store.admitInviteAttempt(minted.token, T0)).not.toBeNull();
    }
    expect(store.admitInviteAttempt(minted.token, T0)).toBeNull();
    expect(store.inviteIsLive(minted.token, T0)).toBe(false);
    // consumeInviteAndCreateAccount is only ever reached BEHIND a
    // successful admission in the same request — the spent-out door
    // refuses at admit, so no submission can reach the KDF or the CAS.
  });

  test("expiry and revocation both read as the same dead", () => {
    const expiring = store.mintInvite("viewer", "alex", T0);
    expect(store.inviteIsLive(expiring.token, later(73))).toBe(false);
    expect(store.admitInviteAttempt(expiring.token, later(73))).toBeNull();

    const revoked = store.mintInvite("approver", "alex", T0);
    expect(store.revokeInvite(revoked.id, T0)).toBe(true);
    expect(store.inviteIsLive(revoked.token, T0)).toBe(false);
    expect(store.revokeInvite(revoked.id, T0)).toBe(false);
  });

  test("a taken name refuses without consuming the invite", () => {
    const minted = store.mintInvite("viewer", "alex", T0);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "alex", credentialHash: hashPassword("whatever-else") }, T0)).toEqual({ ok: false, reason: "name-taken" });
    // The invite survives the collision — the person picks another name.
    expect(store.inviteIsLive(minted.token, T0)).toBe(true);
  });
});

describe("the severing revocation (D7)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  const addPerson = (name: string, role: "approver" | "viewer") => {
    const minted = store.mintInvite(role, "alex", T0);
    const made = store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name, credentialHash: hashPassword(`${name}-password`) }, T0);
    if (!made.ok) throw new Error("seed person");
  };

  test("one transaction ends sessions, invites, and every mode they signed", () => {
    addPerson("bob", "approver");
    // Bob signs a mode and mints an invite.
    const terms = presetTerms("standard", later(24).toISOString());
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "bob", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    const bobsInvite = store.mintInvite("viewer", "bob", T0);

    const before = store.accountFacts().find(one => one.name === "bob");
    const severed = store.revokeAccount("bob", "alex", T0);
    expect(severed).toEqual({ ok: true, modesRevoked: 1, invitesRevoked: 1 });

    // The credential is dead and its generation moved (cookies die at
    // their next lookup; bearers die at authenticateAccount).
    expect(authenticateAccount(store, "bob", "bob-password")).toEqual({ ok: false, reason: "revoked" });
    const after = store.accountFacts().find(one => one.name === "bob");
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokedBy).toBe("alex");
    void before;

    // The mode he signed is gone, with the typed event.
    expect(store.activeMode(REPO, T0)).toBeNull();
    const event = store.raw().prepare("SELECT kind, actor FROM operating_mode_event ORDER BY id DESC LIMIT 1").get();
    expect(event).toMatchObject({ kind: "signer-revoked", actor: "alex" });

    // His invite ended with him.
    expect(store.inviteIsLive(bobsInvite.token, T0)).toBe(false);

    // History is untouched: the account row itself remains, attributable.
    expect(store.accountFacts().some(one => one.name === "bob")).toBe(true);
  });

  test("the last active approver cannot be removed; viewers always can be", () => {
    expect(store.revokeAccount("alex", "alex", T0)).toEqual({ ok: false, reason: "last-approver" });
    addPerson("casey", "viewer");
    expect(store.revokeAccount("casey", "alex", T0).ok).toBe(true);
    // Still just one approver — still guarded.
    expect(store.revokeAccount("alex", "alex", T0)).toEqual({ ok: false, reason: "last-approver" });
    addPerson("dana", "approver");
    expect(store.revokeAccount("alex", "dana", T0).ok).toBe(true);
    expect(store.revokeAccount("nobody", "dana", T0)).toEqual({ ok: false, reason: "unknown" });
    expect(store.revokeAccount("alex", "dana", T0)).toEqual({ ok: false, reason: "already-revoked" });
  });

  test("the v29 rebuild accepts SQLite's real ALTER-appended shape (found on the live console)", () => {
    // A v28 database whose merge_blocker gained lifted_at/lifted_by via
    // ALTER TABLE stores them as "…NOT NULL\n, lifted_at TEXT…" — newline
    // BEFORE the comma. The recognizer must accept exactly that text.
    const file = `${evidenceRootOf()}/live-shape.db`;
    {
      const old = openStore(file);
      old.close();
    }
    {
      const raw = openStore(file);
      raw.raw().exec("PRAGMA foreign_keys = OFF");
      raw.raw().exec("DROP TABLE merge_blocker");
      raw.raw().exec(
        "CREATE TABLE merge_blocker (\n" +
          "  publication INTEGER NOT NULL UNIQUE REFERENCES publication(id),\n" +
          "  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),\n" +
          "  task_id     TEXT,\n" +
          "  created_at  TEXT NOT NULL\n" +
          ", lifted_at TEXT, lifted_by TEXT)",
      );
      raw.raw().exec("DROP TABLE service_cursor; UPDATE schema_version SET version = 28");
      raw.close();
    }
    const reopened = openStore(file);
    const ddl = reopened
      .raw()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_blocker'")
      .get();
    expect(String(ddl?.["sql"])).toContain("lifted_at");
    expect(String(ddl?.["sql"])).not.toContain("UNIQUE");
    reopened.close();
  });

  test("merge blocker lifts are stamps with a name — and the block can recur", () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "b-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    const publication = store.createPublicationIntent(
      { run, taskRef: ref, githubRepo: "alex/thing", remote: "origin", base: "main", head: "b", headSha: "s".repeat(40), bodyHash: "x", draft: false },
      T0,
    );
    store.createMergeBlocker(publication, "t-1", T0);
    expect(store.mergeBlockerFor(publication)).not.toBeNull();
    expect(store.liftMergeBlocker(publication, "alex", T0)).toBe(true);
    expect(store.mergeBlockerFor(publication)).toBeNull();
    expect(store.liftMergeBlocker(publication, "alex", T0)).toBe(false);
    const row = store.raw().prepare("SELECT lifted_by FROM merge_blocker WHERE publication = ?").get(publication);
    expect(row).toMatchObject({ lifted_by: "alex" });
    // A later repair can block the same publication again.
    store.createMergeBlocker(publication, "t-1", later(1));
    expect(store.mergeBlockerFor(publication)).not.toBeNull();
    // And the person's ledger answers for the lift.
    expect(store.recentActsOf("alex").some(act => act.kind === "merge unblocked")).toBe(true);
  });
});

describe("the round-1 closures: escalation, mode-derived approvals, the join race", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    // The runner gate (MCP spec v6): claims authenticate and bind to a repo.
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
  });
  afterEach(() => store.close());

  const addPerson = (name: string, role: "approver" | "viewer") => {
    const minted = store.mintInvite(role, "alex", T0);
    const made = store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name, credentialHash: hashPassword(`${name}-password`) }, T0);
    if (!made.ok) throw new Error("seed person");
  };

  test("neither a viewer nor a revoked approver can vouch a new approver into existence (finding 1)", () => {
    addPerson("vera", "viewer");
    const viaViewer = addApprover(store, "mallory", T0, { name: "vera", token: "vera-password" });
    expect(viaViewer).toEqual({ ok: false, reason: "not-an-approver" });

    addPerson("bob", "approver");
    expect(store.revokeAccount("bob", "alex", T0).ok).toBe(true);
    const viaRevoked = addApprover(store, "mallory", T0, { name: "bob", token: "bob-password" });
    expect(viaRevoked).toEqual({ ok: false, reason: "not-an-approver" });
    expect(store.accountFacts().some(one => one.name === "mallory")).toBe(false);
  });

  const signStandard = (by: string, hoursValid = 24) => {
    const terms = { ...presetTerms("standard", later(hoursValid).toISOString()), autoApproveFiling: true };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    return modeDigestOf(terms);
  };

  const sealUnderMode = (taskId: string) => {
    store.createTask({ id: taskId, title: "the work" }, T0);
    store.placeTask(store.refFor("built-in", taskId).id, REPO);
    const sealed = fileAndSealUnderMode(store, {
      taskId,
      goal: "a guard",
      outOfScope: null,
      touches: [],
      acceptance: RUBRIC,
      now: T0,
      repo: REPO,
      actor: "alex",
    });
    if (!sealed.ok) throw new Error(`seal: ${sealed.reason}`);
  };

  test("revoking the mode demotes its sealed, undispatched approvals — the human ceremony is the next gate (finding 2)", () => {
    signStandard("alex");
    sealUnderMode("t-1");
    expect(store.getScope("t-1")?.approvedAt).not.toBeNull();
    store.revokeMode(REPO, "alex", "operator", T0);
    const scope = store.getScope("t-1");
    expect(scope?.approvedAt ?? null).toBeNull();
    // And the task no longer dispatches on the dead signature.
    const taken = acquireIfReady(store, store.refFor("built-in", "t-1").id, "builder-1", { token: "tok-builder-1", now: later(1) });
    expect(taken.ok).toBe(false);
  });

  test("revoking the SIGNER demotes the same approvals through the cascade (finding 2, D7 road)", () => {
    addPerson("bob", "approver");
    const terms = { ...presetTerms("standard", later(24).toISOString()), autoApproveFiling: true };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "bob", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    store.createTask({ id: "t-1", title: "the work" }, T0);
    store.placeTask(store.refFor("built-in", "t-1").id, REPO);
    const sealed = fileAndSealUnderMode(store, { taskId: "t-1", goal: "a guard", outOfScope: null, touches: [], acceptance: RUBRIC, now: T0, repo: REPO, actor: "bob" });
    if (!sealed.ok) throw new Error("seal");
    expect(store.revokeAccount("bob", "alex", T0).ok).toBe(true);
    expect(store.getScope("t-1")?.approvedAt ?? null).toBeNull();
  });

  test("a RUNNING task's mode-sealed approval is never fenced (finding 2's boundary)", () => {
    signStandard("alex");
    sealUnderMode("t-1");
    const ref = store.refFor("built-in", "t-1").id;
    const taken = acquireIfReady(store, ref, "builder-1", { token: "tok-builder-1", now: T0 });
    expect(taken.ok).toBe(true);
    store.revokeMode(REPO, "alex", "operator", T0);
    // The claim is live: the sweep leaves the approval standing.
    expect(store.getScope("t-1")?.approvedAt).not.toBeNull();
  });

  test("the acquire belt holds in the window before an expired mode is durably closed (finding 2)", () => {
    signStandard("alex", 1);
    sealUnderMode("t-1");
    // NOTHING has read activeMode since expiry — the row is still open,
    // only the clock has passed. Dispatch must still refuse.
    const taken = acquireIfReady(store, store.refFor("built-in", "t-1").id, "builder-1", { token: "tok-builder-1", now: later(2) });
    expect(taken.ok).toBe(false);
  });

  test("the belt covers the RAW claim road and the builder gate, not just acquireIfReady (round 2, finding 2)", () => {
    signStandard("alex", 1);
    sealUnderMode("t-1");
    const ref = store.refFor("built-in", "t-1").id;
    // The expired-by-clock mode: the CLI's raw acquire refuses, typed.
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: later(2) });
    expect(taken).toMatchObject({ ok: false, reason: "mode-ended" });
    // And the one shared question answers the same everywhere.
    expect(store.modeApprovalLive(ref, T0)).toBe(true);
    expect(store.modeApprovalLive(ref, later(2))).toBe(false);
  });

  test("the demotion sweep correlates through the built-in reference exactly (round 2, finding 3)", () => {
    signStandard("alex");
    sealUnderMode("t-1");
    // A same-id EXTERNAL reference in a DIFFERENT repo must not drag t-1's
    // approval into that repo's reconciliation.
    store.refFor("github", "t-1", "theirs");
    store.raw().prepare("UPDATE task_ref SET repo = '/repos/other' WHERE backend = 'github' AND external_id = 't-1'").run();
    const otherTerms = { ...presetTerms("standard", later(24).toISOString()), autoApproveFiling: true };
    store.signMode(
      { repo: "/repos/other", name: "standard", termsJson: modeTermsJson(otherTerms), digest: modeDigestOf(otherTerms), signedBy: "alex", absoluteExpiry: otherTerms.absoluteExpiry, publication: otherTerms.publication },
      T0,
    );
    store.revokeMode("/repos/other", "alex", "operator", T0);
    // t-1's approval (repo /repos/thing, live mode) is untouched.
    expect(store.getScope("t-1")?.approvedAt).not.toBeNull();
  });

  test("the concurrent join loser reads as gone, never as a name collision (finding 3)", () => {
    const minted = store.mintInvite("viewer", "alex", T0);
    expect(store.admitInviteAttempt(minted.token, T0)).not.toBeNull();
    expect(store.admitInviteAttempt(minted.token, T0)).not.toBeNull();
    const winner = store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "casey", credentialHash: hashPassword("casey-password-1") }, T0);
    expect(winner.ok).toBe(true);
    // Same name, different name — the loser cannot tell which world it is in.
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "casey", credentialHash: hashPassword("casey-password-2") }, T0)).toEqual({ ok: false, reason: "gone" });
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "dana", credentialHash: hashPassword("dana-password-9") }, T0)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("the join road and the People screen, over HTTP", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (name: string, secret: string): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name, token: secret }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfOf = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url("/people"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the people page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot: "/nonexistent", clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });

  test("every dead token shape answers with ONE page; a live one shows the form without spending", async () => {
    const unknown = await (await fetch(url(`/join/${"a".repeat(24)}`))).text();
    const minted = store.mintInvite("viewer", "alex", new Date());
    store.revokeInvite(minted.id, new Date());
    const revoked = await (await fetch(url(`/join/${minted.token}`))).text();
    expect(revoked).toBe(unknown);
    expect(unknown).toContain("can't be used");

    const live = store.mintInvite("viewer", "alex", new Date());
    const form = await (await fetch(url(`/join/${live.token}`))).text();
    expect(form).toContain("Create my sign-in");
    // The GET spent nothing.
    const row = store.raw().prepare("SELECT attempts FROM invite WHERE id = ?").get(live.id);
    expect(row).toMatchObject({ attempts: 0 });
  });

  test("the join road end to end: guards, account, cookie, and the viewer ceiling", async () => {
    const minted = store.mintInvite("viewer", "alex", new Date());

    // Guards first: content type and duplicate fields.
    const wrongType = await fetch(url(`/join/${minted.token}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    // Prefix-shaped is not a form either (round 2, finding 5).
    const prefixed = await fetch(url(`/join/${minted.token}`), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded-malformed" },
      body: "name=x&password=y",
    });
    expect(prefixed.status).toBe(415);
    const doubled = await fetch(url(`/join/${minted.token}`), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=casey&name=other&password=long-enough-pass",
    });
    expect(doubled.status).toBe(400);

    // A weak password earns words (the attempt is spent — E3 never refunds).
    const weak = await fetch(url(`/join/${minted.token}`), {
      method: "POST",
      body: new URLSearchParams({ name: "casey", password: "short" }),
    });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain("at least 8 characters");

    // The real join: account, pinned role, cookie, redirect home.
    const joined = await fetch(url(`/join/${minted.token}`), {
      method: "POST",
      body: new URLSearchParams({ name: "casey", password: "casey-good-password" }),
      redirect: "manual",
    });
    expect(joined.status).toBe(303);
    const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie).not.toBe("");

    // The link is spent: its page is the dead page now.
    const again = await (await fetch(url(`/join/${minted.token}`))).text();
    expect(again).toContain("can't be used");

    // The viewer sees themselves on /people — and only themselves.
    const people = await (await fetch(url("/people"), { headers: { cookie } })).text();
    expect(people).toContain("casey");
    expect(people).not.toContain("Invite someone");

    // The central gate holds: a viewer's POST is watching, not acting —
    // proved on the bearer road, where no csrf ceremony sits in front.
    const denied = await fetch(url("/people/invite"), {
      method: "POST",
      headers: { authorization: "Bearer casey:casey-good-password", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "viewer", token: "x" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("watch, not act");
  });

  test("an approver mints from the People screen with their password, and the link page shows once", async () => {
    const cookie = await login("alex", approverToken);
    const csrf = await csrfOf(cookie);
    const people = await (await fetch(url("/people"), { headers: { cookie } })).text();
    expect(people).toContain("Invite someone");

    // Without the password, no invite.
    const refused = await fetch(url("/people/invite"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ role: "viewer", token: "", csrf }),
    });
    expect(refused.status).toBe(403);
    expect(store.openInvites(new Date())).toHaveLength(0);

    const minted = await fetch(url("/people/invite"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ role: "approver", token: approverToken, csrf }),
    });
    expect(minted.status).toBe(200);
    const html = await minted.text();
    expect(html).toContain("/join/");
    expect(html).toContain("Shown once");
    expect(store.openInvites(new Date())).toHaveLength(1);
    expect(store.openInvites(new Date())[0]?.role).toBe("approver");
  });

  test("a bearer credential never spends the signer's mode: the filing lands unapproved (surfaces round 1, finding 1)", async () => {
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.createTask({ id: "t-bearer", title: "the work" }, T0);
    store.placeTask(store.refFor("built-in", "t-bearer").id, REPO);
    const terms = { ...presetTerms("hands-off", later(24).toISOString()) };
    store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    const filed = await fetch(url("/t/t-bearer/scope"), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ goal: "guard the payout", acceptance: "c1: the payout is guarded | manual-review", sawDigest: "" }),
      redirect: "manual",
    });
    expect([200, 303]).toContain(filed.status);
    const scope = store.getScope("t-bearer");
    expect(scope?.goal).toBe("guard the payout");
    // Filed, yes — auto-sealed, never: the machine road cannot spend the mode.
    expect(scope?.approvedAt ?? null).toBeNull();
  });

  test("removing a person from the People screen is a password ceremony with the last-approver guard", async () => {
    const cookie = await login("alex", approverToken);
    const csrf = await csrfOf(cookie);
    const lastApprover = await fetch(url("/people/revoke"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "alex", token: approverToken, csrf }),
      redirect: "manual",
    });
    expect(lastApprover.status).toBe(409);

    const minted = store.mintInvite("viewer", "alex", new Date());
    const made = store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "casey", credentialHash: hashPassword("casey-good-password") }, new Date());
    if (!made.ok) throw new Error("seed casey");
    const severed = await fetch(url("/people/revoke"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "casey", token: approverToken, csrf }),
      redirect: "manual",
    });
    expect(severed.status).toBe(303);
    expect(store.accountFacts().find(one => one.name === "casey")?.revokedAt).not.toBeNull();
    // Their live session would die at its next lookup: the generation moved.
    expect(authenticateAccount(store, "casey", "casey-good-password")).toEqual({ ok: false, reason: "revoked" });
  });
});
