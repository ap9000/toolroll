/**
 * Settings → Computers (the eight settings plan v2, slice F2): connect a builder (what /start-builder showed), every
 * computer that builds and one computer's details (what /fleet and the computers on Agents showed), and the two change
 * documents: register a computer (a credential proof, its token shown once on the answer) and retire one (a step-up).
 *
 * Sections are admitted by settings-sections.ts before any loader here runs; what each person may change only decides
 * which controls are drawn. Every form posts to its existing route (POST /fleet/runner/register, /fleet/runner/retire,
 * /queue/move, /queue/note), which proves the act again.
 */
import type { BrowserComputer, BrowserComputers } from "../browser-workspace.js";
import { plural, RESOURCE } from "../design/kit.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { START_BUILDER_COMMAND } from "../needs-you.js";
import { kitSectionForm, textField } from "../settings-kit.js";
import { btn, chip, codeLine, doc, docHeader, facts, infoLine, note, notice, phoneHeader, select, settingsRecord, settingsSection } from "./kit.js";
import { changeDocumentOf, changeHref, sectionHref } from "./settings-section-table.js";
import type { SectionContext, SectionImpl, SectionImpls } from "./settings-sections.js";

/** What Computers' sections read, none of it from the request. */
export type ComputersDeps = {
  /** Every computer that builds, its claims filtered to what this person may see; `manage` draws the controls. */
  readonly computers: (now: Date, manage: boolean) => BrowserComputers;
  /** Whether a live builder may build in this project now (for that task's reserved computer, when it has one). */
  readonly connected: (repo: string, now: Date, runner: string | null) => boolean;
  readonly projectName: (repo: string) => string;
  /** A one-use form token for registering a computer, bound to this person. */
  readonly registerNonce: (name: string) => string;
  /** "3 minutes ago", for a saved time. */
  readonly ago: (iso: string, now: Date) => string;
};

/** The page's own keys, resolved and admitted by its handler before any section loads. */
export type ComputersSubject = {
  /** ?task=: that task's own saved project (and the computer reserved for it), never the open one. */
  readonly task: { readonly id: string; readonly repo: string; readonly runner: string | null } | null;
  /** ?computer=: the computer whose details (or retire document) were asked for. */
  readonly computer: string | null;
  /** A change document's safe drafts after a refusal (never a password). */
  readonly drafts: Readonly<Record<string, string>>;
};

const AREA = "/settings/computers";
/** What a register nonce is for (mintApprovalNonce's purpose): one register form, one post. */
export const RUNNER_REGISTER = "runner-register";
const chipOf = (one: BrowserComputer): Html => one.retired ? chip("Retired") : chip(RESOURCE[one.state].word, RESOURCE[one.state].tone);
/** Why a computer is in the state it is, in one line (as Agents said it). */
function lineOf(one: BrowserComputer, now: Date, ago: ComputersDeps["ago"]): string {
  const reserved = one.reserved.length > 0 ? ` · ${one.reserved.length} reserved` : "";
  if (one.retired) return `Retired${reserved}`;
  if (one.state === "offline") return `Stopped answering ${ago(one.heardAt, now)}${reserved}`;
  const busy = one.building.length + one.hidden;
  if (one.state === "building") return `${busy} of ${one.capacity} building · heard ${ago(one.heardAt, now)}${reserved}`;
  return `Free · ${plural(one.capacity, "slot", "slots")} · heard ${ago(one.heardAt, now)}${reserved}`;
}

type StartSummary = { project: string | null; connected: boolean | null; whole: boolean; register: boolean };
function startSection(deps: ComputersDeps, subject: ComputersSubject): SectionImpl<StartSummary> {
  return {
    loadSummary: ctx => {
      // A task's own project when the link names one (its handler proved the person may see it), else the open project.
      const task = subject.task;
      const repo = task?.repo ?? ctx.project;
      return { project: repo === null ? null : deps.projectName(repo), connected: repo === null ? null : deps.connected(repo, ctx.now, task?.runner ?? null),
        whole: !ctx.person.restricted, register: ctx.can["register"] === true };
    },
    render: ({ declaration, summary, attrs }) => {
      const where = summary.project === null ? "" : html` to <strong>${summary.project}</strong>`;
      const state = summary.connected === null ? html`` : summary.connected
        ? html`<p>A builder is connected${where}. Approved tasks there start on their own.</p>`
        : html`<p><strong>No builder is connected</strong>${where}. Tasks wait until one is.</p>`;
      const register = changeDocumentOf("register-computer");
      return settingsSection({
        id: "start", title: declaration.title, attrs,
        ...(summary.register && register !== undefined ? { right: btn("Register a computer", { sm: true, href: changeHref(register) }) } : {}),
        body: joinHtml([
          state,
          html`<p>On the computer where ${summary.project ?? "the project"} lives, open the project's folder in a terminal and run:</p>`,
          html`<p id="builder">${codeLine(START_BUILDER_COMMAND)}</p>`,
          summary.whole
            ? note(html`Keep it running. Approved tasks start on their own. The console alone (<code>toolroll serve</code>) doesn't build.`)
            : note("Starting a builder takes someone who manages this Toolroll. Ask them to run it there; your tasks start on their own once it connects."),
        ]),
      });
    },
    refusal: "An approver with access to the whole installation registers computers, from a browser.",
    renderChange: ({ ctx, problem }) => {
      const title = "Register a computer";
      const back = sectionHref({ id: "start", area: "computers" });
      const drafts = subject.drafts;
      const capacity = /^(1|2|3|4|6|8)$/.test(drafts["capacity"] ?? "") ? drafts["capacity"]! : "1";
      const form = kitSectionForm({ proof: "runner-register", action: "/fleet/runner/register", id: "register-form", native: true, save: { label: "Register computer" },
        hidden: { nonce: deps.registerNonce(ctx.person.name) },
        body: joinHtml([
          textField({ id: "register-name", name: "name", label: "Computer name", value: drafts["name"] ?? "", hint: "One short line, like the computer's own name.",
            error: drafts["field"] === "name" ? problem : null, attrs: { maxlength: 60, autocomplete: "off", spellcheck: "false", required: true } }),
          html`<div class="kit-field"><label for="register-capacity">Tasks at a time</label>${select({ id: "register-capacity", name: "capacity", current: capacity, items: ["1", "2", "3", "4", "6", "8"] })}</div>`,
        ]) });
      const body = joinHtml([
        html`<p>Registering makes a token that lets the computer take work. It is shown once, on the next page; only its hash is kept. Most computers don't need this: <code>${START_BUILDER_COMMAND}</code> registers the computer it runs on.</p>`,
        problem === null || drafts["field"] === "name" ? "" : notice(problem),
        form,
        html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: back })}</div>`,
      ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back })}${doc(docHeader({ title, back: [back, "Computers"], same: true }), body)}</div>` };
    },
  };
}

type BuildersSummary = BrowserComputers;
type BuildersDetail = { one: BrowserComputer } | { missing: string };
function buildersSection(deps: ComputersDeps, subject: ComputersSubject): SectionImpl<BuildersSummary, BuildersDetail | null> {
  const detailOf = (computers: BrowserComputers, name: string | null): BuildersDetail | null =>
    name === null ? null : ((one: BrowserComputer | undefined) => one === undefined ? { missing: name } : { one })(computers.list.find(each => each.name === name));
  return {
    loadSummary: ctx => deps.computers(ctx.now, ctx.can["manage"] === true),
    // One computer's details: its reserved work and note (already in the list this person may see).
    loadDetail: ctx => detailOf(deps.computers(ctx.now, ctx.can["manage"] === true), subject.computer),
    render: ({ declaration, ctx, summary, detail, attrs }) => {
      const retire = changeDocumentOf("retire-computer");
      const rows = summary.list.map(one => {
        const opened = detail !== null && "one" in detail && detail.one.name === one.name;
        return settingsRecord({ attrs: { "data-computer": one.name },
          title: html`${one.name} ${chipOf(one)}`, sub: `${one.host} · ${lineOf(one, ctx.now, deps.ago)}`,
          action: opened ? html`` : btn("Details", { sm: true, variant: "ghost", href: `${sectionHref(declaration, { open: true, extra: { computer: one.name } })}#builders` }),
          more: opened ? detailHtml(one, summary, ctx, deps, retire === undefined ? null : changeHref(retire, null, { computer: one.name })) : undefined });
      });
      return settingsSection({
        id: "builders", title: declaration.title, state: summary.list.length === 0 ? "" : ` · ${summary.list.length}`, attrs,
        body: joinHtml([
          // `workers`: Settings → Agents and models' old builders list, kept for its links.
          html`<div id="workers">${summary.list.length === 0 ? note("No computer is building yet. Approved tasks wait until one is connected (above).") : joinHtml(rows)}</div>`,
          detail !== null && "missing" in detail ? notice(`There's no computer named ${detail.missing}.`) : "",
          summary.shared > 0 ? note(html`${plural(summary.shared, "task waits", "tasks wait")} in the shared queue for any free computer. <a class="k-link" href="/?view=order">Reserve one for a computer</a>`) : "",
        ]),
      });
    },
    refusal: "An approver with access to the whole installation retires computers, from a browser.",
    renderChange: ({ ctx, problem }) => {
      const back = sectionHref({ id: "builders", area: "computers" });
      const name = subject.computer;
      const one = name === null ? undefined : deps.computers(ctx.now, true).list.find(each => each.name === name);
      const title = one === undefined ? "Retire a computer" : `Retire ${one.name}`;
      const body = one === undefined || one.retired
        ? joinHtml([infoLine(one === undefined ? "There's no computer by that name to retire." : `${one.name} is already retired.`), html`<div class="k-acts">${btn("Back to Computers", { href: back })}</div>`])
        : joinHtml([
          html`<p>${one.name} stops taking work. Tasks reserved for it wait until you move them. To use it again, register the name again.</p>`,
          facts([["Computer", one.host], ["Status", lineOf(one, ctx.now, deps.ago)], ["Reserved for it", one.reserved.length === 0 ? "Nothing" : plural(one.reserved.length, "task", "tasks")]]),
          problem === null ? "" : notice(problem),
          kitSectionForm({ proof: "runner-retire", action: "/fleet/runner/retire", id: "retire-form", native: true, save: { label: "Retire computer" }, hidden: { name: one.name }, body: html`` }),
          html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: `${sectionHref({ id: "builders", area: "computers" }, { open: true, extra: { computer: one.name } })}#builders` })}</div>`,
        ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back })}${doc(docHeader({ title, back: [back, "Computers"], same: true }), body)}</div>` };
    },
  };
}

/** One computer's details, under its row: what it is, what is reserved for it, its note, and Retire. */
function detailHtml(one: BrowserComputer, computers: BrowserComputers, ctx: SectionContext, deps: ComputersDeps, retireHref: string | null): Html {
  const others = computers.list.filter(other => other.name !== one.name && !other.retired);
  const reserved = one.reserved.length === 0 ? note("Nothing reserved. It takes from the shared queue, top first.")
    : html`<ul class="k-list">${one.reserved.map(task => html`<li data-reserved="${task.id}"><a href="${task.href}">${task.title}</a>${task.project === null ? "" : html` <span class="k-muted">· ${task.project}</span>`}${
      task.taken ? html` <span class="k-note">Being taken</span>`
      : computers.manage ? postForm("/queue/move", html`${select({ name: "column", sm: true, label: `Move ${task.title} to`, current: "anyone", items: [["anyone", "Shared queue"], ...others.map(other => [other.name, other.name] as const)] })}${btn("Move", { sm: true, type: "submit" })}`,
        { hidden: { queueRevision: String(computers.queueRevision), task: task.id, before: "" }, attrs: { class: "k-acts" } }) : ""}</li>`)}</ul>`;
  return joinHtml([
    facts([
      ["Computer", one.host],
      ["Takes work from", one.projects.length > 0 ? one.projects.join(", ") : "No projects yet"],
      ["Building now", one.building.length === 0 && one.hidden === 0 ? "Nothing"
        : joinHtml([...one.building.map(build => html`<a href="${build.href}">${build.title}</a>`), one.hidden > 0 ? plural(one.hidden, "task in a project you can't see", "tasks in projects you can't see") : ""].filter(Boolean), html`<br>`)],
      ["At a time", computers.manage ? html`${plural(one.capacity, "task", "tasks")} <span class="k-muted">· change it there with <code class="k-mono">toolroll runner capacity ${one.name} &lt;n&gt;</code></span>` : plural(one.capacity, "task", "tasks")],
      ["Last heard", deps.ago(one.heardAt, ctx.now)],
      ["Registered", deps.ago(one.registeredAt, ctx.now)],
      ...(!computers.manage && one.note !== null ? [["Note", one.note] as const] : []),
    ]),
    one.state === "offline" && !one.retired ? note(html`To bring it back, open a terminal on ${one.host}, go to the project's folder and run ${codeLine(START_BUILDER_COMMAND)}.`) : "",
    html`<h4>Reserved for it</h4>`, reserved,
    computers.manage && !one.retired ? postForm("/queue/note", html`<div class="kit-field"><label for="note-${one.name}">Note on its queue</label>\
<input class="k-input" id="note-${one.name}" name="note" maxlength="200" value="${one.note ?? ""}">\
<p class="kit-hint">What it is working through, for whoever looks next.</p></div>${btn("Save note", { sm: true, type: "submit" })}`, { hidden: { runner: one.name, from: "fleet" } }) : "",
    computers.manage && !one.retired && retireHref !== null ? html`<div class="k-acts">${btn(`Retire ${one.name}`, { sm: true, href: retireHref })}</div>` : "",
  ]);
}

/** Computers' sections, by id (settings-section-table.ts says who sees each), made per request: `subject` is that page's own resolved keys. */
export function computersSections(deps: ComputersDeps, subject: ComputersSubject): SectionImpls {
  return { start: startSection(deps, subject), builders: buildersSection(deps, subject) } as unknown as SectionImpls;
}

export { AREA as COMPUTERS_PATH };
