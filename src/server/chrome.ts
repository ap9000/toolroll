/** The console's page chrome: the shell, navigation, page scripts, the stylesheet and shared presentation helpers. */
import { accentStyle } from "../accent-colors.js";
import { APPROVAL_RULES_CSS } from "../approval-rules-ui.js";
import { ASSIGNMENT_CSS } from "../assignment-ui.js";
import { BACKUP_CSS } from "../backup-ui.js";
import { BRAND_MARK_CSS } from "../brand-mark.js";
import { type BrowserSignIn,type BrowserUpdateNotice,type BrowserWorkspace } from "../browser-workspace.js";
import { CHAT_POLISH_CSS } from "../chat-polish.js";
import { CHECK_SETTINGS_CSS } from "../check-levels-ui.js";
import { CODING_SHIPPING_CSS } from "../coding-shipping-ui.js";
import { CODING_CSS } from "../coding-ui.js";
import { CREDENTIALS_CSS } from "../credentials-ui.js";
import { DISCLOSURE_CSS } from "../disclosure.js";
import { EVIDENCE_PACK_CSS } from "../evidence-pack.js";
import { EXPORT_CSS } from "../export-ui.js";
import { START_COMMAND } from "../first-run.js";
import { GALLERY_CSS } from "../flow-gallery-ui.js";
import { STARTERS_CSS } from "../flow-starters-ui.js";
import { FLOWS_CSS } from "../flows-ui.js";
import { INTEGRATIONS_CSS } from "../integrations-ui.js";
import { KITS_CSS } from "../kits-ui.js";
import { KNOWLEDGE_CSS } from "../knowledge-ui.js";
import { LEAD_CONTEXT_CSS } from "../lead-context.js";
import { LIMITS_CSS } from "../limits-ui.js";
import { MOBILE_VIEWPORT_SCRIPT } from "../mobile-viewport.js";
import { MODELS_CSS } from "../models-ui.js";
import { MONITORING_CSS } from "../monitoring-ui.js";
import { PEOPLE_AUDIT_CSS } from "../people-audit-ui.js";
import { POLICY_CSS } from "../policy-ui.js";
import { PROJECT_DELETE_CSS } from "../project-delete-ui.js";
import { projectName } from "../project.js";
import { PULL_REQUEST_SETTINGS_CSS } from "../pull-request-ui.js";
import { RECIPE_CSS } from "../recipe-ui.js";
import { REQUEST_LIMITS_CSS } from "../request-budget-ui.js";
import { RETENTION_CSS } from "../retention-ui.js";
import { SKILLS_CSS } from "../skills-ui.js";
import { SPEND_CSS } from "../spend-ui.js";
import { SSO_CSS } from "../sso-ui.js";
import { STORAGE_CSS } from "../storage-ui.js";
import { type Decision,type Run } from "../store.js";
import { styleAsset } from "../style-asset.js";
import { spendLine,type tally } from "../summary.js";
import { TASK_STATUS_CSS } from "../task-status.js";
import { SUBAGENT_CSS } from "../subagents-ui.js";
import { UPDATES_CSS } from "../toolroll-update-ui.js";
import { TOOLS_CSS } from "../tools-ui.js";
import { TRANSITIONS_CSS } from "../transitions-recipes.js";
import { updateNoticeWords } from "../update-notice.js";
import { whenHtml } from "../when-html.js";
import { WORKSPACE_MOTION_CSS } from "../workspace-motion.js";
import { primaryDestinationOf } from "../workspace-ui.js";
import { requestContext } from "./request-context.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { attributes, html, joinHtml, postForm, scriptElement, styleElement, type Html } from "../html.js";
import { page,respond } from "./http.js";
import { type ProjectPeek } from "./render-pages.js";
import { type Who } from "./session.js";

/** The spend line for a 7am reader: whole cents, "runs", the gap still named. */
export function consoleSpend(summary: ReturnType<typeof tally<Run & { taskId: string }>>): string {
  if (summary.invoked.length === 0) return "nothing — no provider was invoked";
  if (summary.measured.some(run => run.authMode === "subscription")) return spendLine(summary);
  const dollars = `$${summary.spend.toFixed(2)}`;
  // The measured count rides the SAME clause as the total (Phase 3 A6):
  // a bare sum over a mixed fleet reads as complete, and is not.
  if (summary.measured.length === summary.invoked.length) {
    return `${dollars} across ${summary.invoked.length} run(s)`;
  }
  return `${dollars} measured across ${summary.measured.length} of ${summary.invoked.length} runs — the rest report tokens only`;
}

/** ISO to the minute — "2026-08-12 17:56" — for anywhere a person reads a time. */
export function when(iso: string | null): string {
  return iso === null ? "" : iso.slice(0, 16).replace("T", " ");
}

/** The same minute as a `<time>`: the full stamp on a desk, "16:39" / "Yesterday 16:39" / "Sep 28" on a phone. */
export function whenTime(iso: string | null): Html {
  return iso === null ? html`` : whenHtml(iso, when(iso));
}

/** Overdue is derived at render — display never writes. */
export function isOverdue(decision: Decision, now: Date): boolean {
  if (decision.state === "expired") return true;
  return (
    decision.state === "open" && decision.deadline !== null && decision.deadline <= now.toISOString()
  );
}

/**
 * A refusal that stays inside the console: same shell, a problem banner, and
 * a way back — the error path is the one place a console must not stop
 * being a console. Bearer callers still get plain text; they parse, not read.
 */
export function refuse(
  response: ServerResponse,
  who: Who | null,
  status: number,
  message: string,
  backHref = "/",
): void {
  if (who === null || who.via === "bearer") {
    return respond(response, status, "text/plain; charset=utf-8", message);
  }
  const body = joinHtml([
    html`<h1>${status === 404 ? "Not found" : "Request refused"}</h1>`,
    // A missing page is plain news, not an error.
    status === 404 ? html`<p>${message}</p>` : html`<div class="problem">${message}</div>`,
    html`<p class="meta refusal-back"><a href="${backHref}">\u2190 Back</a></p>`,
  ], "\n");
  // A signed-in browser keeps the workspace around it: the same navigation as every page.
  const framed = requestContext.getStore()?.refusal;
  if (framed !== undefined && who.via === "cookie") return framed(response, status, body);
  return page(response, status, shell("refused", body));
}

/** The demo's one-line promise, on every page. */
export const DEMO_BANNER = `Demo: a scripted lead and sample projects. Nothing calls a model, reaches outside or spends. For your own project, run ${START_COMMAND} in its folder.`;
/** The demo notice on a phone: one line. */
export const DEMO_BANNER_SHORT = "Demo: sample projects. Nothing calls a model or spends.";

/**
 * The Operations Ledger: the design system Alex approved in Figma and the
 * design/ shadcn package, carried as pure CSS on server-rendered HTML.
 * Deliberately not the React library: the console ships zero dependencies
 * and zero page JavaScript under a CSP that forbids scripts, and a look is
 * not worth that posture. The same semantic tokens render both system light
 * and dark themes.
 */
/** The shared palette, light and dark (2026-09-27, "Signal"): neutral grey
 * grounds, ink for every act a person can take, and one chart magenta, the
 * colour nautical charts print lights and cautions in, for what needs a
 * person (the needs-you count, the act that resolves a screen, focus and
 * selection). Status keeps its own four hues; magenta never means "failed".
 * The frame is the ground the sidebar sits on; work sits on paper sheets
 * inset into it. Semantic names only; every surface (server pages, the
 * React workspace, the pre-script fallback) reads these.
 *
 * The console's stylesheet lives in console.css, shipped beside this module:
 * the palette above in light, dark and pinned themes, then the page rules.
 * Its bytes are the served sheet's (WORKSPACE_STYLE hashes them). */
export const STYLE = readFileSync(join(import.meta.dirname, "console.css"), "utf8");

/** Appearance: a three-way segmented switch, one tap per choice. */
export const THEME_CONTROLS_CSS = `.task-repo select{width:100%;min-height:2.75rem;font-size:1rem}.task-repo-add{margin:.35rem .1rem .5rem}.task-repo-add a{display:inline-flex;align-items:center;min-height:2.25rem}details.result-request-open.result-request-form>summary{border:0;background:transparent;padding:.5rem 0;min-height:2.75rem;font-weight:600;display:list-item;list-style:revert}details.result-request-open.result-request-form>summary::-webkit-details-marker{display:revert}form.js-autosave button[type=submit]{display:none}.provider-row{border-bottom:1px solid var(--so-line);padding:.35rem 0}.provider-row:first-of-type{border-top:1px solid var(--so-line)}.provider-head{display:flex;align-items:center;gap:.75rem;margin:.4rem 0 0}.provider-status{display:inline-flex;align-items:center;gap:.4rem;color:var(--so-muted);font-size:.875rem}.provider-status i{width:.5rem;height:.5rem;border-radius:50%;background:var(--so-muted)}.provider-status--ok i{background:var(--so-success)}.provider-status--warn i{background:var(--so-attention)}.provider-status--off i{background:transparent;border:1.5px solid var(--so-muted)}details.provider-manage>summary{cursor:pointer;color:var(--so-accent-text);font-size:.875rem;min-height:2.5rem;display:list-item;padding-block:.5rem}.card.props .row{display:grid;gap:.1rem;margin:0 0 .75rem}.card.props .row>.meta{display:block;font-size:.75rem}.card.props .row>.meta::first-letter{text-transform:uppercase}.card.props .row>.mono{font-family:var(--font-sans);font-size:.875rem}.card.props .row>.mono .seal{font-family:var(--font-mono);font-size:.8125rem}details.evidence-files{margin:1rem 0}details.evidence-files>summary{cursor:pointer;min-height:2.75rem;display:list-item;padding-block:.7rem;font-weight:600}details.evidence-files ul{list-style:none;margin:0;padding:0}details.evidence-files li{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--so-line)}.result-action .result-feedback-link{display:inline-flex;align-items:center;min-height:2.5rem;padding:.5rem 1rem;border:1px solid var(--so-input-line);border-radius:.5rem;background:var(--so-paper);color:var(--so-ink);font-weight:600;text-decoration:none}@media(hover:hover) and (pointer:fine){.result-action .result-feedback-link:hover{background:var(--so-raised)}}.so-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.verdict{margin:.5rem 0 .75rem}.verdict-chips{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0;margin:0}.verdict-chip{display:inline-flex;align-items:center;gap:.3rem;min-height:1.75rem;padding:.2rem .65rem;border-radius:999px;font-size:.8125rem;font-weight:600;background:var(--so-neutral-soft);color:var(--so-neutral-ink)}.verdict-chip svg{width:.9rem;height:.9rem}.verdict-chip--success{background:var(--so-success-soft);color:var(--so-success)}.verdict-chip--danger{background:var(--so-danger-soft);color:var(--so-danger)}.verdict-chip--warning{background:var(--so-warning-soft);color:var(--so-warning)}.verdict-chip--info{background:var(--so-info-soft);color:var(--so-info)}.verdict-by{margin:.4rem 0 0}details.result-request-open{margin:.5rem 0}details.result-request-open>summary{display:inline-flex;align-items:center;min-height:2.5rem;padding:.5rem 1rem;border:1px solid var(--so-input-line);border-radius:.5rem;background:var(--so-paper);color:var(--so-ink);font-weight:600;cursor:pointer;list-style:none}details.result-request-open>summary::-webkit-details-marker{display:none}details.result-request-open[open]>summary{margin-bottom:.75rem}.settings-tiles{display:grid;gap:1.25rem;margin:0 0 2rem}.settings-tiles h2{margin:0 0 .5rem;font-size:.875rem;font-weight:600;color:var(--so-muted)}.settings-tiles section>div{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.5rem}.settings-tiles a>span{display:grid;gap:.1rem;min-width:0}.settings-tiles .provider-status{font-weight:400;font-size:.8125rem}.settings-tiles a{display:flex;align-items:center;gap:.6rem;min-height:3rem;padding:.65rem .8rem;border:1px solid var(--so-line);border-radius:.625rem;background:var(--so-paper);color:var(--so-ink);text-decoration:none;font-weight:550;font-size:.875rem}@media(hover:hover) and (pointer:fine){.settings-tiles a:hover{border-color:var(--so-input-line);background:var(--so-raised)}}.settings-tiles a>svg{width:1.1rem;height:1.1rem;flex-shrink:0;color:var(--so-accent-text)}details.settings-more{margin:.25rem 0 1.25rem}details.settings-more>summary{cursor:pointer;min-height:2.75rem;display:list-item;padding-block:.7rem;font-weight:550}details.settings-more>summary .meta{font-weight:400;margin-left:.35rem}.settings-changed{margin-top:-.25rem}.appearance{margin:0 0 28px}.appearance h2{margin:0 0 10px}.theme-switch{display:inline-flex;flex-wrap:nowrap;max-width:100%;gap:4px;padding:4px;margin:0;border:1px solid var(--so-line);border-radius:10px;background:var(--so-raised)}.theme-switch .theme-choice,.so-native-region .theme-switch .theme-choice{flex:1 1 0;width:auto;white-space:nowrap;min-height:40px;padding:8px 16px;border:0;border-radius:7px;background:transparent;color:var(--so-muted);font:inherit;font-weight:550;box-shadow:none;cursor:pointer}@media(hover:hover) and (pointer:fine){.theme-switch .theme-choice:hover{color:var(--so-ink)}}.theme-switch .theme-choice[aria-pressed="true"]{background:var(--so-paper);color:var(--so-ink);box-shadow:0 1px 2px rgb(0 0 0 / .1)}.appearance .meta{margin:8px 0 0}@media(max-width:600px){.theme-switch .theme-choice{min-height:44px}}.update-notes{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:18rem;overflow:auto}`;
/** The page CSS this module writes itself (not the imported modules'), for the stylesheet contract tests. */
export const PAGE_CSS = STYLE + THEME_CONTROLS_CSS;
/** The Inbox tabs (console v2): a segmented track of real links; the dot marks a tab with something new, on phones only. */
export const INBOX_TABS_CSS = '.inbox-tabs{display:inline-flex;gap:2px;max-width:100%;overflow-x:auto;margin:4px 0 14px;padding:2px;border-radius:12px;background:var(--so-raised);scrollbar-width:none}' +
  '.inbox-tabs a{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 10px;border-radius:8px;color:var(--so-muted);font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap}' +
  '.inbox-tabs a[aria-current="page"]{background:var(--so-paper);color:var(--so-ink);box-shadow:var(--so-pill-shadow)}' +
  '.inbox-tab-count{min-width:18px;padding:0 5px;border-radius:9999px;font:500 11px/18px var(--so-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;text-align:center}' +
  '.inbox-tab-count--needs{background:var(--so-signal);color:var(--so-on-signal)}' +
  '.inbox-ask{margin:18px 0 0}.inbox-ask>h2{display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:15px;font-weight:600}.inbox-ask>h2 .count{font:500 12px var(--so-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;color:var(--so-muted)}.inbox-ask h3{font-size:13px;font-weight:600;margin:12px 0 4px}' +
  '.inbox-unread{display:none;position:absolute;top:4px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--so-signal)}' +
  '@media (max-width:760px){.inbox-tabs{display:flex;width:100%}.inbox-tabs a{flex:1;justify-content:center;min-height:44px;padding:0 6px}.inbox-unread{display:block}}';
export const WORKSPACE_STYLE = styleAsset(STYLE + BRAND_MARK_CSS + INBOX_TABS_CSS + APPROVAL_RULES_CSS + SPEND_CSS + RETENTION_CSS + STORAGE_CSS + UPDATES_CSS + LIMITS_CSS + MONITORING_CSS + INTEGRATIONS_CSS + BACKUP_CSS + EXPORT_CSS + PROJECT_DELETE_CSS + POLICY_CSS + EVIDENCE_PACK_CSS + THEME_CONTROLS_CSS + CODING_CSS + CODING_SHIPPING_CSS + RECIPE_CSS + SKILLS_CSS + TOOLS_CSS + FLOWS_CSS + SUBAGENT_CSS + KITS_CSS + STARTERS_CSS + GALLERY_CSS + SSO_CSS + CREDENTIALS_CSS + REQUEST_LIMITS_CSS + PEOPLE_AUDIT_CSS + KNOWLEDGE_CSS + MODELS_CSS + CHAT_POLISH_CSS + TRANSITIONS_CSS + WORKSPACE_MOTION_CSS + ASSIGNMENT_CSS + TASK_STATUS_CSS + LEAD_CONTEXT_CSS + PULL_REQUEST_SETTINGS_CSS + CHECK_SETTINGS_CSS + DISCLOSURE_CSS + '.learning{min-width:0;overflow-wrap:anywhere}.learning .card{min-width:0}.learning code,.learning blockquote,.learning pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.learning button,.learning summary,.learning .button-link{min-height:44px}.learning button{white-space:nowrap}.learning summary{padding:12px 0;cursor:pointer}.learning form{margin:12px 0}.learning select{max-width:100%}.learning blockquote{margin:8px 0}.learning ul{padding-left:20px}');

/** Everything the sidebar needs to draw itself for one request. */
export type Chrome = {
  projectScoped?: boolean;
  active: "code" | "inbox" | "board" | "queue" | "fleet" | "workbench" | "work" | "done" | "activity" | "review" | "system" | "tasks" | "runs" | "caps" | "recipes" | "projects" | "flows" | "settings" | "chat" | "people" | "ledger" | "spend" | "mode" | "menu" | "none";
  project: string | null;
  /** The surface's scope for the scope bar — which rows this screen can
   * show. Derived from the ROUTE, not the session: portfolio and fleet are
   * all-project even while a project is open; the board says which of its
   * two modes it is in. Absent = the session default (open project, else
   * all projects). Display only — switching stays POST + CSRF. */
  scope?: "all" | "project" | "board-all";
  /** The saturated inbox count — never a sum of unbounded list reads. */
  inboxCount: number;
  /** The project the Tasks count covers: the request's own project view
   * (the open project, or /work's ?project=), null for every admitted project. */
  inboxProject?: string | null;
  /** The Tasks badge's words, naming what it covers: "3 need you in shop". */
  inboxLabel?: string;
  inboxSaturated: boolean;
  settings: boolean;
  /** This database is a demo sandbox: banner every page, spend fenced. */
  demo?: boolean;
  /** The active operating mode's banner (M1): rides every page scoped to
   * a repo with a live mode — a signed posture is never invisible. */
  modeBanner?: { words: string; name: string };
  /** Providers whose sign-in stopped working: every page says so, once. */
  signIn?: BrowserSignIn[];
  /** A newer Toolroll: a quiet notice for an operator until they dismiss this version. */
  update?: BrowserUpdateNotice;
  /** An update waiting on something, what, and the action that clears it: every page, for an operator. */
  updateWaiting?: { words: string };
  /** The chat tab renders only where chat could ever be allowed. */
  chat?: boolean;
  code?: boolean;
  /** A rendered list pane makes the page master-detail. */
  listPane?: Html;
  /** A compact pulse for the currently open workspace. Null in the
   * cross-workspace view; absent only when the store could not answer. */
  projectPeek?: ProjectPeek | null;
  /** The switcher (board pass): every enrolled project inside the ceiling,
   * most recently opened first — the one-tap switch on any screen. */
  projects?: { path: string; name: string }[];
  /** The session's csrf token, for the switcher's forms; "" when the
   * request has no cookie session (bearer), which renders the switcher
   * inert. */
  csrf?: string;
  /** Where a switch made on this screen returns to. */
  returnTo?: string;
};

/**
 * A server-rendered region that stays current: when the page's live stream
 * says something changed (GET /live, live-bus.ts), fetch this page's own
 * fragment and swap it in place — no flicker, no scroll reset. Inside the
 * workspace the page's one stream is already open (browser/live.ts) and
 * announces each event on `window`; a page without it opens its own stream
 * to the workspace room. A redirect or auth failure navigates to /login
 * instead of ever inserting the login page into the region (finding 4). The
 * swapped markup is this server's own rendering of the same route — escaped
 * at the sink like every page, fetched same-origin — and the nonce'd CSP
 * refuses to execute anything the region could smuggle. Nothing reads on a timer.
 */
export function regionScript(regionId: string, fragmentName: string, path?: string): string {
  // Where the fragment lives: the page's own URL by default; an explicit
  // path when a page embeds another entity's region (the task page embeds
  // the live run's peek, slice 1c — no proxy route exists for it).
  const target = path === undefined ? "location.pathname+q" : JSON.stringify(`${path}?fragment=${fragmentName}`);
  // The named-region refresher (attended review, finding 2): swaps exactly one
  // element, never a form-bearing pane. Failures are VISIBLE — a frozen
  // page must never look live (finding 6): the stamp says how old the
  // region is. One fetch in flight at a time; a change during it fetches once more.
  return (
    `(function(){var region=document.getElementById(${JSON.stringify(regionId)});if(!region)return;` +
    `var stamp=document.getElementById(${JSON.stringify(regionId)}+"-stamp");` +
    `var last=Date.now();var busy=false;var again=false;var failed=false;var stopped=false;` +
    // The swap must not steal what the reader was holding (arc 4,
    // findings 1/15/16): before replacing the region, remember the
    // focused row (roving set only), each scrolled lane's first visible
    // card, and which board lane was centered; put them back after —
    // scroll first, focus last with preventScroll so it cannot undo the
    // scroll pass. All coordinates come from bounding rects, never
    // offsetLeft against an unpositioned parent (finding 21).
    `function laneKey(l){var m=/(^|\\s)(lane-[a-z]+)(\\s|$)/.exec(l.className);return m?m[2]:null;}` +
    `function keep(){var data={lanes:[],focus:null,pager:-1,fold:{}};` +
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k)data.fold[k]=d.open;});` +
    `var act=document.activeElement;` +
    `if(act&&region.contains(act)&&act.matches&&act.matches("a.row, a.lane-card"))data.focus=act.getAttribute("href");` +
    `var board=region.querySelector(".board");` +
    `if(board&&board.scrollLeft>0){var lanes=board.querySelectorAll(".lane");` +
    `var bc=board.getBoundingClientRect();var mid=bc.left+bc.width/2;var best=-1,bd=1e9;` +
    `for(var i=0;i<lanes.length;i++){var r=lanes[i].getBoundingClientRect();var d=Math.abs(r.left+r.width/2-mid);if(d<bd){bd=d;best=i;}}` +
    `data.pager=best;}` +
    `var ls=region.querySelectorAll(".lane");` +
    `for(var i=0;i<ls.length;i++){var l=ls[i];if(l.scrollTop<=0)continue;var key=laneKey(l);if(!key)continue;` +
    `var first=null,off=0;var cards=l.querySelectorAll("a.lane-card");var lr=l.getBoundingClientRect();` +
    `for(var j=0;j<cards.length;j++){var cr=cards[j].getBoundingClientRect();if(cr.bottom>lr.top){first=cards[j].getAttribute("href");off=cr.top-lr.top;break;}}` +
    `data.lanes.push({key:key,href:first,off:off,top:l.scrollTop});}` +
    `return data;}` +
    `function restore(data){` +
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k&&k in data.fold){if(data.fold[k])d.setAttribute("open","");else d.removeAttribute("open");}});` +
    `for(var i=0;i<data.lanes.length;i++){var d=data.lanes[i];var l=region.querySelector(".lane."+d.key);if(!l)continue;` +
    `var done=false;` +
    `if(d.href){var cards=l.querySelectorAll("a.lane-card");` +
    `for(var j=0;j<cards.length;j++){if(cards[j].getAttribute("href")===d.href){` +
    `l.scrollTop=Math.max(0,l.scrollTop+cards[j].getBoundingClientRect().top-l.getBoundingClientRect().top-d.off);done=true;break;}}}` +
    `if(!done)l.scrollTop=d.top;}` +
    `if(data.pager>=0){var board=region.querySelector(".board");` +
    `if(board){var lanes=board.querySelectorAll(".lane");var at=Math.min(data.pager,lanes.length-1);` +
    `if(at>=0){var br=board.getBoundingClientRect();var lr=lanes[at].getBoundingClientRect();` +
    `board.scrollLeft=board.scrollLeft+(lr.left+lr.width/2)-(br.left+br.width/2);}}}` +
    `if(data.focus!==null){var links=region.querySelectorAll("a.row, a.lane-card");` +
    `for(var i=0;i<links.length;i++){if(links[i].getAttribute("href")===data.focus){links[i].focus({preventScroll:true});break;}}}}` +
    `function tell(){if(!stamp||stopped)return;var s=Math.round((Date.now()-last)/1000);` +
    `stamp.textContent=failed?"stale — retrying ("+s+"s old)":"updated "+s+"s ago";}` +
    `setInterval(tell,1000);` +
    `function refresh(){if(stopped)return;if(busy){again=true;return;}busy=true;again=false;` +
    `var q=location.search?location.search+"&fragment="+${JSON.stringify(fragmentName)}:"?fragment="+${JSON.stringify(fragmentName)};` +
    `fetch(${target},{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t){var kept=keep();region.innerHTML=t;restore(kept);last=Date.now();failed=false;}else{failed=true;}})` +
    `.catch(function(){failed=true;})` +
    // A fragment that marks itself final stops: a finished or abandoned build is not fetched again.
    `.then(function(){busy=false;tell();if(region.querySelector("[data-region-stop]")){stopped=true;if(stamp)stamp.textContent="";return;}if(again)refresh();});}` +
    `function heard(name){if(name==="change"||name==="reload")refresh();}` +
    `if(document.documentElement.dataset.live==="1"){addEventListener("so:live",function(e){heard(e.detail&&e.detail.event);});}` +
    `else if(typeof EventSource!=="undefined"){var es=new EventSource("/live?room=workspace");` +
    `es.addEventListener("change",function(){heard("change");});es.addEventListener("reload",function(){heard("reload");});` +
    `document.addEventListener("visibilitychange",function(){if(!document.hidden)refresh();});}` +
    `})();`
  );
}

/**
 * The live transcript's DEDICATED poller (arc 1 §4): a JSON byte-offset
 * protocol, not an HTML fragment — the response is raw sanitized text and
 * the ONLY sink is textContent, so nothing here can become markup. One
 * request in flight, visibility-paused, stops on `final`, and a `replaced`
 * answer restarts from zero with a visible line — never a silent re-read.
 */
export function transcriptScript(path?: string, elementId = "live-transcript"): string {
  const base = path === undefined ? "location.pathname" : JSON.stringify(path);
  return (
    `(function(){var out=document.getElementById(${JSON.stringify(elementId)});if(!out)return;` +
    `var from=0,busy=false,stopped=false;` +
    `function near(){return out.scrollHeight-out.scrollTop-out.clientHeight<40;}` +
    `function go(){if(stopped)return;if(busy||document.hidden){later();return;}busy=true;` +
    `fetch(${base}+"?fragment=transcript&from="+from,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){stopped=true;return null;}` +
    `if(r.status===409)return{error:"replaced"};return r.ok?r.json():null;})` +
    `.then(function(d){busy=false;if(d===null){later();return;}if(stopped)return;` +
    `if(d.error==="replaced"){from=0;out.textContent="[the view restarted]\\n";later();return;}` +
    `if(d.error){stopped=true;return;}` +
    `var stick=near();` +
    `if(typeof d.text==="string"&&d.text!==""){out.appendChild(document.createTextNode(d.text));if(stick)out.scrollTop=out.scrollHeight;}` +
    `if(typeof d.nextOffset==="number"&&d.nextOffset>=from){from=d.nextOffset;}` +
    `if(d.final===true){stopped=true;var m=document.getElementById(${JSON.stringify(`${elementId}-state`)});` +
    `if(m)m.textContent="the agent finished — the record on this page is the story";return;}` +
    `later();})` +
    `.catch(function(){busy=false;later();});}` +
    `function later(){setTimeout(go,2000);}go();})();`
  );
}

/**
 * The chrome layer: the jump palette and elapsed tickers. Pure
 * navigation — no key ever posts, so the palette cannot approve anything;
 * ceremonies stay POST + password + CSRF, untouched. Reads its index from
 * a non-executable JSON script tag rendered by the same authorized page.
 */
/** The rail's presentation-only state is safe beside a password ceremony:
 * it never reads a field or sends a request, and keeps the chat collapsible
 * from its very first screen while the palette and global keys remain absent. */
export function sidebarScript(): string {
  return (
    MOBILE_VIEWPORT_SCRIPT +
    `(function(){var app=document.querySelector(".app"),sideToggle=document.querySelector(".side-toggle");` +
    `function setSide(collapsed){if(!app||!sideToggle)return;app.classList.toggle("sidebar-collapsed",collapsed);` +
    `sideToggle.setAttribute("aria-expanded",String(!collapsed));sideToggle.setAttribute("aria-label",collapsed?"expand sidebar":"collapse sidebar");` +
    `sideToggle.setAttribute("title",collapsed?"expand sidebar":"collapse sidebar");}` +
    `if(app&&sideToggle){var sideCollapsed=false;try{sideCollapsed=localStorage.getItem("standing-orders:sidebar-collapsed")==="1";}catch(e){}` +
    `setSide(sideCollapsed);sideToggle.addEventListener("click",function(){var next=!app.classList.contains("sidebar-collapsed");setSide(next);` +
    `try{localStorage.setItem("standing-orders:sidebar-collapsed",next?"1":"0");}catch(e){}});}})();`
  );
}

export function chromeScript(): string {
  return (
    sidebarScript() +
    `(function(){` +
    // The app-icon badge (Phase 2E): the page's server-rendered waiting
    // count is authoritative over any stale push — synced on every chrome
    // page load through the worker, cleared at zero, honest no-op where
    // push never enrolled.
    `try{var waiting=document.querySelector("[data-waiting]");` +
    `if(waiting&&navigator.serviceWorker&&navigator.serviceWorker.controller){` +
    `navigator.serviceWorker.controller.postMessage({badge:Number(waiting.getAttribute("data-waiting"))||0});}}catch(e){}` +
    // elapsed tickers: server timestamps, client arithmetic, display only
    `function tick(){var nodes=document.querySelectorAll("time[data-elapsed-since]");` +
    `for(var i=0;i<nodes.length;i++){var t=Date.parse(nodes[i].getAttribute("data-elapsed-since"));` +
    `if(!isFinite(t))continue;var s=Math.max(0,Math.floor((Date.now()-t)/1000));` +
    `var m=Math.floor(s/60);var h=Math.floor(m/60);` +
    `nodes[i].textContent=h>0?h+"h "+(m%60)+"m":m>0?m+"m "+(s%60)+"s":s+"s";}}` +
    `setInterval(tick,1000);tick();` +
    // The rail's two accordion groups stay exclusive: opening one closes
    // the other. Each <details> already carries its own open/closed state
    // and keyboard operation natively — this only enforces "at most one
    // open" on top of that, and no-ops wherever the groups are absent.
    `var navGroups=document.querySelectorAll(".nav-group");` +
    `navGroups.forEach(function(g){g.addEventListener("toggle",function(){` +
    `if(g.open){navGroups.forEach(function(o){if(o!==g)o.removeAttribute("open");});}});});` +
    // the palette
    `var raw=document.getElementById("palette-index");if(!raw)return;` +
    `var index;try{index=JSON.parse(raw.textContent||"[]");}catch(e){return;}` +
    `var open=false,box=null,list=null,input=null,items=[],paletteBack=null;` +
    `function close(){if(!open)return;open=false;box.remove();box=null;if(paletteBack&&paletteBack.isConnected)paletteBack.focus();paletteBack=null;}` +
    `function go(href){location.href=href;}` +
    `function render(filter){list.textContent="";items=[];var n=0;` +
    `for(var i=0;i<index.length&&n<12;i++){var e=index[i];` +
    `if(filter&&(e.label.toLowerCase().indexOf(filter.toLowerCase())===-1))continue;` +
    `var li=document.createElement("li");li.setAttribute("role","option");li.textContent=e.label;` +
    `li.setAttribute("data-href",e.href);if(n===0)li.setAttribute("aria-selected","true");` +
    `li.addEventListener("click",function(ev){go(ev.currentTarget.getAttribute("data-href"));});` +
    `list.appendChild(li);items.push(li);n++;}}` +
    `function pick(delta){var at=-1;for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")at=i;` +
    `if(at>=0)items[at].removeAttribute("aria-selected");var next=Math.max(0,Math.min(items.length-1,at+delta));` +
    `if(items[next])items[next].setAttribute("aria-selected","true");}` +
    `function show(){if(open)return;paletteBack=document.activeElement;open=true;` +
    `box=document.createElement("div");box.className="palette";box.setAttribute("role","dialog");box.setAttribute("aria-label","jump to");` +
    `input=document.createElement("input");input.type="text";input.placeholder="jump to\u2026";input.setAttribute("autocomplete","off");` +
    `list=document.createElement("ul");list.setAttribute("role","listbox");` +
    `box.appendChild(input);box.appendChild(list);document.body.appendChild(box);` +
    `input.addEventListener("input",function(){render(input.value);});` +
    `input.addEventListener("keydown",function(ev){` +
    `if(ev.key==="Escape"){close();ev.preventDefault();}` +
    `else if(ev.key==="ArrowDown"){pick(1);ev.preventDefault();}` +
    `else if(ev.key==="ArrowUp"){pick(-1);ev.preventDefault();}` +
    `else if(ev.key==="Enter"){for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")go(items[i].getAttribute("data-href"));ev.preventDefault();}});` +
    `render("");input.focus();}` +
    // the shortcuts overlay: display-only; focus moves in on open and
    // back out on close; every other shortcut sleeps while it is up
    `var help=document.querySelector(".kbd-help");var helpBack=null;` +
    `function helpOpen(){return help!==null&&!help.hidden;}` +
    `function toggleHelp(){if(!help)return;` +
    `if(help.hidden){helpBack=document.activeElement;help.hidden=false;help.focus();}` +
    `else{help.hidden=true;if(helpBack&&helpBack.focus)helpBack.focus();helpBack=null;}}` +
    `document.addEventListener("click",function(ev){if(helpOpen()&&!help.contains(ev.target))toggleHelp();` +
    `document.querySelectorAll("details.switcher[open],details.work-tools[open]").forEach(function(d){if(!d.contains(ev.target))d.removeAttribute("open");});});` +
    `document.addEventListener("keydown",function(ev){if(ev.key!=="Escape"||ev.isComposing)return;var d=ev.target.closest&&ev.target.closest("details.switcher[open],details.work-tools[open]");if(d){d.open=false;d.querySelector("summary").focus();ev.preventDefault();}});` +
    // j/k: a roving focus over the page's rows — only from body or from
    // inside the set, clamped at the ends, preventDefault only on a real
    // move (finding 9); held keys may repeat
    `function rove(delta,ev){` +
    `var set=Array.prototype.slice.call(document.querySelectorAll("a.row, a.lane-card"));` +
    `if(set.length===0)return;` +
    `var cur=document.activeElement;var at=set.indexOf(cur);` +
    `if(cur&&cur!==document.body&&cur!==document.documentElement&&at===-1)return;` +
    `var next=at===-1?(delta>0?0:set.length-1):Math.max(0,Math.min(set.length-1,at+delta));` +
    `if(next===at)return;` +
    `set[next].focus();ev.preventDefault();}` +
    // key routing: never inside editable targets, no modifiers, no IME
    // composition (finding 4); repeats allowed only for j/k
    `var pending=null;` +
    `document.addEventListener("keydown",function(ev){` +
    `if(ev.isComposing||ev.metaKey||ev.ctrlKey||ev.altKey)return;` +
    `var t=ev.target;var tag=t&&t.tagName?t.tagName.toLowerCase():"";` +
    `if(tag==="input"||tag==="textarea"||tag==="select"||tag==="button"||(t&&t.isContentEditable))return;` +
    `if(ev.key==="Escape"){if(helpOpen()){toggleHelp();ev.preventDefault();return;}close();return;}` +
    `if(helpOpen())return;` +
    `if(ev.repeat&&ev.key!=="j"&&ev.key!=="k")return;` +
    `if(ev.key==="/"){show();ev.preventDefault();return;}` +
    `if(ev.key==="?"){toggleHelp();ev.preventDefault();return;}` +
    `if(ev.key==="j"||ev.key==="k"){rove(ev.key==="j"?1:-1,ev);return;}` +
    `if(pending==="g"){pending=null;` +
    `var map={b:"/board",i:"/",w:"/workbench",d:"/done",q:"/board?view=order",f:"/fleet",t:"/tasks",a:"/activity",p:"/projects"};` +
    `if(map[ev.key]){go(map[ev.key]);ev.preventDefault();}return;}` +
    `if(ev.key==="g"){pending="g";setTimeout(function(){pending=null;},800);}});` +
    `})();`
  );
}

/**
 * A page described, not yet rendered (arc 4): every chromed HTML route
 * returns one of these and ONE helper (sendScreen, inside the server)
 * owns the nonce, the palette index, the shortcuts overlay, script
 * composition, and the CSP. Renderers stopped calling shell() themselves
 * so those five things cannot drift apart per route.
 */
export type Screen = {
  title: string;
  body: Html;
  chrome?: Chrome;
  /** The page's own executable behavior (a region poller, the push
   * enrollment script). fetches: true when it calls fetch — connect-src
   * is granted only then. */
  functional?: { script: string; fetches?: boolean };
  refreshSeconds?: number;
  /** Render sensitive even when no password field is visible — one-time
   * secrets and judgment calls the classifier cannot see. */
  forceSensitive?: boolean;
  /** Structured conversation; complex guarded forms stay native islands. */
  workspace?: Partial<Pick<BrowserWorkspace, 'conversation' | 'team' | 'focus' | 'result' | 'notices' | 'view' | 'firstRun' | 'phone' | 'home'>> & {
    /** Markup the workspace shows in place; it becomes bytes where the page's JSON is written (sendScreen). */
    catchUpHtml?: Html; controlsHtml?: Html; pageHtml?: Html | null;
  };
};

export const ROLE_TITLES: Record<"plan" | "build" | "review" | "repair", string> = { plan: "Planner", build: "Builder", review: "Reviewer", repair: "Repair" };

export function screen(
  title: string,
  body: Html,
  options: Omit<Screen, "title" | "body"> = {},
): Screen {
  return { title, body, ...options };
}

/**
 * The sensitivity classifier (arc 4, findings 3/17): a body showing a
 * password input renders WITHOUT the chrome additions (palette, overlay,
 * global keys) — the page's own functional script still ships. Tolerant
 * of quoting, casing, and whitespace; `data-type="password"` and prose
 * mentioning passwords do not match. This is defense-in-depth over a
 * file whose only HTML producer is its own double-quoted template
 * convention — forceSensitive is the escape hatch for what a regex
 * cannot judge.
 */
export const SENSITIVE_INPUT = /<input\b[^>]*[\s"']type\s*=\s*["']?password/i;

/** The design contract every page carries (impeccable direction, 2026-09-27). */
export const DESIGN_CONTRACT = html`<!-- THESIS: a control plane that stays quiet until a person is needed; it refuses the dashboard default of coloured status everywhere and an accent on every button.
OWN-WORLD: a neutral grey frame with paper sheets inset into it (Arc, Linear), Geist for words and Geist Mono for machine facts, ink for every act a person can take, one chart magenta only for what waits on a person plus focus and selection; hairlines and one soft sheet shadow, no glass, no gradients.
STORY: glance, see the accent count, open the one thing that needs you, act with the one accent verb, leave.
FIRST VIEWPORT: sidebar on the frame (accent mark, ink New task, the current page as a raised pill, the accent needs-you count); the main sheet with a 52px header over compact 13px rows; the Crew sheet beside it.
FORM: the Raycast and Arc canon, user-pinned; seed 9c849086.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md -->`;

/** The shortcuts overlay: display-only, toggled by the chrome layer,
 * absent from sensitive pages. Navigation help in plain words — no key
 * ever posts. */
export const KBD_HELP = html`<div class="kbd-help" hidden role="dialog" aria-label="keyboard shortcuts" tabindex="-1">\
<h2>Keyboard shortcuts</h2><table>\
<tr><td><kbd>/</kbd></td><td>jump to a page or an open task</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>i</kbd></td><td>go to the inbox</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>b</kbd></td><td>go to the board</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>q</kbd></td><td>go to the queue</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>f</kbd></td><td>go to the fleet</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>w</kbd></td><td>go to the workbench</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>t</kbd></td><td>go to the task list</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>a</kbd></td><td>go to the activity view</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>p</kbd></td><td>go to the projects</td></tr>\
<tr><td><kbd>g</kbd> then <kbd>d</kbd></td><td>go to what is done</td></tr>\
<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>move through the rows on this page</td></tr>\
<tr><td><kbd>Escape</kbd></td><td>close this</td></tr>\
</table></div>`;

export function shell(
  title: string,
  body: Html,
  options: {
    nav?: boolean;
    chrome?: Chrome;
    /** A password ceremony is on this page: the chrome gains no forms, so
     * the switcher renders inert — the name, and the one /projects link. */
    sensitive?: boolean;
    /** Whether the presentation-only desktop rail control has a nonce'd
     * handler. Sensitive pages may opt in; one-time-secret pages do not. */
    sidebarToggle?: boolean;
    refreshSeconds?: number;
    /** The page's one nonce'd script: region pollers + the chrome layer,
     * composed by sendScreen. Read-only regions only; one nonce per
     * response. fallbackRefresh marks a page whose script POLLS — only
     * those earn the noscript meta-refresh (a chrome-layer-only page with
     * forms must never re-render what someone was typing). */
    live?: { nonce: string; script: string; fallbackRefresh?: boolean };
  } = {},
): Html {
  const main = body;
  const head = joinHtml([
    html`<!doctype html>`,
    html`<html lang="en"${themeAttribute()}><head><meta charset="utf-8">`,
    // viewport-fit=cover is what makes env(safe-area-inset-*) non-zero on a
    // notched phone; without it the tab bar sits under the home indicator.
    html`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
    ...(requestContext.getStore()?.theme
      ? [html`<meta name="theme-color" content="${requestContext.getStore()?.theme === "dark" ? "#0b0b0b" : "#efefef"}">`]
      : [html`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0b0b">`, html`<meta name="theme-color" media="(prefers-color-scheme: light)" content="#efefef">`]),
    html`<meta name="mobile-web-app-capable" content="yes">`,
    html`<meta name="apple-mobile-web-app-capable" content="yes">`,
    html`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
    html`<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
    // Live status with zero JavaScript: the page asks the browser to fetch
    // it again. Only ever on read-only briefing pages — a refresh on a page
    // with a form would eat what somebody was typing.
    // A refresh is a reload, and reloads never cross-fade. No page opts
    // out of the fade either: opening one from a page that fades makes
    // the browser report the aborted fade as an error.
    ...(options.refreshSeconds === undefined
      ? []
      : [html`<meta http-equiv="refresh" content="${Math.max(5, Math.floor(options.refreshSeconds))}">`]),
    // With the in-place swapper, the whole-page refresh survives only as
    // the no-JavaScript fallback — and CSS view transitions run without
    // JavaScript, so the fallback carries its own opt-out.
    ...(options.live?.fallbackRefresh !== true
      ? []
      : [html`<noscript><meta http-equiv="refresh" content="30"><style>@view-transition { navigation: none; }</style></noscript>`]),
    html`<title>${title}</title><link rel="stylesheet" href="${WORKSPACE_STYLE.path}">${accentHead()}</head><body>${DESIGN_CONTRACT}`,
  ], "\n");
  const tail =
    options.live === undefined
      ? html`</body></html>`
      : html`${scriptElement(options.live.script, { nonce: options.live.nonce })}</body></html>`;

  if (options.chrome === undefined) {
    // Chromeless: the login page and refusal pages.
    return joinHtml([head, html`<main>`, main, html`</main>`, tail], "\n");
  }

  const chrome = options.chrome;
  const item = (key: Chrome["active"], href: string, label: string, count?: number): Html =>
    html`<a href="${href}" aria-label="${label}" title="${label}"${chrome.active === key ? html` class="active"` : ""}${key === "inbox" && count !== undefined ? html` data-waiting="${count}"` : ""}>\
${label}\
${count !== undefined && count > 0 ? html` <span class="count badge badge-open">${count}${key === "inbox" && chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;

  // The scope bar (portfolio arc §1): ONE row naming which rows this screen
  // can show — derived from the route's declared scope, falling back to the
  // session default. It replaced the sidebar workspace card and the mobile
  // pill's link as the single scope truth. Display and GET navigation only;
  // switching projects stays the POST + CSRF /projects flow.
  const effectiveScope: "all" | "project" | "board-all" =
    chrome.scope ?? (chrome.project === null ? "all" : "project");
  const peekCounts = chrome.active === "code" || chrome.projectPeek === null || chrome.projectPeek === undefined || effectiveScope !== "project" ? null : chrome.projectPeek;
  const scopeCounts = peekCounts === null
    ? null
    : html`${peekCounts.waiting > 0 ? html`<span class="hot">${peekCounts.waiting} needs you</span>` : html`<span>0 needs you</span>`}\
<span>${peekCounts.running} live</span><span>${peekCounts.queued} queued</span>`;
  // On a desk each count is the road to what it counts; inside the phone
  // pill's summary they stay text, since the pill itself is the switcher.
  const scopeStatus = peekCounts === null
    ? null
    : html`<span class="scope-status">\
${peekCounts.waiting > 0 ? html`<a class="hot" href="/work?view=needs-you">${peekCounts.waiting} needs you</a>` : html`<a href="/work?view=needs-you">0 needs you</a>`}\
<a href="/runs">${peekCounts.running} live</a><a href="/board?view=order">${peekCounts.queued} queued</a></span>`;
  const scopeName = effectiveScope === "project" && chrome.project !== null ? projectName(chrome.project) : "All projects";
  // The switcher (board pass): the scope's name opens a menu of every
  // enrolled project — one tap to open one, or to widen to all — as plain
  // POST forms carrying the session's csrf, returning to this screen.
  // Inert wherever the chrome may carry no forms: a sensitive page, or a
  // request without a cookie session.
  const canSwitch =
    options.sensitive !== true && chrome.csrf !== undefined && chrome.csrf !== "" && chrome.projects !== undefined;
  const switcherMenu = (foot: Html | null): Html | null => {
    if (!canSwitch) return null;
    const allCurrent = effectiveScope !== "project";
    const current = html` class="current" aria-current="true"`;
    const rows = [
      postForm("/projects/select", html`<button type="submit"${allCurrent ? current : ""}>All projects</button>`, { returnTo: chrome.returnTo ?? "/", hidden: { path: "" } }),
      ...(chrome.projects ?? []).map(one =>
        postForm("/projects/open", html`<button type="submit"${!allCurrent && chrome.project === one.path ? current : ""}>${one.name}</button>`, { returnTo: chrome.returnTo ?? "/", hidden: { path: one.path } })),
    ];
    return html`<div class="switcher-menu" role="menu">${rows}${foot}</div>`;
  };
  // No "scope" label word: in this product "scope" names a task's approved
  // terms — the bar just states which projects the screen is showing.
  const scopeBar = html`<div class="scope-bar">\
${canSwitch
      ? html`<details class="switcher"><summary class="name">${scopeName}${CHEVRON_ICON}</summary>${switcherMenu(null)}</details>`
      : html`<span class="name">${scopeName}</span>`}\
${scopeStatus}</div>`;
  // The rail's own accordion (sidebar rework): open the group holding the
  // active page, closed otherwise — the client toggle keeps it exclusive.
  const navGroup = (key: "tools" | "settings", label: string, rows: NavRow[], open: boolean): Html =>
    html`<details class="nav-group" data-group="${key}"${open ? html` open` : ""}>\
<summary>${label}${CHEVRON_ICON}</summary>\
<nav class="nav-group-items">${rows.map(row => item(row.key, row.href, row.label))}</nav>\
</details>`;
  // The three primary destinations (workspace package 1): Chat, Work,
  // Projects — every old page keeps its own active key and lights the
  // destination it now lives under. The count rides Work: it is the
  // saturated needs-you count, exactly as the inbox row wore it.
  const primary = chrome.active === "code" ? "work" : primaryDestinationOf(chrome.active);
  const primaryItem = (key: "code" | "chat" | "work" | "projects" | "flows", href: string, label: string, count?: number): Html =>
    html`<a href="${href}" aria-label="${key === "work" && count !== undefined && count > 0 && chrome.inboxLabel !== undefined ? `${label}, ${chrome.inboxLabel}` : label}" title="${label}"${primary === key ? html` class="active" aria-current="page"` : ""}${key === "work" && count !== undefined ? html` data-waiting="${count}"` : ""}>\
<span class="glyph">${NAV_ICONS[key] ?? ""}</span>${label}\
${count !== undefined && count > 0 ? html` <span${chrome.inboxLabel === undefined ? "" : html` aria-label="${chrome.inboxLabel}" title="${chrome.inboxLabel}"`} class="count badge badge-open">${count}${chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;
  const side = joinHtml([
    html`<aside class="side">`,
    html`<div class="side-head"><a class="brand" href="${chrome.chat === true ? "/chat" : "/work"}"><span class="brand-long">Toolroll</span><span class="brand-short">T</span></a>`,
    ...(options.sidebarToggle === true
      ? [html`<button type="button" class="side-toggle" aria-label="collapse sidebar" aria-expanded="true" title="collapse sidebar">${strokeIcon(html`<path d="m15 18-6-6 6-6"/>`)}</button>`]
      : []),
    html`</div>`,
    html`<nav>`,
    // Chat is present only where the ceiling ever allows it (unchanged
    // gating); Work and Projects always. Every specialist tool is a dim
    // text row inside one of the two accordion groups below.
    ...(chrome.chat ? [primaryItem("chat", "/chat", "Chat")] : []),
    primaryItem("work", "/work", "Tasks", chrome.inboxCount),
    primaryItem("flows", "/flows", "Flows"),
    primaryItem("projects", "/projects", "Projects"),
    html`</nav>`,
    ...(chrome.active === "code" ? [] : [html`<a class="new-task" href="/tasks/new" aria-label="New task">+ New task</a>`]),
    html`<nav class="nav-groups">`,
    navGroup("tools", "Work tools", workToolRows(chrome.projectScoped, chrome.chat, chrome.code), TOOL_KEYS.has(chrome.active)),
    navGroup("settings", "Settings", settingsRows(chrome.projectScoped, chrome.settings), SETTINGS_KEYS.has(chrome.active)),
    html`</nav>`,
    html`<span class="grow"></span>`,
    html`</aside>`,
  ], "\n");

  // The sandbox banner: every page, no dismissal — a screenshot of a demo
  // must not pass as production (adoption review, finding 8; the FENCE is
  // the refuseDemo gate in operate.ts, this is the honest label).
  const update = chrome.update;
  const demoBanner = html`\
${chrome.demo === true ? html`<div class="banner"><span class="badge">Demo</span>${DEMO_BANNER.replace(/^Demo: /, "")}</div>` : ""}\
${chrome.modeBanner === undefined ? "" : html`<div class="banner"><span class="badge badge-running">Mode</span>${chrome.modeBanner.words} \u00b7 <a href="/mode">the terms \u00b7 end it</a></div>`}\
${(chrome.signIn ?? []).map(one => html`<div class="banner sign-in-banner" data-sign-in="${one.provider}"><strong>${one.title}</strong> \u00b7 run <code>${one.command}</code> on this computer, then resume.${one.detail === "" ? "" : ` ${one.detail}`}\
${postForm(one.resumeHref, html`<button type="submit">${one.resumeLabel}</button>`, { attrs: { class: "inline" } })}</div>`)}\
${chrome.updateWaiting === undefined ? "" : html`<div class="banner update-waiting" role="status">${chrome.updateWaiting.words} \u00b7 <a href="/settings/updates">Update status</a></div>`}\
${update === undefined ? "" : html`<div class="banner update-banner" data-update="${update.version}">${updateNoticeWords(update)} \u00b7 <a href="${update.href}">What's new</a>\
${postForm(update.dismissHref, html`<button type="submit">Dismiss</button>`, { attrs: { class: "inline" }, hidden: { version: update.version } })}</div>`}`;
  // The scope bar sits between the banners and the main/split body, so it
  // can never disappear with a responsive pane (portfolio arc §1).
  const content =
    chrome.listPane === undefined
      ? html`<div class="content">${demoBanner}${scopeBar}<main>${main}</main></div>`
      : html`<div class="content">${demoBanner}${scopeBar}<div class="split">\
<div class="list-pane">${chrome.listPane}</div>\
<div class="detail"><main>${main}</main></div>\
</div></div>`;

  // The phone chrome (arc 4): a top bar with the project one tap from
  // switching and quick capture, and a bottom tab bar with the always-
  // visible destinations (chat where allowed, inbox, board, builds,
  // projects) a thumb visits — everything else behind /menu. CSS shows
  // these only below 760px; desktop keeps the sidebar untouched.
  const mobileTop = joinHtml([
    html`<header class="mobile-top">`,
    html`<a class="brand-mini" href="${chrome.chat === true ? "/chat" : "/work"}">T</a>`,
    // On a phone the pill IS the scope row (mobile pass): the project's
    // name, its three counts, and the one /projects link at that
    // breakpoint — the scope bar hides below 760px so the header is one
    // row, not three. Desktop keeps the scope bar's link and hides this.
    canSwitch
      ? html`<details class="project-pill switcher"><summary><span class="name">${scopeName}${CHEVRON_ICON}</span>${
          scopeCounts === null ? "" : html`<span class="pill-status">${scopeCounts}</span>`
          }</summary>${switcherMenu(html`<a class="manage" href="/projects">manage projects</a>`)}</details>`
      : html`<a class="project-pill" href="/projects"><span class="name">${scopeName}</span>${
          scopeCounts === null ? "" : html`<span class="pill-status">${scopeCounts}</span>`
        }</a>`,
    ...(chrome.active === "code" ? [] : [html`<a class="mobile-new" href="/tasks/new">+ task</a>`]),
    // Settings and the specialist tools are a header action on a phone,
    // never a fourth primary tab (workspace package 1).
    html`<a class="mobile-more" href="/menu" aria-label="tools and settings" title="tools and settings">${strokeIcon(html`<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`)}</a>`,
    html`</header>`,
  ]);
  // Drawn icons, one stroke weight, inline and CSP-safe — never unicode
  // glyphs standing in for an icon system.
  const TAB_ICONS = {
    code: strokeIcon(html`<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>`),
    chat: strokeIcon(CHAT_PATHS),
    work: strokeIcon(WORK_PATHS),
    projects: strokeIcon(FOLDER_PATHS),
    flows: strokeIcon(html`<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>`),
  } as const;
  const tab = (key: keyof typeof TAB_ICONS, href: string, label: string, count?: number): Html =>
    // A phone tab says THAT something waits, with a dot; the number is on
    // the Work views themselves (Linear Mobile's rule — one tap away).
    html`<a href="${href}"${primary === key ? html` class="active" aria-current="page"` : ""}><span class="glyph">${TAB_ICONS[key]}</span>${label}\
${count !== undefined && count > 0 ? html`<span class="dot-badge" role="img" aria-label="${chrome.inboxLabel ?? `${count} waiting`}"></span>` : ""}</a>`;
  // Three primary tabs, the same three as the rail: chat where allowed,
  // work, projects. Tools and settings sit behind the header's menu action.
  const tabbar = joinHtml([
    html`<nav class="tabbar">`,
    ...(chrome.chat ? [tab("chat", "/chat", "Chat")] : []),
    tab("work", "/work", "Tasks", chrome.inboxCount),
    tab("flows", "/flows", "Flows"),
    tab("projects", "/projects", "Projects"),
    html`</nav>`,
  ]);

  return joinHtml([head, html`<div class="app">`, side, mobileTop, content, tabbar, html`</div>`, tail], "\n");
}


/** ONE way a person is named on any surface (U3): the same chip everywhere. */
export function personChip(name: string): Html {
  return html`<span class="mono">${name}</span>`;
}

/** The brand, as the workspace sidebar shows it. */
export const BRAND_HTML = html`<span class="so-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>Toolroll`;

/** A page on its own, in the workspace's look but with no script: the brand, then the page. */
export function focusDocument(title: string, body: Html): Html {
  return shell(title, html`<div class="focus-page"><a class="so-wordmark focus-brand" href="/chat">${BRAND_HTML}</a>${body}</div>`);
}


export function chatMoney(microusd: number | null): string {
  return microusd === null ? "unknown" : `$${(microusd / 1_000_000).toFixed(2)}`;
}

export function relativeAge(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The project chip every all-scope row wears: null is UNPLACED, said so. */
export function projectChip(repo: string | null | undefined): Html {
  return repo === null || repo === undefined
    ? html` <span class="badge">Unplaced</span>`
    : html` <span class="badge">${projectName(repo)}</span>`;
}

/**
 * Creating work is the product's first verb, so it gets a whole calm page:
 * a title, the goal that becomes the scope draft, and the project it lands
 * in — then straight to the approve card, which is the aha the flow serves.
 */
/** One queue card. Taken work renders pinned — visible, never draggable. */
/** The person's pinned theme from their own cookie; null follows the device. */
export function pinnedTheme(cookieHeader: string | undefined): "light" | "dark" | null {
  const value = /(?:^|;\s*)so-theme=(light|dark)(?:;|$)/.exec(cookieHeader ?? "")?.[1];
  return value === "light" || value === "dark" ? value : null;
}
export function themeAttribute(): Html {
  return attributes({ "data-theme": requestContext.getStore()?.theme ?? null });
}
/** A chosen accent (Settings → Appearance) re-pigments the signal tokens only, after the shared stylesheet. */
export function accentHead(): Html {
  const accent = requestContext.getStore()?.accent ?? null;
  return accent === null ? html`` : styleElement(accentStyle(accent), { "data-accent": accent });
}

/** Drawn, one stroke weight, like the tab bar's icons — never a glyph. */
export const GRIP_ICON = html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">\
<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/>\
<circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
export const TO_FRONT_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\
<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
/** One stroke weight, from the tab bar's set: the sidebar's primary rows
 * wear an icon each; the foot's list stays text, the way Linear's does. */
export const strokeIcon = (paths: Html | string): Html =>
  html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
/** Where the queue lives now: the board, flipped to dispatch order. */
export const QUEUE_VIEW = "/board?view=order";
export const FOLDER_PATHS = html`<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`;
export const CHAT_PATHS = html`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
export const WORK_PATHS = html`<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m4 6 1 1 2-2"/><path d="m4 12 1 1 2-2"/><path d="m4 18 1 1 2-2"/>`;
export const NAV_ICONS: Partial<Record<Chrome["active"], Html>> = {
  code: strokeIcon(html`<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>`),
  chat: strokeIcon(CHAT_PATHS),
  work: strokeIcon(WORK_PATHS),
  projects: strokeIcon(FOLDER_PATHS),
  flows: strokeIcon(html`<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>`),
};

/** One grouped destination inside an accordion group or the /menu overflow. */
export type NavRow = { key: Chrome["active"]; href: string; label: string; hint: string };

/**
 * The workspace shell (package 1): three primary rows (chat, work,
 * projects) above two accordion groups. Work tools is where work is
 * arranged, planned, and scheduled — the board, its order view, the
 * flat task list, recipes, the portfolio, and the action
 * ledger. Settings is who and what the fleet runs on — fleet,
 * requirements, people, operating mode, system — plus the agent-defaults
 * page where the console offers it. Both draw from the same two lists on
 * a desk (accordion groups) and on a phone (/menu sections), so the two
 * never disagree, and a project-scoped login sees exactly the rows it
 * saw before: moving a link never widens role or project visibility.
 */
export function workToolRows(scoped = false, _offersChat = false, offersCode = false): NavRow[] {
  const rows: NavRow[] = [
    ...(offersCode ? [{ key: "code" as const, href: "/code", label: "Coding sessions", hint: "Direct coding sessions and their saved results" }] : []),
    { key: "inbox", href: "/inbox", label: "Inbox", hint: "questions, approvals, and repairs to act on" },
    { key: "board", href: "/board", label: "Board", hint: "lanes by state, with the order view" },
    { key: "tasks", href: "/tasks", label: "Task list", hint: "everything, filterable by state" },
    { key: "recipes", href: "/recipes", label: "Recipes", hint: "choose, customize, and reuse a workflow" },
    { key: "workbench", href: "/workbench", label: "Portfolio", hint: "every project and live build in one place" },
    { key: "ledger", href: "/ledger", label: "Action ledger", hint: "who acted, what happened, and the result" },
    { key: "spend", href: "/spend", label: "Spend", hint: "what agent work cost, and monthly budgets" },
  ];
  return scoped ? rows.filter(row => row.key !== "workbench" && row.key !== "spend") : rows;
}
export function settingsRows(scoped = false, offersSettings = false): NavRow[] {
  const rows: NavRow[] = [
    ...(offersSettings ? [{ key: "settings" as const, href: "/settings", label: "Settings", hint: "agent defaults, alerts, credentials" }] : []),
    { key: "fleet", href: "/fleet", label: "Fleet", hint: "who is working, and on what" },
    { key: "caps", href: "/caps", label: "Requirements", hint: "tools and credentials builds need" },
    { key: "people", href: "/people", label: "People", hint: "who can sign in, and what they have done" },
    { key: "mode", href: "/mode", label: "Operating mode", hint: "the signed posture this repository runs under" },
    { key: "system", href: "/system", label: "System", hint: "workers, providers, and grants" },
  ];
  return scoped ? rows.filter(row => row.key === "people" || row.key === "settings") : rows;
}
/** Which accordion group opens by default for a given active page. */
export const TOOL_KEYS = new Set<Chrome["active"]>(["code", "inbox", "board", "queue", "tasks", "workbench", "recipes", "ledger", "spend"]);
export const SETTINGS_KEYS = new Set<Chrome["active"]>(["settings", "fleet", "caps", "people", "mode", "system"]);

/** The builds screen's views (reduction pass §1): done, the review queue,
 * and activity are ways of looking at builds, not destinations. */
export function buildsViews(current: "builds" | "done" | "review" | "activity"): Html {
  const views: [typeof current, string, string][] = [
    ["builds", "/runs", "builds"],
    ["done", "/done", "done"],
    ["review", "/review", "review"],
    ["activity", "/activity", "activity"],
  ];
  return html`<p class="meta board-view">${joinHtml(views.map(([key, href, label]) => (key === current ? html`<strong>${label}</strong>` : html`<a href="${href}">${label}</a>`)), " \u00b7 ")}</p>`;
}

export const CHEVRON_ICON = html`<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\
<path d="m6 9 6 6 6-6"/></svg>`;
/** The drag grip: a 2rem touch-sized handle that owns its touches
 * (touch-action: none), so a finger on it drags instead of scrolling. */
export const GRIP_HANDLE = html`<span class="queue-handle" aria-hidden="true">${GRIP_ICON}</span>`;

/** Badges, labels and buttons read in sentence case, whatever word a record stores. */
export const sentenceCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Only an https github.com pull URL earns an anchor (audit IV-11) — a
 * corrupted row renders as text, never as navigation. */
export function safePrUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
    if (!/^\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(parsed.pathname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** A shortened fingerprint for display — enough to compare by eye; the
 * full value rides in the title attribute and in every form field. */
export function shortDigest(digest: string): Html {
  return digest.length <= 12 ? html`${digest}` : html`<span title="${digest}">${digest.slice(0, 12)}…</span>`;
}

/** One display line, bounded — turn text is data, never layout. */
export function oneLineOf(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}
