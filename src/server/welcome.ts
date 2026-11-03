/**
 * The first run's own page, /welcome (Wave E, src/design/KIT.md): five guided steps to a first result, each derived
 * from live facts on every render (never a stored cursor), each with the one action that does it. The next required
 * step's action is the screen's one primary (on a fresh install: Add a project); alerts on the phone are optional and
 * never lead. It only reads: every step's action is a link to the page that does it. Once the first result has
 * arrived (or for a project-limited account, or in the demo) the first run is over and the address leads Home.
 */
import { builderReadyFor, firstRunBuilderRepo } from "../dispatch.js";
import { withBuilderStep, type FirstRunStep } from "../first-run.js";
import { html, type Html } from "../html.js";
import { START_BUILDER_HREF } from "../needs-you.js";
import { handlersOf } from "./handler-registry.js";
import type { HandlerContext } from "./handler-context.js";
import { redirect } from "./http.js";
import { btn, checklist, dock, pageHeader, type CheckStep } from "./kit.js";
import type { ServerRuntime } from "./runtime.js";
import { type Chrome, screen, type Screen } from "./chrome.js";

export type WelcomeFacts = {
  steps: readonly FirstRunStep[];
  projects: number;
  /** This person has a live push enrollment on some device. */
  alerts: boolean;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The five steps as the page shows them, and which one leads. */
export function welcomeSteps(facts: WelcomeFacts): { steps: CheckStep[]; primary: { label: string; href: string } | null } {
  const step = (key: FirstRunStep["key"]) => facts.steps.find(one => one.key === key);
  const agent = step("agent"), builder = step("builder"), task = step("task");
  const projectDone = facts.projects > 0;
  const agentDone = (agent?.done ?? false) && (builder?.done ?? true);
  const command = agent?.action?.kind === "command" ? agent.action.command : null;
  const agentState: CheckStep["state"] = agentDone ? "done" : agent?.checking === true ? "checking" : "open";
  const agentText = agentDone ? "An agent is signed in and a builder is ready."
    : agent?.checking === true ? "Checking for a signed-in agent on this computer…"
      : agent !== undefined && !agent.done && command !== null ? html`On the computer running Toolroll, run <code class="k-mono">${command}</code>.`
        : "Start a builder so tasks can run.";
  const agentLink = agentDone || agent?.checking === true ? null
    : agent !== undefined && !agent.done ? { label: "Agent settings", href: "/settings/models" } : { label: "Start a builder", href: START_BUILDER_HREF };
  const taskDone = task?.done ?? false;
  // The next required step leads (alerts are optional and never do).
  const order: Array<{ key: string; open: boolean; link: { label: string; href: string } | null }> = [
    { key: "project", open: !projectDone, link: { label: "Add a project", href: "/projects" } },
    { key: "agent", open: agentState === "open", link: agentLink },
    { key: "task", open: !taskDone && projectDone, link: { label: "New task", href: "/tasks/new" } },
  ];
  const lead = order.find(one => one.open && one.link !== null) ?? null;
  const action = (key: string, link: { label: string; href: string } | null): Html | null =>
    link === null ? null : btn(link.label, { sm: true, href: link.href, ...(lead?.key === key ? { variant: "primary" as const, docked: true } : {}) });
  const steps: CheckStep[] = [
    { key: "password", title: "Your password", text: "You're signed in. Your first login is saved on the computer running Toolroll.", state: "done" },
    { key: "project", title: "Add a project", text: projectDone ? plural(facts.projects, "project added.", "projects added.") : "A git repository agents work in.", state: projectDone ? "done" : "open", action: action("project", order[0]!.link) },
    { key: "agent", title: "Agent and models", text: agentText, state: agentState, action: action("agent", agentLink) },
    { key: "phone", title: "Alerts on your phone", text: facts.alerts ? "Alerts are on." : "Optional. Hear when something needs you.", state: facts.alerts ? "done" : "open", action: btn("Set up alerts", { sm: true, href: "/settings#phone" }) },
    { key: "task", title: "Your first task", text: taskDone ? "Filed. Its plan waits for your approval." : "Describe a change and approve its plan.", state: taskDone ? "done" : "open",
      action: projectDone ? action("task", order[2]!.link) : null },
  ];
  return { steps, primary: lead?.link ?? null };
}

export function welcomePage(chrome: Chrome, facts: WelcomeFacts): Screen {
  const { steps, primary } = welcomeSteps(facts);
  const left = steps.filter(one => one.state !== "done").length;
  const body = html`${pageHeader("Welcome")}<div class="k-doc"><div class="k-hello"><h2>Get to your first result.</h2><p>${left === 0 ? "Setup is done." : `${plural(left, "step", "steps")} left.`}</p></div>\
${checklist(steps, "Setup steps")}</div>${dock(primary === null ? null : btn(primary.label, { variant: "primary", href: primary.href }))}`;
  return screen("Welcome", body, { chrome });
}

export function createWelcomeHandlers(runtime: ServerRuntime) {
  const { store, sendScreen, chromeFor, firstRunStepsNow, managedRepos, visible } = runtime;
  async function showWelcome(ctx: HandlerContext): Promise<void> {
    const { who, response, now, project } = ctx;
    const steps = withBuilderStep(firstRunStepsNow(now), builderReadyFor(store, firstRunBuilderRepo(store, project, visible, managedRepos()), now));
    // The first run is over (a first result, a project-limited account, the demo): the address leads Home.
    if (steps === null) return redirect(response, "/");
    const alerts = who.via === "cookie" && store.listPushSubscriptions(who.name).some(one => one.retiredAt === null);
    return sendScreen(response, 200, welcomePage(chromeFor(project, "work"), { steps, projects: managedRepos().length, alerts }));
  }
  return { registrations: handlersOf("tasks", { welcome: showWelcome }) };
}
