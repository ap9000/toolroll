/**
 * The ledger as a hash chain (v103): every entry sealed with the one before
 * it; changing, removing or slipping in an entry is found and named; a
 * checkpoint copied off the machine catches a chain rebuilt from scratch;
 * subagent tool calls and minted coordinators are in the ledger too.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { entryHash, LEDGER_GENESIS, matchesOutsideCheckpoint, sealLedger, verifyLedgerChain } from "./ledger-chain.js";
import { mintCoordinator } from "./coordinator.js";
import { runOperate } from "./operate.js";
import { ledgerExportChunks } from "./evidence-pack.js";

let dir: string, file: string, store: Store;
const T0 = new Date("2026-09-20T10:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-ledger-chain-"));
  file = join(dir, "orders.db");
  store = openStore(file);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const act = (action: string, at = T0) => store.recordAction({ at: at.toISOString(), actor: "alex", repo: "/repo/a", taskId: null, runId: null, action, outcome: "done", source: "policy" });
/** What someone with the database file (and no care for the triggers) could do. */
const unguard = () => store.handle.exec("DROP TRIGGER action_ledger_no_update; DROP TRIGGER action_ledger_no_delete; DROP TRIGGER ledger_seal_no_update; DROP TRIGGER ledger_seal_no_delete");

test("every entry is sealed, in order, with the one before it; the chain verifies", () => {
  const ids = [act("one"), act("two"), act("three")];
  const report = store.ledgerChain();
  expect(report).toMatchObject({ ok: true, entries: 3, through: ids[2], unsealed: 0, problem: null });
  const seals = store.handle.prepare("SELECT id, prev, hash FROM ledger_seal ORDER BY id").all();
  expect(seals[0]!["prev"]).toBe(LEDGER_GENESIS);
  expect(seals[1]!["prev"]).toBe(seals[0]!["hash"]);
  expect(report.head).toBe(seals[2]!["hash"]);
  // Anyone can recompute a seal from the entry's own fields.
  const row = store.handle.prepare("SELECT * FROM action_ledger WHERE id = ?").get(ids[1]!)!;
  expect(entryHash(String(seals[0]!["hash"]), row)).toBe(seals[1]!["hash"]);
  // An entry written after the last seal is counted, and sealed on the next read.
  act("four");
  expect(verifyLedgerChain(store.handle)).toMatchObject({ ok: true, entries: 3, unsealed: 1 });
  expect(store.ledgerChain()).toMatchObject({ ok: true, entries: 4, unsealed: 0 });
});

test("the seals themselves are append-only", () => {
  act("one");
  store.sealLedger();
  expect(() => store.handle.prepare("UPDATE ledger_seal SET hash = 'x'").run()).toThrow(/append-only/);
  expect(() => store.handle.prepare("DELETE FROM ledger_seal").run()).toThrow(/append-only/);
  expect(() => store.handle.prepare("DELETE FROM ledger_checkpoint").run()).not.toThrow();
});

test("an entry changed after it was sealed is found, and named", () => {
  act("one"); const two = act("two"); act("three");
  store.sealLedger();
  unguard();
  store.handle.prepare("UPDATE action_ledger SET actor = 'mallory' WHERE id = ?").run(two);
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { id: two, what: `entry #${two} was changed after it was sealed` } });
});

test("an entry removed after it was sealed is found", () => {
  act("one"); const two = act("two"); act("three");
  store.sealLedger();
  unguard();
  store.handle.prepare("DELETE FROM action_ledger WHERE id = ?").run(two);
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { id: two, what: `entry #${two} was removed after it was sealed` } });
  // Removing its seal too breaks the link to the next entry instead. A page view serves the last walk's report
  // (a broken chain doesn't cost a walk per view); the next whole walk says what it finds now.
  store.handle.prepare("DELETE FROM ledger_seal WHERE id = ?").run(two);
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { what: `entry #${two} was removed after it was sealed` } });
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: expect.stringContaining("doesn't follow the entry before it") } });
});

test("an entry slipped in among sealed ones is found", () => {
  const one = act("one"); const two = act("two"); act("three");
  store.sealLedger();
  unguard();
  // Make room, then put a different entry where one was.
  store.handle.prepare("DELETE FROM action_ledger WHERE id = ?").run(two);
  store.handle.prepare("DELETE FROM ledger_seal WHERE id = ?").run(two);
  store.handle.prepare("INSERT INTO action_ledger (id, at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES (?, ?, 'alex', NULL, NULL, NULL, 'forged', 'done', 'policy', NULL)")
    .run(two, T0.toISOString());
  const report = store.ledgerChain();
  expect(report.ok).toBe(false);
  expect(report.through).toBe(one);
});

test("an entry numbered below the first, where sealing never reaches, is found", () => {
  act("one");
  store.sealLedger();
  store.handle.prepare("INSERT INTO action_ledger (id, at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES (-1, ?, 'alex', NULL, NULL, NULL, 'forged', 'done', 'policy', NULL)").run(T0.toISOString());
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { what: "entry #-1 was added outside the sealed history" } });
});

test("a long ledger is walked a page at a time; between whole walks a read checks only what's new", () => {
  for (let i = 0; i < 2500; i++) act(`many ${i}`);
  expect(store.ledgerChain()).toMatchObject({ ok: true, entries: 2500, through: 2500, checkedAt: expect.any(String) });
  act("one more");
  expect(store.ledgerChain()).toMatchObject({ ok: true, entries: 2501, through: 2501 });
  unguard();
  store.handle.prepare("UPDATE action_ledger SET detail = 'late' WHERE id = 2001").run();
  // The next whole walk (every ten minutes, `ledger verify`, before a checkpoint) finds it.
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { id: 2001 } });
  expect(store.ledgerCheckpoint("alex", T0)).toEqual({ problem: "entry #2001 was changed after it was sealed" });
});

test("a chain rebuilt while this process watches is caught at the next read, and stays reported", () => {
  act("one"); const two = act("two"); act("three");
  expect(store.ledgerChain().ok).toBe(true);
  unguard();
  store.handle.prepare("UPDATE action_ledger SET action = 'rewritten' WHERE id = ?").run(two);
  store.handle.prepare("DELETE FROM ledger_seal WHERE id >= ?").run(two);
  // The next read reseals it all, and the head it walked to before is gone.
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { what: "the chain was rewritten since it was last checked (entry #3 changed)" } });
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: "the chain was rewritten since it was last checked (entry #3 changed)" } });
});

test("every checkpoint row counts: a later matching one can't cover an earlier mismatch", () => {
  act("one"); act("two");
  const good = store.ledgerCheckpoint("alex", T0) as { through: number; hash: string };
  store.handle.prepare("INSERT INTO ledger_checkpoint (through, hash, at, by) VALUES (?, ?, ?, 'mallory')").run(good.through, "0".repeat(64), T0.toISOString());
  store.handle.prepare("INSERT INTO ledger_checkpoint (through, hash, at, by) VALUES (?, ?, ?, 'mallory')").run(good.through, good.hash, T0.toISOString());
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: `the chain no longer matches the checkpoint at entry #${good.through}` } });
});

test("a value the ledger never writes (Infinity, a blob) is a break, not a quiet match", () => {
  act("one"); const two = act("two");
  store.sealLedger();
  unguard();
  store.handle.prepare("UPDATE action_ledger SET run_id = 9e999 WHERE id = ?").run(two);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { id: two, what: `entry #${two} holds a run number the ledger never writes` } });
  store.handle.prepare("UPDATE action_ledger SET run_id = NULL, actor = x'00' WHERE id = ?").run(two);
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: `entry #${two} holds a actor the ledger never writes` } });
});

test("an entry numbered past what a seal can name is reported, not a crash", () => {
  act("one");
  store.sealLedger();
  store.handle.exec("INSERT INTO action_ledger (id, at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES (9007199254740993, '2026-09-20T10:00:00.000Z', 'x', NULL, NULL, NULL, 'forged', 'done', 'policy', NULL)");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: "entry #9007199254740993 was added outside the sealed history" } });
});

test("a run number past what JavaScript holds, put in by hand (no trigger stops an insert), is a break everywhere, never a crash", () => {
  act("one");
  store.ledgerChain();
  store.handle.exec("INSERT INTO action_ledger (at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES ('2026-09-20T10:00:00.000Z', 'x', '/repo/a', NULL, 9007199254740993, 'forged', 'done', 'policy', NULL)");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: "entry #2 holds a run number the ledger never writes" } });
  expect(store.actionLedger({ repos: null, limit: 5 })).toHaveLength(2);
  // Sealing carries on after it.
  act("three");
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM ledger_seal").get()?.n).toBe(2);
  store.ledgerChain({ full: true });
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM ledger_seal").get()?.n).toBe(3);
});

test("a seal or checkpoint numbered outside the chain (a plain insert) is a break, never a crash; readers skip entries outside it", () => {
  act("one"); act("two");
  store.ledgerChain();
  store.handle.exec("INSERT INTO ledger_seal (id, prev, hash) VALUES (9007199254740993, 'x', 'y')");
  expect(store.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: "a seal for entry #9007199254740993 was added outside the chain" } });
  act("three");
  expect(store.actionLedger({ repos: null, limit: 10 })).toHaveLength(3);
  const other = openStore(join(dir, "other.db"));
  try {
    other.recordAction({ at: T0.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "one", outcome: "done", source: "policy" });
    other.ledgerChain();
    other.handle.exec("INSERT INTO ledger_checkpoint (through, hash, at, by) VALUES (9007199254740993, 'x', '2026-09-20T10:00:00.000Z', 'x')");
    expect(other.ledgerChain({ full: true })).toMatchObject({ ok: false, problem: { what: "a checkpoint names entry #9007199254740993, outside the chain" } });
    expect(other.ledgerCheckpoints()).toEqual([]);
    // Entries numbered past the chain are named by the report and skipped by readers, not read back rounded.
    other.handle.exec("INSERT INTO action_ledger (id, at, actor, repo, task_id, run_id, action, outcome, source, detail) VALUES (4611686018427387904, '2026-09-20T10:00:00.000Z', 'x', NULL, NULL, NULL, 'forged', 'done', 'policy', NULL)");
    expect(other.actionLedger({ repos: null, limit: 10 }).map(one => one.action)).toEqual(["one"]);
  } finally { other.close(); }
});

test("a task filed under an id a lookup registered before it existed gets its own id, so none of that history is its", () => {
  store.refFor("built-in", "fix-login");
  store.recordAction({ at: T0.toISOString(), actor: "system", repo: null, taskId: "fix-login", runId: null, action: "run started", outcome: "builder", source: "work" });
  const made = store.createConsoleTask({ title: "Fix login", repo: "/repo/a", filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date());
  expect(made).toMatchObject({ ok: true, id: "fix-login-2" });
  const { entries } = store.taskLedgerEntries({ taskIds: ["fix-login-2"], runIds: [] }, { entries: 100, requests: 100 });
  expect(entries.every(one => one.taskId === "fix-login-2")).toBe(true);
  expect(entries.map(one => one.action)).toEqual(expect.arrayContaining(["task registered", "task filed"]));
});

test("a task filed under an explicit id an older lookup registered starts its history at its filing", () => {
  store.refFor("built-in", "fix-login");
  store.recordAction({ at: "2026-09-01T00:00:00.000Z", actor: "mallory", repo: null, taskId: "fix-login", runId: null, action: "run started", outcome: "builder", source: "work" });
  const made = store.createConsoleTask({ id: "fix-login", title: "Fix login", repo: "/repo/a", filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date());
  expect(made).toMatchObject({ ok: true, id: "fix-login" });
  const { entries } = store.taskLedgerEntries({ taskIds: ["fix-login"], runIds: [] }, { entries: 100, requests: 100 });
  expect(entries.some(one => one.actor === "mallory")).toBe(false);
  expect(entries.map(one => one.action)).toEqual(expect.arrayContaining(["task registered", "task filed"]));
});

test("a task filed under an id another backend's ref already names starts its history at its filing too", () => {
  store.refFor("github-issues", "42");
  store.recordAction({ at: "2026-09-01T00:00:00.000Z", actor: "mallory", repo: null, taskId: "42", runId: null, action: "run started", outcome: "builder", source: "work" });
  expect(store.createConsoleTask({ id: "42", title: "Issue 42", repo: "/repo/a", filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date())).toMatchObject({ ok: true, id: "42" });
  const { entries } = store.taskLedgerEntries({ taskIds: ["42"], runIds: [] }, { entries: 100, requests: 100 });
  expect(entries.some(one => one.actor === "mallory")).toBe(false);
});

test("an export walks the whole chain (reusing only a walk from the last minute), so an edit between page views' walks shows there", () => {
  act("one"); const two = act("two"); act("three");
  expect(store.ledgerChain().ok).toBe(true);
  unguard();
  store.handle.prepare("UPDATE action_ledger SET actor = 'mallory' WHERE id = ?").run(two);
  // A walk from the last minute is reused (a burst of exports costs one walk)...
  const chainOf = (bundle: string) => (JSON.parse(bundle) as { chain: { ok: boolean } }).chain.ok;
  expect(chainOf([...ledgerExportChunks(store, { from: "2026-09-20T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }, { repos: null, instance: true },
    { principal: "operator", repos: null, includeUnplaced: true }, "alex", T0, join(dir, "evidence"))].join(""))).toBe(true);
  // ...and past it (here, a console started since), the export walks it all.
  store.close();
  store = openStore(file);
  const bundle = JSON.parse([...ledgerExportChunks(store, { from: "2026-09-20T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }, { repos: null, instance: true },
    { principal: "operator", repos: null, includeUnplaced: true }, "alex", T0, join(dir, "evidence"))].join("")) as { chain: { ok: boolean; problem: string } };
  expect(bundle.chain).toMatchObject({ ok: false, problem: `entry #${two} was changed after it was sealed` });
});

test("a task's entries count from each version's own registration; a version from before that row existed keeps its history", () => {
  const entry = (taskId: string, action: string, source: "work" | "request" = "work", actor = "system") =>
    store.recordAction({ at: T0.toISOString(), actor, repo: "/repo/a", taskId, runId: null, action, outcome: "recorded", source });
  // A request about the revision before it existed, then the legacy root's history (it predates registration rows).
  entry("legacy-2", "task approve", "request", "kim");
  entry("legacy", "scope approved", "work", "alex");
  entry("legacy", "task state changed");
  entry("legacy-2", "task registered");
  entry("legacy-2", "task filed", "work", "alex");
  const { entries } = store.taskLedgerEntries({ taskIds: ["legacy", "legacy-2"], runIds: [] }, { entries: 100, requests: 100 });
  expect(entries.map(one => [one.taskId, one.action])).toEqual([
    ["legacy", "scope approved"], ["legacy", "task state changed"], ["legacy-2", "task registered"], ["legacy-2", "task filed"],
  ]);
});

test("a chain rebuilt from scratch still verifies on its own, but not against a checkpoint", () => {
  act("one"); const two = act("two"); act("three");
  const checkpoint = store.ledgerCheckpoint("alex", T0) as { through: number; hash: string };
  expect(checkpoint.through).toBe(3);
  expect(store.ledgerCheckpoints(1)[0]).toMatchObject({ through: 3, hash: checkpoint.hash, by: "alex" });
  // The checkpoint itself is in the ledger.
  expect(store.actionLedger({ repos: null, limit: 1 })[0]).toMatchObject({ action: "ledger checkpoint", actor: "alex", detail: `3:${checkpoint.hash}` });
  const copied = `${checkpoint.through}:${checkpoint.hash}`;
  expect(matchesOutsideCheckpoint(store.handle, copied)).toMatchObject({ ok: true });
  // Someone with the file (and no running console watching) rewrites entry two, then reseals everything.
  store.close();
  store = openStore(file);
  unguard();
  store.handle.prepare("UPDATE action_ledger SET action = 'rewritten' WHERE id = ?").run(two);
  store.handle.exec("DELETE FROM ledger_seal");
  sealLedger(store.handle);
  // The checkpoint kept here catches it...
  expect(store.ledgerChain()).toMatchObject({ ok: false, problem: { id: 3, what: "the chain no longer matches the checkpoint at entry #3" } });
  // ...and so does the copy kept elsewhere, even when the local checkpoints are gone too.
  store.handle.exec("DROP TRIGGER ledger_checkpoint_no_delete; DELETE FROM ledger_checkpoint");
  store.close();
  store = openStore(file);
  expect(store.ledgerChain().ok).toBe(true);
  expect(matchesOutsideCheckpoint(store.handle, copied)).toMatchObject({ ok: false, what: expect.stringContaining("does NOT match") });
  expect(matchesOutsideCheckpoint(store.handle, "nonsense").ok).toBe(false);
});

test("subagent tool calls, their decisions and undos are in the ledger, as the subagent or the person who decided", () => {
  const repo = "/repo/a";
  const mate = store.createSubagent({ repo, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, T0);
  const flow = store.createFlow({ repo, name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: "alex" }, T0);
  const card = store.addFlowCard({ flow, title: "Refund it", description: null, stage: "inbox", by: "alex" }, T0);
  const call = store.addSubagentCall({ subagent: mate, card, entry: 1, tool: "shop", action: "refund_order", input: { order: "54" }, rule: "ask", why: "Over the limit.", state: "asked" }, T0);
  expect(store.moveSubagentCall(call, ["asked"], { state: "approved", decidedBy: "alex" }, new Date(T0.getTime() + 1000))).toBe(true);
  expect(store.moveSubagentCall(call, ["approved"], { state: "done", result: "refunded" }, new Date(T0.getTime() + 2000))).toBe(true);
  expect(store.markSubagentCallUndone(call, "sam", new Date(T0.getTime() + 3000))).toBe(true);
  const rows = store.actionLedger({ repos: [repo], limit: 20 }).filter(one => one.action.startsWith("subagent tool call")).reverse();
  expect(rows.map(one => [one.actor, one.action, one.outcome])).toEqual([
    ["maya (AI)", "subagent tool call: shop refund_order", "asked"],
    ["alex", "subagent tool call: shop refund_order", "approved"],
    ["maya (AI)", "subagent tool call: shop refund_order", "done"],
    ["sam", "subagent tool call undone: shop refund_order", "undone"],
  ]);
  expect(rows[0]!.detail).toBe("rule: ask");
  expect(rows[2]!.at).toBe(new Date(T0.getTime() + 2000).toISOString());
  // An undo that failed says so; the call stands.
  store.clearSubagentCallUndone(call, new Date(T0.getTime() + 4000));
  expect(store.actionLedger({ repos: [repo], limit: 1 })[0]).toMatchObject({ actor: "maya (AI)", action: "subagent tool call undo failed: shop refund_order", outcome: "failed" });
});

test("minting a coordinator is in the ledger, with its projects", () => {
  const minted = mintCoordinator(store, { name: "release-bot", repos: ["/repo/a"], by: "alex", now: T0 });
  expect(minted.ok).toBe(true);
  expect(store.actionLedger({ repos: null, limit: 5 }).find(one => one.action === "coordinator minted: release-bot")).toMatchObject({ actor: "alex", outcome: "minted", source: "access", detail: 'projects: ["/repo/a"]' });
});

test("the command line verifies the chain, compares a copied checkpoint, and makes one only for an instance operator", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  act("one"); act("two");
  store.close();
  let lines: string[] = [];
  const write = (line: string) => { lines.push(line); };
  const run = async (argv: string[]) => { lines = []; const code = await runOperate("ledger", argv, write, { databaseFile: file, now: T0 }); return { code, out: lines.join("\n") }; };
  const verified = await run(["verify"]);
  expect(verified.code).toBe(0);
  expect(verified.out).toMatch(/^Chain verified: \d+ entries through #\d+, head [0-9a-f]{64}\.$/);
  expect((await run(["checkpoint", "--json"])).code).toBe(3);
  const made = await run(["checkpoint", "--as", "alex", "--token", alex.token, "--json"]);
  expect(made.code).toBe(0);
  const checkpoint = (JSON.parse(made.out) as { checkpoint: string }).checkpoint;
  expect(checkpoint).toMatch(/^\d+:[0-9a-f]{64}$/);
  expect((await run(["verify", "--checkpoint", checkpoint])).out).toContain("still matches the checkpoint");
  const wrong = await run(["verify", "--checkpoint", checkpoint.replace(/.$/, c => c === "0" ? "1" : "0"), "--json"]);
  expect(wrong.code).toBe(1);
  expect(JSON.parse(wrong.out)).toMatchObject({ ok: false, outside: { ok: false } });
  // A broken chain fails the command.
  store = openStore(file);
  unguard();
  store.handle.prepare("UPDATE action_ledger SET actor = 'mallory' WHERE id = 1").run();
  store.close();
  const broken = await run(["verify"]);
  expect(broken.code).toBe(1);
  expect(broken.out).toContain("Chain BROKEN: entry #1 was changed after it was sealed.");
  store = openStore(file);
  // An export of the range, to a file that doesn't exist yet (and never over one that does).
  store.close();
  const out = join(dir, "audit.json");
  const exported = await run(["export", "--from", "2026-09-20", "--to", "2026-09-20", "--out", out, "--json"]);
  expect(exported.code).toBe(0);
  const bundle = JSON.parse(readFileSync(out, "utf8")) as { format: string; entries: { action: string; seal: unknown }[]; chain: { ok: boolean } };
  expect(bundle.format).toBe("standing-orders/ledger-export/v1");
  expect(bundle.entries.map(one => one.action)).toEqual(expect.arrayContaining(["one", "two"]));
  expect(bundle.chain.ok).toBe(false);
  expect((await run(["export", "--from", "2026-09-20", "--to", "2026-09-20", "--out", out])).code).toBe(1);
  expect((await run(["export", "--from", "2026-09-21", "--to", "2026-09-20"])).code).toBe(2);
  store = openStore(file);
  expect(store.actionLedger({ repos: null, instance: true, limit: 5 }).find(one => one.action === "ledger exported")).toMatchObject({ source: "access", detail: expect.stringContaining("2026-09-20 to 2026-09-20") });
});
