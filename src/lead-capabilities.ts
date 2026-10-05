/**
 * What the lead can rely on right now, in one read (get_capabilities): the agents a project's route would run, the
 * workers that would run them, the project's tools and skills, the integrations, and the project's checks. Every entry
 * says what it lets the lead do and, when it can't, the one next step and the settings control (show_control) that
 * takes the owner there. Everything here reads what is already recorded — runner readiness reports, sign-in pauses,
 * plan-limit readings, tool tests, skill tests, integration checks — and never probes anything that spends.
 */
import { projectBatchChecks } from "./batch-policy.js";
import type { Store } from "./store.js";
import type { ChatControl } from "./chat-controls.js";
import { resolveRouteCandidates } from "./agentconfig.js";
import { authPauseOf, messageCommand, providerName } from "./provider-auth.js";
import type { ProviderId } from "./provider.js";
import { readAuthMode, SUBSCRIPTION_CAPABLE, type AuthMode } from "./keys.js";
import { DEFAULT_LIVENESS_MS } from "./runner.js";
import { projectToolsOf, secretsSetFor, toolStanding } from "./project-tools.js";
import { conversationSkills } from "./project-skills.js";
import { CHECK_LEVEL_WORDS, liveQuickCommand, projectCheckLevel } from "./check-levels.js";
import { STATE_WORDS, type Integration } from "./integrations.js";

/** One thing the lead may depend on: its state in a few words, what it lets the lead do, and when it can't, the next step. */
export type Capability = { name: string; state: string; ok: boolean; lets: string; next: string | null; link: ChatControl | null };

export type ProjectCapabilities = {
  repo: string;
  agents: (Capability & { provider: string; model: string; roles: string[] })[];
  agentsProblem: Capability | null;
  tools: Capability[];
  skills: Capability[];
  checks: Capability & { level: string; quickCheck: boolean; releaseCheck: boolean };
};

export type Capabilities = {
  projects: ProjectCapabilities[];
  workers: (Capability & { online: boolean; capacity: number; running: string[] })[];
  integrations: (Capability & { kind: string; account: string | null; usedBy: string[]; lastError: string | null })[];
};

const ROLE_WORDS = { plan: "plan", build: "build", repair: "fix failed checks", review: "review" } as const;
const MAX_LISTED = 12;

/** The exact provider and model pairs a project's route would use, with the roles each would play. */
function routePairs(store: Store, repo: string): { pairs: Map<string, { provider: ProviderId; model: string; roles: string[] }>; problem: string | null } {
  const pairs = new Map<string, { provider: ProviderId; model: string; roles: string[] }>();
  const resolved = resolveRouteCandidates(store, repo);
  if (!resolved.ok) return { pairs, problem: resolved.problem };
  const add = (phase: keyof typeof ROLE_WORDS, candidate: { provider: ProviderId; model: string } | null) => {
    if (candidate === null) return;
    const key = `${candidate.provider} ${candidate.model}`;
    const pair = pairs.get(key) ?? { provider: candidate.provider, model: candidate.model, roles: [] };
    if (!pair.roles.includes(ROLE_WORDS[phase])) pair.roles.push(ROLE_WORDS[phase]);
    pairs.set(key, pair);
  };
  for (const phase of ["plan", "build", "repair", "review"] as const) {
    const leg = resolved.candidates[phase];
    add(phase, leg.routine ?? (phase === "repair" ? resolved.candidates.build.routine : null));
    add(phase, leg.strong);
  }
  return { pairs, problem: null };
}

/** A provider's plan or quota running out, from the last readings (provider_limit and the runners' quota rows). */
function outOfBudget(store: Store, provider: string, now: Date): { until: string | null } | null {
  const stamp = now.toISOString();
  const window = store.providerLimits().find(one => one.provider === provider && one.reached && (one.resetsAt === null || one.resetsAt > stamp));
  if (window !== undefined) return { until: window.resetsAt };
  const quota = store.handle.prepare("SELECT reset_at FROM quota WHERE provider = ? AND state = 'exhausted' AND (reset_at IS NULL OR reset_at > ?) ORDER BY reset_at DESC LIMIT 1").get(provider, stamp);
  return quota === undefined ? null : { until: quota["reset_at"] == null ? null : String(quota["reset_at"]) };
}

function agentsOf(store: Store, repo: string, now: Date, authMode: (provider: ProviderId) => AuthMode): Pick<ProjectCapabilities, "agents" | "agentsProblem"> {
  const { pairs, problem } = routePairs(store, repo);
  if (problem !== null) {
    return { agents: [], agentsProblem: { name: "Agents", state: "Not set up", ok: false, lets: "plan and build this project's tasks", next: `Choose an exact model for each role: ${problem}`, link: "providers" } };
  }
  const readiness = store.readinessLookupFor(repo, null, now);
  const agents = [...pairs.values()].map(pair => {
    const name = `${providerName(pair.provider)} · ${pair.model}`;
    const lets = `${pair.roles.join(", ")} this project's tasks`;
    const base = { provider: pair.provider, model: pair.model, roles: pair.roles, name, lets };
    // Signed out only on a real sign-in failure: a sign-in pause from a run, the worker's login check saying not logged
    // in, or the key a key-only provider needs missing. A provider on an API key gets the key step, never the sign-in.
    const pause = authPauseOf(store, pair.provider);
    const mode = pause?.authMode ?? (SUBSCRIPTION_CAPABLE[pair.provider] ? authMode(pair.provider) : "api-key");
    const key = mode === "api-key";
    const outWords = key ? "Needs a working API key" : "Signed out";
    const outNext = (detail: string) => key ? `Save a working API key: run \`${messageCommand({ provider: pair.provider, authMode: "api-key" })}\` on this computer${detail}.` : `Sign in: run \`${messageCommand({ provider: pair.provider, authMode: "subscription" })}\` on this computer${detail}.`;
    if (pause !== null) return { ...base, state: outWords, ok: false, next: outNext("; its tasks start again on their own"), link: "providers" as ChatControl };
    const seen = readiness(pair.provider);
    const authFailed = seen?.state === "unavailable" && (seen.probe === "key" || (seen.probe === "identity" && !key));
    if (authFailed) return { ...base, state: outWords, ok: false, next: outNext(""), link: "providers" as ChatControl };
    if (seen?.state === "unavailable" && seen.probe !== "identity") {
      return { ...base, state: `Not available: ${seen.reason}`, ok: false, next: `Fix it on the worker: ${seen.reason}.`, link: "providers" as ChatControl };
    }
    const spent = outOfBudget(store, pair.provider, now);
    if (spent !== null) return { ...base, state: "Out of plan budget", ok: false, next: spent.until === null ? "Wait for the plan to reset, or choose another agent." : `Wait until ${spent.until}, when the plan resets, or choose another agent.`, link: "providers" as ChatControl };
    if (seen === null) return { ...base, state: "Not checked yet", ok: false, next: "No worker has reported this agent yet: start a worker for this project.", link: "workers" as ChatControl };
    // On an API key, only a key check speaks for it: a CLI login check (passed or not) says nothing about the key.
    if (seen.state !== "ready" || (key && seen.probe !== "key")) {
      return { ...base, state: "Not checked yet", ok: false, next: key ? "Its API key has not been checked without spending; the first task shows whether it works." : "A worker could not check it without spending; the first task shows whether it works.", link: "providers" as ChatControl };
    }
    return { ...base, state: key ? "API key set" : "Signed in", ok: true, next: null, link: null };
  });
  return { agents, agentsProblem: null };
}

function toolsOf(store: Store, repo: string): Capability[] {
  return projectToolsOf(store, repo).slice(0, MAX_LISTED).map(tool => {
    let set: string[] = [];
    try { set = secretsSetFor(repo, tool.spec); } catch { set = []; }
    const standing = toolStanding(tool, set);
    const state = standing.words;
    const lets = `builds in this project can use ${tool.name}${tool.spec.about ? ` (${tool.spec.about})` : ""}`;
    if (state.startsWith("Needs")) return { name: tool.name, state, ok: false, lets, next: `Add ${state.slice("Needs ".length)} on the Tools page; never in chat.`, link: "tools" };
    if (state === "Last test failed") return { name: tool.name, state, ok: false, lets, next: `Fix it and test it again on the Tools page${tool.lastTest?.problem ? `: ${tool.lastTest.problem}` : ""}.`, link: "tools" };
    if (state === "Not tested yet") return { name: tool.name, state, ok: true, lets, next: "Test it on the Tools page to be sure it works.", link: "tools" };
    return { name: tool.name, state: "Working", ok: true, lets, next: null, link: null };
  });
}

/** The newest test of one skill version in a project: passed, failed or still running; null when never tested. */
function lastSkillTest(store: Store, repo: string, sha: string): "passed" | "failed" | "running" | null {
  const row = store.handle.prepare("SELECT skill_test.task_ref AS ref FROM skill_test JOIN task_ref ON task_ref.id = skill_test.task_ref WHERE task_ref.repo = ? AND skill_test.package = ? ORDER BY skill_test.task_ref DESC LIMIT 1").get(repo, sha);
  if (row === undefined) return null;
  const run = store.runsFor(Number(row["ref"]))[0];
  if (run === undefined || run.outcome === null) return "running";
  return run.outcome === "built" || run.outcome === "no-change" ? "passed" : "failed";
}

function skillsOf(store: Store, repo: string, actor: string): Capability[] {
  let skills: ReturnType<typeof conversationSkills>["skills"];
  try { skills = conversationSkills(store, repo, actor).skills; } catch { return []; }
  return skills.filter(one => one.enabled).slice(0, MAX_LISTED).map(skill => {
    const lets = `builds in this project are given the ${skill.name} skill${skill.description ? ` (${skill.description.slice(0, 120)})` : ""}`;
    const test = lastSkillTest(store, repo, skill.sha);
    if (test === "failed") return { name: skill.name, state: "Last test failed", ok: false, lets, next: "Read it with get_skills, then fix and test it again on the Skills page.", link: "skills" };
    const needs = skill.requirements.trim();
    if (needs !== "" && test !== "passed") return { name: skill.name, state: `Needs ${needs.slice(0, 120)}`, ok: false, lets, next: "Make sure what it needs is set up, then test it on the Skills page.", link: "skills" };
    return { name: skill.name, state: test === "running" ? "Working · test running" : "Working", ok: true, lets, next: null, link: null };
  });
}

function checksOf(store: Store, repo: string): ProjectCapabilities["checks"] {
  const level = projectCheckLevel(store, repo).level;
  const releaseCheck = store.liveVerifyCommand(repo) !== null, quickCheck = liveQuickCommand(store, repo) !== null;
  const base = { name: "Checks", level: CHECK_LEVEL_WORDS[level], quickCheck, releaseCheck, lets: "say whether a result's checks passed before you call it done" };
  if (level === "off") return { ...base, state: "Off", ok: false, next: "Builds are not checked. Turn checks on for the project if results need them.", link: "projects" };
  if (!releaseCheck) return { ...base, state: `${CHECK_LEVEL_WORDS[level]} · no release check`, ok: false, next: "No release check is set up, so no result can show a passing check. Set one for the project.", link: "projects" };
  // Batch checks are changed in Settings → Projects → Checks (or `project checks --batch on|off`), never from chat.
  const batched = level === "full" && projectBatchChecks(store, repo).on ? " · batched with results that finish together" : "";
  return { ...base, state: level === "quick" && !quickCheck ? "Quick · runs the release check" : `${CHECK_LEVEL_WORDS[level]} · release check set${batched}`, ok: true, next: null, link: null };
}

function workersOf(store: Store, repos: readonly string[], now: Date): Capabilities["workers"] {
  const live = store.handle.prepare(`SELECT ref.external_id AS task, ref.repo AS repo FROM claim JOIN task_ref AS ref ON ref.id = claim.task_ref
    WHERE claim.runner = ? AND claim.released_at IS NULL AND claim.expires_at > ?
      AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest WHERE newest.task_ref = claim.task_ref)`);
  const workers = store.listRunners()
    .filter(one => one.retiredAt === null && one.repos.some(repo => repos.includes(repo)))
    .slice(0, MAX_LISTED)
    .map(runner => {
      const online = now.getTime() - Date.parse(runner.heartbeatAt) <= DEFAULT_LIVENESS_MS;
      const held = live.all(runner.name, now.toISOString());
      const running = held.filter(row => repos.includes(String(row["repo"]))).map(row => String(row["task"]));
      const busy = store.liveClaimCount(runner.name, now);
      const lets = `run tasks for ${runner.repos.filter(repo => repos.includes(repo)).length} of your projects, ${runner.capacity} at a time`;
      if (!online) return { name: runner.name, state: `Offline since ${runner.heartbeatAt}`, ok: false, online, capacity: runner.capacity, running, lets,
        next: `Start that computer, or reinstall its background worker there: \`toolroll daemon install --runner ${runner.name}\`.`, link: "workers" as ChatControl };
      const full = busy >= runner.capacity;
      return { name: runner.name, state: full ? `Online · full (${busy} of ${runner.capacity})` : `Online · ${busy} of ${runner.capacity} busy`, ok: true, online, capacity: runner.capacity, running, lets,
        next: full ? "New work waits for a free slot; raise its capacity on the Workers page if it should run more at once." : null, link: full ? "workers" as ChatControl : null };
    });
  if (workers.length === 0) {
    return [{ name: "No worker", state: "None for your projects", ok: false, online: false, capacity: 0, running: [], lets: "run any task",
      next: "Add a worker for the project: run `toolroll daemon install` on the computer that should do the work.", link: "workers" }];
  }
  return workers;
}

const INTEGRATION_LINK: Record<string, ChatControl> = { slack: "slack", discord: "discord" };

/** The integrations exactly as get_integrations reads them, with what each lets the lead do and the next step. */
export function integrationCapabilities(list: readonly Integration[]): Capabilities["integrations"] {
  return list.map(one => {
    const link: ChatControl = one.group === "agents" ? "providers" : one.group === "tools" ? "tools" : INTEGRATION_LINK[one.key.replace(/^.*:/, "").toLowerCase()] ?? INTEGRATION_LINK[one.name.toLowerCase()] ?? "integrations";
    const lets = one.usedBy.length > 0 ? `use ${one.name} for ${one.usedBy.join(", ")}` : `use ${one.name}`;
    const next = one.action.kind === "setup" ? `Not set up: set up ${one.name} in Settings` : one.action.kind === "fix" ? `Fix: ${one.action.words}` : null;
    return { name: one.name, kind: one.group, state: STATE_WORDS[one.state], ok: one.state === "connected", account: one.account, usedBy: one.usedBy, lastError: one.lastError, lets, next, link: next === null ? null : link };
  });
}

/** Every capability, for one project or every admitted one. Read-only and spends nothing. */
export function capabilitiesOf(store: Store, input: { repos: readonly string[]; admitted: readonly string[]; actor: string; integrations: readonly Integration[]; authMode?: (provider: ProviderId) => AuthMode; now: Date }): Capabilities {
  const authMode = input.authMode ?? (provider => readAuthMode(provider));
  return {
    projects: input.repos.map(repo => ({ repo, ...agentsOf(store, repo, input.now, authMode), tools: toolsOf(store, repo), skills: skillsOf(store, repo, input.actor), checks: checksOf(store, repo) })),
    workers: workersOf(store, input.admitted, input.now),
    integrations: integrationCapabilities(input.integrations),
  };
}

/** Whether a call depends on an agent, a worker or an integration, and so needs get_capabilities read first this turn:
 * a task always does (a worker runs it with an agent); a flow change that sets up or starts work does; a promise to
 * report on a task, attempt or check does (crew work must run), and a timed one does when it is reported on a chat app. */
const FLOW_WORK = new Set(["create", "edit", "kit", "starter", "add_trigger", "resume_trigger", "add_card"]);
export function needsCapabilities(name: string, args: Record<string, unknown>, channel: string | undefined): boolean {
  if (name === "propose_task") return true;
  if (name === "propose_flow") return FLOW_WORK.has(String(args["operation"]));
  if (name === "commit_to") return args["when"] === "time" ? channel !== undefined && channel !== "chat" : true;
  return false;
}

export const CAPABILITIES_UNREAD = "This depends on an agent, a worker or an integration. Read get_capabilities first, then propose or promise in a later step; if something it needs can't work, say so plainly with its next step and show_control link instead.";

