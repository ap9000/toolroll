/**
 * Decisions finish in the chat app (chat-decide.ts), against a scripted Bot API: a pushed Ready card accepts and
 * finishes, requests changes or retries in place with a two-tap confirm bound to the exact result; under a signed
 * chatApprove term a plan or a ready pull request approves in chat, and outside the mode's terms the card keeps its
 * link; an agent's question pushes with its options as buttons and a tap answers it. Stale cards say so and act on
 * nothing. Fixture transport, not a phone: nothing here is a live Telegram proof.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
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
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { modeDigestOf, modeTermsJson, modeWords, presetTerms, type ModeTerms } from "./modes.js";
import { mergeInChat, planInChat } from "./chat-decide.js";
import { runOperate } from "./operate.js";

const T0 = new Date("2026-10-03T09:00:00.000Z");
const BOT = "777000";
const ALEX = 4242;
const BOB = 5353;
const REPO = "/projects/alpha";
const ORIGIN = "https://console.example";
const RUNNER = "worker-1";

type Button = { text: string; callback_data?: string; url?: string };
type Call = { method: string; params: Record<string, unknown>; messageId: number | null };

function scriptedTelegram() {
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let next = 100;
  /** Telegram refuses the next edit in a chat, with these words. */
  const editFailures: Array<{ chat: number; description: string }> = [];
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") {
      calls.push({ method, params, messageId: null });
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(one => Number((one as { update_id: number }).update_id) >= offset) };
    }
    if (method === "sendMessage") {
      const messageId = next++;
      calls.push({ method, params, messageId });
      return { ok: true, result: { message_id: messageId } };
    }
    const refusal = method === "editMessageText" ? editFailures.findIndex(one => String(one.chat) === String(params["chat_id"])) : -1;
    if (refusal >= 0) {
      calls.push({ method: "editMessageText (refused)", params, messageId: null });
      return { ok: false, description: editFailures.splice(refusal, 1)[0]!.description };
    }
    calls.push({ method, params, messageId: method === "editMessageText" ? Number(params["message_id"]) : null });
    if (method === "editMessageText") return { ok: true, result: { message_id: params["message_id"] } };
    if (method === "getMyName") return { ok: true, result: { name: "Toolroll" } };
    return { ok: true, result: true };
  };
  const inChat = (chat: number) => calls.filter(call => String(call.params["chat_id"]) === String(chat));
  const buttons = (call: Call | undefined): Button[] => ((call?.params["reply_markup"] as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
  /** The newest message in a chat carrying a button with this label: its id, words and buttons now (its last edit wins). */
  const cardWith = (chat: number, label: RegExp) => {
    const sent = [...inChat(chat)].reverse().find(call => call.method === "sendMessage" && buttons(call).some(one => label.test(one.text)));
    if (sent === undefined) throw new Error(`no message in ${chat} with ${label}`);
    return current(chat, sent.messageId!);
  };
  const current = (chat: number, messageId: number) => {
    const last = [...inChat(chat)].reverse().find(call => (call.method === "sendMessage" || call.method === "editMessageText") && call.messageId === messageId)!;
    const rows = buttons(last);
    const token = (label: RegExp): string => {
      const found = rows.find(one => label.test(one.text) && one.callback_data !== undefined);
      if (found === undefined) throw new Error(`no ${label} button: ${JSON.stringify(rows)}`);
      return found.callback_data!;
    };
    return { messageId, text: String(last.params["text"]), rows, token, labels: rows.map(one => one.url === undefined ? one.text : `${one.text} ↗`) };
  };
  const acks = () => calls.filter(call => call.method === "answerCallbackQuery").map(call => String(call.params["text"] ?? ""));
  return { transport, calls, updates, inChat, cardWith, current, acks, buttons, editFailures };
}

describe("decisions finish in the chat app", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  let alexToken = "";
  let script: ReturnType<typeof scriptedTelegram>;
  let nextUpdate = 10;
  const merges: Array<{ runId: number; by: string }> = [];
  let mergeAnswer: { ok: true } | { ok: false; message: string } = { ok: true };

  const pairAs = (who: string, chat: number, updateId: number) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: String(chat), updateId }, now).ok).toBe(true);
  };
  const pass = () => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [REPO],
    conversation: { evidenceRoot: dir, phoneOrigin: () => ORIGIN, merge: async input => { merges.push(input); return mergeAnswer; } } });
  const tapIn = async (chat: number, data: string, messageId: number, text = script.current(chat, messageId).text) => {
    script.updates.push([{ update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat }, text } } }]);
    return pass();
  };
  const sayIn = async (chat: number, text: string, extra: Record<string, unknown> = {}) => {
    script.updates.push([{ update_id: nextUpdate++, message: { message_id: 2000 + nextUpdate, chat: { id: chat, type: "private" }, from: { id: chat }, text, ...extra } }]);
    return pass();
  };
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
  /** A built, checked result waiting to be finished, with a saved diff a revision can name. */
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
  const assignment = (id: string) => assignmentOf(store, id, now, { principal: "operator", repos: [REPO] }, dir);
  /** A plan written and waiting for approval, filed by alex, with the scope's own limits. */
  const planWaiting = (id: string, title: string, extra: Partial<Parameters<typeof propose>[1]> = {}) => {
    const ref = placed(id, title);
    propose(store, { taskId: id, goal: `${title}.\nKeep the public API unchanged.\nA third line the card leaves out.`, touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now, ...extra });
    return ref;
  };
  const sign = (by: string, change: Partial<ModeTerms> = {}) => {
    const terms: ModeTerms = { ...presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString()), chatApprove: true, ...change };
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
    return terms;
  };
  /** A ready result with an open pull request at its commit, and a way to push "Ready to merge". */
  const readyPullRequest = (id: string) => {
    const { ref, run } = readyResult(id, "Keep the guard readable");
    const head = "a".repeat(40);
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/r", remote: "origin", base: "main", head: `so/${id}`, headSha: head, bodyHash: "h", draft: false }, now);
    store.handle.prepare("UPDATE publication SET state = 'opened', pr_number = 3 WHERE id = ?").run(publication);
    store.handle.prepare("INSERT INTO pull_request_follow (publication, ready_head, created_at, updated_at) VALUES (?, ?, ?, ?)").run(publication, head, now.toISOString(), now.toISOString());
    const ready = () => store.enqueueNotification({ dedupeKey: `pull-request:${publication}:ready:${head}:${now.getTime()}`, kind: "pull-request-ready", pushClass: "merge",
      subject: `Ready to merge: ${id} (PR #3)`, body: `Checks passed on ${head.slice(0, 12)}. Merge it from the task.`, link: `/t/${id}#merge`, source: { run } }, now);
    store.resolveEpisodes("life", now);
    return { run, head, publication, ready };
  };
  const planReady = (ref: number, id: string) =>
    store.enqueueNotification({ dedupeKey: `plan-ready:${id}`, kind: "plan-ready", subject: `${id}: plan ready for review`, body: "Review, edit, and approve the scope — nothing builds until you do.", source: { taskRef: ref } }, now);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "so-chat-decide-"));
    store = openStore(join(dir, "orders.db"));
    now = T0;
    nextUpdate = 10;
    merges.length = 0;
    mergeAnswer = { ok: true };
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
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  test("c1: the pushed Ready card accepts and finishes in two taps, bound to the exact result; Cancel restores it and a spent Yes does nothing", async () => {
    const { run } = readyResult("guard-1", "Keep the guard readable");
    await pass();
    const card = script.cardWith(BOB, /^Accept and finish$/);
    expect(card.text).toBe("Keep the guard readable is ready. Your tests passed. Accept and finish it?");
    expect(card.labels).toEqual(["Accept and finish", "Request changes", "Look first ↗"]);
    expect(card.rows.find(one => one.text === "Look first")!.url).toBe(`${ORIGIN}/chat?task=guard-1&result=${run}&tab=changes`);
    // Opaque tokens only: no task, run or digest rides the button.
    expect(card.token(/^Accept and finish$/)).toMatch(/^d:[0-9a-f]{24}$/);

    await tapIn(BOB, card.token(/^Accept and finish$/), card.messageId);
    const armed = script.current(BOB, card.messageId);
    expect(armed.text).toBe(`${card.text}\n\nAccept and finish "Keep the guard readable"?`);
    expect(armed.labels).toEqual(["Yes", "Cancel"]);
    expect(assignment("guard-1")?.state).toBe("ready-to-check");

    await tapIn(BOB, armed.token(/^Cancel$/), card.messageId);
    const restored = script.current(BOB, card.messageId);
    expect(restored.text).toBe(card.text);
    expect(restored.labels).toEqual(["Accept and finish", "Request changes", "Look first ↗"]);
    // The Yes the Cancel replaced is spent.
    await tapIn(BOB, armed.token(/^Yes$/), card.messageId);
    expect(script.acks().at(-1)).toBe("That button was already used or has expired.");
    expect(assignment("guard-1")?.state).toBe("ready-to-check");

    await tapIn(BOB, restored.token(/^Accept and finish$/), card.messageId);
    const yes = script.current(BOB, card.messageId).token(/^Yes$/);
    await tapIn(BOB, yes, card.messageId);
    expect(assignment("guard-1")).toMatchObject({ state: "complete", completion: { actor: "operator:bob" } });
    const finished = script.current(BOB, card.messageId);
    expect(finished.text).toBe(`${card.text}\n\n✓ Accepted and finished. The recorded checks are unchanged.`);
    expect(finished.labels).toEqual([]);
    // A repeated Yes is spent; the record is unchanged.
    await tapIn(BOB, yes, card.messageId);
    expect(script.acks().at(-1)).toBe("That button was already used or has expired.");
  });

  test("c1: a stale card says so and acts on nothing — the task finished elsewhere, before the first tap or between the two", async () => {
    readyResult("guard-2", "Keep the guard readable");
    await pass();
    const card = script.cardWith(BOB, /^Accept and finish$/);
    // Armed on the phone, then finished on the console: the Yes acts on nothing.
    await tapIn(BOB, card.token(/^Accept and finish$/), card.messageId);
    const yes = script.current(BOB, card.messageId).token(/^Yes$/);
    expect(checkAssignmentAsOperator(store, "guard-2", assignment("guard-2")!.receipt!.digest, who("alex"), now, dir).ok).toBe(true);
    await tapIn(BOB, yes, card.messageId);
    const stale = script.current(BOB, card.messageId);
    expect(stale.text).toBe(`${card.text}\n\nThis task is already finished. Nothing was done.`);
    expect(stale.labels).toEqual(["Look first ↗"]);
    expect(store.settledBy(store.refFor("built-in", "guard-2").id)).toBe("alex");

    // Another person's card for the same result: its first tap says so too.
    const other = script.cardWith(ALEX, /^Accept and finish$/);
    await tapIn(ALEX, other.token(/^Request changes$/), other.messageId);
    expect(script.current(ALEX, other.messageId).text).toContain("This task is already finished. Nothing was done.");
    // A button is the person's own: bob's token from alex's chat does nothing.
    await tapIn(ALEX, card.token(/^Request changes$/), card.messageId, card.text);
    expect(script.acks().at(-1)).toBe("That button isn't for this chat.");
  });

  test("c1: Request changes asks what should change, and the next message becomes the revision's feedback", async () => {
    const { run } = readyResult("guard-3", "Keep the guard readable");
    await pass();
    const card = script.cardWith(BOB, /^Request changes$/);
    await tapIn(BOB, card.token(/^Request changes$/), card.messageId);
    expect(script.acks().at(-1)).toBe("What should change?");
    const prompt = script.inChat(BOB).filter(call => call.method === "sendMessage").at(-1)!;
    expect(String(prompt.params["text"])).toBe('What should change? Your next message is the feedback for "Keep the guard readable".');
    expect(prompt.params["reply_markup"]).toMatchObject({ force_reply: true });

    // A reply to some other message keeps its own meaning: it is not the feedback.
    await sayIn(BOB, "Ship it as is.", { reply_to_message: { message_id: card.messageId } });
    expect(store.taskFamilyOf("guard-3", [REPO], false)!.current.id).toBe("guard-3");
    await sayIn(BOB, "Rename the helper to guardPayout.", { reply_to_message: { message_id: prompt.messageId } });
    const said = script.inChat(BOB).filter(call => call.method === "sendMessage").at(-1)!;
    expect(String(said.params["text"])).toBe('Changes requested for "Keep the guard readable":\n| Rename the helper to guardPayout.\n\nThe revision waits for your approval.');
    expect(script.buttons(said).map(one => one.text)).toEqual(["Review & start"]);
    const family = store.taskFamilyOf("guard-3", [REPO], false)!;
    expect(family.current.id).not.toBe("guard-3");
    expect(store.allDiffComments(run).map(one => ({ note: one.note, author: one.author, consumedBy: one.consumedBy })))
      .toEqual([{ note: "Rename the helper to guardPayout.", author: "bob", consumedBy: family.current.id }]);
    // The prompt is spent: the next message is ordinary chat again, and the old card is out of date.
    await sayIn(BOB, "Thanks");
    expect(store.taskFamilyOf("guard-3", [REPO], false)!.current.id).toBe(family.current.id);
    await tapIn(BOB, card.token(/^Accept and finish$/), card.messageId);
    expect(script.current(BOB, card.messageId).text).toContain("A newer result is current. Nothing was done.");
  });

  test("c1: a Yes left past its ten minutes says it expired, keeps the card's link and acts on nothing", async () => {
    readyResult("guard-11", "Keep the guard readable");
    await pass();
    const card = script.cardWith(BOB, /^Accept and finish$/);
    await tapIn(BOB, card.token(/^Accept and finish$/), card.messageId);
    const yes = script.current(BOB, card.messageId).token(/^Yes$/);
    now = new Date(now.getTime() + 11 * 60_000);
    await tapIn(BOB, yes, card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nThat button expired. Nothing was done.`);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Look first ↗"]);
    expect(assignment("guard-11")?.state).toBe("ready-to-check");
  });

  test("c1: a failed task gets Retry, two taps", async () => {
    const ref = placed("payout-4", "Guard the payout path");
    store.setTaskState("payout-4", "failed", now);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-4", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-4 stalled after 3 straight failures",
      body: "The last attempt failed its checks.", source: { taskRef: ref } }, now);
    await pass();
    const card = script.cardWith(BOB, /^Retry$/);
    expect(card.labels).toEqual(["Retry", "Look first ↗"]);
    await tapIn(BOB, card.token(/^Retry$/), card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nRetry "Guard the payout path"? It queues another attempt.`);
    expect(store.getTask("payout-4")?.state).toBe("failed");
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    expect(store.getTask("payout-4")?.state).toBe("queued");
    expect(script.current(BOB, card.messageId).text).toContain("✓ Queued again.");
  });

  test("c2: the chatApprove term is signed with the password and said plainly; legacy modes never carry it", async () => {
    const lines: string[] = [];
    const code = await runOperate("mode", ["set", "--repo", REPO, "--chat-approve", "--as", "alex", "--token", alexToken], line => lines.push(line), { databaseFile: join(dir, "orders.db") });
    expect(code).toBe(0);
    // Telegram is the chat app wired today, so the term names it alone.
    expect(lines.join("\n")).toContain("your paired Telegram chat may approve this repository's plans and merge its ready pull requests, two taps each, without your password");
    expect(lines.join("\n")).not.toMatch(/Slack|Discord|Teams/);
    expect(JSON.parse(store.activeMode(REPO, new Date())!.termsJson)).toMatchObject({ chatApprove: true });
    const plain = presetTerms("standard", now.toISOString());
    expect(plain.chatApprove).toBe(false);
    expect(modeWords(plain).join("\n")).not.toContain("paired Telegram chat");
  });

  test("c2: under a signed chatApprove term a plan approves in chat with two taps, ledgered via telegram with the binding", async () => {
    sign("bob");
    const ref = planWaiting("plan-5", "Refuse over-limit payouts");
    planReady(ref, "plan-5");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    expect(card.text).toBe([
      "Plan ready: Refuse over-limit payouts", "",
      "Refuse over-limit payouts.", "Keep the public API unchanged.", "",
      "Changes:", "Only in: src/guard.ts", "",
      "Done when:", "• Over-limit payouts are refused.", "",
      "You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt",
    ].join("\n"));
    expect(card.labels).toEqual(["Approve & start", "Edit ↗", "Not now"]);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nApprove and start "Refuse over-limit payouts"?`);
    expect(store.getScope("plan-5")!.approvedDigest).toBeNull();
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    const scope = store.getScope("plan-5")!;
    expect(scope).toMatchObject({ approvedBy: "bob", approvedDigest: scope.digest, approvalBasis: "mode" });
    expect(script.current(BOB, card.messageId).text).toContain("✓ Approved under your chat approval mode.");
    const binding = store.liveTelegramBindingFor(BOT, String(BOB))!;
    const ledger = store.handle.prepare("SELECT actor, task_id, action, outcome, detail FROM action_ledger WHERE action = 'plan approved in chat'").all();
    expect(ledger).toEqual([{ actor: "bob", task_id: "plan-5", action: "plan approved in chat", outcome: "approved",
      detail: `via telegram · chat binding #${binding.id} · mode ${store.activeMode(REPO, now)!.digest}` }]);
  });

  test("c2: Not now leaves the plan waiting; a plan that changed after the card was sent acts on nothing", async () => {
    sign("bob");
    const ref = planWaiting("plan-6", "Refuse over-limit payouts");
    planReady(ref, "plan-6");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    await tapIn(BOB, card.token(/^Approve & start$/), card.messageId);
    const yes = script.current(BOB, card.messageId).token(/^Yes$/);
    propose(store, { taskId: "plan-6", goal: "Refuse over-limit payouts, and log each refusal.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    await tapIn(BOB, yes, card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nThe plan changed since this card was sent. Nothing was done.`);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Review & start ↗"]);
    expect(store.getScope("plan-6")!.approvedDigest).toBeNull();

    // Past the two-minute batch: the next plan is its own message.
    now = new Date(now.getTime() + 3 * 60_000);
    const later = planWaiting("plan-7", "Log refused payouts");
    planReady(later, "plan-7");
    await pass();
    const next = script.cardWith(BOB, /^Approve & start$/);
    await tapIn(BOB, next.token(/^Not now$/), next.messageId);
    expect(script.current(BOB, next.messageId).text).toBe(`${next.text}\n\nNot now. It waits for you in Tasks.`);
    expect(script.current(BOB, next.messageId).labels).toEqual(["Edit ↗"]);
    expect(store.getScope("plan-7")!.approvedDigest).toBeNull();
  });

  test("c2: outside the mode's terms the plan keeps its link — no term, another signer, over budget, wider access, protected paths", async () => {
    const id = "plan-8";
    planWaiting(id, "Refuse over-limit payouts");
    const why = () => { const plan = planInChat(store, id, "bob", now); return plan.ok ? "in chat" : plan.why; };
    expect(why()).toBe("Approving from chat isn't turned on for this project.");
    sign("bob", { chatApprove: false });
    expect(why()).toBe("Approving from chat isn't turned on for this project.");
    sign("alex");
    expect(why()).toBe("Only the person who signed this project's mode can approve from chat.");
    sign("bob", { perAttemptBudgetMicrousd: 1_000_000 });
    expect(why()).toBe("This plan has a $2.00 attempt limit, more than your mode's $1.00.");
    sign("bob");
    expect(why()).toBe("in chat");
    propose(store, { taskId: id, goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000, posture: "escalated",
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now });
    expect(why()).toBe("This plan asks for more access than your mode allows.");
    sign("bob", { permissionDefault: "escalated" });
    expect(why()).toBe("in chat");
    // A saved plan that can't be read back is never approved unseen.
    const planRoute = store.routeAuthorityFor(store.refFor("built-in", id).id, "planner");
    if (!planRoute?.ok) throw new Error("plan route fixture");
    const plannerRun = store.startRun({ taskRef: store.refFor("built-in", id).id, leaseId: "l-plan", runner: RUNNER, role: "planner", branch: "so/p", worktree: "/pool/p", route: planRoute.stamp, now });
    store.saveArtifact({ run: plannerRun, kind: "plan", key: `${plannerRun}/plan.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "0".repeat(64), capture: "planner" }, now);
    expect(planInChat(store, id, "bob", now, dir)).toEqual({ ok: false, why: "The saved plan can't be verified here, so you approve it in Toolroll." });
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["src/"] }, "alex", now);
    expect(why()).toBe("This plan touches protected work, so two people approve it in Toolroll.");

    // Pushed, it keeps the card's ordinary link: no act rides it.
    planReady(store.refFor("built-in", id).id, id);
    await pass();
    const pushed = [...script.inChat(BOB)].reverse().find(call => call.method === "sendMessage" && String(call.params["text"]).includes("plan ready"))!;
    expect(script.buttons(pushed).map(one => [one.text, one.url])).toEqual([["Review & start", `${ORIGIN}/chat?task=${id}#task-chat-action`]]);
  });

  test("c2: a ready pull request merges in chat with two taps under the term, bound to its commit; otherwise a link", async () => {
    const { run, head, publication, ready } = readyPullRequest("merge-9");

    // No term: the link.
    ready();
    await pass();
    const linked = [...script.inChat(BOB)].reverse().find(call => call.method === "sendMessage" && String(call.params["text"]).includes("Ready to merge"))!;
    expect(script.buttons(linked).map(one => [one.text, one.callback_data === undefined])).toEqual([["Merge", true]]);
    expect(mergeInChat(store, "merge-9", run, "bob", now)).toEqual({ ok: false, why: "Approving from chat isn't turned on for this project." });

    sign("bob");
    now = new Date(now.getTime() + 60_000);
    ready();
    await pass();
    const card = script.cardWith(BOB, /^Merge$/);
    expect(card.labels).toEqual(["Merge", "Look first ↗"]);
    await tapIn(BOB, card.token(/^Merge$/), card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nMerge "Keep the guard readable"?`);
    expect(merges).toEqual([]);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    expect(merges).toEqual([{ runId: run, by: "bob" }]);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\n✓ Merged.`);
    // The approval is ledgered with the tap; what GitHub did is its own line.
    const via = `via telegram · chat binding #${store.liveTelegramBindingFor(BOT, String(BOB))!.id} · mode ${store.activeMode(REPO, now)!.digest} · ${head.slice(0, 12)}`;
    expect(store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = 'merge approved in chat'").all()).toEqual([{ outcome: "approved", detail: via }]);
    expect(store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = 'merge from chat'").all()).toEqual([{ outcome: "merged", detail: via }]);
    // A commit pushed after the card: the next card's Yes acts on nothing.
    store.handle.prepare("UPDATE pull_request_follow SET ready_head = ? WHERE publication = ?").run("c".repeat(40), publication);
    expect(mergeInChat(store, "merge-9", run, "bob", now)).toEqual({ ok: false, why: "This pull request changed since this card was sent." });
  });

  test("c2: a chat merge GitHub refuses is ledgered as failed, with why, and the card keeps a way to the task", async () => {
    const { run, head, ready } = readyPullRequest("merge-12");
    sign("bob");
    ready();
    await pass();
    const card = script.cardWith(BOB, /^Merge$/);
    await tapIn(BOB, card.token(/^Merge$/), card.messageId);
    // Nothing is ledgered before the Yes.
    mergeAnswer = { ok: false, message: "Checks are failing, so it can't merge." };
    expect(store.handle.prepare("SELECT 1 FROM action_ledger WHERE action = 'merge approved in chat'").all()).toEqual([]);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Yes$/), card.messageId);
    expect(merges).toEqual([{ runId: run, by: "bob" }]);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\n✗ Not merged: Checks are failing, so it can't merge.`);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Open task ↗"]);
    const via = `via telegram · chat binding #${store.liveTelegramBindingFor(BOT, String(BOB))!.id} · mode ${store.activeMode(REPO, now)!.digest} · ${head.slice(0, 12)}`;
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = 'merge approved in chat'").all()).toEqual([{ outcome: "approved" }]);
    expect(store.handle.prepare("SELECT actor, task_id, run_id, outcome, detail FROM action_ledger WHERE action = 'merge from chat'").all())
      .toEqual([{ actor: "bob", task_id: "merge-12", run_id: run, outcome: "failed", detail: `${via} · Checks are failing, so it can't merge.` }]);
  });

  test("c2: a repaint Telegram refuses keeps the card's old buttons working; after Not now a later card for the plan gets fresh ones", async () => {
    sign("bob");
    const ref = planWaiting("plan-13", "Refuse over-limit payouts");
    planReady(ref, "plan-13");
    await pass();
    const card = script.cardWith(BOB, /^Approve & start$/);
    const first = card.token(/^Approve & start$/);

    // A second notice for the plan within the batch window repaints the card; Telegram refuses the edit.
    now = new Date(now.getTime() + 20_000);
    script.editFailures.push({ chat: BOB, description: "Bad Request: too many edits" });
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-13:again", kind: "plan-ready", subject: "plan-13: plan ready for review", body: "Still waiting for you.", source: { taskRef: ref } }, now);
    await pass();
    expect(script.inChat(BOB).some(call => call.method === "editMessageText (refused)")).toBe(true);
    expect(script.current(BOB, card.messageId).token(/^Approve & start$/)).toBe(first);
    // The buttons still showing still work.
    await tapIn(BOB, first, card.messageId);
    expect(script.current(BOB, card.messageId).text).toBe(`${card.text}\n\nApprove and start "Refuse over-limit payouts"?`);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Cancel$/), card.messageId);
    // The next notice repaints it, and only the new buttons act.
    const before = script.current(BOB, card.messageId).token(/^Approve & start$/);
    now = new Date(now.getTime() + 20_000);
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-13:again-2", kind: "plan-ready", subject: "plan-13: plan ready for review", body: "Still waiting for you.", source: { taskRef: ref } }, now);
    await pass();
    expect(script.current(BOB, card.messageId).token(/^Approve & start$/)).not.toBe(before);
    await tapIn(BOB, before, card.messageId);
    expect(script.acks().at(-1)).toBe("That button was already used or has expired.");

    // Not now spends this card's buttons.
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Not now$/), card.messageId);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Edit ↗"]);
    // A later notice in the same window repaints the card with fresh buttons, not the spent ones.
    now = new Date(now.getTime() + 20_000);
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-13:later", kind: "plan-ready", subject: "plan-13: plan ready for review", body: "Still waiting for you.", source: { taskRef: ref } }, now);
    await pass();
    const repainted = script.current(BOB, card.messageId);
    expect(repainted.labels).toEqual(["Approve & start", "Edit ↗", "Not now"]);
    expect(repainted.token(/^Approve & start$/)).not.toBe(first);
    await tapIn(BOB, repainted.token(/^Approve & start$/), card.messageId);
    expect(script.current(BOB, card.messageId).labels).toEqual(["Yes", "Cancel"]);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Cancel$/), card.messageId);
    await tapIn(BOB, script.current(BOB, card.messageId).token(/^Not now$/), card.messageId);

    // And past the window, a new message with fresh buttons that act.
    now = new Date(now.getTime() + 3 * 60_000);
    store.enqueueNotification({ dedupeKey: "plan-ready:plan-13:tomorrow", kind: "plan-ready", subject: "plan-13: plan ready for review", body: "Still waiting for you.", source: { taskRef: ref } }, now);
    await pass();
    const fresh = script.cardWith(BOB, /^Approve & start$/);
    expect(fresh.messageId).not.toBe(card.messageId);
    await tapIn(BOB, fresh.token(/^Approve & start$/), fresh.messageId);
    await tapIn(BOB, script.current(BOB, fresh.messageId).token(/^Yes$/), fresh.messageId);
    expect(store.getScope("plan-13")).toMatchObject({ approvedBy: "bob", approvalBasis: "mode" });
  });

  test("c1: a decide button tapped from another chat is answered with why, and does nothing", async () => {
    readyResult("guard-14", "Keep the guard readable");
    await pass();
    const card = script.cardWith(BOB, /^Accept and finish$/);
    const before = script.acks().length;
    const tap = (from: number, chat: { id: number; type: string }) => {
      script.updates.push([{ update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, data: card.token(/^Accept and finish$/), from: { id: from },
        message: { message_id: card.messageId, chat, text: card.text } } }]);
      return pass();
    };
    // Bob, from a group chat; a stranger, from their own.
    await tap(BOB, { id: -900, type: "group" });
    await tap(9191, { id: 9191, type: "private" });
    expect(script.acks().slice(before)).toEqual([
      "These buttons work only in your own chat with the bot. Nothing was done.",
      "These buttons work only for the person they were sent to. Nothing was done.",
    ]);
    expect(assignment("guard-14")?.state).toBe("ready-to-check");
    expect(script.current(BOB, card.messageId).labels).toEqual(["Accept and finish", "Request changes", "Look first ↗"]);
  });

  test("c3: an agent's question pushes with its options as buttons, and a tap answers it", async () => {
    const ref = placed("payout-10", "Guard the payout path");
    const authority = store.routeAuthorityFor(ref, "builder");
    const run = store.startRun({ taskRef: ref, leaseId: "l-q", runner: RUNNER, branch: "so/q", worktree: "/pool/q",
      ...(authority?.ok ? { route: authority.stamp } : { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } }), now });
    const decision = store.saveDecision({ run, urgency: "blocking", recap: "The payout guard needs a policy call.", question: "Fail open or fail closed?",
      options: [{ id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true }, { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true }],
      recommendation: "closed" }, now);
    store.enqueueNotification({ source: { run }, dedupeKey: `decision:${decision}`, kind: "decision", subject: "payout-10 parked a decision", body: "q" }, now);
    await pass();
    const card = script.cardWith(BOB, /^Fail closed/);
    expect(card.text).toContain("Q: Fail open or fail closed?");
    expect(card.labels).toEqual(["Fail open", "Fail closed ✓"]);
    await tapIn(BOB, card.token(/^Fail closed/), card.messageId);
    expect(store.getDecision(decision)).toMatchObject({ state: "answered", choice: "closed", answeredBy: "bob", answeredVia: "telegram" });
  });
});
