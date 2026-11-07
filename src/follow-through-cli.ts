/**
 * The terminal's side of follow-through (docs/plans/fleet-follow-through.md): `finding`, `task handover`, `task before-after`,
 * `task failing-first` and `captures`. Each act the task page offers, in the same shared code. A write needs a verified
 * person: `prove` asks operate.ts for it and answers with their name, or null when it has already said why not.
 */
import { checkRepairsOfTask, checkRepairWords } from "./check-repair.js";
import { askFailingFirst, dropFailingFirst, evidencePairsOf, evidenceWords, failingFirstOf, failingFirstWords, rerunEvidence, saveEvidencePair } from "./evidence-pair.js";
import { closeFinding, findingLine, findingsOfTask, findingStandingWords, getFinding, resendFinding, sendCheckFinding, sendFinding, sendReviewFinding, waitingFindings, type Finding, type SendAnswer } from "./findings.js";
import { handoverLines, handoverNoteOf } from "./handover-note.js";
import { captureFixture, labelProviderCapture, providerCapture, providerCaptures } from "./provider-capture.js";
import type { Store } from "./store.js";

export const FINDING_ACTIONS = ["list", "show", "send", "resend", "close"] as const;
export const CAPTURE_ACTIONS = ["list", "show", "mark", "export"] as const;

export type FollowThroughContext = {
  store: Store; evidenceRoot: string; now: Date;
  ok: (command: string, result: Record<string, unknown>, lines: () => string[]) => number;
  no: (command: string, reason: "usage" | "unknown-task" | "refused", message: string) => number;
  /** A verified person with access to `repo`: every write names the project of the record it touches. */
  prove: (command: string, repo: string | null) => Promise<string | null>;
};
type Flags = Map<string, string | true>;
const text = (flags: Flags, name: string): string | undefined => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };

const findingLines = (finding: Finding): string[] => [`${findingLine(finding)}`, `  ${finding.taskId} · from ${finding.sentBy}: ${findingStandingWords(finding)}`];

export const sendWords = (sent: Extract<SendAnswer, { ok: true }>): string => ({
  running: `Finding #${sent.id} goes to the running build.`,
  "next-attempt": `Finding #${sent.id} waits for this task's next attempt.`,
  "with-person": `Finding #${sent.id} has used its rounds: it's yours to decide.`,
  "already-sent": `Finding #${sent.id} is already with the task.`,
}[sent.standing]);

export async function findingCommand(positional: readonly string[], flags: Flags, context: FollowThroughContext): Promise<number> {
  const { store, now, ok, no, prove } = context;
  const [action, target] = positional;
  const command = `finding ${action ?? ""}`.trim();
  if (action === "list") {
    const task = text(flags, "task");
    const found = task === undefined ? waitingFindings(store, null) : findingsOfTask(store, task);
    return ok(command, { findings: found }, () => found.length === 0 ? ["No findings are waiting."] : found.flatMap(findingLines));
  }
  if (action === "show") {
    const found = getFinding(store, Number(target));
    if (found === null) return no(command, "unknown-task", `no finding #${target ?? ""}`);
    return ok(command, { finding: found }, () => [...findingLines(found), `  requested: ${found.action}`, ...(found.excerpt === null ? [] : [`  evidence: ${found.excerpt}`]), ...(found.sourceRun === null ? [] : [`  result: /r/${found.sourceRun}`])]);
  }
  if (action === "send") {
    const review = text(flags, "from-review"), check = text(flags, "from-check"), note = text(flags, "note");
    if (target === undefined || [review, check, note].filter(one => one !== undefined).length !== 1) return no(command, "usage", '`toolroll finding send <task> --note "..." [--path <file> --line <n> --action "..."] --as <you> --token <t>`, or --from-review <run>:<number>, or --from-check <run>');
    const by = await prove(command, store.lookupRef(target)?.repo ?? null);
    if (by === null) return 1;
    const lineWords = text(flags, "line");
    const sent = review !== undefined ? sendReviewFinding(store, target, review, by, now)
      : check !== undefined ? sendCheckFinding(store, context.evidenceRoot, target, Number(check), by, now)
        : sendFinding(store, { taskId: target, source: "person", by, summary: note!, action: text(flags, "action") ?? "", file: text(flags, "path") ?? null, line: lineWords === undefined ? null : Number(lineWords) }, now);
    if (!sent.ok) return no(command, sent.reason === "unknown-task" ? "unknown-task" : "refused", sent.message);
    return ok(command, { finding: sent.id, standing: sent.standing, round: sent.round }, () => [sendWords(sent)]);
  }
  if (action === "resend") {
    const by = await prove(command, getFinding(store, Number(target))?.repo ?? null);
    if (by === null) return 1;
    const sent = resendFinding(store, Number(target), now);
    if (!sent.ok) return no(command, sent.reason === "unknown-task" ? "unknown-task" : "refused", sent.message);
    return ok(command, { finding: sent.id, standing: sent.standing, round: sent.round }, () => [sendWords(sent)]);
  }
  if (action === "close") {
    const note = text(flags, "note");
    if (target === undefined || note === undefined) return no(command, "usage", '`toolroll finding close <id> --note "why" --as <you> --token <t>`');
    const by = await prove(command, getFinding(store, Number(target))?.repo ?? null);
    if (by === null) return 1;
    const closed = closeFinding(store, Number(target), by, note, now);
    return closed.ok ? ok(command, { finding: Number(target), closedBy: by }, () => [`Finding #${target} is closed.`]) : no(command, "refused", closed.message);
  }
  return no("finding", "usage", `try ${FINDING_ACTIONS.join(", ")}`);
}

export function handoverCommand(positional: readonly string[], context: FollowThroughContext): number {
  const id = positional[0];
  const command = "task handover";
  if (id === undefined) return context.no(command, "usage", "which task?");
  const note = handoverNoteOf(context.store, context.evidenceRoot, id, context.now);
  if (note === null) return context.no(command, "unknown-task", `no task \`${id}\``);
  return context.ok(command, { note, checkRepairs: checkRepairsOfTask(context.store, id).map(checkRepairWords) }, () => handoverLines(note));
}

export async function evidenceCommand(positional: readonly string[], flags: Flags, context: FollowThroughContext): Promise<number> {
  const { store, evidenceRoot, now, ok, no, prove } = context;
  const [id, action] = positional;
  const command = "task before-after";
  if (id === undefined || store.lookupRef(id) === null) return no(command, id === undefined ? "usage" : "unknown-task", id === undefined ? "`toolroll task before-after <id> [save [--run <n>] | rerun] --as <you> --token <t>`" : `no task \`${id}\``);
  const repo = store.lookupRef(id)?.repo ?? null;
  if (action === "save") {
    const by = await prove(command, repo);
    if (by === null) return 1;
    const run = text(flags, "run");
    const saved = saveEvidencePair(store, evidenceRoot, { taskId: id, ...(run === undefined ? {} : { runId: Number(run) }), by }, now);
    return saved.ok ? ok(command, { pair: saved.id, existing: saved.existing }, () => [saved.existing ? "That failure is already saved." : "Saved the failing result."]) : no(command, saved.reason === "unknown" ? "unknown-task" : "refused", saved.message);
  }
  if (action === "rerun") {
    const by = await prove(command, repo);
    if (by === null) return 1;
    const asked = rerunEvidence(store, id, by, now);
    return asked.ok ? ok(command, { run: asked.run, head: asked.head, request: asked.request }, () => [`The same check runs on ${asked.head.slice(0, 7)} (build #${asked.run}), with no agent.`]) : no(command, "refused", asked.message);
  }
  if (action !== undefined) return no(command, "usage", "try save or rerun");
  const pairs = evidencePairsOf(store, evidenceRoot, id, now);
  const step = failingFirstOf(store, id);
  const words = failingFirstWords(step);
  return ok(command, { pairs, failingFirst: step }, () => [...(pairs.length === 0 ? ["No failing result is saved."] : pairs.map(evidenceWords)), ...(words === null ? [] : [words])]);
}

export async function failingFirstCommand(positional: readonly string[], context: FollowThroughContext): Promise<number> {
  const { store, now, ok, no, prove } = context;
  const [id, state] = positional;
  const command = "task failing-first";
  if (id === undefined || (state !== "on" && state !== "off")) return no(command, "usage", "`toolroll task failing-first <id> on|off --as <you> --token <t>`");
  if (store.lookupRef(id) === null) return no(command, "unknown-task", `no task \`${id}\``);
  const by = await prove(command, store.lookupRef(id)?.repo ?? null);
  if (by === null) return 1;
  if (state === "on") askFailingFirst(store, id, by, now); else dropFailingFirst(store, id);
  return ok(command, { task: id, on: state === "on" }, () => [state === "on" ? "The next attempt writes a failing test first." : "Failing test first is off."]);
}

export async function capturesCommand(positional: readonly string[], context: FollowThroughContext): Promise<number> {
  const { store, ok, no, prove } = context;
  const [action, target, label] = positional;
  const command = `captures ${action ?? ""}`.trim();
  if (action === "list") {
    const all = providerCaptures(store, null);
    return ok(command, { captures: all }, () => all.length === 0 ? ["No provider failures are saved."] : all.map(one => `#${one.id} ${one.provider}${one.model === null ? "" : ` · ${one.model}`} build #${one.run}${one.hint ? " · mentions limits" : ""}${one.label === null ? "" : ` · ${one.label}`}: ${one.text.slice(0, 120)}`));
  }
  const capture = target === undefined ? null : providerCapture(store, Number(target));
  if (action === "show" || action === "export" || action === "mark") {
    if (capture === null) return no(command, "unknown-task", `no capture #${target ?? ""}`);
    if (action === "show") return ok(command, { capture }, () => [`#${capture.id} ${capture.provider} · exit ${capture.exitCode ?? "none"}${capture.code === null ? "" : ` · ${capture.code}`}`, capture.text]);
    if (action === "export") return ok(command, { fixture: captureFixture(capture) }, () => [JSON.stringify(captureFixture(capture), null, 2)]);
    if (label !== "exhausted" && label !== "not-exhausted") return no(command, "usage", "`toolroll captures mark <id> exhausted|not-exhausted --as <you> --token <t>`");
    const by = await prove(command, capture.repo);
    if (by === null) return 1;
    labelProviderCapture(store, capture.id, label, by);
    return ok(command, { capture: capture.id, label }, () => [`Capture #${capture.id} is marked ${label}. Nothing routes on this.`]);
  }
  return no("captures", "usage", `try ${CAPTURE_ACTIONS.join(", ")}`);
}
