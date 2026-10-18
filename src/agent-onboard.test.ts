/**
 * `toolroll onboard`, over a temp HOME and a temp database: the project,
 * the sign-in report, the operator skill's whole life (preview, write,
 * current, upgrade, foreign, remove), consent, and the handoff.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runOperate, type OnboardSeams } from "./operate.js";
import { openStore } from "./store.js";
import { loadProjectRegistry } from "./repos.js";
import { RELEASED_SKILLS, agentHome, operatorSkillContent, skillFingerprint } from "./agent-onboard.js";
import { addApprover } from "./scope.js";
import { CLAUDE_CODE_MANAGED_MARK, claudeCodeGuideContent, claudeCodeSkillContent, planClaudeCodeInstall } from "./skills.js";
import type { ProviderConnection } from "./provider-connection.js";
import { PACKAGE_VERSION } from "./version.js";

let base: string;
let home: string;
let repo: string;
let elsewhere: string;
let db: string;
let lines: string[];
let asked: string[];

const connections: Record<string, ProviderConnection> = {
  claude: { state: "connected", mode: "subscription", plan: "Max", checkedAt: "2026-09-29T00:00:00.000Z" },
  codex: { state: "signed-out", mode: "subscription", checkedAt: "2026-09-29T00:00:00.000Z" },
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-onboard-")));
  home = join(base, "home");
  repo = join(base, "project");
  elsewhere = join(base, "not-a-repo");
  db = join(base, "config", "orders.db");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(base, "config"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  lines = [];
  asked = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const onboard = (argv: string[], seams: OnboardSeams = {}) =>
  runOperate("onboard", argv, line => lines.push(line), {
    databaseFile: db,
    onboardSeams: {
      home,
      env: {},
      cwd: repo,
      interactive: false,
      checkConnection: async agent => connections[agent] as ProviderConnection,
      ...seams,
    },
  });
const envelope = () => JSON.parse(lines.join("\n")) as Record<string, any>;
const claudeSkill = () => join(home, ".claude", "skills", "toolroll", "SKILL.md");
const codexSkill = () => join(home, ".codex", "skills", "toolroll", "SKILL.md");

describe("toolroll onboard", () => {
  test("adds the current repository as a project and reports who is signed in", async () => {
    expect(await onboard(["--yes", "--json"])).toBe(0);
    const answer = envelope();
    expect(answer).toMatchObject({ ok: true, command: "onboard", project: { path: repo, added: true } });
    expect(answer.agents).toEqual([
      { agent: "claude", name: "Claude Code", state: "connected", words: "Connected", plan: "Max" },
      { agent: "codex", name: "Codex", state: "signed-out", words: "Not signed in" },
    ]);
    const registry = await loadProjectRegistry(join(base, "config", "repos.json"));
    expect(registry).toMatchObject({ repos: [repo] });
    const store = openStore(db);
    try {
      expect(store.listProjects().map(one => one.path)).toContain(repo);
    } finally {
      store.close();
    }

    lines = [];
    await onboard(["--json"]);
    expect(envelope().project).toEqual({ path: repo, added: false });
  });

  test("the project needs a yes like the skill: without one it is only named", async () => {
    expect(await onboard(["--json"])).toBe(0);
    expect(envelope()).toMatchObject({ project: null, projectProblem: `not added yet: run again with --yes to add ${repo}` });
    expect(await loadProjectRegistry(join(base, "config", "repos.json"))).not.toMatchObject({ repos: [repo] });
  });

  test("inside a linked worktree the project is the main checkout", async () => {
    const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(["add", "."], repo);
    git(["commit", "-qm", "first"], repo);
    const linked = join(base, "linked");
    git(["worktree", "add", "-q", linked], repo);
    expect(await onboard(["--yes", "--json"], { cwd: join(linked) })).toBe(0);
    expect(envelope().project).toEqual({ path: repo, added: true });
    expect(await loadProjectRegistry(join(base, "config", "repos.json"))).toMatchObject({ repos: [repo] });
  });

  test("the home folder and Toolroll's own worktrees are never a project", async () => {
    execFileSync("git", ["init", "-q"], { cwd: home });
    expect(await onboard(["--yes", "--json"], { cwd: home })).toBe(0);
    expect(envelope()).toMatchObject({ project: null, projectProblem: `${home} is your home folder, not a project: run onboard inside the repository you want to hand off` });

    const leased = join(base, "config", "worktrees", "toolroll-task-1");
    mkdirSync(leased, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: leased });
    lines = [];
    expect(await onboard(["--yes", "--json"], { cwd: leased })).toBe(0);
    expect(envelope().projectProblem).toBe(`${leased} is one of Toolroll's own worktrees, not a project: run onboard inside your own checkout`);
    const registry = await loadProjectRegistry(join(base, "config", "repos.json"));
    expect("error" in registry || registry.repos.length === 0).toBe(true);
  });

  test("outside a repository nothing is added and the rest still answers", async () => {
    expect(await onboard(["--json"], { cwd: elsewhere })).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, project: null, projectProblem: "not inside a git repository" });
  });

  test("without --yes and no terminal, nothing is written outside the repository", async () => {
    expect(await onboard(["--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "needs-yes", files: [{ agent: "claude", path: claudeSkill(), action: "create" }], wrote: [] });
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("--yes installs the marked skill for each agent found, and a second run changes nothing", async () => {
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "written", wrote: [claudeSkill(), codexSkill()] });
    const content = readFileSync(claudeSkill(), "utf8");
    expect(content).toBe(operatorSkillContent(PACKAGE_VERSION));
    expect(readFileSync(codexSkill(), "utf8")).toBe(content);
    expect(envelope().mcp).toEqual([
      { agent: "claude", command: "claude mcp add --scope user toolroll -- toolroll mcp" },
      { agent: "codex", command: "codex mcp add toolroll -- toolroll mcp" },
    ]);

    lines = [];
    await onboard(["--yes", "--json"]);
    expect(envelope().skill).toMatchObject({ state: "current", wrote: [], removed: [] });
  });

  test("CODEX_HOME and --agent choose where the skill goes", async () => {
    const codexHome = join(base, "codex-home");
    expect(await onboard(["--agent", "codex", "--yes", "--json"], { env: { CODEX_HOME: codexHome } })).toBe(0);
    expect(envelope().skill.wrote).toEqual([join(codexHome, "skills", "toolroll", "SKILL.md")]);
    expect(existsSync(claudeSkill())).toBe(false);
    lines = [];
    expect(await onboard(["--agent", "cursor", "--json"])).toBe(2);
    expect(envelope()).toMatchObject({ ok: false, reason: "usage" });
  });

  test("a relative CODEX_HOME is under the home folder, never the repository onboard runs in", async () => {
    expect(agentHome("codex", home, { CODEX_HOME: "codex-home" })).toBe(join(home, "codex-home"));
    expect(await onboard(["--agent", "codex", "--yes", "--json"], { env: { CODEX_HOME: "codex-home" } })).toBe(0);
    expect(envelope().skill.wrote).toEqual([join(home, "codex-home", "skills", "toolroll", "SKILL.md")]);
    expect(existsSync(join(repo, "codex-home"))).toBe(false);
  });

  test("a skill of ours with the person's edits is left and reported, by --yes and by --remove", async () => {
    const folder = join(home, ".claude", "skills", "toolroll");
    mkdirSync(folder, { recursive: true });
    const edited = `${operatorSkillContent("0.1.0")}\nAlways ask me before queueing more than three tasks.\n`;
    writeFileSync(claudeSkill(), edited);
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "edited", files: [{ action: "edited" }], wrote: [] });
    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "edited" });
    expect(readFileSync(claudeSkill(), "utf8")).toBe(edited);
  });

  test("an older skill of ours is replaced, and its old guide copies go with it", async () => {
    const folder = join(home, ".claude", "skills", "toolroll");
    mkdirSync(folder, { recursive: true });
    writeFileSync(claudeSkill(), operatorSkillContent("0.1.0"));
    writeFileSync(join(folder, "console.md"), claudeCodeGuideContent("console"));
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "written", files: [{ action: "replace" }], removed: [join(folder, "console.md")] });
    expect(readFileSync(claudeSkill(), "utf8")).toBe(operatorSkillContent(PACKAGE_VERSION));
    expect(existsSync(join(folder, "console.md"))).toBe(false);
  });

  test("an old guide copy the person edited, or one no release wrote, stays", async () => {
    const folder = join(home, ".claude", "skills", "toolroll");
    mkdirSync(folder, { recursive: true });
    writeFileSync(claudeSkill(), operatorSkillContent("0.1.0"));
    const edited = `${claudeCodeGuideContent("operating")}\nMy own note: never queue on Fridays.\n`, unknown = `${CLAUDE_CODE_MANAGED_MARK}\n\n# old\n`;
    writeFileSync(join(folder, "operating.md"), edited);
    writeFileSync(join(folder, "runner.md"), unknown);
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "written", removed: [] });
    expect(readFileSync(join(folder, "operating.md"), "utf8")).toBe(edited);
    expect(readFileSync(join(folder, "runner.md"), "utf8")).toBe(unknown);
    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(0);
    expect(readFileSync(join(folder, "operating.md"), "utf8")).toBe(edited);
  });

  test("the skills this build writes are recorded, so a later wording change still knows them as Toolroll's", () => {
    // When this fails, the words changed: append the new fingerprint to RELEASED_SKILLS and keep the old ones.
    for (const content of [operatorSkillContent(PACKAGE_VERSION), claudeCodeSkillContent()]) expect(RELEASED_SKILLS).toContain(skillFingerprint(content));
  });

  test("`skills install --claude-code` recognizes the operator skill as Toolroll's", async () => {
    await onboard(["--yes"]);
    const plan = planClaudeCodeInstall(join(home, ".claude", "skills", "toolroll"), null);
    expect(plan.files.find(file => file.name === "SKILL.md")?.action).toBe("replace");
  });

  test("a SKILL.md that is not Toolroll's is never overwritten or removed", async () => {
    mkdirSync(join(home, ".claude", "skills", "toolroll"), { recursive: true });
    writeFileSync(claudeSkill(), "---\nname: toolroll\n---\nmine\n");
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "not-ours", wrote: [] });
    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "not-ours" });
    expect(readFileSync(claudeSkill(), "utf8")).toBe("---\nname: toolroll\n---\nmine\n");
  });

  test("--remove deletes only with a yes, and then there is nothing left to remove", async () => {
    await onboard(["--yes"]);
    lines = [];
    expect(await onboard(["--remove", "--json"])).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "unconfirmed" });
    expect(existsSync(claudeSkill())).toBe(true);

    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, skill: { state: "removed", removed: [claudeSkill()] } });
    expect(existsSync(join(home, ".claude", "skills", "toolroll"))).toBe(false);
  });

  test("at a terminal it asks once: yes writes, anything else writes nothing", async () => {
    const seams = (answer: boolean): OnboardSeams => ({ interactive: true, confirm: async question => { asked.push(question); return answer; } });
    expect(await onboard([], seams(false))).toBe(0);
    expect(asked).toEqual([`Add ${repo} as a project and write ${claudeSkill()}? [y/N]`]);
    expect(lines.join("\n")).toContain("skill     nothing written");
    expect(lines.join("\n")).toContain(`project   ${repo} not added`);
    expect(existsSync(claudeSkill())).toBe(false);

    lines = [];
    expect(await onboard([], seams(true))).toBe(0);
    expect(lines.join("\n")).toContain(`skill     wrote ${claudeSkill()}`);
    expect(lines.join("\n")).toContain(`project   ${repo} — added`);
    expect(existsSync(claudeSkill())).toBe(true);
  });
});

describe("the handoff", () => {
  const loginFile = () => join(base, "config", "up-login.txt");
  /** An account, and its login saved beside the database the way `up` saves it. */
  const account = (saved = true) => {
    const store = openStore(db);
    try {
      const added = addApprover(store, "alex", new Date());
      if (!added.ok) throw new Error("no account");
      if (saved) writeFileSync(loginFile(), `alex ${added.token}\n`, { mode: 0o600 });
      return added.token;
    } finally {
      store.close();
    }
  };

  test("as text: the login file, never the password", async () => {
    const password = account();
    await onboard(["--port", "4190"]);
    const text = lines.join("\n");
    expect(text).toContain(`  login     alex — the password is in ${loginFile()}`);
    expect(text).not.toContain(password);
  });

  test("as --json: the same facts as data", async () => {
    const password = account();
    await onboard(["--json"]);
    expect(envelope().handoff).toEqual({
      console: "http://127.0.0.1:4180",
      start: "toolroll up",
      login: { account: "alex", file: loginFile() },
      phone: "Open the console on your phone over your tailnet, or pair Telegram in Settings → Telegram with the /pair code it shows.",
      next: ["queue these bugs overnight", "what needs me?", "open the result"],
    });
    expect(lines.join("\n")).not.toContain(password);
  });

  test("with no account yet it says how to get one", async () => {
    await onboard(["--json"]);
    expect(envelope().handoff.login).toBeNull();
  });

  test("an account without a saved login keeps its name and says to sign in with the password", async () => {
    account(false);
    await onboard(["--json"]);
    expect(envelope().handoff.login).toEqual({ account: "alex", file: null });
  });

  test("a saved login that no longer works is not pointed at", async () => {
    account(false);
    writeFileSync(loginFile(), "alex an-old-password\n", { mode: 0o600 });
    await onboard(["--json"]);
    expect(envelope().handoff.login).toEqual({ account: "alex", file: null });
  });

  test("the console is where `up` last served it, unless --port says otherwise", async () => {
    writeFileSync(join(base, "config", "up-console.json"), `${JSON.stringify({ url: "http://127.0.0.1:4312/", at: "2026-09-30T00:00:00.000Z" })}\n`);
    await onboard(["--json"]);
    expect(envelope().handoff.console).toBe("http://127.0.0.1:4312");
    lines = [];
    await onboard(["--json", "--port", "4190"]);
    expect(envelope().handoff.console).toBe("http://127.0.0.1:4190");
  });
});

describe("toolroll onboard offers the starter flows", () => {
  const withAccountAndGithub = () => {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:alex/shop.git"], { cwd: repo });
    const store = openStore(db);
    try { if (!addApprover(store, "alex", new Date("2026-09-30T09:00:00Z")).ok) throw new Error("account"); } finally { store.close(); }
  };

  test("c3: --starter switches on the named starters, each making its trigger and zones; the rest are offered with the command", async () => {
    withAccountAndGithub();
    expect(await onboard(["--yes", "--json", "--starter", "ci-fix,overnight"], { pullRequests: async () => "off" })).toBe(0);
    const answer = envelope();
    expect(answer.starters.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([["ci-fix", "switched-on"], ["issue-task", "off"], ["overnight", "switched-on"], ["plane-review", "off"]]);
    expect(answer.starters[1]).toMatchObject({ command: "toolroll onboard --starter issue-task", never: "Never merges or closes anything without you." });
    const store = openStore(db);
    try {
      const flows = store.listFlows([repo]);
      expect(flows.map(one => one.name).sort()).toEqual(["Fix failing CI", "Overnight queue"]);
      const ci = flows.find(one => one.name === "Fix failing CI")!;
      expect(store.flowTriggers(ci.id).map(one => [one.kind, JSON.parse(one.configJson)])).toEqual([["github", expect.objectContaining({ repo: "alex/shop", watch: "checks", branch: "main", zone: "fix" })]]);
      const overnight = flows.find(one => one.name === "Overnight queue")!;
      expect(JSON.parse(overnight.definitionJson).stages.map((one: { id: string; kind: string }) => [one.id, one.kind])).toEqual([["tonight", "wait"], ["build", "task"], ["morning", "approval"], ["done", "done"]]);
      expect(store.flowTriggers(overnight.id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "button", label: "Queue for tonight", zone: "tonight" })]);
      expect(overnight.owner).toBe("alex");
    } finally {
      store.close();
    }
    // Again: already on, nothing doubled.
    lines = [];
    await onboard(["--json", "--starter", "ci-fix"], { pullRequests: async () => "off" });
    expect(envelope().starters[0]).toMatchObject({ id: "ci-fix", state: "on" });
    const again = openStore(db);
    try { expect(again.listFlows([repo])).toHaveLength(2); } finally { again.close(); }
    lines = [];
    expect(await onboard(["--json", "--starter", "nightly"], { pullRequests: async () => "off" })).toBe(2);
    expect(envelope()).toMatchObject({ ok: false, reason: "usage", message: "--starter takes ci-fix, issue-task, overnight, plane-review" });
  });

  test("c3: at a terminal each starter is one yes, saying what it does and never does; --yes alone switches none on", async () => {
    withAccountAndGithub();
    expect(await onboard(["--yes"], { pullRequests: async () => "off" })).toBe(0);
    let store = openStore(db);
    try { expect(store.listFlows([repo])).toEqual([]); } finally { store.close(); }
    expect(lines.join("\n")).toContain("starters  Fix failing CI: When CI fails on the main branch, a task to fix it is filed. Never merges or pushes to your branch. You decide what ships. Switch on: toolroll onboard --starter ci-fix");

    lines = [];
    await onboard([], { pullRequests: async () => "off", interactive: true, confirm: async question => { asked.push(question); return question.startsWith("Switch on Issues become tasks?"); } });
    expect(asked.filter(one => one.startsWith("Switch on"))).toEqual([
      "Switch on Fix failing CI? When CI fails on the main branch, a task to fix it is filed. Never merges or pushes to your branch. You decide what ships. [y/N]",
      "Switch on Issues become tasks? A GitHub issue labelled “toolroll” becomes a task. Never merges or closes anything without you. [y/N]",
      "Switch on Overnight queue? Cards you add during the day start after 22:00; results wait for you in the morning. Never merges or ships anything without you. [y/N]",
      "Switch on Morning plane review? What went wrong in Toolroll yesterday becomes cards, researched and fixed. Never merges or ships anything without you. Each fix waits for your approval. [y/N]",
    ]);
    expect(lines.join("\n")).toContain("         Issues become tasks: switched on");
    store = openStore(db);
    try {
      const flow = store.listFlows([repo])[0]!;
      expect(flow.name).toBe("Issues become tasks");
      expect(store.flowTriggers(flow.id).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "github", watch: "issues", label: "toolroll", zone: "build" })]);
    } finally { store.close(); }
  });
});
