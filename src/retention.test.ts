/**
 * Retention (v105): how long evidence and logs, finished checkout records,
 * chat messages and notifications are kept (evidence 28 days and the rest
 * forever until someone chooses),
 * the daily sweep that deletes what is older and says so in the ledger once,
 * and what is never deleted: the ledger, and anything a task still needs.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { readVerifiedArtifact, storeEvidence } from "./evidence.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { dailyRetention, parsePeriod, periodLabel, periodWords, retentionPlan, sweepRetention } from "./retention.js";

let dir: string, file: string, root: string, store: Store;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const OLD = new Date("2026-05-01T12:00:00.000Z");
const REPO = "/repo/shop";
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-retention-"));
  file = join(dir, "orders.db");
  root = join(dir, "evidence");
  mkdirSync(root);
  store = openStore(file);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };
let serial = 0;
type Finish = "completed" | "ready" | "queued" | "failed" | "cancelled" | "held";
/** A task with one finished run at `at` and a saved check log, left in the state `finish` names. */
function work(finish: Finish, at = OLD): { id: string; ref: number; run: number; artifact: number } {
  const id = `t-${++serial}`;
  store.createTask({ id, title: id }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${serial}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/w/${id}`, route: legacy, now: at });
  const artifact = storeEvidence(store, root, run, "check-log", "check.log", Buffer.from("x".repeat(40_000)), "the check", at, { captureStatus: "ok" });
  store.finishRun(run, { outcome: "built", now: at });
  if (finish === "completed" || finish === "ready" || finish === "held") store.setTaskState(id, "done", at);
  if (finish === "failed") store.setTaskState(id, "failed", at);
  if (finish === "cancelled") store.setTaskState(id, "cancelled", at);
  if (finish === "completed" || finish === "held") {
    store.recordAction({ at: at.toISOString(), actor: "operator:alex", repo: REPO, taskId: id, runId: run, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  }
  if (finish === "held") store.hold(ref, "waiting on legal", null, at);
  return { id, ref, run, artifact };
}

const ledgerCount = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()!["n"]);
const everything = (days: number) => { for (const kind of ["evidence", "checkouts", "chat", "notifications"] as const) store.setRetentionPeriod(kind, days, "alex", NOW); };

test("periods: evidence 28 days and the rest forever by default; a day count, weeks or years from 1 day to 10 years; each change is in the ledger with before → after", () => {
  expect(store.retentionPeriods()).toEqual({ evidence: 28, checkouts: null, chat: null, notifications: null });
  expect(parsePeriod("forever")).toBeNull();
  expect(parsePeriod("1d")).toBe(1);
  expect(parsePeriod("1")).toBe(1);
  expect(parsePeriod("90")).toBe(90);
  expect(parsePeriod("90d")).toBe(90);
  expect(parsePeriod("12w")).toBe(84);
  expect(parsePeriod("1y")).toBe(365);
  for (const bad of ["0d", "0", "11y", "-5", "soon", ""]) expect(parsePeriod(bad)).toBeUndefined();
  expect([periodWords(null), periodWords(1), periodWords(30), periodWords(365), periodWords(730)]).toEqual(["forever", "1 day", "30 days", "1 year", "2 years"]);
  expect([periodLabel("evidence", 28, false), periodLabel("evidence", 1, true), periodLabel("evidence", 30, true), periodLabel("chat", 30, true)])
    .toEqual(["28 days (default)", "1 day", "30 days (custom)", "30 days"]);

  store.setRetentionPeriod("chat", 90, "alex", NOW);
  store.setRetentionPeriod("chat", 90, "alex", NOW);
  store.setRetentionPeriod("chat", null, "alex", NOW);
  expect(store.retentionPeriods().chat).toBeNull();
  const changes = store.actionLedger({ repos: null }).filter(one => one.action === "retention changed: chat");
  expect(changes.map(one => one.detail).sort()).toEqual(["90 days → forever", "forever → 90 days"]);
  expect(changes.every(one => one.source === "policy" && one.actor === "alex")).toBe(true);
});

test("with every period forever the sweep deletes nothing and writes nothing", () => {
  const done = work("completed");
  store.setRetentionPeriod("evidence", null, "alex", NOW);
  const before = ledgerCount();
  const swept = sweepRetention(store, root, NOW);
  expect(swept).toMatchObject({ counts: [], freed: 0, ledgerId: null });
  expect(ledgerCount()).toBe(before);
  expect(readVerifiedArtifact(root, store.artifactsFor(done.run)[0]!).ok).toBe(true);
});

test("the sweep removes only evidence older than its period, and never what a task still needs; one ledger entry says what and how much", () => {
  const completed = work("completed");
  const cancelled = work("cancelled");
  const recent = work("completed", new Date(NOW.getTime() - 5 * DAY));
  const ready = work("ready");
  const queued = work("queued");
  const failed = work("failed");
  const held = work("held");
  store.setRetentionPeriod("evidence", 30, "alex", NOW);
  const before = ledgerCount();

  const preview = retentionPlan(store, root, NOW);
  expect(preview.items.evidence.map(one => one.run).sort()).toEqual([completed.run, cancelled.run].sort());
  expect(existsSync(join(root, String(completed.run), "check.log"))).toBe(true);

  const swept = sweepRetention(store, root, NOW);
  const evidence = swept.counts.find(one => one.kind === "evidence")!;
  expect(evidence.count).toBe(2);
  expect(swept.freed).toBeGreaterThanOrEqual(80_000);
  for (const gone of [completed, cancelled]) {
    const read = readVerifiedArtifact(root, store.artifactsFor(gone.run)[0]!);
    expect(read).toEqual({ ok: false, problem: "the file was removed by the retention setting" });
    // The record of what it was stays.
    expect(store.artifactsFor(gone.run)).toHaveLength(1);
  }
  for (const kept of [recent, ready, queued, failed, held]) expect(readVerifiedArtifact(root, store.artifactsFor(kept.run)[0]!).ok).toBe(true);

  // Exactly one ledger entry for the sweep; the ledger only grew.
  expect(ledgerCount()).toBe(before + 1);
  const entry = store.actionLedger({ repos: null }).find(one => one.id === swept.ledgerId)!;
  expect(entry).toMatchObject({ action: "retention sweep", outcome: "removed", source: "policy", actor: "worker" });
  expect(entry.detail).toMatch(/^2 runs' evidence; about \d+ KB freed$/);

  // Nothing left to remove: the next sweep says so and frees nothing.
  const again = sweepRetention(store, root, new Date(NOW.getTime() + DAY));
  expect(again.freed).toBe(0);
  expect(store.actionLedger({ repos: null }).find(one => one.id === again.ledgerId)!.detail).toBe("nothing was due");
});

test("chat messages, notifications and finished checkout records older than their periods go; newer ones and those a task needs stay", () => {
  const open = work("queued");
  const finished = work("completed");
  const thread = (scope: "lead" | "task", key: string | null) => Number(store.handle.prepare("INSERT INTO mate_thread (approver, ceiling_digest, opened_at, scope_kind, scope_key) VALUES ('alex', 'd', ?, ?, ?)").run(OLD.toISOString(), scope, key).lastInsertRowid);
  const lead = thread("lead", null), openTask = thread("task", open.id);
  const oldMessage = store.appendMateMessage({ thread: lead, turn: null, role: "operator", text: "what's running?" }, OLD);
  const newMessage = store.appendMateMessage({ thread: lead, turn: null, role: "assistant", text: "two builds" }, new Date(NOW.getTime() - DAY));
  const neededMessage = store.appendMateMessage({ thread: openTask, turn: null, role: "operator", text: "keep the old API" }, OLD);

  const notify = (key: string, at: Date, resolved: boolean, source?: { taskRef: number }) => {
    store.enqueueNotification({ dedupeKey: key, kind: "note", subject: key, body: "body", ...(source === undefined ? {} : { source }) }, at);
    if (resolved) store.resolveEpisode(key, at);
  };
  notify("old-resolved", OLD, true);
  notify("old-waiting", OLD, false);
  notify("old-open-task", OLD, false, { taskRef: open.ref });
  notify("new-resolved", new Date(NOW.getTime() - DAY), true);
  store.handle.prepare("INSERT INTO notification_delivery (notification, destination, delivered_at) SELECT id, 'telegram:1', ? FROM notification WHERE dedupe_key = 'old-resolved'").run(OLD.toISOString());

  const checkout = (path: string, ref: number, released: Date) => store.handle.prepare("INSERT INTO worktree (path, repo, branch, task_ref, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(path, REPO, `b-${path.length}-${ref}`, ref, released.toISOString(), released.toISOString());
  const onDisk = join(dir, "still-here");
  mkdirSync(onDisk);
  checkout(join(dir, "gone"), finished.ref, OLD);
  checkout(join(dir, "gone-open"), open.ref, OLD);
  checkout(onDisk, finished.ref, OLD);

  everything(30);
  const swept = sweepRetention(store, root, NOW);
  const count = (kind: string) => swept.counts.find(one => one.kind === kind)!.count;
  expect([count("chat"), count("notifications"), count("checkouts")]).toEqual([1, 1, 1]);

  const messages = store.handle.prepare("SELECT id FROM mate_message ORDER BY id").all().map(row => Number(row["id"]));
  expect(messages).toEqual([newMessage, neededMessage]);
  expect(messages).not.toContain(oldMessage);
  const notifications = store.handle.prepare("SELECT dedupe_key FROM notification WHERE dedupe_key NOT LIKE 'life:%' ORDER BY id").all().map(row => String(row["dedupe_key"]));
  expect(notifications).toEqual(["old-waiting", "old-open-task", "new-resolved"]);
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification_delivery").get()!["n"]).toBe(0);
  const checkouts = store.listWorktrees().map(row => row.path).sort();
  expect(checkouts).toEqual([join(dir, "gone-open"), onDisk].sort());
  const detail = store.actionLedger({ repos: null }).find(one => one.id === swept.ledgerId)!.detail!;
  expect(detail).toContain("1 checkout record, 1 chat message, 1 notification");
  expect(detail).toMatch(/about \d+ KB freed$/);
});

test("the action ledger is never removed, whatever the periods", () => {
  work("completed");
  everything(7);
  const before = store.handle.prepare("SELECT id FROM action_ledger ORDER BY id").all().map(row => Number(row["id"]));
  expect(before.length).toBeGreaterThan(0);
  sweepRetention(store, root, new Date("2030-01-01T00:00:00.000Z"));
  const after = store.handle.prepare("SELECT id FROM action_ledger ORDER BY id").all().map(row => Number(row["id"]));
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after).toHaveLength(before.length + 1);
  expect(store.ledgerChain({ full: true }).ok).toBe(true);
});

test("the sweep runs once a day", () => {
  const first = work("completed");
  everything(30);
  expect(dailyRetention(store, root, NOW)).not.toBeNull();
  const second = work("completed");
  expect(dailyRetention(store, root, new Date(NOW.getTime() + DAY - 1))).toBeNull();
  expect(readVerifiedArtifact(root, store.artifactsFor(second.run)[0]!).ok).toBe(true);
  expect(dailyRetention(store, root, new Date(NOW.getTime() + DAY))).not.toBeNull();
  expect(readVerifiedArtifact(root, store.artifactsFor(second.run)[0]!).ok).toBe(false);
  expect(readVerifiedArtifact(root, store.artifactsFor(first.run)[0]!).ok).toBe(false);
});

test("evidence keeps 28 days only while nobody chose: a saved choice, forever included, replaces it", () => {
  const old = work("completed", new Date(NOW.getTime() - 40 * DAY));
  const young = work("completed", new Date(NOW.getTime() - 20 * DAY));
  expect(store.retentionChosen()).toEqual({});
  expect(retentionPlan(store, root, NOW).items.evidence.map(one => one.run)).toEqual([old.run]);
  store.setRetentionPeriod("evidence", null, "alex", NOW);
  expect(store.retentionPeriods().evidence).toBeNull();
  expect(store.retentionChosen()).toEqual({ evidence: null });
  expect(retentionPlan(store, root, NOW).items.evidence).toEqual([]);
  store.setRetentionPeriod("evidence", 1, "alex", NOW);
  expect(store.retentionPeriods().evidence).toBe(1);
  expect(retentionPlan(store, root, NOW).items.evidence.map(one => one.run).sort((a, b) => a - b)).toEqual([old.run, young.run].sort((a, b) => a - b));
  expect(store.actionLedger({ repos: null }).filter(one => one.action === "retention changed: evidence").map(one => one.detail).sort())
    .toEqual(["28 days → forever", "forever → 1 day"]);
});

test("a 1-day sweep never removes what a task still needs: Ready for review, unfinished, failed, on hold, live or a release candidate", () => {
  const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY);
  const completed = work("completed", twoDaysAgo);
  const ready = work("ready", twoDaysAgo);
  const queued = work("queued", twoDaysAgo);
  const failed = work("failed", twoDaysAgo);
  const held = work("held", twoDaysAgo);
  const live = work("completed", twoDaysAgo);
  store.startRun({ taskRef: live.ref, leaseId: "l-live", runner: "b2", branch: `standing-orders/${live.id}-2`, worktree: `/w/${live.id}-2`, route: legacy, now: NOW });
  const candidate = work("completed", twoDaysAgo);
  store.handle.prepare("INSERT INTO task_scope (task_id, goal, proposed_at, digest, candidate) VALUES (?, 'g', ?, 'd', 'abc')").run(candidate.id, NOW.toISOString());
  store.setRetentionPeriod("evidence", 1, "alex", NOW);

  const swept = sweepRetention(store, root, NOW);
  expect(swept.counts.find(one => one.kind === "evidence")!.count).toBe(1);
  expect(readVerifiedArtifact(root, store.artifactsFor(completed.run)[0]!)).toEqual({ ok: false, problem: "the file was removed by the retention setting" });
  for (const kept of [ready, queued, failed, held, live, candidate]) expect(readVerifiedArtifact(root, store.artifactsFor(kept.run)[0]!).ok).toBe(true);
});

test("an older file's retention_setting (7 days or more) is rebuilt for 1 day, keeping every choice", () => {
  const db = store.handle;
  db.exec("DROP TABLE retention_setting");
  db.exec(`CREATE TABLE retention_setting (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('evidence', 'checkouts', 'chat', 'notifications')),
  days       INTEGER CHECK (days IS NULL OR (days >= 7 AND days <= 3650)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
  const insert = db.prepare("INSERT INTO retention_setting (kind, days, updated_by, updated_at) VALUES (?, ?, 'alex', ?)");
  insert.run("evidence", 30, OLD.toISOString());
  insert.run("chat", null, OLD.toISOString());
  insert.run("notifications", 365, OLD.toISOString());
  expect(() => insert.run("checkouts", 1, OLD.toISOString())).toThrow();
  const before = db.prepare("SELECT * FROM retention_setting ORDER BY kind").all();
  // That build's file reads older than this one (every DDL change bumps the version since v114).
  db.exec("UPDATE schema_version SET version = 113");
  store.close();

  store = openStore(file);
  expect(store.handle.prepare("SELECT * FROM retention_setting ORDER BY kind").all()).toEqual(before);
  expect(store.retentionPeriods()).toEqual({ evidence: 30, checkouts: null, chat: null, notifications: 365 });
  expect(periodLabel("evidence", 30, true)).toBe("30 days (custom)");
  store.setRetentionPeriod("evidence", 1, "alex", NOW);
  expect(store.retentionPeriods().evidence).toBe(1);
  // Opening again leaves the widened table as it is.
  store.close();
  store = openStore(file);
  expect(store.retentionPeriods()).toEqual({ evidence: 1, checkouts: null, chat: null, notifications: 365 });
});

test("the command line shows periods, previews without deleting, and sets them for an instance operator", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const done = work("completed", new Date(Date.now() - 400 * DAY));
  store.close();
  let lines: string[] = [];
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("retention", argv, line => { lines.push(line); }, { databaseFile: file, evidenceRoot: root }); return { code, out: lines.join("\n") }; };
  try {
    expect(JSON.parse((await run(["show", "--json"])).out)).toMatchObject({ ok: true, periods: { evidence: 28, checkouts: null, chat: null, notifications: null }, defaulted: ["evidence", "checkouts", "chat", "notifications"] });
    expect((await run(["show"])).out).toMatch(/evidence\s+28 days \(default\)/);
    expect((await run(["preview"])).out).toContain("1 run's evidence older than 28 days");
    expect((await run(["set", "evidence", "90d", "--json"])).code).toBe(3);
    expect((await run(["set", "evidence", "0d", "--as", "alex", "--token", alex.token])).code).toBe(2);
    expect((await run(["set", "evidence", "1d", "--as", "alex", "--token", alex.token])).out).toContain("Run evidence and logs: kept for 1 day.");
    expect((await run(["show"])).out).toMatch(/evidence\s+1 day\s/);
    expect((await run(["set", "evidence", "90d", "--as", "alex", "--token", alex.token])).out).toContain("Run evidence and logs: kept for 90 days.");
    expect((await run(["show"])).out).toMatch(/evidence\s+90 days \(custom\)/);
    expect(JSON.parse((await run(["show", "--json"])).out).defaulted).toEqual(["checkouts", "chat", "notifications"]);
    const preview = await run(["preview", "--json"]);
    expect(JSON.parse(preview.out).counts.find((one: { kind: string }) => one.kind === "evidence")).toMatchObject({ count: 1, days: 90 });
    expect((await run(["preview"])).out).toContain("1 run's evidence older than 90 days");
    expect(existsSync(join(root, String(done.run), "check.log"))).toBe(true);
  } finally {
    store = openStore(file);
  }
  expect(store.actionLedger({ repos: null }).filter(one => one.action === "retention sweep")).toEqual([]);
});

test("Settings → Retention is an instance operator's; saving takes the password and the ledger keeps each change", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [REPO], "alex", NOW)).toEqual({ ok: true });
  const server = createDecisionServer({ store, evidenceRoot: root, repo: REPO });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = await (await fetch(`${base}/settings/retention`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Retention</h1>");
    expect(page).toContain("Nothing is old enough to remove yet.");
    expect(page).toMatch(/<select id="keep-evidence" name="evidence"><option value="1">1 day<\/option><option value="7">7 days<\/option><option value="14">14 days<\/option><option value="28" selected>28 days \(default\)<\/option><option value="forever">Forever<\/option><\/select>/);
    expect(page).toMatch(/<select id="keep-chat" name="chat">.*<option value="forever" selected>Forever \(default\)<\/option>/);
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetch(`${base}/settings/retention`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    const choices = { evidence: "1", checkouts: "365", chat: "forever", notifications: "30" };
    expect((await post({ ...choices, password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(store.retentionPeriods()).toEqual({ evidence: 28, checkouts: null, chat: null, notifications: null });
    // Only the periods the page offers for each kind save.
    for (const bad of ["2", "365"]) expect((await post({ ...choices, evidence: bad, password: alex.token })).headers.get("location")).toContain("problem=");
    expect((await post({ ...choices, chat: "1", password: alex.token })).headers.get("location")).toContain("problem=");
    expect(store.retentionChosen()).toEqual({});
    expect((await post({ ...choices, password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.retentionPeriods()).toEqual({ evidence: 1, checkouts: 365, chat: null, notifications: 30 });
    expect(store.actionLedger({ repos: null }).filter(one => one.action.startsWith("retention changed")).map(one => one.detail).sort())
      .toEqual(["28 days → 1 day", "forever → 1 year", "forever → 30 days"]);
    const saved = await (await fetch(`${base}/settings/retention`, { headers: { cookie } })).text();
    expect(saved).toContain('<option value="1" selected>1 day</option>');
    expect(saved).toContain('<option value="365" selected>1 year</option>');
    expect(saved).toContain('<option value="forever" selected>Forever (default)</option>');
    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/settings/retention`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a completed task's evidence stays while any revision below it is unfinished (Ready included), at any depth", () => {
  const parent = work("completed");
  const child = work("completed");
  const grandchild = work("ready");
  store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(parent.id, child.ref);
  store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(child.id, grandchild.ref);
  const lone = work("completed");
  store.setRetentionPeriod("evidence", 30, "alex", NOW);
  // The Ready grandchild's review still reads its ancestors' evidence: neither ancestor's goes, nor its own.
  expect(retentionPlan(store, root, NOW).items.evidence.map(one => one.run)).toEqual([lone.run]);
  // Once it's completed too, the whole family's can go.
  store.recordAction({ at: NOW.toISOString(), actor: "operator:alex", repo: REPO, taskId: grandchild.id, runId: grandchild.run, action: COMPLETION_ACTION, outcome: "b".repeat(64), source: "work" });
  expect(retentionPlan(store, root, NOW).items.evidence.map(one => one.run).sort((a, b) => a - b)).toEqual([parent.run, child.run, grandchild.run, lone.run].sort((a, b) => a - b));
});
