/**
 * The welcome's facts read from this computer, for the screens that are not the console: `toolroll welcome` and the
 * terminal UI's Setup screen. The console's /welcome reads the same facts from its runtime (server/welcome.ts); both
 * go through first-run.ts's one model (welcomeModel), so the three steps say the same thing everywhere.
 *
 * Reads only: the project registry beside the database, the store, and each agent CLI's own sign-in check (no model,
 * nothing spent).
 */
import { basename, dirname, join } from "node:path";
import { resolvePhaseAgent } from "./agentconfig.js";
import { builderReadyFor, firstRunBuilderRepo, modelsEverChosen } from "./dispatch.js";
import { localModeOn } from "./local-owner.js";
import { SAMPLE_FIRST_TASKS, SAMPLE_PROJECT_NAME, GENERIC_FIRST_TASKS, welcomeModel, type WelcomeAgentId, type WelcomeModel } from "./first-run.js";
import type { ConnectionChecker, ProviderConnection } from "./provider-connection.js";
import { detectAgents, type AgentDetection, type DetectedState } from "./agent-detect.js";
import { loadProjectRegistry } from "./repos.js";
import type { Store } from "./store.js";

const AGENT_OF: Readonly<Record<string, WelcomeAgentId>> = { "claude-subscription": "claude", "codex-subscription": "codex" };

export type WelcomeHere = { model: WelcomeModel; projects: readonly string[]; detection: AgentDetection };

/** A detected sign-in as the welcome's two agents read it (provider-connection.ts states). */
const CONNECTION_OF: Readonly<Record<DetectedState, ProviderConnection["state"]>> = { "signed-in": "connected", "signed-out": "signed-out", unknown: "unverified", "not-installed": "not-installed" };

/** The welcome model for this computer now: every agent looked for at once (agent-detect.ts). `check`: Claude Code's and
 * Codex's sign-in check (tests pass their own). */
export async function welcomeHere(store: Store, databaseFile: string, now: Date, options: { check?: ConnectionChecker; platform?: NodeJS.Platform } = {}): Promise<WelcomeHere> {
  const registry = await loadProjectRegistry(join(dirname(databaseFile), "repos.json"));
  const repos = "error" in registry ? [] : registry.repos;
  const root = "error" in registry ? null : registry.roots[0] ?? null;
  const repo = firstRunBuilderRepo(store, null, () => true, repos);
  const sample = root === null ? null : `${root.replace(/\/+$/, "")}/${SAMPLE_PROJECT_NAME}`;
  const build = resolvePhaseAgent(store, "build", repo, {});
  const routed = firstTaskRouted(store, repo);
  const detection = await detectAgents({ ...(options.check === undefined ? {} : { check: options.check }), routed, clock: () => now, acpChecked: acpCheckedHere(store) });
  const stateOf = (id: WelcomeAgentId) => CONNECTION_OF[detection.agents.find(one => one.id === id)?.state ?? "unknown"];
  const model = welcomeModel({
    agents: { claude: stateOf("claude"), codex: stateOf("codex") },
    others: detection.agents, routed,
    inUse: AGENT_OF[store.getChatConfig()?.provider ?? ""] ?? null,
    buildsOn: build.ok ? build.spec.provider : null,
    // Choosing the agent is the console's act ("Use this one"); these screens show the step and its sign-in command.
    canChoose: false,
    projects: repos.map(path => ({ name: basename(path), path })),
    projectRoot: root,
    ready: builderReadyFor(store, repo, now),
    hasTask: store.hasAnyWork(),
    starters: repo !== null && repo === sample ? SAMPLE_FIRST_TASKS : GENERIC_FIRST_TASKS,
    platform: options.platform ?? process.platform,
  });
  return { model, projects: repos, detection };
}

/**
 * Where a first task's build goes, for agent-detect.ts: the provider chosen in Settings → Models (or the project's), when
 * one is; null when nothing is chosen and a laptop install's first start will choose the agent detection picks
 * (local mode on, models never chosen here: model-choices.ts fillDefaultRouting's first-start door); otherwise the
 * built-in default, Claude Code, which is where the task really goes.
 */
export function firstTaskRouted(store: Store, repo: string | null = null): string | null {
  const build = resolvePhaseAgent(store, "build", repo, {});
  if (build.ok && build.source !== "default") return build.spec.provider;
  return localModeOn(store) && !modelsEverChosen(store) ? null : "claude";
}

/** Whether an ACP agent passed its one-time check on a runner of this installation (store.acpAttestationFor). */
export function acpCheckedHere(store: Store): (provider: import("./acp-agents.js").AcpProviderId) => boolean {
  const runners = store.listRunners().filter(one => one.retiredAt === null).map(one => one.name);
  return provider => runners.some(name => store.acpAttestationFor(provider, name) !== null);
}

export type WelcomeStepKey = "agent" | "project" | "task";
export const WELCOME_STEPS: readonly WelcomeStepKey[] = ["agent", "project", "task"];

/** How a terminal offers the sample project when no project is added yet: the terminal UI's own key, the command that
 * adds it, or not at all (an install with passwords, whose sample is the browser's). */
export type SampleOffer = "key" | "command" | null;

/** One step as lines for a terminal: its number and name, Done or what to do next, in plain words. */
export function welcomeStepLines(model: WelcomeModel, key: WelcomeStepKey, sample: SampleOffer = null): string[] {
  const mark = (done: boolean) => (done ? "Done" : "To do");
  const lines: string[] = [];
  if (key === "agent") {
    lines.push(`1. Agent · ${mark(model.agent.done)}`);
    // Who the first task goes to; else one "Sign in to <Agent>: run …" per installed agent; else how to install one
    // (agent-detect.ts firstRunAgentLines, the same lines every screen shows).
    for (const line of model.agent.lines) lines.push(`   ${line}`);
  } else if (key === "project") {
    lines.push(`2. Project · ${mark(model.project.done)}`);
    for (const one of model.project.projects.slice(0, 3)) lines.push(`   ${one.name}  ${one.path}`);
    const offer = model.project.projects.length === 0 && model.project.sample !== null ? sample : null;
    const addOwn = "a git repository: run `toolroll repos add <folder>`, or `toolroll --web` and choose one.";
    if (offer === "key") lines.push("   s  Try the sample project", `   Or add ${addOwn}`);
    else if (model.project.projects.length === 0) lines.push(`   Add ${addOwn}`, ...offer === "command" ? ["   Or try the sample project: run `toolroll welcome sample`."] : []);
    else if (model.project.notTakingWork) lines.push("   Tasks can't start yet: nothing on this computer is taking work. Run `toolroll`.");
  } else {
    // Filed with no agent signed in: it waits for step 1, so it reads Filed (never Done) and never "waits for your approval".
    const waitsForAgent = model.task.done && !model.agent.done && !model.agent.checking;
    lines.push(`3. First task · ${waitsForAgent ? "Filed" : mark(model.task.done)}`);
    if (model.task.done) lines.push(waitsForAgent ? "   It starts by itself once an agent is signed in (step 1)." : "   Filed. Its plan waits for your approval.");
    else if (!model.task.open) lines.push("   Add a project first.");
    else for (const one of model.task.starters) lines.push(`   Idea: ${one.draft}`);
  }
  return lines;
}

/** The welcome as lines for a terminal: how many steps are left, then each step. */
export function welcomeLines(model: WelcomeModel, sample: SampleOffer = null): string[] {
  return [model.left === 0 ? "Setup is done." : `${model.left} ${model.left === 1 ? "step" : "steps"} left.`, "", ...WELCOME_STEPS.flatMap(key => welcomeStepLines(model, key, sample))];
}

/** Whether a terminal may offer the sample project here: no project yet, a projects folder to make it in, and this
 * computer's password-free owner to add it (local mode on, not the demo). What a screen offers only; the command decides. */
export function sampleOffered(model: WelcomeModel, localOn: boolean, demo: boolean): boolean {
  return localOn && !demo && model.project.projects.length === 0 && model.project.sample !== null;
}
