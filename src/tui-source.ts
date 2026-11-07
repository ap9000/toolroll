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
import { assignmentOf } from "./assignment.js";
import { checklistLines, mergeChecklistOf } from "./merge-checklist.js";
import { runAsLocalOwner } from "./local-owner.js";
import type { OperateOptions } from "./operate.js";
import { snapshotLiveRuns } from "./peek-cli.js";
import type { ConnectionChecker } from "./provider-connection.js";
import { loadProjectRegistry } from "./repos.js";
import { describeScope } from "./scope.js";
import { localModeOf, openStoreReadOnly, type Store } from "./store.js";
import type { TuiAct, TuiActResult, TuiDecision, TuiFastTerms, TuiRow, TuiSetup, TuiSnapshot, TuiSource, TuiTask } from "./tui-contract.js";
import { terminalText } from "./terminal-text.js";
import { welcomeHere, welcomeLines } from "./welcome-facts.js";

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

/** What a refused write says, and whether it is a local-owner refusal (the screen then leads to a password). */
function refusalOf(envelope: Envelope): TuiActResult {
  const message = shown(envelope.message, "That was refused.");
  return { ok: false, message, needsPassword: envelope.reason === "refused" || envelope.reason === "machine-proof" || envelope.reason === "person-required" || /password/i.test(message) };
}

export function createTuiSource(options: TuiSourceOptions): TuiSource & { close(): void } {
  const file = options.databaseFile;
  const clock = options.clock ?? (() => new Date());
  const evidenceRoot = join(dirname(file), "evidence");
  const tails: NonNullable<Parameters<typeof snapshotLiveRuns>[3]> = new Map();
  let reader: Store | null = null;
  const read = (): Store | null => {
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
        };
      });
      const waiting = rows.filter(one => one.needsYou);
      const needsYou = waiting.length === 0 ? null : `${waiting.length === 1 ? "1 task needs" : `${waiting.length} tasks need`} you: ${waiting[0]!.title}`;
      const registry = await loadProjectRegistry(join(dirname(file), "repos.json"));
      const store = read();
      const mode = store === null ? null : localModeOf(store);
      const passwordSet = store !== null && mode !== null && store.accountOf(mode.owner)?.passwordSet === true;
      return { rows, needsYou, projects: "error" in registry ? [] : registry.repos, passwordSet };
    },

    async task(id: string): Promise<TuiTask | null> {
      const answer = await command(["task", "show", id]);
      if (answer.ok !== true) return null;
      const task = record(answer["task"]), work = record(answer["work"]), status = record(work["status"]);
      const store = read();
      const scope = store === null ? null : store.getScope(id);
      const plan = scope === null || scope.approvedDigest === scope.digest ? null : { digest: scope.digest, lines: describeScope(scope).map(line => terminalText(line)) };
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
        case "new": argv = ["task", "add", act.text, ...(act.repo === null ? [] : ["--repo", act.repo])]; done = "Filed. Its plan will be ready for you to approve."; break;
        case "build": argv = ["task", "new", "--build", act.preview, "--digest", act.digest]; done = "Building. A builder starts it next."; break;
        case "approve": argv = ["task", "approve", act.id, "--yes", "--digest", act.digest]; done = "Approved. An agent starts on it."; break;
        case "stop": argv = ["task", "stop", act.id, "--run", String(act.runId)]; done = "Stopping. Its work so far is kept."; break;
        case "revise": argv = ["task", "revise", act.id, "--feedback", act.text]; done = "Sent back with your note."; break;
        case "answer": argv = ["decide", String(act.decision), "--choose", act.option]; done = "Answered."; break;
        // Retry is today's requeue (the console's Retry), the same command and the same refusals.
        case "retry": argv = ["task", "retry", act.id]; done = "Queued again. A builder starts it next."; break;
        case "complete": {
          const store = read();
          let digest: string | undefined;
          try { digest = store === null ? undefined : assignmentOf(store, act.id, clock(), { principal: "operator", repos: null })?.receipt?.digest; } catch { digest = undefined; }
          if (digest === undefined) return { ok: false, message: "This task has no finished result to accept.", needsPassword: false };
          argv = ["task", "complete", act.id, "--digest", digest]; done = "Accepted."; break;
        }
      }
      const answer = await command(argv);
      if (answer.ok !== true) return refusalOf(answer);
      const filed = act.kind === "new" ? words(record(answer["task"])["id"], words(answer["id"])) : act.kind === "build" ? words(answer["task"]) : "";
      return { ok: true, message: done, ...(filed === "" ? {} : { id: filed }) };
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
      const here = await welcomeHere(store, file, clock(), options.check === undefined ? {} : { check: options.check });
      const value = here.model.left === 0 ? null : { left: here.model.left, lines: welcomeLines(here.model).map(line => terminalText(line)) };
      setupCache = { at: Date.now(), value };
      return value;
    },

    close(): void {
      reader?.close();
      reader = null;
    },
  };
}
