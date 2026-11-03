import { randomUUID } from "node:crypto";
import { whenUtc } from "./when-html.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, chip, disclose, facts, formRow, input, note, notice, select, settingsRecord, settingsSection, textarea } from "./server/kit.js";
import type {
  SavedSkill,
  SkillsSnapshot,
  SkillsView,
  skillTestResult,
} from "./project-skills.js";
// Hidden fields as they always were: a missing value is an empty field.
const fields = (data: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
export const SKILLS_CSS = `.skills{max-width:780px;min-width:0;overflow-wrap:anywhere}.skills h2{font-size:1.1rem}.skills .card{padding:18px;margin:14px 0;min-width:0}.skills form,.skills label{display:grid;gap:10px}.skills input,.skills textarea,.skills select{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.skills textarea{resize:vertical;min-height:130px}.skills button{justify-self:start;white-space:nowrap;min-height:44px}.skills summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.skills pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:.9rem}.skills .skill-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.skills .skill-heading h2{margin:0}.skills .skill-state{font-size:.85rem;flex-shrink:0}.skills .skill-source{font-size:.85rem}.skills .skill-controls{display:flex;gap:12px;flex-wrap:wrap}.skills .skill-controls form{margin:0}.skills details details{margin-top:10px}.skills [hidden]{display:none!important}.skills .skill-files{max-height:200px;overflow:auto}.skills .problem{padding:12px}@media(max-width:600px){.skills input,.skills textarea,.skills select{font-size:16px}.skills .card{padding:14px}.skills .skill-heading{align-items:flex-start}}`;
function source(skill: SavedSkill): Html {
  return html`<p class="skill-source">${skill.source} · ${skill.sha.slice(0, 10)}</p><p>${skill.files.length} files · ${Math.ceil(skill.files.reduce((n, f) => n + Buffer.from(f.base64, "base64").length, 0) / 1024)} KB</p><pre>${Buffer.from(skill.files.find((f) => f.path === "SKILL.md")!.base64, "base64").toString("utf8")}</pre><details><summary>Package files</summary><ul class="skill-files">${skill.files.map((f) => html`<li>${f.path}</li>`)}</ul></details>`;
}
/** A skill's package as the settings page shows it: where it came from, its size, its SKILL.md, its files. */
function sourceKit(skill: SavedSkill): Html {
  const kb = Math.ceil(skill.files.reduce((n, f) => n + Buffer.from(f.base64, "base64").length, 0) / 1024);
  return joinHtml([
    facts([["Source", html`${skill.source} · <span class="k-mono">${skill.sha.slice(0, 10)}</span>`], ["Size", `${skill.files.length} files · ${kb} KB`]]),
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
  const active = Object.values(view.selection).filter((c) => c.enabled).length;
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
      note(`${options.agent ?? "Uses this project’s configured report agent"}. Runs a read-only sample through the normal task and approval flow.`),
      formRow("Sample request", "The report shows what worked and what needs tools or permission. Enabled status alone does not prove use.",
        textarea({ id: `skill-sample-${skill.sha.slice(0, 12)}`, name: "sample", rows: 3, value: options.draft?.["sha"] === skill.sha ? (options.draft?.["sample"] ?? "") : "",
          attrs: { required: true, maxlength: 800, placeholder: "Review this project’s home page and suggest three clearer button labels.", "aria-label": "Sample request" } }), "top"),
      acts(btn("Create test", { sm: true, type: "submit" })),
    ]), { sha: skill.sha, nonce: randomUUID() }), options.draft?.["sha"] === skill.sha) : "";
    return settingsRecord({
      title: html`<span>${skill.name}</span>${chip(enabled ? "Enabled" : "In library", enabled ? "done" : "")}`,
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
    lead: `${active ? `${active} skill${active === 1 ? "" : "s"} enabled for new tasks.` : "No skills enabled for this project."} Active tasks keep their saved versions.`,
    body: joinHtml([add, search, cards.length ? joinHtml(cards) : note("Your library is empty. Add a skill to review and enable it here."), history]),
  });
  return joinHtml([options.error ? notice(options.error) : "", library]);
}
export function skillsSnapshotHtml(snapshot: SkillsSnapshot | null): Html | "" {
  if (!snapshot || !snapshot.packages.length) return "";
  return html`<details class="skills"><summary>Skills supplied (${snapshot.packages.length})</summary><p class="meta">Exact versions supplied to this run. This does not confirm the agent read or applied them.</p>${snapshot.packages.map((s) => html`<details><summary>${s.name} · ${s.sha.slice(0, 10)}</summary>${source(s)}</details>`)}</details>`;
}
export function skillsScript() {
  return `(()=>{const search=document.querySelector('[data-skill-search]');if(search)search.addEventListener('input',()=>{let found=0;document.querySelectorAll('[data-skill-group]').forEach(el=>{el.hidden=!el.dataset.skillQuery.toLowerCase().includes(search.value.trim().toLowerCase());if(!el.hidden)found++;});document.querySelector('[data-skill-no-matches]').hidden=found>0;});const form=document.querySelector('[data-skill-import]');if(!form)return;const method=form.querySelector('[data-skill-method]'),error=form.querySelector('[data-skill-error]');function sync(){form.querySelectorAll('[data-skill-input]').forEach(el=>{el.hidden=el.dataset.skillInput!==method.value;el.querySelectorAll('input,textarea').forEach(i=>i.disabled=el.hidden);});}method.addEventListener('change',sync);sync();form.addEventListener('submit',async event=>{if(method.value!=='folder')return;if(form.dataset.prepared==='yes'){delete form.dataset.prepared;return;}event.preventDefault();error.hidden=true;error.textContent='';const button=form.querySelector('button');button.disabled=true;try{const files=Array.from(form.querySelector('[data-skill-folder]').files);if(!files.length||files.length>64||files.reduce((n,f)=>n+f.size,0)>1048576||files.some(f=>f.size>262144))throw Error('Choose one skill folder with up to 64 files and 1 MB total.');const packed=[];for(const file of files){const parts=file.webkitRelativePath.split('/');parts.shift();const data=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of data)binary+=String.fromCharCode(byte);packed.push({path:parts.join('/'),base64:btoa(binary)});}form.querySelector('[name=files]').value=JSON.stringify(packed);form.dataset.prepared='yes';button.disabled=false;form.requestSubmit();}catch(e){error.textContent=e.message||'The folder could not be read. Select it again.';error.hidden=false;button.disabled=false;}});})();`;
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
