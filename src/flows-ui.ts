/** Flows in the console: the list of a person's flows, and one flow's canvas
 * (the React view's data, plus a plain fallback page the view replaces). */
import type { BrowserFlowCard, BrowserFlowTrigger, BrowserFlowView } from "./browser-workspace.js";
import { draftFor, flowDefinitionOf } from "./flow-engine.js";
import { describeTrigger, triggerHeadline, FLOW_TRIGGER_KINDS, FLOW_TRIGGER_WORDS, githubRepoOf, HOOK_PATH, hookReady, planeStatusLink, readHooksBase, readLinearKey, takesDeliveries, triggerConfigOf } from "./flow-triggers.js";
import { deciderOf, FLOW_COLORS, FLOW_KIND_WORDS, FLOW_STAGE_KINDS } from "./flows.js";
import { flowInsights, troubleWords } from "./flow-insights.js";
import { parseSortDecision, sortChip } from "./flow-sort.js";
import { flowSecretNames, readEmailSettings, sendingReady } from "./flow-actions.js";
import { projectToolsOf, secretsSetFor, toolStanding } from "./project-tools.js";
import type { FlowCardRow, FlowRow, Store } from "./store.js";
import { flowFingerprint } from "./flow-live.js";
import { flowChoiceAt, readFlowSend, type FlowSendContent } from "./flow-send.js";
import { FLOW_FILE_MAX_BYTES, type FlowFile, type FlowImportPlan } from "./flow-share.js";
import { googleConnected } from "./google-mail.js";
import { mailboxReady } from "./mailbox.js";
import { labelOf, nameOf } from "./teammate-admin.js";
import { callWords, receiptWords } from "./teammate-tools.js";
import { undoFor } from "./teammate-week.js";

const e = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const projectName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

export const FLOWS_CSS = `.flows{max-width:880px;min-width:0}.flows .card{padding:16px 18px;margin:12px 0}.flows .flow-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.flows .flow-row h2{font-size:1.05rem;margin:0}.flows .flow-counts{font-size:.85rem;color:var(--so-muted)}.flows form{display:grid;gap:10px;margin:0}.flows label{display:grid;gap:6px}.flows input,.flows select{box-sizing:border-box;width:100%;max-width:100%}.flows button{justify-self:start;min-height:44px}.flows .flow-fallback ol{padding-left:20px}.flows summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.flows .flow-buttons{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 0}.flows .flow-import{margin-top:18px;padding-top:14px;border-top:1px solid var(--so-line)}.flows .flow-import h3{font-size:.95rem;margin:0}.flows .flow-terms{list-style:none;padding:0;margin:8px 0 16px;display:grid;gap:10px}.flows .flow-terms li{white-space:pre-line;overflow-wrap:anywhere}.flows .flow-terms pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;margin:6px 0 0}.flows .flow-import-preview h2{font-size:1rem;margin:20px 0 4px}.flows .flow-untrusted{font-weight:600}.flows button.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}.flows fieldset{border:0;padding:0;margin:0;display:grid;gap:10px;min-width:0}.flows legend{font-weight:600;padding:0;margin-bottom:6px}.flows textarea[hidden]{display:none}.flows button.secondary{background:transparent;color:var(--foreground);border:1px solid var(--border)}@media(max-width:600px){.flows input,.flows select{font-size:16px}}@media(max-width:760px){.flows .card{padding:10px 12px;margin:8px 0;position:relative}.flows .flow-row{row-gap:2px}.flows .flow-row h2 a::after{content:"";position:absolute;inset:0;border-radius:inherit}.flows .flow-counts{line-height:1.35}}`;

/** The flows a person can open, with how many cards wait in each, and the new-flow form. */
export function flowsListHtml(store: Store, flows: readonly FlowRow[], projects: readonly string[], csrf: string, canCreate: boolean, problem: string | null): string {
  const rows = flows.map(flow => {
    const cards = store.flowCards(flow.id, false);
    const definition = flowDefinitionOf(flow);
    const waiting = cards.filter(card => ["approval", "choose"].includes(definition?.stages.find(one => one.id === card.stage)?.kind ?? "")).length;
    const buttons = store.flowTriggers(flow.id).filter(one => one.state === "active").flatMap(one => { const config = triggerConfigOf(one); return config?.kind === "button" ? [{ id: one.id, label: config.label }] : []; });
    const trouble = troubleWords(flowInsights(store, flow, new Date(), 7));
    return `<article class="card"><div class="flow-row"><h2><a href="/flows/${flow.id}">${e(flow.name)}</a></h2><span class="flow-counts">${e(projectName(flow.repo))} · ${cards.length} card${cards.length === 1 ? "" : "s"} in progress${waiting > 0 ? ` · ${waiting} waiting for a decision` : ""}${trouble === null ? "" : ` · ${e(trouble)}`}</span></div>` +
      (buttons.length === 0 ? "" : `<p class="flow-buttons">${buttons.map(one => `<a class="button-link" href="/flows/${flow.id}?start=${one.id}">${e(one.label)}</a>`).join(" ")}</p>`) + `</article>`;
  }).join("");
  const projectField = projects.length === 1 ? `<input type="hidden" name="repo" value="${e(projects[0]!)}">` : `<label>Project<select name="repo">${projects.map(repo => `<option value="${e(repo)}">${e(projectName(repo))}</option>`).join("")}</select></label>`;
  // A flow file (flow-share.ts): chosen here or fetched from a gist, previewed in plain words before anything is made.
  const importForm = `<form method="post" action="/flows/import" class="flow-import" data-flow-import><input type="hidden" name="csrf" value="${e(csrf)}"><h3>Or import a flow file</h3>${projectField}<label>File<input type="file" accept=".json,application/json" data-flow-file></label><textarea name="document" hidden data-flow-document></textarea><label>Or its address<input name="url" type="url" inputmode="url" placeholder="https://gist.github.com/…"></label><p class="problem" role="alert" data-flow-file-note hidden></p><button>Preview import</button></form>`;
  // A new flow starts from the gallery (Flows → New): templates grouped by what they're for.
  const create = canCreate && projects.length > 0 ? `<p class="flow-buttons"><a class="button-link" href="/flows/new">New flow</a></p>${importForm}` : "";
  // No flows yet: one click makes a working example with a sample question in it.
  const example = flows.length === 0 && canCreate && projects.length > 0
    ? `<form method="post" action="/flows/example" class="card flow-example"><input type="hidden" name="csrf" value="${e(csrf)}"><h2>See a flow work</h2><p class="meta">Claude drafts a reply to a sample customer question; you approve it here or in your chat app.</p>${projects.length === 1 ? `<input type="hidden" name="repo" value="${e(projects[0]!)}">` : `<label>Project<select name="repo">${projects.map(repo => `<option value="${e(repo)}">${e(projectName(repo))}</option>`).join("")}</select></label>`}<button>Try an example</button></form>`
    : "";
  const intro = `<p class="meta">A flow is your process drawn as zones. Cards move through them: agents do the work, people approve, and the team hears about it.</p>` +
    (canCreate && projects.length > 0 ? `<p class="flow-chat">Describe how work should move and your lead drafts the flow for you to confirm, or start from a template. <a href="/chat?draft=${encodeURIComponent("Make a flow for ")}">Describe it in chat</a></p>` : "") +
    `<p class="flow-chat">AI teammates can decide and handle cards for you, within rules you write. <a href="/teammates">Teammates</a> · or set one up with its flow in one click: <a href="/kits">Starter kits</a></p>`;
  return `<section class="flows">${problem === null ? "" : `<p class="problem" role="alert">${e(problem)}</p>`}${intro}${create}${rows || example || '<p class="meta">No flows yet.</p>'}</section>`;
}

/** Reads the chosen flow file into the form (the server reads it again, whole, before anything is made). */
export const FLOW_IMPORT_SCRIPT = `(function(){var form=document.querySelector('[data-flow-import]');if(!form)return;var input=form.querySelector('[data-flow-file]'),text=form.querySelector('[data-flow-document]'),note=form.querySelector('[data-flow-file-note]'),address=form.querySelector('[name=url]');function say(words){note.textContent=words;note.hidden=words==='';}var reading=null;input.addEventListener('change',function(){text.value='';say('');var file=input.files&&input.files[0];if(!file){reading=null;return;}if(file.size>${FLOW_FILE_MAX_BYTES}){say('That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.');input.value='';reading=null;return;}reading=file.text().then(function(value){text.value=value;});});form.addEventListener('submit',function(event){if(reading!==null&&text.value===''){event.preventDefault();reading.then(function(){form.requestSubmit();});return;}if(text.value===''&&address.value.trim()===''){event.preventDefault();say('Choose a flow file or give its address.');}});})();`;

/** An import's preview: the plan in plain words, what it asks for, and one Import button after the terms. */
export function flowImportHtml(input: { plan: FlowImportPlan | null; file: FlowFile; document: string; repo: string; csrf: string; values: Record<string, string>; previewed: string; problem: string | null }): string {
  const { plan, file } = input;
  const fields = file.parameters.map(one => `<label><span>${e(one.about)}${one.optional === true ? ' <span class="meta">(optional)</span>' : ""}</span><input name="param.${e(one.id)}" value="${e(input.values[one.id] ?? plan?.values[one.id] ?? one.default ?? "")}" maxlength="200" autocomplete="off"></label>`).join("");
  const list = (items: readonly string[]) => items.length === 0 ? "" : `<ul class="flow-terms">${items.map(term => `<li>${e(term)}</li>`).join("")}</ul>`;
  // The steps, what they mean, the triggers and the scripts; each script's code one tap away, as on the Scripts panel.
  const terms = plan === null ? "" : (plan.parts.about === null ? "" : `<p>${e(plan.parts.about)}</p>`) +
    `<p class="flow-untrusted">Its instructions come from the file, not from you: read what each step is asked before you import.</p>` +
    list(plan.parts.steps) +
    (plan.parts.triggers.length === 0 ? "" : `<h2>Triggers</h2>${list(plan.parts.triggers)}`) +
    (plan.parts.scripts.length + plan.parts.kept.length === 0 ? "" : `<h2>Scripts</h2><ul class="flow-terms">${plan.scripts.add.map((one, index) => `<li>${e(plan.parts.scripts[index])}${one.body === undefined ? "" : `<details><summary>Show the script</summary><pre>${e(one.body)}</pre></details>`}</li>`).join("")}${plan.parts.kept.map(one => `<li>${e(one)}</li>`).join("")}</ul>`) +
    `<h2>Good to know</h2>${list([...plan.parts.notes, ...(plan.parts.needs === null ? [] : [plan.parts.needs])])}`;
  return `<section class="flows flow-import-preview">${input.problem === null ? "" : `<p class="problem" role="alert">${e(input.problem)}</p>`}` +
    `<p class="meta">Into ${e(projectName(input.repo))}. Nothing is made until you import it.</p>${terms}` +
    `<form method="post" action="/flows/import" class="card"><input type="hidden" name="csrf" value="${e(input.csrf)}"><input type="hidden" name="repo" value="${e(input.repo)}"><input type="hidden" name="previewed" value="${e(input.previewed)}"><textarea name="document" hidden>${e(input.document)}</textarea>` +
    (fields === "" ? "" : `<fieldset class="flow-import-fields"><legend>Fill in</legend>${fields}</fieldset>`) +
    `<p class="flow-buttons">${plan === null ? "" : '<button name="confirm" value="yes" class="primary">Import flow</button>'}${fields === "" ? "" : `<button name="confirm" value="" class="${plan === null ? "" : "secondary"}">Update preview</button>`}<a href="/flows">Cancel</a></p></form></section>`;
}

const historyText = (event: { fromStage: string | null; toStage: string; outcome: string; actor: string; note: string | null }, title: (id: string) => string, sorts: ReadonlySet<string> = new Set()): string => {
  const who = event.actor === "flow" ? "" : ` by ${event.actor}`;
  const note = event.note === null ? "" : `: ${event.note}`;
  switch (event.outcome) {
    case "created": return `Added to ${title(event.toStage)}${who}`;
    case "approved": return `Approved${who}${note}`;
    case "sent-back": return `Sent back to ${title(event.toStage)}${who}${note}`;
    case "fail": return `Moved to ${title(event.toStage)} after a problem${note}`;
    // "Ignore" on a choice closes the card (flow-send.ts): said as such, with what was chosen and where.
    case "cancelled": return event.note?.startsWith("Ignored") ? `Ignored${who}${event.note.slice("Ignored".length)}` : `Cancelled${who}`;
    case "ok": return event.fromStage !== null && sorts.has(event.fromStage) ? `Sorted into ${title(event.toStage)}` : `Moved on to ${title(event.toStage)}${note}`;
    default: return `Moved to ${title(event.toStage)}${who}${note}`;
  }
};

/** One flow's canvas for one person. */
export function flowView(store: Store, flow: FlowRow, viewer: { name: string; approver: boolean }, selectedCard: number | null, setup: { dir: string | null; repos: readonly string[]; startTrigger?: number | null; sortReady?: boolean; toolHome?: string } = { dir: null, repos: [] }): BrowserFlowView {
  const definition = flowDefinitionOf(flow);
  const stages = definition?.stages ?? [];
  const title = (id: string) => stages.find(one => one.id === id)?.title ?? id;
  const sortZones = new Set(stages.filter(one => one.kind === "sort").map(one => one.id));
  const decisions = sortZones.size === 0 ? new Map<number, { decisionJson: string }>() : store.flowSortDecisions(flow.id);
  const mates = new Map(store.teammates([flow.repo]).map(one => [one.id, one] as const));
  const cards: BrowserFlowCard[] = store.flowCards(flow.id, true).filter(card => card.state === "active" || Date.now() - Date.parse(card.updatedAt) < 7 * 86_400_000).map((card: FlowCardRow) => {
    const stage = stages.find(one => one.id === card.stage);
    const task = card.task ?? card.primaryTask;
    const discussion = store.flowComments(card.id);
    const watchers = store.flowCardWatchers(card.id);
    const decider = stage?.kind === "approval" ? deciderOf(stage, flow) : null;
    // While its teammate is deciding (v92), the card isn't anyone else's to decide yet.
    const teammateDeciding = stage?.teammate !== undefined && card.waiting !== null && card.waiting.endsWith(" is deciding");
    const canDecide = viewer.approver && card.state === "active" && stage?.kind === "approval" && (decider === null || decider === viewer.name) && !teammateDeciding;
    // History reads moves and ownership together, newest first.
    const owned = discussion.filter(one => one.kind === "owner").map(one => ({ text: one.body === "" ? `${one.author} left it without an owner` : one.body === one.author ? `${one.author} took it on` : `${one.author} made ${one.body} the owner`, at: one.at }));
    const moves = store.flowEvents(card.id).map(event => ({ text: historyText(event, title, sortZones), at: event.at }));
    const decision = parseSortDecision(decisions.get(card.id)?.decisionJson ?? null);
    const shown = stage?.kind === "approval" && definition !== null ? draftFor(definition, stage) : null;
    // v91: when a Wait zone gives up (or moves on), or a zone's time limit comes.
    // An "hours" wait has no deadline of its own: it goes on when the clock reaches its hours.
    const clock = stage?.wait?.for === "hours" ? stage.limit : stage?.wait ?? stage?.limit;
    const until = card.state !== "active" || stage === undefined || clock === undefined ? null : new Date(Date.parse(store.flowCardEnteredAt(card.id) ?? card.updatedAt) + clock.minutes * 60_000);
    const deadline = until === null || until.getTime() <= Date.now() ? null : {
      at: until.toISOString(),
      label: stage!.wait !== undefined && stage!.wait.for !== "hours" ? (stage!.wait.for === "reply" ? "No reply by" : "Moves on at") : stage!.limit!.to !== null ? `Moves to ${title(stage!.limit!.to)} at` : "Reminder at",
    };
    // Its open question: one of its own, or (v94) a tool call waiting for approval.
    const asked = card.state === "active" ? store.openTeammateQuestionOn(card.id, card.entry) : null;
    const pending = asked?.toolCall == null ? null : store.teammateCall(asked.toolCall);
    // A decision its teammate handed over carries what the teammate said (v92).
    const turn = card.state === "active" && stage?.kind === "approval" && stage.teammate !== undefined ? store.flowStepRun(card.id, card.entry) : null;
    let handoff: { from: string; note: string } | null = null;
    if (turn !== null && turn.kind === "teammate" && turn.state === "passed") {
      try {
        const said = JSON.parse(turn.decisionJson ?? "{}") as { action?: unknown; note?: unknown };
        const mate = store.teammateByHandle(flow.repo, stage!.teammate!);
        if (said.action === "hand_off" && typeof said.note === "string" && said.note !== "" && mate !== null) handoff = { from: labelOf(mate), note: said.note };
      } catch { handoff = null; }
    }
    const asker = asked === null || asked.state !== "open" ? null : store.getTeammate(asked.teammate);
    // "Person chooses" (flow-send.ts): what was sent, and the options, for the person it waits on; the latest send otherwise.
    const choosing = card.state === "active" && stage?.kind === "choose" ? flowChoiceAt(store, card.id, card.entry) : null;
    const latest = store.flowSends(card.id)[0] ?? null;
    const sentContent = latest === null ? null : readFlowSend(latest.contentJson);
    // On the card itself: where it came from (the card's title is right above), and only the links the panel doesn't already have.
    const own = new Set([`/flows/${flow.id}?card=${card.id}`, ...(task === null ? [] : [`/t/${encodeURIComponent(task)}`])]);
    const sentView = (content: FlowSendContent) => ({ title: content.from === undefined ? "What was done" : `From ${content.from}`, summary: content.summary,
      links: content.links.map(one => ({ label: one.label, href: "url" in one ? one.url : one.path })).filter(one => !own.has(one.href)) });
    return {
      id: card.id, title: card.title, description: card.description, stage: card.stage, state: card.state, waiting: card.waiting,
      task: task === null ? null : { id: task, href: `/t/${encodeURIComponent(task)}` },
      createdBy: card.createdBy, updatedAt: card.updatedAt,
      canDecide,
      // What a "Send to me" sent shows once, in its own box (sent), not again here; a report zone's items and full report
      // (`<id>.items`, `<id>.report`) are for later zones, and its summary is shown.
      outputs: Object.entries(card.outputs).filter(([id]) => !id.includes(".") && stages.find(one => one.id === id)?.kind !== "send").map(([id, text]) => ({ stage: id, title: title(id), text })),
      history: [...moves, ...owned].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
      source: card.source,
      owner: card.owner, watchers, watching: watchers.includes(viewer.name),
      mine: card.owner === viewer.name || watchers.includes(viewer.name) || canDecide || choosing?.person === viewer.name,
      comments: discussion.filter(one => one.kind === "comment").map(one => ({ id: one.id, author: one.author, body: one.body, mentions: one.mentions, at: one.at })),
      sorted: decision === null ? null : { chip: sortChip(decision), confident: decision.confident },
      draft: shown === null || card.state !== "active" || card.outputs[shown.id] === undefined ? null : { zone: shown.id, title: shown.title, text: card.outputs[shown.id]! },
      deadline,
      handoff,
      choose: choosing === null || sentContent === null || latest?.entry !== card.entry ? null : { entry: card.entry, ...sentView(sentContent), person: choosing.person, mine: choosing.person === viewer.name,
        options: (sentContent.options ?? []).filter(one => choosing.stage.options?.[one.choice]?.label === one.label), reply: sentContent.reply === true },
      sent: sentContent === null || (choosing !== null && latest?.entry === card.entry) ? null : { ...sentView(sentContent), person: latest!.person, at: latest!.createdAt },
      question: asked === null || asked.state !== "open" || asker === null ? null
        : { id: asked.id, from: labelOf(asker), question: asked.question, options: asked.options, askedOf: asked.askedOf, mine: asked.askedOf === viewer.name,
          call: pending === null ? null : { why: pending.why, rule: pending.result ?? "" } },
      calls: store.teammateCallsOn(card.id).slice(-30).map(call => {
        const mate = mates.get(call.teammate) ?? null;
        // A person's undo (v97) reads as theirs, and its outcome says what it undid.
        return { id: call.id, who: call.undoOf !== null ? call.decidedBy ?? "A person" : mate === null ? "A teammate" : nameOf(mate), words: callWords(call.tool, call.action, call.input, 400), state: call.state, outcome: receiptWords(store, call),
          why: call.undoOf !== null ? "" : call.why, result: call.state === "asked" ? null : call.result, at: call.createdAt, teammate: call.teammate, undo: viewer.approver ? undoFor(store, call) : null };
      }),
    };
  });
  const triggers: BrowserFlowTrigger[] = store.flowTriggers(flow.id).map(trigger => {
    const config = triggerConfigOf(trigger);
    return {
      id: trigger.id, kind: trigger.kind, words: config === null ? "This trigger can't be read." : describeTrigger(config, store),
      ...(config === null ? { name: "Trigger", detail: "Can't be read" } : triggerHeadline(config, store)),
      zone: title(config?.zone ?? definition?.start ?? ""), zoneId: config?.zone ?? definition?.start ?? "", state: trigger.state, status: trigger.lastOutcome, statusLink: planeStatusLink(config, trigger.lastOutcome), statusAt: trigger.lastAt, failing: trigger.failures > 0,
      button: config?.kind === "button" ? { label: config.label, questions: config.questions } : null,
      hook: config !== null && takesDeliveries(config) ? { ready: hookReady(trigger, setup.dir), needsSecret: config.kind === "linear" } : null,
      checkable: ((config?.kind === "github" || config?.kind === "linear") && config.delivery === "poll") || config?.kind === "email" || (config?.kind === "schedule" && config.script !== undefined) || config?.kind === "plane-review",
      shared: config?.kind === "button" && trigger.hookHash !== null,
    };
  });
  return {
    kind: "flow",
    flow: { id: flow.id, name: flow.name, project: projectName(flow.repo), revision: flow.revision, href: `/flows/${flow.id}`, owner: flow.owner },
    chatHref: `/chat?draft=${encodeURIComponent(`In the ${flow.name} flow, `)}`,
    triggers,
    triggerSetup: {
      kinds: FLOW_TRIGGER_KINDS.map(kind => ({ kind, label: FLOW_TRIGGER_WORDS[kind] })),
      githubRepo: githubRepoOf(flow.repo), linearKey: readLinearKey(setup.dir) !== null, hooksBase: readHooksBase(setup.dir), hooksPath: HOOK_PATH,
      mailbox: mailboxReady(setup.dir) ? googleConnected(setup.dir)?.address ?? readEmailSettings(setup.dir)?.from ?? null : null,
      otherFlows: store.listFlows(setup.repos).filter(one => one.id !== flow.id).map(one => ({ id: one.id, name: one.name, zones: (flowDefinitionOf(one)?.stages ?? []).map(stage => ({ id: stage.id, title: stage.title })) })),
    },
    startTrigger: setup.startTrigger ?? null,
    me: viewer.name,
    sortReady: setup.sortReady ?? false,
    teammates: store.teammates([flow.repo]).map(mate => ({ handle: mate.handle, label: labelOf(mate), name: nameOf(mate), working: mate.state === "active", href: `/teammates/${mate.id}` })),
    emailReady: sendingReady(setup.dir),
    requestSecrets: flowSecretNames(setup.dir, flow.repo),
    tools: projectToolsOf(store, flow.repo).map(tool => ({ name: tool.name, about: tool.spec.about, functions: tool.lastTest?.ok === true ? tool.lastTest.tools : [],
      ready: toolStanding(tool, secretsSetFor(flow.repo, tool.spec, setup.toolHome)).ready })),
    scripts: store.flowScripts(flow.repo).map(script => ({ name: script.name, about: script.about, body: script.body, timeoutMinutes: script.timeoutMinutes, version: script.version, savedBy: script.savedBy, savedAt: script.savedAt,
      language: script.language, file: script.file, held: script.held !== null,
      usedHere: stages.filter(stage => stage.kind === "check" && stage.script === script.name).map(stage => stage.title) })),
    start: definition?.start ?? stages[0]?.id ?? "",
    stages,
    cards,
    selectedCard,
    live: flowFingerprint(store, flow.id),
    canEdit: viewer.approver,
    approvers: store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, flow.repo)),
    projects: [flow.repo, ...setup.repos.filter(one => one !== flow.repo)].map(path => ({ path, name: projectName(path) })),
    kinds: FLOW_STAGE_KINDS.map(kind => ({ kind, label: FLOW_KIND_WORDS[kind].label, about: FLOW_KIND_WORDS[kind].about })),
    colors: [...FLOW_COLORS],
  };
}

/** The page the canvas replaces when scripts can't run: each zone and its cards, in order. */
export function flowFallbackHtml(view: BrowserFlowView): string {
  return `<section class="flows flow-fallback"><p class="meta">${e(view.flow.project)}</p><ol>${view.stages.map(stage => {
    const cards = view.cards.filter(card => card.stage === stage.id && card.state === "active");
    return `<li><strong>${e(stage.title)}</strong> · ${e(FLOW_KIND_WORDS[stage.kind].label)}${cards.length === 0 ? "" : `<ul>${cards.map(card => `<li>${e(card.title)}${card.waiting === null ? "" : ` — ${e(card.waiting)}`}</li>`).join("")}</ul>`}</li>`;
  }).join("")}</ol></section>`;
}
