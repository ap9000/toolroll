/**
 * Steps that run outside a model (v84), in the worker's pass:
 *
 * - check  — runs one of the project's scripts (flow-scripts.ts) in a fresh
 *            copy of the card's latest result (or the base branch), after the
 *            project's approved setup, with the same bare environment setup
 *            and checks get, plus FLOW_* variables naming the card. Exit 0
 *            passes; anything else takes the failure path. The end of its
 *            output (64 KB, whole lines, keys blanked) is kept as the log.
 * - update — comments on the GitHub or Linear issue the card came from, and
 *            can close it (Linear: moves it to the team's done state), with
 *            the person's own `gh` login and Linear key.
 * - draft  — (v86) Claude writes from the card (flow-draft.ts); the draft
 *            is kept on the card for a person and later steps.
 * - sort   — (v85) asks Jev through OpenRouter which of the zone's answers
 *            fits the card (flow-sort.ts), and sends it where that answer
 *            leads, or down the not-sure path.
 * - pull-request — opens a pull request for the card's result and follows
 *            its CI (flow-pull-request.ts).
 *
 * One run per visit to the zone (flow_step_run): two workers never run it
 * twice. Trouble reaching a service is retried three times, 5 then 15
 * minutes apart; a check that fails is an answer, not trouble.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import { approvedCommandShell, redactSecretAssignments, SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { assignmentOf } from "./assignment.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";
import { LINEAR_URL, readLinearKey } from "./flow-triggers.js";
import { cardEmailOf, fillFlowText, type FlowDefinition, type FlowStage } from "./flows.js";
import { JEV_MODEL, askJev, readJevAnswers, sortLog, sortRequest, sortState, sortWords } from "./flow-sort.js";
import { claudeDraftRunner, DRAFT_CHARS, DRAFT_TIMEOUT, draftPrompt, wholeDraft, type DraftRunner } from "./flow-draft.js";
import { overruns, passOn, TEXT_LIMITS, writeWithin } from "./text-limits.js";
import { readFlowSecrets, sendingReady, runRequest, sendEmail, toolWaiting, useTool, type MailSender, type ToolCaller } from "./flow-actions.js";
import { cleanFolder, runCode } from "./flow-code.js";
import { agentFence } from "./agent-fence.js";
import { readProviderKey } from "./keys.js";
import type { FlowCardRow, FlowRow, FlowScriptRow, FlowStepKind, Store } from "./store.js";
import { replyInChannel } from "./chat-inbox.js";
import { recordSent, threadOf } from "./flow-replies.js";
import { ASKED, teammateReady, teammateTurn, type TeammateOutcome } from "./teammate-work.js";
import type { TurnRunner } from "./teammates.js";
import type { ToolLister } from "./teammate-tools.js";
import { budgetHoldWords, claudeMachineBilling, monthOf } from "./spend.js";
import { toolRefusal } from "./policy.js";
import { pullRequestStep } from "./flow-pull-request.js";

export type StepIo = {
  /** `gh` for GitHub; git and the check's shell, both without a model. */
  gh: Runner; git: Runner; shell: Runner;
  fetch: typeof fetch;
  /** Beside the database: the Linear key. */
  dir: string | null;
  /** Where temporary copies of a card's work are made. */
  scratch: string;
  evidenceRoot?: string;
  /** The branch a card with no result yet is checked against. */
  base: string;
  /** The operator's OpenRouter key, for sort steps (default: the one stored in Settings → AI providers). */
  openRouterKey?: () => string | null;
  /** Writes a draft (default: Claude through this computer's sign-in, no tools). */
  draft?: DraftRunner;
  /** Sends an email (default: the mail server in Settings → Email). */
  mail?: MailSender;
  /** Calls a project tool (default: starts its MCP server, like its Test button). */
  callTool?: ToolCaller;
  /** Where the project tools' secrets live (default: this computer's home). */
  toolHome?: string;
  /** Takes a teammate's turn (default: Claude through this computer's sign-in, answering in its fixed shape). */
  teammate?: TurnRunner;
  /** Lists what a project tool offers a teammate (default: starts its MCP server and asks). */
  listTools?: ToolLister;
};
export type StepPass = { ran: number; problems: string[] };
type Outcome = { state: "passed" | "failed" | "retry"; said: string; log?: string; exitCode?: number | null;
  /** sort: where the card goes (null: it waits here), and what was decided. */
  to?: string | null; decisionJson?: string; unsure?: boolean;
  /** What the card keeps from this step, when it isn't `said` (a draft's text). */
  output?: string;
  /** email (v91): what went out, so a reply finds the card. */
  mail?: { id: string; to: string[] } };

const RETRY_MS = [5 * 60_000, 15 * 60_000];
/** A teammate's turn tries again sooner: a card waiting on a person's colleague shouldn't wait long for a hiccup. */
const TEAMMATE_RETRY_MS = [60_000, 5 * 60_000];
const OUTPUT_CHARS = 3000;
/** How much of a step's output its run keeps as the log. */
const LOG_CHARS = 64_000;

/** Run every due check and update in one project, then move each card on. */
export async function runFlowSteps(store: Store, repo: string, now: Date, io: StepIo): Promise<StepPass> {
  // v105: one budget gate a pass, built only if a Sort card is waiting.
  let gate: ReturnType<Store["budgetGate"]> | null = null;
  const budgetGate: ReturnType<Store["budgetGate"]> = work => (gate ??= store.budgetGate(now))(work);
  const pass: StepPass = { ran: 0, problems: [] };
  // A step left running long past any time limit had its worker stop: it may try again.
  for (const stale of store.staleFlowSteps(new Date(now.getTime() - 75 * 60_000))) store.finishFlowStep(stale.card, stale.entry, { state: "waiting", result: "Interrupted; trying again.", nextAt: now.toISOString() }, now);
  const flows = new Map<number, { flow: FlowRow; definition: FlowDefinition | null }>();
  for (const card of store.activeFlowCards(repo)) {
    let known = flows.get(card.flow);
    if (known === undefined) { const flow = store.getFlow(card.flow)!; known = { flow, definition: flowDefinitionOf(flow) }; flows.set(card.flow, known); }
    const stage = known.definition?.stages.find(one => one.id === card.stage);
    if (stage === undefined) continue;
    // v92: a teammate's turn — a zone it handles, or a decision it staffs (a person decides when it's paused or gone).
    if (stage.kind === "teammate" || (stage.kind === "approval" && stage.teammate !== undefined)) {
      await teammateStep(store, known.flow, known.definition!, stage, card, now, io, pass);
      continue;
    }
    // A pull request: opened for the card's result, then CI decides where it goes (flow-pull-request.ts).
    if (stage.kind === "pull-request") {
      try {
        if (await pullRequestStep(store, known.flow, known.definition!, stage, card, now, { gh: io.gh, ...(io.evidenceRoot === undefined ? {} : { evidenceRoot: io.evidenceRoot }) })) pass.ran++;
      } catch (error) {
        pass.problems.push(`flow card ${card.id}: ${error instanceof Error ? error.message : "the pull request step couldn't run"}`);
      }
      continue;
    }
    if (!(["check", "update", "sort", "draft", "request", "email", "tool"] as const).includes(stage.kind as "check")) continue;
    // Email and tools wait, saying why, until what they need is set up.
    const setup = stage.kind === "email" && !sendingReady(io.dir) ? "Email isn't set up yet. Add your mail server or a Google account in Settings → Email."
      : stage.kind === "tool" ? toolWaiting(store, stage, repo) : null;
    if (setup !== null) {
      if (card.waiting !== setup) store.updateFlowCard(card.id, { waiting: setup }, now);
      continue;
    }
    const key = stage.kind === "sort" ? (io.openRouterKey ?? (() => readProviderKey("openrouter")))() : null;
    if (stage.kind === "sort" && key === null) {
      const waiting = "Sorting needs an OpenRouter key. Add one in Settings → AI providers.";
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    // v105: sorting spends the key's credit, and a draft whatever this computer's Claude bills: a budget for this project
    // (or everything) that holds key work holds them.
    const agents = stage.kind === "sort" ? [{ provider: "openrouter", billing: "api-key" as const }]
      : stage.kind === "draft" ? [{ provider: "claude", billing: claudeMachineBilling(store.handle) }] : null;
    const held = agents === null ? null : budgetGate({ project: repo, person: null, teammate: null, agents });
    if (held !== null && held.over !== null) {
      const waiting = `${budgetHoldWords(held, monthOf(now).name)}. Raise it on Spend to go on.`;
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    // Sprint 8: a sort, a draft or a tool call the organisation policy doesn't allow waits, saying which rule.
    const disallowed = stage.kind === "sort" ? store.agentPolicyRefusal("openrouter", JEV_MODEL)
      : stage.kind === "draft" ? store.agentPolicyRefusal("claude", draftModel(store))
        : stage.kind === "tool" && stage.tool !== undefined && stage.tool !== null ? toolRefusal(store.orgPolicy(), stage.tool.server) : null;
    if (disallowed !== null) {
      if (card.waiting !== disallowed) store.updateFlowCard(card.id, { waiting: disallowed }, now);
      continue;
    }
    const script = stage.kind === "check" && stage.script !== null ? store.flowScript(repo, stage.script) : null;
    if (stage.kind === "check" && script === null) {
      const waiting = `There's no script called ${stage.script ?? "(none)"} in this project. Make it on the flow's Scripts panel.`;
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    // A script an imported flow brought waits until a person approves it, like any change to what runs here.
    if (script !== null && script.held !== null) {
      const waiting = `The ${script.name} script came with an imported flow. Approve it on the Scripts panel to run it.`;
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    // A script waits for the secrets it names (v90), and runs on its own once they're saved.
    const missing = stage.kind === "check" ? (stage.secrets ?? []).filter(name => readFlowSecrets(io.dir, repo)[name] === undefined) : [];
    if (missing.length > 0) {
      const waiting = `${stage.script} needs the secret${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Save ${missing.length === 1 ? "it" : "them"} on the zone.`;
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    if (!claimStep(store, card, { stage: stage.id, kind: stage.kind as FlowStepKind, script: script?.name ?? null, scriptVersion: script?.version ?? null }, now)) continue;
    pass.ran++;
    store.updateFlowCard(card.id, { waiting: { check: "Running its check…", sort: "Sorting…", draft: "Writing the draft…", request: "Calling the address…", email: "Sending the email…", tool: "Using the tool…" }[stage.kind as string] ?? "Updating the issue…" }, now);
    let outcome: Outcome;
    const started = Date.now();
    try {
      outcome = stage.kind === "check" ? await runCheck(store, known.flow, stage, script!, card, now, io)
        : stage.kind === "sort" ? await sortCard(known.definition!, stage, card, key!, io)
        : stage.kind === "draft" ? await draftCard(store, known.definition!, stage, card, io, repo, now)
        : stage.kind === "request" ? await runRequest(stage, card, repo, io)
        : stage.kind === "email" ? await sendEmail(stage, card, io, threadOf(store, card))
        : stage.kind === "tool" ? await useTool(store, stage, card, repo, io)
        : await updateSource(store, stage, card, io, now);
    } catch (error) {
      outcome = { state: "retry", said: error instanceof Error ? error.message : "It couldn't run." };
    }
    // What went out is kept before the card moves on, so a reply that comes back at once still finds it.
    if (outcome.state === "passed" && outcome.mail !== undefined) recordSent(store, card, outcome.mail, now);
    settle(store, known.definition!, stage, store.getFlowCard(card.id)!, outcome, now, Date.now() - started);
    if (outcome.state === "retry") pass.problems.push(`flow card ${card.id}: ${outcome.said}`);
  }
  return pass;
}

/** Claim this card's visit to its step zone, only while the card is still there on that visit: a pass that read the card
 * before another pass (or a person) moved it never runs the step for a visit that's over. */
function claimStep(store: Store, card: FlowCardRow, step: { stage: string; kind: FlowStepKind; script: string | null; scriptVersion: number | null }, now: Date): boolean {
  return store.transact(() => {
    const fresh = store.getFlowCard(card.id);
    if (fresh === null || fresh.state !== "active" || fresh.entry !== card.entry || fresh.stage !== step.stage) return false;
    return store.claimFlowStep({ card: card.id, entry: card.entry, ...step }, now);
  });
}

/** One teammate turn, when one is due for this card: claimed like any step, retried on failure, and waiting while its question is open. */
async function teammateStep(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, io: StepIo, pass: StepPass): Promise<boolean> {
  // v102: on a protected project an AI teammate never decides an approval; the engine asks the person.
  if (stage.kind === "approval" && store.approvalRules(flow.repo).protectProject) return true;
  const mate = stage.teammate === undefined ? null : store.teammateByHandle(flow.repo, stage.teammate);
  const ready = teammateReady(store, mate, now);
  if (!ready.ok) {
    // A decision goes to its person (the engine asks them). A zone only it handles waits, saying why.
    if (stage.kind === "approval") return true;
    const waiting = ready.why === "gone" ? `There's no teammate called ${stage.teammate ?? "(none)"} in this project.` : `${mate!.handle} is ${ready.why === "paused" ? "paused" : `waiting: ${ready.why}`}.`;
    if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
    return true;
  }
  // Waiting on a person: its own question, or (v94) a tool call they approve first.
  if (store.openTeammateQuestionOn(card.id, card.entry) !== null) return true;
  if (!claimStep(store, card, { stage: stage.id, kind: "teammate", script: null, scriptVersion: null }, now)) return true;
  pass.ran++;
  const started = Date.now();
  let outcome: TeammateOutcome;
  try {
    outcome = await teammateTurn(store, flow, definition, stage, card, mate!, now, { ...(io.teammate === undefined ? {} : { turn: io.teammate }), ...(io.evidenceRoot === undefined ? {} : { evidenceRoot: io.evidenceRoot }),
      ...(io.callTool === undefined ? {} : { callTool: io.callTool }), ...(io.listTools === undefined ? {} : { listTools: io.listTools }), ...(io.toolHome === undefined ? {} : { toolHome: io.toolHome }) });
  } catch (error) {
    outcome = { state: "retry", said: error instanceof Error ? error.message : "It couldn't take its turn." };
  }
  const run = store.flowStepRun(card.id, card.entry);
  const kept = { log: outcome.log === undefined ? null : keptLog(outcome.log), durationMs: Date.now() - started, ...(outcome.decisionJson === undefined ? {} : { decisionJson: outcome.decisionJson }) };
  if (outcome.state === "retry") {
    const attempts = run?.attempts ?? 1;
    if (attempts <= TEAMMATE_RETRY_MS.length) {
      store.finishFlowStep(card.id, card.entry, { state: "waiting", result: outcome.said, nextAt: new Date(now.getTime() + TEAMMATE_RETRY_MS[attempts - 1]!).toISOString(), ...kept }, now);
      if (stage.kind !== "approval") store.updateFlowCard(card.id, { waiting: `${outcome.said} Trying again in ${attempts === 1 ? "a minute" : "5 minutes"}.` }, now);
      pass.problems.push(`flow card ${card.id}: ${outcome.said}`);
      return true;
    }
    outcome = { state: "failed", said: `${outcome.said} It didn't work after three tries.` };
    store.addTeammateEvent({ teammate: mate!.id, card: card.id, entry: card.entry, kind: "failed", said: `Couldn't take its turn on “${card.title}”: ${outcome.said}` }, now);
    if (stage.kind !== "approval") store.updateFlowCard(card.id, { waiting: outcome.said }, now);
  }
  store.finishFlowStep(card.id, card.entry, outcome.state === "waiting" ? { state: "waiting", result: outcome.said, nextAt: outcome.nextAt ?? ASKED, ...kept }
    : { state: outcome.state === "passed" ? "passed" : "failed", result: outcome.said, ...kept }, now);
  return true;
}

/** Record what a step did and move the card: on for a pass, down its failure path for a fail, or wait to try again. */
function settle(store: Store, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, outcome: Outcome, now: Date, durationMs: number): void {
  const run = store.flowStepRun(card.id, card.entry);
  const kept = { log: outcome.log === undefined ? null : keptLog(outcome.log), exitCode: outcome.exitCode ?? null, durationMs, ...(outcome.decisionJson === undefined ? {} : { decisionJson: outcome.decisionJson }) };
  if (outcome.state === "retry") {
    const attempts = run?.attempts ?? 1;
    if (attempts <= RETRY_MS.length) {
      store.finishFlowStep(card.id, card.entry, { state: "waiting", result: outcome.said, nextAt: new Date(now.getTime() + RETRY_MS[attempts - 1]!).toISOString(), ...kept }, now);
      store.updateFlowCard(card.id, { waiting: `${outcome.said} Trying again in ${attempts === 1 ? 5 : 15} minutes.` }, now);
      return;
    }
    outcome = { state: "failed", said: `${outcome.said} It didn't work after three tries.` };
  }
  store.finishFlowStep(card.id, card.entry, { state: outcome.state === "passed" ? "passed" : "failed", result: outcome.said, ...kept }, now);
  // What the steps after it read: whole up to TEXT_LIMITS.stageOutput; longer is kept whole in this step's log, and they read where.
  const output = passOn(outcome.output ?? outcome.said, TEXT_LIMITS.stageOutput, { label: `the card's ${stage.title} step`, href: flowCardHref(card.flow, card.id) }).text;
  store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: output }, waiting: null }, now);
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "another zone";
  if (outcome.state === "passed") {
    // A sort names where the card goes; one it isn't sure about is a person's to place.
    const to = outcome.to !== undefined ? outcome.to : stage.next;
    if (outcome.unsure === true) {
      const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
      notifyPeople(store, card, people, null, { key: `unsure:${card.entry}`, subject: `${stage.title} wasn't sure about “${card.title}”`, body: `${outcome.said}${to === null ? " Move it to the right zone." : ` It's in ${definition.stages.find(one => one.id === to)?.title ?? "another zone"} for a person to place.`}`, attention: true }, now);
    }
    if (to === null) { store.updateFlowCard(card.id, { waiting: outcome.to !== undefined ? `${outcome.said} Move it to the right zone.` : "Finished here. Move the card on when you're ready." }, now); return; }
    store.moveFlowCard(card.id, { to, outcome: "ok", actor: "flow", expectEntry: card.entry }, now);
    return;
  }
  if (stage.onFail === null) {
    store.updateFlowCard(card.id, { waiting: `${outcome.said} Fix it, then move the card to try again.` }, now);
  } else {
    store.moveFlowCard(card.id, { to: stage.onFail, outcome: "fail", actor: "flow", note: outcome.said, expectEntry: card.entry }, now);
  }
  const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
  notifyPeople(store, card, people, null, { key: `step-failed:${card.entry}`, subject: `${stage.title} didn't pass for “${card.title}”`, body: `${outcome.said}${stage.onFail === null ? "" : `\n\nIt's back in ${titleOf(stage.onFail)}.`}`, attention: true }, now);
}

/** A run's log: the end of its output in whole lines, where failures show, with key-shaped lines replaced and credential-looking values blanked. */
function keptLog(text: string): string {
  const end = text.length <= LOG_CHARS ? text : text.slice(-LOG_CHARS).replace(/^[^\n]*\n/, "");
  return redactSecretAssignments(redactSecretLines(end, scanForSecrets(end)));
}

/** The end of a command's output, without anything that looks like a key. */
function tail(text: string): string {
  const end = text.trim().slice(-OUTPUT_CHARS);
  return scanForSecrets(end).length > 0 ? "(Its output held something that looked like a key, so it isn't shown.)" : end;
}

/** The Claude model a draft runs on: the lead chat's Claude model, or Claude's default. */
function draftModel(store: Store): string {
  const config = store.getChatConfig();
  return config?.provider === "claude-subscription" ? config.model : "default";
}

/** A draft: Claude writes what the zone asks, from the card, with the lead chat's Claude model; the text stays on the card. */
async function draftCard(store: Store, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, io: StepIo, repo: string, now: Date): Promise<Outcome> {
  const model = draftModel(store);
  const runner = io.draft ?? claudeDraftRunner();
  // Claude is told the limit before it writes; a draft over it is asked once to shorten, and one still over is kept whole
  // in the step's log and on the card, linked from what the next steps read (settle): never cut.
  let first: string | null = null;
  const written = await writeWithin(async shorten => {
    const answer = await runner({ model, prompt: draftPrompt(stage, card, definition, shorten === null || first === null ? null : { draft: first, ask: shorten }), timeoutMs: DRAFT_TIMEOUT });
    // v105: what it cost, billed as this computer's Claude does (a plan's is $0).
    if (answer.ok) { store.recordDraftSpend({ repo, model: model === "default" ? null : model, costUsd: answer.costUsd ?? null }, now); first ??= wholeDraft(answer.text); }
    return answer;
  }, answer => answer.ok ? overruns({ draft: wholeDraft(answer.text) }, { draft: DRAFT_CHARS }) : []);
  const answer = written.answer;
  if (!answer.ok) return written.repaired && first !== null ? draftOutcome(first, model, null, true) : { state: "retry", said: answer.said };
  const text = wholeDraft(answer.text);
  if (text === "") return written.repaired && first !== null ? draftOutcome(first, model, answer.ms, true) : { state: "retry", said: "Claude's draft came back empty." };
  return draftOutcome(text, model, answer.ms, written.repaired);
}

/** A draft step's result: the draft whole, on the card and in its log. */
function draftOutcome(text: string, model: string, ms: number | null, shortened: boolean): Outcome {
  const words = text.split(/\s+/).filter(Boolean).length;
  const over = text.length > DRAFT_CHARS ? ` It is still over the ${DRAFT_CHARS.toLocaleString("en-US")}-character limit after one ask to shorten, so it is kept whole.` : shortened ? " Shortened once to fit." : "";
  return { state: "passed", said: `Drafted ${words} word${words === 1 ? "" : "s"}.${over}`, output: text, log: `Claude (${model})${ms === null ? "" : ` · ${(ms / 1000).toFixed(1)} s`}\n\n${text}` };
}

/** A sort: Jev picks one of the zone's answers for the card; the answer (or the not-sure path) says where it goes. */
async function sortCard(definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, key: string, io: StepIo): Promise<Outcome> {
  const index = definition.stages.findIndex(one => one.id === stage.id);
  const earlier = definition.stages.filter((one, at) => at !== index && card.outputs[one.id] !== undefined).map(one => ({ id: one.id, title: one.title }));
  const asked = await askJev(io.fetch, key, sortRequest(stage.sort!, sortState(card, earlier)));
  if (!asked.ok) return { state: "retry", said: asked.said };
  const decision = readJevAnswers(stage, asked.body, asked.ms);
  if ("problem" in decision) return { state: "retry", said: decision.problem };
  return { state: "passed", said: sortWords(decision), log: sortLog(stage, decision), to: decision.to, decisionJson: JSON.stringify(decision), unsure: !decision.confident };
}

/** A script step: a fresh detached copy at the card's latest result (or the base branch), the approved setup, then the script. */
/**
 * A script zone (v90: code steps): the script runs with the card as its input, in a clean folder or in
 * a copy of the card's work (after the project's setup), inside the agents' fence. What it prints is
 * the step's result; a last "goto:" line picks one of the zone's answers.
 */
async function runCheck(store: Store, flow: FlowRow, stage: FlowStage, script: FlowScriptRow, card: FlowCardRow, now: Date, io: StepIo): Promise<Outcome> {
  const task = card.primaryTask ?? card.task;
  const copy = (stage.runIn ?? "copy") === "copy";
  const receipt = !copy || task === null ? null : assignmentOf(store, task, now, { principal: "operator", repos: [flow.repo] }, io.evidenceRoot)?.receipt ?? null;
  const commit = receipt?.head ?? null;
  const where = !copy ? "" : commit === null ? ` on ${io.base}` : ` on commit ${commit.slice(0, 7)}`;
  // The secrets it names, from the flow's saved ones: a missing one is said, never run without.
  const saved = readFlowSecrets(io.dir, flow.repo);
  const missing = (stage.secrets ?? []).filter(name => saved[name] === undefined);
  if (missing.length > 0) return { state: "failed", said: `${script.name} needs the secret${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Save ${missing.length === 1 ? "it" : "them"} on the zone, then move the card back to try again.` };
  const secrets = Object.fromEntries((stage.secrets ?? []).map(name => [name, saved[name]!]));
  mkdirSync(io.scratch, { recursive: true });
  const path = copy ? join(io.scratch, `flow-check-${card.id}-${card.entry}`) : cleanFolder(io.scratch, `flow-run-${card.id}-${card.entry}`);
  if (copy) {
    rmSync(path, { recursive: true, force: true });
    const added = await io.git("git", ["-C", flow.repo, "worktree", "add", "--detach", path, commit ?? io.base], { timeoutMs: 120_000 });
    if (added.code !== 0) return { state: "retry", said: `Couldn't make a copy of${where}: ${added.stderr.trim().split("\n")[0]?.slice(0, 160) ?? "git refused"}.` };
  }
  try {
    const fence = agentFence({ databaseFile: store.databaseFile(), worktree: path });
    let log = "";
    const setup = copy ? store.liveWorktreeSetup(flow.repo) : null;
    if (setup !== null) {
      const shell = approvedCommandShell(setup.command);
      const prepared = await io.shell(shell.file, shell.args, { cwd: path, timeoutMs: setup.timeoutMs, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST, processGroup: true, fence });
      log += `$ ${setup.command}\n${prepared.stdout}${prepared.stderr}\n`;
      if (prepared.code !== 0) return { state: "failed", said: `The project's setup failed before ${script.name} ran (exit ${prepared.code}).\n${tail(`${prepared.stdout}\n${prepared.stderr}`)}`, log, exitCode: prepared.code };
    }
    const definition = flowDefinitionOf(flow);
    const titleOf = (id: string) => definition?.stages.find(one => one.id === id.split(".")[0])?.title ?? id;
    // The card as data: never part of a command.
    const input = {
      card: { id: card.id, title: card.title, description: card.description, email: cardEmailOf(card) || null, note: card.note, owner: card.owner, source: card.source === null ? null : { kind: card.source.kind, label: card.source.label, url: card.source.url } },
      outputs: Object.fromEntries(Object.entries(card.outputs).map(([id, text]) => [id, { zone: titleOf(id), text }])),
      flow: { id: flow.id, name: flow.name }, zone: { id: stage.id, title: stage.title }, visit: card.entry, commit,
      answers: (stage.routes ?? []).map(one => one.answer),
    };
    const env = { FLOW_NAME: flow.name, FLOW_CARD_ID: String(card.id), FLOW_CARD_TITLE: card.title, FLOW_COMMIT: commit ?? "", FLOW_SCRIPT: script.name, FLOW_PROJECT: flow.repo };
    const ran = await runCode({ script, cwd: path, root: copy ? path : flow.repo, input, env, secrets, scratch: io.scratch, shell: io.shell, fence });
    log += ran.log;
    const output = ran.output === "" ? undefined : ran.output;
    // Where it ran goes at the end of the first line: "run-tests failed (exit 1) on main."
    const placed = (said: string) => { const [first = "", ...rest] = said.split("\n"); return [first.replace(/\.$/, `${where}.`), ...rest].join("\n"); };
    if (ran.state === "failed") return { state: "failed", said: placed(ran.said), log, exitCode: ran.exitCode, ...(output === undefined ? {} : { output }) };
    if (ran.goTo === null) return { state: "passed", said: copy ? `${script.name} passed${where}.` : `${script.name} ran.`, log, exitCode: 0, ...(output === undefined ? {} : { output }) };
    const route = (stage.routes ?? []).find(one => one.answer.toLowerCase() === ran.goTo!.toLowerCase());
    if (route === undefined) return { state: "failed", said: `${script.name} picked “${ran.goTo}”, but this zone has no answer called that${(stage.routes ?? []).length === 0 ? "" : ` (it has ${(stage.routes ?? []).map(one => one.answer).join(", ")})`}.`, log, exitCode: 0, ...(output === undefined ? {} : { output }) };
    return { state: "passed", said: `${script.name} ran${where} and picked ${route.answer}.`, log, exitCode: 0, to: route.to, ...(output === undefined ? {} : { output }) };
  } finally {
    if (copy) await io.git("git", ["-C", flow.repo, "worktree", "remove", "--force", path], { timeoutMs: 60_000 }).catch(() => undefined);
    rmSync(path, { recursive: true, force: true });
  }
}

/** An update: a comment on the issue the card came from, and closing it if the zone says so. */
async function updateSource(store: Store, stage: FlowStage, card: FlowCardRow, io: StepIo, now: Date): Promise<Outcome> {
  const source = card.source;
  const text = fillFlowText(stage.message ?? "Done: {{card.title}}", { title: card.title, description: card.description, note: card.note, outputs: card.outputs });
  if (scanForSecrets(text).length > 0) return { state: "failed", said: "The comment looked like it held a key or password, so nothing was posted." };
  // A card from a chat channel (v89): the answer goes in the thread it came from.
  if (source?.chat !== undefined) {
    const replied = replyInChannel(store, source.chat, { card: card.id, entry: card.entry }, text, now);
    return replied.ok ? { state: "passed", said: `Answered in the ${source.label.replace(/ message$/, "")} thread.` } : { state: "failed", said: replied.said };
  }
  const github = source?.kind === "github" && source.url !== null ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)$/.exec(source.url) : null;
  if (github !== null) {
    const [, repo, what, number] = github;
    const commented = await io.gh("gh", ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${text}`], { timeoutMs: 20_000 });
    if (commented.code !== 0) return { state: "retry", said: `GitHub didn't take the comment: ${(commented.stderr || commented.stdout).trim().split("\n")[0]?.slice(0, 160)}.` };
    if (stage.close === true && what === "issues") {
      const closed = await io.gh("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"], { timeoutMs: 20_000 });
      if (closed.code !== 0) return { state: "retry", said: `Commented, but GitHub didn't close it: ${(closed.stderr || closed.stdout).trim().split("\n")[0]?.slice(0, 160)}.` };
      return { state: "passed", said: `Commented on and closed ${source!.label}.` };
    }
    return { state: "passed", said: `Commented on ${source!.label}.` };
  }
  const linear = source?.kind === "linear" ? /^Linear ([A-Z][A-Z0-9]*-\d+)$/.exec(source.label)?.[1] ?? null : null;
  if (linear !== null) {
    const key = readLinearKey(io.dir);
    if (key === null) return { state: "failed", said: "Needs a Linear API key to update the issue. Add it on the flow's Triggers panel." };
    const ask = async (query: string, variables: Record<string, unknown>) => {
      const response = await io.fetch(LINEAR_URL, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as { data?: Record<string, unknown>; errors?: { message?: string }[] };
      if (!response.ok || (body.errors?.length ?? 0) > 0) throw new Error(`Linear said: ${(body.errors?.[0]?.message ?? `status ${response.status}`).slice(0, 160)}.`);
      return body.data ?? {};
    };
    try {
      const found = await ask("query FlowIssue($id: String!) { issue(id: $id) { id team { states(filter: { type: { eq: \"completed\" } }) { nodes { id name } } } } }", { id: linear });
      const issue = found["issue"] as { id: string; team: { states: { nodes: { id: string; name: string }[] } } } | null;
      if (issue === null || issue === undefined) return { state: "failed", said: `Linear has no issue ${linear} this key can see.` };
      await ask("mutation FlowComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId: issue.id, body: text } });
      if (stage.close === true) {
        const done = issue.team.states.nodes[0];
        if (done === undefined) return { state: "passed", said: `Commented on ${linear}; its team has no done state to move it to.` };
        await ask("mutation FlowDone($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issue.id, input: { stateId: done.id } });
        return { state: "passed", said: `Commented on ${linear} and moved it to ${done.name}.` };
      }
      return { state: "passed", said: `Commented on ${linear}.` };
    } catch (error) {
      return { state: "retry", said: error instanceof Error ? error.message : "Couldn't reach Linear." };
    }
  }
  return { state: "passed", said: "Nothing to update: this card didn't come from a GitHub or Linear issue or a chat channel." };
}
