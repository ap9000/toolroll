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
import { builderReadyFor, firstRunBuilderRepo } from "./dispatch.js";
import { SAMPLE_FIRST_TASKS, SAMPLE_PROJECT_NAME, GENERIC_FIRST_TASKS, welcomeModel, type WelcomeAgentId, type WelcomeModel } from "./first-run.js";
import { createConnectionChecker, type ConnectionChecker } from "./provider-connection.js";
import { loadProjectRegistry } from "./repos.js";
import type { Store } from "./store.js";

const AGENT_OF: Readonly<Record<string, WelcomeAgentId>> = { "claude-subscription": "claude", "codex-subscription": "codex" };

export type WelcomeHere = { model: WelcomeModel; projects: readonly string[] };

/** The welcome model for this computer now. `check`: the agent sign-in check (tests pass their own). */
export async function welcomeHere(store: Store, databaseFile: string, now: Date, options: { check?: ConnectionChecker; platform?: NodeJS.Platform } = {}): Promise<WelcomeHere> {
  const registry = await loadProjectRegistry(join(dirname(databaseFile), "repos.json"));
  const repos = "error" in registry ? [] : registry.repos;
  const root = "error" in registry ? null : registry.roots[0] ?? null;
  const check = options.check ?? createConnectionChecker();
  const states = await Promise.all((["claude", "codex"] as const).map(one => check(one).then(value => value.state, () => "unverified" as const)));
  const repo = firstRunBuilderRepo(store, null, () => true, repos);
  const sample = root === null ? null : `${root.replace(/\/+$/, "")}/${SAMPLE_PROJECT_NAME}`;
  const build = resolvePhaseAgent(store, "build", repo, {});
  const model = welcomeModel({
    agents: { claude: states[0] ?? null, codex: states[1] ?? null },
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
  return { model, projects: repos };
}

export type WelcomeStepKey = "agent" | "project" | "task";
export const WELCOME_STEPS: readonly WelcomeStepKey[] = ["agent", "project", "task"];

/** One step as lines for a terminal: its number and name, Done or what to do next, in plain words. */
export function welcomeStepLines(model: WelcomeModel, key: WelcomeStepKey): string[] {
  const mark = (done: boolean) => (done ? "Done" : "To do");
  const lines: string[] = [];
  if (key === "agent") {
    lines.push(`1. Agent · ${mark(model.agent.done)}`);
    for (const agent of model.agent.agents) {
      const state = agent.state === "signed-in" ? "signed in" : agent.state === "checking" ? "checking" : agent.state === "not-installed" ? "not installed" : "not signed in";
      lines.push(`   ${agent.name}: ${state}${agent.inUse ? " (in use)" : ""}`);
      if (agent.command !== null) lines.push(`     To sign in, run: ${agent.command}`);
    }
  } else if (key === "project") {
    lines.push(`2. Project · ${mark(model.project.done)}`);
    for (const one of model.project.projects.slice(0, 3)) lines.push(`   ${one.name}  ${one.path}`);
    if (model.project.projects.length === 0) lines.push("   Add a git repository: run `toolroll repos add <folder>`, or `toolroll open --web` and choose one.");
    else if (model.project.notTakingWork) lines.push("   Tasks can't start yet: nothing on this computer is taking work. Run `toolroll`.");
  } else {
    lines.push(`3. First task · ${mark(model.task.done)}`);
    // Filed with no agent signed in: it waits for step 1, never "waits for your approval".
    if (model.task.done) lines.push(model.agent.done || model.agent.checking ? "   Filed. Its plan waits for your approval." : "   Filed. It starts by itself once an agent is signed in (step 1).");
    else if (!model.task.open) lines.push("   Add a project first.");
    else for (const one of model.task.starters) lines.push(`   Idea: ${one.draft}`);
  }
  return lines;
}

/** The welcome as lines for a terminal: how many steps are left, then each step. */
export function welcomeLines(model: WelcomeModel): string[] {
  return [model.left === 0 ? "Setup is done." : `${model.left} ${model.left === 1 ? "step" : "steps"} left.`, "", ...WELCOME_STEPS.flatMap(key => welcomeStepLines(model, key))];
}
