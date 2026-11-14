/**
 * The first run's own page, /welcome (src/design/KIT.md): three steps to a first result, Agent · Project · First task,
 * told by first-run.ts's one model (welcomeModel) from live facts on every render, never a stored cursor. The page
 * reads; its acts are the ones that already own each change: choosing the agent posts to Settings → Lead's own
 * turn-on (/settings/lead/on), a folder and GitHub link to Projects, and the sample project is made and added here
 * (POST /welcome/sample) the way Projects adds a folder (project-admission.ts). A first task's starter only drafts its
 * words into New task's box: nothing is filed until the person sends it. Once the first result has arrived (or for a
 * project-limited account, or in the demo) the address leads Home.
 */
import { resolvePhaseAgent } from "../agentconfig.js";
import { CONSOLE_FORMS, readForm } from "../contracts/console-api.js";
import { builderReadyFor, firstRunBuilderRepo } from "../dispatch.js";
import { firstTaskSuggestions, SAMPLE_FIRST_TASKS, SAMPLE_PROJECT_NAME, welcomeModel, withBuilderStep, type WelcomeAgent, type WelcomeAgentId, type WelcomeModel } from "../first-run.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { START_BUILDER_HREF } from "../needs-you.js";
import { addSampleProject } from "../sample-project.js";
import { resolveCeiling } from "../project.js";
import { readProjectRegistryNow, type ProjectRegistry } from "../repos.js";
import { type Chrome, refuse, screen, type Screen } from "./chrome.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect } from "./http.js";
import { rereadBrowser } from "./live.js";
import { btn, chip, codeLine, dock, note, notice, pageHeader, settingsRecord } from "./kit.js";
import type { ServerRuntime } from "./runtime.js";

/** Why the sample project wasn't added, as a fixed key in the address (never words from it). */
export const SAMPLE_PROBLEMS = {
  "no-root": "There's no project folder to put the sample in. Add a folder instead.",
  exists: `A folder named ${SAMPLE_PROJECT_NAME} is already there and wasn't made here, so nothing was changed.`,
  failed: "The sample project couldn't be made. Nothing was added. Try again, or add a folder instead.",
  "not-added": "The sample project was made but couldn't be added. Try again, or add it from Projects.",
  incomplete: "The sample project wasn't added, and its line in the project list couldn't be taken back. Remove it in Projects, then try again.",
} as const;
export type SampleProblem = keyof typeof SAMPLE_PROBLEMS;
const isSampleProblem = (value: string | null): value is SampleProblem => value !== null && Object.hasOwn(SAMPLE_PROBLEMS, value);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const AGENT_WORDS: Record<WelcomeAgent["state"], string> = { "signed-in": "Signed in", "signed-out": "Not signed in", "not-installed": "Not installed", checking: "Checking…" };
const PROJECTS_SHOWN = 3;
const ADD_FOLDER = "/projects?return=%2Fwelcome";

/** One step: its number and name, Done once it is, then its body. */
function step(key: string, index: number, title: string, done: boolean, body: Html): Html {
  return html`<section class="k-sec welcome-step" id="welcome-${key}" data-step="${key}" data-done="${done ? "1" : "0"}" aria-labelledby="welcome-${key}-h">\
<div class="k-secthead"><h3 id="welcome-${key}-h">${index}. ${title}</h3>${done ? chip("Done", "done") : ""}</div>${body}</section>`;
}

/** "Use this one": Settings → Lead's own turn-on, for exactly this agent, back here. */
const useForm = (agent: WelcomeAgentId, button: Html): Html => postForm("/settings/lead/on", button, { hidden: { agent, return: "/welcome" } });

function agentRow(agent: WelcomeAgent, leads: boolean): Html {
  const sub = agent.command === null ? AGENT_WORDS[agent.state]
    : html`${AGENT_WORDS[agent.state]}. To sign in, run this on the computer running Toolroll:${codeLine(agent.command)}`;
  const action = agent.inUse ? chip("In use", "", { dot: false })
    : agent.canUse ? useForm(agent.id, btn("Use this one", { sm: true, type: "submit", ...(leads ? { variant: "primary" as const, docked: true } : {}) }))
    : "";
  return settingsRecord({ title: agent.name, sub, action, attrs: { "data-agent": agent.id, "data-state": agent.state } });
}

/** The page body for one model, and the screen's one primary (for the phone dock). `problem`: why the sample project
 * wasn't added, from the address. `canAdd`: this person may add projects here. */
export function welcomeBody(model: WelcomeModel, options: { problem?: SampleProblem | null; canAdd: boolean }): { body: Html; primary: Html | null } {
  const lead = model.next;
  let primary: Html | null = null;

  const agentLead = lead === "agent" ? model.agent.agents.find(one => one.canUse) ?? null : null;
  if (agentLead !== null) primary = useForm(agentLead.id, btn(`Use ${agentLead.name}`, { variant: "primary", type: "submit" }));
  const agentNote = model.agent.checking ? note("Checking for a signed-in agent on this computer…")
    : !model.agent.done ? note("Sign in to one of these, then come back to this page.")
      : model.agent.buildsWith !== null ? note(html`Tasks are built with ${model.agent.buildsWith}. <a class="k-link" href="/settings/models">Change</a>`) : "";
  const agent = step("agent", 1, "Agent", model.agent.done, html`<p class="k-note">The AI coding agent that plans and builds your tasks.</p>\
<div class="welcome-rows">${model.agent.agents.map(one => agentRow(one, agentLead?.id === one.id))}</div>${agentNote}`);

  const projects = model.project.projects;
  const listed = projects.slice(0, PROJECTS_SHOWN).map(one => settingsRecord({ title: one.name, sub: html`<span class="k-mono">${one.path}</span>`, attrs: { "data-project": "" } }));
  const more = projects.length > PROJECTS_SHOWN ? note(html`And ${plural(projects.length - PROJECTS_SHOWN, "more project", "more projects")} in <a class="k-link" href="/projects">Projects</a>.`) : "";
  const working = lead === "project" && model.project.notTakingWork;
  const folderLeads = lead === "project" && !working;
  const folderLabel = projects.length === 0 ? "Add a folder" : "Add another folder";
  if (folderLeads) primary = btn(folderLabel, { variant: "primary", href: ADD_FOLDER });
  if (working) primary = btn("Start taking work", { variant: "primary", href: START_BUILDER_HREF });
  const adds = joinHtml([
    model.project.notTakingWork ? btn("Start taking work", { sm: true, href: START_BUILDER_HREF, ...(working ? { variant: "primary" as const, docked: true } : {}) }) : "",
    btn(folderLabel, { sm: true, href: ADD_FOLDER, ...(folderLeads ? { variant: "primary" as const, docked: true } : {}) }),
    options.canAdd ? btn("From GitHub", { sm: true, href: "/projects/github" }) : "",
    options.canAdd && model.project.sample !== null ? postForm("/welcome/sample", btn("Try a sample project", { sm: true, type: "submit" }), { attrs: { class: "welcome-form" } }) : "",
  ]);
  const projectLine = projects.length === 0 ? "A git repository on this computer for agents to work in."
    : model.project.notTakingWork ? `${plural(projects.length, "project added", "projects added")}. Tasks can't start yet: this computer isn't taking work for them.`
      : plural(projects.length, "project added.", "projects added.");
  const sampleWhere = projects.length === 0 && options.canAdd && model.project.sample !== null
    ? note(html`The sample is a tiny repository, made at <span class="k-mono">${model.project.sample}</span>.`) : "";
  const project = step("project", 2, "Project", model.project.done, html`<p class="k-note">${projectLine}</p>\
${listed.length === 0 ? "" : html`<div class="welcome-rows">${listed}</div>`}${more}${options.problem ? notice(SAMPLE_PROBLEMS[options.problem]) : ""}\
<div class="k-acts welcome-acts">${adds}</div>${sampleWhere}`);

  const taskLeads = lead === "task";
  if (taskLeads) primary = btn("Write a task", { variant: "primary", href: "/tasks/new" });
  const taskBody = model.task.done ? !model.agent.done && !model.agent.checking ? html`<p class="k-note">Filed. It starts by itself once an agent is signed in (step 1).</p>`
    : html`<p class="k-note">Filed. Its plan waits for your approval in <a class="k-link" href="/tasks">Tasks</a>.</p>`
    : !model.task.open ? html`<p class="k-note">Add a project first.</p>`
      : html`<p class="k-note">Describe a change in a sentence or two. Nothing starts until you approve its plan.</p>\
${model.task.starters.length === 0 ? "" : html`<div class="k-ideas" aria-label="Ideas to start from" data-starters>${model.task.starters.map(one => html`<a class="k-btn k-btn-outline k-idea" href="${one.href}">${one.label}</a>`)}</div>`}\
<div class="k-acts">${btn("Write a task", { sm: true, href: "/tasks/new", ...(taskLeads ? { variant: "primary" as const, docked: true } : {}) })}</div>`;
  const task = step("task", 3, "First task", model.task.done, taskBody);

  const hello = html`<div class="k-hello"><h2>Get to your first result.</h2><p>${model.left === 0 ? "Setup is done." : `${plural(model.left, "step", "steps")} left.`}</p></div>`;
  return { body: html`${hello}${agent}${project}${task}`, primary };
}

export function welcomePage(chrome: Chrome, model: WelcomeModel, options: { problem?: SampleProblem | null; canAdd: boolean }): Screen {
  const { body, primary } = welcomeBody(model, options);
  return screen("Welcome", html`${pageHeader("Welcome")}<div class="k-doc welcome" data-welcome>${body}</div>${dock(primary)}`, { chrome });
}

const AGENT_OF: Readonly<Record<string, WelcomeAgentId>> = { "claude-subscription": "claude", "codex-subscription": "codex" };

export function createWelcomeHandlers(runtime: ServerRuntime) {
  const { store, sendScreen, chromeFor, firstRunStepsNow, managedRepos, visible, liveCeiling, identities, deletedRepos, options, sessions } = runtime;

  async function showWelcome(ctx: HandlerContext): Promise<void> {
    const { who, response, now, project, url } = ctx;
    const steps = withBuilderStep(firstRunStepsNow(now), builderReadyFor(store, firstRunBuilderRepo(store, project, visible, managedRepos()), now));
    // The first run is over (a first result, a project-limited account, the demo): the address leads Home.
    if (steps === null) return redirect(response, "/");
    // The projects the sidebar lists (a sample added here included).
    const chrome = chromeFor(project, "work");
    const projects = (chrome.projects ?? []).map(one => ({ name: one.name, path: one.path }));
    const repo = project ?? projects[0]?.path ?? null;
    const root = liveCeiling().roots[0] ?? null;
    const sample = root === null ? null : `${root.replace(/\/+$/, "")}/${SAMPLE_PROJECT_NAME}`;
    const starters = repo === null ? [] : repo === sample ? SAMPLE_FIRST_TASKS : runtime.firstTasks.get(repo)?.found ?? firstTaskSuggestions({ issues: [], todos: [] });
    const states = runtime.localSignIn?.states ?? null;
    const build = resolvePhaseAgent(store, "build", repo, {});
    const approver = who.via === "cookie" && who.role === "approver";
    const model = welcomeModel({
      agents: { claude: states?.claude ?? null, codex: states?.codex ?? null },
      inUse: AGENT_OF[store.getChatConfig()?.provider ?? ""] ?? null,
      buildsOn: build.ok ? build.spec.provider : null,
      canChoose: approver,
      projects, projectRoot: root,
      ready: steps.find(one => one.key === "builder")?.done ?? false,
      hasTask: steps.find(one => one.key === "task")?.done ?? false,
      starters, platform: options.platform ?? process.platform,
    });
    const asked = url.searchParams.get("sample");
    return sendScreen(response, 200, welcomePage(chrome, model, { problem: isSampleProblem(asked) ? asked : null, canAdd: approver && !store.isDemo() }));
  }

  /** Try a sample project: made in the project folder (or found again when it is ours), then added the way Projects
   * adds a folder, and opened (sample-project.ts addSampleProject, the one operation every surface uses). A refusal
   * comes back to the welcome as a fixed key. */
  async function addSample(ctx: HandlerContext): Promise<void> {
    const { who, response, now, posted, request } = ctx;
    readForm(posted, CONSOLE_FORMS.welcomeSample);
    if (who.via !== "cookie") return refuse(response, who, 403, "adding a project is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the sandbox never makes projects");
    const back = (problem: SampleProblem): void => redirect(response, `/welcome?sample=${problem}#welcome-project`);
    // This browser session, still saved, still an approver of the same generation: asked before anything is made, after
    // each wait, and inside the admission's own writes (a local owner's chain is re-proved by every write as well).
    const stands = (): boolean => { const again = rereadBrowser(runtime, request, who); return again !== null && again.role === "approver" && !store.isDemo(); };
    // What this console serves. An `up` console (it serves the registry's admitted set) decides on the registry as it is
    // now — under its lock when given it — so a projects folder taken out of the registry is no longer served for this;
    // a flag-only `serve` has no registry folders and keeps its own --project-root ceiling.
    const registryPath = options.registryPath ?? null;
    const registryBacked = registryPath !== null && options.admittedRepos !== undefined;
    const ceiling = (registry?: ProjectRegistry) => {
      const live = liveCeiling();
      if (!registryBacked) return live;
      const read = registry ?? readProjectRegistryNow(registryPath);
      const current = "error" in read ? [] : resolveCeiling([], read.roots).ceiling.roots;
      return { ...live, roots: live.roots.filter(root => current.includes(root)) };
    };
    const added = await addSampleProject({
      store, registryFile: registryPath, ceiling, now, visible,
      authority: { actor: { label: who.name, origin: "console" }, stands },
      resolveFolder: identities.resolveNow, generation: () => identities.generation(),
    });
    if (!added.ok) {
      if (added.reason === "refused") return refuse(response, who, 403, "your access changed while the sample was being added");
      return back(added.reason);
    }
    deletedRepos.delete(added.repo);
    who.session.project = added.repo;
    who.session.projectRevision++;
    sessions.persist(who.session);
    return redirect(response, "/welcome");
  }

  return { registrations: handlersOf("tasks", { welcome: showWelcome, "welcome.sample": addSample }) };
}
