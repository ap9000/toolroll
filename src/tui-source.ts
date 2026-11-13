/**
 * The terminal UI's view of this installation (tui-contract.ts TuiSource), in this process.
 *
 * Reads come straight from the database through a read-only handle (the task list and a task's own envelopes through
 * `runOperate`, live output through peek's tail reader, the store's wake sequence as the change signal). Every write
 * goes through `runOperate` inside runAsLocalOwner: the same commands, rows and refusals as the CLI, bound to local
 * mode when each command opens the database, never to anything the screen says. Every command runs with --json, so
 * nothing ever prompts on the terminal the screen owns.
 */
import { dirname, join } from "node:path";
import { advancedShownFor } from "./advanced.js";
import { assignmentOf, owedAcceptance } from "./assignment.js";
import { agentlessFirstRun, buildersFor } from "./dispatch.js";
import { familyChangedFiles } from "./result-completion.js";
import { checkBackingOf, receiptChecksOf, requirementWordOf } from "./task-status.js";
import { checklistLines, mergeChecklistOf } from "./merge-checklist.js";
import { runAsLocalOwner } from "./local-owner.js";
import type { OperateOptions } from "./operate.js";
import { snapshotLiveRuns } from "./peek-cli.js";
import type { ConnectionChecker } from "./provider-connection.js";
import { loadProjectRegistry } from "./repos.js";
import { describeScope } from "./scope.js";
import { localModeOf, openStoreReadOnly, type Store } from "./store.js";
import { routeChangeOf } from "./route-change.js";
import { flakyCount } from "./flaky.js";
import { memoryWaiting } from "./lesson-notes.js";
import { homeGroupOf } from "./home-groups.js";
import type { TuiAct, TuiActResult, TuiDecision, TuiFastTerms, TuiResult, TuiRow, TuiSetup, TuiSnapshot, TuiSource, TuiTask } from "./tui-contract.js";
import { terminalText } from "./terminal-text.js";
import { welcomeHere, welcomeLines } from "./welcome-facts.js";
import { planSourceOf, retryPinsOf } from "./local-owner-acts.js";

export type TuiSourceOptions = {
  databaseFile: string;
  clock?: () => Date;
  /** Passed to every runOperate (tests: a fixed clock, seams). */
  operate?: OperateOptions;
  /** The agents' sign-in check for the Setup screen (tests pass their own). */
  check?: ConnectionChecker;
};

type Envelope = Record<string, unknown> & { ok?: boolean; reason?: string; message?: string };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const words = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
/** Text for the screen: whatever wrote it (an agent, a person, a project's name), escapes and controls never reach the
 * terminal (terminal-text.ts). Every displayed string below goes through here; ids and digests are only acted on. */
const shown = (value: unknown, fallback = ""): string => terminalText(words(value, fallback));

/** What a refused write says, and whether it is a local-owner refusal (the screen then leads to a password), or a
 * result that changed since the screen read it. */
function refusalOf(envelope: Envelope): TuiActResult {
  const message = shown(envelope.message, "That was refused.");
  if (envelope.reason === "stale") return { ok: false, message, needsPassword: false, changed: true };
  return { ok: false, message, needsPassword: envelope.reason === "refused" || envelope.reason === "machine-proof" || envelope.reason === "person-required" || /password/i.test(message) };
}

const routeLines = (store: Store, id: string): string[] => { const words = routeChangeOf(store, id); return words === null ? [] : [words]; };

export function createTuiSource(options: TuiSourceOptions): TuiSource & { close(): void } {
  const file = options.databaseFile;
  const clock = options.clock ?? (() => new Date());
  const evidenceRoot = join(dirname(file), "evidence");
  const tails: NonNullable<Parameters<typeof snapshotLiveRuns>[3]> = new Map();
  let reader: Store | null = null;
  let closed = false;
  const read = (): Store | null => {
    if (closed) return null;
    reader ??= openStoreReadOnly(file);
    return reader;
  };

  /** One command as the local owner, with --json: its envelope (an unreadable answer reads as a refusal). */
  async function command(argv: readonly string[]): Promise<Envelope> {
    const [name = "", ...rest] = argv;
    let out = "";
    const { runOperate } = await import("./operate.js");
    await runAsLocalOwner(() => runOperate(name, [...rest, "--json", "--db", file], text => { out += `${text}\n`; }, options.operate ?? {}));
    try { return record(JSON.parse(out.trim())) as Envelope; }
    catch {
      const last = out.trim().split("\n").at(-1) ?? "";
      try { return record(JSON.parse(last)) as Envelope; } catch { return { ok: false, reason: "unreadable", message: "Toolroll's answer couldn't be read." }; }
    }
  }

  let setupCache: { at: number; value: TuiSetup | null } | null = null;

  return {
    async snapshot(): Promise<TuiSnapshot> {
      const listed = await command(["task", "list"]);
      const tasks = Array.isArray(listed["tasks"]) ? listed["tasks"] as unknown[] : [];
      const rows: TuiRow[] = tasks.map(one => {
        const row = record(one), status = record(row["status"]);
        const views = Array.isArray(status["views"]) ? status["views"] as unknown[] : [];
        return {
          id: words(row["id"], words(row["rootId"])), title: shown(row["title"]), status: shown(status["label"], words(row["state"])), detail: shown(status["detail"]),
          needsYou: views.includes("needs-you"), liveRunId: typeof row["liveRunId"] === "number" ? row["liveRunId"] : null, repo: typeof row["repo"] === "string" ? row["repo"] : null,
          // The same rule as Home's groups, over the same work index item.
          group: homeGroupOf({ status: { views: views.filter((one): one is string => typeof one === "string") } }),
        };
      });
      const waiting = rows.filter(one => one.needsYou);
      const needsYou = waiting.length === 0 ? null : `${waiting.length === 1 ? "1 task needs" : `${waiting.length} tasks need`} you: ${waiting[0]!.title}`;
      const registry = await loadProjectRegistry(join(dirname(file), "repos.json"));
      const store = read();
      const mode = store === null ? null : localModeOf(store);
      const passwordSet = store !== null && mode !== null && store.accountOf(mode.owner)?.passwordSet === true;
      // Settings → Advanced: flaky tests are an advanced feature; the local owner's own switch decides (no local mode: no
      // one person to ask, so it shows as before). Memory suggestions wait on a person, so they show whatever the switch.
      const advanced = store === null || mode === null || advancedShownFor(store, mode.owner);
      return { rows, needsYou, projects: "error" in registry ? [] : registry.repos, passwordSet, learning: store === null ? null : learningLine(store, "error" in registry ? [] : registry.repos, clock(), advanced) };
    },

    async task(id: string): Promise<TuiTask | null> {
      const answer = await command(["task", "show", id]);
      if (answer.ok !== true) return null;
      const task = record(answer["task"]), work = record(answer["work"]), status = record(work["status"]);
      const store = read();
      const scope = store === null ? null : store.getScope(id);
      const plan = scope === null || scope.approvedDigest === scope.digest ? null : { digest: scope.digest, lines: [...(store === null ? [] : routeLines(store, id)), ...describeScope(scope)].map(line => terminalText(line)) };
      let hasResult = false;
      try { hasResult = store !== null && assignmentOf(store, id, clock(), { principal: "operator", repos: null })?.receipt != null; } catch { hasResult = false; }
      const decisions: TuiDecision[] = store === null ? [] : store.listDecisions("unanswered").filter(one => one.taskId === id)
        .map(one => ({ id: one.id, question: terminalText(one.question), options: one.options.map(option => ({ id: option.id, label: terminalText(option.label) })) }));
      // "Can I merge?": the same checklist and lines as `toolroll task ready`, read from the same records.
      let ready: string[] = [];
      try {
        const list = !hasResult || store === null ? null : mergeChecklistOf(store, id, clock(), { principal: "operator", repos: null }, evidenceRoot);
        ready = list === null ? [] : checklistLines(list).map(line => terminalText(line));
      } catch { ready = []; }
      return {
        id, title: shown(task["title"], id), status: shown(status["label"], words(work["state"])), detail: shown(status["detail"]),
        plan, liveRunId: typeof work["liveRunId"] === "number" ? work["liveRunId"] : null, hasResult, decisions, ready,
        planAsk: store === null ? null : planAskOf(store, id),
        retry: (() => { const pins = store === null ? null : retryPinsOf(store, id); return pins === null ? null : { runId: pins.run, digest: pins.digest }; })(),
      };
    },

    live(id: string): readonly string[] {
      const store = read();
      if (store === null) return [];
      try { return snapshotLiveRuns(store, evidenceRoot, clock(), tails).find(one => one.taskId === id)?.lines.map(line => terminalText(line)) ?? []; } catch { return []; }
    },

    changed(): number {
      try { return read()?.wakeSeq() ?? 0; } catch { return 0; }
    },

    async act(act: TuiAct): Promise<TuiActResult> {
      let argv: string[];
      let done: string;
      switch (act.kind) {
        // A task too big to build straight away: filed, then its plan asked for at once (local-owner slice 2), below.
        case "new": argv = ["task", "add", act.text, ...(act.repo === null ? [] : ["--repo", act.repo])]; done = "Filed."; break;
        case "plan": argv = ["task", "plan", act.id, "--digest", act.source]; done = "Asked for a plan. You'll approve it before anything is built."; break;
        case "build": argv = ["task", "new", "--build", act.preview, "--digest", act.digest]; done = "Building. It starts next."; break;
        case "approve": argv = ["task", "approve", act.id, "--yes", "--digest", act.digest]; done = "Approved. An agent starts on it."; break;
        case "stop": argv = ["task", "stop", act.id, "--run", String(act.runId)]; done = "Stopping. Its work so far is kept."; break;
        case "revise": argv = ["task", "revise", act.id, "--feedback", act.text]; done = "Sent back with your note."; break;
        case "answer": argv = ["decide", String(act.decision), "--choose", act.option]; done = "Answered."; break;
        // Retry: exactly the build and approved plan the screen read (local-owner slice 3), never the current ones.
        case "retry": argv = ["task", "requeue", act.id, "--run", String(act.runId), "--digest", act.digest]; done = "Retrying. It starts next."; break;
        // Accept: exactly the result the Accept screen read, never the one current when this is sent (the command
        // refuses a result that changed meanwhile). The person's yes to their own check, or a reason, only when given.
        case "complete":
          argv = ["task", "complete", act.id, "--run", String(act.runId), "--digest", act.digest, ...(act.checked ? ["--checked"] : []), ...(act.reason === null ? [] : ["--reason", act.reason])];
          done = "Accepted. The task is done."; break;
      }
      const answer = await command(argv);
      if (answer.ok !== true) return refusalOf(answer);
      if (act.kind === "complete" && answer["replayed"] === true) return { ok: true, message: "Already accepted. The task is done." };
      if (act.kind === "plan" && answer["replayed"] === true) return { ok: true, message: "Already asked for a plan." };
      if (act.kind === "retry" && answer["replayed"] === true) return { ok: true, message: "Already retrying. It starts next." };
      const filed = act.kind === "new" ? words(record(answer["task"])["id"], words(answer["id"])) : act.kind === "build" ? words(answer["task"]) : "";
      // Filed in a project: ask for its plan now, bound to the task just filed (the screen promised a plan).
      if (act.kind === "new" && filed !== "" && act.repo !== null) {
        const store = read();
        const ask = store === null ? null : planAskOf(store, filed);
        const asked = ask === null ? null : await command(["task", "plan", filed, "--digest", ask.source]);
        // No coding agent signed in on this computer yet: the plan waits for it, and the one command says how.
        const filedRef = store === null ? null : store.lookupRef(filed);
        const agentless = store === null || filedRef === null || asked?.ok !== true ? null
          : agentlessFirstRun(store, filedRef, true, buildersFor(store, act.repo, clock()).alive.map(one => one.name));
        const message = asked?.ok !== true ? `Filed. It wasn't sent for a plan: ${shown(asked?.message, "it can't be planned now.")}`
          : agentless !== null ? `Filed. ${agentless.words}`
          : "Filed. Planning: you'll approve the plan before anything is built.";
        return { ok: true, message, id: filed };
      }
      return { ok: true, message: done, ...(filed === "" ? {} : { id: filed }) };
    },

    async result(id: string): Promise<TuiResult | null> {
      const store = read();
      if (store === null) return null;
      try { return resultOf(store, id, clock(), evidenceRoot); } catch { return null; }
    },

    async fastTerms(text: string, repo: string | null): Promise<TuiFastTerms | null> {
      if (repo === null) return null;
      const answer = await command(["task", "new", text, "--repo", repo, "--preview"]);
      if (answer.ok !== true || answer["eligible"] !== true) return null;
      const terms = Array.isArray(answer["terms"]) ? answer["terms"].map(one => ({ label: words(record(one)["label"]), words: words(record(one)["words"]) })) : [];
      return { preview: words(answer["preview"]), digest: words(answer["digest"]), terms };
    },

    async setup(): Promise<TuiSetup | null> {
      if (setupCache !== null && Date.now() - setupCache.at < 30_000) return setupCache.value;
      const store = read();
      if (store === null) return null;
      // The screen can close while this waits on the sign-in checks: the store it holds is gone then, and so is the question.
      const here = await welcomeHere(store, file, clock(), options.check === undefined ? {} : { check: options.check }).catch((problem: unknown) => {
        if (closed) return null;
        throw problem;
      });
      if (here === null) return null;
      const value = here.model.left === 0 ? null : { left: here.model.left, lines: welcomeLines(here.model).map(line => terminalText(line)) };
      setupCache = { at: Date.now(), value };
      return value;
    },

    close(): void {
      closed = true;
      reader?.close();
      reader = null;
    },
  };
}

/** The screen's one line about the learning loops: flaky tests and what waits in project memory, each with its command.
 * `advanced` false (Settings → Advanced off) leaves out flaky tests only: memory suggestions wait on a person and always
 * show. */
export function learningLine(store: Store, repos: readonly string[], now: Date, advanced = true): string | null {
  let flaky = 0, memory = 0;
  try {
    for (const repo of repos) {
      if (advanced) flaky += flakyCount(store, repo, now);
      const waiting = memoryWaiting(store, repo);
      memory += waiting.notes + waiting.cleanups;
    }
  } catch { return null; }
  const parts = [flaky === 0 ? "" : `${flaky} flaky test${flaky === 1 ? "" : "s"}: open the project's Flaky tests in the browser`, memory === 0 ? "" : `${memory} project memory suggestion${memory === 1 ? "" : "s"}: open Settings → Knowledge`].filter(Boolean);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The Accept screen's one read of a task's current result (local-owner slice 1): which build and receipt it pins, and
 * what the result page would show about it — the agent's summary, the files changed, each requirement and how it is
 * shown, the actual check status, and what accepting it needs from the person. Text from outside is cleaned here. */
function resultOf(store: Store, id: string, now: Date, evidenceRoot: string): TuiResult | null {
  const assignment = assignmentOf(store, id, now, { principal: "operator", repos: null }, evidenceRoot);
  const receipt = assignment?.receipt ?? null;
  if (assignment === null || receipt === null) return null;
  const blockers = assignment.readiness?.blockers ?? [];
  const owed = assignment.state === "ready-to-check" ? owedAcceptance(receipt, blockers) : null;
  // An exception's own blocker is what its reason answers; any other one stands in the way of accepting.
  const standing = blockers.filter(one => !(owed === "exception" && one.key === "criteria")).map(one => terminalText(one.message));
  const notNow = assignment.state === "complete" ? "This result is already accepted." : assignment.state === "ready-to-check" ? null : terminalText(assignment.detail || "This result isn't ready to accept.");
  const changed = familyChangedFiles(store, receipt.taskId, receipt.runId, evidenceRoot);
  const backing = checkBackingOf(receiptChecksOf(receipt));
  let checks: string[] = [];
  try { const list = mergeChecklistOf(store, id, now, { principal: "operator", repos: null }, evidenceRoot); checks = list === null ? [] : checklistLines(list).map(line => terminalText(line)); } catch { checks = []; }
  return {
    id, runId: receipt.runId, digest: receipt.digest, title: terminalText(assignment.title),
    ready: notNow === null && standing.length === 0, blockers: notNow === null ? standing : [notNow],
    summary: (receipt.agentReport ?? "").split("\n").map(line => terminalText(line).trimEnd()).filter(line => line.trim() !== "").slice(0, 8),
    files: changed === null ? null : { names: changed.slice(0, 10).map(name => terminalText(name)), more: Math.max(0, changed.length - 10) },
    requirements: (receipt.proof?.matrix ?? []).map(row => ({ word: requirementWordOf(row, receipt.proof?.verdict ?? null, backing), statement: terminalText(row.statement ?? row.id ?? "") })),
    checks, owed,
  };
}

/** Whether a plan can be asked for this task now, and the planning source a request binds to (local-owner slice 2): a
 * queued task with no plan asked or drafted and no approved plan. What the screen offers only; the command decides. */
function planAskOf(store: Store, id: string): { source: string } | null {
  const ref = store.lookupRef(id);
  const scope = store.getScope(id);
  if (ref === null || ref.plan !== null || store.getTask(id)?.state !== "queued" || (scope !== null && scope.approvedAt !== null && scope.approvedDigest === scope.digest)) return null;
  const source = planSourceOf(store, id);
  return source === null ? null : { source };
}
