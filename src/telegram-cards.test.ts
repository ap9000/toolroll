/**
 * Telegram decision cards as the phone gets them: a parked decision, a plan, a result, a failed task, a pull request,
 * a lead's proposal, a flow approval and a flow choice, each sent through the bridge against a scripted Bot API, then
 * tapped. Every card leads with what to do and what it does; the old buttons' data keeps its forms and limits; and
 * what a tap records is unchanged. Fixture transport, not a phone: nothing here is a live Telegram proof.
 *
 * With TELEGRAM_CARDS_OUT set to a file, every card state seen here is also written there (text and button rows,
 * tokens masked) for a before/after review.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf } from "./assignment.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";
import { modeDigestOf, modeTermsJson, presetTerms, type ModeTerms } from "./modes.js";
import { advanceFlows } from "./flow-engine.js";
import { flowFromSteps } from "./flows.js";
import { mintCardTokens, proposalPreview } from "./telegram-lead.js";
import { subscriptionCredentialKey } from "./converse.js";
import { TEXT_LIMITS } from "./text-limits.js";
import { readTelegramButtonData } from "./contracts/telegram-callback.js";
import { scriptedTelegram, type ScriptButton } from "../test/telegram-script.js";

const T0 = new Date("2026-10-03T09:00:00.000Z");
const BOT = "777000";
const ALEX = 4242;
const BOB = 5353;
const REPO = "/projects/alpha";
const ORIGIN = "https://console.example";
const RUNNER = "worker-1";

/** Every callback form a Toolroll card has ever sent: decide tokens, decision/flow/choice/proposal tokens. */
const CALLBACK_FORMS = [/^d:[0-9a-f]{24}$/, /^[0-9a-f]{32}$/];

type Captured = { family: string; state: string; text: string; rows: { label: string; kind: "tap" | "link"; data: string }[][] };
const captured: Captured[] = [];
const masked = (data: string) => data.replace(/[0-9a-f]{24,}/g, hex => `<${hex.length} hex>`);
function capture(family: string, state: string, text: string, rows: ScriptButton[][]): void {
  captured.push({ family, state, text, rows: rows.map(row => row.map(one => one.url !== undefined
    ? { label: one.text, kind: "link" as const, data: one.url } : { label: one.text, kind: "tap" as const, data: masked(one.callback_data ?? "") })) });
}
afterAll(() => {
  const out = process.env["TELEGRAM_CARDS_OUT"];
  if (out === undefined || out === "") return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(captured, null, 2)}\n`);
});

/** Telegram's own limits, for every card state: text, and each button's data in a form Toolroll reads back. */
function withinTelegram(text: string, rows: ScriptButton[][]): void {
  expect(text.length).toBeLessThanOrEqual(4096);
  for (const one of rows.flat()) {
    if (one.url !== undefined) { expect(one.url.startsWith(`${ORIGIN}/`) || one.url.startsWith("https://")).toBe(true); continue; }
    const data = one.callback_data!;
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TEXT_LIMITS.telegramCallbackDataBytes);
    expect(readTelegramButtonData(data).ok).toBe(true);
    expect(CALLBACK_FORMS.some(form => form.test(data))).toBe(true);
  }
}

let dir: string;
let store: Store;
let now: Date;
let alexToken = "";
let script: ReturnType<typeof scriptedTelegram>;
let nextUpdate = 10;
const merges: Array<{ runId: number; by: string }> = [];

const pairAs = (who: string, chat: number, updateId: number) => {
  const code = mintPairingCode();
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, now);
  expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: String(chat), updateId }, now).ok).toBe(true);
};
const pass = () => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [REPO],
  conversation: { evidenceRoot: dir, phoneOrigin: () => ORIGIN, merge: async input => { merges.push(input); return { ok: true }; } } });
const tapIn = async (chat: number, data: string, messageId: number, text = script.current(chat, messageId).text) => {
  script.updates.push([{ update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat }, text } } }]);
  return pass();
};
const replyIn = async (chat: number, text: string, replyTo: number) => {
  script.updates.push([{ update_id: nextUpdate++, message: { message_id: 3000 + nextUpdate, chat: { id: chat, type: "private" }, from: { id: chat }, text, reply_to_message: { message_id: replyTo } } }]);
  return pass();
};
/** One card state: captured for review, and inside Telegram's limits. */
const seen = (family: string, state: string, card: { text: string; rows: ScriptButton[][] }) => {
  capture(family, state, card.text, card.rows);
  withinTelegram(card.text, card.rows);
  return card;
};
const placed = (id: string, title: string) => {
  store.createTask({ id, title }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, now);
  return ref;
};
/** A built, checked result waiting to be finished. */
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
  const patch = Buffer.from(`diff --git a/src/guard.ts b/src/guard.ts\n+guard\n`, "utf8");
  writeFileSync(join(dir, String(run), "terminal-diff.patch"), patch);
  store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false,
    sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, now);
  return { ref, run };
};
const sign = (by: string) => {
  const terms: ModeTerms = { ...presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString()), chatApprove: true };
  store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
};
const decisionOn = (ref: number, recap: string, options: { id: string; label: string; consequence: string; reversible: boolean }[], recommendation: string, deadline?: string) => {
  const authority = store.routeAuthorityFor(ref, "builder");
  const run = store.startRun({ taskRef: ref, leaseId: `l-d-${ref}`, runner: RUNNER, branch: "so/q", worktree: "/pool/q",
    ...(authority?.ok ? { route: authority.stamp } : { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } }), now });
  const id = store.saveDecision({ run, urgency: "blocking", recap, question: "Fail open or fail closed?", options, recommendation, ...(deadline === undefined ? {} : { deadline }) }, now);
  store.enqueueNotification({ source: { run }, dedupeKey: `decision:${id}`, kind: "decision", subject: "payout parked a decision", body: "q" }, now);
  return id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-telegram-cards-"));
  store = openStore(join(dir, "orders.db"));
  now = T0;
  nextUpdate = 10;
  merges.length = 0;
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  expect(addApprover(store, "bob", now, { name: "alex", token: alexToken }).ok).toBe(true);
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now);
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now, newToken: () => `tok-${RUNNER}` });
  pairAs("alex", ALEX, 1);
  pairAs("bob", BOB, 2);
  script = scriptedTelegram();
  await pass();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a parked decision", () => {
  const OPTIONS = [
    { id: "open", label: "Fail open", consequence: "Bad payouts slip through until the guard is fixed.", reversible: true },
    { id: "closed", label: "Fail closed", consequence: "Queued payouts are dropped and can't be replayed.", reversible: false },
  ];

  test("sent, armed, cancelled and answered: the question first, each option's consequence before any button", async () => {
    const ref = placed("payout-1", "Guard the payout path");
    const id = decisionOn(ref, "The payout guard needs a policy call before the release.", OPTIONS, "closed", "2026-10-04T17:00:00.000Z");
    await pass();
    const card = seen("Parked decision", "sent", script.cardWith(BOB, /^Fail closed/));
    expect(card.text).toBe([
      "alpha · Decide: Fail open or fail closed?",
      "• Fail open: Bad payouts slip through until the guard is fixed.",
      "• Fail closed (recommended) ⚠ can't be undone: Queued payouts are dropped and can't be replayed.",
      "Decide by 2026-10-04 17:00 UTC", "",
      "Background: The payout guard needs a policy call before the release.",
    ].join("\n"));
    expect(card.labels).toEqual(["Fail open", "Fail closed ✓ ⚠"]);
    const message = card.messageId;
    // Answering the irreversible option arms a confirm; nothing is answered yet.
    await tapIn(BOB, card.token(/^Fail closed/), message);
    const armed = seen("Parked decision", "armed (can't be undone)", script.current(BOB, message));
    expect(armed.text).toBe("Fail closed? ⚠ This can't be undone.\nQueued payouts are dropped and can't be replayed.");
    expect(armed.labels).toEqual(["⚠ Yes, Fail closed", "Cancel"]);
    expect(store.getDecision(id)?.state).toBe("open");
    await tapIn(BOB, armed.token(/^Cancel$/), message);
    const restored = seen("Parked decision", "after Cancel", script.current(BOB, message));
    // Cancel brings back the question and every consequence, not the question alone.
    expect(restored.text).toBe(card.text.slice("alpha · ".length, card.text.indexOf("\n\nBackground:")));
    // The cancelled confirm is spent.
    await tapIn(BOB, armed.token(/Yes/), message);
    expect(store.getDecision(id)?.state).toBe("open");
    await tapIn(BOB, restored.token(/^Fail open/), message);
    expect(seen("Parked decision", "answered", script.current(BOB, message)).text).toBe("✓ Answered: Fail open\npayout-1 · by bob via telegram");
    expect(store.getDecision(id)).toMatchObject({ state: "answered", choice: "open", answeredBy: "bob", answeredVia: "telegram" });
  });

  test("a long recap splits across messages; every consequence is sent before the one message with buttons", async () => {
    const ref = placed("payout-2", "Guard the payout path");
    const recap = "The payout guard needs a policy call. ".repeat(110).trim();
    await pass();
    const from = script.sends(BOB).length;
    decisionOn(ref, recap, OPTIONS, "closed");
    await pass();
    const sends = script.sends(BOB).slice(from);
    const keyed = sends.findIndex(call => script.buttons(call).length > 0);
    expect(keyed).toBe(sends.length - 1);
    expect(sends.length).toBeGreaterThan(1);
    const before = sends.map(call => String(call.params["text"])).join("");
    for (const option of OPTIONS) expect(before).toContain(option.consequence);
    for (const [index, call] of sends.entries()) seen("Parked decision, long recap", `part ${index + 1} of ${sends.length}`, { text: String(call.params["text"]), rows: script.keyboard(call) });
    // The question and every consequence lead the first part, before the recap.
    expect(String(sends[0]!.params["text"]).indexOf("Background:")).toBeGreaterThan(String(sends[0]!.params["text"]).indexOf(OPTIONS[1]!.consequence));
  });

  test("the longest decision allowed: Cancel keeps the restored card inside one message", async () => {
    const ref = placed("payout-3", "Guard the payout path");
    const options = Array.from({ length: 6 }, (_, n) => ({ id: `o${n}`, label: `Option ${n} ${"x".repeat(100)}`, consequence: "c".repeat(500), reversible: n !== 1 }));
    await pass();
    const from = script.sends(BOB).length;
    const id = decisionOn(ref, "r".repeat(2_000), options, "o1");
    store.handle.prepare("UPDATE decision SET question = ? WHERE id = ?").run(`${"q".repeat(1_999)}?`, id);
    await pass();
    const sends = script.sends(BOB).slice(from);
    for (const call of sends) withinTelegram(String(call.params["text"]), script.keyboard(call));
    const last = sends.at(-1)!;
    await tapIn(BOB, script.current(BOB, last.messageId!).token(/^Option 1/), last.messageId!);
    await tapIn(BOB, script.current(BOB, last.messageId!).token(/^Cancel$/), last.messageId!);
    const restored = script.current(BOB, last.messageId!);
    withinTelegram(restored.text, restored.rows);
    expect(restored.text).toBe(`Decide: ${"q".repeat(1_999)}?`);
    expect(restored.labels).toHaveLength(6);
    expect(store.getDecision(id)?.state).toBe("open");
  });

  test("a card sent before this change keeps working: its buttons answer the same way and record the same", async () => {
    const ref = placed("payout-5", "Guard the payout path");
    const id = decisionOn(ref, "The payout guard needs a policy call.", OPTIONS, "closed");
    await pass();
    const card = script.cardWith(BOB, /^Fail open/);
    // The old words on the phone; the tap carries them, and the buttons are the same tokens.
    const old = "alpha · Decision needed\n\nThe payout guard needs a policy call.\n\nQ: Fail open or fail closed?\n\n[open] Fail open\n    Bad payouts slip through until the guard is fixed.";
    await tapIn(BOB, card.token(/^Fail open/), card.messageId, old);
    expect(store.getDecision(id)).toMatchObject({ state: "answered", choice: "open", answeredBy: "bob", answeredVia: "telegram" });
  });
});

describe("decide-in-chat cards", () => {
  test("a plan: sent, armed, approved; ledgered as before", async () => {
    sign("bob");
    const ref = placed("plan-5", "Refuse over-limit payouts");
    propose(store, { taskId: "plan-5", goal: "Refuse over-limit payouts.\nKeep the public API unchanged.\nA third line the card leaves out.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }, { id: "c2", statement: "Refusals are logged with the payout id.", how: null, evidence: ["check"] }], now });
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-5", kind: "plan-ready", subject: "plan-5: plan ready for review", body: "Review, edit, and approve the scope — nothing builds until you do.", source: { taskRef: ref } }, now);
    await pass();
    const card = seen("Plan approval", "sent", script.cardWith(BOB, /^Approve & start$/));
    expect(card.text).toBe([
      "Plan ready: Refuse over-limit payouts",
      "Starting allows: file edits and routine commands; anything risky stops · up to $2.00 per attempt", "",
      "Refuse over-limit payouts.", "Keep the public API unchanged.", "Only in: src/guard.ts", "",
      "Done when:", "• Over-limit payouts are refused.", "• Refusals are logged with the payout id.",
    ].join("\n"));
    expect(card.labels).toEqual(["Approve & start", "Edit ↗", "Not now"]);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    const armed = seen("Plan approval", "armed", script.current(BOB, card.messageId));
    expect(armed.text).toBe(`${card.text}\n\nApprove and start "Refuse over-limit payouts"?`);
    await tapIn(BOB, armed.token(/^Cancel$/), card.messageId);
    const restored = seen("Plan approval", "after Cancel", script.current(BOB, card.messageId));
    expect(restored.text).toBe(card.text);
    await tapIn(BOB, restored.token(/^Approve & start$/), card.messageId);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    expect(seen("Plan approval", "approved", script.current(BOB, card.messageId)).text).toBe(`${card.text}\n\n✓ Approved. Work starts when a worker is free.`);
    const scope = store.getScope("plan-5")!;
    expect(scope).toMatchObject({ approvedBy: "bob", approvedDigest: scope.digest, approvalBasis: "chat" });
    const binding = store.liveTelegramBindingFor(BOT, String(BOB))!;
    expect(store.handle.prepare("SELECT actor, task_id, action, outcome, detail FROM action_ledger WHERE action = 'plan approved in chat'").all())
      .toEqual([{ actor: "bob", task_id: "plan-5", action: "plan approved in chat", outcome: "approved", detail: `via telegram · chat binding #${binding.id} · mode ${store.activeMode(REPO, now)!.digest}` }]);
  });

  test("a plan card sent before this change: its Approve, Yes and Cancel act as before, on the words it shows", async () => {
    sign("bob");
    const ref = placed("plan-6", "Refuse over-limit payouts");
    propose(store, { taskId: "plan-6", goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-6", kind: "plan-ready", subject: "plan-6: plan ready for review", body: "Review it.", source: { taskRef: ref } }, now);
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    const old = ["Plan ready: Refuse over-limit payouts", "", "Refuse over-limit payouts.", "", "Changes:", "Only in: src/guard.ts", "",
      "Done when:", "• Over-limit payouts are refused.", "", "You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt"].join("\n");
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId, old);
    expect(script.current(BOB, card.messageId).text).toBe(`${old}\n\nApprove and start "Refuse over-limit payouts"?`);
    // An old armed card's question is the one cardBody already strips: Cancel shows the card, not the question twice.
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Cancel$/), card.messageId, `${old}\n\nApprove and start "Refuse over-limit payouts"?`);
    expect(script.current(BOB, card.messageId).text).toBe(card.text);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Approve & start$/), card.messageId, old);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId, `${old}\n\nApprove and start "Refuse over-limit payouts"?`);
    expect(script.current(BOB, card.messageId).text).toBe(`${old}\n\n✓ Approved. Work starts when a worker is free.`);
    expect(store.getScope("plan-6")).toMatchObject({ approvedBy: "bob", approvalBasis: "chat" });
  });

  test("a result: sent, armed, accepted and finished as the operator", async () => {
    readyResult("guard-1", "Keep the guard readable");
    await pass();
    const card = seen("Result", "sent", script.cardWith(BOB, /^Accept and finish$/));
    await tapIn(BOB, card.token(/^Accept and finish$/), card.messageId);
    seen("Result", "armed", script.current(BOB, card.messageId));
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    seen("Result", "finished", script.current(BOB, card.messageId));
    expect(assignmentOf(store, "guard-1", now, { principal: "operator", repos: [REPO] }, dir)).toMatchObject({ state: "complete", completion: { actor: "operator:bob" } });
  });

  test("a failed task: sent, armed, queued again", async () => {
    const ref = placed("payout-4", "Guard the payout path");
    store.setTaskState("payout-4", "failed", now);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-4", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-4 stalled after 3 straight failures",
      body: "The last attempt failed its checks.", source: { taskRef: ref } }, now);
    await pass();
    const card = seen("Failed task", "sent", script.cardWith(BOB, /^Retry$/));
    await tapIn(BOB, card.token(/^Retry$/), card.messageId);
    seen("Failed task", "armed", script.current(BOB, card.messageId));
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    seen("Failed task", "queued again", script.current(BOB, card.messageId));
    expect(store.getTask("payout-4")?.state).toBe("queued");
  });

  test("a pull request: sent, armed, merged; both ledger lines as before", async () => {
    const { ref, run } = readyResult("merge-9", "Keep the guard readable");
    const head = "a".repeat(40);
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/r", remote: "origin", base: "main", head: "so/merge-9", headSha: head, bodyHash: "h", draft: false }, now);
    store.handle.prepare("UPDATE publication SET state = 'opened', pr_number = 3 WHERE id = ?").run(publication);
    store.handle.prepare("INSERT INTO pull_request_follow (publication, ready_head, created_at, updated_at) VALUES (?, ?, ?, ?)").run(publication, head, now.toISOString(), now.toISOString());
    sign("bob");
    store.resolveEpisodes("life", now);
    await pass();
    now = new Date(now.getTime() + 3 * 60_000);
    store.enqueueNotification({ dedupeKey: `pull-request:${publication}:ready:${head}`, kind: "pull-request-ready", pushClass: "merge",
      subject: "Ready to merge: merge-9 (PR #3)", body: `Checks passed on ${head.slice(0, 12)}. Merge it from the task.`, link: "/t/merge-9#merge", source: { run } }, now);
    await pass();
    const card = seen("Pull request", "sent", script.cardWith(BOB, /^Merge$/));
    await tapIn(BOB, card.token(/^Merge$/), card.messageId);
    seen("Pull request", "armed", script.current(BOB, card.messageId));
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    seen("Pull request", "merged", script.current(BOB, card.messageId));
    expect(merges).toEqual([{ runId: run, by: "bob" }]);
    expect(store.handle.prepare("SELECT action, outcome FROM action_ledger WHERE action LIKE 'merge%chat' ORDER BY id").all())
      .toEqual([{ action: "merge approved in chat", outcome: "approved" }, { action: "merge from chat", outcome: "merged" }]);
  });
});

describe("a lead's proposal", () => {
  /** A pending card on alex's own session and thread, its tokens placed on a synthetic message. */
  const proposal = (kind: Parameters<Store["draftLeadProposal"]>[0]["kind"], payload: Record<string, unknown>, messageId: number) => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    const me = verified.who;
    const credentialKey = subscriptionCredentialKey("claude-subscription");
    if (store.activeLeadSession("alex") === null) store.mintLeadSession({ approver: "alex", approverGeneration: me.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
    const session = store.activeLeadSession("alex")!;
    const thread = store.openLeadThread("alex", me.ceilingDigest, now).thread;
    const opened = store.openLeadTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startLeadTurn(opened.id, now);
    if (!started.ok) throw new Error("start");
    const id = store.draftLeadProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: me.ceilingDigest }, now);
    store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now);
    const minted = mintCardTokens(store, store.liveTelegramBindingFor(BOT, String(ALEX))!, id, now, String(messageId));
    const text = proposalPreview(store, store.getLeadProposal(id)!, [REPO], "telegram").text;
    // As the bridge sends it: the card's words, then its Confirm and Dismiss.
    script.calls.push({ method: "sendMessage", params: { chat_id: ALEX, text, reply_markup: { inline_keyboard: minted.keyboard } }, messageId });
    return { id, messageId };
  };

  test("a new task: what confirming does, before the exact terms", async () => {
    placed("guard-2", "Keep the guard readable");
    const card = proposal("task", { repoId: "r1", title: "Log refused payouts", goal: "Write one line per refused payout with its id and the limit it passed.", not: "Change the limit itself." }, 77);
    expect(seen("Proposal: new task", "sent", script.current(ALEX, card.messageId)).text).toBe([
      "Create task in alpha: Log refused payouts",
      "Confirm files it. You still approve its scope before work starts.", "",
      "Goal: Write one line per refused payout with its id and the limit it passed.",
      "Not: Change the limit itself.", "",
      "Nothing changes until you confirm.",
    ].join("\n"));
    // Slack, Discord and Teams keep their own card words.
    expect(proposalPreview(store, store.getLeadProposal(card.id)!, [REPO], "slack").text).toContain("Confirm or Dismiss below. Nothing changes until you confirm.");
  });

  test("an irreversible answer: sent, armed, cancelled, then answered through the shared door", async () => {
    const ref = placed("q", "Guard the payout path");
    const decision = decisionOn(ref, "The check can fail.", [
      { id: "open", label: "Fail open", consequence: "Requests pass while the check is down", reversible: true },
      { id: "closed", label: "Fail closed", consequence: "Requests are refused; a rollback restores them", reversible: false },
    ], "closed");
    const card = proposal("answer", { decision, task: "q", taskTitle: "Guard the payout path", option: "closed", optionLabel: "Fail closed", reversible: false, rationale: "Safer while the guard is new." }, 78);
    const sent = seen("Proposal: irreversible answer", "sent", script.current(ALEX, card.messageId));
    await tapIn(ALEX, sent.token(/^Confirm$/), card.messageId);
    expect(sent.text.split("\n").slice(0, 2)).toEqual(['Answer decision #1 on Guard the payout path with "Fail closed"', "⚠ This choice can't be undone. Confirming asks you once more."]);
    const armed = seen("Proposal: irreversible answer", "armed", script.current(ALEX, card.messageId));
    expect(armed.text).toBe(`${sent.text}\n\n⚠ Last step: this answer can't be undone. Confirm?`);
    expect(armed.labels).toEqual(["⚠ Yes, answer it", "Cancel"]);
    expect(store.getDecision(decision)?.state).toBe("open");
    await tapIn(ALEX, armed.token(/^Cancel$/), card.messageId);
    const restored = seen("Proposal: irreversible answer", "after Cancel", script.current(ALEX, card.messageId));
    expect(restored.text).toBe(sent.text);
    await tapIn(ALEX, restored.token(/^Confirm$/), card.messageId);
    await tapIn(ALEX, script.current(ALEX, card.messageId).token(/Yes/), card.messageId);
    seen("Proposal: irreversible answer", "answered", script.current(ALEX, card.messageId));
    expect(store.getDecision(decision)).toMatchObject({ state: "answered", choice: "closed", answeredBy: "alex", answeredVia: "telegram" });
  });
});

describe("flow cards", () => {
  test("a flow approval: sent with its draft, Edit replaces it, Approve moves the card on", async () => {
    const flow = store.createFlow({ repo: REPO, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
      { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
      { id: "post", title: "Post it", kind: "inbox" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "check", by: "alex" }, now);
    store.updateFlowCard(card, { outputs: { draft: "Hi Sam, we refunded order 42 today. It reaches your card in 3–5 working days." } }, now);
    advanceFlows(store, REPO, now, { evidenceRoot: dir });
    await pass();
    const sent = seen("Flow approval", "sent", script.cardWith(ALEX, /Approve$/));
    expect(sent.text).toBe([
      "alpha · Approve “Refund for order 42?”",
      "Approve → Post it · Send back → Write the reply, with your note", "",
      "Draft:", "Hi Sam, we refunded order 42 today. It reaches your card in 3–5 working days.", "",
      "Support · Check the reply",
    ].join("\n"));
    expect(sent.labels).toEqual(["✅ Approve", "✏️ Edit", "↩️ Send back", "Open console ↗"]);
    // The saved notice keeps its words for every other place.
    expect(store.listNotifications("all").find(one => one.dedupeKey === `flow-decide:${card}:1`)!.body)
      .toBe("Check the reply: approve this draft to send it as written, edit it, or send it back with a note.\n\nHi Sam, we refunded order 42 today. It reaches your card in 3–5 working days.");
    await tapIn(ALEX, sent.token(/Edit$/), sent.messageId);
    const ask = script.sends(ALEX).at(-1)!;
    seen("Flow approval", "Edit asks for a reply", { text: String(ask.params["text"]), rows: [] });
    await replyIn(ALEX, "Hi Sam, we refunded order 42 today. Expect it within 5 working days.", ask.messageId!);
    const fresh = seen("Flow approval", "your version, back for a decision", script.cardWith(ALEX, /Approve$/));
    expect(fresh.text.split("\n").slice(0, 5)).toEqual(["Approve your version of “Refund for order 42?”", "Approve → Post it · Send back → Write the reply, with your note", "",
      "Draft:", "Hi Sam, we refunded order 42 today. Expect it within 5 working days."]);
    expect(fresh.messageId).not.toBe(sent.messageId);
    // The first card's buttons are spent; the fresh card's Approve decides.
    await tapIn(ALEX, sent.token(/Approve$/), sent.messageId);
    expect(store.getFlowCard(card)!.stage).toBe("check");
    // Two taps, as a plan's: Approve asks, and only the Yes decides.
    await tapIn(ALEX, fresh.token(/Approve$/), fresh.messageId);
    const armed = seen("Flow approval", "armed", script.current(ALEX, fresh.messageId));
    expect(armed.text).toBe(`${fresh.text}\n\nApprove “Refund for order 42?”? It moves to Post it.`);
    expect(armed.labels).toEqual(["Yes", "Cancel"]);
    expect(store.getFlowCard(card)!.stage).toBe("check");
    await tapIn(ALEX, armed.token(/^Yes$/), fresh.messageId);
    expect(seen("Flow approval", "approved", script.current(ALEX, fresh.messageId)).text).toBe(`${fresh.text}\n\n✅ Approved. Moved to Post it.`);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "post", outputs: { draft: "Hi Sam, we refunded order 42 today. Expect it within 5 working days." } });
    expect(store.flowEvents(card).at(-1)).toMatchObject({ toStage: "post", outcome: "approved", actor: "alex" });
  });

  test("a flow approval with the longest draft: split within Telegram's limit, the buttons on the last part only", async () => {
    const flow = store.createFlow({ repo: REPO, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply" },
      { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "A long reply", description: null, stage: "check", by: "alex" }, now);
    store.updateFlowCard(card, { outputs: { draft: "word ".repeat(2_400).trim() } }, now);
    advanceFlows(store, REPO, now, { evidenceRoot: dir });
    await pass();
    const from = script.sends(ALEX).findIndex(call => String(call.params["text"]).includes("Approve “A long reply”"));
    const sends = script.sends(ALEX).slice(from);
    expect(sends.length).toBeGreaterThan(1);
    for (const call of sends) withinTelegram(String(call.params["text"]), script.keyboard(call));
    expect(sends.findIndex(call => script.buttons(call).length > 0)).toBe(sends.length - 1);
    // The action and where each button goes lead the first part; Approve with no next zone finishes the card.
    expect(String(sends[0]!.params["text"]).split("\n").slice(0, 2)).toEqual(["alpha · Approve “A long reply”", "Approve → Done · Send back → Write the reply, with your note"]);
  });

  test("a flow choice: sent with its options, a tap moves the card and is ledgered as before", async () => {
    store.createTask({ id: "fix-3", title: "Checkout rounding" }, now);
    const ref = store.refFor("built-in", "fix-3").id;
    store.placeTask(ref, REPO, {}, now);
    const run = store.startRun({ taskRef: ref, leaseId: "l-fix-3", runner: RUNNER, branch: "so/fix-3", worktree: "/pool/fix-3",
      route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const }, now });
    store.recordOutcomeFacts(run, { handoff: "Totals now round half-up, with a regression test." });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.setTaskState("fix-3", "done", now);
    const flow = store.createFlow({ repo: REPO, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { id: "build", title: "Build", kind: "task" },
      { id: "choose", title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }], remindAfter: "2 days", ifNoReply: "Parked" },
      { id: "ship", title: "Ship", kind: "inbox" },
      { id: "parked", title: "Parked", kind: "inbox" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Checkout rounding", description: "Totals are off by a cent", stage: "build", by: "alex" }, now);
    store.updateFlowCard(card, { primaryTask: "fix-3", outputs: { build: "Result ready on task fix-3." } }, now);
    expect(store.moveFlowCard(card, { to: "choose", outcome: "ok", actor: "flow", task: "fix-3" }, now)).toBe(true);
    advanceFlows(store, REPO, now, { evidenceRoot: dir });
    await pass();
    const sent = seen("Flow choice", "sent", script.cardWith(ALEX, /^Ship it$/));
    expect(sent.text).toBe([
      "alpha · Choose what happens to “Checkout rounding”",
      "Ship it → Ship · Ignore → closes the card · or reply → Build, with your note", "",
      "Totals now round half-up, with a regression test.", "",
      "Fixes · after Build",
    ].join("\n"));
    expect(sent.labels).toEqual(["Ship it", "Ignore", "Result ↗", "Card ↗"]);
    await tapIn(ALEX, sent.token(/^Ship it$/), sent.messageId);
    expect(seen("Flow choice", "chosen", script.current(ALEX, sent.messageId)).text).toBe(`${sent.text}\n\n✅ Ship it. Moved to Ship.`);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "ship", state: "active" });
    expect(store.flowEvents(card).at(-1)).toMatchObject({ toStage: "ship", actor: "alex", note: "Chose “Ship it” in Telegram" });
    expect(store.actionLedger({ repos: [REPO] }).filter(one => one.action === "flow choice"))
      .toEqual([expect.objectContaining({ actor: "alex", outcome: "chosen", detail: `Fixes · card ${card} · What next?: “Ship it” · via Telegram` })]);
  });
});

describe("approving anywhere the owner has authority", () => {
  const DAY = 86_400_000;
  const supportFlow = () => {
    const flow = store.createFlow({ repo: REPO, name: "Publish", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write it", kind: "draft", instructions: "Write {{card.title}}" },
      { id: "check", title: "Publish to toolroll.dev?", kind: "approval", decider: "owner", ifFails: "Write it" },
      { id: "post", title: "Published", kind: "inbox" },
    ], null)) }, now);
    return { flow, card: (title: string) => {
      const card = store.addFlowCard({ flow, title, description: null, stage: "check", by: "alex" }, now);
      store.updateFlowCard(card, { outputs: { draft: `Notes for ${title}.` } }, now);
      return card;
    } };
  };
  const plan = (id: string, extra: Partial<Parameters<typeof propose>[1]> = {}) => {
    const ref = placed(id, "Refuse over-limit payouts");
    propose(store, { taskId: id, goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now, ...extra });
    store.enqueueNotification({ dedupeKey: `plan-ready:${id}`, kind: "plan-ready", subject: `${id}: plan ready for review`, body: "Review it.", source: { taskRef: ref } }, now);
    return ref;
  };
  const flowLedger = () => store.handle.prepare("SELECT actor, repo, action, outcome, detail FROM action_ledger WHERE action = 'flow decision' ORDER BY id").all();
  const events = (card: number) => store.flowEvents(card).filter(one => one.outcome !== "created").map(({ fromStage, toStage, outcome, actor, note }) => ({ fromStage, toStage, outcome, actor, note }));

  test("under the lasting setting a plan approves in two taps eight days on, sealed as the owner's yes, and stands a month later like a console approval", async () => {
    const { setChatApproval } = await import("./chat-approval.js");
    expect(setChatApproval(store, { approver: "bob", scope: REPO, enabled: true, limits: { fullAccess: false, capMicrousd: 5_000_000 }, via: "test" }, now).ok).toBe(true);
    now = new Date(T0.getTime() + 8 * DAY);
    const ref = plan("plan-30");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    expect(store.getScope("plan-30")!.approvedDigest).toBeNull();
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    const chat = store.getScope("plan-30")!;
    expect(chat).toMatchObject({ approvedBy: "bob", approvedDigest: chat.digest, approvalBasis: "chat" });
    const setting = store.handle.prepare("SELECT digest FROM chat_approval_setting WHERE approver = 'bob'").get() as { digest: string };
    const binding = store.liveTelegramBindingFor(BOT, String(BOB))!;
    expect(store.handle.prepare("SELECT actor, repo, task_id, action, outcome, detail FROM action_ledger WHERE action = 'plan approved in chat'").all())
      .toEqual([{ actor: "bob", repo: REPO, task_id: "plan-30", action: "plan approved in chat", outcome: "approved", detail: `via telegram · chat binding #${binding.id} · setting ${setting.digest}` }]);
    // The same plan approved on the console: the same seal, and the same answer when it is checked again later.
    const consoleRef = placed("plan-31", "Refuse over-limit payouts");
    propose(store, { taskId: "plan-31", goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    expect(approve(store, "plan-31", "alex", now, store.getScope("plan-31")!.digest, alexToken).ok).toBe(true);
    // Turning the setting off, and a month passing, leave both approvals standing.
    setChatApproval(store, { approver: "bob", scope: REPO, enabled: false, via: "test" }, now);
    const later = new Date(now.getTime() + 30 * DAY);
    for (const [id, one] of [["plan-30", ref], ["plan-31", consoleRef]] as const) {
      expect(store.scopeSealed(id), id).toBe(true);
      expect(store.modeApprovalLive(one, later), id).toBe(true);
    }
  });

  test("a plan that asks for full access keeps its console link under the setting; taps from an unpaired chat do nothing", async () => {
    const { setChatApproval } = await import("./chat-approval.js");
    setChatApproval(store, { approver: "bob", scope: REPO, enabled: true, limits: { fullAccess: false, capMicrousd: null }, via: "test" }, now);
    plan("plan-32", { posture: "escalated" });
    await pass();
    const pushed = [...script.inChat(BOB)].reverse().find(call => call.method === "sendMessage" && String(call.params["text"]).includes("plan ready"))!;
    expect(script.buttons(pushed).map(one => [one.text, one.url])).toEqual([["Review & start", `${ORIGIN}/chat?task=plan-32#task-chat-action`]]);

    now = new Date(now.getTime() + 3 * 60_000);
    plan("plan-33");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    // A stranger taps bob's plan button from their own chat: answered, and nothing changes.
    script.updates.push([{ update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, data: card.token(/^Approve & start$/), from: { id: 9191 }, message: { message_id: card.messageId, chat: { id: 9191 }, text: card.text } } }]);
    await pass();
    expect(script.acks().at(-1)).toBe("These buttons work only for the person they were sent to. Nothing was done.");
    expect(store.getScope("plan-33")!.approvedDigest).toBeNull();
    expect(script.current(BOB, card.messageId).labels).toEqual(["Approve & start", "Edit ↗", "Not now"]);
  });

  test("a flow approval decided in Telegram and one decided on the console: the same flow events and ledger line but for where; an unpaired tap does nothing", async () => {
    const { decideFlowCard } = await import("./flow-engine.js");
    const { card: cardIn } = supportFlow();
    const phone = cardIn("Release notes"), desk = cardIn("Pricing page");
    advanceFlows(store, REPO, now, { evidenceRoot: dir });
    await pass();
    const sent = script.cardWith(ALEX, /Approve$/);
    // Someone not paired taps alex's Approve: nothing happens.
    script.updates.push([{ update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, data: sent.token(/Approve$/), from: { id: 9191 }, message: { message_id: sent.messageId, chat: { id: 9191 }, text: sent.text } } }]);
    await pass();
    expect(store.getFlowCard(phone)!.stage).toBe("check");
    const first = sent.text.includes("Release notes") ? phone : desk;
    const second = first === phone ? desk : phone;
    await tapIn(ALEX, sent.token(/Approve$/), sent.messageId);
    await tapIn(ALEX, script.current(ALEX, sent.messageId).token(/^Yes$/), sent.messageId);
    expect(decideFlowCard(store, { card: second, decision: "approve", note: null, actor: "alex", repos: [REPO], where: "the console" }, now)).toMatchObject({ ok: true });
    expect(events(first)).toEqual(events(second));
    expect(events(first)).toEqual([{ fromStage: "check", toStage: "post", outcome: "approved", actor: "alex", note: null }]);
    const [viaPhone, viaDesk] = flowLedger() as Array<Record<string, string>>;
    const same = (row: Record<string, string>) => ({ ...row, detail: row["detail"]!.replace(/ · card \d+ · /, " · card N · ").replace(/ · via .*$/, "") });
    expect(same(viaPhone!)).toEqual(same(viaDesk!));
    expect([viaPhone!["detail"]!.endsWith("via Telegram"), viaDesk!["detail"]!.endsWith("via the console")]).toEqual([true, true]);
  });

  test("an expired flow card says where the card is now and links it in Flows while it waits; a moved one links nothing", async () => {
    const { flow, card: cardIn } = supportFlow();
    const card = cardIn("Release notes");
    advanceFlows(store, REPO, now, { evidenceRoot: dir });
    await pass();
    const sent = script.cardWith(ALEX, /Approve$/);
    now = new Date(now.getTime() + 8 * DAY);
    await tapIn(ALEX, sent.token(/Approve$/), sent.messageId);
    const old = script.current(ALEX, sent.messageId);
    expect(old.text).toBe(`${sent.text}\n\nThese buttons were already used, or are too old. It's waiting for alex in Publish to toolroll.dev? (Publish).`);
    expect(old.rows.flat().map(one => [one.text, one.url])).toEqual([["Open it in Flows", `${ORIGIN}/flows/${flow}?card=${card}`]]);
    expect(store.getFlowCard(card)!.stage).toBe("check");
    // Moved on elsewhere: the old message names where it went, with nothing to tap.
    store.moveFlowCard(card, { to: "post", outcome: "moved", actor: "alex", expectEntry: 1 }, now);
    await tapIn(ALEX, sent.token(/Edit$/), sent.messageId, sent.text);
    expect(script.current(ALEX, sent.messageId).text).toBe(`${sent.text}\n\nThese buttons were already used, or are too old. It moved on to Published (Publish).`);
    expect(script.current(ALEX, sent.messageId).rows.flat()).toEqual([]);
  });

  test("an expired plan card links the plan where it still waits; once cancelled it says so and links nothing", async () => {
    const { setChatApproval } = await import("./chat-approval.js");
    setChatApproval(store, { approver: "bob", scope: REPO, enabled: true, via: "test" }, now);
    plan("plan-34");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    now = new Date(now.getTime() + 8 * DAY);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nThat button expired. Nothing was done. "Refuse over-limit payouts" waits for your approval.`);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Review & start ↗"]);
    expect(store.getScope("plan-34")!.approvedDigest).toBeNull();
    now = new Date(now.getTime() + 60_000);
    plan("plan-35");
    await pass();
    const next = script.cardWith(BOB, /^Approve & start$/);
    store.setTaskState("plan-35", "cancelled", now);
    await tapIn(BOB, next.token(/^Approve & start$/), next.messageId);
    expect(script.current(BOB, next.messageId).text).toContain(`"Refuse over-limit payouts" was cancelled.`);
    expect(script.current(BOB, next.messageId).rows.flat()).toEqual([]);
  });

  test("asked to approve, the lead sends the plan's and the flow card's own buttons; the owner's taps decide, never the lead", async () => {
    const { LEAD_TOOLS } = await import("./lead-tools.js");
    const offer = LEAD_TOOLS.find(one => one.name === "offer_approval")!;
    const principal = verifyApproverStanding(store, "bob", store.accountOf("bob")!.generation, [REPO]);
    if (!principal.ok) throw new Error("principal");
    const ctx = { store, who: principal.who, now, draft: () => null, step: 1, readDecisions: new Map(), evidenceRoot: dir, channel: "telegram" as const };
    placed("plan-36", "Refuse over-limit payouts");
    propose(store, { taskId: "plan-36", goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    // Not turned on: the lead hears why, and nothing is sent.
    expect(offer.handle(ctx as never, { task: "plan-36" })).toEqual({ ok: true, body: { offered: false, task: "plan-36", why: "Approving from chat isn't turned on for this project.", control: "approval" } });
    const { setChatApproval } = await import("./chat-approval.js");
    setChatApproval(store, { approver: "bob", scope: REPO, enabled: true, via: "test" }, now);
    expect(offer.handle(ctx as never, { task: "plan-36" })).toMatchObject({ ok: true, body: { offered: true, task: "plan-36" } });
    expect(store.getScope("plan-36")!.approvedDigest).toBeNull();
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    expect(store.getScope("plan-36")).toMatchObject({ approvedBy: "bob", approvalBasis: "chat" });

    // A flow card whose decider is alex: bob's lead says only alex decides; alex's sends alex the buttons.
    const { card: cardIn } = supportFlow();
    const flowCard = cardIn("Release notes");
    expect(offer.handle(ctx as never, { card: flowCard })).toMatchObject({ ok: true, body: { offered: false, why: "Only alex decides here." } });
    const alexWho = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!alexWho.ok) throw new Error("principal");
    expect(offer.handle({ ...ctx, who: alexWho.who } as never, { card: flowCard })).toMatchObject({ ok: true, body: { offered: true } });
    now = new Date(now.getTime() + 3 * 60_000);
    await pass();
    const sent = script.cardWith(ALEX, /Approve$/);
    expect(sent.text).toContain("Approve “Release notes”");
    await tapIn(ALEX, sent.token(/Approve$/), sent.messageId);
    expect(store.getFlowCard(flowCard)!.stage).toBe("check");
    await tapIn(ALEX, script.current(ALEX, sent.messageId).token(/^Yes$/), sent.messageId);
    expect(store.getFlowCard(flowCard)!.stage).toBe("post");
  });
});
