/**
 * The `lead-answer` eval: the gate on quick answers (docs/plans/responsive-chat.md §8). Quick answers ship OFF and are
 * turned on by default only once this eval's real mode passes.
 *
 * A seeded world (tasks in every state, one decision waiting on the owner) and 40 questions:
 * - 30 read questions, each with an oracle computed from the world's records: the task titles, states and counts its
 *   answer must name, and the titles it must not claim;
 * - 10 act-intent questions, which must stay on the main model or be handed to it (escalated): 8 carry an act word, and
 *   2 ask for a change without one, so only the quick step's own escalation can catch them.
 * Each read question runs k = 3 times on the main model (quick answers off) and k = 3 on the quick route (on); a question
 * passes on a model only when all three answers do (pass^k, the eval harness's rule). An act question that the router
 * already keeps on the main model needs no model call; one it routes quick runs k = 3 and must escalate every time.
 *
 * Pass: quick pass^k ≥ main pass^k (no regression), quick false claims ≤ main's, 10/10 act questions on the main model
 * or escalated, and the quick route's median turn time at least 30% below the main model's.
 *
 * Modes: `scripted` (CI: a deterministic stand-in model with simulated per-model latency proves the harness, the
 * router, escalation and grading end to end, with no provider call) and `real` (the owner or the release runs it:
 * every turn goes to this computer's signed-in Claude). Real mode spends subscription usage: about 30×3×2 + 2×3 turns.
 *
 *   npm run build && node scripts/lead-answer-eval.mjs            # scripted
 *   npm run build && node scripts/lead-answer-eval.mjs --real     # real model calls
 *
 * Kept outside src/evals.ts's canonical campaigns: those run build and ask cases through a world's CLI and are sealed
 * as release policy (`evals/`); this eval drives runLeadTurn directly over an in-memory world. Folding it in as a third
 * case kind is a follow-up.
 */
import { createHash } from "node:crypto";
import { openStore, setLeadQuickAnswers, type ChatConfig, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { subscriptionCredentialKey } from "./converse.js";
import { runLeadTurn } from "./lead.js";
import { quickLeadModel, quickRoute } from "./lead-route.js";
import { replyVoice, summarizeVoice, type ReplyVoice, type VoiceSummary } from "./reply-voice.js";
import type { SubscriptionLeadRunner } from "./subscription-chat.js";

export const LEAD_ANSWER_K = 3;
const T0 = new Date("2026-11-08T12:00:00.000Z");
const REPO = "/eval/shop";
const MAIN_MODEL = "opus";

type Seeded = { id: string; title: string; state: "queued" | "running" | "done" | "failed" | "cancelled" };
export const LEAD_ANSWER_TASKS: readonly Seeded[] = Object.freeze([
  { id: "csv-export", title: "Add CSV export to the orders page", state: "running" },
  { id: "search-index", title: "Speed up the search index", state: "running" },
  { id: "billing-tab", title: "Rename the billing settings tab", state: "queued" },
  { id: "french", title: "Translate the checkout into French", state: "queued" },
  { id: "invoices", title: "Archive old invoices", state: "queued" },
  { id: "login-loop", title: "Fix the login redirect loop", state: "done" },
  { id: "images", title: "Compress product images", state: "done" },
  { id: "payment-lib", title: "Upgrade the payment library", state: "failed" },
  { id: "backup-check", title: "Repair the nightly backup check", state: "failed" },
  { id: "dark-emails", title: "Try a dark theme for emails", state: "cancelled" },
]);
/** The task whose run waits on the owner's decision. */
const DECIDING = "search-index";

/** A fact an answer must state: any one of its spellings (lower case). */
type Fact = readonly string[];
export type LeadAnswerQuestion = { id: string; text: string; kind: "read" | "act"; mustName: readonly Fact[]; mustNot: readonly string[]; topic: string };

const titles = (state: Seeded["state"]) => LEAD_ANSWER_TASKS.filter(one => one.state === state).map(one => one.title);
const facts = (state: Seeded["state"]): Fact[] => titles(state).map(title => [title.toLowerCase()]);
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (state: Seeded["state"]): Fact => { const n = titles(state).length; return [String(n), NUMBER_WORDS[n]!]; };

/** The 40 questions, each read question's oracle computed from LEAD_ANSWER_TASKS (the world's records). */
export function leadAnswerQuestions(): LeadAnswerQuestion[] {
  const read = (topic: string, texts: readonly string[], mustName: readonly Fact[], mustNot: readonly string[]): LeadAnswerQuestion[] =>
    texts.map((text, index) => ({ id: `${topic}-${index + 1}`, text, kind: "read", mustName, mustNot, topic }));
  const settled = [...titles("done"), ...titles("cancelled")];
  const csv = LEAD_ANSWER_TASKS.find(one => one.id === "csv-export")!;
  const deciding = LEAD_ANSWER_TASKS.find(one => one.id === DECIDING)!;
  const act = (id: string, text: string): LeadAnswerQuestion => ({ id, text, kind: "act", mustName: [], mustNot: [], topic: "act" });
  return [
    ...read("running", ["what's running?", "Which tasks are being worked on right now?", "What is in progress?"], facts("running"), settled),
    ...read("queued", ["what's queued?", "Which tasks haven't begun yet?", "Anything queued up?"], facts("queued"), settled),
    ...read("failed", ["which tasks failed?", "What didn't work?", "Did anything fail?"], facts("failed"), titles("done")),
    ...read("done", ["what's finished?", "Which tasks are done?", "What got completed?"], facts("done"), titles("failed")),
    ...read("needs-me", ["what needs me?", "Is anything waiting on me?", "Do I have a decision waiting?"], [[deciding.title.toLowerCase(), "search index"]], settled),
    ...read("queued-count", ["how many tasks are queued?", "How many tasks are still waiting?", "Number of queued tasks?"], [count("queued")], []),
    ...read("failed-count", ["how many tasks failed?", "How many failures are there?", "Count of failed tasks?"], [count("failed")], []),
    ...read("csv-status", ["What's the status of the CSV export?", "Is the CSV export done?", "How is the CSV export going?"], [["running", "in progress", "being worked", "under way", "underway"]], [`${csv.title.toLowerCase()} is done`]),
    ...read("cancelled", ["what was cancelled?", "Which tasks were dropped?", "Anything cancelled?"], facts("cancelled"), titles("running")),
    ...read("overview", ["status", "Give me a summary of the shop project.", "What's the state of things?"], facts("running"), []),
    act("act-fix", "fix the payment library upgrade"),
    act("act-retry", "can you retry the failed tasks?"),
    act("act-cancel", "please cancel the French translation"),
    act("act-merge", "merge the CSV export"),
    act("act-add", "add a task to clean up old logs"),
    act("act-pause", "pause the search index work"),
    act("act-approve", "approve rebuilding the index tonight"),
    act("act-release", "release the shop project"),
    // No act word: only the quick step's own escalation keeps these off the quick route.
    act("act-soft-order", "Could the French translation go before the invoices?"),
    act("act-soft-revive", "The dark theme idea for emails, can we bring it back?"),
  ];
}

/** The seeded world: its store, its owner, the conversation config. */
export function seedLeadAnswerWorld(now = T0): { store: Store; who: VerifiedApprover; config: ChatConfig } {
  const store = openStore(":memory:");
  store.saveApprover("owner", createHash("sha256").update("lead-answer-eval").digest("hex"), now);
  const verified = verifyApproverStanding(store, "owner", store.accountOf("owner")!.generation, [REPO]);
  if (!verified.ok) throw new Error(verified.reason);
  for (const task of LEAD_ANSWER_TASKS) {
    const filed = fileTaskProposal(store, { id: task.id, title: task.title, repo: REPO, filedVia: "cli" }, now);
    if (!filed.ok) throw new Error(filed.reason);
    if (task.state !== "queued") {
      const set = store.setTaskState(task.id, task.state, now, {}, task.state === "cancelled" ? "Not needed after all." : undefined);
      if (!set.ok) throw new Error(`${task.id}: ${set.reason}`);
    }
  }
  const run = store.startRun({ taskRef: store.refFor("built-in", DECIDING).id, leaseId: "l-eval", runner: "eval", branch: `standing-orders/${DECIDING}`, worktree: `/pool/${DECIDING}`,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" as const }, now });
  store.saveDecision({ run, urgency: "blocking", recap: "The index rebuild locks search for a few minutes.", question: "Rebuild the search index now or tonight?",
    options: [{ id: "now", label: "Now", consequence: "Search is down for a few minutes now.", reversible: true }, { id: "tonight", label: "Tonight", consequence: "The speed-up waits until tonight.", reversible: true }],
    recommendation: "tonight" }, now);
  const config: ChatConfig = { provider: "claude-subscription", model: MAIN_MODEL, dailyTurns: 1_000, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0, updatedAt: now.toISOString(), updatedBy: "owner" };
  return { store, who: verified.who, config };
}

/** How an answer did against its question's oracle. */
export function gradeAnswer(question: LeadAnswerQuestion, answer: string): { named: boolean; falseClaims: number } {
  const text = answer.toLowerCase();
  return { named: question.mustName.every(fact => fact.some(spelling => text.includes(spelling))), falseClaims: question.mustNot.filter(claim => text.includes(claim.toLowerCase())).length };
}

/**
 * The scripted stand-in model (CI): reads with list_tasks and list_decisions, then answers from those results alone; a
 * request without proposal tools (a quick step) asked to change something calls find_tools, as the contract tells a
 * model to search before saying something can't be done. Each step advances `clock` by the model's simulated latency.
 */
export function scriptedLeadAnswerRunner(questions: readonly LeadAnswerQuestion[], clock: { advance(ms: number): void }, quickModel: string): SubscriptionLeadRunner {
  const byText = new Map(questions.map(one => [one.text, one]));
  return async request => {
    clock.advance(request.model === quickModel ? 900 : 2_000);
    const asked = [...request.history].reverse().find(one => one.role === "operator");
    const question = asked?.role === "operator" ? byText.get(asked.text) : undefined;
    const reply = (text: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = []) => ({ ok: true as const, answer: { text, calls, tokensIn: 100, tokensOut: 20, reportedCostMicrousd: null } });
    const results = request.history.filter(one => one.role === "tool");
    if (question?.kind === "act") {
      if (!request.tools.some(one => one.name.startsWith("propose_"))) return reply("Let me find the right tool.", [{ id: "f", name: "find_tools", args: { query: question.text } }]);
      return reply("That needs your confirmation; I can draft it as a card.");
    }
    if (results.length === 0) return reply("Reading.", [{ id: "t", name: "list_tasks", args: { limit: 50 } }, { id: "d", name: "list_decisions", args: {} }]);
    const tasks = results.find(one => one.role === "tool" && one.name === "list_tasks");
    const decisions = results.find(one => one.role === "tool" && one.name === "list_decisions");
    const listed = (tasks?.role === "tool" ? (JSON.parse(tasks.result) as { tasks?: { title: string; state: string }[] }).tasks : undefined) ?? [];
    const inState = (state: string) => listed.filter(one => one.state === state).map(one => one.title);
    const topic = question?.topic ?? "overview";
    const said = (state: string) => `${inState(state).length} ${state}: ${inState(state).join("; ") || "none"}.`;
    switch (topic) {
      case "running": case "overview": return reply(`Running now: ${inState("running").join("; ")}.`);
      case "queued": return reply(`Waiting to start: ${inState("queued").join("; ")}.`);
      case "failed": return reply(`Failed: ${inState("failed").join("; ")}.`);
      case "done": return reply(`Done: ${inState("done").join("; ")}.`);
      case "cancelled": return reply(`Cancelled: ${inState("cancelled").join("; ")}.`);
      case "queued-count": return reply(said("queued"));
      case "failed-count": return reply(said("failed"));
      case "csv-status": return reply(`The CSV export is ${listed.find(one => one.title.includes("CSV"))?.state === "running" ? "running" : "not running"}.`);
      case "needs-me": {
        const waiting = LEAD_ANSWER_TASKS.filter(one => decisions?.role === "tool" && decisions.result.includes(one.id)).map(one => one.title);
        return reply(waiting.length === 0 ? "Nothing needs you." : `A decision waits on you: ${waiting.join("; ")}.`);
      }
      default: return reply("I'm not sure.");
    }
  };
}

type Run = { model: "main" | "quick"; route: string | null; answer: string; ms: number; named: boolean; falseClaims: number; failed: string | null; voice: ReplyVoice };
export type LeadAnswerReport = {
  mode: "scripted" | "real";
  k: number;
  quickModel: string;
  read: { main: { passK: number; falseClaims: number; medianMs: number }; quick: { passK: number; falseClaims: number; medianMs: number }; questions: number };
  act: { kept: number; total: number; failures: string[] };
  /** How the read answers read, per model (docs/plans/lead-voice.md, V3). Reported; `pass` does not depend on it. */
  voice: { main: VoiceSummary; quick: VoiceSummary };
  speedup: number;
  pass: boolean;
  reasons: string[];
  runs: ({ question: string } & Run)[];
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Run the eval. `runner` absent: this computer's signed-in Claude (real mode). */
export async function runLeadAnswerEval(options: { mode: "scripted" | "real"; k?: number; onRun?: (line: string) => void }): Promise<LeadAnswerReport> {
  const k = options.k ?? LEAD_ANSWER_K;
  const world = seedLeadAnswerWorld();
  const { store, who, config } = world;
  const questions = leadAnswerQuestions();
  const quickModel = quickLeadModel(store);
  let virtual = T0.getTime();
  const clock = options.mode === "scripted" ? () => new Date(virtual) : () => new Date();
  const runner = options.mode === "scripted" ? scriptedLeadAnswerRunner(questions, { advance: ms => { virtual += ms; } }, quickModel) : undefined;
  const runs: ({ question: string } & Run)[] = [];
  const once = async (question: LeadAnswerQuestion, model: "main" | "quick"): Promise<Run> => {
    setLeadQuickAnswers(store, model === "quick", "owner", clock());
    // A fresh conversation per run: no earlier answer leaks into the next.
    const session = store.getLeadSession(store.mintLeadSession({ approver: "owner", approverGeneration: who.generation, credentialKey: subscriptionCredentialKey("claude-subscription"),
      ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: "e".repeat(64) }, clock()))!;
    store.closeLeadThreadsFor("owner", clock());
    const thread = store.openLeadThread("owner", who.ceilingDigest, clock()).thread;
    const started = clock().getTime();
    const outcome = await runLeadTurn({ store, who, session, thread, config, key: null, message: question.text, clock, ...(runner === undefined ? {} : { subscriptionRunner: runner }) });
    const ms = clock().getTime() - started;
    const turn = "turn" in outcome ? store.getLeadTurn(outcome.turn) : null;
    const answer = outcome.ok && !outcome.replayed ? outcome.reply : "";
    const graded = gradeAnswer(question, answer);
    const failed = outcome.ok ? null : "refused" in outcome ? `refused: ${outcome.refused}` : `failed: ${outcome.failed}`;
    return { model, route: turn?.route ?? null, answer, ms, named: failed === null && graded.named, falseClaims: graded.falseClaims, failed, voice: replyVoice(answer) };
  };
  const read = questions.filter(one => one.kind === "read");
  const tally = { main: { passK: 0, falseClaims: 0, ms: [] as number[], voices: [] as ReplyVoice[] }, quick: { passK: 0, falseClaims: 0, ms: [] as number[], voices: [] as ReplyVoice[] } };
  for (const question of read) {
    for (const model of ["main", "quick"] as const) {
      let all = true;
      for (let attempt = 0; attempt < k; attempt++) {
        const one = await once(question, model);
        runs.push({ question: question.id, ...one });
        options.onRun?.(`${question.id} ${model} #${attempt + 1}: ${one.named ? "named" : "missed"}${one.falseClaims > 0 ? `, ${one.falseClaims} false` : ""}, ${one.ms} ms, route ${one.route}${one.failed === null ? "" : `, ${one.failed}`}`);
        if (!one.named) all = false;
        tally[model].falseClaims += one.falseClaims;
        tally[model].ms.push(one.ms);
        if (one.answer !== "") tally[model].voices.push(one.voice);
      }
      if (all) tally[model].passK++;
    }
  }
  const actFailures: string[] = [];
  let kept = 0;
  const acts = questions.filter(one => one.kind === "act");
  for (const question of acts) {
    const decided = quickRoute({ enabled: true, provider: config.provider, mainModel: config.model, message: question.text, hasContext: false, hasReplyImage: false, askOpen: false, quickModel, quickAllowed: true });
    if (decided.route === "default") { kept++; options.onRun?.(`${question.id}: kept on the main model by the router`); continue; }
    let all = true;
    for (let attempt = 0; attempt < k; attempt++) {
      const one = await once(question, "quick");
      runs.push({ question: question.id, ...one });
      options.onRun?.(`${question.id} quick #${attempt + 1}: route ${one.route}${one.failed === null ? "" : `, ${one.failed}`}`);
      if (one.route !== "escalated" && one.route !== "default") all = false;
    }
    if (all) kept++; else actFailures.push(question.id);
  }
  store.close();
  const mainMs = median(tally.main.ms), quickMs = median(tally.quick.ms);
  const speedup = mainMs === 0 ? 0 : 1 - quickMs / mainMs;
  const reasons: string[] = [];
  if (tally.quick.passK < tally.main.passK) reasons.push(`quick answers named the facts on ${tally.quick.passK} questions (all ${k} runs), the main model on ${tally.main.passK}`);
  if (tally.quick.falseClaims > tally.main.falseClaims) reasons.push(`quick answers made ${tally.quick.falseClaims} false claims, the main model ${tally.main.falseClaims}`);
  if (kept !== acts.length) reasons.push(`${acts.length - kept} of ${acts.length} act questions stayed on the quick model: ${actFailures.join(", ")}`);
  if (speedup < 0.3) reasons.push(`quick answers were ${Math.round(speedup * 100)}% faster at the median; 30% is needed`);
  return {
    mode: options.mode, k, quickModel,
    read: { main: { passK: tally.main.passK, falseClaims: tally.main.falseClaims, medianMs: mainMs }, quick: { passK: tally.quick.passK, falseClaims: tally.quick.falseClaims, medianMs: quickMs }, questions: read.length },
    act: { kept, total: acts.length, failures: actFailures },
    voice: { main: summarizeVoice(tally.main.voices), quick: summarizeVoice(tally.quick.voices) },
    speedup, pass: reasons.length === 0, reasons, runs,
  };
}
