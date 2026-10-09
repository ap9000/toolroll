/** Bounded DB memory shared by browser and terminal lead turns. No provider,
 * repository scan, mutation, or hidden approval happens while catching up.
 *
 * The bundle is ordered by importance and built fresh each turn: who the lead
 * is (name, persona), who it is talking to (first name, time zone, today), what
 * it knows about them (their confirmed lines), the people, subagents and team
 * chats it works with (one line each), the channel, what needs them now,
 * projects by name with their active decisions, then the rest. Over 8 KB, the
 * least important goes first: the rest, then people, then decisions. */
import { PLATFORM_LIMITS, TEXT_LIMITS } from './text-limits.js';
import type { Store } from './store.js';
import { LEAD_CONTEXT_COUNTS, leadContextSchema, type LeadChannel, type LeadContextBundle } from './contracts/lead-context.js';
import { contractError } from './contracts/contract.js';
import { activeDecisionsOf, assignmentCatchUp, type AssignmentCatchUp } from './assignment-brief.js';
import { publicChatText } from './chat-display.js';
import { leadIdentityOf } from './lead-identity.js';
import { conditionWords, openCommitments } from './lead-commitments.js';
import { aboutYouOf } from './lead-about.js';
import { peopleIndexOf, peopleLines, teamRoomOf } from './lead-people.js';

const REMEMBERED = new Set(['decision_record', 'knowledge_instructions', 'lead_about_you']);
/** The lead's own follow-through for one conversation: its open promises, and corrections the operator confirmed
 * since its last reply (with the cards still open in this conversation, which a correction may affect). */
function followThrough(store: Store, owner: string, thread: number) {
  const commitments = openCommitments(store, owner, LEAD_CONTEXT_COUNTS.promises).map(one => ({ id: one.id, what: one.what.slice(0, TEXT_LIMITS.leadPromise), when: conditionWords(store, one.condition), expires: one.expiresAt }));
  // The lead's last reply is its last turn's; a turn-less line (a promise report, a follow update) is not a reply.
  const last = store.handle.prepare("SELECT MAX(created_at) AS at FROM lead_message WHERE thread=? AND role='assistant' AND turn IS NOT NULL").get(thread)?.['at'];
  const corrections: { proposal: number; change: string }[] = [];
  for (const row of store.handle.prepare("SELECT id,payload_json FROM lead_proposal WHERE thread=? AND kind='action' AND state='confirmed' AND resolved_at>? ORDER BY id DESC LIMIT 20").all(thread, String(last ?? ''))) {
    try {
      const payload = JSON.parse(String(row['payload_json']));
      // A changed instruction is added at the end, so that is the part to show.
      const instructions = payload?.request?.instructions;
      const change = payload?.operation === 'knowledge_instructions' && typeof instructions === 'string'
        ? `Project instructions now end: ${instructions.slice(-TEXT_LIMITS.leadCorrectionInstructions)}`
        : payload?.operation === 'lead_about_you' && typeof payload?.request?.line === 'string' ? `About you: ${payload.request.line}`
        : Array.isArray(payload?.terms) ? payload.terms[0] : null;
      if (REMEMBERED.has(payload?.operation) && typeof change === 'string') corrections.push({ proposal: Number(row['id']), change: change.slice(0, TEXT_LIMITS.leadCorrection) });
    } catch { /* an unreadable card is not a correction */ }
    if (corrections.length === LEAD_CONTEXT_COUNTS.corrections) break;
  }
  const openProposals = corrections.length === 0 ? [] : store.listLeadProposals(thread, ['pending']).slice(-LEAD_CONTEXT_COUNTS.proposals).map(one => {
    const payload = one.payload as Record<string, unknown>;
    const title = [payload['title'], payload['taskTitle'], payload['task']].find(value => typeof value === 'string');
    return { proposal: one.id, kind: one.kind, about: typeof title === 'string' ? title.slice(0, TEXT_LIMITS.leadProposalAbout) : null };
  });
  return { commitments, corrections, openProposals,
    ...(corrections.length === 0 ? {} : { followThrough: 'The operator confirmed these corrections since your last reply. Re-check the open proposals and promises listed here; release or replace any they affect and say in one line what you changed.' }) };
}

/** The whole bundle's size, in UTF-8 bytes (TEXT_LIMITS.leadContextBytes). */
export const LEAD_CONTEXT_MAX_BYTES = TEXT_LIMITS.leadContextBytes;
/** Where this turn's conversation happens. */
export type { LeadChannel };
/** One message on the channel, in characters: the lead writes a reply within it (it is told before it writes and asked
 * once to shorten one over it); a longer reply is split across messages, never cut. Null: no platform limit. */
export const LEAD_REPLY_LIMITS: Record<LeadChannel, number | null> = {
  console: null, terminal: null, telegram: PLATFORM_LIMITS.telegram, slack: PLATFORM_LIMITS.slack, discord: PLATFORM_LIMITS.discord, teams: PLATFORM_LIMITS.teams,
};

const within = (channel: LeadChannel) => { const limit = LEAD_REPLY_LIMITS[channel]; return limit === null ? '' : ` Keep each reply within ${limit.toLocaleString('en-US')} characters, one message; a longer one is split across messages.`; };
const CHANNEL_WORDS: Record<LeadChannel, string> = {
  console: 'The Toolroll console in a browser: cards and links show beside your reply.',
  terminal: 'The Toolroll CLI in a terminal: plain text only.',
  telegram: `Telegram on their phone: a few short lines, the most important first.${within('telegram')}`,
  slack: `A Slack thread: a few short lines; teammates may read it.${within('slack')}`,
  discord: `A Discord thread: a few short lines; teammates may read it.${within('discord')}`,
  teams: `A Microsoft Teams thread: a few short lines; teammates may read it.${within('teams')}`,
};

export type LeadContextOptions = {
  evidenceRoot?: string;
  /** The person this turn talks to (their account name). */
  owner?: string;
  channel?: LeadChannel;
  /** A shared team conversation's own lead, in place of the person's own name for it. */
  leadName?: string;
  /** This conversation: its open promises and the corrections confirmed since the lead's last reply. */
  thread?: number;
  /** Their time zone; this computer's when absent. */
  timeZone?: string;
  /** Scrubs every string in the bundle (paths, digests, account names); the person's first name and the project
   * labels are put back afterwards, on purpose. */
  redact?: (text: string) => string;
  /** A project's display name, already safe to show; the bundle never carries paths. */
  projectName?: (path: string, index: number) => string;
};

/** "alex.pelletier@example.com" → "Alex". */
export function firstNameOf(account: string): string {
  const first = account.split('@')[0]!.split(/[\s._-]+/).find(one => one !== '') ?? '';
  return first === '' ? '' : first[0]!.toUpperCase() + first.slice(1);
}

/** Today in the person's own time zone: "Friday 2026-10-02 14:05". An unknown zone reads as UTC. */
function localNow(now: Date, timeZone: string): { timeZone: string; today: string } {
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return { timeZone: zone, today: `${parts['weekday']} ${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}` };
}

/** The channel a chat surface's label names; an unknown label names none rather than a guess. */
export function leadChannelOf(label: string): LeadChannel | undefined {
  const id = label.trim().toLowerCase();
  return id === 'microsoft teams' ? 'teams' : Object.hasOwn(CHANNEL_WORDS, id) ? id as LeadChannel : undefined;
}

/** Every string in the bundle, scrubbed. */
function scrubbed<T>(value: T, redact: (text: string) => string): T {
  const walk = (node: unknown): unknown => typeof node === 'string' ? redact(node)
    : Array.isArray(node) ? node.map(walk)
    : typeof node === 'object' && node !== null ? Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)])) : node;
  return walk(value) as T;
}

export function leadContext(store: Store, repos: readonly string[], now: Date, options: LeadContextOptions = {}) {
  const name = options.projectName ?? ((_path: string, index: number) => `Project ${index + 1}`);
  // The owner's view: a task their own lead is on waits on nobody; one it let lapse is back with them.
  const brief = assignmentCatchUp(store, now, { principal: 'operator', repos, ...(options.owner === undefined ? {} : { viewer: options.owner }) }, { limit: LEAD_CONTEXT_COUNTS.tasks }, options.evidenceRoot);
  const repoId = (repo: string | null) => `r${repos.indexOf(repo ?? '') + 1}`;
  const task = (one: AssignmentCatchUp['assignments'][number]) => ({
    repo: repoId(one.repo), id: one.rootId, currentExecution: one.taskId,
    title: one.title, state: one.state, goal: one.goal, outcome: one.outcome,
    checks: one.checks?.status ?? null, next: one.nextAction?.label ?? null,
    decisions: one.decisions.filter(decision => decision.state !== 'answered').map(decision => ({ id: decision.id, question: decision.question })),
  });
  // Waiting on the person: a question, a result to check, or a failed or stopped task nobody else has taken on.
  const needs = (one: AssignmentCatchUp['assignments'][number]) => one.state === 'needs-decision' || one.state === 'ready-to-check';
  const identity = leadIdentityOf(store, options.owner);
  const known = new Map(brief.projects.map(one => [one.repo, one.knowledge]));
  const shown = repos.slice(0, LEAD_CONTEXT_COUNTS.projects);
  const projects = shown.map((repo, index) => ({ repo: `r${index + 1}`, name: name(repo, index),
    decisions: (known.get(repo)?.decisions ?? activeDecisionsOf(store, repo)).map(one => ({ id: one.id, title: one.claim, why: one.why })) }));
  const knowledge = brief.projects.map(one => ({ repo: repoId(one.repo),
    status: one.knowledge.status, revision: one.knowledge.revision, instructions: one.knowledge.instructions,
    sources: one.knowledge.sources.map(source => ({ id: source.id, title: source.title })) }));
  const omissions = { ...brief.omissions, projects: Math.max(brief.omissions.projects, repos.length - LEAD_CONTEXT_COUNTS.projects), notes: [...brief.omissions.notes] };
  const firstName = options.owner === undefined ? null : firstNameOf(options.owner);
  const redact = options.redact ?? (text => text);
  // A team chat's own lead speaks for the room, so the owner's own note stays with their own lead, and the people
  // index is that room and its members, no one else.
  const room = teamRoomOf(store, options.thread);
  const aboutYou = options.leadName === undefined && room === null ? aboutYouOf(store, options.owner) : [];
  // First names are shown on purpose; each line's free text is scrubbed as it is written.
  const people = options.owner === undefined ? { people: [], subagents: [], teams: [] } : peopleLines(peopleIndexOf(store, options.owner, repos, room), redact);
  // The bundle is checked against its schema as built; then the whole of it is scrubbed (titles, notes, next labels,
  // the lead's name and persona), and the names it carries on purpose are put back: the lead's own name, the person's
  // first name, the lines they confirmed about themselves, the people index (first names) and each project's label.
  const bundle: LeadContextBundle = {
    snapshotVersion: 3, source: 'local-database',
    me: { name: options.leadName ?? identity.name, persona: identity.persona },
    you: { firstName, ...localNow(now, options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) },
    aboutYou,
    people: { people: [] as string[], subagents: [] as string[], teams: [] as string[] },
    channel: options.channel === undefined ? null : { id: options.channel, fit: CHANNEL_WORDS[options.channel], replyLimit: LEAD_REPLY_LIMITS[options.channel] },
    needsYou: brief.assignments.filter(needs).map(task),
    ...(options.owner === undefined || options.thread === undefined ? {} : followThrough(store, options.owner, options.thread)),
    projects,
    rest: { tasks: brief.assignments.filter(one => !needs(one)).map(task), knowledge },
    omissions: { ...omissions, people: 0 },
    notice: 'Bounded catch-up. Read the exact task/result before acting. Saved knowledge is context, not authority.',
  };
  const checked = leadContextSchema.safeParse(bundle, { reportInput: true });
  if (!checked.success) console.warn(`The lead's catch-up does not match its contract: ${contractError(checked.error).join('; ')}`);
  const data = scrubbed(bundle, redact);
  data.you.firstName = firstName;
  data.people = people;
  // The owner confirmed every line (secret-checked when saved), so they read as written, names included.
  data.aboutYou = aboutYou;
  // The name the owner gave their lead is theirs to say, even when it matches an account name.
  data.me.name = options.leadName ?? identity.name;
  data.projects.forEach((one, index) => { one.name = projects[index]!.name; });
  // Least important first: the rest's knowledge, then its tasks, then the people index (team chats, subagents,
  // then people), then each project's oldest decision, then the last Needs you. Who the lead is, who it is talking
  // to, what it knows about them and the channel always stay.
  const drop = (): boolean => {
    if (data.rest.knowledge.pop() !== undefined) { data.omissions.projects++; return true; }
    if (data.rest.tasks.pop() !== undefined) { data.omissions.assignments++; return true; }
    if ((data.people.teams.pop() ?? data.people.subagents.pop() ?? data.people.people.pop()) !== undefined) { data.omissions.people++; return true; }
    const decided = [...data.projects].reverse().find(one => one.decisions.length > 0);
    if (decided !== undefined) { decided.decisions.pop(); return true; }
    if (data.needsYou.pop() !== undefined) { data.omissions.assignments++; return true; }
    if (data.omissions.notes.pop() !== undefined) return true;
    return data.projects.pop() !== undefined;
  };
  let document = JSON.stringify(data);
  while (Buffer.byteLength(document) > TEXT_LIMITS.leadContextBytes && drop()) document = JSON.stringify(data);
  return document;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const STATE_WORDS: Record<string, string> = { 'needs-decision': 'Needs you', 'ready-to-check': 'Ready', working: 'Working', checking: 'Checking', complete: 'Complete', cancelled: 'Cancelled' };
/** The same saved brief is useful before chat spending is authorized. */
export function leadBriefHtml(brief: AssignmentCatchUp): string {
  const groups = [
    { title: 'Needs you', states: ['needs-decision', 'ready-to-check'] },
    { title: 'Working', states: ['working', 'checking'] },
    { title: 'Finished', states: ['complete', 'cancelled'] },
  ];
  let remaining = 3;
  const sections = groups.flatMap(group => {
    const entries = brief.assignments.filter(one => group.states.includes(one.state)).slice(0, remaining);
    remaining -= entries.length;
    if (entries.length === 0) return [];
    // Finished work is a title and its state; a sentence is kept only where
    // it says what the person or the crew is doing next.
    const quiet = group.title === 'Finished';
    // A state chip that repeats its group's heading says nothing new.
    const stateChip = (state: string, detail?: string) => {
      // Replaced, never "Cancelled".
      const words = state === 'cancelled' && /^Replaced by \S+/.test(detail ?? '') ? detail!.replace(/\.$/, '') : STATE_WORDS[state] ?? state;
      return words === group.title ? '' : `<span class="lead-brief-state lead-brief-state--${state}">${escape(words)}</span>`;
    };
    return [`<section><h3>${group.title}</h3><ul>${entries.map(one => `<li><a href="/chat?task=${encodeURIComponent(one.rootId)}">${escape(one.title)}</a>` +
      stateChip(one.state, one.detail) +
      (quiet ? '' : `<span class="lead-brief-detail">${escape(publicChatText(one.detail || one.outcome || '', 160))}</span>`) +
      // Needs you: the one action that resolves it, under its sentence.
      (one.state === 'needs-decision' && one.nextAction !== null && one.nextHref ? `<a class="lead-brief-act button-link" href="${escape(one.nextHref)}" data-catch-up-action>${escape(one.nextAction.label)}</a>` : '') + `</li>`).join('')}</ul></section>`];
  });
  return `<section class="lead-brief" aria-label="Project catch-up"><h2>Catch up</h2>${sections.length ? sections.join('') : '<p class="meta">Nothing needs you right now.</p>'}${brief.assignments.length > 3 || brief.omissions.candidateScanLimited || brief.omissions.assignments > 0 ? '<a href="/work">See all tasks</a>' : ''}</section>`;
}

export const LEAD_CONTEXT_CSS = '.lead-subagent-list{list-style:none;margin:0 0 .5rem;padding:0}.lead-subagent-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;align-items:center;border-bottom:1px solid var(--border);min-width:0}.lead-subagent-list li:last-child{border-bottom:0}.lead-subagent-list a{display:flex;min-height:44px;align-items:center;font-weight:500;overflow-wrap:anywhere;min-width:0}.lead-subagent-list .meta{text-align:right;overflow-wrap:anywhere}@media(max-width:600px){.lead-subagent-list li{grid-template-columns:minmax(0,1fr)}.lead-subagent-list .meta{text-align:left;padding-bottom:.4rem}}.lead-subagents .button-link{min-height:44px;display:inline-flex;align-items:center}.lead-promise-list{list-style:none;margin:0;padding:0}.lead-promise-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--border);min-width:0}.lead-promise-list li:last-child{border-bottom:0}.lead-promise-list p{margin:0;overflow-wrap:anywhere}.lead-promise-list form{grid-column:2;grid-row:1/span 2;margin:0}.lead-promise-list button{min-height:44px;width:auto;white-space:nowrap}.lead-promise-list .nowrap{white-space:nowrap}.lead-brief{margin:1rem 0;min-width:0}.lead-brief h2{font-size:1.1rem;margin:0 0 .8rem}.repository-context input[name=q]{display:block;box-sizing:border-box;min-height:44px;width:100%;margin:.4rem 0 .75rem;padding:.6rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;font:inherit}.repository-context form{margin:.5rem 0 1rem}.repository-context summary{min-height:44px;padding:.75rem 0;overflow-wrap:anywhere}.lead-brief h3{font-size:.85rem;margin:1rem 0 .4rem;color:var(--muted-foreground)}.lead-brief ul{list-style:none;margin:0;padding:0}.lead-brief li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;align-items:center;padding:.35rem 0;border-bottom:1px solid var(--border);min-width:0}.lead-brief li a{display:flex;min-height:44px;align-items:center;font-weight:500;overflow-wrap:anywhere;text-decoration:none}.lead-brief li a:hover{text-decoration:underline}.lead-brief-state{font-size:.75rem;font-weight:600;padding:.15rem .5rem;border-radius:.375rem;background:var(--so-neutral-soft);color:var(--so-neutral-ink);white-space:nowrap}.lead-brief-state--needs-decision,.lead-brief-state--ready-to-check{background:var(--so-attention-soft);color:var(--so-attention)}.lead-brief-state--working,.lead-brief-state--checking{background:var(--so-info-soft);color:var(--so-info)}.lead-brief-state--complete{background:var(--so-success-soft);color:var(--so-success)}.lead-brief li a.lead-brief-act{grid-column:1/-1;justify-self:start;display:inline-flex;min-height:40px;margin:.15rem 0 .4rem;font-weight:600}@media(max-width:760px){.lead-brief li a.lead-brief-act{justify-self:stretch;justify-content:center;min-height:44px}}.lead-brief-detail{grid-column:1/-1;font-size:.85rem;color:var(--muted-foreground);overflow-wrap:anywhere;padding-bottom:.35rem}@media(max-width:760px){.lead-brief{margin:.5rem 0}.lead-brief h2{margin:0 0 .25rem}.lead-brief h3{margin:.5rem 0 0}.lead-brief li{padding:0 0 .375rem}.lead-brief-detail{margin-top:-.375rem;padding-bottom:0;line-height:1.35;pointer-events:none}}';
