/** Shared, exact-state actions. Models may prepare; only the existing human
 * confirmation door executes. Protected actions use a one-use review receipt. */
import { withActor } from "./actor.js";
import { publicChatText } from "./chat-display.js";
import { gateWords } from "./approval-policy.js";
import { createHash, randomBytes } from "node:crypto";
import { verifiedAuthor, type Store } from "./store.js";
import {
  isVerifiedApprover,
  reproveApprover,
  type VerifiedApprover,
} from "./principal.js";
import {
  changeSkills,
  importSkill,
  skillsView,
  skillsVersion,
  testSkill,
  validateSkill,
  type SkillFile,
} from "./project-skills.js";
import {
  changeKnowledge,
  knowledgeVersion,
  knowledgeView,
  type KnowledgeDraft,
} from "./project-knowledge.js";
import {
  approve,
  authenticateApprover,
  describeScope,
  scopeAuthorityOf,
  type ExecutionProfile,
} from "./scope.js";
import { readVerifiedArtifact, scanForSecrets } from "./evidence.js";
import { readAuthModeStrict } from "./keys.js";
import { parseProof } from "./proof.js";
import { acceptAndCompleteAsOperator, assignmentOf } from "./assignment.js";
import { getDecision, recordDecision, retireDecision } from "./project-memory.js";
import { resumeTaskStop, taskControlOf } from "./task-control.js";
import { addToolTo, catalogTool, projectToolsOf, removeToolFrom, toolCommandLine, validateToolSpec, type ToolSpec } from "./project-tools.js";
import { deciderOf, FLOW_KIND_WORDS, flowDigest, flowTerms, replyTarget, validateFlowDefinition, type FlowDefinition, type FlowStage } from "./flows.js";
import { saveScript, scriptDigest, validateScript } from "./flow-scripts.js";
import { addCardToFlow, advanceFlows, cancelFlowCard, crossProjectProblem, decideFlowCard, flowCardHref, flowCardText, flowDefinitionOf, moveCardInFlow } from "./flow-engine.js";
import { chooseFlowCard, flowPersonOf } from "./flow-send.js";
import type { FlowCardRow, FlowRow, FlowTriggerRow } from "./store.js";
import { assignFlowCard, commentOnFlowCard, flowPeople, mentionsIn, watchFlowCard } from "./flow-people.js";
import { addFlowTriggerTo, describeTrigger, readLinearKey, removeFlowTrigger, scheduleFromWords, takesDeliveries, triggerConfigOf, validateTriggerConfig } from "./flow-triggers.js";
import { describeSchedule, parseSchedule } from "./routine.js";
import { dirname } from "node:path";
import { handleOf, parseSoul, SOUL_CHARS, TEAMMATE_TEMPLATES, teammateLabel } from "./teammates.js";
import { createTeammateFrom, labelOf, nameOf, renamedSoul, saveSoul, setTeammateState } from "./teammate-admin.js";
import { cleanMemory, editMemory, forgetMemory, tellTeammate } from "./teammate-memory.js";
import { addRoutine, removeRoutine, routineSchedule, routinesOf } from "./teammate-desk.js";
import { requestUndo, undoFor } from "./teammate-week.js";
import { kitInstalled, kitOf, KITS, setUpKitNow } from "./kits.js";
import { starterFlowOf, starterOf, startersFor, starterTerms, STARTER_FLOWS, switchOnStarter } from "./flow-starters.js";
import { answerTeammateQuestion } from "./teammate-work.js";
import { callWords, checkRule, defaultRule, grantListed, revokeTool, ruleWords, setToolRules } from "./teammate-tools.js";
import { aboutYouOf, checkAboutYouLine, saveAboutYou, withAboutYouLine } from "./lead-about.js";

/** A tool from the lead's card: a common tool by its id, or the operator's own program or address. */
function toolSpecFromRequest(input: Record<string, unknown>): ToolSpec {
  if (input["catalog"] !== undefined) {
    const chosen = catalogTool(String(input["catalog"]));
    if (chosen === null) throw Error("Choose a tool from get_project_tools' common list.");
    const { label: _label, ...spec } = chosen;
    return spec;
  }
  const secrets = Array.isArray(input["secrets"]) ? input["secrets"].map((one) => String(one)) : [];
  const url = typeof input["url"] === "string" ? input["url"] : null;
  return validateToolSpec({
    name: input["name"], transport: url === null ? "stdio" : "http", command: input["command"], args: input["args"] ?? [], url,
    secrets: secrets.map((name) => ({ name, optional: false })), bearer: url === null ? null : secrets[0] ?? null, about: input["about"],
  });
}

export const CHAT_ACTIONS = {
  skill_import: { label: "Add skill", protected: true, password: false },
  skill_enable: { label: "Enable skill", protected: false, password: false },
  skill_disable: { label: "Disable skill", protected: false, password: false },
  skill_restore: { label: "Restore skills", protected: false, password: false },
  skill_test: { label: "Test skill", protected: false, password: false },
  knowledge_instructions: {
    label: "Save project instructions",
    protected: false,
    password: false,
  },
  knowledge_save: {
    label: "Save reference",
    protected: false,
    password: false,
  },
  knowledge_remove: {
    label: "Remove reference",
    protected: false,
    password: false,
  },
  knowledge_restore: {
    label: "Restore knowledge",
    protected: false,
    password: false,
  },
  // A tool runs on this computer for every build the operator approves from now on: the password screen, like an approval.
  tool_add: { label: "Add tool", protected: true, password: true },
  tool_remove: { label: "Remove tool", protected: false, password: false },
  // Flows: a drawing and cards on it. Any work a card files is an ordinary task under the usual approvals.
  flow_create: { label: "Create flow", protected: false, password: false },
  // A starter flow: its zones and its trigger, switched on with one yes (flow-starters.ts).
  flow_starter: { label: "Switch on", protected: false, password: false },
  flow_edit: { label: "Save flow", protected: false, password: false },
  flow_card_add: { label: "Add card", protected: false, password: false },
  flow_card_move: { label: "Move card", protected: false, password: false },
  flow_card_approve: { label: "Approve", protected: false, password: false },
  flow_card_send_back: { label: "Send back", protected: false, password: false },
  flow_card_choose: { label: "Choose", protected: false, password: false },
  flow_card_cancel: { label: "Cancel card", protected: false, password: false },
  flow_card_comment: { label: "Comment", protected: false, password: false },
  flow_card_assign: { label: "Set owner", protected: false, password: false },
  flow_card_watch: { label: "Follow card", protected: false, password: false },
  flow_script_save: { label: "Save script", protected: false, password: false },
  flow_trigger_add: { label: "Add trigger", protected: false, password: false },
  flow_trigger_pause: { label: "Pause trigger", protected: false, password: false },
  flow_trigger_resume: { label: "Turn trigger on", protected: false, password: false },
  flow_trigger_remove: { label: "Remove trigger", protected: false, password: false },
  teammate_create: { label: "Add teammate", protected: false, password: false },
  teammate_soul: { label: "Update soul file", protected: false, password: false },
  teammate_state: { label: "Change teammate", protected: false, password: false },
  teammate_note: { label: "Tell teammate", protected: false, password: false },
  teammate_answer: { label: "Answer teammate", protected: false, password: false },
  teammate_tools: { label: "Change teammate's tools", protected: false, password: false },
  teammate_memory: { label: "Change teammate's memory", protected: false, password: false },
  teammate_routine: { label: "Change teammate's routines", protected: false, password: false },
  teammate_undo: { label: "Undo teammate's call", protected: false, password: false },
  kit_setup: { label: "Set up kit", protected: false, password: false },
  decision_record: { label: "Record decision", protected: false, password: false },
  decision_retire: { label: "Retire decision", protected: false, password: false },
  // What the owner's own lead knows about them: theirs alone, in no project (lead-about.ts).
  lead_about_you: { label: "Remember", protected: false, password: false },
  scope_approve: { label: "Approve work", protected: true, password: true },
  result_accept: { label: "Accept and finish", protected: true, password: false },
  task_cancel: { label: "Cancel task", protected: true, password: false },
  task_resume: { label: "Resume task", protected: true, password: true },
} as const;
export type ChatAction = keyof typeof CHAT_ACTIONS;
/** Protected actions a paired phone may confirm behind its own explicit
 * yes/cancel challenge instead of the console's secure screen. Password
 * actions and long or redacted terms never qualify. */
export const CHALLENGE_ACTIONS: ReadonlySet<ChatAction> = new Set<ChatAction>(["result_accept"]);
/** Actions about the person themselves, in no project: their card carries no project (repo ""). */
export const OWNER_ACTIONS: ReadonlySet<ChatAction> = new Set<ChatAction>(["lead_about_you"]);
export function isChatAction(value: unknown): value is ChatAction {
  return typeof value === "string" && Object.hasOwn(CHAT_ACTIONS, value);
}
export type SharedAction = {
  operation: ChatAction;
  request: Record<string, unknown>;
  repo: string;
  title: string;
  terms: string[];
  stamp: string;
  state: Record<string, unknown>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const CHAT_ACTION_FIELDS: Record<ChatAction, readonly string[]> = {
  skill_import: ["repo", "content", "files"],
  skill_enable: ["repo", "version"],
  skill_disable: ["repo", "version"],
  skill_restore: ["repo", "restore"],
  skill_test: ["repo", "version", "sample", "nonce"],
  knowledge_instructions: ["repo", "instructions"],
  knowledge_save: ["repo", "title", "content", "id"],
  knowledge_remove: ["repo", "id"],
  knowledge_restore: ["repo", "restore"],
  tool_add: ["repo", "catalog", "name", "command", "args", "url", "secrets", "about"],
  tool_remove: ["repo", "name"],
  flow_create: ["repo", "name", "definition", "trigger"],
  flow_starter: ["repo", "starter"],
  flow_edit: ["flow", "name", "definition"],
  flow_card_add: ["flow", "title", "description", "zone"],
  flow_card_move: ["card", "zone"],
  flow_card_approve: ["card", "note"],
  flow_card_send_back: ["card", "note"],
  flow_card_choose: ["card", "choice", "note"],
  flow_card_cancel: ["card"],
  flow_card_comment: ["card", "note"],
  flow_card_assign: ["card", "owner"],
  flow_card_watch: ["card", "watching"],
  flow_script_save: ["repo", "script"],
  flow_trigger_add: ["flow", "trigger"],
  flow_trigger_pause: ["trigger"],
  flow_trigger_resume: ["trigger"],
  flow_trigger_remove: ["trigger"],
  teammate_create: ["repo", "template", "name", "soul"],
  teammate_soul: ["teammate", "soul"],
  teammate_state: ["teammate", "state"],
  teammate_note: ["teammate", "note"],
  teammate_answer: ["question", "choice", "text"],
  teammate_tools: ["teammate", "tool", "change", "action", "use", "limitField", "limitOver", "undoWith"],
  teammate_memory: ["teammate", "memory", "change", "text"],
  teammate_routine: ["teammate", "change", "routine", "schedule", "text"],
  teammate_undo: ["teammate", "call"],
  kit_setup: ["repo", "kit"],
  decision_record: ["repo", "claim", "why", "supersedes", "source"],
  decision_retire: ["repo", "decision", "reason"],
  lead_about_you: ["line", "replaces"],
  scope_approve: ["task"],
  result_accept: ["task", "run"],
  task_cancel: ["task"],
  task_resume: ["task", "run"],
};
const nonceHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function requireActor(store: Store, who: VerifiedApprover, repo: string, operation?: ChatAction) {
  if (!store.schemaCurrent())
    throw Error(
      "The running build changed. Reload before proposing an action.",
    );
  // An action about the person themselves names no project; every other one names one they can reach.
  const owned = repo === "" && operation !== undefined && OWNER_ACTIONS.has(operation);
  if (
    !isVerifiedApprover(who) ||
    !reproveApprover(store, who).ok ||
    (!owned && (!who.repos.includes(repo) || !store.accountCanAccess(who.name, repo)))
  )
    throw Error("This project is outside your current access.");
}
function text(
  input: Record<string, unknown>,
  key: string,
  cap: number,
  optional = false,
): string {
  const value = input[key];
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    value.length > cap ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufffd]/.test(
      value,
    ) ||
    scanForSecrets(value).length
  )
    throw Error(
      `Check the ${key} field. Credentials cannot be included in chat actions.`,
    );
  return value;
}
function integer(input: Record<string, unknown>, key: string): number {
  if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1)
    throw Error(`Choose a valid ${key}.`);
  return Number(input[key]);
}
function runtimeTerms(profile: ExecutionProfile): string {
  const permission =
    profile.provider === "claude"
      ? profile.permissionArgv === "bypassPermissions"
        ? "Full access: tools run without asking for permission (--dangerously-skip-permissions)."
        : profile.permissionArgv === "auto"
          ? "Auto permissions: routine commands and edits proceed; risky actions stop."
          : "Edits proceed; commands that ask for permission are denied."
      : profile.provider === "gemini"
        ? profile.approvalArgv === "yolo"
          ? "Full access: every tool is approved automatically (--approval-mode yolo)."
          : "Edits are approved automatically; other tools are refused."
        : profile.sandboxMode === "danger-full-access"
          ? "Full access: approvals and sandbox are bypassed (--dangerously-bypass-approvals-and-sandbox)."
          : "Commands use the workspace-write sandbox.";
  return `${profile.provider} · ${profile.model}\n${permission}\n${profile.timeoutSeconds} seconds ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}${profile.provider === "claude" ? `; at most ${profile.maxTurns} turns` : ""}. Repairs: ${profile.repairModel}, ${profile.repairTimeoutSeconds} seconds${profile.provider === "claude" ? `, at most ${profile.repairMaxTurns} turns` : ""}.`;
}
function resultOf(store: Store, task: string, run: number, repo: string) {
  const ref = store.lookupRef(task)!;
  const current = store
    .runsFor(ref.id)
    .find(
      (one) =>
        one.finishedAt !== null &&
        ["builder", "repair", "scout"].includes(one.role),
    );
  if (!current || current.id !== run || ref.repo !== repo)
    throw Error("This result changed. Review the current result.");
  return current;
}
/** The flow (and card) a flow action names; its project decides who may act. */
function flowTargetOf(store: Store, input: Record<string, unknown>): { flow: FlowRow; definition: FlowDefinition; card: FlowCardRow | null; trigger: FlowTriggerRow | null } {
  const card = input["card"] === undefined ? null : store.getFlowCard(integer(input, "card"));
  if (input["card"] !== undefined && (card === null || card.state !== "active")) throw Error("That card isn't active in a flow any more.");
  const trigger = typeof input["trigger"] === "number" ? store.getFlowTrigger(integer(input, "trigger")) : null;
  if (typeof input["trigger"] === "number" && (trigger === null || trigger.state === "removed")) throw Error("That trigger was removed.");
  const flow = store.getFlow(card?.flow ?? trigger?.flow ?? integer(input, "flow"));
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (flow === null || flow.state !== "active") throw Error("That flow isn't in your projects.");
  if (definition === null) throw Error("This flow's drawing can't be read. Save it again on its canvas.");
  return { flow, definition, card, trigger };
}
/** Where this installation keeps its files: beside the database. */
function configDirOf(store: Store): string | null {
  const file = store.databaseFile();
  return file === null ? null : dirname(file);
}
/** A zone named by id or by its title. */
function flowZoneOf(definition: FlowDefinition, input: Record<string, unknown>, fallback: string | null): FlowStage {
  const named = input["zone"] === undefined ? fallback : text(input, "zone", 60).trim();
  const stage = named === null ? undefined : definition.stages.find(one => one.id === named || one.title.toLowerCase() === named.toLowerCase());
  if (stage === undefined) throw Error(`This flow has no zone called ${named}.`);
  return stage;
}
/** A flow drawing from chat: whole, keyless, plain, and every named decider can decide on the project. */
function flowDrawingOf(store: Store, input: Record<string, unknown>, repo: string): FlowDefinition {
  const definition = validateFlowDefinition(input["definition"]);
  const words = JSON.stringify(definition);
  if (scanForSecrets(words).length > 0 || /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufffd]/.test(words)) throw Error("Check the steps. Credentials cannot be included in chat actions.");
  for (const stage of definition.stages)
    if (stage.approver !== null && !(store.listApprovers().some(one => one.name === stage.approver) && store.accountCanAccess(stage.approver, repo)))
      throw Error(`No one called ${stage.approver} can approve on this project. Name someone who can, or let anyone who approves decide.`);
  return definition;
}
const quoted = (value: string) => `“${value}”`;
/** No writes, including at preview. Store-derived snapshots are never accepted
 * from a model. Rebuilding the same request before execution catches changes. */
export function prepareSharedAction(
  store: Store,
  who: VerifiedApprover,
  operation: ChatAction,
  input: Record<string, unknown>,
  root?: string,
  now = new Date(),
): SharedAction {
  if (!isChatAction(operation)) throw Error("Choose an available action.");
  const allowed = CHAT_ACTION_FIELDS[operation];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Error("This action contains an unsupported field.");
  if (operation === "lead_about_you") {
    // The owner's own note: the card shows the line, and the line it replaces beside it.
    const checked = checkAboutYouLine(input["line"]);
    if (!checked.ok) throw Error(checked.message);
    const lines = aboutYouOf(store, who.name);
    const replaces = input["replaces"] === undefined || input["replaces"] === 0 ? 0 : integer(input, "replaces");
    const next = withAboutYouLine(lines, checked.line, replaces);
    if (!next.ok) throw Error(next.message);
    requireActor(store, who, "", operation);
    const request = { line: checked.line, ...(replaces === 0 ? {} : { replaces }) };
    const terms = replaces === 0
      ? [checked.line, "Your lead keeps this about you in every project. Change it in Settings → Lead."]
      : [`Was: ${lines[replaces - 1]}`, `Now: ${checked.line}`, "Replaces that line in what your lead knows about you. Change it in Settings → Lead."];
    // An added line goes on the end, so it holds whatever else changed; a replacing card holds only while the line
    // it replaces is still that line.
    const state = replaces === 0 ? {} : { was: lines[replaces - 1] };
    const title = replaces === 0 ? "Remember about you" : "Update what your lead knows about you";
    const stamp = hash({ operation, request, repo: "", state, terms, actor: who.name, generation: who.generation, ceiling: who.ceilingDigest });
    return { operation, request, repo: "", title, terms, stamp, state };
  }
  const task =
    operation.startsWith("skill_") || operation.startsWith("knowledge_") || operation.startsWith("decision_") || operation.startsWith("tool_") || operation.startsWith("flow_") || operation.startsWith("teammate_") || operation.startsWith("kit_")
      ? null
      : text(input, "task", 64);
  const flowTarget = operation.startsWith("flow_") && operation !== "flow_create" && operation !== "flow_script_save" && operation !== "flow_starter" ? flowTargetOf(store, input) : null;
  // v92: a teammate names its project; a question names it through its card's flow.
  const mateTarget = operation.startsWith("teammate_") && operation !== "teammate_create" && operation !== "teammate_answer" ? store.getTeammate(integer(input, "teammate")) : null;
  if (mateTarget !== null && mateTarget.state === "removed") throw Error("That teammate is off the team.");
  const questionTarget = operation === "teammate_answer" ? store.teammateQuestion(integer(input, "question")) : null;
  const questionFlow = questionTarget === null ? null : store.getFlow(store.getFlowCard(questionTarget.card)?.flow ?? -1);
  if (operation === "teammate_answer" && (questionTarget === null || questionFlow === null)) throw Error("That question isn't open any more.");
  const repo =
    flowTarget !== null ? flowTarget.flow.repo : mateTarget !== null ? mateTarget.repo : questionFlow !== null ? questionFlow.repo : task === null ? text(input, "repo", 4096) : store.lookupRef(task)?.repo;
  if (!repo) throw Error("Choose an available project.");
  requireActor(store, who, repo);
  const request = structuredClone(input),
    terms: string[] = [];
  let state: Record<string, unknown>,
    title = CHAT_ACTIONS[operation].label as string;
  if (operation.startsWith("skill_")) {
    const view = skillsView(store, repo, who.name);
    state = {
      identity: view.identity,
      revision: view.revision,
      selection: view.selection,
      library: view.library.map((one) => one.sha),
    };
    if (operation === "skill_import") {
      if (input["files"] !== undefined && input["content"] !== undefined)
        throw Error("Choose one source for this skill.");
      const files =
        input["files"] === undefined
          ? [
              {
                path: "SKILL.md",
                base64: Buffer.from(text(input, "content", 12000)).toString(
                  "base64",
                ),
              },
            ]
          : (input["files"] as SkillFile[]);
      const skill = validateSkill(files, "Chat import");
      request["files"] = skill.files;
      delete request["content"];
      title = `Add ${skill.name}`;
      terms.push(
        "Adds this version to your library. It will not be enabled automatically.",
        ...skill.files.map(
          (file) =>
            `${file.path}\n${Buffer.from(file.base64, "base64").toString("utf8")}`,
        ),
      );
    } else if (operation === "skill_restore") {
      const restore = integer(input, "restore");
      const selection = skillsVersion(store, repo, who.name, restore);
      state["restore"] = selection;
      terms.push(
        `Restore skills version ${restore}. Future runs use this selection; existing runs keep their saved skills.`,
        ...Object.entries(selection).map(
          ([name, choice]) =>
            `${name}: ${choice.enabled ? "enabled" : "disabled"}\nVersion ${choice.sha}`,
        ),
      );
    } else {
      const version = text(input, "version", 64);
      const matches = /^[a-f0-9]{20,64}$/.test(version)
        ? view.library.filter((one) => one.sha.startsWith(version))
        : [];
      if (matches.length !== 1)
        throw Error("Choose an exact skill version from get_skills.");
      const skill = matches[0]!;
      request["version"] = skill.sha;
      title = `${CHAT_ACTIONS[operation].label}: ${skill.name}`;
      terms.push(
        `Version ${view.library.filter((one) => one.sha.startsWith(skill.sha.slice(0, 20))).length === 1 ? skill.sha.slice(0, 20) : skill.sha}`,
        operation === "skill_test"
          ? `Sample request:\n${text(input, "sample", 800)}\nCreates a report task under the existing approval rules.`
          : "Changes skills for future runs. Existing runs keep their saved versions.",
      );
      if (
        operation === "skill_test" &&
        !/^[a-f0-9-]{36}$/.test(text(input, "nonce", 36))
      )
        throw Error("This test request has no saved identity.");
    }
  } else if (operation.startsWith("tool_")) {
    // The staleness fence: the project's tools as the card saw them.
    const current = projectToolsOf(store, repo);
    state = { tools: current.map((one) => `${one.name}:${one.digest}`) };
    const project = repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
    if (operation === "tool_add") {
      const spec = toolSpecFromRequest(input);
      if (current.some((one) => one.name === spec.name))
        throw Error(`${project} already has a tool called ${spec.name}.`);
      // The request is rewritten to exactly what was checked, so confirming re-checks the same words.
      for (const key of ["name", "command", "args", "url", "secrets", "about"]) delete request[key];
      if (input["catalog"] === undefined) Object.assign(request, { name: spec.name, ...(spec.transport === "http" ? { url: spec.url } : { command: spec.command, args: spec.args }), secrets: spec.secrets.map((one) => one.name), about: spec.about });
      const needs = spec.secrets.filter((one) => !one.optional).map((one) => one.name);
      title = `Add ${spec.name} to ${project}`;
      terms.push(
        spec.about,
        `Starts: ${toolCommandLine(spec)}`,
        "It runs on this computer with the same access as your builds. Work you approve from now on can use it; tasks approved earlier need approving again to use it.",
        needs.length > 0
          ? `Needs ${needs.join(" and ")}. Set ${needs.length === 1 ? "it" : "them"} on the Tools page after adding, never in chat.`
          : "Test it on the Tools page after adding.",
      );
    } else {
      const name = text(input, "name", 40);
      if (!current.some((one) => one.name === name))
        throw Error(`${project} has no tool called ${name}.`);
      title = `Remove ${name} from ${project}`;
      terms.push("Builds stop using it right away. Its stored secrets are deleted.");
    }
  } else if (operation === "kit_setup") {
    // a starter kit — its teammate, its flow and its buttons.
    const project = repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
    const kit = kitOf(String(input["kit"] ?? ""));
    if (kit === null) throw Error(`Choose a kit: ${KITS.map(one => one.id).join(", ")}.`);
    if (kitInstalled(store, kit, repo) !== null) throw Error(`${kit.name} is already set up in ${project}.`);
    const template = TEAMMATE_TEMPLATES.find(one => one.id === kit.teammate.template);
    title = `Set up ${kit.name} in ${project}`;
    terms.push(kit.promise, `Adds ${kit.teammate.handle.charAt(0).toUpperCase()}${kit.teammate.handle.slice(1)} (${template?.label.toLowerCase() ?? "a teammate"}) and the ${kit.flowName} flow${kit.buttons.length === 0 ? "" : ` with its ${kit.buttons.map(one => `“${one.label}”`).join(" and ")} button`}. Nothing goes out without your approval.`);
    state = {};
  } else if (operation.startsWith("teammate_")) {
    const project = repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
    const mate = mateTarget;
    if (operation === "teammate_create") {
      const template = TEAMMATE_TEMPLATES.find(one => one.id === input["template"]);
      const given = typeof input["soul"] === "string" && input["soul"].trim() !== "" ? text(input, "soul", SOUL_CHARS) : null;
      if ((template === undefined) === (given === null)) throw Error("Start from a template, or write the whole soul file, not both.");
      let soul = given ?? template!.soul;
      if (typeof input["name"] === "string" && input["name"].trim() !== "") soul = renamedSoul(soul, text(input, "name", 40));
      const read = parseSoul(soul);
      if (!read.ok) throw Error(read.problem);
      if (store.teammateByHandle(repo, handleOf(read.soul.name)) !== null) throw Error(`There's already a teammate called ${read.soul.name} in ${project}.`);
      Object.assign(request, { soul }); delete request["template"]; delete request["name"];
      state = { handle: handleOf(read.soul.name) };
      title = `Add ${teammateLabel(read.soul)} to the team in ${project}`;
      terms.push(soul.trim(), `${read.soul.name} decides only within these rules and asks you when they say to. Teammates never approve code tasks or merges.`);
    } else if (operation === "teammate_soul") {
      const soul = text(input, "soul", SOUL_CHARS);
      const read = parseSoul(soul);
      if (!read.ok) throw Error(read.problem);
      if (handleOf(read.soul.name) !== mate!.handle) throw Error("Keep the teammate's name; make a new teammate for another name.");
      if (soul.trim() === mate!.soul.trim()) throw Error("That's already its soul file.");
      state = { version: mate!.version };
      title = `Update ${teammateLabel(read.soul)}'s soul file`;
      terms.push(soul.trim(), `Replaces version ${mate!.version}. Its next turn reads this.`);
    } else if (operation === "teammate_state") {
      const wanted = input["state"];
      if (wanted !== "active" && wanted !== "paused" && wanted !== "removed") throw Error("Choose pause, resume or remove.");
      state = { state: mate!.state };
      title = `${wanted === "paused" ? "Pause" : wanted === "active" ? "Resume" : "Remove"} ${labelOf(mate!)}`;
      terms.push(wanted === "paused" ? "Its decisions go to people and the zones it handles wait until you resume it." : wanted === "active" ? "It picks up its zones' cards again." : "It leaves the team: zones that name it go to people.");
    } else if (operation === "teammate_tools") {
      // v94: which project tools it may use, and its rule for one action.
      const tool = text(input, "tool", 40);
      const change = input["change"];
      const grant = store.teammateGrant(mate!.id, tool);
      const name = nameOf(mate!);
      const grants = store.teammateGrants(mate!.id);
      const uses = grants.length === 0 ? ` ${name} doesn't use any tools yet.` : ` ${name} uses ${grants.map(one => `${one.tool} (actions: ${one.actions.map(each => each.name).join(", ")})`).join("; ")}.`;
      if (change === "grant") {
        const found = projectToolsOf(store, repo).find(one => one.name === tool);
        const named = projectToolsOf(store, repo).map(one => one.name);
        if (found === undefined) throw Error(`${project} has no tool called ${tool}.${named.length === 0 ? " Add it on the Tools page first." : ` Its tools: ${named.join(", ")}.`}${uses}`);
        if (grant !== null) throw Error(`${name} can already use ${tool}.`);
        const actions = found.lastTest?.tools ?? [];
        if (actions.length === 0) throw Error(`${tool} hasn't said what it can do yet. Test it on the Tools page first.`);
        state = { rules: "" };
        title = `Let ${name} use ${tool}`;
        terms.push(...actions.map(one => `${one}: ${defaultRule({ name: one, readOnly: false }).use === "free" ? "does it" : "asks you first"}`),
          `${name} asks for each call on its turn; Toolroll makes it by these rules, and every call is kept on the card. Change a rule any time.`);
      } else if (change === "revoke") {
        if (grant === null) throw Error(`${name} doesn't use a tool called ${tool}.${uses}`);
        state = { rules: JSON.stringify(grant.rules) };
        title = `Stop ${name} using ${tool}`;
        terms.push("Calls waiting for your approval are cancelled.");
      } else if (change === "rule") {
        if (grant === null) throw Error(`${name} doesn't use a tool called ${tool}.${uses}`);
        const action = text(input, "action", 64);
        const limit = input["limitField"] === undefined || input["limitField"] === null || input["limitField"] === "" ? null : { field: input["limitField"], over: input["limitOver"] };
        const checked = checkRule(grant, action, { use: input["use"], limit, undo: input["undoWith"] ?? grant.rules[action]?.undo ?? "" });
        if (!checked.ok) throw Error(checked.said);
        state = { rules: JSON.stringify(grant.rules) };
        title = `${name}: ${action} — ${ruleWords(checked.rule)}`;
        terms.push(`${tool} → ${action}: ${ruleWords(checked.rule)}.`, `Was: ${ruleWords(grant.rules[action] ?? { use: "ask" })}.`,
          ...(checked.rule.undo === undefined ? [] : [`A person can undo it with ${checked.rule.undo}, called with the same input.`]));
      } else throw Error("Choose grant, revoke or rule.");
    } else if (operation === "teammate_undo") {
      // v97: undo one of its tool calls with the action its manager named for that.
      const call = store.teammateCall(integer(input, "call"));
      const undo = call === null || call.teammate !== mate!.id ? null : undoFor(store, call);
      if (call === null || undo === null) throw Error(call?.undoneBy ? `${call.undoneBy} already undid it.` : "That call can't be undone: its action has no undo set on the teammate's Tools.");
      title = `Undo ${nameOf(mate!)}'s ${call.action}`;
      terms.push(`Undoes: ${callWords(call.tool, call.action, call.input, 300)}`, `By calling: ${callWords(call.tool, undo, call.input, 300)}`, "It's made as you, with the same input, and both calls keep their receipts.");
      state = { call: call.id };
    } else if (operation === "teammate_routine") {
      // v96: a routine: on a schedule, a card on its desk saying what to do; its answer goes to its manager.
      const name = nameOf(mate!);
      if (input["change"] === "add") {
        const schedule = routineSchedule(text(input, "schedule", 80));
        if (schedule === null) throw Error("Say the schedule like “weekdays 09:00”, “daily 17:00 Europe/London”, “monday 09:00” or “every 2 hours”.");
        const what = text(input, "text", 200).replace(/\s+/g, " ").trim();
        if (what === "") throw Error("Say what it should do each time.");
        Object.assign(request, { schedule, text: what });
        title = `${name}: ${what}`.slice(0, 120);
        terms.push(`When: ${describeSchedule(parseSchedule(schedule)!)}`, `What: ${what}`, `Each time, a card lands on ${name}'s desk; ${name} works it within its rules and tools, and the answer goes to ${mate!.manager}.`);
        state = { routines: routinesOf(store, mate!).length };
      } else if (input["change"] === "remove") {
        const routine = routinesOf(store, mate!).find(one => one.id === integer(input, "routine"));
        if (routine === undefined) throw Error("That routine is already gone.");
        title = `Stop ${name}'s routine`;
        terms.push(`${describeSchedule(parseSchedule(routine.schedule) ?? { kind: "every", minutes: 60 })}: ${routine.text}`);
        state = { routine: routine.id };
      } else throw Error("Choose add or remove.");
    } else if (operation === "teammate_memory") {
      // v95: edit or forget one thing it remembers.
      const memory = store.teammateMemory(integer(input, "memory"));
      if (memory === null || memory.teammate !== mate!.id) throw Error(`${nameOf(mate!)} doesn't remember that any more.`);
      if (input["change"] === "forget") {
        title = `${nameOf(mate!)} forgets: ${memory.text.slice(0, 60)}`;
        terms.push(memory.text);
      } else if (input["change"] === "edit") {
        const clean = cleanMemory(text(input, "text", 400));
        if (!clean.ok) throw Error(clean.said);
        request["text"] = clean.text;
        title = `Change what ${nameOf(mate!)} remembers`;
        terms.push(`Was: ${memory.text}`, `Now: ${clean.text}`);
      } else throw Error("Choose edit or forget.");
      state = { text: memory.text };
    } else if (operation === "teammate_note") {
      const note = cleanMemory(text(input, "note", 1000));
      if (!note.ok) throw Error(note.said);
      request["note"] = note.text;
      state = { teammate: mate!.id };
      title = `Tell ${nameOf(mate!)}`;
      terms.push(note.text, "It keeps this in its memory: every turn reads the latest ten things people told it.");
    } else {
      const question = questionTarget!;
      if (question.state !== "open") throw Error("That question was already answered.");
      if (question.askedOf !== who.name) throw Error(`Only ${question.askedOf} can answer this one.`);
      const choice = typeof input["choice"] === "string" ? question.options.find(one => one.id === input["choice"] || one.label.toLowerCase() === String(input["choice"]).trim().toLowerCase()) ?? null : null;
      const said = typeof input["text"] === "string" ? text(input, "text", 2000).trim() : "";
      if (choice === null && said === "") throw Error("Pick one of its options or say the answer.");
      Object.assign(request, { choice: choice?.id ?? null, text: said || null });
      state = { question: question.id };
      const mateOf = store.getTeammate(question.teammate);
      title = `Answer ${mateOf === null ? "the teammate" : nameOf(mateOf)}`;
      terms.push(question.question, `Your answer: ${[choice?.label, said].filter(Boolean).join(" — ")}`);
    }
  } else if (operation.startsWith("flow_")) {
    const project = repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
    if (operation === "flow_create") {
      const name = text(input, "name", 80).trim();
      const definition = flowDrawingOf(store, input, repo);
      const elsewhere = crossProjectProblem(store, definition, { repo, owner: who.name });
      if (elsewhere !== null) throw Error(elsewhere);
      request["name"] = name;
      request["definition"] = definition;
      state = {};
      title = `Create the ${name} flow in ${project}`;
      terms.push(...flowTerms(definition, null));
      // A template's trigger (Issues to PRs: labelled issues) comes with it, checked as the flow will have it.
      if (input["trigger"] !== undefined) {
        const draft: FlowRow = { id: 0, repo, name, definitionJson: JSON.stringify(definition), revision: 1, state: "active", createdBy: who.name, createdAt: now.toISOString(), updatedBy: who.name, updatedAt: now.toISOString(), owner: who.name };
        const config = validateTriggerConfig(input["trigger"], { store, flow: draft, definition, actor: who.name });
        if (takesDeliveries(config)) throw Error("Webhook addresses are secrets, so they are set up on the flow's Triggers panel.");
        request["trigger"] = config;
        terms.push(`Starts cards from: ${describeTrigger(config, store)}. Only what happens from now on counts.`);
      }
    } else if (operation === "flow_starter") {
      const starter = starterOf(String(input["starter"] ?? ""));
      if (starter === null) throw Error(`Choose a starter flow: ${STARTER_FLOWS.map(one => one.id).join(", ")}.`);
      if (starterFlowOf(store, starter, repo) !== null) throw Error(`${starter.name} is already on in ${project}.`);
      const blocked = startersFor(store, repo).find(one => one.id === starter.id)?.blocked ?? null;
      if (blocked !== null) throw Error(blocked);
      state = {};
      title = `Switch on ${starter.name} in ${project}`;
      terms.push(...starterTerms(store, starter, repo));
    } else if (operation === "flow_edit") {
      const { flow, definition: before } = flowTarget!;
      const name = input["name"] === undefined ? flow.name : text(input, "name", 80).trim();
      const definition = input["definition"] === undefined ? before : flowDrawingOf(store, input, repo);
      const redrawn = flowDigest(definition) !== flowDigest(before);
      const elsewhere = crossProjectProblem(store, definition, flow);
      if (elsewhere !== null) throw Error(elsewhere);
      if (!redrawn && name === flow.name) throw Error("That's the flow as it is now.");
      Object.assign(request, { name, definition });
      state = { flow: flow.id, revision: flow.revision };
      title = `Change the ${flow.name} flow`;
      if (name !== flow.name) terms.push(`Renames it to ${name}.`);
      if (redrawn) terms.push(...flowTerms(definition, before));
    } else if (operation === "flow_card_add") {
      const { flow, definition } = flowTarget!;
      const words = flowCardText(input["title"], input["description"]);
      if ("problem" in words) throw Error(words.problem);
      const stage = flowZoneOf(definition, input, definition.start);
      Object.assign(request, { title: words.title, zone: stage.id });
      if (words.description === null) delete request["description"]; else request["description"] = words.description;
      state = { flow: flow.id, revision: flow.revision };
      title = `Add ${quoted(words.title)} to ${flow.name}`;
      terms.push(words.description === null ? words.title : `${words.title}\n${words.description}`, `Starts in ${stage.title}: ${FLOW_KIND_WORDS[stage.kind].about}`);
    } else if (operation === "flow_script_save") {
      const draft = validateScript((input["script"] ?? {}) as Record<string, unknown>);
      const current = store.flowScript(repo, draft.name);
      if (current !== null && current.digest === scriptDigest(draft) && current.about === draft.about) throw Error(`${draft.name} is already saved exactly like that.`);
      request["script"] = draft;
      state = { current: current?.digest ?? null, version: current?.version ?? 0 };
      title = `${current === null ? "Save" : "Update"} the ${draft.name} script in ${project}`;
      const language = draft.language === "python" ? "Python" : draft.language === "node" ? "Node" : "Shell";
      terms.push(`${draft.name}: ${draft.about}`, draft.file === null ? draft.body : `Runs the project's file ${draft.file}`,
        `${language}, with no AI, for up to ${draft.timeoutMinutes} minutes, whenever a card reaches a zone that runs it (or a schedule does). It gets the card as data; what it prints is passed on.${current === null ? "" : ` Replaces version ${current.version} everywhere it's used.`}`);
    } else if (operation === "flow_trigger_add") {
      const { flow, definition } = flowTarget!;
      const config = validateTriggerConfig(input["trigger"], { store, flow, definition, actor: who.name });
      // A webhook address is a secret: it is made and shown on the flow's own Triggers panel, never through chat.
      if (takesDeliveries(config)) throw Error("Webhook addresses are secrets, so they are set up on the flow's Triggers panel. From chat, use a trigger that is checked every 2 minutes.");
      request["trigger"] = config;
      state = { flow: flow.id, revision: flow.revision };
      title = `Add a trigger to ${flow.name}`;
      const zone = definition.stages.find(one => one.id === (config.zone ?? definition.start))?.title ?? "the first zone";
      terms.push(describeTrigger(config, store), `Cards start in ${zone}.`);
      if (config.kind === "github" && config.from === "anyone") terms.push("Anyone who can open one there can write what the agent reads.");
      if (config.kind === "linear" && readLinearKey(configDirOf(store)) === null) terms.push("It needs a Linear API key, saved on the flow's Triggers panel (never in chat).");
      if (config.kind === "github" || config.kind === "linear") terms.push("Only what happens from now on counts; nothing already there is added.");
      terms.push("Work a card starts still waits for your usual approvals.");
    } else if (operation === "flow_trigger_pause" || operation === "flow_trigger_resume" || operation === "flow_trigger_remove") {
      const { flow, trigger } = flowTarget!;
      const config = trigger === null ? null : triggerConfigOf(trigger);
      if (trigger === null || config === null) throw Error("Choose a trigger from get_flows.");
      if (operation === "flow_trigger_pause" && trigger.state === "paused") throw Error("That trigger is already paused.");
      if (operation === "flow_trigger_resume" && trigger.state === "active") throw Error("That trigger is already on.");
      state = { trigger: trigger.id, state: trigger.state, updatedAt: trigger.updatedAt };
      const what = describeTrigger(config, store);
      title = `${operation === "flow_trigger_pause" ? "Pause" : operation === "flow_trigger_resume" ? "Turn on" : "Remove"} a trigger on ${flow.name}`;
      terms.push(what, operation === "flow_trigger_pause" ? "It stops adding cards until it's turned on again. Cards it already added stay." : operation === "flow_trigger_resume" ? "It adds cards again, starting from now." : `It stops adding cards for good${takesDeliveries(config) ? ", and its webhook address stops working" : ""}. Cards it already added stay.`);
    } else {
      const { definition, card } = flowTarget!;
      if (card === null) throw Error("Choose a card from get_flows.");
      const at = definition.stages.find(one => one.id === card.stage);
      state = { card: card.id, entry: card.entry, stage: card.stage };
      if (operation === "flow_card_comment" || operation === "flow_card_assign" || operation === "flow_card_watch") {
        const people = flowPeople(store, flowTarget!.flow.repo);
        if (operation === "flow_card_comment") {
          const note = text(input, "note", 4000).trim();
          const mentions = mentionsIn(note, people);
          request["note"] = note;
          title = `Comment on ${quoted(card.title)}`;
          terms.push(note, mentions.length === 0 ? "Its owner and followers hear about it." : `${mentions.join(" and ")} ${mentions.length === 1 ? "is" : "are"} pinged; its owner and followers hear about it too.`);
        } else if (operation === "flow_card_assign") {
          const said = input["owner"] === null || input["owner"] === undefined ? "" : text(input, "owner", 64).trim();
          const owner = said === "" ? null : people.find(one => one.toLowerCase() === said.toLowerCase()) ?? null;
          if (said !== "" && owner === null) throw Error(`No one called ${said} can work on this project.`);
          if (owner === card.owner) throw Error(owner === null ? "It has no owner already." : `${owner === who.name ? "You already own" : `${owner} already owns`} it.`);
          request["owner"] = owner;
          state["owner"] = card.owner;
          title = owner === null ? `Leave ${quoted(card.title)} without an owner` : `Make ${owner === who.name ? "you" : owner} the owner of ${quoted(card.title)}`;
          terms.push(owner === null ? "No one owns it; its followers still hear about it." : `${owner === who.name ? "You" : owner} will hear when it needs ${owner === who.name ? "you" : "them"}, is sent back, fails or finishes.`);
        } else {
          const watching = input["watching"] !== false;
          request["watching"] = watching;
          title = `${watching ? "Follow" : "Stop following"} ${quoted(card.title)}`;
          terms.push(watching ? "You'll hear when it moves, is commented on, or finishes." : "You won't hear about it unless someone mentions you.");
        }
      } else if (operation === "flow_card_move") {
        const stage = flowZoneOf(definition, input, null);
        if (stage.id === card.stage) throw Error(`It's already in ${stage.title}.`);
        request["zone"] = stage.id;
        title = `Move ${quoted(card.title)} to ${stage.title}`;
        terms.push(`From ${at?.title ?? "its zone"} to ${stage.title}.`, `${stage.title}: ${FLOW_KIND_WORDS[stage.kind].about}`);
      } else if (operation === "flow_card_cancel") {
        title = `Take ${quoted(card.title)} out of the flow`;
        terms.push("The card leaves the flow. Any tasks it filed stay as they are.");
      } else if (operation === "flow_card_choose") {
        // "Person chooses" (flow-send.ts): one of the zone's own options, or a reply that becomes the note.
        if (at?.kind !== "choose") throw Error("That card isn't waiting for a choice.");
        const person = flowPersonOf(card, flowTarget!.flow);
        if (person !== who.name) throw Error(`Only ${person} chooses here.`);
        const titleOf = (id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
        if (input["choice"] !== undefined && input["choice"] !== null) {
          const index = Number(input["choice"]) - 1;
          const option = Number.isSafeInteger(input["choice"]) ? (at.options ?? [])[index] : undefined;
          if (option === undefined) throw Error(`Choose one of its ${(at.options ?? []).length} options, by number.`);
          delete request["note"];
          title = `Choose “${option.label}” for ${quoted(card.title)}`;
          terms.push(option.to === "end" ? `${at.title}: “${option.label}”. The card is closed as Ignored.` : `${at.title}: “${option.label}”. It moves to ${titleOf(option.to)}.`);
        } else {
          const note = input["note"] === undefined ? "" : text(input, "note", 2000).trim();
          const target = replyTarget(at);
          if (target === null) throw Error("This step takes one of its options, not a reply.");
          if (note === "") throw Error("Say what you'd change, or choose an option by number.");
          request["note"] = note;
          title = `Reply on ${quoted(card.title)}`;
          terms.push(`${at.title}: your reply goes to ${titleOf(target)} as its note:\n${note}`);
        }
      } else {
        if (at?.kind !== "approval") throw Error("That card isn't waiting for a decision.");
        const decider = deciderOf(at, flowTarget!.flow);
        if (decider !== null && decider !== who.name) throw Error(`Only ${decider} decides here.`);
        const note = input["note"] === undefined ? "" : text(input, "note", 2000).trim();
        const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? null;
        if (operation === "flow_card_approve") {
          title = `Approve ${quoted(card.title)}`;
          terms.push(`${at.title}: approved. ${at.next === null ? "The card is done." : `It moves to ${titleOf(at.next)}.`}`);
          if (note !== "") terms.push(`Note: ${note}`);
        } else {
          if (at.onFail === null) throw Error("This step has nowhere to send work back to.");
          if (note === "") throw Error("Say what should change.");
          const back = definition.stages.find(one => one.id === at.onFail);
          title = `Send ${quoted(card.title)} back`;
          terms.push(`${at.title}: sent back to ${back?.title ?? at.onFail} with this note:\n${note}`);
          if (back?.kind === "task" && card.primaryTask !== null) terms.push("It already has a result, so the build makes a revision of that same work, with your note.");
        }
        if (note === "") delete request["note"]; else request["note"] = note;
      }
    }
  } else if (operation.startsWith("decision_")) {
    // The staleness fence: the newest decision id and the active count, so a
    // card drafted before a teammate recorded or retired one is refused.
    const stamp = store.handle.prepare("SELECT COALESCE(MAX(id),0) AS newest, COUNT(*) AS active FROM project_decision WHERE repo=? AND status='active'").get(repo);
    state = { newest: Number(stamp?.["newest"] ?? 0), active: Number(stamp?.["active"] ?? 0) };
    if (operation === "decision_record") {
      const claim = text(input, "claim", 240), why = text(input, "why", 2000);
      if (!claim || !why) throw Error("A decision needs the choice in one sentence and the reason.");
      terms.push(`Decision: ${claim}`, `Why: ${why}`);
      if (input["supersedes"] !== undefined) {
        const older = getDecision(store, repo, who.name, integer(input, "supersedes"));
        if (older === null || older.status !== "active") throw Error("The decision being replaced is not active.");
        terms.push(`Replaces decision ${older.id}: ${older.claim}`);
        state["supersedes"] = older.id;
      }
      if (input["source"] !== undefined) terms.push(`Source: ${text(input, "source", 200)}`);
      terms.push("Records a settled choice with its reason for everyone on this project. It is context, never an instruction or a permission.");
    } else {
      const older = getDecision(store, repo, who.name, integer(input, "decision"));
      if (older === null || older.status !== "active") throw Error("That decision is not active.");
      const reason = text(input, "reason", 500);
      if (!reason) throw Error("Say why this decision no longer holds.");
      terms.push(`Retire decision ${older.id}: ${older.claim}`, `Reason: ${reason}`, "The decision stays in history and stops being offered as context.");
      state["decision"] = older.id;
    }
  } else if (operation.startsWith("knowledge_")) {
    const view = knowledgeView(store, repo, who.name);
    state = {
      identity: view.identity,
      revision: view.revision,
      knowledge: view.knowledge,
    };
    if (operation === "knowledge_instructions")
      terms.push(
        `Project instructions:\n${text(input, "instructions", 4000, true)}`,
      );
    if (operation === "knowledge_save") {
      terms.push(
        `Reference: ${text(input, "title", 120)}\n${text(input, "content", 12000)}`,
      );
      if (
        input["id"] !== undefined &&
        !view.knowledge.references.some((one) => one.id === input["id"])
      )
        throw Error("That reference is no longer available.");
    }
    if (operation === "knowledge_remove") {
      const reference = view.knowledge.references.find(
        (one) => one.id === text(input, "id", 20),
      );
      if (!reference) throw Error("That reference is no longer available.");
      terms.push(`Remove ${reference.title}\n${reference.content}`);
    }
    if (operation === "knowledge_restore")
      terms.push(
        `Restore version ${integer(input, "restore")}:\n${JSON.stringify(knowledgeVersion(store, repo, who.name, Number(input["restore"])), null, 2)}`,
      );
    terms.push(
      "Changes project knowledge for future runs. Existing runs retain their saved context.",
    );
  } else {
    const ref = store.lookupRef(task!)!,
      row = store.getTask(task!)!,
      family = store.taskFamilyOf(task!, who.repos, false);
    if (!row || !family || family.problem || family.current.id !== task)
      throw Error("Choose the current task.");
    if (store.openContestFor(ref.id) !== null)
      throw Error("Wait for the agent comparison to finish.");
    const scope = store.getScope(task!);
    state = {
      task,
      updatedAt: row.updatedAt,
      taskState: row.state,
      scope,
      latest: store.runsFor(ref.id)[0]?.id ?? null,
    };
    title = `${CHAT_ACTIONS[operation].label}: ${row.title}`;
    if (operation === "scope_approve") {
      if (!scope || ref.plan === "requested")
        throw Error(
          "Wait for the exact work and plan to be ready for approval.",
        );
      if (scope.digest === scope.approvedDigest)
        throw Error("This work is already approved.");
      const authority = scopeAuthorityOf(scope, {
        authMode: readAuthModeStrict,
      });
      if (!authority.ok) throw Error(authority.problem);
      state["authMode"] = authority.authMode;
      const race = store.activeTournamentTerms(ref.id);
      state["race"] = race;
      terms.push(
        ...describeScope(scope)
          .filter((line) => !/^\s*(reference|approved)\s/.test(line))
          .map((line) =>
            line
              .trimStart()
              .replace(/^goal\s+/, "Work: ")
              .replace(/^not this\s+/, "Excluded: ")
              .replace(/^touches\s+/, "Allowed files: "),
          ),
        ...(
          authority.chain ?? [
            { profile: authority.profile, authMode: authority.authMode },
          ]
        ).map(
          (entry, index) =>
            `${index === 0 ? "Agent permissions and limits" : "Fallback " + index}\n${runtimeTerms(entry.profile)}\n${entry.authMode === "api-key" ? "Uses your API key; spend is charged to that account." : entry.authMode === "subscription" ? "Uses your subscription login." : ""}`,
        ),
      );
      if (race)
        terms.push(`Agent comparison terms:\n${JSON.stringify(race, null, 2)}`);
      const plan = store.latestPlanArtifact(ref.id),
        revision =
          ref.revisionBriefArtifact === null
            ? null
            : store.getArtifact(ref.revisionBriefArtifact);
      if (ref.plan === "drafted" && !plan)
        throw Error("The saved plan is missing.");
      if (ref.revisionBriefArtifact !== null && !revision)
        throw Error("The revision evidence is missing.");
      for (const artifact of [plan, revision])
        if (artifact) {
          if (!root) throw Error("The saved approval evidence is unavailable.");
          const read = readVerifiedArtifact(root, artifact);
          if (
            !read.ok ||
            artifact.truncated ||
            artifact.redacted ||
            artifact.captureStatus === "failed"
          )
            throw Error(
              "The saved approval evidence could not be verified in full.",
            );
          state[artifact.kind] = { id: artifact.id, sha: artifact.sha256 };
          terms.push(
            `${artifact.kind === "plan" ? "Plan" : "Requested changes"}:\n${read.content.toString("utf8")}`,
          );
        }
    } else if (operation === "task_resume") {
      const run = integer(input, "run"),
        control = taskControlOf(store, ref.id, now);
      if (control.kind !== "paused" || control.run !== run)
        throw Error("This attempt is not ready to resume.");
      state["stop"] = store.stopOf(run);
      terms.push(
        `Resume saved work from attempt #${run}. Only this stop's hold is released. Other holds and approval requirements still apply.`,
      );
    } else if (operation === "task_cancel") {
      if (row.state === "cancelled" || row.state === "done")
        throw Error("This task cannot be cancelled now.");
      terms.push(
        "Cancel this task. It will no longer be scheduled. Existing work and evidence are preserved.",
      );
    } else {
      const run = resultOf(store, task!, integer(input, "run"), repo);
      state["run"] = { id: run.id, head: run.headRevision };
      const assignment = assignmentOf(
        store,
        task!,
        now,
        { principal: "operator", repos: who.repos },
        root,
      );
      const receipt = assignment?.receipt ?? null;
      if (assignment === null || receipt === null || receipt.runId !== run.id)
        throw Error(
          "This result changed. Open the current result before marking it complete.",
        );
      if (assignment.state === "complete")
        throw Error("This result is already marked complete.");
      if (assignment.state !== "ready-to-check")
        throw Error(`This result is not ready to complete: ${assignment.detail}`);
      state["receipt"] = receipt.digest;
      terms.push(
        `Result #${run.id} · ${run.headRevision === null ? "no commit recorded" : `commit ${run.headRevision.slice(0, 12)}`}`,
        "Marks this exact result complete: you handled it. Recorded checks stay unchanged, and publication or deployment is separate.",
        `Checks: ${receipt.checks.detail}`,
      );
      if (receipt.proof !== null && receipt.proof.matrix.length > 0)
        terms.push(
          `Requirements: ${receipt.proof.matrix.filter((row) => row.state === "pass").length}/${receipt.proof.matrix.length} satisfied in the saved record.`,
        );
      for (const line of assignment.attention) terms.push(line);
      for (const caveat of receipt.caveats)
        if (!assignment.attention.includes(caveat)) terms.push(`Limitation: ${caveat}`);
    }
  }
  const stamp = hash({
    operation,
    request,
    repo,
    state,
    terms,
    actor: who.name,
    generation: who.generation,
    ceiling: who.ceilingDigest,
  });
  return { operation, request, repo, title, terms, stamp, state };
}
export function sharedActionPayload(
  value: Record<string, unknown>,
): SharedAction | null {
  return isChatAction(value["operation"]) &&
    typeof value["stamp"] === "string" &&
    typeof value["repo"] === "string" &&
    typeof value["title"] === "string" &&
    Array.isArray(value["terms"]) &&
    value["terms"].every((t) => typeof t === "string") &&
    value["request"] !== null &&
    typeof value["request"] === "object" &&
    !Array.isArray(value["request"]) &&
    value["state"] !== null &&
    typeof value["state"] === "object"
    ? (value as unknown as SharedAction)
    : null;
}
/** A shortened or redacted preview is not complete consent. This rule lives
 * in the shared door, so a forged transport callback cannot bypass it. */
function sharedActionContentNeedsReview(action: SharedAction): boolean {
  const content = [action.title, ...action.terms];
  return (
    action.terms.join("\n").length > 1200 ||
    content.some(
      (value, index) =>
        publicChatText(value, index === 0 ? 200 : 1200) !==
        value.replace(/\s+/g, " ").trim(),
    )
  );
}
export function sharedActionNeedsReview(action: SharedAction): boolean {
  return (
    CHAT_ACTIONS[action.operation].protected ||
    sharedActionContentNeedsReview(action)
  );
}
/** Whether a paired phone may confirm this protected action behind its own
 * explicit challenge: the action is on the challenge list, needs no
 * password, and every term fits the card unshortened. */
export function sharedActionAllowsChallenge(action: SharedAction): boolean {
  const config = CHAT_ACTIONS[action.operation];
  return (
    CHALLENGE_ACTIONS.has(action.operation) &&
    config.protected &&
    !config.password &&
    !sharedActionContentNeedsReview(action)
  );
}
export function sharedActionReviewPath(id: number): string {
  return `/chat/action/${id}`;
}
function savedActionContext(
  store: Store,
  who: VerifiedApprover,
  id: number,
  state: "pending" | "confirming",
) {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok)
    throw Error("Your access changed. Sign in again.");
  const proposal = store.getMateProposal(id),
    payload =
      proposal?.kind === "action"
        ? sharedActionPayload(proposal.payload)
        : null;
  const shared=proposal&&store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(proposal.thread);
  const session = shared&&proposal ? store.teamMateSession(who.name,proposal.thread) : store.activeMateSession(who.name),
    turn = proposal ? store.getMateTurn(proposal.turn) : null;
  if (
    !proposal ||
    !payload ||
    proposal.state !== state ||
    (shared ? !store.canUseTeamMateThread(who.name,who.generation,proposal.thread) : store.getMateThread(proposal.thread)?.approver !== who.name)
  )
    throw Error("This action is no longer waiting for your review.");
  if (
    !session ||
    session.approverGeneration !== who.generation ||
    session.ceilingDigest !== who.ceilingDigest ||
    proposal.ceilingDigest !== who.ceilingDigest ||
    (!shared && turn?.session !== session.id) ||
    turn?.state !== "answered"
  )
    throw Error(
      "This conversation ended or its project access changed. Ask for a fresh proposal.",
    );
  requireActor(store, who, payload.repo, payload.operation);
  return payload;
}
export function mintSharedActionReview(
  store: Store,
  who: VerifiedApprover,
  id: number,
  root: string,
  now: Date,
) {
  const payload = savedActionContext(store, who, id, "pending");
  const live = prepareSharedAction(
    store,
    who,
    payload.operation,
    payload.request,
    root,
    now,
  );
  if (live.stamp !== payload.stamp)
    throw Error("This action changed. Ask for a fresh proposal.");
  const nonce = randomBytes(24).toString("hex");
  if (
    !store.mintCeremonyNonce(
      {
        hash: nonceHash(nonce),
        approver: who.name,
        subject: "chat-action",
        subjectId: id,
        digest: payload.stamp,
        ttlMs: 10 * 60_000,
      },
      now,
    ).ok
  )
    throw Error(
      "Too many reviews are open. Close older reviews and try again.",
    );
  return { payload: live, nonce };
}
export type SharedActionOptions = {
  via: "web" | "cli" | "telegram" | "slack" | "discord" | "teams";
  root?: string;
  review?: { nonce: string; password: string };
  confirm?: boolean;
};
/** Called inside the proposal door's transaction, after ownership and session
 * checks. No password or review receipt is ever part of a saved proposal. */
export function executeSharedAction(
  store: Store,
  who: VerifiedApprover,
  id: number,
  payload: SharedAction,
  now: Date,
  options: SharedActionOptions,
):
  | { ok: true; said: string; taskId: string | null; href?: string }
  | { ok: false; reason: "needs-confirm" | "stale" | "refused"; said: string } {
  const refuse = (
    reason: "needs-confirm" | "stale" | "refused",
    said: string,
  ) => ({ ok: false as const, reason, said });
  if (store.isDemo()) return refuse("refused", "The demo authorizes nothing.");
  let live: SharedAction;
  try {
    const saved = savedActionContext(store, who, id, "confirming");
    if (hash(saved) !== hash(payload))
      return refuse(
        "refused",
        "This action does not match the saved proposal.",
      );
    live = prepareSharedAction(
      store,
      who,
      saved.operation,
      saved.request,
      options.root,
      now,
    );
    if (live.stamp !== saved.stamp)
      return refuse("stale", "This action changed. Ask for a fresh proposal.");
  } catch (error) {
    return refuse(
      "stale",
      error instanceof Error
        ? error.message
        : "This action is no longer available.",
    );
  }
  payload = live;
  const config = CHAT_ACTIONS[live.operation],
    req = live.request;
  const challenged =
    options.via !== "web" &&
    options.via !== "cli" &&
    options.confirm === true &&
    sharedActionAllowsChallenge(payload);
  if (sharedActionNeedsReview(payload) && !challenged) {
    if (options.via !== "web" || !options.review || options.confirm !== true)
      return refuse(
        "needs-confirm",
        "Review the complete action in the secure confirmation screen.",
      );
    if (
      !store.consumeCeremonyNonce(
        nonceHash(options.review.nonce),
        who.name,
        "chat-action",
        id,
        payload.stamp,
        now,
      )
    )
      return refuse(
        "needs-confirm",
        "This confirmation expired or was already used. Open the review again.",
      );
    if (
      config.password &&
      !authenticateApprover(
        store,
        who.name,
        options.review.password,
        payload.repo,
      ).ok
    )
      return refuse(
        "needs-confirm",
        "Confirm with your password in the secure screen.",
      );
  }
  try {
    return store.savepoint(() => {
      const task = typeof req["task"] === "string" ? req["task"] : null,
        repo = payload.repo,
        actor = who.name;
      let taskId = task;
      if (payload.operation === "lead_about_you") {
        const next = withAboutYouLine(aboutYouOf(store, actor), String(req["line"]), Number(req["replaces"] ?? 0));
        if (!next.ok) throw Error(next.message);
        saveAboutYou(store, actor, next.lines, now);
        return { ok: true as const, taskId: null, said: req["replaces"] === undefined ? "Your lead will remember this." : "Updated what your lead knows about you.", href: "/settings/lead" };
      }
      if (payload.operation === "skill_import")
        importSkill(
          store,
          repo,
          actor,
          req["files"] as SkillFile[],
          "Chat import",
          now,
        );
      else if (payload.operation === "skill_test")
        taskId = testSkill(
          store,
          {
            repo,
            actor,
            sha: String(req["version"]),
            sample: String(req["sample"]),
            nonce: String(req["nonce"]),
          },
          now,
        ).id;
      else if (payload.operation.startsWith("skill_"))
        changeSkills(
          store,
          {
            repo,
            actor,
            identity: String(payload.state["identity"]),
            revision: Number(payload.state["revision"]),
            action: payload.operation.slice(6) as
              "enable" | "disable" | "restore",
            ...(req["version"] === undefined
              ? {}
              : { sha: String(req["version"]) }),
            ...(req["restore"] === undefined
              ? {}
              : { restore: Number(req["restore"]) }),
          },
          now,
        );
      else if (payload.operation.startsWith("flow_")) {
        const done = runFlowAction(store, payload, actor, who.repos, options.root, now);
        return { ok: true as const, taskId: null, said: done.said, href: done.href };
      }
      else if (payload.operation === "kit_setup") {
        const kit = kitOf(String(req["kit"]))!;
        const made = setUpKitNow(store, kit, repo, actor, now, null, true);
        if (!made.ok) throw Error(made.said);
        return { ok: true as const, taskId: null, said: `${made.said} Try it with a sample card from its page.`, href: `/kits/${kit.id}?repo=${encodeURIComponent(repo)}` };
      }
      else if (payload.operation.startsWith("teammate_")) {
        const done = runTeammateAction(store, payload, actor, now);
        return { ok: true as const, taskId: null, said: done.said, href: done.href };
      }
      else if (payload.operation === "tool_add") {
        const added = addToolTo(store, repo, toolSpecFromRequest(req), req["catalog"] === undefined ? "the lead, confirmed by you" : "the common tools list", actor, now);
        if (!added.ok) throw Error(added.message);
      } else if (payload.operation === "tool_remove") {
        if (!removeToolFrom(store, repo, String(req["name"]), actor, now)) throw Error("That tool was already removed.");
      }
      else if (payload.operation === "decision_record")
        recordDecision(store, { repo, actor, draft: { claim: String(req["claim"]), why: String(req["why"]), sourceKind: "conversation",
          ...(req["source"] === undefined ? {} : { sourceRef: String(req["source"]) }), ...(payload.state["supersedes"] === undefined ? {} : { supersedes: Number(payload.state["supersedes"]) }) } }, now);
      else if (payload.operation === "decision_retire")
        retireDecision(store, { repo, actor, id: Number(payload.state["decision"]), reason: String(req["reason"]) }, now);
      else if (payload.operation.startsWith("knowledge_"))
        changeKnowledge(
          store,
          {
            repo,
            actor,
            identity: String(payload.state["identity"]),
            revision: Number(payload.state["revision"]),
            action: payload.operation.slice(10) as
              "instructions" | "save" | "remove" | "restore",
            draft: Object.fromEntries(
              ["instructions", "title", "content", "id"]
                .filter((k) => req[k] !== undefined)
                .map((k) => [k, req[k]]),
            ) as KnowledgeDraft,
            ...(req["restore"] === undefined
              ? {}
              : { restore: Number(req["restore"]) }),
          },
          now,
        );
      else if (payload.operation === "scope_approve") {
        const scope = store.getScope(task!)!,
          race = store.activeTournamentTerms(store.lookupRef(task!)!.id);
        const result = approve(
          store,
          task!,
          actor,
          now,
          scope.digest,
          options.review!.password,
        );
        if (!result.ok) {
          // v102: the project's approval rules speak for themselves.
          if (result.reason === "second-approver") throw Error(gateWords({ verdict: "vote", have: result.have, need: 2, already: result.already }));
          if (result.reason === "requester" || result.reason === "person-required") throw Error(gateWords({ verdict: "refuse", reason: result.reason }));
          if (result.reason === "policy") throw Error(result.message);
          throw Error(`Approval refused: ${result.reason}.`);
        }
        if (
          race &&
          !store.approveTournamentTerms(race.id, actor, race.raceDigest, now)
        )
          throw Error("The comparison terms changed. Nothing was approved.");
      } else if (payload.operation === "result_accept") {
        // Accept and finish, as on the result page: whether a check only the person makes is accepted
        // too is decided inside the same transaction, against the receipt as it stands.
        const completed = acceptAndCompleteAsOperator(store, task!, { runId: null, receiptDigest: String(payload.state["receipt"] ?? ""), note: null }, who, now, options.root);
        if (!completed.ok) throw Error(completed.message);
      } else if (payload.operation === "task_cancel") {
        const result = withActor({ account: who.name, lead: false }, () => store.cancelTask(task!, now));
        if (!result.ok)
          throw Error(`Task was not cancelled: ${result.reason}.`);
      } else if (payload.operation === "task_resume") {
        const result = resumeTaskStop(
          store,
          {
            taskId: task!,
            runId: Number(req["run"]),
            by: verifiedAuthor(actor),
            via: "web",
          },
          now,
        );
        if (!result.ok) throw Error(result.detail);
        return {
          ok: true as const,
          taskId,
          said: `Stop released. ${result.gate ? "Other requirements still prevent the next attempt." : "The next attempt may start."}`,
        };
      }
      const said =
        payload.operation === "skill_test"
          ? "Skill test created. Existing approval rules apply."
          : payload.operation === "result_accept"
              ? "Accepted and finished. The recorded checks are unchanged."
              : payload.operation === "scope_approve"
                ? "The exact work is approved."
                : payload.operation === "task_cancel"
                  ? "Task cancelled."
                  : payload.operation === "skill_import"
                    ? "Skill added to the library."
                    : payload.operation === "skill_enable"
                      ? "Skill enabled for future runs."
                      : payload.operation === "skill_disable"
                        ? "Skill disabled for future runs."
                        : payload.operation === "skill_restore"
                          ? "Saved skills restored."
                          : payload.operation === "decision_record"
                            ? "Decision recorded for this project."
                            : payload.operation === "decision_retire"
                              ? "Decision retired; its history stays."
                          : payload.operation === "tool_add"
                            ? "Tool added for work you approve from now on. Set any secrets it needs and test it on the Tools page."
                          : payload.operation === "tool_remove"
                            ? "Tool removed from every build."
                          : payload.operation === "knowledge_remove"
                            ? "Reference removed."
                            : payload.operation === "knowledge_restore"
                              ? "Saved project knowledge restored."
                              : "Project knowledge saved.";
      return { ok: true as const, taskId, said };
    });
  } catch (error) {
    return refuse(
      "refused",
      error instanceof Error
        ? error.message
        : "The action could not be completed.",
    );
  }
}

/** A confirmed teammate action (v92), through the same helpers the Teammates pages use. */
function runTeammateAction(store: Store, payload: SharedAction, actor: string, now: Date): { said: string; href: string } {
  const req = payload.request;
  if (payload.operation === "teammate_create") {
    const made = createTeammateFrom(store, { repo: payload.repo, soul: String(req["soul"]), by: actor }, now);
    if (!made.ok) throw Error(made.said);
    return { said: made.said, href: `/teammates/${made.id}` };
  }
  if (payload.operation === "teammate_answer") {
    const question = store.teammateQuestion(Number(req["question"]));
    const answered = answerTeammateQuestion(store, Number(req["question"]), { choice: req["choice"] === null ? null : String(req["choice"]), text: req["text"] === null ? null : String(req["text"]), by: actor, via: "chat" }, now);
    if (!answered.ok) throw Error(answered.said);
    return { said: answered.said, href: question === null ? "/teammates" : `/teammates/${question.teammate}` };
  }
  const mate = store.getTeammate(Number(req["teammate"]));
  if (mate === null || mate.state === "removed") throw Error("That teammate is off the team.");
  if (payload.operation === "teammate_undo") {
    const asked = requestUndo(store, mate, Number(req["call"]), actor, now);
    if (!asked.ok) throw Error(asked.said);
    return { said: `${asked.said} The receipt on the card shows how it went.`, href: `/teammates/${mate.id}#week` };
  }
  if (payload.operation === "teammate_routine") {
    const done = req["change"] === "add" ? addRoutine(store, mate, String(req["schedule"]), String(req["text"]), actor, now, null)
      : removeRoutine(store, mate, Number(req["routine"]), now, null);
    if (!done.ok) throw Error(done.said);
    return { said: done.said, href: `/teammates/${mate.id}#desk` };
  }
  if (payload.operation === "teammate_memory") {
    const memory = store.teammateMemory(Number(req["memory"]));
    if (memory === null || memory.text !== payload.state["text"]) throw Error("That memory changed since. Ask for a fresh proposal.");
    const done = req["change"] === "forget" ? forgetMemory(store, mate, memory.id, actor, now) : editMemory(store, mate, memory.id, String(req["text"]), actor, now);
    if (!done.ok) throw Error(done.said);
    return { said: done.said, href: `/teammates/${mate.id}#memory` };
  }
  if (payload.operation === "teammate_tools") {
    const tool = String(req["tool"]);
    const grant = store.teammateGrant(mate.id, tool);
    if ((grant === null ? "" : JSON.stringify(grant.rules)) !== payload.state["rules"]) throw Error("Someone changed its tools since. Ask for a fresh proposal.");
    const found = projectToolsOf(store, mate.repo).find(one => one.name === tool);
    const done = req["change"] === "grant" ? found === undefined ? { ok: false as const, said: `There's no tool called ${tool} any more.` } : grantListed(store, mate, found, null, actor, now)
      : req["change"] === "revoke" ? revokeTool(store, mate, tool, actor, now)
      : setToolRules(store, mate, tool, { [String(req["action"])]: { use: req["use"], limit: req["limitField"] === undefined || req["limitField"] === null || req["limitField"] === "" ? null : { field: req["limitField"], over: req["limitOver"] },
        undo: req["undoWith"] ?? grant?.rules[String(req["action"])]?.undo ?? "" } }, actor, now);
    if (!done.ok) throw Error(done.said);
    return { said: done.said, href: `/teammates/${mate.id}#tools` };
  }
  if (payload.operation === "teammate_soul" && mate.version !== payload.state["version"]) throw Error("Someone changed its soul file since. Ask for a fresh proposal.");
  const done = payload.operation === "teammate_soul" ? saveSoul(store, mate, String(req["soul"]), actor, now)
    : payload.operation === "teammate_state" ? setTeammateState(store, mate, req["state"] as "active" | "paused" | "removed", actor, now)
    : tellTeammate(store, mate, String(req["note"]), actor, now);
  if (!done.ok) throw Error(done.said);
  return { said: done.said, href: payload.operation === "teammate_state" && req["state"] === "removed" ? "/teammates" : `/teammates/${mate.id}` };
}

/** A confirmed flow action, through the same helpers the canvas uses; then
 * the flow moves what it can right away, as it does after a canvas change. */
function runFlowAction(store: Store, payload: SharedAction, actor: string, repos: readonly string[], root: string | undefined, now: Date): { said: string; href: string } {
  const req = payload.request;
  const settle = (flow: number, said: string, card: number | null) => {
    const repo = store.getFlow(flow)?.repo;
    if (repo !== undefined) {
      try { advanceFlows(store, repo, now, root === undefined ? {} : { evidenceRoot: root }); } catch { /* the next worker pass retries */ }
    }
    const after = card === null ? null : store.getFlowCard(card);
    const filed = after !== null && after.task !== null && after.state === "active" ? " Its step filed a task under your usual approvals." : "";
    return { said: `${said}${filed}`, href: card === null ? `/flows/${flow}` : flowCardHref(flow, card) };
  };
  if (payload.operation === "flow_create") {
    const id = store.transact(() => {
      const made = store.createFlow({ repo: payload.repo, name: String(req["name"]), definitionJson: JSON.stringify(req["definition"]), by: actor }, now);
      if (req["trigger"] !== undefined) {
        const trigger = addFlowTriggerTo(store, store.getFlow(made)!, req["trigger"], actor, now, null);
        if (!trigger.ok) throw Error(trigger.message);
      }
      return made;
    });
    return { said: "Flow created. Add cards to it here or on its canvas.", href: `/flows/${id}` };
  }
  if (payload.operation === "flow_starter") {
    const switched = switchOnStarter(store, starterOf(String(req["starter"]))!, payload.repo, actor, now, configDirOf(store));
    if (!switched.ok) throw Error(switched.said);
    return { said: switched.said, href: `/flows/${switched.flow}` };
  }
  if (payload.operation === "flow_edit") {
    const flow = Number(payload.state["flow"]);
    if (!store.saveFlow(flow, { name: String(req["name"]), definitionJson: JSON.stringify(req["definition"]), sawRevision: Number(payload.state["revision"]), by: actor }, now))
      throw Error("Someone changed this flow. Ask for a fresh proposal.");
    return settle(flow, "Flow saved.", null);
  }
  if (payload.operation === "flow_card_add") {
    const flow = store.getFlow(Number(req["flow"]))!;
    const added = addCardToFlow(store, flow, { title: req["title"], description: req["description"] ?? null, stage: String(req["zone"]) }, actor, now);
    if (!added.ok) throw Error(added.message);
    return settle(flow.id, added.said, added.card);
  }
  if (payload.operation === "flow_script_save") {
    const saved = saveScript(store, payload.repo, req["script"] as Record<string, unknown>, actor, now);
    if (!saved.ok) throw Error(saved.message);
    const first = store.listFlows([payload.repo])[0];
    return { said: saved.said, href: first === undefined ? "/flows" : `/flows/${first.id}` };
  }
  if (payload.operation === "flow_trigger_add") {
    const flow = store.getFlow(Number(req["flow"]))!;
    const made = addFlowTriggerTo(store, flow, req["trigger"], actor, now, null);
    if (!made.ok) throw Error(made.message);
    return { said: "Trigger added.", href: `/flows/${flow.id}` };
  }
  if (payload.operation.startsWith("flow_trigger_")) {
    const trigger = store.getFlowTrigger(Number(req["trigger"]))!;
    if (payload.operation === "flow_trigger_remove") removeFlowTrigger(store, trigger, now, configDirOf(store));
    else store.updateFlowTrigger(trigger.id, { state: payload.operation === "flow_trigger_pause" ? "paused" : "active" }, now);
    return { said: payload.operation === "flow_trigger_remove" ? "Trigger removed." : payload.operation === "flow_trigger_pause" ? "Trigger paused." : "Trigger on again.", href: `/flows/${trigger.flow}` };
  }
  const card = store.getFlowCard(Number(req["card"]))!;
  if (payload.operation === "flow_card_comment" || payload.operation === "flow_card_assign" || payload.operation === "flow_card_watch") {
    const done = payload.operation === "flow_card_comment" ? commentOnFlowCard(store, card, actor, req["note"], now)
      : payload.operation === "flow_card_assign" ? assignFlowCard(store, card, typeof req["owner"] === "string" ? req["owner"] : null, actor, now)
      : watchFlowCard(store, card, actor, req["watching"] !== false, now);
    if (!done.ok) throw Error(done.message);
    return { said: done.said, href: flowCardHref(card.flow, card.id) };
  }
  const acted = payload.operation === "flow_card_move" ? moveCardInFlow(store, card, String(req["zone"]), actor, now)
    : payload.operation === "flow_card_cancel" ? cancelFlowCard(store, card, actor, now)
    : payload.operation === "flow_card_choose" ? (() => {
        const chosen = chooseFlowCard(store, { card: card.id, entry: Number(payload.state["entry"]), choice: Number.isSafeInteger(req["choice"]) ? Number(req["choice"]) - 1 : null,
          note: typeof req["note"] === "string" ? req["note"] : null, actor, where: "chat", repos, ...(root === undefined ? {} : { evidenceRoot: root }) }, now);
        return chosen.ok ? { ok: true as const, said: chosen.said, card: card.id } : { ok: false as const, message: chosen.message };
      })()
    : (() => {
        const decided = decideFlowCard(store, { card: card.id, decision: payload.operation === "flow_card_approve" ? "approve" : "send-back", note: typeof req["note"] === "string" ? req["note"] : null, actor, repos, ...(root === undefined ? {} : { evidenceRoot: root }) }, now);
        return decided.ok ? { ok: true as const, said: decided.said, card: card.id } : { ok: false as const, message: decided.message };
      })();
  if (!acted.ok) throw Error(acted.message);
  return settle(card.flow, acted.said, card.id);
}
