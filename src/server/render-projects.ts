/**
 * Projects on the kit (src/design/KIT.md): the list's server parts (the add ways, the clone review), the project's
 * reading page, folder browse and the GitHub listing. Names, descriptions and paths are gh or filesystem data,
 * escaped at the sink like everything else (html.ts).
 */
import { advancedShownNow } from "../advanced-view.js";
import { ACTIVITY_ACTORS, activityAge, activityLimit, activityMetrics, activityScope } from "../project-activity.js";
import { type BrowserProjectRow, type BrowserProjectsView } from "../browser-workspace.js";
import { html, htmlString, joinHtml, postForm, type Html, type HtmlValue } from "../html.js";
import { type ListOutcome } from "../onboard.js";
import { type ProjectOutcomes } from "../project-outcomes.js";
import { projectName } from "../project.js";
import { homedir } from "node:os";
import { type Chrome, relativeAge, screen, type Screen } from "./chrome.js";
import {
  acts, approvalFactsNow, approvalTerms, approveForm, btn, chip, count, disclose, doc, docHeader, dock, empty, facts, field, group, infoLine, input,
  linkTabs, note, notice, pageHeader, phoneHeader, row, slots, status,
} from "./kit.js";
import { type OnboardCardState, type ProjectPeek } from "./render-pages.js";

/** A path as a person reads it: the home folder as ~. */
export function shortPathOf(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A project's page address. Names are folder names, so two projects can share one: then the path picks. */
export function projectHref(name: string, path: string, ambiguous: boolean, page = ""): string {
  return `/projects/${encodeURIComponent(name)}${page === "" ? "" : `/${page}`}${ambiguous ? `?path=${encodeURIComponent(path)}` : ""}`;
}

/** What a project's counts say on one line ("2 need you · 1 running"); null when it wasn't scanned. */
export function peekWords(peek: ProjectPeek | null): string | null {
  if (peek === null) return null;
  // What waits on you is said once, by the row's chip ("2 waiting on you"); the line keeps the neutral facts.
  const words = [
    peek.running > 0 ? `${peek.running} running` : "",
    peek.queued > 0 ? `${peek.queued} queued` : "",
  ].filter(Boolean);
  return words.length === 0 ? peek.waiting > 0 ? "" : "Nothing waiting" : words.join(" · ");
}

const mono = (text: string): Html => html`<span class="k-mono">${text}</span>`;
const sentence = (text: string): string => text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
/** A refusal says what didn't change. */
const refused = (text: string): string => /nothing (changed|was)/i.test(text) ? sentence(text) : `${sentence(text).replace(/[.\s]+$/, "")}. Nothing changed.`;

/** Where a message belongs: next to the GitHub link, in the clone review, the page's own refusal, or a neutral line
 * (a finished clone). */
export type ProblemAt = "link" | "clone" | "open" | "path" | "said" | null;

/** The "From this computer" part's own facts: whether this person may add a repository outside the projects folder (an
 * approver signed in with a password, who types it again). */
export type AddLocalFacts = {
  outside: boolean;
  /** Browse… : the repository picker over this computer's folders (an approver's read). */
  pick: boolean;
  /** The exact-path form's refusal, said at the top of its section, and what was typed (kept in the field). */
  pathProblem: string | null;
  pathValue: string;
};

// ---- the list's server parts -------------------------------------------------------------------------------------

/** The add ways, as the drawer (and the no-script page) shows them: GitHub, then this computer. */
export function addWaysHtml(data: { browsable: boolean; onboard: OnboardCardState | null; returnTo: string; linkProblem: string | null; local?: AddLocalFacts }): Html {
  const local = data.local ?? { outside: false, pick: false, pathProblem: null, pathValue: "" };
  const onboard = data.onboard;
  const github = onboard === null
    ? null
    : html`<section class="k-sec" aria-labelledby="add-gh"><h3 id="add-gh">From GitHub</h3>${!onboard.enabled
      ? note(sentence(onboard.why))
      : joinHtml([
        acts(btn("Choose a GitHub repository", { sm: true, href: "/projects/github" })),
        postForm("/projects/onboard-preview", joinHtml([
          field({ id: "add-link", label: "Or paste a GitHub link", hint: "You review it before anything is downloaded.", error: data.linkProblem === null ? null : refused(data.linkProblem),
            control: input({ id: "add-link", name: "repo", hint: true, error: data.linkProblem !== null, attrs: { placeholder: "owner/name or https://github.com/owner/name", autocomplete: "off", spellcheck: "false" } }) }),
          onboard.roots.length > 1
            ? field({ id: "add-root", label: "Clone into", control: html`<span class="k-selw wide"><select class="k-sel" id="add-root" name="root">${onboard.roots.map((one, index) => html`<option value="${index}">${shortPathOf(one)}</option>`)}</select></span>` })
            : html`<input type="hidden" name="root" value="0">`,
          acts(btn("Review", { sm: true, type: "submit" })),
          onboard.roots.length === 1 ? note(html`Clones into ${mono(shortPathOf(onboard.roots[0] ?? ""))}.`) : "",
        ]), { attrs: { class: "k-sec" } }),
      ])}</section>`;
  const thisComputer = html`<section class="k-sec" aria-labelledby="add-local"><h3 id="add-local">From this computer</h3>${joinHtml([
    // A refused path is said first, where the person is looking, not as a small line under the field.
    local.pathProblem === null ? "" : notice(refused(local.pathProblem)),
    local.pick ? acts(btn("Browse…", { sm: true, href: "/projects/pick" }))
      : data.browsable ? acts(btn("Choose a folder", { sm: true, href: "/projects/browse" })) : "",
    postForm("/projects/open", joinHtml([
      field({ id: "add-path", label: "Or enter an exact path",
        hint: local.outside ? "Add any git repository on this computer — outside your projects folder, Toolroll asks for your password." : "It must be a git repository.",
        error: null,
        control: input({ id: "add-path", name: "path", hint: true, error: local.pathProblem !== null, value: local.pathValue, attrs: { placeholder: "~/code/your-repo", autocomplete: "off", spellcheck: "false", autocapitalize: "none" } }) }),
      local.outside ? field({ id: "add-password", label: "Your password",
        control: html`<input class="k-input" id="add-password" type="password" name="password" data-so-typed autocomplete="current-password">` }) : "",
      acts(btn("Add and open", { sm: true, type: "submit", variant: "primary" })),
    ]), { attrs: { class: "k-sec" }, returnTo: data.returnTo, hidden: { via: "path" } }),
  ])}</section>`;
  return html`<div class="k-sec">${github ?? ""}${thisComputer}</div>`;
}

/** The clone review a preview minted (single use, ten minutes): what lands where, then the step-up. */
export function cloneReviewHtml(onboard: OnboardCardState | null, problem: string | null): Html | null {
  if (onboard === null || !onboard.enabled || onboard.record === null) return null;
  const [nonce, record] = onboard.record;
  const kind = "step-up" as const;
  // The local owner has no password to type: the clone is its own act (add-project), proved by the session at confirm.
  const local = onboard.localOwner === true;
  const factsNow = local ? { ...approvalFactsNow(), passwordless: true } : approvalFactsNow();
  const size = record.diskUsageKib === null ? "Unknown" : `${Math.max(1, Math.round(record.diskUsageKib / 1024))} MiB`;
  const bigOk = record.large
    ? html`<div class="k-checks"><label><input type="checkbox" name="big-ok" value="1" required>${record.nameWithOwner} is ${record.diskUsageKib === null ? "of unknown size" : size}. Clone it anyway</label></div>`
    : html``;
  return html`${slots({
    status: html`<h2>Clone ${record.nameWithOwner}</h2>`,
    text: html`Review before anything is downloaded. Clones into ${mono(shortPathOf(record.target))} and adds it as a project. Large-file (LFS) objects aren’t downloaded.`,
    acts: approveForm({ action: "/projects/onboard-confirm", kind, facts: factsNow, label: "Clone and add", form: { hidden: { nonce } }, before: bigOk }),
    terms: `${local ? "No password needed on this computer." : approvalTerms(kind, factsNow)} The review expires in 10 minutes.`,
    err: problem === null ? null : refused(problem),
    attrs: { "aria-label": `Clone ${record.nameWithOwner}` },
  })}${facts([["Repository", mono(`github.com/${record.nameWithOwner}`)], ["Size", size], ["Into", mono(shortPathOf(record.target))]])}`;
}

/** The projects list: the React view draws it from `workspace.view`; the body is the same page for a browser
 * without the workspace script (and what the sensitivity check reads). */
export function projectsPage(chrome: Chrome, data: {
  recent: readonly { path: string; name: string; lastOpenedAt: string }[];
  candidates: readonly string[];
  open: string | null;
  problem: string | null;
  problemAt: ProblemAt;
  browsable: boolean;
  onboard: OnboardCardState | null;
  peeks: Readonly<Record<string, ProjectPeek | null>>;
  returnTo: string;
  local?: Omit<AddLocalFacts, "pathProblem">;
}): Screen {
  const choosing = data.returnTo.startsWith("/tasks/new");
  const names = new Map<string, number>();
  for (const name of [...data.recent.map(one => one.name), ...data.candidates.map(projectName)]) names.set(name, (names.get(name) ?? 0) + 1);
  const rowOf = (path: string, name: string, openedAt: string | null): BrowserProjectRow => {
    const peek = data.peeks[path] ?? null;
    return {
      name, path, shortPath: shortPathOf(path), href: projectHref(name, path, (names.get(name) ?? 0) > 1),
      open: data.open !== null && data.open === path, openedAt,
      status: peek === null ? null : peek.waiting > 0 ? "needs" : peek.running > 0 ? "running" : null,
      waiting: peek?.waiting ?? 0,
      summary: peekWords(peek),
    };
  };
  const recent = data.recent.map(one => rowOf(one.path, one.name, one.lastOpenedAt));
  const available = data.candidates.map(path => rowOf(path, projectName(path), null));
  const linkProblem = data.problemAt === "link" ? data.problem : null;
  const review = cloneReviewHtml(data.onboard, data.problemAt === "clone" ? data.problem : null);
  const reviewHasProblem = review !== null && data.problemAt === "clone";
  const said = data.problemAt === "said" && data.problem !== null ? sentence(data.problem) : null;
  const pathProblem = data.problemAt === "path" ? data.problem : null;
  const topProblem = data.problem === null || said !== null || linkProblem !== null || pathProblem !== null || reviewHasProblem ? null : data.problemAt === "clone" ? sentence(data.problem) : refused(data.problem);
  const addHtml = addWaysHtml({ browsable: data.browsable, onboard: data.onboard, returnTo: data.returnTo, linkProblem,
    ...(data.local === undefined ? {} : { local: { ...data.local, pathProblem } }) });

  // Without the workspace script: the same rows, the add ways as a section.
  const rowHtml = (one: BrowserProjectRow): Html => row({
    href: one.href, chip: one.status === null ? html`` : one.status === "needs" ? chip(waitingWords(one.waiting), "ask") : status(one.status), title: one.name, wait: one.status === "needs",
    desc: mono(one.shortPath), meta: html`<span>${one.summary ?? "Not scanned"}</span>${one.open ? html`<span>Open now</span>` : ""}`,
    action: one.open && !choosing ? btn("New task", { sm: true, href: "/tasks/new" })
      : postForm("/projects/open", btn(choosing ? "Choose" : "Open", { sm: true, type: "submit" }), { returnTo: data.returnTo, hidden: { path: one.path } }),
  });
  const title = choosing ? "New task" : "Projects";
  const body = joinHtml([
    pageHeader(title, { ...(choosing ? { ctx: "Choose the project it belongs to" } : {}) }),
    topProblem === null ? null : notice(topProblem),
    said === null ? null : infoLine(said),
    review,
    recent.length > 0 ? html`<section aria-label="Projects" data-project-list>${group("Projects", count(recent.length))}${recent.map(rowHtml)}</section>` : null,
    available.length > 0 ? html`<section aria-label="Available" data-project-list>${group("Available", count(available.length))}${available.map(rowHtml)}</section>` : null,
    recent.length === 0 && available.length === 0 ? empty({ title: "No projects yet.", text: "A project is a git repository your agents work in." }) : null,
    html`<section class="k-doc" id="add-project" aria-label="Add a project">${addHtml}</section>`,
  ], "\n");
  return screen(title, body, { chrome, workspace: { view: {
    kind: "projects", choosing, problem: topProblem, said, returnTo: data.returnTo, recent, available,
    add: { html: htmlString(addHtml), review: review === null ? null : htmlString(review), openOnLoad: linkProblem !== null || pathProblem !== null },
  } satisfies BrowserProjectsView } });
}

// ---- one project ---------------------------------------------------------------------------------------------------

export type ProjectPageTask = { href: string; title: string; reason: string; needs: boolean; since: string | null };

function activityHtml(report: ProjectOutcomes | null): Html {
  if (report === null) return notice("Activity is unavailable right now. Nothing changed. Reload the page to try again.");
  const familyLine = (one: ProjectOutcomes["families"][number]): Html => row({
    href: one.href, chip: html``, title: one.title,
    desc: `${one.actor === null ? one.state === "ready" ? "Ready" : "History unavailable" : ACTIVITY_ACTORS[one.actor]} · ${one.kind} · Recorded checks: ${one.checks}`,
    meta: one.state === "completed" ? html`<span class="k-num">${activityAge(one.elapsedMs)}</span>` : "",
  });
  return html`${note(activityScope(report))}${report.truncated ? note(activityLimit(report)) : ""}${activityMetrics(report).map(metric =>
    disclose(`${metric.label} · ${metric.value}`, html`${note(metric.detail)}${metric.rows.length === 0 ? note("No tasks in this group.") : metric.rows.map(familyLine)}`))}`;
}

/** One project's reading page. Reads only: Open project posts to /projects/select, which switches this session. */
export function projectPage(chrome: Chrome, data: {
  name: string;
  path: string;
  selfHref: string;
  open: boolean;
  openedAt: string | null;
  peek: ProjectPeek | null;
  tasks: readonly ProjectPageTask[];
  moreTasks: number;
  checks: { href: string; level: string } | null;
  pullRequests: { href: string; on: boolean } | null;
  knowledgeHref: string;
  flakyHref: string;
  settingsHref: string | null;
  activity: { report: ProjectOutcomes | null } | null;
  now: Date;
}): Screen {
  const opened = data.open ? "Open now" : data.openedAt === null ? "Not opened here yet" : `Opened ${relativeAge(data.openedAt, data.now)}`;
  // The one primary: in the header at a desk, in the dock on a phone (the dock's button submits the header's form).
  const primary = data.open
    ? btn("New task", { variant: "primary", lead: "plus", href: "/tasks/new", className: "k-desk-only" })
    : postForm("/projects/select", btn("Open project", { variant: "primary", type: "submit", className: "k-desk-only" }), { returnTo: data.selfHref, hidden: { path: data.path }, attrs: { id: "project-open" } });
  const docked = data.open
    ? btn("New task", { variant: "primary", lead: "plus", href: "/tasks/new" })
    : btn("Open project", { variant: "primary", type: "submit", attrs: { form: "project-open" } });
  const peek = data.peek;
  const countWords = (n: number, words: string, href: string): Html => data.open && n > 0 ? html`<a class="k-link" href="${href}">${String(n)} ${words}</a>` : html`<span>${String(n)} ${words}</span>`;
  const counts = peek === null
    ? note("Not scanned yet.")
    : html`<p>${joinHtml([
      countWords(peek.waiting, peek.waiting === 1 ? "needs you" : "need you", "/tasks"),
      countWords(peek.running, "running", "/tasks"),
      countWords(peek.queued, "queued", "/tasks?view=order"),
      countWords(peek.doneRecently, "built today", "/tasks?view=done"),
    ], " · ")}</p>`;
  const tasks = data.tasks.length === 0
    ? note(`Nothing needs you or is running in ${data.name}.`)
    : html`${data.tasks.map(task => row({
      href: task.href, chip: task.needs ? status("needs") : status("running"), title: task.title, desc: task.reason, wait: task.needs,
      meta: task.since === null ? "" : html`<span class="k-num">${relativeAge(task.since, data.now)}</span>`,
    }))}${data.moreTasks > 0 ? note(data.open ? html`<a class="k-link" href="/tasks">${data.moreTasks} more in Tasks</a>` : `${data.moreTasks} more`) : ""}`;
  const setup = facts([
    ["Folder", mono(data.path)],
    ...(data.checks === null ? [] : [["Checks", html`<a class="k-link" href="${data.checks.href}">${data.checks.level}</a>`] as const]),
    ...(data.pullRequests === null ? [] : [["Pull requests", html`<a class="k-link" href="${data.pullRequests.href}">${data.pullRequests.on ? "On" : "Off"}</a>`] as const]),
    ["Knowledge", html`<a class="k-link" href="${data.knowledgeHref}">Open knowledge</a>`],
    // Settings → Advanced off: the code map and flaky tests rows go (Settings → Advanced points to them).
    ...(advancedShownNow() ? [
      ["Code map", html`<a class="k-link" href="${`/projects/${encodeURIComponent(data.name)}/map${data.selfHref.includes("?") ? data.selfHref.slice(data.selfHref.indexOf("?")) : ""}`}">Open code map</a>`] as const,
      ["Flaky tests", html`<a class="k-link" href="${data.flakyHref}">Open flaky tests</a>`] as const,
    ] : []),
  ]);
  const body = joinHtml([
    phoneHeader(data.name, { back: "/projects" }),
    doc(
      docHeader({ back: ["/projects", "Projects"], title: data.name, meta: html`${mono(shortPathOf(data.path))} · ${opened}`, right: primary, same: true }),
      html`<section class="k-sec" aria-labelledby="p-now"><h3 id="p-now">Now</h3>${counts}</section>`,
      html`<section class="k-sec" aria-labelledby="p-tasks"><h3 id="p-tasks">Tasks</h3>${tasks}</section>`,
      html`<section class="k-sec" aria-labelledby="p-setup"><h3 id="p-setup">Setup</h3>${setup}${data.settingsHref === null ? "" : note(html`Network access, the sandbox and removing the project are in <a class="k-link" href="${data.settingsHref}">Settings → Project</a>.`)}</section>`,
      data.activity === null ? "" : html`<section class="k-sec" aria-labelledby="p-activity"><h3 id="p-activity">Activity</h3>${activityHtml(data.activity.report)}</section>`,
    ),
    dock(docked),
  ], "\n");
  return screen(data.name, body, { chrome });
}

// ---- folder browse -----------------------------------------------------------------------------------------------

export function browsePage(chrome: Chrome, data: {
  at: string;
  root: string;
  roots: readonly string[];
  parent: string | null;
  entries: readonly { name: string; path: string; git: boolean }[];
  /** Projects already added here: their row says Open, not Add and open. */
  registered: ReadonlySet<string>;
}): Screen {
  const browseHref = (path: string): string => `/projects/browse?at=${encodeURIComponent(path)}`;
  const here = data.at === data.root ? shortPathOf(data.root) : `${shortPathOf(data.root)}${data.at.slice(data.root.length)}`;
  const openForm = (path: string, label: string): Html =>
    postForm("/projects/open", btn(label, { sm: true, type: "submit" }), { hidden: { path } });
  const rows = data.entries.length === 0
    ? note("This folder has no folders inside.")
    : html`${data.entries.map(one => row({
      href: browseHref(one.path), chip: html``, title: one.name,
      desc: data.registered.has(one.path) ? "Project" : one.git ? "Git repository" : "Folder",
      action: one.git ? openForm(one.path, data.registered.has(one.path) ? "Open" : "Add and open") : btn("Open folder", { sm: true, variant: "ghost", href: browseHref(one.path) }),
    }))}`;
  const body = joinHtml([
    phoneHeader("Choose a folder", { back: "/projects" }),
    doc(
      docHeader({ back: ["/projects", "Projects"], title: "Choose a folder", meta: mono(here), same: true,
        ...(data.parent === null ? {} : { right: btn("Up one folder", { sm: true, variant: "ghost", lead: "back", href: browseHref(data.parent) }) }) }),
      data.roots.length > 1 ? linkTabs("Projects folders", data.root, data.roots.map(one => ({ key: one, label: projectName(one), href: browseHref(one) }))) : "",
      html`<div>${rows}</div>`,
      note(html`Git repositories are listed first and can be added. Showing folders under ${mono(shortPathOf(data.root))}.`),
    ),
  ], "\n");
  return screen("Choose a folder", body, { chrome });
}

// ---- the GitHub listing --------------------------------------------------------------------------------------------

/** The account's repositories with ONE honest action each: open (already a project here), add and open (a clone
 * under a projects folder), or the existing preview-and-password clone ceremony. */
export function githubReposPage(chrome: Chrome, data: {
  /** The last listing; null until someone lists (a POST: listing asks GitHub, so a page visit never does). */
  listed: ListOutcome | null;
  local: ReadonlyMap<string, string>;
  registered: ReadonlySet<string>;
  cloneReady: boolean;
  openProject: string | null;
  /** A projects folder didn't answer in time: local copies weren't matched this time. */
  localUnanswered?: boolean;
  now: Date;
}): Screen {
  const openForm = (path: string, label: string): Html =>
    postForm("/projects/open", btn(label, { sm: true, type: "submit" }), { hidden: { path } });
  const cloneForm = (nameWithOwner: string): Html =>
    postForm("/projects/onboard-preview", btn("Clone here", { sm: true, type: "submit" }), { hidden: { repo: nameWithOwner, root: "0" } });
  const list = (label: string, primary: boolean): Html =>
    postForm("/projects/github", btn(label, { sm: true, variant: primary ? "primary" : "outline", type: "submit" }));
  const listed = data.listed;
  const instead = btn("Choose a folder instead", { sm: true, variant: "ghost", href: "/projects/browse" });
  const rows = listed === null
    ? empty({ title: "Your repositories aren’t listed yet.", text: "Toolroll asks the GitHub CLI signed in on this computer.", action: acts(list("List repositories", true)) })
    : !listed.ok
      ? listed.reason === "gh-missing"
        ? empty({ title: "The GitHub CLI isn’t installed on this computer.", text: "Install gh on the computer running Toolroll (brew install gh), sign in with gh auth login, then check again.", action: acts(list("Check again", false), instead) })
        : listed.reason === "gh-auth"
          ? empty({ title: "The GitHub CLI isn’t signed in.", text: "In a terminal on the computer running Toolroll, run gh auth login, then check again.", action: acts(list("Check again", false), instead) })
          : html`${notice(`${sentence(listed.message)}. Nothing changed.`)}${acts(list("Try again", false))}`
      : listed.repos.length === 0
        ? empty({ title: "No repositories to list.", text: "The GitHub account signed in on this computer has none." })
        : html`${group("Repositories", count(listed.repos.length))}${listed.repos.map(repo => {
          const localPath = data.local.get(repo.nameWithOwner.toLowerCase()) ?? null;
          const action = localPath !== null && data.openProject === localPath
            ? btn("Open now", { sm: true, variant: "ghost", href: projectHref(projectName(localPath), localPath, false) })
            : localPath !== null
              ? openForm(localPath, data.registered.has(localPath) ? "Open" : "Add and open")
              : data.cloneReady
                ? cloneForm(repo.nameWithOwner)
                : html`<span class="k-muted">Choose a projects folder first</span>`;
          const where = localPath === null
            ? `${repo.isPrivate ? "Private" : "Public"}${/^\d{4}-\d{2}-\d{2}T/.test(repo.updatedAt) ? ` · updated ${relativeAge(repo.updatedAt, data.now)}` : ""}`
            : data.registered.has(localPath) ? html`Project ${mono(projectName(localPath))}` : html`Already cloned at ${mono(shortPathOf(localPath))}`;
          return row({ href: `https://github.com/${repo.nameWithOwner}`, chip: html``, title: repo.nameWithOwner,
            desc: repo.description === "" ? where : html`${repo.description} · ${where}`, action });
        })}`;
  const body = joinHtml([
    phoneHeader("Add from GitHub", { back: "/projects" }),
    doc(
      docHeader({ back: ["/projects", "Projects"], title: "Add from GitHub", meta: "Repositories the GitHub CLI on this computer can see.", same: true,
        ...(listed === null ? {} : { right: list("Refresh list", false) }) }),
      data.localUnanswered === true ? notice("Your projects folder didn’t answer, so copies already on this computer aren’t matched yet. Try again in a moment.") : "",
      html`<div>${rows}</div>`,
    ),
  ], "\n");
  return screen("Add from GitHub", body, { chrome });
}

/** A project name nobody can see answers the same as one that doesn't exist. */
export const unknownProject = (name: string): { title: string; text: string } =>
  ({ title: `There is no project called ${name} here.`, text: "It may have been removed, or the link is for another Toolroll." });

/** A project row's chip when something there waits on this person (DESIGN.md "Peek chips"): "2 waiting on you", in the
 * soft ask tone; the solid Needs you chip is never on every row of a list. */
export function waitingWords(count: number): string {
  return `${count} waiting on you`;
}

// ---- the folder picker ---------------------------------------------------------------------------------------------

/** What the picker shows: where it is (breadcrumb, Up), shortcuts, the folders here, and what can be done with the
 * folder it is at (`chosen`: the add confirmation for a repository, or "use this folder" for the projects folder). */
export type FolderPickerView = {
  at: { shown: string; crumbs: readonly { label: string; href: string | null }[]; up: string | null } | null;
  entries: readonly { name: string; git: boolean; registered: boolean; href: string }[];
  shortcuts: readonly { label: string; href: string }[];
  /** The folder couldn't be read (or didn't answer): said in place of the list. */
  lookProblem: string | null;
  chosen: Html | null;
  problem: string | null;
  said: string | null;
  back: readonly [href: string, label: string];
};

/** The repository picker over the server's own disk (pages.ts projectsPick): directory names only, read off
 * the console's thread (folder-look.ts), git repositories marked. Every row is a link (keyboard and phone alike). */
export function folderPickerPage(chrome: Chrome, view: FolderPickerView): Screen {
  const title = "Choose a repository";
  // The breadcrumb wraps on a phone (plain inline text), each folder above this one a link.
  const crumbs = view.at === null ? "" : html`<nav class="k-mono" aria-label="Folder">${joinHtml(view.at.crumbs.map(one => one.href === null
    ? html`<span aria-current="location">${one.label}</span>`
    : html`<a class="k-link" href="${one.href}">${one.label}</a>`), html`<span aria-hidden="true"> / </span>`)}</nav>`;
  const gits = view.entries.filter(one => one.git).length;
  const list = view.lookProblem !== null ? notice(view.lookProblem)
    : view.entries.length === 0 && view.chosen !== null ? ""
    : view.entries.length === 0 ? empty({ title: "No repositories here.", text: view.at?.up ? "Go up one folder, or try a shortcut." : "Try a shortcut." })
    : html`${gits === 0 ? note("No repositories here. Open a folder to look inside it.") : ""}${group("Folders", count(view.entries.length))}${view.entries.map(one => row({
      href: one.href, chip: one.git ? chip(one.registered ? "Project" : "Git repository", "") : html``, title: one.name,
      desc: one.git ? (one.registered ? "Already added" : "Choose to add it") : "Folder",
    }))}`;
  const body = joinHtml([
    phoneHeader(title, { back: view.back[0] }),
    doc(
      docHeader({ back: view.back, title, meta: crumbs, same: true }),
      view.problem === null ? "" : notice(sentence(view.problem)),
      view.said === null ? "" : infoLine(sentence(view.said)),
      view.chosen ?? "",
      view.shortcuts.length === 0 && !view.at?.up ? "" : html`<nav class="k-acts" aria-label="Go to">${view.at?.up ? btn("Up one folder", { sm: true, lead: "back", href: view.at.up }) : ""}${view.shortcuts.map(one => btn(one.label, { sm: true, variant: "ghost", href: one.href }))}</nav>`,
      html`<div>${list}</div>`,
    ),
  ], "\n");
  // A page with a password field is drawn without scripts by the screen's own sensitivity check.
  return screen(title, body, { chrome });
}

/** A password typed now, for a form on the picker (never remembered: it widens what the server may open). */
export const typedPasswordField = (id: string): Html => field({ id, label: "Your password",
  control: html`<input class="k-input" id="${id}" type="password" name="password" data-so-typed autocomplete="current-password" required>` });

/** The picker's confirmation for a repository: open it, add it (inside the projects folder), or add it from outside
 * with a password typed now; or why it can't be added. Posts the same exact-path form the Add project panel does. */
export function pickRepoChosen(data: { name: string; path: string; state: "open" | "inside" | "outside" | "blocked"; refusal: string | null }): Html {
  const form = (label: string, extra: Html | string = "") => postForm("/projects/open", joinHtml([extra, acts(btn(label, { type: "submit", variant: "primary" }))]), { returnTo: "/projects", hidden: { path: data.path, via: "path" } });
  const text = data.refusal !== null ? sentence(data.refusal)
    : data.state === "open" ? "Already a project here."
    : data.state === "outside" ? "It’s outside your projects folder, so Toolroll asks for your password."
    : data.state === "blocked" ? "It’s outside your projects folder. Only an approver signed in with a password can add it."
    : "Adds it as a project.";
  const acts_ = data.refusal !== null || data.state === "blocked" ? ""
    : data.state === "open" ? form("Open") : data.state === "outside" ? form("Add and open", typedPasswordField("pick-password")) : form("Add and open");
  return slots({ status: html`<h2>${data.name}</h2>`, text: html`${mono(shortPathOf(data.path))} · ${text}`, acts: acts_, terms: "", attrs: { "aria-label": `Add ${data.name}` } });
}
