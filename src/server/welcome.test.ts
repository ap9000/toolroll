/**
 * The welcome page (/welcome): its three steps from the one model, in plain words, with each step's acts.
 */
import { describe, expect, test } from "vitest";
import { GENERIC_FIRST_TASKS, welcomeModel, type WelcomeFacts } from "../first-run.js";
import { htmlString } from "../html.js";
import { withFormToken } from "./request-context.js";
import { welcomeBody, type SampleProblem } from "./welcome.js";

const base: WelcomeFacts = {
  agents: { claude: "connected", codex: "signed-out" }, inUse: "claude", buildsOn: "claude", canChoose: true,
  projects: [], projectRoot: "/Users/sam/Projects", ready: false, hasTask: false, starters: GENERIC_FIRST_TASKS, platform: "darwin",
};
const render = (facts: Partial<WelcomeFacts> = {}, options: { problem?: SampleProblem | null; canAdd?: boolean } = {}) => {
  const { body, primary } = withFormToken("t0k", () => welcomeBody(welcomeModel({ ...base, ...facts }), { canAdd: options.canAdd ?? true, problem: options.problem ?? null }));
  return { body: htmlString(body), primary: primary === null ? null : htmlString(primary) };
};
/** Words these screens never say: the product's inside terms. */
const JARGON = /\b(approvers?|builders?|scopes?|digests?|runners?|lead|leads)\b/i;
const words = (page: string) => page.replace(/<[^>]*>/g, " ");

describe("the welcome page", () => {
  test("three steps, Agent · Project · First task, and no password or phone step", () => {
    const { body } = render();
    expect([...body.matchAll(/data-step="([a-z]+)"/g)].map(one => one[1])).toEqual(["agent", "project", "task"]);
    expect(body).not.toMatch(/password|phone|alerts/i);
    expect(body).not.toMatch(/gemini/i);
  });

  test("every state reads in plain words", () => {
    const states: Partial<WelcomeFacts>[] = [
      {}, { agents: { claude: null, codex: null }, inUse: null }, { agents: { claude: "not-installed", codex: "not-installed" }, inUse: null },
      { inUse: "codex", agents: { claude: "connected", codex: "connected" } },
      { projects: [{ name: "shop", path: "/Users/sam/Projects/shop" }] },
      { projects: [{ name: "shop", path: "/Users/sam/Projects/shop" }], ready: true },
      { projects: [{ name: "shop", path: "/Users/sam/Projects/shop" }], ready: true, hasTask: true },
    ];
    for (const facts of states) {
      for (const problem of [null, "exists", "failed", "no-root", "not-added"] as const) {
        const { body, primary } = render(facts, { problem });
        expect(words(body)).not.toMatch(JARGON);
        if (primary !== null) expect(words(primary)).not.toMatch(JARGON);
      }
    }
  });

  test("Agent: each one's state and exact sign-in command; Use this one posts the existing turn-on for exactly that agent", () => {
    const { body, primary } = render({ agents: { claude: "connected", codex: "connected" }, inUse: null });
    expect(body).toContain('data-agent="claude" data-state="signed-in"');
    expect(body).toMatch(/action="\/settings\/lead\/on"[\s\S]*name="agent" value="claude"[\s\S]*name="return" value="\/welcome"/);
    expect(primary).toContain("Use Claude Code");
    const out = render({ agents: { claude: "signed-out", codex: "not-installed" }, inUse: null }).body;
    expect(out).toContain("claude auth login");
    expect(out).toContain("npm install -g @openai/codex &amp;&amp; codex login");
    expect(out).not.toContain("/settings/lead/on");
  });

  test("Project: a folder, GitHub and the sample; a failed sample says so in fixed words", () => {
    const { body, primary } = render({ agents: { claude: "signed-out", codex: "signed-out" }, inUse: null });
    expect(body).toContain('href="/projects?return=%2Fwelcome"');
    expect(body).toContain('href="/projects/github"');
    expect(body).toMatch(/action="\/welcome\/sample"/);
    expect(body).toContain("/Users/sam/Projects/toolroll-sample");
    expect(primary).toContain("Add a folder");
    expect(render({}, { problem: "exists" }).body).toContain('role="alert"');
    // Someone who can't add projects sees no adding acts but the folder link; no folder means no sample.
    expect(render({}, { canAdd: false }).body).not.toMatch(/\/welcome\/sample|\/projects\/github/);
    expect(render({ projectRoot: null }).body).not.toContain("/welcome/sample");
  });

  test("First task: starters link to New task with the words drafted; nothing here files a task", () => {
    const { body, primary } = render({ projects: [{ name: "shop", path: "/p/shop" }], ready: true });
    for (const one of GENERIC_FIRST_TASKS) expect(body).toContain(`href="/tasks/new?text=${encodeURIComponent(one.draft)}"`);
    expect(body).not.toContain("/tasks/add");
    expect(primary).toContain("Write a task");
  });

  test("a long project name and path stay in the page's words, escaped", () => {
    const long = `${"a-very-long-project-name-".repeat(6)}<b>`;
    const { body } = render({ projects: [{ name: long, path: `/Users/sam/Projects/${long}` }] });
    expect(body).toContain("a-very-long-project-name-a-very-long-project-name-");
    expect(body).not.toContain("<b>");
  });
});
