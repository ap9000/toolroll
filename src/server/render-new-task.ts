/**
 * New task (Wave E, src/design/KIT.md): one describe box, the project it lands in and "Read code before planning" in
 * the box's bottom row, the round send; every other choice behind More options; ideas under it. The form posts the
 * same fields /tasks/add has always read (title, repo, plan-first with planning-policy=choice, quality-mode, after,
 * goal, acceptance, not, touches, scout, id, permission-mode, projectRevision), so every server check is unchanged.
 */
import { html, joinHtml, postForm } from "../html.js";
import { projectName } from "../project.js";
import type { QualityMode } from "../quality.js";
import type { UnattendedPermissionMode } from "../scope.js";
import { type Chrome, screen, type Screen } from "./chrome.js";
import { btn, composer, disclose, doc, docHeader, dock, facts, field, ideas, input, note, phoneHeader, radios, select, sendButton, textarea, toggleChip } from "./kit.js";
import { fastTermsLines } from "../fast-terms.js";
import type { Scope } from "../scope.js";
import type { Store } from "../store.js";
import { TASK_TEXT_LIMITS } from "../task-text.js";

export type TaskComposerPrefill = { title: string; goal: string; not: string; touches: string; acceptance: string; values?: URLSearchParams };

const FORM_ID = "nt-form";
const PLAN_ON = "The agent reads the code and asks you anything unclear, then writes the plan.";
const PLAN_OFF = "The agent writes the plan straight from your words. Faster for small, obvious changes.";

/** The projects as the select offers them: names, with the parent folder when two share a name; the open one first
 * picked. Values are the paths the server proves. */
function projectItems(projects: readonly { path: string; name: string }[], open: string | null): Array<readonly [string, string]> {
  const all = open !== null && !projects.some(one => one.path === open) ? [{ path: open, name: projectName(open) }, ...projects] : [...projects];
  const counts = new Map<string, number>();
  for (const one of all) counts.set(one.name, (counts.get(one.name) ?? 0) + 1);
  return all.map(one => {
    if ((counts.get(one.name) ?? 0) < 2) return [one.path, one.name] as const;
    const parent = one.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? one.path;
    return [one.path, `${one.name} (${parent})`] as const;
  });
}

export function newTaskPage(
  chrome: Chrome,
  project: string | null,
  /** undefined: keep the revision the refused form posted (its draft), so a project switch since still refuses. */
  projectRevision: number | undefined,
  problem: string | null,
  candidates: { id: string; title: string }[] = [],
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
  projects: { path: string; name: string }[] = [],
  /** A shipped template's fields, or a refused filing's own words, back in the form. */
  prefill: TaskComposerPrefill | null = null,
  /** Words an idea's link put in the box (GET ?text=). */
  draft: string | null = null,
  /** Ideas for the chosen project: one tap drafts the words into the box. */
  suggestions: ReadonlyArray<{ label: string; draft: string }> = [],
  /** A link the lead or a person put in the address (GET ?from=). */
  fromLink: string | null = null,
): Screen {
  const head = html`${phoneHeader("New task", { back: "/tasks" })}`;
  const header = docHeader({ title: "New task", back: ["/tasks", "Tasks"], meta: "Nothing is built until you approve its plan.", same: true });
  const items = projectItems(projects, project);
  const values = prefill?.values;
  // No project to choose from: the task names its folder (the server proves it), and adding a project is one link away.
  const typed = items.length === 0;
  const chosen = values?.get("repo") ?? project ?? items[0]?.[0] ?? "";
  const planOn = values === undefined || values.get("plan-first") === "1";
  const quality = values?.get("quality-mode") ?? qualityDefault;
  const after = values?.get("after") ?? "";
  const permission = values?.get("permission-mode") === "bypassPermissions" ? "bypassPermissions" : values?.get("permission-mode") === "auto" ? "auto" : permissionDefault;
  const text = prefill?.title ?? draft ?? "";
  // More options opens on a template, or when a refused filing had used any of them.
  const optionsUsed = fromLink !== null || prefill !== null && (values === undefined || ["from", "goal", "acceptance", "not", "touches", "id", "after"].some(name => (values.get(name) ?? "") !== "") || values.get("scout") === "1");

  const folder = !typed ? "" : field({ id: "nt-repo", label: "Project folder", hint: "No projects yet: name the folder of a git repository.",
    control: input({ id: "nt-repo", name: "repo", value: chosen, hint: true, attrs: { required: true, placeholder: "/path/to/repository", autocapitalize: "none", spellcheck: "false" } }) });
  const bar = joinHtml([
    typed ? "" : select({ id: "nt-project", name: "repo", label: "Project", items, current: chosen, chip: true }),
    toggleChip({ id: "nt-plan", name: "plan-first", label: "Read code before planning", on: planOn, attrs: { value: "1" } }),
  ]);
  const box = composer({
    id: "nt", name: "title", label: "What should change?", placeholder: "What should change? One or two sentences is enough.",
    value: text, rows: 4, maxRows: 10, before: bar, error: problem,
    send: sendButton({ label: "File task" }),
    note: html`<span class="k-on-note">${PLAN_ON}</span><span class="k-off-note">${PLAN_OFF}</span>`,
    // The box holds what a title holds: a task's words are its title, and the planner reads nothing else of them when no
    // goal is given, so longer words would be lost, not kept. Filing's whole-word cut (task-text.ts titleWithin) is a
    // belt for other callers only.
    textAttrs: { maxlength: TASK_TEXT_LIMITS.title, autofocus: true },
  });
  const options = html`<div class="k-form">\
${field({ id: "nt-from", label: "From an issue or PR (optional)", hint: "A github.com link in this project. Its text becomes the plan, and you approve it.", control: input({ id: "nt-from", name: "from", value: values?.get("from") ?? fromLink ?? "", attrs: { placeholder: "https://github.com/…", autocapitalize: "none", spellcheck: "false", inputmode: "url" } }) })}\
${field({ id: "nt-quality", label: "Checks", control: select({ id: "nt-quality", name: "quality-mode", items: [["default", "Default checks"], ["strict", "Strict (release)"]], current: quality, wide: true }) })}\
${candidates.length === 0 ? "" : field({ id: "nt-after", label: "Starts", control: select({ id: "nt-after", name: "after", wide: true, current: after,
    items: [["", "Right away"], ...candidates.map(one => [one.id, `After ${one.id}: ${one.title}`] as const)] }) })}\
${field({ id: "nt-goal", label: "Goal (optional)", hint: "With requirements below, an unchanged plan can be approved automatically.", control: textarea({ id: "nt-goal", name: "goal", rows: 2, value: prefill?.goal ?? "", attrs: { placeholder: "What success looks like" } }) })}\
${field({ id: "nt-acceptance", label: "Acceptance", hint: "Needed with a goal. One per line: statement | evidence,kinds | how", control: textarea({ id: "nt-acceptance", name: "acceptance", rows: 2, value: prefill?.acceptance ?? "", attrs: { placeholder: "Requests over the limit return 429 | check" } }) })}\
${field({ id: "nt-not", label: "Not this (optional)", control: input({ id: "nt-not", name: "not", value: prefill?.not ?? "" }) })}\
${field({ id: "nt-touches", label: "Likely touches (optional)", hint: "Paths, separated by commas.", control: input({ id: "nt-touches", name: "touches", value: prefill?.touches ?? "", hint: true }) })}\
<div class="k-checks"><label><input type="checkbox" name="scout" value="1"${values?.get("scout") === "1" ? html` checked` : ""}>Research only: a read-only report, no code changes</label></div>\
${field({ id: "nt-id", label: "Task id (optional)", control: input({ id: "nt-id", name: "id", value: values?.get("id") ?? "", attrs: { placeholder: "Made from the request" } }) })}\
<div class="k-field"><span class="k-label">Agent permissions</span>${radios({ name: "permission-mode", legend: "Agent permissions", current: permission, items: [
    { value: "auto", label: "Auto", text: "Asks before risky actions." },
    { value: "bypassPermissions", label: "Full access", text: "Never asks and can change files anywhere on this computer. Trusted repositories only." },
  ] })}<p class="k-hint">From Settings. You can still change it on the plan before you approve.</p></div></div>`;

  const form = postForm("/tasks/add", joinHtml([
    prefill !== null && values === undefined ? note("Filled in from a template. Change anything; it still waits for your approval.") : "",
    folder,
    typed ? note(html`<a class="k-link" href="/projects?return=%2Ftasks%2Fnew">Add a project</a> to choose it here next time.`) : "",
    box,
    disclose("More options", options, optionsUsed),
  ]), {
    attrs: { class: "k-form k-dock-send", id: FORM_ID },
    projectRevision: projectRevision === undefined && values?.get("projectRevision") == null ? null : String(projectRevision ?? values?.get("projectRevision") ?? ""),
    hidden: { "planning-policy": "choice" },
  });
  const chosenName = items.find(([path]) => path === chosen)?.[1] ?? (chosen === "" ? "your project" : projectName(chosen));
  const ideaList = ideas({
    label: `Ideas for ${chosenName}`, into: "nt",
    items: suggestions.map(one => ({ label: one.label, draft: one.draft, href: `/tasks/new?text=${encodeURIComponent(one.draft)}` })),
  });
  const recipes = note(html`Work you do often? <a class="k-link" href="/recipes">Use a saved recipe</a>.`);
  return screen("New task", html`${head}${doc(header, form, ideaList, recipes)}${dock(btn("File task", { variant: "primary", type: "submit", attrs: { form: FORM_ID } }))}`, { chrome });
}

/** The terms as label and words: the lines every approval surface reads (fast-terms.ts), with nothing hidden. */
export function fastTermsRows(store: Store, scope: Scope, repo: string): ReadonlyArray<readonly [string, string]> {
  return fastTermsLines(store, scope, repo).map(line => [line.label, line.words] as const);
}

/** Build (docs/plans/plain-toolroll.md P2.4): the exact terms this small task would be approved on, and the one button
 * that approves them. The fields of "Plan it first" are the person's own words, on the ordinary road. */
export function fastStartPage(chrome: Chrome, input: { title: string; repo: string; preview: string; digest: string; terms: ReadonlyArray<readonly [string, string]> }): Screen {
  const head = html`${phoneHeader("Build this?", { back: "/tasks/new" })}`;
  const header = docHeader({ title: "Build this?", back: ["/tasks/new", "New task"], meta: "Build approves exactly these terms.", same: true });
  const build = postForm("/tasks/fast", btn("Build", { variant: "primary", type: "submit" }), { attrs: { class: "k-form", id: "fast-build" }, hidden: { preview: input.preview, digest: input.digest } });
  const plan = postForm("/tasks/add", btn("Plan it first", { type: "submit" }), { attrs: { class: "k-form" }, hidden: { plain: "1", title: input.title, repo: input.repo, "planning-policy": "choice", "plan-first": "1" } });
  return screen("Build this?", html`${head}${doc(header, facts(input.terms.map(([label, words]) => [label, joinHtml(words.split("\n").map(line => html`<div>${line}</div>`))] as const)), html`<div class="k-acts">${build}${plan}</div>`)}`, { chrome });
}

/** An issue or pull request, read and quoted before anything is filed. Add task files it for the ordinary approval. */
export function importPage(chrome: Chrome, input: { repo: string; url: string; title: string; body: string; kind: "issue" | "pull"; number: number; head: string | null }): Screen {
  const name = input.kind === "pull" ? `Pull request #${input.number}` : `Issue #${input.number}`;
  const head = html`${phoneHeader(name, { back: "/tasks/new" })}`;
  const header = docHeader({ title: name, back: ["/tasks/new", "New task"], meta: "Written outside Toolroll. You'll approve its plan before anything builds.", same: true });
  const file = postForm("/tasks/add", btn("Add task", { variant: "primary", type: "submit" }), { attrs: { class: "k-form" }, hidden: { from: input.url, repo: input.repo, title: input.title, ...(input.head === null ? {} : { "from-head": input.head }), "from-read": "1" } });
  return screen(name, html`${head}${doc(header, html`<blockquote class="k-quote"><p><strong>${input.title}</strong></p><p class="k-pre">${input.body === "" ? "No description." : input.body}</p></blockquote>`, file)}`, { chrome });
}
