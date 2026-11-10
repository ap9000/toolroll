/**
 * Approving from chat (docs/plans/toolroll-cards.md): a person with the authority approves from their own chat, with no
 * password. Each case here tries a way around what makes that safe. Real store, the real confirm door.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withActor } from "./actor.js";
import { CHAT_ACTIONS, mintSharedActionReview, prepareSharedAction, sharedActionAllowsChallenge, sharedActionPayload, APPROVAL_ACTIONS } from "./chat-actions.js";
import { ALL_PROJECTS, setChatApproval } from "./chat-approval.js";
import { cardShowsScope, cardTermsDigest, chatLimitProblem, scopeTermsText, shownTermsDigest } from "./chat-terms.js";
import { checkAccessWords } from "./check-access.js";
import { YOUIYOUX_FILED_VIA } from "./contracts/youiyoux-request.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { ISSUE_IMPORT_FILED_VIA } from "./task-source.js";
import { executeLeadTool, LEAD_TOOL_SCHEMAS } from "./lead-tools.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { modeDigestOf, modeTermsJson, presetTerms, type ModeTerms } from "./modes.js";
import { fileTaskProposal } from "./proposal.js";
import { addApprover, approve, approvalProofOf, propose } from "./scope.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-11-07T09:00:00Z");
const words = (terms: string) => ({ expect: cardTermsDigest(terms), terms });

describe("approving from chat", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, thread: number, session: number;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chat-approve-")));
    repo = join(root, "shop");
    mkdirSync(repo);
    store = openStore(join(root, "orders.db"));
    if (!addApprover(store, "operator", now).ok) throw Error("account");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "approve", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
    thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
    const filed = fileTaskProposal(store, { id: "fix-1", title: "Fix the login page", repo, filedVia: "cli" }, now);
    if (!filed.ok) throw Error(filed.message);
    propose(store, { taskId: "fix-1", goal: "Fix the login page.", touches: ["src/login.ts"], acceptance: [{ id: "c1", statement: "Login works.", how: null, evidence: ["check"] }], now });
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** The lead drafts the card, as a model would: this is all a model can do. */
  function draft(): number {
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "approve", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const action = prepareSharedAction(store, who, "scope_approve", { task: "fix-1" }, root, now);
    const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...action }, ceilingDigest: who.ceilingDigest }, now)!;
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return id;
  }
  const tap = (id: number, yes = true) => confirmLeadProposal(store, who, id, now, { authority: "full", via: "slack", confirm: yes, evidenceRoot: root });
  const sealed = () => store.getScope("fix-1")?.approvedDigest ?? null;

  test("every approval says it needs no password, and each is protected: never a one-tap act", () => {
    for (const operation of APPROVAL_ACTIONS) expect(CHAT_ACTIONS[operation]).toMatchObject({ protected: true, password: false });
    expect(sharedActionAllowsChallenge(sharedActionPayload(store.getLeadProposal(draft())!.payload)!, "telegram")).toBe(true);
  });

  test("a term the card would show rewritten (a 40-hex value shown as [digest]) is never complete consent", () => {
    const card = sharedActionPayload(store.getLeadProposal(draft())!.payload)!;
    expect(sharedActionAllowsChallenge(card, "telegram")).toBe(true);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    // The same card with a term that carries a full commit or a key-like value: the card can't show it verbatim.
    expect(sharedActionAllowsChallenge({ ...card, terms: [...card.terms, `Deploy commit ${sha}`] }, "telegram")).toBe(false);
    expect(sharedActionAllowsChallenge({ ...card, terms: [...card.terms, `Token ${"ab".repeat(20)}`] }, "telegram")).toBe(false);
    // Written short, as Toolroll writes a commit, it shows exactly and stays a card the person can confirm.
    expect(sharedActionAllowsChallenge({ ...card, terms: [...card.terms, `Deploy commit ${sha.slice(0, 7)}`] }, "telegram")).toBe(true);
  });

  test("an approval is never a tap where the chat app would show its words changed: Teams always, Slack when a word becomes an emoji", () => {
    const id = draft(), card = sharedActionPayload(store.getLeadProposal(id)!.payload)!;
    for (const channel of ["telegram", "slack", "discord"] as const) expect(sharedActionAllowsChallenge(card, channel)).toBe(true);
    // Teams draws card text as Markdown: a link's label hides its address, so its card never shows the stored words.
    expect(sharedActionAllowsChallenge(card, "teams")).toBe(false);
    expect(sharedActionAllowsChallenge({ ...card, title: "Approve [the footer fix](https://example.test/and-the-header)" }, "teams")).toBe(false);
    // Slack turns `:name:` into a picture; the same words are plain text on Telegram.
    const emoji = { ...card, terms: [...card.terms, "Also :tada: the header"] };
    expect(sharedActionAllowsChallenge(emoji, "slack")).toBe(false);
    expect(sharedActionAllowsChallenge(emoji, "telegram")).toBe(true);
    // A workspace's own emoji can be named in any script; an address with a port is not an emoji.
    expect(sharedActionAllowsChallenge({ ...card, terms: [...card.terms, "Also :猫: the header"] }, "slack")).toBe(false);
    expect(sharedActionAllowsChallenge({ ...card, terms: [...card.terms, "See http://localhost:8080/a: the page"] }, "slack")).toBe(true);
    // The door reads the same rule from the chat app the tap came through: a yes sent through Teams seals nothing, and
    // the card stays for the review page.
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "teams", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(sealed()).toBeNull();
    expect(store.getLeadProposal(id)?.state).toBe("pending");
    // The same yes through Slack, where these words are shown as stored, approves.
    expect(tap(id)).toMatchObject({ ok: true });
  });

  test("a person's own second tap approves, recorded as that person, bound to these exact terms", () => {
    const id = draft();
    expect(tap(id, false)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(sealed()).toBeNull();
    expect(tap(id)).toMatchObject({ ok: true });
    const scope = store.getScope("fix-1")!;
    expect(scope).toMatchObject({ approvedBy: "operator", approvalBasis: "chat", approvedDigest: scope.digest });
    expect(approvalProofOf(store, "fix-1", "operator", scope.digest)?.method).toBe("chat");
  });

  test("a card is one use: a replayed tap changes nothing", () => {
    const id = draft();
    expect(tap(id)).toMatchObject({ ok: true });
    expect(tap(id)).toMatchObject({ ok: false, reason: "not-pending" });
  });

  test("changed terms refuse: a card can't approve what it didn't show", () => {
    const id = draft();
    propose(store, { taskId: "fix-1", goal: "Delete the login page.", touches: ["src/login.ts"], acceptance: [{ id: "c1", statement: "Gone.", how: null, evidence: ["check"] }], now });
    expect(tap(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(sealed()).toBeNull();
  });

  test("a model has no road: no tool confirms, drafting approves nothing, and a token on the web door is refused", () => {
    expect(LEAD_TOOL_SCHEMAS.map(one => one.name).filter(name => /confirm|approve$/.test(name))).toEqual([]);
    const id = draft();
    expect(sealed()).toBeNull();
    expect(executeLeadTool({ store, who, now, step: 1, readDecisions: new Map(), draft: () => null }, "offer_approval", { task: "fix-1" })).toMatchObject({ ok: true });
    expect(sealed()).toBeNull();
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", person: false, confirm: true, evidenceRoot: root, actionReview: { nonce: "x", password: "" } })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "cli", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(sealed()).toBeNull();
  });

  test("a machine acting can't use the chat road, whatever it holds", () => {
    const scope = store.getScope("fix-1")!;
    const result = withActor({ account: "operator", lead: true }, () => approve(store, "fix-1", "operator", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: words(scopeTermsText(scope)) }));
    expect(result).toMatchObject({ ok: false, reason: "machine-proof" });
    expect(sealed()).toBeNull();
  });

  test("the chat road proves the person's role and reach itself", () => {
    const scope = store.getScope("fix-1")!;
    expect(approve(store, "fix-1", "stranger", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: words("anything") })).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(sealed()).toBeNull();
  });

  test("a person's own off holds in their chat", () => {
    const id = draft();
    expect(setChatApproval(store, { approver: "operator", scope: ALL_PROJECTS, enabled: false, via: "test" }, now).ok).toBe(true);
    expect(tap(id)).toMatchObject({ ok: false });
    expect(sealed()).toBeNull();
  });

  test("a person's own off holds even under a mode they signed that lets chat approve", () => {
    const id = draft();
    expect(setChatApproval(store, { approver: "operator", scope: ALL_PROJECTS, enabled: false, via: "test" }, now).ok).toBe(true);
    const terms: ModeTerms = { ...presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString()), chatApprove: true, chatApproveChats: ["slack"], permissionDefault: "escalated" };
    store.signMode({ repo, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "operator", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
    expect(store.activeMode(repo, now)?.signedBy).toBe("operator");
    expect(tap(id)).toMatchObject({ ok: false, reason: "refused", said: "You turned off approving from chat for this project." });
    expect(sealed()).toBeNull();
  });

  test("terms a machine wrote seal only on a chat yes carrying the words a card showed; nothing automatic gets through", () => {
    store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = 'fix-1'").run();
    const digest = store.getScope("fix-1")!.digest;
    const shown = words(`Card\n${scopeTermsText(store.getScope("fix-1")!)}`);
    for (const basis of [{ kind: "chat" as const, modeDigest: "x" }, { kind: "chat" as const, modeDigest: "x", card: "shown" as const, cardDigest: "0".repeat(64), shownTerms: shown.terms },
      { kind: "chat" as const, modeDigest: "x", card: "terms" as const, cardDigest: shownTermsDigest(store.getScope("fix-1")!) }, { kind: "mode" as const, modeDigest: "x" }])
      expect(store.sealScopeApproval("fix-1", "operator", now, {}, basis, "person")).toBe(false);
    expect(sealed()).toBeNull();
    // A plain chat yes (the card showed less) doesn't open the wall either.
    expect(approve(store, "fix-1", "operator", now, digest, "", {}, undefined, { modeDigest: "x", shown: null })).toMatchObject({ ok: false });
    expect(sealed()).toBeNull();
    expect(approve(store, "fix-1", "operator", now, digest, "", {}, undefined, { modeDigest: "x", shown })).toMatchObject({ ok: true });
  });

  test("the digest is the one kept when the card was made: other words refuse, and so do words that drop a widening", () => {
    const scope = store.getScope("fix-1")!, whole = scopeTermsText(scope);
    const shown = words(whole);
    expect(approve(store, "fix-1", "operator", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: { expect: shown.expect, terms: "Work: Something else." } })).toMatchObject({ ok: false, reason: "changed" });
    expect(sealed()).toBeNull();
    // Check access and extra services on the scope: words that leave them out prove nothing.
    expect(cardShowsScope({ ...scope, profile: { ...scope.profile!, checkAccess: "sign-ins" } as never }, whole)).toBe(false);
    expect(cardShowsScope({ ...scope, profile: { ...scope.profile!, machLookup: ["com.apple.example"] } as never }, whole)).toBe(false);
    expect(cardShowsScope({ ...scope, profile: { ...scope.profile!, checkAccess: "sign-ins" } as never }, `${whole}\nchecks ${checkAccessWords("sign-ins")}`)).toBe(true);
  });

  test.each([["part of the terms", (whole: string) => whole.slice(0, 20)], ["terms from an earlier version", () => "earlier"], ["a matching digest over unrelated words", () => "Goal:\nSomething harmless."]])("an imported task isn't sealed by a card showing %s", (_name, words_) => {
    const earlier = scopeTermsText(store.getScope("fix-1")!);
    propose(store, { taskId: "fix-1", goal: "Fix the login page and send the keys elsewhere.", touches: ["src/login.ts"], acceptance: [{ id: "c1", statement: "Login works.", how: null, evidence: ["check"] }], now });
    const scope = store.getScope("fix-1")!;
    store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = 'fix-1'").run();
    expect(store.getScope("fix-1")!.digest).toBe(scope.digest);
    const shownTerms = words_(scopeTermsText(scope)) === "earlier" ? earlier : words_(scopeTermsText(scope));
    const card = words(shownTerms);
    // Machine-written, a youiyoux request, an imported issue: each wall holds against the same card.
    for (const filedVia of ["cli", YOUIYOUX_FILED_VIA, ISSUE_IMPORT_FILED_VIA]) {
      store.handle.prepare("UPDATE task_ref SET filed_via = ? WHERE external_id = 'fix-1'").run(filedVia);
      expect(store.sealScopeApproval("fix-1", "operator", now, {}, { kind: "chat", modeDigest: "x", card: "shown", cardDigest: card.expect, shownTerms }, "person")).toBe(false);
      expect(approve(store, "fix-1", "operator", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: card })).toMatchObject({ ok: false, reason: "changed" });
      expect(approve(store, "fix-1", "operator", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: null })).toMatchObject({ ok: false });
      expect(sealed()).toBeNull();
    }
  });

  test("the card keeps the digest of its own words, and a card made before the scope changed can't reach the new one", () => {
    const id = draft();
    const saved = sharedActionPayload(store.getLeadProposal(id)!.payload)!;
    expect(saved.state["shown"]).toBe(cardTermsDigest(saved.terms.join("\n")));
    expect(saved.terms.join("\n")).toContain(scopeTermsText(store.getScope("fix-1")!));
  });

  test("a person's saved limits hold on the card road, not only on the plan road", () => {
    const id = draft();
    expect(setChatApproval(store, { approver: "operator", scope: repo, enabled: true, limits: { fullAccess: false, capMicrousd: 1_000_000 }, via: "test" }, now).ok).toBe(true);
    expect(tap(id)).toMatchObject({ ok: false });
    expect(sealed()).toBeNull();
    expect(chatLimitProblem({ profile: null, budgetMicrousd: null }, { fullAccess: true, capMicrousd: 1 }, "your chat approval setting")).toContain("no attempt limit");
    expect(chatLimitProblem({ profile: { provider: "claude", permissionArgv: "bypassPermissions" } as never, budgetMicrousd: 1 }, { fullAccess: false, capMicrousd: null }, "your mode")).toContain("more access");
  });

  test("a person's off holds in web chat too, and each of the other approvals asks the same question", () => {
    const id = draft();
    expect(setChatApproval(store, { approver: "operator", scope: ALL_PROJECTS, enabled: false, via: "test" }, now).ok).toBe(true);
    const review = mintSharedActionReview(store, who, id, root, now);
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", person: true, confirm: true, evidenceRoot: root, actionReview: { nonce: review.nonce, password: "" } })).toMatchObject({ ok: false });
    expect(sealed()).toBeNull();
  });
});
