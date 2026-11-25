/**
 * A restore brings back a backup's chat pairings, pairing codes and chat buttons, and a binding's liveness reads the
 * account generation, which a restore leaves as it was. So a chat unpaired after the backup would act and approve again
 * once the backup is restored. The restore retires them all before the swap: every binding (with its rooms), every
 * outstanding code and every button or prompt, checked by postcondition.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { backupNow, restoreDatabase } from "../../src/backup.js";
import { ChatCore, chatHash } from "../../src/chat-core.js";
import { hasLiveDecideTokens } from "../../src/chat-decide.js";
import { addApprover } from "../../src/scope.js";
import { openStore, type Store } from "../../src/store.js";

const NOW = new Date("2026-09-28T05:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
let dir: string, file: string, store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-restore-chat-")); file = join(dir, "orders.db"); store = openStore(file); });
afterEach(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const pair = (chat: ChatCore, code: string, approver: string, member: string, now: Date) => {
  chat.savePairing({ hash: chatHash(code), installation: "bot-1", approver, generation: store.accountOf(approver)!.generation, by: approver }, now);
  const done = chat.consumePairing({ hash: chatHash(code), installation: "bot-1", team: "t", app: "a", member, channel: `dm-${member}`, event: null }, now);
  if (!done.ok) throw Error(done.reason);
  return done.binding;
};

test("a chat unpaired after the backup can't act or approve after restoring it; the backup's codes and buttons are dead", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw Error("sam");
  const chat = new ChatCore(store, "telegram");
  const binding = pair(chat, "code-alex", "alex", "m-alex", NOW);
  // Sam's code is outstanding at the backup; an approve button rides alex's chat.
  chat.savePairing({ hash: chatHash("code-sam"), installation: null, approver: "sam", generation: store.accountOf("sam")!.generation, by: "sam" }, NOW);
  store.handle.prepare(`INSERT INTO chat_decide_action (token, channel, binding, chat, message, act, phase, task_id, run, digest, created_at, expires_at)
    VALUES ('d:approve', 'telegram', ?, 'dm-m-alex', 'msg-1', 'approve', 'offer', 't-1', NULL, 'digest', ?, ?)`).run(binding.id, NOW.toISOString(), at(600).toISOString());
  expect(chat.live(binding)).toBe(true);
  expect(hasLiveDecideTokens(store, "telegram", "dm-m-alex", "msg-1", at(1))).toBe(true);

  const made = await backupNow(store, file, "manual", () => NOW);
  if (!made.ok) throw Error(made.error);
  // After the backup the chat is unpaired (lost phone, say).
  expect(chat.revokeBinding(binding, at(1), "alex")).toBe(true);
  store.close();

  const done = await restoreDatabase({ databaseFile: file, file: made.file, dryRun: false, now: at(2) });
  expect(done.ok).toBe(true);
  expect(done.retired).toMatchObject({ chatBindings: 1, chatPairings: 1, chatActions: 1 });

  store = openStore(file);
  const after = new ChatCore(store, "telegram");
  // The binding the backup carried is gone: it can't act, approve or deliver.
  expect(after.bindingById(binding.id)).toBeNull();
  expect(after.live(binding)).toBe(false);
  expect(after.liveBindings("bot-1")).toEqual([]);
  expect(hasLiveDecideTokens(store, "telegram", "dm-m-alex", "msg-1", at(3))).toBe(false);
  // The backup's outstanding code pairs nothing.
  expect(after.consumePairing({ hash: chatHash("code-sam"), installation: "bot-1", team: "t", app: "a", member: "m-sam", channel: "dm-m-sam", event: null }, at(3)))
    .toEqual({ ok: false, reason: "unknown-code" });
  // A fresh pairing still works: the person re-pairs on purpose.
  expect(pair(after, "code-again", "alex", "m-alex", at(3))).toMatchObject({ approver: "alex" });
});
