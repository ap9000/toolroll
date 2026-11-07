/**
 * The first run: four plain steps to a first result, and three first tasks
 * to try. Everything here is derived from live facts on each render; the
 * list retires permanently with the first Ready result (the
 * 'first-success-at' installation fact). A suggestion only drafts words in
 * the composer: nothing is filed until the person sends it and confirms.
 */
import { run } from "./exec.js";
import { hardenedGit } from "./teardown-git.js";
import type { Runner } from "./backend.js";
import { githubIssues } from "./issues.js";
import { START_BUILDER_HREF } from "./needs-you.js";

export const SIGN_IN_COMMAND = "claude auth login";
export const SANDBOX_COMMAND = "npx toolroll demo";
/** How a person starts on a real project (the demo hands off to this). */
export const START_COMMAND = "npx toolroll up";
/** How it works, once, above the composer until the first request. */
export const HOW_IT_WORKS = "Ask for a change. The lead writes a short plan; you approve it; an agent builds it on its own branch; it's Ready when your tests pass.";

type SignInState = "connected" | "signed-out" | "not-installed" | "unverified" | "key-present" | "key-works" | "key-refused" | "missing-key";

/**
 * The one command that gets an agent signed in on this computer: sign in to the CLI that's installed (Claude Code
 * first, then Codex), or install Claude Code and sign in, written for this operating system's shell. Unknown states
 * (not checked yet) get the install-and-sign-in command, which is right on a fresh machine and harmless otherwise.
 */
export function signInCommandFor(states: { claude: SignInState; codex: SignInState } | null, platform: NodeJS.Platform): string {
  const installed = (state: SignInState | undefined) => state !== undefined && state !== "not-installed";
  if (installed(states?.claude)) return SIGN_IN_COMMAND;
  if (installed(states?.codex)) return "codex login";
  return `npm install -g @anthropic-ai/claude-code${platform === "win32" ? ";" : " &&"} ${SIGN_IN_COMMAND}`;
}

export type FirstRunAction = { kind: "link"; label: string; href: string } | { kind: "command"; command: string };
/** `checking`: the answer is not in yet, so the step is shown neither done nor to do. */
export type FirstRunStep = { key: "agent" | "project" | "builder" | "task"; title: string; done: boolean; action: FirstRunAction | null; checking?: true };
/** agentSignedIn is null until this machine's first sign-in check has answered. */
export type FirstRunFacts = { agentSignedIn: boolean | null; projects: number; hasTask: boolean; firstResultAt: string | null; signInCommand?: string };

/** The steps (the builder step is added by withBuilderStep), each done or with the one action that does it; null once the first result has arrived. */
export function firstRunSteps(facts: FirstRunFacts): FirstRunStep[] | null {
  if (facts.firstResultAt !== null) return null;
  const project = facts.projects > 0;
  return [
    facts.agentSignedIn === null ? { key: "agent", title: "Agent signed in", done: false, action: null, checking: true }
      : { key: "agent", title: "Agent signed in", done: facts.agentSignedIn, action: facts.agentSignedIn ? null : { kind: "command", command: facts.signInCommand ?? SIGN_IN_COMMAND } },
    { key: "project", title: "Project added", done: project, action: project ? null : { kind: "link", label: "Add a project", href: "/projects" } },
    { key: "task", title: "Your first task", done: facts.hasTask, action: facts.hasTask ? null : { kind: "link", label: "New task", href: "/tasks/new" } },
  ];
}

/** The builder step, before the first task: under `toolroll serve` nothing connects a builder, and a task filed then
 * waits forever, so the steps never all read done without one. It leads to Start a builder, which shows the command. */
export function withBuilderStep(steps: FirstRunStep[] | null, connected: boolean): FirstRunStep[] | null {
  if (steps === null) return null;
  const builder: FirstRunStep = { key: "builder", title: "Builder connected", done: connected,
    action: connected ? null : { kind: "link", label: "Start a builder", href: START_BUILDER_HREF } };
  const task = steps.findIndex(one => one.key === "task");
  return task < 0 ? [...steps, builder] : [...steps.slice(0, task), builder, ...steps.slice(task)];
}

export type OpenIssue = { number: number; title: string };
export type TodoComment = { file: string; line: number; text: string };
export type FirstTaskSuggestion = { source: "issue" | "todo" | "generic"; label: string; draft: string };

export const GENERIC_FIRST_TASKS: readonly FirstTaskSuggestion[] = [
  { source: "generic", label: "Add a test for an untested function", draft: "Find one function without a test and add a focused test for it." },
  { source: "generic", label: "Fix a lint warning", draft: "Fix one lint warning without changing behaviour." },
  { source: "generic", label: "Improve the README's setup section", draft: "Improve the setup section of the README so a newcomer can install and run the project." },
];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Issue titles and TODO text are written by anyone: keep only what a person can see, so the draft they send is the
 * draft the lead reads (no control, format, zero-width, bidi, tag or variation-selector characters). */
export const visibleText = (text: string) =>
  text.replace(/[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim();

/** Three first tasks: open GitHub issues first, then TODO or FIXME comments, then safe generic ones. */
export function firstTaskSuggestions(found: { issues: readonly OpenIssue[]; todos: readonly TodoComment[] }): FirstTaskSuggestion[] {
  const fromIssues = found.issues.map(({ number, title: raw }): FirstTaskSuggestion => {
    const title = visibleText(raw);
    return { source: "issue", label: clip(`#${number} ${title}`, 80), draft: `Fix GitHub issue #${number}: ${title}` };
  });
  const fromTodos = found.todos.map(({ file: rawFile, line, text: rawText }) => ({ file: visibleText(rawFile), line, text: visibleText(rawText) })).map((todo): FirstTaskSuggestion => ({
    source: "todo", label: clip(todo.text === "" ? `The note in ${todo.file}` : todo.text.charAt(0).toUpperCase() + todo.text.slice(1), 80),
    draft: `Resolve the note in ${todo.file} line ${todo.line}${todo.text === "" ? "" : `: ${todo.text}`}`,
  }));
  return [...fromIssues, ...fromTodos, ...GENERIC_FIRST_TASKS].slice(0, 3);
}

const SKIPPED = /(^|\/)(node_modules|dist|build|vendor|third_party|\.git)\//;

/** `git grep -z -n` records ("file\0line\0text\n") to TODO or FIXME notes, one per file. NUL-separated so a
 * file name with a colon or a newline in it is still one file name. */
export function parseTodoLines(stdout: string, limit = 3): TodoComment[] {
  const found: TodoComment[] = [];
  const seen = new Set<string>();
  for (const match of stdout.matchAll(/([^\0]*)\0(\d+)\0([^\n]*)(?:\n|$)/g)) {
    const file = match[1]!;
    if (file === "" || SKIPPED.test(file) || seen.has(file)) continue;
    const note = /\b(?:TODO|FIXME)\b(?:\([^)]*\))?[:\s-]*(.*)$/.exec(match[3]!);
    if (note === null) continue;
    seen.add(file);
    found.push({ file, line: Number(match[2]), text: clip(note[1]!.replace(/\s*(\*\/|-->)\s*$/, "").trim(), 120) });
    if (found.length === limit) break;
  }
  return found;
}

/** The TODO search: no colour and no column whatever the person's git config says, NUL after each file name. */
export const TODO_GREP_ARGS: readonly string[] = ["-c", "grep.column=false", "grep", "--no-color", "-z", "-n", "-I", "-w", "--max-count=1", "-E", "TODO|FIXME"];

/** Read the project's own sources for suggestions: its open issues through the `gh` login, then its TODO comments. Failures fall through quietly. */
export async function findFirstTasks(repo: string, runner: Runner = run): Promise<FirstTaskSuggestion[]> {
  let issues: OpenIssue[] = [];
  try {
    const listed = await githubIssues({ repo, runner, limit: 3, timeoutMs: 5_000 }).listReady();
    if (listed.ok) issues = listed.value.slice(0, 3).map(one => ({ number: Number(one.id), title: one.title })).filter(one => Number.isSafeInteger(one.number));
  } catch { issues = []; }
  let todos: TodoComment[] = [];
  if (issues.length < 3) {
    try {
      // The project's repository is shared with builds that can write its config: the hardened read (teardown-git.ts).
      const result = await (runner === run ? hardenedGit(run, "read") : runner)("git", [...TODO_GREP_ARGS], { cwd: repo, timeoutMs: 5_000 });
      if (result.code === 0 || result.stdout !== "") todos = parseTodoLines(result.stdout);
    } catch { todos = []; }
  }
  return firstTaskSuggestions({ issues, todos });
}

/** "First result in 7 min": how long after the installation began its first Ready result arrived. */
export function firstResultWords(since: string, at: string): string | null {
  const minutes = Math.round((Date.parse(at) - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "First result in under a minute";
  if (minutes < 60) return `First result in ${minutes} min`;
  if (minutes < 48 * 60) { const hours = Math.floor(minutes / 60), rest = minutes % 60; return `First result in ${hours} h${rest === 0 ? "" : ` ${rest} min`}`; }
  return `First result in ${Math.round(minutes / (24 * 60))} days`;
}

/** The first task's five steps, as a person reads them. */
export const JOURNEY_STEPS = [["plan", "Plan"], ["approve", "You approve"], ["build", "Build"], ["checks", "Checks"], ["ready", "Ready"]] as const;
export type JourneyKey = (typeof JOURNEY_STEPS)[number][0];
/** `stuck`: the step it stopped at (Failed, Stopped, or waiting on something other than the approval). */
/** `skipped`: a stage the task went past without it happening (its checks didn't run or couldn't be read). `needsYou`:
 * the current or stuck step waits on a person, so it is the one step drawn amber. */
export type JourneyStep = { key: JourneyKey; label: string; state: "done" | "current" | "stuck" | "skipped" | "todo"; needsYou?: true };

/**
 * Where the first task stands on Plan → You approve → Build → Checks → Ready, from the one stage every surface reads
 * (task-status.ts). Waiting for a worker before approval is still the plan; after approval it is the build. `built`:
 * the build finished with a result.
 */
export function firstTaskJourney(read: { stage: "queued" | "planning" | "needs-you" | "waiting" | "building" | "checking" | "reviewing" | "finished" | "complete" | "failed" | "stopped"; need?: string | undefined }, approved: boolean, built = false): JourneyStep[] {
  const at: { index: number; stuck: boolean } =
    read.stage === "finished" || read.stage === "complete" ? { index: 5, stuck: false }
    : read.stage === "checking" || read.stage === "reviewing" ? { index: 3, stuck: false }
    : read.stage === "building" ? { index: 2, stuck: false }
    // Waiting on nothing a person does: the build finished and is settling.
    : read.stage === "waiting" ? { index: built ? 3 : approved ? 2 : 0, stuck: false }
    : read.stage === "needs-you" && read.need === "approval" ? { index: 1, stuck: false }
    : read.stage === "planning" ? { index: 0, stuck: false }
    : read.stage === "queued" ? { index: approved ? 2 : 0, stuck: false }
    // A build that finished but isn't Ready (its checks failed or didn't run, or it needs a decision) stopped at Checks.
    : { index: built ? 3 : approved ? 2 : 0, stuck: true };
  return JOURNEY_STEPS.map(([key, label], index) => ({ key, label,
    state: index < at.index ? "done" : index === at.index ? (at.stuck ? "stuck" : "current") : "todo" }));
}

/** The approved check as the task's status reads it (task-status.ts `approvedCheckStateOf`), for its road: `null` when
 * nothing says (the step is then shown skipped, never done). The road reads this one answer, never a row's words. */
export type RoadChecks = "passed" | "running" | "failed" | "not-run" | "off" | "unreadable" | null;
/**
 * Any task's road (the read-only stepper on its page, after ReUI's Stepper): the first task's five steps, told only
 * from recorded facts. You approve is done only when the plan was approved (a rewritten plan waiting on approval
 * stands there again); a task that never needed one shows it skipped. Checks is done only when the approved check
 * passed; a running, missing or Off check says so, and with no checks fact it is skipped. A failed check, or one that
 * can't be read, stops the road at Checks: Ready isn't done (fail closed), even on a task a person marked complete.
 * A research report has no Checks step: a report stopped there stops at
 * Ready. The step that waits on a person carries `needsYou`.
 */
export function taskRoad(read: Parameters<typeof firstTaskJourney>[0], approved: boolean, built: boolean, facts: { report?: boolean; checks?: RoadChecks }): JourneyStep[] {
  const replan = read.stage === "needs-you" && read.need === "replan";
  const plainApproved = approved && !replan;
  let steps: JourneyStep[] = firstTaskJourney(replan ? { stage: "needs-you", need: "approval" } : read, plainApproved, built);
  const complete = read.stage === "complete";
  // A finished build that waits on something other than its check (a hold, a decision) stops after Checks, at Ready,
  // when its check passed, didn't run or is Off: the road never calls a passing check stuck.
  let waitsAtReady = false;
  steps = steps.map(step => {
    if (step.key === "approve" && step.state === "done" && !plainApproved) return { ...step, state: "skipped" };
    if (step.key === "checks" && step.state === "stuck" && built) {
      switch (facts.checks ?? null) {
        case "passed": waitsAtReady = true; return { ...step, state: "done" };
        case "not-run": waitsAtReady = true; return { ...step, state: "skipped", label: "Checks not run" };
        case "off": waitsAtReady = true; return { ...step, state: "skipped", label: "Checks at release" };
        case "running": return { ...step, state: "current", label: "Checks running" };
        case "failed": return { ...step, label: "Checks failed" };
        case "unreadable": return { ...step, label: "Checks unreadable" };
        default: return step;
      }
    }
    if (step.key !== "checks" || (step.state !== "done" && step.state !== "current")) return step;
    // At Checks now: only a recorded failure, an unreadable check or a running check changes how it reads.
    if (step.state === "current") return facts.checks === "failed" ? { ...step, state: "stuck", label: "Checks failed" }
      : facts.checks === "unreadable" ? { ...step, state: "stuck", label: "Checks unreadable" }
      : facts.checks === "running" ? { ...step, label: "Checks running" } : step;
    switch (facts.checks ?? null) {
      case "passed": return step;
      case "running": return { ...step, state: "current", label: "Checks running" };
      case "failed": return { ...step, state: "stuck", label: "Checks failed" };
      case "not-run": return { ...step, state: "skipped", label: "Checks not run" };
      case "off": return { ...step, state: "skipped", label: "Checks at release" };
      case "unreadable": return { ...step, state: "stuck", label: "Checks unreadable", ...(complete ? {} : { needsYou: true as const }) };
      default: return { ...step, state: "skipped" };
    }
  });
  if (waitsAtReady) steps = steps.map(step => step.key === "ready" ? { ...step, state: "stuck" } : step);
  // A road stopped at Checks (failed, or unreadable) has not reached Ready.
  const at = steps.find(step => step.key === "checks");
  if (facts.report !== true && at !== undefined && at.state === "stuck") {
    steps = steps.map(step => step.key === "ready" && step.state === "done" ? { ...step, state: "todo" } : step);
  }
  if (facts.report === true) {
    const checks = steps.find(step => step.key === "checks");
    if (checks !== undefined && (checks.state === "current" || checks.state === "stuck")) {
      steps = steps.map(step => step.key === "ready" ? { ...step, state: checks.state } : step);
    }
    steps = steps.filter(step => step.key !== "checks");
  }
  const waiting = read.stage === "needs-you";
  return steps.map(step => waiting && (step.state === "current" || step.state === "stuck") ? { ...step, needsYou: true } : step);
}

// ---- the welcome (/welcome, a future terminal screen, `toolroll welcome --json`) ---------------------------------

/** The agents setup offers: the two whose sign-in check, readiness and chat are supported end to end. */
export type WelcomeAgentId = "claude" | "codex";
export const WELCOME_AGENTS: readonly { id: WelcomeAgentId; name: string; signIn: string; install: string }[] = [
  { id: "claude", name: "Claude Code", signIn: SIGN_IN_COMMAND, install: "npm install -g @anthropic-ai/claude-code" },
  { id: "codex", name: "Codex", signIn: "codex login", install: "npm install -g @openai/codex" },
];
/** The sample project's folder name under the project folder. */
export const SAMPLE_PROJECT_NAME = "toolroll-sample";

export type WelcomeAgentState = "signed-in" | "signed-out" | "not-installed" | "checking";
export type WelcomeAgent = {
  id: WelcomeAgentId; name: string; state: WelcomeAgentState;
  /** The exact command that signs it in on this computer (installing it first when it isn't there); null once signed in or while checking. */
  command: string | null;
  inUse: boolean;
  /** "Use this one" can choose it: signed in with an account, not already in use, and this person may choose. */
  canUse: boolean;
};
export type WelcomeStarter = { label: string; draft: string; href: string };
export type WelcomeModel = {
  agent: { done: boolean; checking: boolean; agents: WelcomeAgent[]; inUse: WelcomeAgentId | null;
    /** Tasks are built with another agent than the one in use (Settings → Models decides): say so, with where to change it. */
    buildsWith: string | null };
  project: { done: boolean; projects: { name: string; path: string }[];
    /** Where "Try a sample project" puts it; null when there is no project folder or it is already added. */
    sample: string | null;
    /** A project is added but nothing on this computer takes its tasks yet. */
    notTakingWork: boolean };
  task: { done: boolean; open: boolean; starters: WelcomeStarter[] };
  /** The step the screen's one primary belongs to, or null when nothing is left that a page can do. */
  next: "agent" | "project" | "task" | null;
  left: number;
};
export type WelcomeFacts = {
  /** Each agent's last sign-in check on this computer; null until one has answered. */
  agents: Record<WelcomeAgentId, SignInState | null>;
  inUse: WelcomeAgentId | null;
  /** The provider routine builds run on now (claude by default). */
  buildsOn: string | null;
  canChoose: boolean;
  projects: readonly { name: string; path: string }[];
  /** The folder new projects go in; null when this console has none. */
  projectRoot: string | null;
  ready: boolean;
  hasTask: boolean;
  starters: readonly FirstTaskSuggestion[];
  platform: NodeJS.Platform;
};

const SIGNED_IN: ReadonlySet<SignInState> = new Set(["connected", "key-works", "key-present"]);

/** The welcome's three steps (Agent · Project · First task) from live facts, the same for every screen that shows them. */
export function welcomeModel(facts: WelcomeFacts): WelcomeModel {
  const join = facts.platform === "win32" ? ";" : " &&";
  const agents = WELCOME_AGENTS.map((one): WelcomeAgent => {
    const seen = facts.agents[one.id];
    const state: WelcomeAgentState = seen === null ? "checking" : SIGNED_IN.has(seen) ? "signed-in" : seen === "not-installed" ? "not-installed" : "signed-out";
    const command = state === "signed-in" || state === "checking" ? null : state === "not-installed" ? `${one.install}${join} ${one.signIn}` : one.signIn;
    const inUse = facts.inUse === one.id;
    return { id: one.id, name: one.name, state, command, inUse, canUse: facts.canChoose && !inUse && seen === "connected" };
  });
  const signedIn = agents.some(one => one.state === "signed-in");
  const checking = !signedIn && agents.some(one => one.state === "checking");
  const builds = facts.buildsOn === null ? null : WELCOME_AGENTS.find(one => one.id === facts.buildsOn)?.name ?? facts.buildsOn;
  const buildsWith = facts.inUse !== null && facts.buildsOn !== null && facts.buildsOn !== facts.inUse ? builds : null;
  const hasProject = facts.projects.length > 0;
  const samplePath = facts.projectRoot === null ? null : `${facts.projectRoot.replace(/\/+$/, "")}/${SAMPLE_PROJECT_NAME}`;
  const sample = samplePath !== null && !facts.projects.some(one => one.path === samplePath) ? samplePath : null;
  const projectDone = hasProject && facts.ready;
  const taskOpen = hasProject;
  const starters = facts.starters.slice(0, 3).map(one => ({ label: one.label, draft: one.draft, href: `/tasks/new?text=${encodeURIComponent(one.draft)}` }));
  const model: Omit<WelcomeModel, "next" | "left"> = {
    agent: { done: signedIn, checking, agents, inUse: facts.inUse, buildsWith },
    project: { done: projectDone, projects: [...facts.projects], sample, notTakingWork: hasProject && !facts.ready },
    task: { done: facts.hasTask, open: taskOpen, starters: taskOpen ? starters : [] },
  };
  // The next step a page can move: the agent only when there is something to click (Use this one); its sign-in is a
  // command on the computer, so a project or the first task leads meanwhile.
  const agentAct = !signedIn ? false : facts.inUse === null && agents.some(one => one.canUse);
  const next = agentAct ? "agent" : !projectDone ? "project" : !facts.hasTask ? "task" : null;
  const left = [model.agent.done, model.project.done, model.task.done].filter(done => !done).length;
  return { ...model, next, left };
}

/** First tasks for the sample project: the changes its README suggests. */
export const SAMPLE_FIRST_TASKS: readonly FirstTaskSuggestion[] = [
  { source: "generic", label: "Round prices to whole cents", draft: "Round priceWithDiscount's result to whole cents and add a test for it." },
  { source: "generic", label: "Refuse a negative discount", draft: "Make priceWithDiscount refuse a negative discount with a clear error, and test it." },
  { source: "generic", label: "Add a usage example to the README", draft: "Add a short usage example for priceWithDiscount to the README." },
];
