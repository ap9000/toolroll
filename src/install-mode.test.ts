/**
 * Solo or team (install-mode.ts): the mode is derived by the server, inside the act's own transaction, from the store
 * alone. Every way an install becomes multi-person flips it to team at that moment, in the act's transaction, and the
 * solo-only shortcut (a signed-in session standing in for the password at a step-up) is refused right after. An install
 * never drops back to solo silently; "It's just me" refuses while any live fact says team.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalMode, openStore, type Store } from "./store.js";
import { addApprover, approve, freshFacts, hashPassword, propose, proveAccountNow, type FreshFacts } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { mintCoordinator } from "./coordinator.js";
import { ChatCore } from "./chat-core.js";
import { fileTaskProposal } from "./proposal.js";
import { fastAcceptance, fastStartRules } from "./fast-start.js";
import { verifiedDatabaseBackup } from "./desktop-update.js";
import { approvalPasswordField } from "./approval-password.js";
import { declareJustMe, installModeNow, INSTALL_MODE_ACTION, justMeAllowed, sessionStandsIn, soloNow } from "./install-mode.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const REPO = "/home/me/app";
const PW = "alex-password-1";
const GATE = "00000000-0000-4000-8000-000000000166";
let store: Store;
const dirs: string[] = [];

/** A live browser session of `name` with no password remembered: under solo it is the proof; under team nothing. */
function liveSession(name = "alex"): FreshFacts {
  return { actor: name, local: true, allowlisted: false, live: () => true, passwordAt: () => null, ssoReauthAt: () => null, ssoNow: () => null,
    consumeSsoNow: () => () => {}, floor: () => 0, stamp: () => {} };
}
/** The solo-only shortcut: an empty password at a step-up, on the person's own live session. */
const shortcut = (name = "alex") => freshFacts.run(liveSession(name), () => proveAccountNow(store, name, "")).ok;

function setup(s: Store): Store {
  for (const phase of ["build", "plan", "review"] as const) s.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  return s;
}
/** A new install: its first account made through the first-account door, which records solo. */
function soloStore(file = ":memory:"): Store {
  const s = setup(openStore(file));
  expect(s.bootstrapApproverIfNone("alex", hashPassword(PW), NOW)).toEqual({ ok: true });
  return s;
}
function filed(id: string, touches: string[] = ["src/a.ts"]) {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  propose(store, { taskId: id, goal: `Do ${id}`, touches, acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
  expect(store.getScope(id)).not.toBeNull();
}
/** Approve with an empty password on the person's own live session: the real step-up road. */
const approveEmpty = (id: string, name = "alex") => freshFacts.run(liveSession(name), () => approve(store, id, name, NOW, store.getScope(id)!.digest, ""));
const later = (ms: number) => new Date(NOW.getTime() + ms);
const tokenFor = (account: string, by: string, access: "read" | "act" = "act") => {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account, name: `for ${account}`, secretHash: minted.hash, access, expiresAt: later(86_400_000).toISOString(), by }, NOW);
  return minted.id;
};
const chat = () => new ChatCore(store, "telegram");
/** A pairing through the real code path: the person mints a code, a chat-app member redeems it. */
function pair(member: string, approver = "alex"): number {
  const core = chat();
  core.savePairing({ hash: `code-${member}`, installation: "bot-1", approver, generation: store.accountOf(approver)!.generation, by: approver }, NOW);
  const done = core.consumePairing({ hash: `code-${member}`, installation: "bot-1", team: "t", app: "a", member, channel: `dm-${member}`, event: null }, NOW);
  if (!done.ok) throw new Error(done.reason);
  return done.binding.id;
}
/** The same act, in one transaction, then: team inside it, the shortcut refused inside it, and both again after it. */
function flipsInItsTransaction(act: () => void, fact: string): void {
  expect(soloNow(store)).toBe(true);
  expect(shortcut()).toBe(true);
  store.transact(() => {
    act();
    expect(installModeNow(store)).toMatchObject({ mode: "team" });
    expect(installModeNow(store).facts).toContain(fact);
    expect(shortcut()).toBe(false);
  });
  expect(installModeNow(store).facts).toContain(fact);
  expect(shortcut()).toBe(false);
  filed("after");
  expect(approveEmpty("after")).toEqual({ ok: false, reason: "not-an-approver" });
  expect(store.getScope("after")!.approvedAt).toBeNull();
}

beforeEach(() => { store = soloStore(); });
afterEach(() => { store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("what is solo", () => {
  test("a new install's first account is solo, recorded with who and when; the shortcut stands and approves", () => {
    expect(installModeNow(store)).toEqual({ mode: "solo", facts: [], declared: { by: "alex", at: NOW.toISOString(), why: "new-install" } });
    filed("one");
    expect(approveEmpty("one")).toMatchObject({ ok: true });
    // The form reads the same rule (approval-password.ts): no field.
    expect(approvalPasswordField(store, { name: "alex", taskId: "one", scope: store.getScope("one")!, passwordless: freshFacts.run(liveSession(), () => sessionStandsIn(store)), localOwner: false, freshAt: null, returnTo: "/" }))
      .toEqual({ field: "none", why: "passwordless" });
  });

  test("a laptop install's first account (local mode) is solo too", () => {
    const laptop = openStore(":memory:");
    expect(initLocalMode(laptop, { owner: "alex", fenceAvailable: true, now: NOW })).toMatchObject({ ok: true });
    expect(installModeNow(laptop)).toMatchObject({ mode: "solo", declared: { by: "alex", why: "new-install" } });
    laptop.close();
  });

  test("an install from before solo (no declaration) is team: nothing widens by itself", () => {
    const old = setup(openStore(":memory:"));
    const alex = addApprover(old, "alex", NOW);
    expect(alex.ok).toBe(true);
    expect(installModeNow(old)).toEqual({ mode: "team", facts: ["existing-install"], declared: null });
    const prior = store; store = old;
    try {
      expect(shortcut()).toBe(false);
      filed("old");
      expect(approveEmpty("old")).toEqual({ ok: false, reason: "not-an-approver" });
    } finally { store = prior; old.close(); }
  });

  test("the owner's own tokens, lead and coordinators keep solo (a token never approves); so does their own chat app", () => {
    tokenFor("alex", "alex");
    tokenFor("alex", "alex", "read");
    store.mintLeadCredential("alex", "alex", NOW);
    expect(mintCoordinator(store, { name: "ci", repos: [REPO], by: "alex", now: NOW }).ok).toBe(true);
    pair("alex-phone");
    // A phone is the same account: a second session and a push subscription add no one.
    expect(installModeNow(store)).toMatchObject({ mode: "solo", facts: [] });
  });

  test("anything unreadable is team", () => {
    expect(installModeNow({ handle: { prepare: () => { throw new Error("gone"); } } } as unknown as Store)).toEqual({ mode: "team", facts: ["unreadable"], declared: null });
    expect(sessionStandsIn({} as Store)).toBe(false);
  });
});

describe("every way an install becomes multi-person flips it to team in the act's transaction", () => {
  test("an invite accepted", () => {
    const invite = store.mintInvite("viewer", "alex", NOW);
    flipsInItsTransaction(() => {
      expect(store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "robin", credentialHash: hashPassword("robin-pw-1") }, NOW)).toEqual({ ok: true, role: "viewer" });
    }, "second-person");
  });

  test("a person added directly (the CLI's approver add, a saved account)", () => {
    flipsInItsTransaction(() => {
      expect(addApprover(store, "robin", NOW, { name: "alex", token: PW }).ok).toBe(true);
    }, "second-person");
  });

  test("an account an identity-provider sign-in made", () => {
    flipsInItsTransaction(() => {
      expect(store.signInWithSso({ issuer: "https://idp.example", subject: "s-1", email: null, label: "Okta" }, { role: "approver", projects: null }, () => "dana", NOW)).toMatchObject({ ok: true, created: true });
    }, "second-person");
  });

  test("an acting API token minted for someone else", () => {
    flipsInItsTransaction(() => { tokenFor("robin", "alex"); }, "token-for-someone-else");
  });

  test("a lead token for someone else", () => {
    flipsInItsTransaction(() => { store.mintLeadCredential("robin", "alex", NOW); }, "token-for-someone-else");
  });

  test("a token from an older version (carried into the credential table as it was minted then)", () => {
    flipsInItsTransaction(() => {
      store.handle.prepare(`INSERT INTO credential (id, kind, public_id, account, name, secret_hash, access, created_at, created_by, expires_at)
        VALUES ('legacy1', 'person', 'legacy1', 'alex', 'old ci', ?, 'act', ?, 'old-admin', ?)`).run("0".repeat(64), "2025-01-01T00:00:00.000Z", later(86_400_000).toISOString());
    }, "token-for-someone-else");
    // It is a live fact: "It's just me" refuses until it is revoked.
    expect(declareJustMe(store, "alex", NOW)).toEqual({ ok: false, reason: "team", facts: ["token-for-someone-else"] });
  });

  test("a second person in a chat app with authority", () => {
    const own = pair("alex-phone");
    chat().revokeBinding({ id: own }, NOW, "alex");
    flipsInItsTransaction(() => { pair("robin-phone"); }, "chat-person-added");
  });

  test("a chat group following the install", () => {
    const binding = pair("alex-phone");
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO team_conversation (id, lead, title, visibility, projects_json, thread, created_by, created_at) VALUES ('c1', 'l1', 'Team', 'team', '[]', 1, 'alex', ?)").run(NOW.toISOString());
    store.handle.exec("PRAGMA foreign_keys = ON");
    flipsInItsTransaction(() => {
      expect(chat().bindRoom({ installation: "bot-1", chat: "group-1", kind: "group", conversation: "c1", by: "alex", binding }, NOW).ok).toBe(true);
    }, "chat-group");
  });

  test("a restored backup with two people is team, whatever it says about itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-install-mode-")); dirs.push(dir);
    const file = join(dir, "toolroll.db");
    const live = soloStore(file);
    live.saveApprover("robin", hashPassword("robin-pw-1"), NOW);
    // A declaration that claims solo over both people (an edited or foreign backup) is not believed either.
    live.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: INSTALL_MODE_ACTION, outcome: "solo", source: "access",
      detail: JSON.stringify({ v: 1, people: 2, tokens: 0, chat: 0, groups: 0, why: "just-me" }) });
    live.close();
    const backup = join(dir, "backup.db");
    await verifiedDatabaseBackup(file, backup, GATE);
    const restored = join(dir, "restored.db");
    copyFileSync(backup, restored);
    const opened = openStore(restored);
    try {
      expect(installModeNow(opened)).toMatchObject({ mode: "team", facts: ["second-person"] });
      expect(declareJustMe(opened, "alex", NOW)).toEqual({ ok: false, reason: "team", facts: ["second-person"] });
    } finally { opened.close(); }
  });

  test("an act that rolls back leaves solo: the flip is the act's own row", () => {
    const undo = new Error("undo");
    expect(() => store.transact(() => { store.saveApprover("robin", hashPassword("robin-pw-1"), NOW); expect(soloNow(store)).toBe(false); throw undo; })).toThrow(undo);
    expect(soloNow(store)).toBe(true);
  });
});

describe("never back to solo silently", () => {
  test("a second person removed leaves the install team; only It's just me returns it, recorded", () => {
    expect(addApprover(store, "robin", NOW, { name: "alex", token: PW }).ok).toBe(true);
    store.revokeAccount("robin", "alex", NOW);
    expect(installModeNow(store)).toMatchObject({ mode: "team", facts: ["person-added"] });
    expect(shortcut()).toBe(false);
    expect(justMeAllowed(installModeNow(store))).toBe(true);
    expect(declareJustMe(store, "alex", later(1000))).toEqual({ ok: true });
    expect(installModeNow(store)).toEqual({ mode: "solo", facts: [], declared: { by: "alex", at: later(1000).toISOString(), why: "just-me" } });
    expect(shortcut()).toBe(true);
  });

  test("a token for someone else, revoked, keeps team until It's just me", () => {
    const id = tokenFor("robin", "alex");
    store.revokeApiToken(id, "alex", NOW, "done");
    expect(installModeNow(store)).toMatchObject({ mode: "team", facts: ["token-added"] });
  });
});

describe("It's just me", () => {
  test("refuses while any live fact says team, names each, and writes nothing", () => {
    expect(addApprover(store, "robin", NOW, { name: "alex", token: PW }).ok).toBe(true);
    tokenFor("sam", "alex");
    const before = store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(INSTALL_MODE_ACTION)!["n"];
    expect(declareJustMe(store, "alex", NOW)).toEqual({ ok: false, reason: "team", facts: ["second-person", "token-for-someone-else"] });
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(INSTALL_MODE_ACTION)!["n"]).toBe(before);
    expect(justMeAllowed(installModeNow(store))).toBe(false);
  });

  test("an existing single-person install switches, once, recorded; only its instance operator may", () => {
    const old = setup(openStore(":memory:"));
    expect(addApprover(old, "alex", NOW).ok).toBe(true);
    expect(declareJustMe(old, "nobody", NOW)).toEqual({ ok: false, reason: "not-owner", facts: [] });
    expect(declareJustMe(old, "alex", NOW)).toEqual({ ok: true });
    expect(declareJustMe(old, "alex", NOW)).toEqual({ ok: false, reason: "already-solo", facts: [] });
    expect(old.handle.prepare("SELECT actor, outcome, source FROM action_ledger WHERE action = ?").all(INSTALL_MODE_ACTION)).toEqual([{ actor: "alex", outcome: "solo", source: "access" }]);
    old.close();
  });

  test("a declaration that isn't exactly the store's own shape is not believed", () => {
    const old = setup(openStore(":memory:"));
    expect(addApprover(old, "alex", NOW).ok).toBe(true);
    const forge = (over: Record<string, unknown>, detail: unknown = { v: 1, people: 1, tokens: 0, chat: 0, groups: 0, why: "just-me" }) =>
      old.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: INSTALL_MODE_ACTION, outcome: "solo", source: "access", detail: typeof detail === "string" ? detail : JSON.stringify(detail), ...over });
    for (const [over, detail] of [
      [{ source: "request" }, undefined], [{ repo: REPO }, undefined], [{ outcome: "team" }, undefined],
      [{}, "solo"], [{}, { v: 2, people: 1, tokens: 0, chat: 0, groups: 0, why: "just-me" }], [{}, { v: 1, people: 1, tokens: 0, chat: 0, why: "just-me" }],
      [{}, { v: 1, people: -1, tokens: 0, chat: 0, groups: 0, why: "just-me" }], [{}, { v: 1, people: 1, tokens: 0, chat: 0, groups: 0, why: "header" }],
    ] as [Record<string, unknown>, unknown][]) {
      forge(over, detail);
      expect(installModeNow(old).mode, JSON.stringify([over, detail])).toBe("team");
    }
    old.close();
  });
});

describe("solo never skips team rules", () => {
  test("the race: a second person added after the page read solo, before the press: the press refuses", () => {
    filed("raced");
    // What the page read when it drew the form: solo, no password field.
    const drawn = freshFacts.run(liveSession(), () => sessionStandsIn(store));
    expect(drawn).toBe(true);
    // Meanwhile someone joins.
    store.saveApprover("robin", hashPassword("robin-pw-1"), NOW);
    // The press: approve() derives the mode again inside its own transaction.
    expect(approveEmpty("raced")).toEqual({ ok: false, reason: "not-an-approver" });
    expect(store.getScope("raced")!.approvedAt).toBeNull();
    // A typed password still approves under team rules.
    expect(approve(store, "raced", "alex", NOW, store.getScope("raced")!.digest, PW)).toMatchObject({ ok: true });
  });

  test("protected work still needs its approvals: no small-task start, and one person's yes is one vote", () => {
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", NOW);
    const title = "Fix the typo in the footer";
    const sizing = { size: "small" as const, risky: false, source: "classifier" as const, reason: "one word" };
    const made = fileTaskProposal(store, { id: "task-protected", title, repo: REPO, goal: title, acceptance: fastAcceptance(title), planning: "skip", sizing, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
    expect(made.ok).toBe(true);
    expect(soloNow(store)).toBe(true);
    expect(fastStartRules(store, { actor: "alex", repo: REPO, title, taskId: "task-protected", sizing, proof: { password: { passwordless: true, localOwner: false, freshAt: null, returnTo: "/" } } }, NOW))
      .toEqual({ ok: false, reason: "protected" });
    approveEmpty("task-protected");
    expect(store.getScope("task-protected")!.approvedAt).toBeNull();
  });

  test("a credential act never takes the session, solo or not", () => {
    expect(freshFacts.run(liveSession(), () => proveAccountNow(store, "alex", "", { credential: true }))).toEqual({ ok: false, reason: "not-an-approver" });
  });

  test("the mode reads nothing but the store: no argument can claim solo", () => {
    expect(installModeNow.length).toBe(1);
    expect(soloNow.length).toBe(1);
    expect(sessionStandsIn.length).toBe(1);
  });
});
