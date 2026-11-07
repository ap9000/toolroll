/** One password rule for every approve form (docs/plans/plain-toolroll.md P1.3): approvalPasswordField says what a
 * form shows, and on every row it agrees with approve() itself — a field that may be left empty approves with an empty
 * password; one that must be typed refuses without it. Rows: standard work, protected work, escalated terms, terms an
 * agent filed, nothing remembered, Passwordless on, and this computer's local owner. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, initLocalMode, type Store } from "./store.js";
import { addApprover, approve, freshFacts, propose, withFreshness, type FreshFacts } from "./scope.js";
import { asLocalOwner } from "./local-owner.js";
import { mintCoordinator } from "./coordinator.js";
import { approvalPasswordField } from "./approval-password.js";

const NOW = new Date();
const REPO = "/repos/approval-password";
let store: Store, password = "";

/** A remembered password on this session, a minute old (password-freshness.test.ts's session, on a live request). */
function remembered(name: string): FreshFacts {
  let passwordAt: number | null = Date.now() - 60_000;
  return { actor: name, local: true, allowlisted: true, live: () => true, passwordAt: () => passwordAt, ssoReauthAt: () => null, ssoNow: () => null,
    consumeSsoNow: () => () => {}, floor: () => 0, stamp: at => { passwordAt = at; } };
}
function filed(id: string, extra: { touches?: string[]; permissionMode?: "auto" | "bypassPermissions"; coordinator?: boolean } = {}) {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  if (extra.coordinator) {
    const lead = mintCoordinator(store, { name: `lead-${id}`, repos: [REPO], by: "alex", now: NOW });
    if (!lead.ok) throw new Error(lead.reason);
    store.raw().prepare("UPDATE task_ref SET coordinator_cid = ? WHERE id = ?").run(lead.cid, ref);
  }
  return propose(store, { taskId: id, goal: `Do ${id}`, touches: extra.touches ?? ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW,
    ...(extra.permissionMode === undefined ? {} : { permissionMode: extra.permissionMode }) });
}
/** What the form shows, and whether approve() takes an empty password, under the same facts. */
function both(id: string, facts: { fresh: boolean; passwordless?: boolean; local?: boolean }) {
  const scope = store.getScope(id)!;
  const field = approvalPasswordField(store, { name: "alex", taskId: id, scope, passwordless: facts.passwordless ?? false, localOwner: facts.local ?? false,
    freshAt: facts.fresh ? Date.now() - 60_000 : null, returnTo: `/t/${id}` });
  const empty = () => approve(store, id, "alex", NOW, scope.digest, "");
  const owner = { account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "browser" as const, act: "approve-plan" as const, sessionHash: null, request: null };
  const answer = facts.local ? asLocalOwner(owner, () => empty())
    : facts.fresh ? freshFacts.run(remembered("alex"), () => withFreshness("approve-standard", empty)) : empty();
  return { field: field.field, approvesEmpty: answer.ok };
}

beforeEach(() => {
  store = openStore(":memory:");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
});
afterEach(() => store.close());

describe("the form and approve() agree", () => {
  test("standard work with a remembered password: the field may be left empty, and an empty one approves", () => {
    filed("standard");
    expect(both("standard", { fresh: true })).toEqual({ field: "remembered", approvesEmpty: true });
  });

  test("nothing remembered: typed now, and an empty one is refused", () => {
    filed("nothing");
    expect(both("nothing", { fresh: false })).toEqual({ field: "required", approvesEmpty: false });
  });

  test("protected work, escalated terms and terms an agent filed: typed now, whatever is remembered", () => {
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, "alex", NOW);
    filed("protected", { touches: ["infra/main.tf"] });
    filed("escalated", { permissionMode: "bypassPermissions" });
    filed("by-agent", { coordinator: true });
    for (const id of ["protected", "escalated", "by-agent"]) expect(both(id, { fresh: true }), id).toEqual({ field: "required", approvesEmpty: false });
  });

  test("Passwordless on: no field (the session is the proof the approve road reads)", () => {
    filed("passwordless");
    expect(approvalPasswordField(store, { name: "alex", taskId: "passwordless", scope: store.getScope("passwordless")!, passwordless: true, localOwner: false, freshAt: null, returnTo: "/" }))
      .toEqual({ field: "none", why: "passwordless" });
  });
});

describe("this computer's local owner", () => {
  test("eligible work: no field, and the local owner's empty approval stands; ineligible work says where to go", () => {
    // A laptop install: local mode on for its owner, no password set.
    store.close();
    store = openStore(":memory:", { createdBy: "laptop" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok).toBe(true);
    filed("local-ok");
    filed("local-escalated", { permissionMode: "bypassPermissions" });
    expect(both("local-ok", { fresh: false, local: true })).toEqual({ field: "none", approvesEmpty: true });
    const refused = both("local-escalated", { fresh: false, local: true });
    expect(refused).toEqual({ field: "local-refused", approvesEmpty: false });
    expect(password).not.toBe("");
  });
});
