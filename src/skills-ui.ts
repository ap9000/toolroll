import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { whenUtc } from "./when-html.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, chip, disclose, facts, formRow, input, note, notice, select, settingsRecord, settingsSection, textarea } from "./server/kit.js";
import { plural } from "./design/kit.js";
import type {
  SavedSkill,
  SkillsSnapshot,
  SkillsView,
  skillTestResult,
} from "./project-skills.js";
import type { SkillLibraryView } from "./skill-library.js";
import type { DetectedLocalTool } from "./skill-local-sync.js";
// Shorten the current user's home directory prefix to ~ so detected local tool folders stay scannable.
function prettyHomePath(target: string): string {
  const home = homedir();
  return home && (target === home || target.startsWith(`${home}/`)) ? `~${target.slice(home.length)}` : target;
}
// Hidden fields as they always were: a missing value is an empty field.
const fields = (data: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
export const SKILLS_CSS = `.skills{max-width:780px;min-width:0;overflow-wrap:anywhere}.skills h2{font-size:1.1rem}.skills .card{padding:18px;margin:14px 0;min-width:0}.skills form,.skills label{display:grid;gap:10px}.skills input,.skills textarea,.skills select{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.skills textarea{resize:vertical;min-height:130px}.skills button{justify-self:start;white-space:nowrap;min-height:44px}.skills summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.skills pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:.9rem}.skills .skill-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.skills .skill-heading h2{margin:0}.skills .skill-state{font-size:.85rem;flex-shrink:0}.skills .skill-source{font-size:.85rem}.skills .skill-controls{display:flex;gap:12px;flex-wrap:wrap}.skills .skill-controls form{margin:0}.skills details details{margin-top:10px}.skills [hidden]{display:none!important}.skills .skill-files{max-height:200px;overflow:auto}.skills .problem{padding:12px}@media(max-width:600px){.skills input,.skills textarea,.skills select{font-size:16px}.skills .card{padding:14px}.skills .skill-heading{align-items:flex-start}}`;
function source(skill: SavedSkill): Html {
  return html`<p class="skill-source">${skill.source} · ${skill.sha.slice(0, 10)}</p><p>${plural(skill.files.length, "file", "files")} · ${Math.ceil(skill.files.reduce((n, f) => n + Buffer.from(f.base64, "base64").length, 0) / 1024)} KB</p><pre>${Buffer.from(skill.files.find((f) => f.path === "SKILL.md")!.base64, "base64").toString("utf8")}</pre><details><summary>Package files</summary><ul class="skill-files">${skill.files.map((f) => html`<li>${f.path}</li>`)}</ul></details>`;
}
/** A skill's package as the settings page shows it: where it came from, its size, its SKILL.md, its files. */
function sourceKit(skill: SavedSkill): Html {
  const kb = Math.ceil(skill.files.reduce((n, f) => n + Buffer.from(f.base64, "base64").length, 0) / 1024);
  return joinHtml([
    facts([["Source", html`${skill.source} · <span class="k-mono">${skill.sha.slice(0, 10)}</span>`], ["Size", `${plural(skill.files.length, "file", "files")} · ${kb} KB`]]),
    html`<pre class="k-scode">${Buffer.from(skill.files.find((f) => f.path === "SKILL.md")!.base64, "base64").toString("utf8")}</pre>`,
    disclose("Package files", html`<ul class="k-note">${skill.files.map((f) => html`<li class="k-mono">${f.path}</li>`)}</ul>`),
  ]);
}
export function skillsHtml(
  view: SkillsView,
  csrf: string,
  canManage: boolean,
  options: {
    focus?: string;
    error?: string;
    draft?: Record<string, string>;
    agent?: string;
    /** What new tasks in this project receive (project-skills.ts effectiveSkillsForRepo): the global library less this
     * project's opt-outs, with its own choices over it. The one status each skill shows. */
    effective?: readonly { name: string; sha: string }[];
  } = {},
): Html {
  const manage = canManage && !!csrf,
    base = {
      repo: view.repo,
      identity: view.identity,
      revision: view.revision,
    };
  const form = (
    action: string,
    contents: Html,
    extra: Record<string, unknown> = {},
  ) => postForm("/settings/skills/change", contents, { hidden: fields({ ...base, action, ...extra }) });
  const active = options.effective?.length ?? Object.values(view.selection).filter((c) => c.enabled).length;
  const reaches = new Set((options.effective ?? []).map((one) => one.sha));
  const renderSkill = (skill: SavedSkill): Html => {
    const enabled =
      view.selection[skill.name]?.sha === skill.sha &&
      view.selection[skill.name]?.enabled === true;
    const replaced =
      view.selection[skill.name]?.enabled &&
      view.selection[skill.name]?.sha !== skill.sha;
    const toggle = manage ? form(enabled ? "disable" : "enable", joinHtml([
      replaced ? note("Replaces the enabled version of this skill for new tasks.") : "",
      acts(btn(enabled ? "Disable skill" : "Enable skill", { sm: true, type: "submit" })),
    ]), { sha: skill.sha }) : "";
    const testing = manage ? disclose("Test skill", form("test", joinHtml([
      note(`${options.agent ?? "Uses this project’s configured report agent"}. Runs the sample as a report task through the normal approval: it reads the project, and a report that changes a file fails with nothing kept.`),
      formRow("Sample request", "The report shows what worked and what needs tools or permission. Enabled status alone does not prove use.",
        textarea({ id: `skill-sample-${skill.sha.slice(0, 12)}`, name: "sample", rows: 3, value: options.draft?.["sha"] === skill.sha ? (options.draft?.["sample"] ?? "") : "",
          attrs: { required: true, maxlength: 800, placeholder: "Review this project’s home page and suggest three clearer button labels.", "aria-label": "Sample request" } }), "top"),
      acts(btn("Create test", { sm: true, type: "submit" })),
    ]), { sha: skill.sha, nonce: randomUUID() }), options.draft?.["sha"] === skill.sha) : "";
    return settingsRecord({
      title: html`<span>${skill.name}</span>${enabled ? chip("Enabled here", "done")
        : view.selection[skill.name]?.enabled === false ? chip("Off in this project", "")
        : reaches.has(skill.sha) ? chip("Active from the global library", "done") : chip("In library", "")}`,
      sub: skill.description,
      attrs: { id: `skill-${skill.sha}` },
      more: joinHtml([
        skill.requirements ? note(`Requires: ${skill.requirements}. Availability is checked when the agent tests or uses it.`) : "",
        ...skill.warnings.map((w) => note(w)),
        disclose("Review skill", joinHtml([sourceKit(skill), toggle]), options.focus === skill.sha),
        testing,
      ]),
    });
  };
  const names = [...new Set(view.library.map((s) => s.name))];
  const cards = names
    .map((name) => {
      const versions = view.library.filter((s) => s.name === name),
        primary =
          versions.find((s) => s.sha === options.focus) ??
          versions.find((s) => s.sha === view.selection[name]?.sha) ??
          versions.at(-1)!;
      const older = versions.filter((s) => s !== primary);
      return html`<div data-skill-group data-skill-query="${name + " " + primary.description}">${renderSkill(primary)}${older.length ? disclose(`Other versions (${older.length})`, joinHtml(older.map(renderSkill))) : ""}</div>`;
    });
  const search =
    names.length > 5
      ? html`${formRow("Search library", null, input({ id: "skill-search", name: "skill-search", type: "search", attrs: { "data-skill-search": true, placeholder: "Name or description", "aria-label": "Search library" } }), "wide")}<p class="k-note" data-skill-no-matches hidden>No matching skills.</p>`
      : "";
  const d = options.draft ?? {};
  const add = manage
    ? disclose("Add a skill", postForm("/settings/skills/import", joinHtml([
        formRow("Add from", null, select({ id: "skill-method", name: "method", label: "Add from", current: d["method"] ?? "paste", attrs: { "data-skill-method": true },
          items: [["paste", "Paste SKILL.md"], ["github", "GitHub folder"], ["folder", "Local folder"]] })),
        html`<div data-skill-input="paste">${formRow("SKILL.md", null, textarea({ id: "skill-content", name: "content", rows: 8, value: d["content"] ?? "",
          attrs: { maxlength: 24576, placeholder: "---\nname: design-review\ndescription: Review interface copy and layout.\n---\nWrite your instructions here.", "aria-label": "SKILL.md" } }), "top")}</div>`,
        html`<div data-skill-input="github">${formRow("Public GitHub folder", null, input({ id: "skill-url", name: "url", type: "url", value: d["url"] ?? "",
          attrs: { placeholder: "https://github.com/owner/repo/tree/main/skills/review", "aria-label": "Public GitHub folder" } }), "wide")}</div>`,
        html`<div data-skill-input="folder">${formRow("Skill folder", "Choose the folder containing SKILL.md. Up to 64 files, 1 MB total.",
          html`<input class="k-input" id="skill-folder" type="file" webkitdirectory multiple data-skill-folder aria-label="Skill folder">`)}<input type="hidden" name="files" value="">\
<noscript>${note("Folder uploads need JavaScript. You can paste SKILL.md or use a GitHub folder.")}</noscript></div>`,
        note("Added to your library first. Review its source and requirements before enabling it."),
        html`<p class="k-err" data-skill-error role="alert" hidden></p>`,
        acts(btn("Add to library", { variant: "primary", type: "submit" })),
      ]), { attrs: { "data-skill-import": true }, hidden: fields(base) }), Boolean(options.error && options.draft?.["method"]))
    : "";
  const history = view.history.length
    ? disclose("Change history", joinHtml(view.history.map((h) => settingsRecord({
        title: `Selection ${h.revision}`,
        sub: h.enabled.length ? h.enabled.map((s) => `${s.name} · ${s.version}`).join(", ") : "No skills enabled",
        when: html`${h.actor} · ${whenUtc(h.at)}`,
        action: manage && h.revision !== view.revision ? form("restore", btn("Restore selection", { sm: true, type: "submit" }), { restore: h.revision }) : note("Current selection"),
      }))))
    : "";
  const library = settingsSection({
    id: "library", title: "Library",
    lead: `${active ? `${active} skill${active === 1 ? "" : "s"} reach${active === 1 ? "es" : ""} new tasks in this project.` : "No skills reach new tasks in this project."} Active tasks keep their saved versions.`,
    body: joinHtml([add, search, cards.length ? joinHtml(cards) : note("Your library is empty. Add a skill to review and enable it here."), history]),
  });
  return joinHtml([options.error ? notice(options.error) : "", library]);
}
export function skillsSnapshotHtml(snapshot: SkillsSnapshot | null): Html | "" {
  if (!snapshot || !snapshot.packages.length) return "";
  return html`<details class="skills"><summary>Skills supplied (${snapshot.packages.length})</summary><p class="meta">Exact versions supplied to this run. This does not confirm the agent read or applied them.</p>${snapshot.packages.map((s) => html`<details><summary>${s.name} · ${s.sha.slice(0, 10)}</summary>${source(s)}</details>`)}</details>`;
}
export function skillsScript() {
  return `(()=>{const gsearch=document.querySelector('[data-global-skill-search]');if(gsearch)gsearch.addEventListener('input',()=>{let found=0;document.querySelectorAll('[data-global-skill-group]').forEach(el=>{el.hidden=!el.dataset.globalSkillQuery.toLowerCase().includes(gsearch.value.trim().toLowerCase());if(!el.hidden)found++;});const nm=document.querySelector('[data-global-skill-no-matches]');if(nm)nm.hidden=found>0;});const search=document.querySelector('[data-skill-search]');if(search)search.addEventListener('input',()=>{let found=0;document.querySelectorAll('[data-skill-group]').forEach(el=>{el.hidden=!el.dataset.skillQuery.toLowerCase().includes(search.value.trim().toLowerCase());if(!el.hidden)found++;});document.querySelector('[data-skill-no-matches]').hidden=found>0;});const form=document.querySelector('[data-skill-import]');if(!form)return;const method=form.querySelector('[data-skill-method]'),error=form.querySelector('[data-skill-error]');function sync(){form.querySelectorAll('[data-skill-input]').forEach(el=>{el.hidden=el.dataset.skillInput!==method.value;el.querySelectorAll('input,textarea').forEach(i=>i.disabled=el.hidden);});}method.addEventListener('change',sync);sync();form.addEventListener('submit',async event=>{if(method.value!=='folder')return;if(form.dataset.prepared==='yes'){delete form.dataset.prepared;return;}event.preventDefault();error.hidden=true;error.textContent='';const button=form.querySelector('button');button.disabled=true;try{const files=Array.from(form.querySelector('[data-skill-folder]').files);if(!files.length||files.length>64||files.reduce((n,f)=>n+f.size,0)>1048576||files.some(f=>f.size>262144))throw Error('Choose one skill folder with up to 64 files and 1 MB total.');const packed=[];for(const file of files){const parts=file.webkitRelativePath.split('/');parts.shift();const data=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of data)binary+=String.fromCharCode(byte);packed.push({path:parts.join('/'),base64:btoa(binary)});}form.querySelector('[name=files]').value=JSON.stringify(packed);form.dataset.prepared='yes';button.disabled=false;form.requestSubmit();}catch(e){error.textContent=e.message||'The folder could not be read. Select it again.';error.hidden=false;button.disabled=false;}});})();`;
}

export function skillTestFeedbackHtml(
  test: NonNullable<ReturnType<typeof skillTestResult>>,
  csrf: string,
  canManage: boolean,
  error = "",
  draft = "",
): Html {
  return html`<section class="skills" id="skill-test-feedback"><h2>Improve this test</h2>${test.sourceRun ? html`<p>Revises test run #${test.sourceRun}.</p>` : ""}${test.feedback ? html`<details><summary>Feedback for this test</summary><p>${test.feedback}</p></details>` : ""}${test.revisions.length ? html`<p>${joinHtml(test.revisions.map((id, i) => html`<a href="/t/${encodeURIComponent(id)}">Test revision ${i + 1}</a>`), " · ")}</p>` : ""}${error ? html`<p role="alert">${error}</p>` : ""}${canManage && csrf ? postForm("/settings/skills/revise", html`<label>What should change?<textarea name="feedback" required maxlength="500" rows="3" placeholder="Try a clearer action label and explain why it fits the user’s goal.">${draft}</textarea></label><p class="meta">Creates another report task with this skill version and your feedback. Review its scope before it runs.</p><button>Create revision</button>`, { hidden: fields({ repo: test.repo, run: test.run, nonce: randomUUID() }) }) : ""}</section>`;
}

/** Global skill library (shared across all projects unless opted out), GitHub bundles, and local computer tool sync. */
export function skillLibrarySectionHtml(
  library: SkillLibraryView,
  localTools: readonly DetectedLocalTool[],
  csrf: string,
  canManage: boolean,
  options: {
    repo?: string;
    said?: string | null;
    error?: string | null;
    /** This project's own choices (project-skills.ts skillsView selection), which win over the global library here. */
    projectSelection?: Readonly<Record<string, { sha: string; enabled: boolean }>>;
    /** The bundle address a failed import was given, kept in its field. */
    bundleUrl?: string;
  } = {},
): Html {
  const manage = canManage && !!csrf;
  const repo = options.repo ?? "";
  const bundleUrl = options.bundleUrl ?? "";
  const libForm = (action: string, contents: Html, extra: Record<string, unknown> = {}) =>
    postForm("/settings/skills/library", contents, { hidden: fields({ action, repo, revision: library.revision, ...extra }) });

  const enabledCount = Object.values(library.selection).filter((c) => c.enabled).length;
  const projectOptedOutAll = library.projectOptOut?.all === true;
  const projectOptOutNames = new Set(library.projectOptOut?.names ?? []);
  const importBundleForm = manage
    ? disclose("Import a GitHub skill bundle", libForm("import-bundle", html`<div class="k-sec">${joinHtml([
        formRow("GitHub repository URL", "Imports every SKILL.md found in the repository, pinned to its exact commit SHA.",
          input({ id: "bundle-url", name: "url", type: "url", value: bundleUrl, attrs: { required: true, placeholder: "https://github.com/owner/repo", "aria-label": "GitHub repository URL" } }), "wide"),
        html`<div class="k-checks"><label><input type="checkbox" name="autoUpdate" value="1" checked> Check daily and apply clean updates automatically (suspicious changes are held for review)</label></div>`,
        acts(btn("Import bundle", { variant: "primary", type: "submit" })),
      ])}</div>`), bundleUrl !== "" || (library.bundles.length === 0 && library.skills.length === 0))
    : "";

  const addGlobalSkillForm = manage
    ? disclose("Add a single skill to all projects", libForm("import-skill", joinHtml([
        formRow("SKILL.md", "Added to the global library and enabled across all projects unless opted out.",
          textarea({ id: "global-skill-content", name: "content", rows: 6, attrs: { required: true, maxlength: 24576, placeholder: "---\nname: code-review\ndescription: Review changes for clarity and bugs.\n---\nWrite your instructions here.", "aria-label": "Global SKILL.md" } }), "top"),
        acts(btn("Add to global library", { sm: true, type: "submit" })),
      ]), { method: "paste" }))
    : "";

  const bundleCards = library.bundles.map((bundle) => {
    const heldBlock = bundle.heldCommit
      ? joinHtml([
          notice(`Update held for review (${bundle.heldCommit.slice(0, 12)}): ${bundle.heldReason ?? "Suspicious change detected."}`),
          manage ? html`<div class="skill-controls">${libForm("apply-held", btn("Apply held update anyway", { sm: true, type: "submit" }), { bundle: bundle.id })}${libForm("dismiss-held", btn("Dismiss held update", { sm: true, type: "submit" }), { bundle: bundle.id })}</div>` : "",
        ])
      : "";
    const controls = manage
      ? html`<div class="skill-controls">
          ${libForm("sweep-bundle", btn("Check for updates", { sm: true, type: "submit" }), { bundle: bundle.id })}
          ${libForm("bundle-auto-update", btn(bundle.autoUpdate ? "Pause daily updates" : "Enable daily updates", { sm: true, type: "submit" }), { bundle: bundle.id, autoUpdate: bundle.autoUpdate ? "0" : "1" })}
          ${bundle.previousCommit ? libForm("rollback-bundle", btn(`Roll back to ${bundle.previousCommit.slice(0, 10)}`, { sm: true, type: "submit" }), { bundle: bundle.id }) : ""}
        </div>`
      : "";
    return settingsRecord({
      title: html`<span>${bundle.owner}/${bundle.repoName}</span>${chip(`${plural(bundle.skillNames.length, "skill", "skills")}`, "done")}${bundle.heldCommit ? chip("Update held", "") : ""}`,
      sub: html`Pinned at <span class="k-mono">${bundle.pinnedCommit.slice(0, 12)}</span> · ${bundle.autoUpdate ? "Daily auto-update on" : "Manual updates"}`,
      when: bundle.lastCheckedAt ? html`Checked ${whenUtc(bundle.lastCheckedAt)}` : undefined,
      more: joinHtml([heldBlock, controls]),
    });
  });

  const projectOptOutToggle = manage && repo
    ? libForm("project-opt-out", acts(btn(projectOptedOutAll ? "Re-enable global library for this project" : "Opt this project out of the global library", { sm: true, type: "submit" })), {
        skill: "*",
        optedOut: projectOptedOutAll ? "0" : "1",
      })
    : "";

  const globalSkillCards = library.skills.map((skill) => {
    const enabled = library.selection[skill.name]?.sha === skill.sha && library.selection[skill.name]?.enabled === true;
    const optedOutThis = projectOptOutNames.has(skill.name);
    const optOut = optedOutThis || projectOptedOutAll;
    // The one status new tasks here get, from the merged selection (skill-library.ts mergeProjectAndLibrarySkills):
    // the project's own choice first (it wins over the global library and its opt-outs), then the global library's.
    const own = repo ? options.projectSelection?.[skill.name] : undefined;
    const statusChip = own?.enabled === false
      ? chip("Off in this project", "")
      : own !== undefined && own.sha !== skill.sha
        ? chip("This project uses another version", "")
        : own !== undefined
          ? chip("Active: this project enables it", "done")
          : !enabled
            ? chip("Disabled", "")
            : optOut
              ? chip("Opted out here", "")
              : chip("Active", "done");
    // What the global library itself says, apart, when the project's own choice is what decides here.
    const globalWords = own === undefined ? "" : note(`Global library: ${enabled ? "enabled" : "disabled"}${optOut ? ", and this project opted out of it" : ""}. This project’s own choice decides here.`);
    const controls = manage
      ? html`<div class="skill-controls">
          ${libForm(enabled ? "disable-skill" : "enable-skill", btn(enabled ? "Disable globally" : "Enable globally", { sm: true, type: "submit" }), { sha: skill.sha })}
          ${repo && !projectOptedOutAll ? libForm("project-opt-out", btn(optedOutThis ? "Include in this project" : "Opt out here", { sm: true, type: "submit" }), { skill: skill.name, optedOut: optedOutThis ? "0" : "1" }) : ""}
        </div>`
      : "";
    return html`<div data-global-skill-group data-global-skill-query="${skill.name + " " + skill.description}">${settingsRecord({
      title: html`<span>${skill.name}</span>${statusChip}`,
      sub: skill.description,
      more: joinHtml([
        globalWords,
        disclose("Review skill", joinHtml([sourceKit(skill), controls])),
      ]),
    })}</div>`;
  });

  const globalSearch = library.skills.length > 5
    ? html`${formRow("Search global library", null, input({ id: "global-skill-search", name: "global-skill-search", type: "search", attrs: { "data-global-skill-search": true, placeholder: "Filter global skills by name or description", "aria-label": "Search global library" } }), "wide")}<p class="k-note" data-global-skill-no-matches hidden>No matching global skills.</p>`
    : "";

  const globalSection = settingsSection({
    id: "global-library",
    title: "Global Skill Library",
    lead: `${enabledCount ? `${plural(enabledCount, "skill", "skills")} active across all projects by default.` : "No global skills installed yet."} Every agent (tasks, Direct Chat, threads, terminals, and the lead) receives this pinned set unless a project opts out.`,
    body: html`<div class="k-sec">${joinHtml([
      importBundleForm,
      addGlobalSkillForm,
      bundleCards.length ? html`<h3>Tracked GitHub bundles</h3>${joinHtml(bundleCards)}` : "",
      projectOptOutToggle,
      globalSearch,
      globalSkillCards.length ? joinHtml(globalSkillCards) : note("Import a GitHub skill repository or add a skill above to share it across every project."),
    ])}</div>`,
  });

  const localToolCards = localTools.map((tool) => {
    const statusChip = !tool.detected
      ? chip("Not detected", "")
      : tool.enabled
        ? chip(`Synced (${tool.installedCount})`, "done")
        : chip("Detected · off", "");
    const sub = tool.detected
      ? html`Writes only Toolroll-managed skills to <span class="k-mono">${prettyHomePath(tool.skillsDir ?? tool.toolHome)}</span>. Your own hand-written skills are never overwritten.`
      : "Folder not found on this computer — Toolroll only writes where a tool is already installed.";
    const actions = manage && tool.detected
      ? html`<div class="skill-controls">
          ${libForm("local-sync", btn(tool.enabled ? "Turn off sync" : "Also install here", { sm: true, type: "submit" }), { tool: tool.tool, enabled: tool.enabled ? "0" : "1" })}
          ${tool.enabled ? libForm("local-sync-now", btn("Sync now", { sm: true, type: "submit" }), { tool: tool.tool }) : ""}
        </div>`
      : "";
    return settingsRecord({
      title: html`<span>${tool.label}</span>${statusChip}`,
      sub,
      when: tool.syncedAt ? html`Last synced ${whenUtc(tool.syncedAt)}` : undefined,
      more: actions,
    });
  });

  const localSection = settingsSection({
    id: "local-sync",
    title: "Also install on this computer",
    lead: "Mirror your enabled global skills into your local Claude Code, Codex, and Gemini CLI folders. Toolroll only writes into tools detected on this computer and never touches your own skills.",
    body: joinHtml(localToolCards),
  });

  return joinHtml([
    options.said ? notice(options.said) : "",
    options.error ? notice(options.error) : "",
    globalSection,
    localSection,
  ]);
}
