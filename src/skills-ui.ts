import { randomUUID } from "node:crypto";
import { whenUtc } from "./when-html.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
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
    return html`<article class="card" id="skill-${skill.sha}"><div class="skill-heading"><h2>${skill.name}</h2><span class="skill-state">${enabled ? "Enabled" : "In library"}</span></div><p>${skill.description}</p>${skill.requirements ? html`<p><strong>Requires:</strong> ${skill.requirements} <span class="meta">Availability is checked when the agent tests or uses it.</span></p>` : ""}${skill.warnings.map((w) => html`<p class="meta">${w}</p>`)}<details${options.focus === skill.sha ? html` open` : ""}><summary>Review skill</summary>${source(skill)}${manage ? form(enabled ? "disable" : "enable", html`${replaced ? html`<p>Replaces the enabled version of this skill for new tasks.</p>` : ""}<button>${enabled ? "Disable skill" : "Enable skill"}</button>`, { sha: skill.sha }) : ""}</details>${manage ? html`<details${options.draft?.["sha"] === skill.sha ? html` open` : ""}><summary>Test skill</summary>${form("test", html`<p>${options.agent ?? "Uses this project’s configured report agent"}. Runs a read-only sample through the normal task and approval flow.</p><label>Sample request<textarea name="sample" required maxlength="800" placeholder="Review this project’s home page and suggest three clearer button labels.">${options.draft?.["sha"] === skill.sha ? (options.draft?.["sample"] ?? "") : ""}</textarea></label><p class="meta">The report shows what worked and what needs tools or permission. Enabled status alone does not prove use.</p><button>Create test</button>`, { sha: skill.sha, nonce: randomUUID() })}</details>` : ""}</article>`;
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
      return html`<div data-skill-group data-skill-query="${name + " " + primary.description}">${renderSkill(primary)}${older.length ? html`<details><summary>Other versions (${older.length})</summary>${older.map(renderSkill)}</details>` : ""}</div>`;
    });
  const search =
    names.length > 5
      ? html`<label>Search library<input type="search" data-skill-search placeholder="Name or description"></label><p data-skill-no-matches hidden>No matching skills.</p>`
      : "";
  const d = options.draft ?? {};
  const add = manage
    ? html`<details class="card"${options.error && options.draft?.["method"] ? html` open` : ""}><summary>Add skill</summary>${postForm("/settings/skills/import", html`<label>Add from<select name="method" data-skill-method><option value="paste"${d["method"] === "paste" ? html` selected` : ""}>Paste SKILL.md</option><option value="github"${d["method"] === "github" ? html` selected` : ""}>GitHub folder</option><option value="folder"${d["method"] === "folder" ? html` selected` : ""}>Local folder</option></select></label><div data-skill-input="paste"><label>SKILL.md<textarea name="content" rows="8" maxlength="24576" placeholder="---&#10;name: design-review&#10;description: Review interface copy and layout.&#10;---&#10;Write your instructions here.">${d["content"]}</textarea></label></div><div data-skill-input="github"><label>Public GitHub folder<input name="url" type="url" value="${d["url"]}" placeholder="https://github.com/owner/repo/tree/main/skills/review"></label></div><div data-skill-input="folder"><label>Skill folder<input type="file" webkitdirectory multiple data-skill-folder></label><input type="hidden" name="files" value=""><p class="meta">Choose the folder containing SKILL.md. Up to 64 files, 1 MB total.</p><noscript>Folder uploads require JavaScript. You can paste SKILL.md or use a GitHub folder.</noscript></div><p class="meta">Added to your library first. Review its source and requirements before enabling it.</p><p data-skill-error role="alert" hidden></p><button>Add to library</button>`, { attrs: { "data-skill-import": true }, hidden: fields(base) })}</details>`
    : "";
  const history = view.history.length
    ? html`<details><summary>Change history</summary>${view.history.map((h) => html`<div class="card"><p>Selection ${h.revision} · ${h.actor} · ${whenUtc(h.at)}</p><ul>${h.enabled.length ? h.enabled.map((s) => html`<li>${s.name} · ${s.version}</li>`) : html`<li>No skills enabled</li>`}</ul>${manage && h.revision !== view.revision ? form("restore", html`<button>Restore selection</button>`, { restore: h.revision }) : html`<span class="meta">Current selection</span>`}</div>`)}</details>`
    : "";
  return html`<section class="skills">${options.error ? html`<p class="problem" role="alert">${options.error}</p>` : ""}<p>${active ? `${active} skill${active === 1 ? "" : "s"} enabled for new tasks.` : "No skills enabled for this project."} Active tasks keep their saved versions.</p>${add}${search}${cards.length ? cards : html`<p>Your library is empty. Add a skill to review and enable it here.</p>`}${history}</section>`;
}
export function skillsSnapshotHtml(snapshot: SkillsSnapshot | null): Html | "" {
  if (!snapshot || !snapshot.packages.length) return "";
  return html`<details class="skills"><summary>Skills supplied (${snapshot.packages.length})</summary><p class="meta">Exact versions supplied to this run. This does not confirm the agent read or applied them.</p>${snapshot.packages.map((s) => html`<details><summary>${s.name} · ${s.sha.slice(0, 10)}</summary>${source(s)}</details>`)}</details>`;
}
export function skillsScript() {
  return `(()=>{const search=document.querySelector('[data-skill-search]');if(search)search.addEventListener('input',()=>{let found=0;document.querySelectorAll('[data-skill-group]').forEach(el=>{el.hidden=!el.dataset.skillQuery.toLowerCase().includes(search.value.trim().toLowerCase());if(!el.hidden)found++;});document.querySelector('[data-skill-no-matches]').hidden=found>0;});const form=document.querySelector('[data-skill-import]');if(!form)return;const method=form.querySelector('[data-skill-method]'),error=form.querySelector('[data-skill-error]');function sync(){form.querySelectorAll('[data-skill-input]').forEach(el=>{el.hidden=el.dataset.skillInput!==method.value;el.querySelectorAll('input,textarea').forEach(i=>i.disabled=el.hidden);});}method.addEventListener('change',sync);sync();form.addEventListener('submit',async event=>{if(method.value!=='folder')return;if(form.dataset.prepared==='yes'){delete form.dataset.prepared;return;}event.preventDefault();error.hidden=true;const button=form.querySelector('button');button.disabled=true;try{const files=Array.from(form.querySelector('[data-skill-folder]').files);if(!files.length||files.length>64||files.reduce((n,f)=>n+f.size,0)>1048576||files.some(f=>f.size>262144))throw Error('Choose one skill folder with up to 64 files and 1 MB total.');const packed=[];for(const file of files){const parts=file.webkitRelativePath.split('/');parts.shift();const data=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of data)binary+=String.fromCharCode(byte);packed.push({path:parts.join('/'),base64:btoa(binary)});}form.querySelector('[name=files]').value=JSON.stringify(packed);form.dataset.prepared='yes';button.disabled=false;form.requestSubmit();}catch(e){error.textContent=e.message||'The folder could not be read. Select it again.';error.hidden=false;button.disabled=false;}});})();`;
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
