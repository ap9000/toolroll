/**
 * `toolroll onboard`: the agent that installed Toolroll becomes its lead.
 *
 * Run inside a repository, it adds that repository as a project (the same
 * registry and project row Projects → add writes), reports which agent
 * CLIs are signed in (the checks Settings → AI providers makes), installs
 * a thin operator skill for the person's own agent, prints the MCP line
 * without running it, and ends with a handoff the agent can relay.
 *
 * Adding the project and writing the skill both need --yes or one yes
 * typed at a terminal. Then it offers the starter flows (flow-starters.ts),
 * each switched on by its own yes at a terminal or by --starter; --yes alone
 * never switches one on. The project is the main checkout (never a linked
 * worktree, the home folder, or one of Toolroll's own worktrees). The skill
 * is replaced by the next onboard and deleted by `onboard --remove` only
 * while it is exactly a version Toolroll wrote; a file of the same name
 * that is not ours, or ours with the person's edits, is never touched.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { CLAUDE_CODE_GUIDES, CLAUDE_CODE_MANAGED_MARK, MANAGED_MARK, OPERATOR_SKILL_MARK, claudeCodeGuideContent, claudeCodeSkillContent } from "./skills.js";
import type { ProviderConnection } from "./provider-connection.js";
import { connectionWords } from "./control-ui.js";
import { envelopeJson } from "./envelope.js";
import type { StarterView, SwitchedOn } from "./flow-starters.js";

export type OnboardAgent = "claude" | "codex";
export const ONBOARD_AGENTS: readonly OnboardAgent[] = ["claude", "codex"];
export const AGENT_NAMES: Record<OnboardAgent, string> = { claude: "Claude Code", codex: "Codex" };

/** Each agent's user-level home: where its skills folder lives. A relative CODEX_HOME is under the home folder, never
 * wherever onboard happens to run. */
export function agentHome(agent: OnboardAgent, home: string, env: Record<string, string | undefined>): string {
  if (agent === "codex") {
    const codexHome = env["CODEX_HOME"];
    if (codexHome === undefined || codexHome === "") return join(home, ".codex");
    return isAbsolute(codexHome) ? codexHome : resolve(home, codexHome);
  }
  return join(home, ".claude");
}

export function operatorSkillPath(agent: OnboardAgent, home: string, env: Record<string, string | undefined>): string {
  return join(agentHome(agent, home, env), "skills", "toolroll", "SKILL.md");
}

/** The agents this person uses: those whose home folder exists, else Claude Code. */
export function detectAgents(home: string, env: Record<string, string | undefined>): OnboardAgent[] {
  const found = ONBOARD_AGENTS.filter(agent => existsSync(agentHome(agent, home, env)));
  return found.length > 0 ? found : ["claude"];
}

/** The line that adds Toolroll as tools, for every project. Printed, never run. */
export function mcpLine(agent: OnboardAgent): string {
  return agent === "claude" ? "claude mcp add --scope user toolroll -- toolroll mcp" : `${agent} mcp add toolroll -- toolroll mcp`;
}

/** The thin skill: when to reach for Toolroll, and where the real guides are. */
export function operatorSkillContent(version: string): string {
  return `---
name: toolroll
description: Hand coding work to this machine's Toolroll and see it through. Use when the person wants work done unattended ("queue these bugs overnight"), asks what needs them, wants to wait on or review a result, or wants finished work released.
---

${OPERATOR_SKILL_MARK} · written by toolroll ${version}. \`toolroll onboard --yes\` replaces this file; \`toolroll onboard --remove --yes\` deletes it. -->

# Toolroll

You lead this person's Toolroll. Its agents build; the person approves.

- **Hand off** work that can run without anyone watching: a batch of bugs, a refactor, anything overnight.
- **Wait** on handed-off work with Toolroll instead of checking by hand.
- **Review**: say what needs the person, and open finished results.
- **Release** a result the person accepted through Toolroll's own publishing, never by pushing it yourself.

Read the guides from the installed binary. They match its version, so do not copy them:

- \`toolroll skills get operating\`: the commands, their JSON answers, and what you must never do.
- \`toolroll skills get console\`: which screen does what, for the person.
- \`toolroll skills list\`: every other guide.

Approving work and answering decisions belong to the person. Never read out or repeat their password.
`;
}

const escapedMark = OPERATOR_SKILL_MARK.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const WRITTEN_BY = new RegExp(`^(${escapedMark} · written by toolroll )(\\S+?)(\\. \`toolroll onboard)`, "m");

/** A skill's fingerprint with the version it names set aside: every release writes the same words. */
export function skillFingerprint(content: string): string {
  return createHash("sha256").update(content.replace(WRITTEN_BY, "$1*$3")).digest("hex");
}

/** Every SKILL.md a release has generated at this path (skillFingerprint): the operator skill, and `skills install
 * --claude-code`'s. Kept, never replaced, when the words change: a skill an earlier release wrote is still ours. A
 * test fails until this build's own fingerprints are listed. */
export const RELEASED_SKILLS: readonly string[] = [
  "6ff9b4458f332636b6c5968c416bee4770564ef0190d62ec8640e84051fb7f60", // skills install --claude-code
  "3fb6741eec6d394a0a41604cae321da05d85c74f440424b740151c131f125742", // the operator skill
  "448fc51dc200b4d46c53bf191fd7ecee7c4f7487413bf4dbfb1f984a3b401993", // skills install --claude-code, with the release guide
];
const KNOWN_SKILLS = new Set([...RELEASED_SKILLS, ...[operatorSkillContent("0.0.0"), claudeCodeSkillContent()].map(skillFingerprint)]);

/** SHA-256 of every guide copy (console.md, operating.md, runner.md, release.md) an earlier `skills install --claude-code` wrote
 * beside SKILL.md, and of this build's. Only an exact one of these is removed: an edited copy is the person's. */
const RELEASED_GUIDES: readonly string[] = [
  "a5aa20f93d803fd49bbac2908e46353a4f90c95c2bb57993ee724770c28adb0b", "65fc1774c4d6dd99e71a7cfb245a61148ac74889765477ddd5066703cd28f55c", "01604f373b92de737ae7f75804c7f7f09dd690ed96a3e676be75f71358819f23",
  "1e1ee5c46c84b65c931e86c005802478415ec026b6240367e7f12a8d66d608eb", "e5270e70eb09f202980a236a0ae36ac2e1c3df91840c24d40a6a8bd4c0d47fe8", "969dd5e97b63f27dc559889a551f4392bcf289f2b47ce802338868f06e05f1c9",
  "bea301cb7b7d7711afb165b72c355ff829e6341abb75c59431c4a0a7c129b6cd",
  "4b087ed3fdb60b8b7c56a2312a990eab1a854078592e355d852f4a4c5b13c752", "ac61340c17d780994052cd8ed9a0541f1fa64b80f95fc7e915e6899baa163caa", "a11a8576cc17a9e40ecfbf01503979298a4b003a4badffbd1dbd455b0eafde64",
  "37518ca87fdbb54ff649289ec1893232137fd30c9db6e29cd1fc4bc9ba5e2f1a",
];
const guideHash = (content: string) => createHash("sha256").update(content).digest("hex");
const KNOWN_GUIDES = new Set([...RELEASED_GUIDES, ...CLAUDE_CODE_GUIDES.map(name => guideHash(claudeCodeGuideContent(name)))]);

/** ours: exactly a version Toolroll wrote. edited: ours, with the person's changes. foreign: not ours at all. */
function skillOwnership(path: string): "ours" | "edited" | "foreign" {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 2_000_000) return "foreign";
  const content = readFileSync(path, "utf8");
  const marked = content.startsWith("---\nname: toolroll\n") && [OPERATOR_SKILL_MARK, CLAUDE_CODE_MANAGED_MARK, MANAGED_MARK].some(mark => content.includes(mark));
  if (!marked) return "foreign";
  return KNOWN_SKILLS.has(skillFingerprint(content)) ? "ours" : "edited";
}

/** Guide copies an older `skills install --claude-code` left beside SKILL.md, exactly as it wrote them. */
function oldGuideCopies(folder: string): string[] {
  return CLAUDE_CODE_GUIDES.map(name => join(folder, `${name}.md`)).filter(path => {
    try {
      const entry = lstatSync(path);
      return !entry.isSymbolicLink() && entry.isFile() && entry.size <= 2_000_000 && KNOWN_GUIDES.has(guideHash(readFileSync(path, "utf8")));
    } catch {
      return false;
    }
  });
}

export type SkillStep = {
  agent: OnboardAgent;
  path: string;
  /** create/replace/remove change the file; current and absent change nothing; not-ours and edited refuse. */
  action: "create" | "replace" | "current" | "remove" | "absent" | "not-ours" | "edited";
  /** Old guide copies of ours that go with it. */
  alsoRemove: string[];
};

/** What install (or --remove) would do, without writing anything. */
export function planOperatorSkill(agents: readonly OnboardAgent[], options: { home: string; env: Record<string, string | undefined>; version: string; remove: boolean }): SkillStep[] {
  return agents.map(agent => {
    const path = operatorSkillPath(agent, options.home, options.env);
    const folder = join(path, "..");
    let folderIsReal = true;
    try {
      const entry = lstatSync(folder);
      folderIsReal = entry.isDirectory() && !entry.isSymbolicLink();
    } catch {
      return { agent, path, action: options.remove ? "absent" : "create", alsoRemove: [] };
    }
    if (!folderIsReal) return { agent, path, action: "not-ours", alsoRemove: [] };
    const alsoRemove = oldGuideCopies(folder);
    if (!lstatExists(path)) {
      return { agent, path, action: options.remove ? (alsoRemove.length > 0 ? "remove" : "absent") : "create", alsoRemove };
    }
    const ownership = skillOwnership(path);
    if (ownership !== "ours") return { agent, path, action: ownership === "edited" ? "edited" : "not-ours", alsoRemove: [] };
    if (options.remove) return { agent, path, action: "remove", alsoRemove };
    const current = readFileSync(path, "utf8") === operatorSkillContent(options.version);
    return { agent, path, action: current && alsoRemove.length === 0 ? "current" : "replace", alsoRemove };
  });
}

function lstatExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** Carry out a plan. Steps that are not ours, current, or absent change nothing. */
export function applyOperatorSkill(steps: readonly SkillStep[], version: string): { wrote: string[]; removed: string[] } {
  const wrote: string[] = [];
  const removed: string[] = [];
  for (const step of steps) {
    const folder = join(step.path, "..");
    if (step.action === "create" || step.action === "replace") {
      mkdirSync(folder, { recursive: true });
      writeFileSync(step.path, operatorSkillContent(version));
      wrote.push(step.path);
    }
    if (step.action === "create" || step.action === "replace" || step.action === "remove") {
      for (const path of step.alsoRemove) {
        unlinkSync(path);
        removed.push(path);
      }
    }
    if (step.action === "remove") {
      if (lstatExists(step.path)) {
        unlinkSync(step.path);
        removed.push(step.path);
      }
      if (readdirSync(folder).length === 0) rmdirSync(folder);
    }
  }
  return { wrote, removed };
}

/** How to sign in: the account, and the saved login file when one still works. Never the password. */
export type HandoffLogin = { account: string | null; file: string | null };

export type Handoff = {
  console: string;
  /** How to start the console when it is not running. */
  start: string;
  /** null while there is no account yet. */
  login: HandoffLogin | null;
  phone: string;
  next: readonly string[];
};

export const NEXT_THINGS = ["queue these bugs overnight", "what needs me?", "open the result"] as const;

export function buildHandoff(input: { url: string; login: HandoffLogin | null }): Handoff {
  return {
    console: input.url,
    start: "toolroll up",
    login: input.login,
    phone: "Open the console on your phone over your tailnet, or pair Telegram in Settings → Telegram with the /pair code it shows.",
    next: NEXT_THINGS,
  };
}

export function handoffLines(handoff: Handoff): string[] {
  const login = handoff.login === null
    ? "no account yet; `toolroll up` creates one"
    : handoff.login.file === null
      ? `${handoff.login.account ?? "your account"} — sign in with your password`
      : `${handoff.login.account ?? "the account"} — the password is in ${handoff.login.file}`;
  return [
    "Toolroll is ready.",
    `  console   ${handoff.console}`,
    `  login     ${login}`,
    `  phone     ${handoff.phone}`,
    `  say next  ${handoff.next.map(one => `"${one}"`).join(" · ")}`,
  ];
}

/** The account name from a saved login file, never its password. */
export function loginAccount(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const cut = raw.indexOf(" ");
    return cut > 0 ? raw.slice(0, cut) : null;
  } catch {
    return null;
  }
}

export type AgentReport = { agent: OnboardAgent; name: string; state: ProviderConnection["state"]; words: string; plan?: string };

export function agentReport(agent: OnboardAgent, connection: ProviderConnection): AgentReport {
  return { agent, name: AGENT_NAMES[agent], state: connection.state, words: connectionWords(connection), ...(connection.plan === undefined ? {} : { plan: connection.plan }) };
}

export type OnboardIo = {
  write: (line: string) => void;
  json: boolean;
  yes: boolean;
  remove: boolean;
  /** --agent, as typed: a comma list of claude and codex. */
  agentFlag: string | undefined;
  url: string;
  login: HandoffLogin | null;
  home: string;
  /** Where Toolroll leases its own worktrees: never a project. */
  worktrees: string;
  env: Record<string, string | undefined>;
  version: string;
  cwd: string;
  /** A person at a terminal who can be asked y/N. */
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** The repository containing cwd: its top folder, and its main checkout (the same folder unless cwd is in a linked
   * worktree). null outside one. */
  findRepo: (cwd: string) => Promise<{ top: string; main: string } | null>;
  /** Whether a repository is already a project. */
  enrolled: (repo: string) => Promise<boolean>;
  /** Add a repository as a project, as Projects → add does. */
  enroll: (repo: string) => Promise<{ ok: true; added: boolean } | { ok: false; message: string }>;
  checkConnection: (agent: OnboardAgent) => Promise<ProviderConnection>;
  /** Whether the project can open pull requests at Complete, in one line: on, the one command that turns it on, or
   * what to fix first. Turning it on stays a person's password step. */
  pullRequests?: (repo: string) => Promise<string>;
  /** --starter, as typed: a comma list of starter flow ids to switch on. */
  starterFlag?: string | undefined;
  /** The project's starter flows, and switching one on — its trigger and zones. */
  starters?: { list: (repo: string) => Promise<StarterView[]>; switchOn: (repo: string, id: string) => Promise<SwitchedOn> };
};

export type StarterAnswer = { id: string; name: string; summary: string; does: string[]; never: string; state: "on" | "switched-on" | "off" | "unavailable" | "failed"; flow?: number; said?: string };

/** Offer each starter flow: switch on the ones --starter names, or ask one yes each at a terminal. */
async function offerStarters(io: OnboardIo, repo: string): Promise<StarterAnswer[] | { usage: string }> {
  if (io.starters === undefined) return [];
  const list = await io.starters.list(repo);
  const named = io.starterFlag === undefined ? null : io.starterFlag.split(",").map(one => one.trim()).filter(one => one !== "");
  const unknown = named?.filter(one => !list.some(starter => starter.id === one)) ?? [];
  if (named !== null && (named.length === 0 || unknown.length > 0)) return { usage: `--starter takes ${list.map(one => one.id).join(", ")}` };
  const answers: StarterAnswer[] = [];
  for (const one of list) {
    const base = { id: one.id, name: one.name, summary: one.summary, does: one.does, never: one.never };
    if (one.on !== null) { answers.push({ ...base, state: "on", flow: one.on.flow }); continue; }
    if (one.blocked !== null) { answers.push({ ...base, state: "unavailable", said: one.blocked }); continue; }
    const wanted = named !== null ? named.includes(one.id) : io.interactive && !io.json && await io.confirm(`Switch on ${one.name}? ${one.summary} ${one.never} [y/N]`);
    if (!wanted) { answers.push({ ...base, state: "off" }); continue; }
    const switched = await io.starters.switchOn(repo, one.id);
    answers.push(switched.ok ? { ...base, state: switched.already ? "on" : "switched-on", flow: switched.flow } : { ...base, state: "failed", said: switched.said });
  }
  return answers;
}

function starterLines(answers: readonly StarterAnswer[]): string[] {
  return answers.map((one, index) => {
    const head = index === 0 ? "starters " : "         ";
    switch (one.state) {
      case "on": return `${head} ${one.name}: on`;
      case "switched-on": return `${head} ${one.name}: switched on`;
      case "unavailable": return `${head} ${one.name}: ${one.said}`;
      case "failed": return `${head} ${one.name}: ${one.said}`;
      case "off": return `${head} ${one.name}: ${one.summary} ${one.never} Switch on: toolroll onboard --starter ${one.id}`;
    }
  });
}

type SkillAnswer = { state: "written" | "current" | "needs-yes" | "declined" | "not-ours" | "edited" | "removed" | "absent"; files: SkillStep[]; wrote: string[]; removed: string[] };

type ProjectAnswer =
  | { state: "none" }
  | { state: "refused"; path: string; message: string }
  | { state: "added" | "already" | "needs-yes" | "declined"; path: string }
  | { state: "failed"; path: string; message: string };

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/** Why a found repository cannot be the project, or null when it can. */
export function projectRefusal(found: { top: string; main: string }, where: { cwd: string; home: string; worktrees: string }): string | null {
  const worktrees = real(where.worktrees);
  if ([where.cwd, found.top, found.main].some(path => within(real(path), worktrees))) {
    return `${found.top} is one of Toolroll's own worktrees, not a project: run onboard inside your own checkout`;
  }
  const home = real(where.home);
  if (real(found.main) === home || real(found.top) === home) {
    return `${home} is your home folder, not a project: run onboard inside the repository you want to hand off`;
  }
  return null;
}

/** Returns the exit code: 0 done, 2 usage, 3 a refusal to answer. */
export async function runOnboard(io: OnboardIo): Promise<number> {
  const command = "onboard";
  const refuse = (reason: string, message: string, code: number, extra: Record<string, unknown> = {}): number => {
    io.write(io.json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
    return code;
  };

  let agents: OnboardAgent[];
  if (io.agentFlag !== undefined) {
    const asked = io.agentFlag.split(",").map(one => one.trim()).filter(one => one !== "");
    const unknown = asked.filter(one => !(ONBOARD_AGENTS as readonly string[]).includes(one));
    if (asked.length === 0 || unknown.length > 0) return refuse("usage", "--agent takes claude, codex, or claude,codex", 2);
    agents = [...new Set(asked as OnboardAgent[])];
  } else {
    agents = detectAgents(io.home, io.env);
  }

  // The skill: validate every file first.
  const steps = planOperatorSkill(agents, { home: io.home, env: io.env, version: io.version, remove: io.remove });
  const changes = steps.filter(step => step.action === "create" || step.action === "replace" || step.action === "remove");
  const foreign = steps.filter(step => step.action === "not-ours" || step.action === "edited");
  const skillChanges = foreign.length === 0 && changes.length > 0;

  // The project: the main checkout of the repository onboard runs in, never --remove's business.
  let project: ProjectAnswer = { state: "none" };
  if (!io.remove) {
    const found = await io.findRepo(io.cwd);
    if (found !== null) {
      const refusal = projectRefusal(found, { cwd: io.cwd, home: io.home, worktrees: io.worktrees });
      if (refusal !== null) project = { state: "refused", path: found.main, message: refusal };
      else project = { state: (await io.enrolled(found.main)) ? "already" : "needs-yes", path: found.main };
    }
  }
  const projectChange = project.state === "needs-yes";

  // Then ask once for everything that writes, then write.
  let consent = false;
  if (skillChanges || projectChange) {
    const parts = [
      ...(projectChange ? [`add ${(project as { path: string }).path} as a project`] : []),
      ...(skillChanges ? [`${io.remove ? "remove" : "write"} ${changes.map(step => step.path).join(" and ")}`] : []),
    ];
    const question = `${parts.join(" and ").replace(/^./, first => first.toUpperCase())}? [y/N]`;
    consent = io.yes || (io.interactive && !io.json && (await io.confirm(question)));
  }
  const unconfirmed = io.interactive && !io.json && !io.yes ? "declined" : "needs-yes";

  let skill: SkillAnswer;
  if (foreign.length > 0) {
    skill = { state: foreign.some(step => step.action === "not-ours") ? "not-ours" : "edited", files: steps, wrote: [], removed: [] };
  } else if (!skillChanges) {
    skill = { state: io.remove ? "absent" : "current", files: steps, wrote: [], removed: [] };
  } else if (!consent) {
    skill = { state: unconfirmed, files: steps, wrote: [], removed: [] };
  } else {
    const done = applyOperatorSkill(steps, io.version);
    skill = { state: io.remove ? "removed" : "written", files: steps, ...done };
  }
  const skillLine = (): string => {
    const where = (list: readonly SkillStep[]) => list.map(step => step.path).join(", ");
    const nothing = io.remove ? "removed" : "written";
    switch (skill.state) {
      case "written": return `skill     wrote ${skill.wrote.join(", ")}`;
      case "removed": return `skill     removed ${skill.removed.join(", ")}`;
      case "current": return `skill     up to date: ${where(steps)}`;
      case "absent": return "skill     not installed; nothing to remove";
      case "not-ours": return `skill     ${where(foreign)} ${foreign.length === 1 ? "is" : "are"} not Toolroll's, so nothing was ${nothing}`;
      case "edited": return `skill     ${where(foreign)} ${foreign.length === 1 ? "has your edits, so it was" : "have your edits, so they were"} left as is`;
      case "declined": return `skill     nothing ${nothing}`;
      case "needs-yes": return `skill     not ${nothing} yet: run again with --yes to ${io.remove ? "remove" : "write"} ${where(changes)}`;
    }
  };
  const skillData = { state: skill.state, files: skill.files.map(step => ({ agent: step.agent, path: step.path, action: step.action })), wrote: skill.wrote, removed: skill.removed };

  if (io.remove) {
    if (skill.state === "not-ours" || skill.state === "edited") return refuse(skill.state, skillLine().replace(/^skill\s+/, ""), 3, { skill: skillData });
    if (skill.state === "needs-yes" || skill.state === "declined") {
      return refuse("unconfirmed", skillLine().replace(/^skill\s+/, ""), 3, { skill: skillData });
    }
    io.write(io.json ? envelopeJson({ ok: true, command, skill: skillData }) : skillLine());
    return 0;
  }

  if (project.state === "needs-yes") {
    if (!consent) project = { state: unconfirmed, path: project.path };
    else {
      const enrolled = await io.enroll(project.path);
      project = enrolled.ok ? { state: enrolled.added ? "added" : "already", path: project.path } : { state: "failed", path: project.path, message: enrolled.message };
    }
  }
  const reports = await Promise.all(ONBOARD_AGENTS.map(async agent => agentReport(agent, await io.checkConnection(agent))));
  const handoff = buildHandoff({ url: io.url, login: io.login });
  const mcp = agents.map(agent => ({ agent, command: mcpLine(agent) }));

  const projectData = project.state === "added" || project.state === "already" ? { path: project.path, added: project.state === "added" } : null;
  const pullRequests = projectData === null || io.pullRequests === undefined ? null : await io.pullRequests(projectData.path);
  const offered = projectData === null ? [] : await offerStarters(io, projectData.path);
  if (!Array.isArray(offered)) return refuse("usage", offered.usage, 2);
  const projectProblem = (() => {
    switch (project.state) {
      case "none": return "not inside a git repository";
      case "refused": return project.message;
      case "failed": return `${project.path} could not be added — ${project.message}`;
      case "needs-yes": return `not added yet: run again with --yes to add ${project.path}`;
      case "declined": return `${project.path} not added`;
      default: return null;
    }
  })();
  if (io.json) {
    io.write(envelopeJson({
      ok: true,
      command,
      project: projectData,
      ...(projectProblem === null ? {} : { projectProblem }),
      ...(pullRequests === null ? {} : { pullRequests }),
      ...(offered.length === 0 ? {} : { starters: offered.map(one => ({ ...one, ...(one.state === "off" ? { command: `toolroll onboard --starter ${one.id}` } : {}) })) }),
      agents: reports,
      skill: skillData,
      mcp,
      handoff,
    }));
    return 0;
  }
  const projectLine = projectData !== null
    ? `project   ${projectData.path} — ${projectData.added ? "added" : "already added"}`
    : project.state === "none" ? "project   none added: run onboard inside the repository you want to hand off" : `project   ${projectProblem}`;
  io.write([
    projectLine,
    ...(pullRequests === null ? [] : [`pull requests ${pullRequests}`]),
    ...starterLines(offered),
    `agents    ${reports.map(one => `${one.name}: ${[one.words, one.plan].filter(Boolean).join(" · ")}`).join("; ")}`,
    skillLine(),
    ...mcp.map((one, index) => `${index === 0 ? "tools    " : "         "} ${one.command}   (add Toolroll as tools; not run)`),
    "",
    ...handoffLines(handoff),
  ].join("\n"));
  return 0;
}
