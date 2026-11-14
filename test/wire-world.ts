/**
 * The wire world (slice 0 of the fluid pages plan, `npm run test:perf:wire`; docs/TESTING.md "Wire budgets"): one seeded, deterministic install the
 * size of a busy team's, so what the browser receives today can be measured and held to ceilings.
 *
 * Fixed clock (WIRE_NOW) and fixed randomness (a seeded PRNG): the same code builds the same rows, the same artifact
 * bytes and the same pages on every machine. No model, no network, no child process, no git.
 *
 * Shape:
 * - 8 projects, 10,000 tasks: families (revisions chained to their roots), the states the lists show (failed, cancelled,
 *   complete; plans waiting for an approval; Ready results nobody has checked yet), approved scopes,
 *   finished runs with their checks, settled process custody and ledger rows.
 * - Every built run keeps real artifacts on disk, at realistic sizes: its diff, its diff stat and its check log
 *   (scripts/benchmark-workspace.ts leaves artifact files out on purpose; this world never does).
 * - One measured result (RESULT_TASK): a three-version family whose current build is Ready, with a 40 KiB diff over 24
 *   files, a sealed passing check, its proof and verdict, made through the store's own writers.
 * - People: alex (the installation's operator), robin (an approver on every project) and sam (a viewer limited to one
 *   project). A few chat conversations: alex's lead conversation, two project conversations and a task's.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addApprover, approve, propose, type AcceptanceCriterion } from "../src/scope.js";
import { register } from "../src/runner.js";
import { storeEvidence, budgetedStatJson, type DiffStat } from "../src/evidence.js";
import { sealVerificationReceipt } from "../src/verification-evidence.js";
import { verifyApproverStanding } from "../src/principal.js";
import { subscriptionCredentialKey } from "../src/converse.js";
import { setLimitOverride } from "../src/request-budget.js";
import type { Store } from "../src/store.js";

/** The world's clock: every row, every page and every relative age reads this instant. */
export const WIRE_NOW = new Date("2026-11-02T15:00:00.000Z");
export const WIRE_SHAPE = { projects: 8, tasks: 10_000, revisionShare: 0.15 } as const;
const PROJECT_NAMES = ["payments-api", "web-app", "mobile", "billing", "search", "infra", "docs-site", "data-pipeline"] as const;
/** The measured result page's family root. */
export const RESULT_TASK = "receipt-rounding";

/** mulberry32: a small seeded PRNG, the world's only source of randomness. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type WireWorld = {
  repos: string[];
  evidenceRoot: string;
  people: { alex: string; robin: string; sam: string };
  /** The project sam may see. */
  samProject: string;
  /** A task in sam's project whose state a live-room probe moves (visible to every viewer). */
  probeTask: string;
  resultTask: string;
  counts: { tasks: number; runs: number; artifacts: number; artifactBytes: number; ledger: number; leadMessages: number };
};

const at = (minutesAgo: number) => new Date(WIRE_NOW.getTime() - minutesAgo * 60_000).toISOString();
const atDate = (minutesAgo: number) => new Date(WIRE_NOW.getTime() - minutesAgo * 60_000);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// ---- realistic artifact bodies ---------------------------------------------------------------------------------------

const SOURCE_LINES = [
  "export function totalOf(lines: readonly LineItem[], rules: TaxRules): Money {",
  "  const subtotal = lines.reduce((sum, line) => sum.add(line.price.times(line.quantity)), Money.zero(rules.currency));",
  "  if (rules.inclusive) return subtotal;",
  "  const tax = subtotal.times(rules.rate).round(rules.rounding);",
  "  return subtotal.add(tax);",
  "}",
  "",
  "import { describe, expect, test } from \"vitest\";",
  "import { totalOf } from \"./total.js\";",
  "test(\"rounds half-up per line when the region asks for it\", () => {",
  "  expect(totalOf([item(\"1.005\", 3)], { ...rules, rounding: \"half-up\" }).toString()).toBe(\"3.02\");",
  "});",
  "  const response = await fetch(`${base}/v1/receipts/${id}`, { headers: { authorization: `Bearer ${token}` } });",
  "  if (!response.ok) throw new ReceiptError(response.status, await response.text());",
  "  return ReceiptSchema.parse(await response.json());",
  "const retry = backoff({ initialMs: 200, maxMs: 5_000, jitter: 0.2 });",
  "    for (const event of batch) await queue.publish(event.topic, serialize(event));",
  "  logger.info({ requestId, durationMs: performance.now() - started }, \"request finished\");",
  "export const config = { region: process.env.REGION ?? \"us-east-1\", replicas: Number(process.env.REPLICAS ?? 2) };",
  "  // Keep the cursor stable across pages: order by (created_at, id), never by a mutable column.",
  "  const rows = await db.select().from(orders).where(gt(orders.id, cursor)).orderBy(orders.createdAt, orders.id).limit(50);",
  "  return rows.map(row => ({ ...row, total: Money.from(row.totalCents, row.currency) }));",
  "<button type=\"submit\" class=\"btn btn-primary\" disabled={pending}>Save changes</button>",
  "  const [state, setState] = useState<FormState>({ status: \"idle\" });",
  "resource \"aws_s3_bucket_lifecycle_configuration\" \"logs\" {",
  "  rule { id = \"expire-old-logs\" status = \"Enabled\" expiration { days = 30 } }",
  "SELECT o.id, o.total_cents, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid';",
  "  def handle(self, event: dict) -> None:",
  "      self.metrics.increment(\"events.processed\", tags={\"kind\": event[\"kind\"]})",
];
const PATHS = ["src/total.ts", "src/total.test.ts", "src/receipts/client.ts", "src/receipts/schema.ts", "src/queue/publisher.ts",
  "src/http/logger.ts", "src/config.ts", "src/orders/list.ts", "src/orders/list.test.ts", "web/components/SettingsForm.tsx",
  "web/hooks/useForm.ts", "infra/s3.tf", "sql/reports/paid_orders.sql", "pipeline/handlers/events.py", "docs/receipts.md",
  "src/money.ts", "src/money.test.ts", "src/tax/rules.ts", "src/tax/rules.test.ts", "web/pages/checkout.tsx",
  "web/pages/checkout.test.tsx", "src/retry.ts", "src/retry.test.ts", "README.md"];

/** A unified diff of `files` files, `hunks` hunks each, built from real-looking source lines. */
function diffOf(random: () => number, files: number, hunksPerFile: number): { patch: string; stat: DiffStat["files"] } {
  const parts: string[] = [], stat: DiffStat["files"] = [];
  const offset = Math.floor(random() * PATHS.length);
  for (let f = 0; f < files; f++) {
    const path = PATHS[(offset + f) % PATHS.length]!;
    let additions = 0, deletions = 0;
    parts.push(`diff --git a/${path} b/${path}\nindex ${digest(path + f).slice(0, 7)}..${digest(path + f + "h").slice(0, 7)} 100644\n--- a/${path}\n+++ b/${path}\n`);
    for (let h = 0; h < hunksPerFile; h++) {
      const start = 1 + Math.floor(random() * 400), size = 6 + Math.floor(random() * 18);
      const lines: string[] = [];
      for (let l = 0; l < size; l++) {
        const text = SOURCE_LINES[Math.floor(random() * SOURCE_LINES.length)]!;
        const kind = random();
        if (kind < 0.25) { lines.push(`-${text}`); deletions++; }
        else if (kind < 0.6) { lines.push(`+${text}`); additions++; }
        else lines.push(` ${text}`);
      }
      parts.push(`@@ -${start},${size} +${start},${size} @@\n${lines.join("\n")}\n`);
    }
    stat.push({ path, additions, deletions });
  }
  return { patch: parts.join(""), stat };
}

/** A project check's saved log, as the builder records it (attempt summary, then each attempt's streams). */
function checkLogOf(random: () => number, command: string, passed: boolean, suites: number): string {
  const out: string[] = [];
  for (let s = 0; s < suites; s++) {
    const file = PATHS[Math.floor(random() * PATHS.length)]!.replace(/\.(ts|tsx|py|tf|sql|md)$/, ".test.ts");
    const tests = 3 + Math.floor(random() * 14);
    out.push(` ${passed || s > 0 ? "✓" : "✗"} ${file} (${tests} tests) ${Math.floor(random() * 900) + 12}ms`);
    for (let t = 0; t < tests; t++) out.push(`   ${passed || s > 0 || t > 0 ? "✓" : "✗"} ${SOURCE_LINES[Math.floor(random() * SOURCE_LINES.length)]!.slice(0, 60).trim() || "keeps the cursor stable"}`);
  }
  const summary = passed ? `Test Files  ${suites} passed (${suites})` : `Test Files  1 failed | ${suites - 1} passed (${suites})`;
  return `=== Attempt summary ===\n- Project check · attempt 1: (exit ${passed ? 0 : 1})\n\n=== Project check · attempt 1 ===\n$ ${command}\n(exit ${passed ? 0 : 1})\n\n--- stdout ---\n${out.join("\n")}\n\n ${summary}\n      Tests  ${suites * 9} ${passed ? "passed" : "failed"}\n   Duration  ${(random() * 40 + 3).toFixed(2)}s\n\n--- stderr ---\n`;
}

// ---- the world ----------------------------------------------------------------------------------------------------

/** Seed `store` (a fresh database) with the wire world. `root` holds the project folders and the evidence. */
export function seedWireWorld(store: Store, root: string, options: { tasks?: number; progress?: (line: string) => void } = {}): WireWorld {
  const total = options.tasks ?? WIRE_SHAPE.tasks;
  const random = seeded(20261102);
  const repos = PROJECT_NAMES.map(name => { const repo = join(root, "projects", name); mkdirSync(repo, { recursive: true }); return repo; });
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot, { recursive: true });
  const db = store.handle;
  const counts = { tasks: 0, runs: 0, artifacts: 0, artifactBytes: 0, ledger: 0, leadMessages: 0 };

  // People: the operator first (the bootstrap approver), an approver on every project, and a viewer of one project.
  const alex = addApprover(store, "alex", atDate(400_000));
  if (!alex.ok) throw Error("wire world: alex");
  const robin = addApprover(store, "robin", atDate(300_000), { name: "alex", token: alex.token });
  const sam = addApprover(store, "sam", atDate(200_000), { name: "alex", token: alex.token });
  if (!robin.ok || !sam.ok) throw Error("wire world: people");
  const samProject = repos[1]!;
  db.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'sam'").run();
  if (!store.setAccountProjects("sam", [samProject], "alex", atDate(200_000)).ok) throw Error("wire world: sam's project");
  // Every request of the measurement is one person's ordinary read; none of them is ever refused for its rate.
  setLimitOverride(store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10_000 }, "alex", atDate(100_000));
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "wire world", atDate(400_000));
  for (const repo of repos) store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 600_000, approvedBy: "alex" }, atDate(390_000));
  register(store, { name: "worker-1", host: "build-box", capacity: 4, repos, now: atDate(1), newToken: () => "wire-worker-token" });

  // ---- 10,000 tasks of history, in raw rows (one transaction) ----
  const artifact = (runId: number, kind: "terminal-diff" | "diff-stat" | "check-log", name: string, body: Buffer, capture: string, when: string) => {
    storeEvidence(store, evidenceRoot, runId, kind, name, body, capture, new Date(when), { captureStatus: "ok" });
    counts.artifacts++; counts.artifactBytes += body.length;
  };
  store.transact(() => {
    const project = db.prepare("INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)");
    repos.forEach((repo, index) => project.run(repo, PROJECT_NAMES[index]!, at(400_000), at(10 + index)));
    const task = db.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)");
    const ref = db.prepare("INSERT INTO task_ref(backend,external_id,repo,revision_of,filed_via) VALUES('built-in',?,?,?,?)");
    const scope = db.prepare(`INSERT INTO task_scope(task_id,goal,proposed_at,digest,approved_at,approved_by,approved_digest) VALUES(?,?,?,?,?,?,?)`);
    const run = db.prepare(`INSERT INTO run(task_ref,lease_id,runner,role,provider,base_revision,branch,worktree,model,outcome,reason,started_at,finished_at,provider_started_at,head_revision,scope_digest)
      VALUES(?,?,'worker-1','builder','claude',?,?,'/build-box/checkouts/removed','sonnet',?,?,?,?,?,?,?)`);
    const revision = db.prepare("UPDATE task_ref SET revision_of = ?, revision_brief_artifact = ? WHERE id = ?");
    const check = db.prepare("INSERT INTO run_check(run,status) VALUES(?,?)");
    const settled = db.prepare(`INSERT INTO run_process_summary(run,witnesses,process_groups,first_observed_at,last_observed_at,last_exited_at,settled_at) VALUES(?,3,1,?,?,?,?)`);
    const ledger = db.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES(?,?,?,?,?,?,?,?)");
    const record = (when: string, actor: string, repo: string | null, taskId: string | null, runId: number | null, action: string, outcome: string, source = "work") => {
      ledger.run(when, actor, repo, taskId, runId, action, outcome, source); counts.ledger++;
    };
    for (const repo of repos) record(at(300_000), "alex", repo, null, null, "release approval changed", "ask");
    // Families a later task may revise: its root, and its newest version with a finished attempt (what a revision builds on).
    const families: { rootId: string; repo: string; latestId: string; latestRun: number }[] = [];
    const verbs = ["Fix", "Add", "Harden", "Speed up", "Retire", "Document", "Refactor", "Split", "Cache", "Validate"];
    const things = ["receipt totals", "the checkout form", "webhook retries", "the search index", "nightly exports", "login rate limits",
      "the billing cron", "image uploads", "the orders list paging", "S3 log retention", "the settings page", "push notifications"];
    const people = ["alex", "robin"];
    for (let i = 0; i < total; i++) {
      if (i % 1000 === 0) options.progress?.(`seeding task ${i}`);
      const id = `wt-${String(i).padStart(5, "0")}`;
      // Oldest first: the newest tasks are the last ones (minutes ago grows toward the start).
      const minutes = (total - i) * 40 + 30;
      const family = i > 200 && families.length > 0 && random() < WIRE_SHAPE.revisionShare ? families[Math.floor(random() * families.length)]! : null;
      const repo = family?.repo ?? repos[Math.floor(random() * repos.length)]!;
      const recent = i >= total - 120;
      // The newest tasks hold what is live: plans waiting for approval, queued work and fresh results; the history is
      // mostly done, with failures and cancellations in it.
      const roll = random();
      const state = recent
        ? (roll < 0.25 ? "queued" : roll < 0.35 ? "failed" : roll < 0.4 ? "cancelled" : "done")
        : (roll < 0.06 ? "cancelled" : roll < 0.11 ? "failed" : "done");
      const title = `${verbs[Math.floor(random() * verbs.length)]} ${things[Math.floor(random() * things.length)]}${family === null ? "" : " (revision)"} #${i}`;
      task.run(id, title, state, at(minutes), at(Math.max(1, minutes - 30)));
      const refId = Number(ref.run(id, repo, null, random() < 0.6 ? "console" : "chat").lastInsertRowid);
      counts.tasks++;
      if (family !== null) {
        // A revision of the family's newest version, with the brief its sender wrote on that version's last attempt.
        const brief = storeEvidence(store, evidenceRoot, family.latestRun, "revision-brief", `revision-${refId}.json`,
          Buffer.from(JSON.stringify({ note: `Send back ${family.latestId}: cover the edge cases the first build missed.` })), "revision brief", new Date(at(minutes + 1)), { captureStatus: "ok" });
        revision.run(family.latestId, brief, refId);
        counts.artifacts++;
      }
      const by = people[Math.floor(random() * people.length)]!;
      record(at(minutes), by, repo, id, null, "task filed", "ok");
      // A plan waits for an approval on 40% of the newest queued tasks.
      const attempts = state === "queued" || state === "cancelled" && random() < 0.5 ? 0 : random() < 0.3 ? 2 : 1;
      const waitsForApproval = state === "queued" && random() < 0.4;
      const terms = digest(`scope ${id}`);
      if (waitsForApproval) scope.run(id, `Goal for ${title}: keep the saved result and its checks.`, at(minutes - 1), terms, null, null, null);
      // Every attempt ran under an approved plan; a task cancelled before it ran may never have had one.
      else if (attempts > 0 || random() < 0.5) {
        scope.run(id, `Goal for ${title}: keep the saved result and its checks.`, at(minutes - 1), terms, at(minutes - 2), by, terms);
        record(at(minutes - 2), by, repo, id, null, "scope approved", "approved");
      }
      let built: number | null = null, last: number | null = null;
      const approvedTerms = waitsForApproval || db.prepare("SELECT approved_digest FROM task_scope WHERE task_id = ?").get(id) === undefined ? null : terms;
      for (let a = 0; a < attempts; a++) {
        const started = at(minutes - 5 - a * 15), finished = at(minutes - 14 - a * 15);
        const outcome = a === attempts - 1 && state === "done" ? "built" : "failed";
        const head = digest(`head ${i} ${a}`).slice(0, 40);
        const runId = Number(run.run(refId, `${id}-${a}`, digest(`base ${i}`).slice(0, 40), `toolroll/${id}`, outcome, outcome === "built" ? null : "check failed",
          started, finished, started, head, approvedTerms).lastInsertRowid);
        last = runId;
        counts.runs++;
        check.run(runId, outcome === "built" ? "passed" : "failed");
        settled.run(runId, started, finished, finished, finished);
        record(started, "worker-1", repo, id, runId, "run started", "ok");
        record(finished, "worker-1", repo, id, runId, "run finished", outcome);
        // What every finished attempt keeps: its diff, its diff stat and its check log, real bytes on disk.
        const shape = diffOf(random, 1 + Math.floor(random() * random() * 14), 1 + Math.floor(random() * 3));
        artifact(runId, "terminal-diff", "terminal-diff.patch", Buffer.from(shape.patch), `git diff ${digest(`base ${i}`).slice(0, 8)}..HEAD (exit 0)`, finished);
        const stat: DiffStat = { schema: 1, base: digest(`base ${i}`).slice(0, 40), head, fileCount: shape.stat.length,
          additions: shape.stat.reduce((n, one) => n + one.additions, 0), deletions: shape.stat.reduce((n, one) => n + one.deletions, 0), binaryCount: 0, files: shape.stat, filesTruncated: false };
        artifact(runId, "diff-stat", "diff-stat.json", budgetedStatJson(stat), "parsed from git diff --numstat -z", finished);
        artifact(runId, "check-log", "check-log.txt", Buffer.from(checkLogOf(random, "npm test", outcome === "built", 2 + Math.floor(random() * 10))), "npm test (attempt recorded)", finished);
        if (outcome === "built") built = runId;
      }
      if (state === "done") record(at(minutes - 40), by, repo, id, null, "task completed", "ok");
      // Most finished work was checked by a person; the newest built results still wait for that look (Ready).
      if (state === "done" && built !== null && !(recent && random() < 0.5)) record(at(minutes - 45), `operator:${by}`, repo, family?.rootId ?? id, built, "assignment handoff checked", digest(`receipt ${id}`));
      if (last !== null) {
        if (family === null) families.push({ rootId: id, repo, latestId: id, latestRun: last });
        else { family.latestId = id; family.latestRun = last; }
      }
    }
    // Sign-ins and console requests, the rest of a team's ledger.
    for (let n = 0; n < 6_000; n++) {
      if (n % 3 === 0) record(at(n * 7), people[n % 2]!, null, null, null, "signed in", "ok", "sign-in");
      else record(at(n * 7), people[n % 2]!, repos[n % repos.length]!, `wt-${String(total - 1 - (n % Math.min(900, total))).padStart(5, "0")}`, null, "console request", "accepted", "request");
    }
  });

  // ---- the measured result: a three-version family, current build Ready, made through the store's own writers ----
  const resultTask = seedResultFamily(store, evidenceRoot, repos[0]!, alex.token, random, counts);

  // ---- a probe task in sam's project: a live-room change moves its state ----
  const probeTask = "wt-probe";
  store.createTask({ id: probeTask, title: "Speed up the orders list paging" }, atDate(90));
  store.placeTask(store.refFor("built-in", probeTask).id, samProject, {}, atDate(90));
  counts.tasks++;

  // ---- chat: the lead is on; alex's lead conversation, two project conversations and a task's ----
  store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 200, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", atDate(100_000));
  // Each person's lead conversation, started as a first message starts it (serve.ts startLeadConversation): a session
  // under the projects they may see now, and its threads.
  const ceilingOf = (approver: string) => {
    const standing = verifyApproverStanding(store, approver, store.accountOf(approver)!.generation, repos);
    if (!standing.ok) throw Error(`wire world: ${approver}'s standing`);
    return { generation: standing.who.generation, ceiling: standing.who.ceilingDigest };
  };
  for (const approver of ["alex", "robin"]) {
    const { generation, ceiling } = ceilingOf(approver);
    store.mintLeadSession({ approver, approverGeneration: generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceiling,
      termsDigest: createHash("sha256").update(`0\n${ceiling}`).digest("hex") }, atDate(1_500));
  }
  const conversation = (approver: string, scope: Parameters<Store["openLeadThread"]>[3], messages: number, startMinutes: number) => {
    const ceiling = ceilingOf(approver).ceiling;
    const thread = store.openLeadThread(approver, ceiling, atDate(startMinutes), scope).thread.id;
    for (let m = 0; m < messages; m++) {
      const operator = m % 2 === 0;
      const text = operator
        ? ["Can you look at why the receipt totals drift by a cent?", "Plan the webhook retry change, but keep the old queue for now.",
          "What's still waiting on me today?", "Send back the checkout fix: the test only covers USD.", "Ship it when the check passes."][m % 5]!
        : ["I looked at the receipts module. Line totals are rounded **before** tax, so three items at $1.005 come to $3.03 instead of $3.02.\n\nI filed a task with a plan: round per line only where the region requires it, and add tests for half-up and banker's rounding.",
          "Here is the plan:\n\n1. Keep the current queue as the fallback.\n2. Add exponential backoff with jitter (200 ms to 5 s).\n3. Move poison messages to a dead-letter queue after 8 tries.\n\nIt needs your approval before it starts.",
          "Three things wait on you: two plans to approve (search index rebuild, S3 log retention) and one Ready result (checkout form validation). Nothing has failed since this morning.",
          "Sent back with your note. The builder will add EUR and JPY cases and re-run the project check.",
          "The check passed on the new commit (214 tests). The result is Ready for you to look at."][m % 5]!;
      store.appendLeadMessage({ thread, turn: null, role: operator ? "operator" : "assistant", text }, atDate(startMinutes - m * 3));
      counts.leadMessages++;
    }
  };
  conversation("alex", { kind: "lead" }, 60, 600);
  conversation("alex", { kind: "project", key: repos[0]! }, 24, 900);
  conversation("alex", { kind: "project", key: repos[2]! }, 12, 1_200);
  conversation("alex", { kind: "task", key: resultTask }, 10, 300);
  conversation("robin", { kind: "lead" }, 20, 700);

  return { repos, evidenceRoot, people: { alex: alex.token, robin: robin.token, sam: sam.token }, samProject, probeTask, resultTask, counts };
}

/** The measured result: an original whose build failed its check, a first revision sent back, and a second revision whose
 * build is Ready (passing check, verified proof). Returns the family's root id. */
function seedResultFamily(store: Store, evidenceRoot: string, repo: string, token: string, random: () => number,
  counts: WireWorld["counts"]): string {
  const acceptance: AcceptanceCriterion[] = [
    { id: "c1", statement: "Line totals round per the region's rule (half-up in the US, banker's in the EU).", how: null, evidence: ["check"] },
    { id: "c2", statement: "The receipt total equals the sum of the rounded lines plus tax.", how: null, evidence: ["check"] },
    { id: "c3", statement: "The change touches only the receipts and tax modules and their tests.", how: null, evidence: ["changed-path"] },
  ];
  const versions = [RESULT_TASK, `${RESULT_TASK}-r1`, `${RESULT_TASK}-r2`];
  let previous: string | null = null;
  let lastRun = 0;
  versions.forEach((id, index) => {
    const minutes = 600 - index * 180;
    store.createTask({ id, title: "Fix the receipt rounding drift" }, atDate(minutes));
    const refId = store.refFor("built-in", id).id;
    if (previous !== null) {
      // A revision of the version before it, with the brief its sender wrote.
      const brief = storeEvidence(store, evidenceRoot, lastRun, "revision-brief", "revision.json",
        Buffer.from(JSON.stringify({ note: "The test only covers USD: add EUR (banker's rounding) and JPY (no minor unit)." })), "revision brief", atDate(minutes + 1), { captureStatus: "ok" });
      store.markRevision(refId, previous, brief);
    }
    store.placeTask(refId, repo, {}, atDate(minutes));
    counts.tasks++;
    const filed = propose(store, { taskId: id, goal: "Receipts add up: round each line per the region's rule, then add tax.", touches: ["src/receipts/", "src/tax/"], acceptance, now: atDate(minutes - 1) });
    const approved = approve(store, id, "alex", atDate(minutes - 2), filed.digest, token);
    if (!approved.ok) throw Error(`wire world: approve ${id}: ${approved.reason}`);
    const route = store.routeAuthorityFor(refId, "builder");
    if (route === null || !route.ok) throw Error(`wire world: route ${id}`);
    const runId = store.startRun({ taskRef: refId, leaseId: `wire-${id}`, runner: "worker-1", branch: `toolroll/${id}`, worktree: `/build-box/checkouts/${id}`, route: route.stamp, now: atDate(minutes - 5) });
    counts.runs++;
    const base = digest(`result base ${index}`).slice(0, 40), head = digest(`result head ${index}`).slice(0, 40);
    store.stampRun(runId, { scopeDigest: filed.digest, baseRevision: base });
    store.recordOutcomeFacts(runId, { headRevision: head, handoff: index === 2 ? "Line totals now round per region before tax; added 18 cases across USD, EUR and JPY." : "Rounded line totals before tax." });
    const ready = index === 2;
    const shape = diffOf(random, ready ? 24 : 6, ready ? 3 : 2);
    const when = atDate(minutes - 20);
    const keep = (kind: "terminal-diff" | "diff-stat" | "check-log", name: string, body: Buffer, capture: string) => {
      storeEvidence(store, evidenceRoot, runId, kind, name, body, capture, when, { captureStatus: "ok" });
      counts.artifacts++; counts.artifactBytes += body.length;
    };
    keep("terminal-diff", "terminal-diff.patch", Buffer.from(shape.patch), `git diff ${base.slice(0, 8)}..HEAD (exit 0)`);
    const stat: DiffStat = { schema: 1, base, head, fileCount: shape.stat.length, additions: shape.stat.reduce((n, one) => n + one.additions, 0),
      deletions: shape.stat.reduce((n, one) => n + one.deletions, 0), binaryCount: 0, files: shape.stat, filesTruncated: false };
    keep("diff-stat", "diff-stat.json", budgetedStatJson(stat), "parsed from git diff --numstat -z");
    keep("check-log", "check-log.txt", Buffer.from(checkLogOf(random, "npm test", ready, ready ? 24 : 9)), "npm test (attempt recorded)");
    sealVerificationReceipt(store, evidenceRoot, runId, head, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: ready ? 0 : 1 }, when);
    store.recordRunCheck(runId, { status: ready ? "passed" : "failed", exitCode: ready ? 0 : 1, suites: [] }, when);
    // The verdict as the builder's adjudication leaves it: every criterion met on the Ready build; the check missed before.
    const matrix = acceptance.map(one => ({ id: one.id, statement: one.statement, requiredEvidence: one.evidence, state: ready || one.id === "c3" ? "pass" : "missing",
      detail: ready || one.id === "c3" ? [] : ["the project check failed (exit 1)"], answered: [], review: null }));
    store.saveProofVerdict(runId, ready ? "verified" : "short", ready ? [] : ["the project check failed (exit 1)"], when, matrix as never, ready ? "verified" : "short");
    store.finishRun(runId, ready ? { outcome: "built", committed: true, now: when } : { outcome: "failed", reason: "check", now: when });
    store.setTaskState(id, ready ? "done" : "failed", when);
    previous = id;
    lastRun = runId;
  });
  return RESULT_TASK;
}
