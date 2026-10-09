/**
 * One chat core, four apps: pairing, approvals and notifications work the same on Telegram, Slack, Discord and Teams.
 * Each contract runs against every app through its own entry points (test/chat-providers.ts): Telegram's bridge, and
 * Slack's, Discord's and Teams' receive, process, plan and deliver. Fixture APIs only: no live account acceptance.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { ChatCore } from "./chat-core.js";
import { chatApproveMode } from "./chat-decide.js";
import { CHAT_APPROVE_ALL, modeDigestOf, modeTermsFromJson, modeTermsJson, modeWords, presetTerms, type ModeTerms } from "./modes.js";
import { CHAT_PROVIDERS, type ChatProvider } from "./contracts/chat-tables.js";
import { CHAT_HARNESSES, type ChatCard, type ChatHarness, type ChatWorld } from "../test/chat-providers.js";

const T0 = new Date("2026-10-08T09:00:00.000Z");
const REPO = "/projects/alpha";
const RUNNER = "worker-1";

let dir: string;
let store: Store;
let now: Date;
let alexToken = "";
const merges: Array<{ runId: number; by: string }> = [];
const world = (): ChatWorld => ({ store, clock: () => now, evidenceRoot: dir, projects: () => [REPO], origin: "https://console.example",
  merge: async input => { merges.push(input); return { ok: true }; } });
const later = (ms: number) => { now = new Date(now.getTime() + ms); };
const live = (provider: ChatProvider, installation: string) => new ChatCore(store, provider).liveBindings(installation);
const who = (name: string) => {
  const verified = verifyApproverStanding(store, name, store.accountOf(name)!.generation, [REPO]);
  if (!verified.ok) throw new Error("approver fixture");
  return verified.who;
};
const placed = (id: string, title: string) => {
  store.createTask({ id, title }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, now);
  return ref;
};
/** A built, checked result waiting to be finished (its Ready notification is the store's own). */
const readyResult = (id: string, title: string) => {
  const ref = placed(id, title);
  propose(store, { taskId: id, goal: title, touches: ["src/guard.ts"], acceptance: [{ id: "c1", statement: "The guard stays readable.", how: null, evidence: ["check"] }], now });
  expect(approve(store, id, "alex", now, store.getScope(id)!.digest, alexToken).ok).toBe(true);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route fixture");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: RUNNER, branch: `so/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The guard reads well." });
  store.finishRun(run, { outcome: "built", committed: true, now });
  store.setTaskState(id, "done", now);
  store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", statement: "The guard stays readable.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, now);
  storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", now, { captureStatus: "ok" });
  sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
  mkdirSync(join(dir, String(run)), { recursive: true });
  const patch = Buffer.from("diff --git a/src/guard.ts b/src/guard.ts\n+guard\n", "utf8");
  writeFileSync(join(dir, String(run), "terminal-diff.patch"), patch);
  store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false,
    sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, now);
  return { ref, run };
};
const assignment = (id: string) => assignmentOf(store, id, now, { principal: "operator", repos: [REPO] }, dir);
/** A failed task whose attention notice asks for a person. */
const failed = (id: string, title: string) => {
  const ref = placed(id, title);
  store.setTaskState(id, "failed", now);
  store.enqueueNotification({ dedupeKey: `exhausted:${id}`, kind: "attempts-exhausted", pushClass: "attention", subject: `${id} stalled after 3 straight failures`,
    body: "The last attempt failed its checks.", source: { taskRef: ref } }, now);
  return ref;
};
const cardWith = (h: ChatHarness, member: string, label: RegExp): ChatCard => {
  const card = [...h.cards(member)].reverse().find(one => one.buttons.some(button => label.test(button.label) && button.token !== undefined));
  if (card === undefined) throw new Error(`${h.provider}: no card with ${label} in ${JSON.stringify(h.cards(member))}`);
  return card;
};
const current = (h: ChatHarness, member: string, message: string): ChatCard => h.cards(member).find(one => one.message === message)!;
const labels = (card: ChatCard) => card.buttons.map(one => one.url === undefined ? one.label : `${one.label} ↗`);
const pair = async (h: ChatHarness, person: string, member: string) => {
  h.sendPair(h.mint(person), member);
  await h.pass();
  expect(live(h.provider, h.installation).map(one => [one.approver, one.member])).toContainEqual([person, member]);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-chat-core-"));
  store = openStore(join(dir, "orders.db"));
  now = T0;
  merges.length = 0;
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now);
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now, newToken: () => `tok-${RUNNER}` });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe.each(CHAT_PROVIDERS)("the shared chat core on %s", provider => {
  let h: ChatHarness;
  beforeEach(() => { h = CHAT_HARNESSES[provider](world()); });

  test("pairing: a code from settings pairs one person's own chat once; a replayed message, a spent or wrong code, or a second account never pair", async () => {
    const [m0, m1, m2] = [h.member(0), h.member(1), h.member(2)];
    const code = h.mint("alex");
    h.sendPair(code, m0);
    await h.pass();
    expect(live(provider, h.installation).map(one => [one.provider, one.approver, one.member, one.channel])).toEqual([[provider, "alex", m0, h.chatOf(m0)]]);
    expect(h.cards(m0)).toHaveLength(1);
    // The app delivering the very same message again pairs nothing twice and says nothing twice.
    h.redeliver();
    await h.pass();
    expect(live(provider, h.installation)).toHaveLength(1);
    expect(h.cards(m0)).toHaveLength(1);
    // The spent code, a code nobody minted, and a second account for the same person all get silence.
    h.sendPair(code, m1);
    h.sendPair("0".repeat(32), m1);
    h.sendPair(h.mint("alex"), m1);
    await h.pass();
    expect(live(provider, h.installation).map(one => one.member)).toEqual([m0]);
    expect(h.cards(m1)).toEqual([]);
    // A teammate pairs their own chat; a newer code replaces their older one.
    const older = h.mint("sam");
    const newer = h.mint("sam");
    h.sendPair(older, m2);
    await h.pass();
    expect(live(provider, h.installation).map(one => one.approver)).toEqual(["alex"]);
    h.sendPair(newer, m2);
    await h.pass();
    expect(live(provider, h.installation).map(one => one.approver)).toEqual(["alex", "sam"]);
  });

  test("rotation and revocation: a password change ends the pairing in every app and strands its codes; unpairing ends the chat's buttons", async () => {
    const [m0, m1] = [h.member(0), h.member(1)];
    await pair(h, "alex", m0);
    const outstanding = h.mint("alex");
    store.saveApprover("alex", "rotated-credential-hash", now);
    expect(live(provider, h.installation)).toEqual([]);
    h.sendPair(outstanding, m1);
    await h.pass();
    expect(live(provider, h.installation)).toEqual([]);
    // A fresh code after the rotation pairs again.
    await pair(h, "alex", m0);
    // A card's buttons stop working once the chat is unpaired.
    failed("payout-1", "Guard the payout path");
    await h.pass();
    const card = cardWith(h, m0, /^Retry$/);
    const chat = new ChatCore(store, provider);
    for (const binding of chat.liveBindings(h.installation)) chat.revokeBinding(binding, now, "alex");
    h.tap(card, /^Retry$/, m0);
    await h.pass();
    expect(store.getTask("payout-1")?.state).toBe("failed");
    expect(current(h, m0, card.message)).toEqual(card);
  });

  test("approvals: a Ready result accepts and finishes in two taps bound to the exact result; Cancel restores the card and a spent Yes does nothing", async () => {
    const m0 = h.member(0);
    await pair(h, "alex", m0);
    readyResult("guard-1", "Keep the guard readable");
    await h.pass();
    const card = cardWith(h, m0, /^Accept and finish$/);
    expect(card.text).toContain("Keep the guard readable");
    expect(labels(card)).toEqual(["Accept and finish", "Request changes", "Look first ↗"]);
    // Opaque one-time tokens only: no task, run or digest rides a button.
    for (const button of card.buttons) if (button.token !== undefined) expect(button.token).toMatch(/^d:[0-9a-f]{24}$/);

    h.tap(card, /^Accept and finish$/, m0);
    await h.pass();
    const armed = current(h, m0, card.message);
    expect(armed.text).toContain('Accept and finish "Keep the guard readable"?');
    expect(labels(armed)).toEqual(["Yes", "Cancel"]);
    expect(assignment("guard-1")?.state).toBe("ready-to-check");

    h.tap(armed, /^Cancel$/, m0);
    await h.pass();
    const restored = current(h, m0, card.message);
    expect(labels(restored)).toEqual(["Accept and finish", "Request changes", "Look first ↗"]);
    // The Yes that Cancel replaced is spent.
    h.tap(armed, /^Yes$/, m0);
    await h.pass();
    expect(assignment("guard-1")?.state).toBe("ready-to-check");

    h.tap(restored, /^Accept and finish$/, m0);
    await h.pass();
    const yes = current(h, m0, card.message);
    h.tap(yes, /^Yes$/, m0);
    await h.pass();
    expect(assignment("guard-1")).toMatchObject({ state: "complete", completion: { actor: "operator:alex" } });
    const finished = current(h, m0, card.message);
    expect(finished.text).toContain("✓ Accepted and finished.");
    expect(finished.buttons).toEqual([]);
    // A repeated Yes does nothing more.
    h.tap(yes, /^Yes$/, m0);
    await h.pass();
    expect(current(h, m0, card.message)).toEqual(finished);
  });

  test("approvals: a stale card says so and acts on nothing, and a button is its own person's", async () => {
    const [m0, m1] = [h.member(0), h.member(1)];
    await pair(h, "alex", m0);
    await pair(h, "sam", m1);
    readyResult("guard-2", "Keep the guard readable");
    await h.pass();
    const card = cardWith(h, m0, /^Accept and finish$/);
    // Sam taps alex's button from sam's own chat: it isn't sam's, and nothing happens.
    const accept = card.buttons.find(one => one.label === "Accept and finish")!;
    h.tapToken(accept.token!, card.message, m1, accept.action);
    await h.pass();
    expect(current(h, m0, card.message)).toEqual(card);
    // Armed in chat, then finished on the console: the Yes acts on nothing and the card says why.
    h.tap(card, /^Accept and finish$/, m0);
    await h.pass();
    const armed = current(h, m0, card.message);
    expect(checkAssignmentAsOperator(store, "guard-2", assignment("guard-2")!.receipt!.digest, who("sam"), now, dir).ok).toBe(true);
    h.tap(armed, /^Yes$/, m0);
    await h.pass();
    const stale = current(h, m0, card.message);
    expect(stale.text).toContain("This task is already finished. Nothing was done.");
    expect(labels(stale)).toEqual(["Look first ↗"]);
    expect(store.settledBy(store.refFor("built-in", "guard-2").id)).toBe("sam");
  });

  test("approvals: Request changes asks what should change, and the person's next message becomes the revision's feedback", async () => {
    const m0 = h.member(0);
    await pair(h, "alex", m0);
    const { run } = readyResult("guard-3", "Keep the guard readable");
    await h.pass();
    const card = cardWith(h, m0, /^Request changes$/);
    h.tap(card, /^Request changes$/, m0);
    await h.pass();
    expect(h.cards(m0).at(-1)!.text).toContain('What should change? Your next message is the feedback for "Keep the guard readable".');
    h.say("Rename the helper to guardPayout.", m0);
    await h.pass();
    expect(h.cards(m0).at(-1)!.text).toContain('Changes requested for "Keep the guard readable"');
    const family = store.taskFamilyOf("guard-3", [REPO], false)!;
    expect(family.current.id).not.toBe("guard-3");
    expect(store.allDiffComments(run).map(one => ({ note: one.note, author: one.author }))).toEqual([{ note: "Rename the helper to guardPayout.", author: "alex" }]);
  });

  test("notifications: an attention fact reaches the paired chat once; a failed send waits and is retried, and arrives once", async () => {
    const m0 = h.member(0);
    await pair(h, "alex", m0);
    failed("payout-2", "Guard the payout path");
    h.failSends(1);
    await h.pass();
    const first = h.cards(m0).length;
    later(10 * 60_000);
    await h.pass();
    later(10 * 60_000);
    await h.pass();
    // What failed went out on a later pass; every message went out once (a resend would be a second message).
    expect(h.cards(m0).length).toBeGreaterThan(first);
    expect(h.posted(m0)).toBe(h.cards(m0).length);
    const delivered = h.cards(m0).filter(one => one.buttons.some(button => button.label === "Retry"));
    expect(delivered).toHaveLength(1);
    // Retry is the same two taps here as anywhere.
    h.tap(delivered[0]!, /^Retry$/, m0);
    await h.pass();
    expect(current(h, m0, delivered[0]!.message).text).toContain('Retry "Guard the payout path"? It queues another attempt.');
    h.tap(current(h, m0, delivered[0]!.message), /^Yes$/, m0);
    await h.pass();
    expect(store.getTask("payout-2")?.state).toBe("queued");
  });
});

describe.each(CHAT_PROVIDERS)("notices from before pairing on %s", provider => {
  test("an attention notice from before a person paired reaches them once they pair, a teammate pairing later too; routine history does not", async () => {
    const h = CHAT_HARNESSES[provider](world());
    const m0 = h.member(0), m1 = h.member(1);
    failed("early-1", "Guard the refund path");
    store.enqueueNotification({ dedupeKey: "early-note", kind: "merge", subject: "Merged before pairing", body: "Old news from before pairing.", recipient: "alex" }, now);
    later(60_000);
    await pair(h, "alex", m0);
    await h.pass();
    const retry = (member: string) => h.cards(member).filter(card => card.buttons.some(button => button.label === "Retry"));
    expect(retry(m0)).toHaveLength(1);
    expect(h.cards(m0).some(card => card.text.includes("Old news from before pairing"))).toBe(false);
    // Sam pairs after the worker already passed that notice for Alex: it still reaches Sam, once.
    later(60_000);
    await pair(h, "sam", m1);
    await h.pass();
    await h.pass();
    expect(retry(m1)).toHaveLength(1);
    expect(retry(m0)).toHaveLength(1);
    expect(h.posted(m1)).toBe(h.cards(m1).length);
  });
});

describe("every app at once", () => {
  test("each app pairs, delivers and retries on its own: one app failing doesn't hold the others, and nobody gets a message twice", async () => {
    const harnesses = CHAT_PROVIDERS.map(provider => CHAT_HARNESSES[provider](world()));
    for (const h of harnesses) await pair(h, "alex", h.member(0));
    // The same person, the same ids, four apps: each sees only its own pairing.
    for (const h of harnesses) expect(new ChatCore(store, h.provider).liveBindings(h.installation).map(one => one.provider)).toEqual([h.provider]);
    const slack = harnesses.find(h => h.provider === "slack")!;
    failed("payout-3", "Guard the payout path");
    slack.failSends(50);
    for (const h of harnesses) await h.pass();
    const got = (h: ChatHarness) => h.cards(h.member(0)).filter(one => one.buttons.some(button => button.label === "Retry")).length;
    expect(Object.fromEntries(harnesses.map(h => [h.provider, got(h)]))).toEqual({ telegram: 1, slack: 0, discord: 1, teams: 1 });
    slack.failSends(0);
    for (let round = 0; round < 3; round++) {
      later(10 * 60_000);
      for (const h of harnesses) await h.pass();
    }
    expect(Object.fromEntries(harnesses.map(h => [h.provider, got(h)]))).toEqual({ telegram: 1, slack: 1, discord: 1, teams: 1 });
  });

  test("a chat query that doesn't name its provider is refused before it runs", () => {
    const chat = new ChatCore(store, "slack");
    expect(() => chat.prepare("SELECT * FROM chat_binding")).toThrow("a chat query must name its provider");
    expect(chat.prepare("SELECT COUNT(*) AS n FROM chat_binding WHERE provider = :provider").get()).toEqual({ n: 0 });
  });
});

describe("c1: approving from chat follows the chat apps the signed mode names", () => {
  const sign = (terms: ModeTerms) =>
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
  const planWaiting = (id: string, title: string) => {
    const ref = placed(id, title);
    propose(store, { taskId: id, goal: title, touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    store.enqueueNotification({ dedupeKey: `plan-ready:${id}`, kind: "plan-ready", subject: `${id}: plan ready for review`, body: "Review and approve it.", source: { taskRef: ref } }, now);
  };
  const approveButtons = (h: ChatHarness) => h.cards(h.member(0)).filter(card => card.buttons.some(button => button.label === "Approve & start" && button.token !== undefined));
  const approved = (id: string) => { const scope = store.getScope(id)!; return scope.approvedDigest === scope.digest; };

  test("an existing Telegram-only grant approves on Telegram, and never on Slack, Discord or Teams until a new signature names them", async () => {
    const harnesses = CHAT_PROVIDERS.map(provider => CHAT_HARNESSES[provider](world()));
    const [telegram, ...others] = harnesses;
    for (const h of harnesses) await pair(h, "alex", h.member(0));
    // The grant exactly as earlier builds signed it: chatApprove, no apps named, its words naming Telegram.
    const legacy: ModeTerms = { ...presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString()), chatApprove: true };
    expect(JSON.parse(modeTermsJson(legacy))).not.toHaveProperty("chatApproveChats");
    expect(modeWords(legacy).join("\n")).toContain("your paired Telegram chat may approve this repository's plans");
    const legacyMode = sign(legacy);
    expect(modeTermsFromJson(store.activeMode(REPO, now)!.termsJson)).toEqual(legacy);
    expect(Object.fromEntries(CHAT_PROVIDERS.map(provider => [provider, chatApproveMode(store, REPO, "alex", now, provider)]))).toEqual({
      telegram: { ok: true, digest: store.activeMode(REPO, now)!.digest, limits: { fullAccess: false, capMicrousd: null }, source: "mode" },
      slack: { ok: false, why: "Your mode approves from Telegram only. Sign it again to approve from Slack." },
      discord: { ok: false, why: "Your mode approves from Telegram only. Sign it again to approve from Discord." },
      teams: { ok: false, why: "Your mode approves from Telegram only. Sign it again to approve from Teams." },
    });
    expect(legacyMode).toBeGreaterThan(0);

    // Offered: only Telegram's card carries Approve & start; the others keep their link to the console.
    planWaiting("plan-1", "Refuse over-limit payouts");
    for (const h of harnesses) await h.pass();
    expect(Object.fromEntries(harnesses.map(h => [h.provider, approveButtons(h).length]))).toEqual({ telegram: 1, slack: 0, discord: 0, teams: 0 });
    for (const h of others) expect(h.cards(h.member(0)).some(card => card.text.includes("Refuse over-limit payouts"))).toBe(true);

    // Executed: a Yes armed on Slack, Discord or Teams under a broader signature does nothing once the grant is Telegram-only again.
    sign({ ...legacy, chatApproveChats: CHAT_APPROVE_ALL });
    later(3 * 60_000);
    planWaiting("plan-2", "Log refused payouts");
    for (const h of harnesses) await h.pass();
    const armed = others.map(h => {
      const card = approveButtons(h).find(one => one.text.includes("Log refused payouts"))!;
      h.tap(card, /^Approve & start$/, h.member(0));
      return { h, message: card.message };
    });
    for (const { h } of armed) await h.pass();
    sign(legacy);
    for (const { h, message } of armed) {
      h.tap(current(h, h.member(0), message), /^Yes$/, h.member(0));
      await h.pass();
      expect(approved("plan-2"), h.provider).toBe(false);
      expect(current(h, h.member(0), message).text, h.provider).toContain("Your mode approves from Telegram only. Sign it again to approve from");
    }
    // Telegram's own two taps still approve under that same grant.
    const card = approveButtons(telegram!).find(one => one.text.includes("Refuse over-limit payouts"))!;
    telegram!.tap(card, /^Approve & start$/, telegram!.member(0));
    await telegram!.pass();
    telegram!.tap(current(telegram!, telegram!.member(0), card.message), /^Yes$/, telegram!.member(0));
    await telegram!.pass();
    expect(approved("plan-1")).toBe(true);

    // Renewed consent: a signature naming the apps (and saying so) approves on each of them, two taps each.
    const renewed: ModeTerms = { ...legacy, chatApproveChats: CHAT_APPROVE_ALL };
    expect(modeWords(renewed).join("\n")).toContain("your paired Telegram, Slack, Discord or Teams chat may approve this repository's plans");
    sign(renewed);
    for (const [index, h] of others.entries()) {
      later(3 * 60_000);
      const id = `plan-${3 + index}`;
      planWaiting(id, `Guard payouts ${index}`);
      for (const one of harnesses) await one.pass();
      const offer = approveButtons(h).find(one => one.text.includes(`Guard payouts ${index}`))!;
      h.tap(offer, /^Approve & start$/, h.member(0));
      await h.pass();
      h.tap(current(h, h.member(0), offer.message), /^Yes$/, h.member(0));
      await h.pass();
      expect(approved(id), h.provider).toBe(true);
    }
  });
});
