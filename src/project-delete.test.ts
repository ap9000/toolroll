/**
 * Deleting a project: everything Toolroll holds for it goes (tasks and
 * their versions, runs, evidence, checkouts and the branches it made, chats,
 * flows and cards, subagents, budgets, settings), never while its work runs,
 * never the repository or branches it didn't make, never another project's
 * rows; the ledger keeps every entry, still verifies, and says who deleted
 * what. The console asks for the name, then the password; so does the CLI's
 * --yes.
 */
import { setLiveCommands } from "./live-detail.js";
import { verifiedAuthor } from "./store.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { deleteProject, holdingsWords, MODEL_SETTINGS, PROJECT_SETTINGS, projectHoldings, projectRunning } from "./project-delete.js";
import { modelsGenerationOf } from "./route-store.js";
import { watchObservation } from "./flaky.js";

let dir: string, file: string, store: Store, repo: string, evidence: string, pool: string;
const OTHER = "/repo/other";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-project-delete-")));
  file = join(dir, "orders.db");
  evidence = join(dir, "evidence");
  pool = join(dir, "worktrees");
  repo = join(dir, "shop");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "shop\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "first");
  // A branch of the project's own, and one Toolroll made with a commit only it has.
  git("branch", "feature/login");
  store = openStore(file);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

let serial = 0;
/** A task in `where` with one finished run, its evidence on disk, and (for the shop) its branch and checkout. */
function task(where: string, revisionOf?: string): { id: string; ref: number; run: number } {
  const id = `t-${++serial}`;
  store.createTask({ id, title: `Task ${id}`, filedBy: { name: "alex", kind: "person" } }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, where);
  if (revisionOf !== undefined) store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(revisionOf, ref);
  // New tasks build on toolroll/<id>; ones from before the rename on standing-orders/<id>. Both are Toolroll's own.
  const branch = `${serial % 2 === 1 ? "toolroll" : "standing-orders"}/${id}`;
  const worktree = join(pool, `shop-${id}`);
  if (where === repo) {
    git("worktree", "add", "-q", "-b", branch, worktree, "main");
    writeFileSync(join(worktree, "work.txt"), `${id}\n`);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "x", "--allow-empty"], { cwd: worktree });
    store.saveWorktree({ path: worktree, repo, branch, runner: null, taskRef: ref, createdAt: NOW.toISOString(), leasedAt: null, releasedAt: NOW.toISOString(), verified: true });
  }
  const run = store.startRun({ taskRef: ref, leaseId: `l-${serial}`, runner: "b1", branch, worktree, route: legacy, now: NOW });
  mkdirSync(join(evidence, String(run)), { recursive: true });
  writeFileSync(join(evidence, String(run), "diff.patch"), "+x\n");
  store.saveArtifact({ run, kind: "diff", key: `${run}/diff.patch`, bytesOriginal: 3, bytesStored: 3, truncated: false, sha256: "0".repeat(64), capture: "git diff" }, NOW);
  store.recordUsage(run, { costUsd: 1 });
  store.finishRun(run, { outcome: "built", now: NOW });
  return { id, ref, run };
}

/** A project's learning-loops rows (v149), the decision tables' guards and the merge's own included. */
function learningRows(where: string, first: { ref: number; run: number }): void {
  const at = NOW.toISOString();
  store.handle.prepare("INSERT INTO check_fact (run, repo, task_ref, purpose, learn_state, recorded_at) VALUES (?, ?, ?, 'ordinary', 'not-asked', ?)").run(first.run, where, first.ref, at);
  store.handle.prepare("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, 'check', 'passed', 'receipt', ?)").run(first.run, at);
  watchObservation(store, { repo: where, identity: "unit:src/a.test.ts::adds", observation: first.run, now: NOW });
  const decision = (claim: string) => Number(store.handle.prepare(`INSERT INTO project_decision (repo, identity, claim, why, status, decided_by, decided_at, source_kind, recorded_by, sha)
    VALUES (?, 'id', ?, 'why', 'active', 'alex', ?, 'manual', 'alex', 'sha') RETURNING id`).get(where, claim, at)!["id"]);
  const [a, b] = [decision("A"), decision("B")];
  store.handle.prepare("INSERT INTO decision_merge (merge, successor, successor_revision, predecessor, predecessor_revision, at, by) VALUES (?, ?, 1, ?, 1, ?, 'alex')").run(first.run, b, a, at);
}
const learningCounts = (where: string) => ({
  facts: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM check_fact WHERE repo = ?").get(where)!["n"]),
  results: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM check_result WHERE run IN (SELECT run FROM check_fact WHERE repo = ?)").get(where)!["n"]),
  watches: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM learning_watch WHERE repo = ?").get(where)!["n"]),
  merges: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM decision_merge WHERE successor IN (SELECT id FROM project_decision WHERE repo = ?)").get(where)!["n"]),
});

/** Everything a project can have: tasks and a version, runs and evidence, a chat, a flow and card, a subagent, budgets, settings, knowledge. */
function populate(where: string) {
  const first = task(where);
  const second = task(where, first.id);
  const flow = store.createFlow({ repo: where, name: "Support", definitionJson: JSON.stringify({ stages: [{ id: "inbox", name: "Inbox" }] }), by: "alex" }, NOW);
  const card = store.addFlowCard({ flow, title: "Refund", description: null, stage: "inbox", by: "alex", byKind: "person" }, NOW);
  store.addFlowComment({ card, author: "alex", body: "Looking", mentions: [] }, NOW);
  const mate = store.createSubagent({ repo: where, handle: `maya${serial}`, soul: "---\nname: Maya\n---\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  store.addSubagentTurn({ subagent: mate, card, model: "sonnet", ok: true, ms: 5, costUsd: 0.1 }, NOW);
  const thread = store.openLeadThread("alex", "d", NOW, { kind: "project", key: where }).thread.id;
  store.appendLeadMessage({ thread, turn: null, role: "operator", text: "How is the shop?" }, NOW);
  const taskThread = store.openLeadThread("alex", "d", NOW, { kind: "task", key: first.id }).thread.id;
  store.appendLeadMessage({ thread: taskThread, turn: null, role: "operator", text: "Status?" }, NOW);
  store.setBudget({ scope: "project", key: where, limitMicrousd: 5_000_000, hardStop: true }, "alex", NOW);
  store.setBudget({ scope: "subagent", key: String(mate), limitMicrousd: 1_000_000, hardStop: true }, "alex", NOW);
  store.setApprovalRules(where, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", NOW);
  // The live view's "Show commands", and a steering note that reached a run (its history rows go with the run).
  setLiveCommands(store, { repo: where, commands: true, by: "alex", via: "test" }, NOW);
  const steered = store.fileSteerNote(first.id, verifiedAuthor("alex"), "look at the retry path", NOW);
  if (steered.ok) store.markSteerMailed(steered.id, first.run, NOW);
  // Knowledge history refuses deletes by design; a project's own goes with it.
  store.handle.prepare("INSERT INTO knowledge_change (repo, identity, revision, actor, at, payload, sha) VALUES (?, 'k', 1, 'alex', ?, '{}', 'x')").run(where, NOW.toISOString());
  store.upsertProject(where, where.split("/").pop()!, NOW);
  // Learning loops (v149): a check's facts and results, a tracked identity, and a merge of two of its decisions.
  learningRows(where, first);
  // Its Models rows and results-routing rows (v148): an override, a strong agent, another provider's candidate, an
  // earned rule and a result record.
  store.setPhaseConfig(where, "build", "claude", "claude-haiku-4-5", "alex", NOW);
  store.setPhaseTierConfig(where, "build", "strong", "claude", "claude-opus-4-1", "alex", NOW);
  store.setPhaseTierAlternate(where, "build", "routine", "codex", "gpt-5-codex", "alex", NOW);
  store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, state, grant_json, prices_json, depends_json, accepted_by, accepted_at)
    VALUES (?, 'small', 'rule', 'claude', 'claude-haiku-4-5', 'claude', 'active', '{}', '{}', '{}', 'alex', ?)`).run(where, NOW.toISOString());
  store.handle.prepare("INSERT INTO route_record (task_ref, repo, state, evaluated_at) VALUES (?, ?, 'pending', ?)").run(first.ref, where, NOW.toISOString());
  return { first, second, flow, card, mate, thread, taskThread };
}

/** Rows anywhere that name the project (by repo, project, path or scope), outside the ledger. */
function mentions(where: string): string[] {
  const found: string[] = [];
  for (const { name } of store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_%'").all() as { name: string }[]) {
    // The ledger keeps every entry; a Models generation counter only ever moves forward (results routing: a project
    // added again under the same path must never meet an old offer's generation), and holds nothing but a number.
    if (name === "action_ledger" || name === "models_generation") continue;
    const columns = store.handle.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row["name"])).filter(one => ["repo", "project", "path", "scope", "scope_key"].includes(one));
    for (const column of columns) if (Number(store.handle.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${column}" = ?`).get(where)!["n"]) > 0) found.push(`${name}.${column}`);
  }
  return found;
}
const count = (sql: string, ...params: unknown[]) => Number(store.handle.prepare(sql).get(...params)!["n"]);

/** A paired Telegram chat's messages, each about one task, each with its reply planned. Returns their event ids. */
function telegramTalk(about: Array<[string, number]>): string[] {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("approver fixture");
  store.createTelegramPairing({ codeHash: "c".repeat(64), approver: "alex", by: "alex", ttlMs: 60_000 }, NOW);
  const paired = store.consumeTelegramPairing({ codeHash: "c".repeat(64), botId: "777", chatId: "42", userId: "42", updateId: 1 }, NOW);
  if (!paired.ok) throw new Error("pairing fixture");
  return about.map(([taskId, update]) => {
    store.enqueueTelegramConversation({ binding: paired.binding, updateId: update, messageId: String(update), replyTo: null, request: `r-${update}`, text: `How is ${taskId}?`, context: null, taskId, sourceRun: null }, NOW);
    const claimed = store.claimTelegramConversation("777", "owner", 60_000, NOW)!;
    expect(store.planTelegramConversationParts(claimed.id, "owner", { session: 1, turn: 1 }, [{ kind: "reply", text: "Going well." }], NOW)).toBe(true);
    return `m${update}`;
  });
}

test("deleting a project removes what Toolroll holds for it and keeps everything else", async () => {
  const shop = populate(repo);
  const other = populate(OTHER);
  const before = { main: git("rev-parse", "main"), feature: git("rev-parse", "feature/login"), head: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain") };
  expect(projectHoldings(store, repo)).toMatchObject({ tasks: 1, versions: 1, runs: 2, evidence: 2, checkouts: 2, chats: 2, flows: 1, cards: 1, subagents: 1, budgets: 2 });
  expect(holdingsWords(projectHoldings(store, repo))).toContain("1 task, 1 version, 2 runs, 2 evidence files, 2 checkouts, 2 chats, 1 flow with 1 card, 1 subagent, 2 budgets");
  const otherBefore = projectHoldings(store, OTHER);
  // Another project's task that points at this project's evidence keeps everything but the pointer.
  const shared = Number(store.handle.prepare("SELECT id FROM artifact WHERE run = ?").get(shop.first.run)!["id"]);
  store.handle.prepare("UPDATE task_ref SET revision_brief_artifact = ? WHERE id = ?").run(shared, other.second.ref);
  expect(mentions(repo).length).toBeGreaterThan(5);

  // Each project's task came from a signed Sentry delivery (v126 task_source).
  const source = JSON.stringify({ label: "Sentry issue", verified: "sentry", external: { id: "1", url: "https://acme.sentry.io/issues/1/" }, receipt: "v3:sentry:id:1" });
  store.recordTaskSource(shop.first.id, { flow: 1, card: 1, entry: 1 }, source, NOW);
  store.recordTaskSource(other.first.id, { flow: 1, card: 1, entry: 1 }, source, NOW);

  // A paired Telegram chat asked about each project's task; each message has its reply planned (event ids are text, 'm…').
  const talk = telegramTalk([[shop.first.id, 501], [other.first.id, 502]]);
  expect(count("SELECT COUNT(*) AS n FROM chat_event WHERE provider = 'telegram' AND kind = 'message'")).toBe(2);
  // A typed yes to a Start card rode each message (one-step-chat.md C5); the one that stays started the shop's task.
  for (const event of talk) store.handle.prepare(`INSERT INTO chat_typed_start (provider, event, proposal, card_message, stamp, how, created, outcome, task_id, finished)
    VALUES ('telegram', ?, 999, '1', 's', 'next', ?, 'started', ?, ?)`).run(event, NOW.toISOString(), shop.first.id, NOW.toISOString());

  const generation = modelsGenerationOf(store, repo, "build");
  expect(learningCounts(repo)).toEqual({ facts: 1, results: 1, watches: 1, merges: 1 });
  const done = await deleteProject(store, repo, { actor: "alex", via: "command line", now: NOW, evidenceRoot: evidence, poolRoot: pool });
  expect(done).toMatchObject({ ok: true, removed: { tasks: 1, versions: 1, runs: 2, branches: 2, chats: 2, subagents: 1 }, left: [] });
  // Its Models rows went through the counter (so whatever depended on them paused), with its results-routing rows.
  expect(modelsGenerationOf(store, repo, "build")).toBe(generation + 1);
  for (const table of ["route_rule", "route_record"]) expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE repo = ?`, repo), table).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM route_rule WHERE repo = ?", OTHER)).toBe(1);
  // Its learning rows went with it, through the deletion's own lifted guards; the other project's stayed, guards back.
  expect(learningCounts(repo)).toEqual({ facts: 0, results: 0, watches: 0, merges: 0 });
  expect(learningCounts(OTHER)).toEqual({ facts: 1, results: 1, watches: 1, merges: 1 });
  expect(() => store.handle.prepare("DELETE FROM check_fact").run()).toThrow(/kept/);
  // Only forgetProjectModels deletes them: the generic settings list never names a Models table.
  expect(PROJECT_SETTINGS.map(([table]) => table).filter(table => MODEL_SETTINGS.some(([model]) => model === table))).toEqual([]);
  // The shop's message and its reply went with it; the other project's stayed.
  expect(store.handle.prepare("SELECT id FROM chat_event WHERE provider = 'telegram' AND kind = 'message'").all().map(row => row["id"])).toEqual([talk[1]]);
  expect(store.handle.prepare("SELECT event FROM chat_part WHERE provider = 'telegram'").all().map(row => row["event"])).toEqual([talk[1]]);
  // The typed yes on the shop's message went with it; the one on the message that stays no longer names the deleted task.
  expect(store.handle.prepare("SELECT event, outcome, task_id FROM chat_typed_start").all()).toEqual([{ event: talk[1], outcome: "started", task_id: null }]);

  // Where the deleted task came from goes with it: a task later made under the same id is never given that origin.
  expect(store.taskSourceOf(shop.first.id)).toBeNull();
  expect(store.taskSourceOf(other.first.id)).not.toBeNull();
  // Nothing names the project any more; its tasks, runs, chats, cards, subagent and evidence are gone.
  expect(mentions(repo)).toEqual([]);
  expect(count("SELECT COUNT(*) AS n FROM task WHERE id IN (?, ?)", shop.first.id, shop.second.id)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM run WHERE id IN (?, ?)", shop.first.run, shop.second.run)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM artifact WHERE run IN (?, ?)", shop.first.run, shop.second.run)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM lead_message WHERE thread IN (?, ?)", shop.thread, shop.taskThread)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM flow_comment WHERE card = ?", shop.card)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM subagent_turn WHERE subagent = ?", shop.mate)).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM budget WHERE scope_key IN (?, ?)", repo, String(shop.mate))).toBe(0);
  expect(existsSync(join(evidence, String(shop.first.run)))).toBe(false);
  // The other project is untouched, its evidence and knowledge history too.
  expect(projectHoldings(store, OTHER)).toEqual(otherBefore);
  expect(store.handle.prepare("SELECT repo, revision_brief_artifact FROM task_ref WHERE id = ?").get(other.second.ref)).toEqual({ repo: OTHER, revision_brief_artifact: null });
  expect(existsSync(join(evidence, String(other.first.run), "diff.patch"))).toBe(true);
  expect(count("SELECT COUNT(*) AS n FROM knowledge_change WHERE repo = ?", OTHER)).toBe(1);
  // The history guards are back: the other project's knowledge still refuses a delete.
  expect(() => store.handle.prepare("DELETE FROM knowledge_change WHERE repo = ?").run(OTHER)).toThrow(/immutable/);

  // The repository: its own branches, HEAD and working copy exactly as they were; Toolroll's branches and checkouts gone.
  expect({ main: git("rev-parse", "main"), feature: git("rev-parse", "feature/login"), head: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain") }).toEqual(before);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("shop\n");
  expect(git("branch", "--list", "toolroll/*", "standing-orders/*")).toBe("");
  expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toEqual([`worktree ${repo}`]);
  expect(existsSync(join(pool, `shop-${shop.first.id}`))).toBe(false);

  // The ledger keeps every entry, still verifies, and says who deleted what.
  const chain = store.ledgerChain({ full: true });
  expect(chain.ok).toBe(true);
  const entry = store.handle.prepare("SELECT * FROM action_ledger WHERE id = ?").get(done.ok ? done.ledgerId : 0)!;
  expect(entry).toMatchObject({ actor: "alex", repo, action: "project deleted", outcome: "deleted", source: "policy" });
  expect(String(entry["detail"])).toMatch(/^1 task, 1 version, 2 runs, 2 evidence files, 2 checkouts, 2 branches, 2 chats, 1 flow with 1 card, 1 subagent, 2 budgets, \d+ settings? → deleted from the command line$/);
  expect(count("SELECT COUNT(*) AS n FROM action_ledger WHERE repo = ? AND action <> 'project deleted'", repo)).toBeGreaterThan(0);
});

test("nothing is deleted while the project's work is running", async () => {
  const shop = populate(repo);
  const held = projectHoldings(store, repo);
  store.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('live', ?, 1, 'b1', ?, ?, ?)")
    .run(shop.second.ref, NOW.toISOString(), new Date(NOW.getTime() + 600_000).toISOString(), NOW.toISOString());
  expect(projectRunning(store, repo, NOW)).toEqual(["1 task is being built"]);
  const refused = await deleteProject(store, repo, { actor: "alex", via: "console", now: NOW, evidenceRoot: evidence, poolRoot: pool });
  expect(refused).toMatchObject({ ok: false, reason: "running", said: "Nothing was deleted: 1 task is being built. Stop it, then try again." });
  expect(projectHoldings(store, repo)).toEqual(held);
  expect(git("branch", "--list", "toolroll/*", "standing-orders/*").split("\n")).toHaveLength(2);
  expect(existsSync(join(evidence, String(shop.first.run)))).toBe(true);
  expect(count("SELECT COUNT(*) AS n FROM hold WHERE owner_id LIKE 'project-delete:%'")).toBe(0);
  // A chat answering holds it too; once all of it has stopped, it goes.
  store.handle.prepare("UPDATE claim SET released_at = ? WHERE lease_id = 'live'").run(NOW.toISOString());
  expect(projectRunning(store, repo, NOW)).toEqual([]);
  expect(await deleteProject(store, repo, { actor: "alex", via: "console", now: NOW, evidenceRoot: evidence, poolRoot: pool })).toMatchObject({ ok: true });
});

test("the console asks for the project's name, then the password, and only an instance operator can", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  populate(repo);
  populate(OTHER);
  const server = createDecisionServer({ store, evidenceRoot: evidence, repo, poolRoot: pool });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
    expect(page).toContain("<summary>Delete project</summary>");
    expect(page).toContain('<span class="k-frow-t">Type shop to continue</span>');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>, who = cookie) => fetch(`${base}/settings/project/delete`, { method: "POST", headers: { cookie: who, origin: base }, body: new URLSearchParams({ csrf, repo, ...fields }), redirect: "manual" });
    // The wrong name goes back with nothing deleted.
    expect(decodeURIComponent((await post({ name: "shoe" })).headers.get("location")!)).toContain("Type shop exactly to delete it.");
    // The right name shows what goes, and asks for the password.
    const confirm = await (await post({ name: "shop" })).text();
    expect(confirm).toContain('<h2 class="k-same">Delete shop?</h2>');
    expect(confirm).toContain("1 task and 1 version, with 2 runs and their evidence");
    expect(confirm).toContain('name="password"');
    expect(confirm).toContain('name="step" value="delete"');
    expect(await (await post({ name: "shop", step: "delete", password: "wrong" })).text()).toContain("That password didn&#39;t match. Nothing was deleted.");
    expect(projectHoldings(store, repo).tasks).toBe(1);
    // Someone who isn't an instance operator can't, even with the right password.
    const samCsrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie: await signIn("sam", sam.token) } })).text())![1]!;
    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/settings/project/delete`, { method: "POST", headers: { cookie: samCookie, origin: base }, body: new URLSearchParams({ csrf: samCsrf, repo, name: "shop", step: "delete", password: sam.token }), redirect: "manual" })).status).toBe(403);
    const deleted = await post({ name: "shop", step: "delete", password: alex.token });
    expect(deleted.status).toBe(303);
    expect(decodeURIComponent(deleted.headers.get("location")!)).toContain("Deleted shop: 1 task, 1 version, 2 runs");
    expect(projectHoldings(store, repo).tasks).toBe(0);
    expect(store.handle.prepare("SELECT actor, repo FROM action_ledger WHERE action = 'project deleted'").all()).toEqual([{ actor: "alex", repo }]);
    expect(await (await fetch(`${base}/settings/project`, { headers: { cookie } })).text()).not.toContain(`value="${repo}"`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("the command line previews, then deletes with --yes for an instance operator", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  populate(repo);
  store.close();
  let lines: string[] = [];
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("project", argv, line => { lines.push(line); }, { databaseFile: file, evidenceRoot: evidence }); return { code, out: lines.join("\n") }; };
  try {
    expect((await run(["delete", "--repo", repo])).code).toBe(3);
    const preview = await run(["delete", "--repo", repo, "--as", "alex", "--token", alex.token]);
    expect(preview).toMatchObject({ code: 0 });
    expect(preview.out).toContain("Add --yes to delete.");
    const done = await run(["delete", "--repo", repo, "--yes", "--as", "alex", "--token", alex.token, "--json"]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out)).toMatchObject({ ok: true, deleted: true, removed: { tasks: 1, runs: 2, branches: 2 } });
    expect(git("branch", "--list", "toolroll/*", "standing-orders/*")).toBe("");
    expect((await run(["delete", "--repo", repo, "--as", "alex", "--token", alex.token])).code).toBe(3);
  } finally {
    store = openStore(file);
  }
  expect(store.ledgerChain({ full: true }).ok).toBe(true);
});

test("a checkout Toolroll made that someone switched to a branch of their own is theirs: it stays, with its work", async () => {
  const shop = populate(repo);
  const mine = join(pool, `shop-${shop.first.id}`);
  execFileSync("git", ["switch", "-q", "-c", "feature/customer-work"], { cwd: mine });
  writeFileSync(join(mine, "unsaved.txt"), "work in progress\n");
  const done = await deleteProject(store, repo, { actor: "alex", via: "command line", now: NOW, evidenceRoot: evidence, poolRoot: pool });
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  expect(done.left).toEqual([expect.stringContaining("feature/customer-work, not a Toolroll branch")]);
  expect(readFileSync(join(mine, "unsaved.txt"), "utf8")).toBe("work in progress\n");
  expect(git("branch", "--list", "feature/customer-work")).toContain("feature/customer-work");
});

test("project deletion hardens every Git call and suppresses planted reference hooks", async () => {
  task(repo);
  const marker = join(dir, "hook-ran");
  writeFileSync(join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const { run } = await import("./exec.js");
  let calls = 0;
  const result = await deleteProject(store, repo, { actor: "alex", via: "command line", now: NOW, evidenceRoot: evidence, poolRoot: pool,
    runner: (file, args, options) => {
      calls++;
      expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      expect(args.includes("--no-includes") || args.includes("core.hooksPath=/dev/null")).toBe(true);
      return run(file, args, options);
    } });
  expect(result).toMatchObject({ ok: true, removed: { checkouts: 1, branches: 1 }, left: [] });
  expect(calls).toBeGreaterThan(0);
  expect(existsSync(marker)).toBe(false);
});

test("project config refusal keeps its checkouts instead of taking the missing-repository fallback", async () => {
  task(repo);
  const path = store.listWorktrees()[0]!.path;
  git("config", "core.fsmonitor", "touch should-not-run");
  const result = await deleteProject(store, repo, { actor: "alex", via: "command line", now: NOW, evidenceRoot: evidence, poolRoot: pool });
  expect(result).toMatchObject({ ok: true, removed: { branches: 0 } });
  expect(existsSync(path)).toBe(true);
  if (result.ok) expect(result.left.join(" ")).toContain("core.fsmonitor");
});

test("removing a project from the list keeps its learning rows, as it keeps its tasks and results", () => {
  const first = task(OTHER);
  store.upsertProject(OTHER, "other", NOW);
  learningRows(OTHER, first);
  store.forgetProject(OTHER);
  expect(learningCounts(OTHER)).toEqual({ facts: 1, results: 1, watches: 1, merges: 1 });
});

test("deleting a project removes its fallback agents and its paid fallback grant, and keeps another project's", async () => {
  const setting = store.handle.prepare("INSERT INTO fallback_setting (repo, entries_json, paid_granted_by, paid_granted_at, updated_by, updated_at) VALUES (?, ?, 'alex', ?, 'alex', ?)");
  const entries = JSON.stringify([{ provider: "codex", model: "gpt-5.5", authMode: "api-key" }]);
  for (const where of [repo, OTHER]) setting.run(where, entries, NOW.toISOString(), NOW.toISOString());
  expect(projectHoldings(store, repo).settings).toBeGreaterThanOrEqual(1);
  expect(await deleteProject(store, repo, { actor: "alex", via: "command line", now: NOW, evidenceRoot: evidence, poolRoot: pool })).toMatchObject({ ok: true });
  expect(store.handle.prepare("SELECT repo, paid_granted_by FROM fallback_setting ORDER BY repo").all()).toEqual([{ repo: OTHER, paid_granted_by: "alex" }]);
  expect(PROJECT_SETTINGS.map(([table]) => table)).toContain("fallback_setting");
});
