/** Reusable work definitions. Recipes carry scope, never credentials or grants.
 * A preview freezes the exact copy to file; its durable receipt makes a retry
 * after a lost response return the same task or flow, even after a restart.
 * A repeating recipe (v115) makes a scheduled flow whose schedule starts paused. */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import { TEMPLATES } from "./templates.js";
import { hasDisguisedText, hasForbiddenControls } from "./decision.js";
import { parseAcceptanceCriteria } from "./scope.js";
import { validateTaskText, fileTaskProposal } from "./proposal.js";
import { createScheduledFlow, describeSchedule, firstFireAt, parseSchedule, standingTermsProblems } from "./flow-schedule.js";
import { applyModeToNewFiling } from "./plan-auto.js";
import { canonicalProject } from "./project.js";
import type { ContractIssue } from "./contracts/contract.js";
import { RECIPE_FORMAT, RECIPE_LIMITS, readRecipeDocument, type RecipeDocument, type RecipeInput } from "./contracts/recipes.js";
import { resolve } from "node:path";

export const RECIPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_recipe (
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  repo TEXT NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE INDEX IF NOT EXISTS workflow_recipe_project ON workflow_recipe(repo, id, revision DESC);
CREATE TRIGGER IF NOT EXISTS workflow_recipe_no_update BEFORE UPDATE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_recipe_no_delete BEFORE DELETE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TABLE IF NOT EXISTS workflow_preview (
  token TEXT PRIMARY KEY, actor TEXT NOT NULL, repo TEXT NOT NULL,
  document TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  -- routine_id: history (routines became scheduled flows in v115; the flow_id column is added after this runs).
  task_id TEXT REFERENCES task(id), routine_id INTEGER,
  saved_id TEXT, saved_revision INTEGER,
  CHECK(task_id IS NULL OR routine_id IS NULL),
  FOREIGN KEY(saved_id, saved_revision) REFERENCES workflow_recipe(id, revision)
);
CREATE INDEX IF NOT EXISTS workflow_preview_project ON workflow_preview(repo, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_preview_source ON workflow_preview(repo, source, created_at DESC)
WHERE task_id IS NOT NULL OR routine_id IS NOT NULL;
`;

export type { RecipeDocument, RecipeInput } from "./contracts/recipes.js";
export const RECIPE_INPUT_LIMIT = RECIPE_LIMITS.inputs;
export type RecipeAnswers = ReadonlyMap<string, string>;
export type Recipe = { id: string; revision: number; repo: string | null; document: RecipeDocument; digest: string; author: string };
export type WorkflowPreview = { token: string; actor: string; repo: string; document: RecipeDocument; digest: string; source: string; expiresAt: string; taskId: string | null; flowId: number | null; savedId: string | null; savedRevision: number | null };
export class RecipeError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
const honest = (text: string) => !hasForbiddenControls(text) && !hasDisguisedText(text);
const recipeProject = (repo: string) => canonicalProject(repo) ?? resolve(repo);

/** What a refusal at each top-level field tells the person, after the path-named line. */
const FIELD_ADVICE: Record<string, string> = {
  name: "Name, goal, exclusions, and allowed paths must be readable text.", description: "Name, goal, exclusions, and allowed paths must be readable text.",
  goal: "Name, goal, exclusions, and allowed paths must be readable text.", outOfScope: "Name, goal, exclusions, and allowed paths must be readable text.",
  touches: "Name, goal, exclusions, and allowed paths must be readable text.",
  planning: "Choose a supported planning and result type.", deliverable: "Choose a supported planning and result type.",
  schedule: "Choose a valid schedule.", costCeilingUsd: "The weekly budget must be a positive dollar amount.",
};
const FIELDS_MISMATCH = "Recipe fields do not match this version. Recipes contain work definitions, not permissions, credentials, or agent settings.";

/** The one refusal a recipe structure gets: its first path-named line, with the advice for that field. */
function structureError(issues: readonly ContractIssue[]): RecipeError {
  const top = issues.find(one => one.kind === "unknown-key" && one.path === "payload") ?? issues.find(one => one.kind === "required" && !/[.[]/.test(one.path));
  if (top !== undefined) return new RecipeError(`${top.line}. ${FIELDS_MISMATCH}`);
  const first = issues[0]!;
  const field = first.path.split(/[.[]/)[0]!;
  if (field === "acceptance") {
    if (issues.some(one => one.path.startsWith("acceptance") && one.kind === "unknown-key")) {
      return new RecipeError(`${issues.find(one => one.path.startsWith("acceptance") && one.kind === "unknown-key")!.line}. Success checks have unsupported fields.`);
    }
    return new RecipeError(issues.filter(one => one.path.startsWith("acceptance")).map(one => one.line).join("; "));
  }
  if (field === "inputs") {
    const advice = first.path === "inputs" ? "Add between 1 and 8 questions, or remove the empty questions to save a fixed recipe."
      : /\.key$/.test(first.path) ? "Give each question a unique key: lowercase letters, numbers, or underscores, starting with a letter (up to 32 characters)."
      : /\.label$/.test(first.path) ? "Give each question a readable label of up to 80 characters."
      : /\.defaultValue$/.test(first.path) && first.kind !== "required" ? "Default answers must be plain text up to 500 characters, without input placeholders."
      : "Questions contain only a key, label, and optional default answer.";
    return new RecipeError(`${first.line}. ${advice}`);
  }
  // Zod states `positive` as an exclusive minimum ("at least 0"); the advice says it plainly.
  if (field === "costCeilingUsd" && first.kind === "bad-value") return new RecipeError(`costCeilingUsd: ${FIELD_ADVICE[field]}`);
  return new RecipeError(`${first.line}. ${FIELD_ADVICE[field] ?? FIELDS_MISMATCH}`);
}

/** Reject unknown fields, including approval/provider settings, on import. */
export function parseRecipe(input: unknown): RecipeDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new RecipeError("Choose a recipe document.");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > RECIPE_LIMITS.documentBytes) throw new RecipeError("A recipe must be at most 32 KB.");
  const raw = input as Record<string, unknown>;
  if (raw.format !== RECIPE_FORMAT) throw new RecipeError("format: This recipe format/version is not supported.");
  if (raw.version !== 1 && raw.version !== 2) {
    const newer = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 2;
    throw new RecipeError(`version: ${newer ? `made by a newer Toolroll (version ${raw.version}). ` : ""}This recipe format/version is not supported.`);
  }
  const read = readRecipeDocument(raw);
  if (!read.ok) throw structureError(read.issues);
  const doc = read.value;
  if (doc.description.length > RECIPE_LIMITS.description || !honest(doc.description)) throw new RecipeError("description: Keep the description within 400 characters, without hidden text.");
  const bad = validateTaskText({ title: doc.name, goal: doc.goal, outOfScope: doc.outOfScope, touches: doc.touches });
  if (bad !== null) throw new RecipeError(bad.message);
  if (doc.schedule !== null && parseSchedule(doc.schedule) === null) throw new RecipeError("schedule: Choose a valid schedule.");
  if (doc.schedule === null && doc.costCeilingUsd !== null) throw new RecipeError("costCeilingUsd: A weekly budget applies to a repeating workflow. One-time work uses the project's task budget.");
  if (doc.deliverable === "report" && doc.schedule !== null) throw new RecipeError("deliverable: Report recipes run once. Repeating workflows currently produce code changes.");
  if (doc.schedule !== null && doc.planning === "required") throw new RecipeError("planning: Plan-first recipes run once. Repeating workflows reuse their approved scope; choose direct execution or run once.");
  const parsed = parseAcceptanceCriteria(raw.acceptance);
  if (parsed.problems.length > 0 || parsed.criteria.length === 0) throw new RecipeError(parsed.problems.map(one => one.message).join("; ") || "acceptance: Add at least one success check.");
  const fields = { format: RECIPE_FORMAT, name: doc.name.trim(), description: doc.description.trim(), goal: doc.goal.trim(), outOfScope: doc.outOfScope?.trim() || null,
    touches: [...doc.touches], acceptance: parsed.criteria, planning: doc.planning, deliverable: doc.deliverable, schedule: doc.schedule, costCeilingUsd: doc.costCeilingUsd } as const;
  // Keep v1's canonical key order stable: existing immutable digests must survive.
  const ordered: RecipeDocument = { format: fields.format, version: doc.version, name: fields.name, description: fields.description, goal: fields.goal,
    outOfScope: fields.outOfScope, touches: fields.touches, acceptance: fields.acceptance, planning: fields.planning, deliverable: fields.deliverable,
    schedule: fields.schedule, costCeilingUsd: fields.costCeilingUsd, ...(doc.version === 2 ? { inputs: parseRecipeInputs(doc.inputs) } : {}) } as RecipeDocument;
  if (ordered.version === 2) validateInputReferences(ordered);
  if (ordered.schedule !== null) {
    const problems = standingTermsProblems({ ...ordered, requirements: [], budgetPerRunMicrousd: null }, ordered.schedule);
    if (problems.length) throw new RecipeError(problems.join("; "));
  }
  return ordered;
}
export function importRecipe(text: string): RecipeDocument {
  if (Buffer.byteLength(text, "utf8") > RECIPE_LIMITS.documentBytes) throw new RecipeError("A recipe must be at most 32 KB.");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new RecipeError("That is not valid recipe JSON."); }
  return parseRecipe(value);
}
export const recipeDigest = (document: RecipeDocument): string => createHash("sha256").update(JSON.stringify(document)).digest("hex");
export const exportRecipe = (document: RecipeDocument): string => JSON.stringify(parseRecipe(document), null, 2) + "\n";

/** Inputs are literal work text, never a program, path grant, or shell fragment. Their shape is already read. */
function parseRecipeInputs(inputs: readonly RecipeInput[]): RecipeInput[] {
  const seen = new Set<string>();
  return inputs.map(({ key, label, defaultValue }, index) => {
    const at = `inputs[${index}]`;
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || ["constructor", "prototype"].includes(key) || seen.has(key)) throw new RecipeError(`${at}.key: Give each question a unique key: lowercase letters, numbers, or underscores, starting with a letter (up to 32 characters).`);
    if (!label.trim() || label.length > RECIPE_LIMITS.label || !honest(label)) throw new RecipeError(`${at}.label: Give each question a readable label of up to 80 characters.`);
    if (defaultValue !== null && (defaultValue.length > RECIPE_LIMITS.answer || !honest(defaultValue) || /\{\{|\}\}/.test(defaultValue))) throw new RecipeError(`${at}.defaultValue: Default answers must be plain text up to 500 characters, without input placeholders.`);
    seen.add(key);
    return { key, label: label.trim(), defaultValue: defaultValue === null ? null : defaultValue.trim() || null };
  });
}
const inputToken = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
function workTexts(document: RecipeDocument): string[] {
  return [document.name, document.description, document.goal, document.outOfScope ?? "", ...document.acceptance.map(one => one.statement)];
}
function validateInputReferences(document: RecipeDocument & { version: 2 }): void {
  const keys = new Set(document.inputs.map(input => input.key)), used = new Set<string>();
  for (const text of workTexts(document)) {
    const rest = text.replace(inputToken, (_, key: string) => {
      if (!keys.has(key)) throw new RecipeError(`Add a question for {{${key}}}, or remove that placeholder.`);
      used.add(key); return "";
    });
    if (/\{\{|\}\}/.test(rest)) throw new RecipeError("Use placeholders like {{module}}, matching a question key.");
  }
  if ([...document.touches, ...document.acceptance.map(one => one.how ?? "")].some(text => /\{\{|\}\}/.test(text))) throw new RecipeError("Use inputs in instructions and success checks. Allowed paths and check commands must stay fixed.");
  for (const key of keys) if (!used.has(key)) throw new RecipeError(`Use {{${key}}} in your instructions or success checks so its answer affects the work.`);
}
export function resolveRecipe(document: RecipeDocument, answers: RecipeAnswers): RecipeDocument & { version: 1 } {
  const parsed = parseRecipe(document);
  const inputs = parsed.version === 2 ? parsed.inputs : [];
  const known = new Set(inputs.map(input => input.key));
  for (const key of answers.keys()) if (!known.has(key)) throw new RecipeError("This recipe does not ask for that input. Reload it before continuing.");
  const values = new Map<string, string>();
  for (const input of inputs) {
    const value = (answers.has(input.key) ? answers.get(input.key)! : input.defaultValue ?? "").trim();
    if (!value) throw new RecipeError(`Answer “${input.label}” before previewing the work.`);
    if (value.length > 500 || !honest(value) || /\{\{|\}\}/.test(value)) throw new RecipeError(`“${input.label}” must be plain text up to 500 characters, without input placeholders.`);
    values.set(input.key, value);
  }
  if (parsed.version === 1) return parsed;
  const expand = (text: string) => text.replace(inputToken, (_, key: string) => values.get(key)!);
  const { inputs: _inputs, ...fields } = parsed;
  return parseRecipe({ ...fields, version: 1, name: expand(parsed.name), description: expand(parsed.description), goal: expand(parsed.goal), outOfScope: parsed.outOfScope === null ? null : expand(parsed.outOfScope),
    acceptance: parsed.acceptance.map(one => ({ ...one, statement: expand(one.statement) })) }) as RecipeDocument & { version: 1 };
}

/** Only the stored definition supplies scope; form answers cannot replace it. */
export function prepareRecipeRun(store: Store, actor: string, repo: string, id: string, revision: number, answers: RecipeAnswers, now: Date): WorkflowPreview {
  repo = recipeProject(repo);
  return store.transact(() => {
    access(store, actor, repo, true);
    const recipe = findRecipe(store, actor, repo, id, revision);
    if (recipe === null || recipe.repo === null) throw new RecipeError("This recipe is not available in this project.", 404);
    return createWorkflowPreview(store, actor, repo, resolveRecipe(recipe.document, answers), recipe.id, now);
  });
}

const titles: Record<string, string> = { "lint-sweep": "Clean up lint and types" };
export function starterRecipes(): Recipe[] {
  const recipes: Recipe[] = TEMPLATES.filter(one => one.kind !== "recipe").map(one => {
    const document = parseRecipe({ format: "standing-orders-recipe", version: 1, name: one.kind === "scheduled" ? one.title : titles[one.name] ?? one.name, description: one.purpose, goal: one.goal, outOfScope: one.outOfScope, touches: one.touches, acceptance: one.acceptance,
      planning: "skip", deliverable: "branch", schedule: one.kind === "scheduled" ? one.schedule : null, costCeilingUsd: null });
    return { id: one.name, revision: 1, repo: null, document, digest: recipeDigest(document), author: "Toolroll" };
  });
  for (const [id, document] of [
    ["small-feature", { name: "Ship a small feature", description: "Turn one clear outcome into a plan, a reviewed change, and evidence.", goal: "Implement one small feature. Describe the desired behavior here, including who uses it and what success looks like.", outOfScope: "No unrelated refactoring, dependency upgrades, deployment, or changes to existing public behavior.", planning: "required", deliverable: "branch", acceptance: [{ id: "c1", statement: "The requested behavior works and relevant regression tests pass.", how: null, evidence: ["check", "changed-path"] }] }],
    ["project-tour", { name: "Understand this project", description: "A useful first run: get a source-backed report before changing anything.", goal: "Map the project's entry points, major components, build and test commands, and one bounded improvement worth doing next. Cite the source paths behind each claim and distinguish confirmed facts from unknowns.", outOfScope: "No code or configuration changes, dependency installation, or publication.", planning: "skip", deliverable: "report", acceptance: [{ id: "c1", statement: "The report explains the entry points, components, build/test commands, and next improvement with source references and explicit unknowns.", how: null, evidence: ["manual-review"] }] }],
  ] as const) {
    const parsed = parseRecipe({ format: "standing-orders-recipe", version: 1, ...document, touches: [], schedule: null, costCeilingUsd: null });
    recipes.unshift({ id, revision: 1, repo: null, document: parsed, digest: recipeDigest(parsed), author: "Toolroll" });
  }
  return recipes;
}

function access(store: Store, actor: string, repo: string, write = false): void {
  if (!store.accountCanAccess(actor, repo) || (write && store.accountOf(actor)?.role !== "approver")) throw new RecipeError("This project is outside your current access.", 403);
}
function readRecipe(row: Record<string, unknown>): Recipe {
  const document = importRecipe(String(row.document));
  if (recipeDigest(document) !== row.digest) throw new RecipeError("The saved recipe does not match its recorded version.", 409);
  return { id: String(row.id), revision: Number(row.revision), repo: String(row.repo), document, digest: String(row.digest), author: String(row.author) };
}
export function savedRecipes(store: Store, actor: string, repo: string): Recipe[] {
  repo = recipeProject(repo);
  access(store, actor, repo);
  return store.handle.prepare(`SELECT r.* FROM workflow_recipe r WHERE repo=? AND revision=(SELECT MAX(revision) FROM workflow_recipe WHERE id=r.id) ORDER BY (SELECT MAX(p.created_at) FROM workflow_preview p WHERE p.repo=r.repo AND p.source=r.id AND (p.task_id IS NOT NULL OR p.routine_id IS NOT NULL OR p.flow_id IS NOT NULL)) DESC, created_at DESC, id LIMIT 100`).all(repo).map(readRecipe);
}
export function findRecipe(store: Store, actor: string, repo: string | null, id: string, revision?: number): Recipe | null {
  const starter = starterRecipes().find(one => one.id === id);
  if (starter !== undefined) return revision === undefined || revision === starter.revision ? starter : null;
  if (repo === null) return null;
  repo = recipeProject(repo);
  access(store, actor, repo);
  const row = revision === undefined ? store.handle.prepare("SELECT * FROM workflow_recipe WHERE repo=? AND id=? ORDER BY revision DESC LIMIT 1").get(repo, id)
    : store.handle.prepare("SELECT * FROM workflow_recipe WHERE repo=? AND id=? AND revision=?").get(repo, id, revision);
  return row === undefined ? null : readRecipe(row);
}
export function createWorkflowPreview(store: Store, actor: string, repo: string, document: RecipeDocument, source: string, now: Date): WorkflowPreview {
  repo = recipeProject(repo);
  const parsed = parseRecipe(document);
  if (!/^[a-z0-9-]{1,48}$/.test(source)) throw new RecipeError("Unknown recipe source.");
  return store.transact(() => {
    access(store, actor, repo, true);
    store.handle.prepare("DELETE FROM workflow_preview WHERE actor=? AND expires_at<? AND task_id IS NULL AND routine_id IS NULL AND flow_id IS NULL AND saved_id IS NULL").run(actor, now.toISOString());
    const count = store.handle.prepare("SELECT COUNT(*) n FROM workflow_preview WHERE actor=? AND expires_at>? AND task_id IS NULL AND routine_id IS NULL AND flow_id IS NULL AND saved_id IS NULL").get(actor, now.toISOString());
    if (Number(count?.n) >= 30) throw new RecipeError("You have 30 open previews. Use one or let it expire before making another.", 429);
    const token = randomBytes(16).toString("hex");
    store.handle.prepare("INSERT INTO workflow_preview(token,actor,repo,document,digest,source,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(token, actor, repo, JSON.stringify(parsed), recipeDigest(parsed), source, now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString());
    return workflowPreview(store, actor, repo, token)!;
  });
}
export function workflowPreview(store: Store, actor: string, repo: string, token: string): WorkflowPreview | null {
  repo = recipeProject(repo);
  access(store, actor, repo);
  const row = store.handle.prepare("SELECT * FROM workflow_preview WHERE token=? AND actor=? AND repo=?").get(token, actor, repo);
  if (row === undefined) return null;
  const document = importRecipe(String(row.document));
  if (recipeDigest(document) !== row.digest) throw new RecipeError("This preview has changed. Make a fresh preview.", 409);
  return { token, actor, repo, document, digest: String(row.digest), source: String(row.source), expiresAt: String(row.expires_at), taskId: row.task_id as string | null, flowId: row.flow_id == null ? null : Number(row.flow_id), savedId: row.saved_id as string | null, savedRevision: row.saved_revision as number | null };
}
function currentPreview(store: Store, actor: string, repo: string, token: string): WorkflowPreview {
  access(store, actor, repo, true);
  const preview = workflowPreview(store, actor, repo, token);
  if (preview === null) throw new RecipeError("No preview in this project. Preview the workflow again.", 404);
  return preview;
}
export function launchWorkflow(store: Store, actor: string, repo: string, token: string, now: Date, operatorFiling: boolean): { taskId: string | null; flowId: number | null } {
  repo = recipeProject(repo);
  return store.transact(() => {
    const preview = currentPreview(store, actor, repo, token);
    if (preview.taskId !== null || preview.flowId !== null) return { taskId: preview.taskId, flowId: preview.flowId };
    if (preview.expiresAt <= now.toISOString()) throw new RecipeError("This preview expired. Preview it again before creating work.", 409);
    const d = preview.document;
    if (d.version === 2) throw new RecipeError("Answer the recipe questions and preview the filled-in work before creating it.", 409);
    const provenance = `recipe:${preview.savedId ?? preview.source}`;
    let taskId: string | null = null, flowId: number | null = null;
    if (d.schedule === null) {
      const made = fileTaskProposal(store, { id: `workflow-${token}`, title: d.name, repo, goal: d.goal, outOfScope: d.outOfScope, touches: d.touches, acceptance: d.acceptance, planning: d.planning, deliverable: d.deliverable, filedVia: provenance, filedBy: { name: actor, kind: "person" as const }, admittedRepos: [repo] }, now);
      if (!made.ok) throw new RecipeError(made.message, made.reason === "backlog-full" ? 429 : 400);
      taskId = made.id;
      if (operatorFiling) applyModeToNewFiling(store, taskId, actor, now);
    } else {
      const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workflow";
      // A scheduled flow whose schedule starts paused: nothing repeats until a person turns it on.
      const made = createScheduledFlow(store, { repo, name: d.name, stem: `${slug}-${token.slice(0, 8)}`, schedule: d.schedule, by: actor,
        terms: { goal: d.goal, outOfScope: d.outOfScope, touches: d.touches, requirements: [], acceptance: d.acceptance, budgetPerRunMicrousd: null, costCeilingUsd: d.costCeilingUsd } }, now);
      if (!made.ok) throw new RecipeError(made.message);
      flowId = made.flow;
    }
    store.handle.prepare("UPDATE workflow_preview SET task_id=?,flow_id=? WHERE token=?").run(taskId, flowId, token);
    store.recordAction({ at: now.toISOString(), actor, repo, taskId, runId: null, action: "workflow created", outcome: flowId === null ? "task" : "scheduled flow", source: "work" });
    return { taskId, flowId };
  });
}
export function saveWorkflowRecipe(store: Store, actor: string, repo: string, token: string, now: Date): Recipe {
  repo = recipeProject(repo);
  return store.transact(() => {
    const preview = currentPreview(store, actor, repo, token);
    if (preview.savedId !== null) return findRecipe(store, actor, repo, preview.savedId, preview.savedRevision!)!;
    if (preview.expiresAt <= now.toISOString()) throw new RecipeError("This preview expired. Preview it again before saving.", 409);
    const id = randomBytes(12).toString("hex");
    store.handle.prepare("INSERT INTO workflow_recipe(id,revision,repo,document,digest,author,created_at) VALUES (?,1,?,?,?,?,?)").run(id, repo, JSON.stringify(preview.document), preview.digest, actor, now.toISOString());
    store.handle.prepare("UPDATE workflow_preview SET saved_id=?,saved_revision=1 WHERE token=?").run(id, token);
    store.recordAction({ at: now.toISOString(), actor, repo, taskId: null, runId: null, action: "recipe saved", outcome: "saved", source: "work" });
    return findRecipe(store, actor, repo, id, 1)!;
  });
}
export function workflowSteps(document: RecipeDocument): { title: string; detail: string }[] {
  return [
    { title: "Authorize", detail: document.schedule === null ? "Your project policy applies. Without a matching policy, review and approve the scope first." : "Turn the schedule on when you're ready. Each run waits for approval under your project's rules." },
    ...(document.deliverable === "report" ? [{ title: "Investigate", detail: "Inspect the project and return a source-backed report." }] : [
      ...(document.schedule === null && document.planning !== "skip" ? [{ title: "Plan", detail: document.planning === "required" ? "Inspect the repository and plan before building." : "Plan first when the scope calls for repository discovery." }] : []),
      { title: "Build", detail: "Work in an isolated branch within the agreed scope." },
      { title: "Verify", detail: "Check each success criterion and retain its evidence." },
    ]),
    { title: "Open result", detail: "See the report or change, its checks, and unresolved questions. Agent review follows your project policy; publishing requires separate authority." },
  ];
}
export function recipeScheduleWords(document: RecipeDocument, now: Date): string {
  if (document.schedule === null) return "Once, after its approval and readiness gates pass";
  const schedule = parseSchedule(document.schedule)!;
  return `${describeSchedule(schedule)}, one at a time (first ${firstFireAt(schedule, now)} if turned on now). Nothing repeats until you turn the schedule on.`;
}
