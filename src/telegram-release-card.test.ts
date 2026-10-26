/**
 * A release card's Continue in Telegram (chat-management.md §0a.5): Telegram carries the terms only as a file, so
 * Approve appears only once that file was accepted. An upload Telegram refuses, or one that throws, leaves the card
 * without Approve (its Approve and Cancel never act) and with a fresh Continue that sends the file again.
 * Codex review of 0.9.73, finding 6.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { releaseTermsFor } from "./release-carry.js";
import { setChatApproval } from "./chat-approval.js";
import { verifyApproverStanding } from "./principal.js";
import { decideOffer, mintDecideButtons } from "./chat-decide.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const BOT = "777000", USER = 31337;
let dir: string, repo: string, root: string, store: Store;
type Call = { method: string; params: Record<string, unknown> };
let calls: Call[], updates: unknown[][], documentFault: "throw" | "refuse" | null;

const transport: TelegramTransport = async (method, params) => {
  if (method === "getUpdates") return { ok: true, result: updates.shift() ?? [] };
  calls.push({ method, params });
  if (method === "sendDocument") {
    if (documentFault === "throw") throw new Error("socket hang up");
    if (documentFault === "refuse") return { ok: false, description: "Bad Request: file is too big" };
  }
  return { ok: true, result: method === "sendMessage" || method === "sendDocument" ? { message_id: 500 + calls.length } : true };
};
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-telegram-release-")));
  repo = join(dir, "project"); root = join(dir, "evidence");
  mkdirSync(repo); mkdirSync(root);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n"); git("add", "-A"); git("commit", "-q", "-m", "The last release");
  const baseline = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "b\n"); git("add", "-A"); git("commit", "-q", "-m", "Release candidate");
  calls = []; updates = []; documentFault = null;
  store = openStore(join(dir, "orders.db"));
  store.upsertProject(repo, "project", NOW, { remoteUrl: "https://github.com/example-invalid/project.git" });
  if (!addApprover(store, "alex", NOW).ok) throw new Error("approver");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs --full", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  if (!setChatApproval(store, { approver: "alex", scope: "*", enabled: true, limits: { fullAccess: true, capMicrousd: null }, via: "test" }, NOW).ok) throw new Error("chat approval");
  // The last verified release on the plane's record, so the card's change list reads from Git objects.
  recordRelease(baseline, "0.9.72");
  // A private chat: Telegram makes its id the person's own.
  const code = mintPairingCode();
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, NOW);
  if (!store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(USER), userId: String(USER), updateId: 1 }, NOW).ok) throw new Error("pairing");
});
function recordRelease(merge: string, version: string): void {
  const id = Number(store.handle.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree, tip_sha, tip_task,
    policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at) VALUES (?,1,?,1,'b','main','t','d',?,?,?,'t','{}','p',1,'v','a','merged',?,?)`)
    .run(repo, version, merge, merge, merge, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  store.handle.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, external_ref, reserved_at, finished_at) VALUES (?,?, 'merge', 't', ?, 1, 'succeeded', ?, ?, ?)")
    .run(`op-${id}`, id, merge, merge, NOW.toISOString(), NOW.toISOString());
}
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A deploy gate filed as `toolroll release` files one, and its card's Continue, on message 77. */
function continueToken(): string {
  const candidate = git("rev-parse", "HEAD");
  store.createTask({ id: "release-0.9.73", title: "Release 0.9.73" }, NOW);
  store.placeTask(store.refFor("built-in", "release-0.9.73").id, repo, {}, NOW);
  const terms = releaseTermsFor(store, { repo, version: "0.9.73", branch: "release-0.9.73", pr: 260, candidate, now: NOW });
  if (!terms.ok) throw new Error(terms.why);
  propose(store, { taskId: "release-0.9.73", goal: "Verify 0.9.73", candidate, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseTerms: terms.terms, now: NOW });
  const binding = store.liveTelegramBinding(BOT)!;
  const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
  if (!who.ok) throw new Error("standing");
  const offer = decideOffer(store, { kind: "plan", taskId: "release-0.9.73" }, who.who, NOW, "telegram", root);
  if (offer === null) throw new Error("no release card");
  const seat = { channel: "telegram" as const, binding: binding.id, chat: binding.chatId, approver: "alex", generation: binding.approverGeneration };
  return mintDecideButtons(store, seat, { kind: "plan", taskId: "release-0.9.73" }, offer, NOW, "77").tokens[0]!;
}
let nextUpdate = 10;
async function tap(token: string): Promise<{ labels: string[]; tokens: string[]; text: string }> {
  updates.push([{ update_id: nextUpdate++, callback_query: { id: "cb", data: token, from: { id: USER }, message: { message_id: 77, chat: { id: USER } } } }]);
  await bridgePass(store, { botId: BOT, transport, clock: () => NOW, deliver: false, readProjects: async () => [repo],
    conversation: { evidenceRoot: root, subscriptionRunner: async () => { throw new Error("no turns here"); }, phoneOrigin: () => null } } as Parameters<typeof bridgePass>[1]);
  const edit = calls.filter(call => call.method === "editMessageText").at(-1)!;
  const keys = ((edit.params["reply_markup"] as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard).flat();
  return { labels: keys.map(one => one.text), tokens: keys.flatMap(one => one.callback_data === undefined ? [] : [one.callback_data]), text: String(edit.params["text"]) };
}
const live = (token: string) => store.handle.prepare("SELECT 1 FROM chat_decide_action WHERE token = ? AND consumed_at IS NULL").get(token) !== undefined;
const sealed = () => store.getScope("release-0.9.73")!.approvedAt !== null;

test.each(["refuse", "throw"] as const)("a terms file Telegram %ss leaves no Approve; Continue sends it again, and only then is Approve shown", async fault => {
  documentFault = fault;
  const first = await tap(continueToken());
  expect(calls.filter(call => call.method === "sendDocument")).toHaveLength(1);
  expect(first.labels).toEqual(["Continue"]);
  expect(first.text).toContain("The terms file didn't arrive, so Approve isn't shown.");
  // The Approve and Cancel minted for the card never act: none is live but the fresh Continue.
  const minted = store.handle.prepare("SELECT token, phase FROM chat_decide_action WHERE consumed_at IS NULL").all().map(row => [String(row["token"]), String(row["phase"])]);
  expect(minted).toEqual([[first.tokens[0], "offer"]]);
  expect(sealed()).toBe(false);
  // Delivered now: the file first, then Approve.
  documentFault = null;
  const again = await tap(first.tokens[0]!);
  expect(calls.filter(call => call.method === "sendDocument")).toHaveLength(2);
  expect(again.labels).toEqual(["Approve", "Cancel"]);
  expect(again.tokens.every(live)).toBe(true);
  expect(live(first.tokens[0]!)).toBe(false);
});

test.each([null, "refuse", "throw"] as const)("a release that changed while it was read is shown again through the same gate (upload %s) (0.9.73 review round 2, finding 4)", async fault => {
  const continued = await tap(continueToken());
  expect(continued.labels).toEqual(["Approve", "Cancel"]);
  // The release changes before Approve: a later release is now the last verified one, so the change list differs.
  recordRelease(git("rev-parse", "HEAD"), "0.9.72-1");
  documentFault = fault;
  const documents = calls.filter(call => call.method === "sendDocument").length;
  const refreshed = await tap(continued.tokens[0]!);
  // The new terms were sent; Approve (bound to the new card) only when they arrived, else a Continue to send them again.
  expect(calls.filter(call => call.method === "sendDocument")).toHaveLength(documents + 1);
  expect(refreshed.text).toContain("This release changed while you were reading.");
  expect(refreshed.labels).toEqual(fault === null ? ["Approve", "Cancel"] : ["Continue"]);
  expect(refreshed.tokens.every(live)).toBe(true);
  expect(sealed()).toBe(false);
  if (fault === null) return;
  documentFault = null;
  expect((await tap(refreshed.tokens[0]!)).labels).toEqual(["Approve", "Cancel"]);
});
