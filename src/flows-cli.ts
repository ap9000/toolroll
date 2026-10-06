/** `toolroll flows …`: set up and inspect flows from a terminal, through the
 * same helpers the console and the lead's flow tool use — flowFromSteps,
 * FLOW_TEMPLATES, the starter flows, addFlowTriggerTo, saveScript and
 * addCardToFlow — so a flow made here is checked exactly as one drawn there.
 * Reads need no login; every write is an approver's, proved by --as/--token
 * (or the remembered login), and lands in the ledger as a console request
 * does. create, edit, archive, import and trigger add preview until --yes.
 * export writes a flow file (flow-share.ts); import reads one, from a path
 * or a gist/GitHub address, and previews it in plain words first. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envelopeJson } from './envelope.js';
import { addCardToFlow, advanceFlows, crossProjectProblem, decideFlowCard, flowDefinitionOf } from './flow-engine.js';
import { chooseFlowCard } from './flow-send.js';
import { saveScript } from './flow-scripts.js';
import { exportFlow, fetchFlowFile, FLOW_FILE_MAX_BYTES, FlowFileError, importFlow, parseFlowFile, planFlowImport, type FetchLike } from './flow-share.js';
import { STARTER_FLOWS, starterFlowOf, starterOf, startersFor, starterTerms, switchOnStarter } from './flow-starters.js';
import { addFlowTriggerTo, checkFlowTriggerNow, describeTrigger, removeFlowTrigger, triggerConfigOf, validateTriggerConfig, type TriggerIo } from './flow-triggers.js';
import { deciderOf, FLOW_KIND_WORDS, FLOW_TEMPLATES, flowDigest, flowFromSteps, flowTerms, stepsFor, type FlowDefinition, type FlowStage } from './flows.js';
import { verifyApproverByPassword } from './principal.js';
import { projectName } from './project.js';
import type { FlowRow, Store } from './store.js';

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

const json = { name: 'json', takesValue: false, meaning: 'answer with one machine envelope on stdout' };
const db = { name: 'db', takesValue: true, meaning: 'path to the database file (defaults to the installation\'s)' };
const as = { name: 'as', takesValue: true, meaning: 'the approver making the change (default: the remembered login)' };
const token = { name: 'token', takesValue: true, meaning: "that approver's password" };
const yes = { name: 'yes', takesValue: false, meaning: 'make the previewed change' };
const repo = { name: 'repo', takesValue: true, meaning: 'the project checkout root' };
const steps = { name: 'steps', takesValue: true, meaning: "a JSON file (or - for stdin) with the steps in order, as the lead's flow tool takes them" };
const read = [json, db];
const write = [json, db, as, token];
export const FLOWS_DESCRIPTORS = [
  { action: 'list', synopsis: 'list flows: id, name, project, zones, triggers and cards waiting', mutation: 'none', flags: [...read, repo] },
  { action: 'show', synopsis: 'one flow: zones with their next and failure paths, triggers and recent cards', mutation: 'none', positionals: ['flow'], flags: read },
  { action: 'create', synopsis: 'create a flow from --template <id> (a template or starter flow) or --steps <file|->; previews until --yes', mutation: 'unkeyed', flags: [...write, yes, repo,
    { name: 'name', takesValue: true, meaning: "the flow's name (a template's label when left out)" },
    { name: 'template', takesValue: true, meaning: `one of ${[...FLOW_TEMPLATES.map(one => one.id), ...STARTER_FLOWS.map(one => one.id)].join(', ')}` }, steps] },
  { action: 'edit', synopsis: "replace a flow's steps (kept steps by id) and optionally rename it; previews until --yes", mutation: 'unkeyed', positionals: ['flow'], flags: [...write, yes, steps, { name: 'name', takesValue: true, meaning: 'a new name' }] },
  { action: 'trigger add', synopsis: 'add a trigger from JSON or a JSON file (any kind: button, schedule, github, linear, flow, webhook, email, chat); previews until --yes', mutation: 'unkeyed', positionals: ['flow', 'trigger'], flags: [...write, yes] },
  { action: 'trigger pause', synopsis: 'pause a trigger', mutation: 'identity-idempotent', positionals: ['flow', 'trigger'], flags: write },
  { action: 'trigger resume', synopsis: 'turn a paused trigger on again', mutation: 'identity-idempotent', positionals: ['flow', 'trigger'], flags: write },
  { action: 'trigger remove', synopsis: 'remove a trigger; cards it added stay', mutation: 'identity-idempotent', positionals: ['flow', 'trigger'], flags: write },
  { action: 'trigger check', synopsis: 'run a checked trigger (or a schedule\'s script) now, like Check now', mutation: 'unkeyed', positionals: ['flow', 'trigger'], flags: write },
  { action: 'script save', synopsis: "save a project script (a new version when it exists)", mutation: 'identity-idempotent', flags: [...write, repo,
    { name: 'name', takesValue: true, meaning: 'lowercase letters, numbers and dashes' },
    { name: 'file', takesValue: true, meaning: 'run this path in the project' },
    { name: 'body', takesValue: true, meaning: 'a local file holding the script itself' },
    { name: 'about', takesValue: true, meaning: 'one line: what it checks or does' },
    { name: 'language', takesValue: true, meaning: 'shell (default), python or node' },
    { name: 'timeout-minutes', takesValue: true, meaning: '1 to 60 (default 15)' }] },
  { action: 'card add', synopsis: 'add a card, in the first zone unless --zone names one', mutation: 'unkeyed', positionals: ['flow'], flags: [...write,
    { name: 'title', takesValue: true, meaning: "the card's title" },
    { name: 'description', takesValue: true, meaning: 'its details' },
    { name: 'zone', takesValue: true, meaning: 'a zone id or name' }] },
  { action: 'card approve', synopsis: "approve a card waiting at a Person decides step (or pick --option at a Person chooses step), as the console's Approve does", mutation: 'identity-idempotent', positionals: ['flow', 'card'], flags: [...write,
    { name: 'option', takesValue: true, meaning: "at a Person chooses step: the option's words or its number" }] },
  { action: 'card send-back', synopsis: "send a waiting card back with a note, as the console's Send back (or a reply at a Person chooses step) does", mutation: 'identity-idempotent', positionals: ['flow', 'card'], flags: [...write,
    { name: 'note', takesValue: true, meaning: 'what should change' }] },
  { action: 'export', synopsis: 'write a flow as a *.toolroll-flow.json file: zones, paths, trigger settings and scripts; never secrets, webhook addresses, names or cards', mutation: 'none', positionals: ['flow'], flags: [...read,
    { name: 'out', takesValue: true, meaning: 'write the file here (default: print it)' }] },
  { action: 'import', synopsis: 'make a flow from a flow file or a gist/GitHub https address; previews in plain words until --yes; triggers arrive off and scripts wait for approval', mutation: 'unkeyed', positionals: ['file'], flags: [...write, yes, repo,
    { name: 'param', takesValue: true, meaning: 'a value the file asks for, as name=value (repeat for more)' }] },
  { action: 'script approve', synopsis: 'approve a script an imported flow brought, so it runs', mutation: 'identity-idempotent', flags: [...write, repo, { name: 'name', takesValue: true, meaning: "the script's name" }] },
  { action: 'archive', synopsis: 'archive a flow: its cards stop moving and its triggers stop; previews until --yes', mutation: 'identity-idempotent', positionals: ['flow'], flags: [...write, yes] },
] as const;

/** `--file` is a value here (a path in the project), where elsewhere it is a switch. */
export const FLOWS_VALUE_FLAGS: ReadonlySet<string> = new Set(['file', 'param']);

export type FlowsCliContext = {
  store: Store;
  write: (line: string) => void;
  json: boolean;
  clock: () => Date;
  /** --as/--token, or the remembered login; null when neither. */
  credentials: { name: string; token: string } | null;
  /** Every project the installation knows (enrolled, opened or worked on). */
  projects: readonly string[];
  /** Beside the database: webhook secrets, the hooks address. */
  configDir: string;
  evidenceRoot: string;
  triggerIo: TriggerIo;
  /** Reads a file, or stdin for "-". */
  readInput?: (path: string) => string;
  /** Fetches a flow file's address (tests stand in for the network). */
  fetchFlow?: FetchLike;
};

type Flags = Map<string, string | true>;

export async function runFlowsCommand(positional: readonly string[], flags: Flags, context: FlowsCliContext): Promise<number> {
  const [first, second] = positional;
  const action = first === 'trigger' || first === 'script' || first === 'card' ? `${first} ${second ?? ''}`.trim() : first ?? 'list';
  const command = `flows ${action}`;
  const args = positional.slice(action.split(' ').length);
  const fail = (reason: string, message: string, code: number = EXIT.refused, extra: Record<string, unknown> = {}) => {
    context.write(context.json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
    return code;
  };
  const ok = (result: Record<string, unknown>, lines: string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join('\n')); return EXIT.ok; };
  const descriptor = FLOWS_DESCRIPTORS.find(one => one.action === action);
  if (descriptor === undefined) return fail('usage', `Use flows ${FLOWS_DESCRIPTORS.map(one => one.action).join(' | ')}.`, EXIT.usage);
  const known = new Set<string>(descriptor.flags.map(one => one.name));
  for (const name of flags.keys()) if (!known.has(name) && name !== 'help') return fail('usage', `--${name} is not a flows ${action} option.`, EXIT.usage);
  const text = (key: string): string | null => { const value = flags.get(key); return typeof value === 'string' ? value : null; };
  const readInput = context.readInput ?? ((path: string) => readFileSync(path === '-' ? 0 : resolve(path), 'utf8'));
  const { store } = context;

  // ---- reads: what the installation holds, no login needed
  const projectOf = (given: string | null) => given === null ? null : context.projects.find(one => one === given || one === resolve(given)) ?? null;
  const flowOf = (value: string | undefined, repos: readonly string[]): FlowRow | null => {
    const flow = value !== undefined && /^[1-9][0-9]{0,9}$/.test(value) ? store.getFlow(Number(value)) : null;
    return flow !== null && flow.state === 'active' && repos.includes(flow.repo) ? flow : null;
  };
  if (action === 'list') {
    const given = text('repo');
    const project = projectOf(given);
    if (given !== null && project === null) return fail('unknown-project', 'That isn\'t a project Toolroll knows.');
    const flows = store.listFlows(project === null ? context.projects : [project]).map(flow => listed(store, flow));
    return ok({ flows }, flows.length === 0 ? ['No flows yet. Create one: toolroll flows create --repo <path> --name <name> --template coding'] : flows.map(one =>
      `#${one.id}  ${one.name} · ${one.project} · ${one.zones.length} zone${one.zones.length === 1 ? '' : 's'} · ${one.triggers} trigger${one.triggers === 1 ? '' : 's'} · ${one.cardsWaiting} card${one.cardsWaiting === 1 ? '' : 's'} waiting`));
  }
  if (action === 'show') {
    const flow = flowOf(args[0], context.projects);
    if (flow === null) return fail('unknown-flow', 'No such flow in your projects. toolroll flows list names them.');
    const shown = describeFlow(store, flow);
    return ok({ flow: shown }, showLines(shown));
  }
  if (action === 'export') {
    const flow = flowOf(args[0], context.projects);
    if (flow === null) return fail('unknown-flow', 'No such flow in your projects. toolroll flows list names them.');
    let exported: ReturnType<typeof exportFlow>;
    try { exported = exportFlow(store, flow, context.configDir); } catch (error) { return fail('unreadable', error instanceof Error ? error.message : 'This flow can\'t be exported.'); }
    const left = exported.left.length === 0 ? [] : [`Left out: ${exported.left.join('; ')}.`];
    const out = text('out');
    if (out === null) {
      if (context.json) return ok({ file: exported.file, fileName: exported.fileName, left: exported.left }, []);
      context.write(exported.json.trimEnd());
      return EXIT.ok;
    }
    try { writeFileSync(resolve(out), exported.json); } catch { return fail('unwritable', `Couldn't write ${out}.`, EXIT.failed); }
    return ok({ path: resolve(out), fileName: exported.fileName, left: exported.left }, [`Wrote ${flow.name} to ${resolve(out)}.`, ...left]);
  }

  // ---- writes: an approver's, on a project they can reach
  if (context.credentials === null) return fail('unauthenticated', 'Changing a flow needs an approver: pass --as <you> --token <your password> (or sign in once with toolroll up).');
  const acting = context.credentials;
  const reachable = context.projects.filter(one => store.accountCanAccess(acting.name, one));
  const verified = verifyApproverByPassword(store, acting.name, acting.token, reachable);
  if (!verified.ok) return fail('unauthenticated', 'That name and password aren\'t an approver\'s. Nothing was changed.');
  const who = verified.who.name;
  const now = context.clock();
  // Each write, taken or refused, is a line in the ledger, like a console request.
  const record = (project: string | null, outcome: 'accepted' | 'refused', detail: string | null = null) => {
    store.recordAction({ at: context.clock().toISOString(), actor: who, repo: project, taskId: null, runId: null, action: command, outcome, source: 'request', detail: `command line${detail === null ? '' : ` · ${detail}`}` });
  };
  const refuse = (project: string | null, reason: string, message: string, code: number = EXIT.refused) => { record(project, 'refused', reason); return fail(reason, message, code); };
  const settle = (project: string) => { try { advanceFlows(store, project, context.clock(), { evidenceRoot: context.evidenceRoot }); } catch { /* the next worker pass retries */ } };
  const preview = (project: string | null, title: string, terms: string[], extra: Record<string, unknown>) =>
    ok({ applied: false, repo: project, title, terms, ...extra }, [title, ...terms.map(one => `  ${one.replace(/\n/g, '\n     ')}`), '', 'Nothing has changed. Add --yes to make this change.']);
  const readJson = (value: string, what: string): { ok: true; value: unknown } | { ok: false; message: string } => {
    let raw: string;
    try { raw = value.trim().startsWith('{') || value.trim().startsWith('[') ? value : readInput(value); }
    catch { return { ok: false, message: `The ${what} file couldn't be read.` }; }
    try { return { ok: true, value: JSON.parse(raw) as unknown }; } catch { return { ok: false, message: `The ${what} aren't valid JSON.` }; }
  };
  const stepsOf = (value: unknown): unknown => value !== null && typeof value === 'object' && !Array.isArray(value) && 'steps' in value ? (value as { steps: unknown }).steps : value;

  if (action === 'create') {
    const given = text('repo');
    if (given === null) return fail('usage', 'Use flows create --repo <path> --name <name> (--template <id> | --steps <file|->).', EXIT.usage);
    const project = projectOf(given);
    if (project === null || !reachable.includes(project)) return refuse(null, 'unknown-project', 'That isn\'t one of your projects. toolroll repos lists them.');
    const templateId = text('template'), stepsFile = text('steps');
    if ((templateId === null) === (stepsFile === null)) return fail('usage', 'Give --template or --steps, not both.', EXIT.usage);
    const name = (text('name') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    const starter = templateId === null ? null : starterOf(templateId);
    if (starter !== null) {
      // A starter flow: its zones and its trigger, together, under its own name.
      if (name !== '' && name !== starter.name) return fail('usage', `A starter flow keeps its name, ${starter.name}.`, EXIT.usage);
      if (starterFlowOf(store, starter, project) !== null) return refuse(project, 'already-on', `${starter.name} is already on in ${projectName(project)}.`);
      const blocked = startersFor(store, project).find(one => one.id === starter.id)?.blocked ?? null;
      if (blocked !== null) return refuse(project, 'blocked', blocked);
      if (!flags.has('yes')) return preview(project, `Switch on ${starter.name} in ${projectName(project)}`, starterTerms(store, starter, project), { starter: starter.id });
      const switched = switchOnStarter(store, starter, project, who, now, context.configDir);
      if (!switched.ok) return refuse(project, 'refused', switched.said);
      record(project, 'accepted', `flow #${switched.flow}`);
      return ok({ applied: true, flow: describeFlow(store, store.getFlow(switched.flow)!) }, [`${switched.said} Flow #${switched.flow}.`]);
    }
    const template = templateId === null ? null : FLOW_TEMPLATES.find(one => one.id === templateId) ?? null;
    if (templateId !== null && template === null) return fail('usage', `Choose a template: ${[...FLOW_TEMPLATES.map(one => one.id), ...STARTER_FLOWS.map(one => one.id)].join(', ')}.`, EXIT.usage);
    let definition: FlowDefinition;
    if (template !== null) definition = structuredClone(template.definition);
    else {
      const input = readJson(stepsFile!, 'steps');
      if (!input.ok) return refuse(project, 'invalid-steps', input.message);
      try { definition = flowFromSteps(stepsFor(stepsOf(input.value), who), null); }
      catch (error) { return refuse(project, 'invalid-steps', error instanceof Error ? error.message : 'Those steps aren\'t a flow.'); }
    }
    const flowName = name || template?.label || '';
    if (flowName === '') return fail('usage', 'Name the flow with --name.', EXIT.usage);
    const elsewhere = crossProjectProblem(store, definition, { repo: project, owner: who });
    if (elsewhere !== null) return refuse(project, 'invalid-steps', elsewhere);
    const terms = flowTerms(definition, null);
    if (template?.trigger !== undefined) {
      const draft: FlowRow = { id: 0, repo: project, name: flowName, definitionJson: JSON.stringify(definition), revision: 1, state: 'active', createdBy: who, createdAt: now.toISOString(), updatedBy: who, updatedAt: now.toISOString(), owner: who };
      try { terms.push(`Starts cards from: ${describeTrigger(validateTriggerConfig(template.trigger, { store, flow: draft, definition, actor: who }), store)}. Only what happens from now on counts.`); }
      catch (error) { return refuse(project, 'invalid-trigger', error instanceof Error ? error.message : 'Its trigger isn\'t valid.'); }
    }
    if (!flags.has('yes')) return preview(project, `Create the ${flowName} flow in ${projectName(project)}`, terms, { definition });
    let id: number;
    try {
      id = store.transact(() => {
        const made = store.createFlow({ repo: project, name: flowName, definitionJson: JSON.stringify(definition), by: who }, now);
        if (template?.trigger !== undefined) {
          const trigger = addFlowTriggerTo(store, store.getFlow(made)!, template.trigger, who, now, context.configDir);
          if (!trigger.ok) throw new Error(trigger.message);
        }
        return made;
      });
    } catch (error) { return refuse(project, 'invalid-trigger', error instanceof Error ? error.message : 'Its trigger isn\'t valid.'); }
    record(project, 'accepted', `flow #${id}`);
    return ok({ applied: true, flow: describeFlow(store, store.getFlow(id)!) }, [`Created ${flowName}, flow #${id}. Add cards with toolroll flows card add ${id} --title "…".`]);
  }

  if (action === 'script save') {
    const given = text('repo');
    if (given === null || text('name') === null) return fail('usage', 'Use flows script save --repo <path> --name <name> (--file <path in project> | --body <file>) --about "<one line>".', EXIT.usage);
    const project = projectOf(given);
    if (project === null || !reachable.includes(project)) return refuse(null, 'unknown-project', 'That isn\'t one of your projects. toolroll repos lists them.');
    let body: string | undefined;
    const bodyFile = text('body');
    if (bodyFile !== null) {
      try { body = readInput(bodyFile); } catch { return refuse(project, 'unreadable', 'The --body file couldn\'t be read.'); }
    }
    const saved = saveScript(store, project, { name: text('name'), about: text('about') ?? undefined, body, file: text('file') ?? undefined, language: text('language') ?? undefined, timeoutMinutes: text('timeout-minutes') ?? undefined }, who, now);
    if (!saved.ok) return refuse(project, 'invalid-script', saved.message);
    record(project, 'accepted', `script ${String(text('name')).trim().toLowerCase()} v${saved.version}`);
    settle(project);
    return ok({ applied: true, repo: project, script: store.flowScript(project, String(text('name')).trim().toLowerCase()), said: saved.said }, [saved.said]);
  }

  if (action === 'import') {
    const given = text('repo');
    if (given === null || args[0] === undefined) return fail('usage', 'Use flows import <file|https address> --repo <path> [--param name=value …] [--yes].', EXIT.usage);
    const project = projectOf(given);
    if (project === null || !reachable.includes(project)) return refuse(null, 'unknown-project', 'That isn\'t one of your projects. toolroll repos lists them.');
    const source = args[0];
    const params: Record<string, string> = {};
    for (const line of (text('param') ?? '').split('\n').filter(one => one.trim() !== '')) {
      const equals = line.indexOf('=');
      if (equals < 1) return fail('usage', `Give --param as name=value, not ${line}.`, EXIT.usage);
      params[line.slice(0, equals).trim()] = line.slice(equals + 1);
    }
    let plan: ReturnType<typeof planFlowImport>;
    try {
      let raw: string;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) raw = await fetchFlowFile(source, context.fetchFlow);
      else {
        let size = 0;
        try { size = source === '-' ? 0 : statSync(resolve(source)).size; } catch { /* readInput says it can't be read */ }
        if (size > FLOW_FILE_MAX_BYTES) throw new FlowFileError(`That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.`);
        try { raw = readInput(source); } catch { throw new FlowFileError(`${source} couldn't be read.`); }
      }
      plan = planFlowImport(store, project, parseFlowFile(raw), params, who);
    } catch (error) {
      if (!(error instanceof FlowFileError)) throw error;
      return refuse(project, 'invalid-file', error.message);
    }
    if (!flags.has('yes')) return preview(project, plan.title, plan.terms, { name: plan.name, definition: plan.definition, parameters: plan.values });
    let made: ReturnType<typeof importFlow>;
    try { made = importFlow(store, plan, who, now, context.configDir); }
    catch (error) { return refuse(project, 'invalid-file', error instanceof Error ? error.message : 'That flow couldn\'t be imported.'); }
    record(project, 'accepted', `flow #${made.id}`);
    return ok({ applied: true, flow: describeFlow(store, store.getFlow(made.id)!), said: made.said }, [`${made.said} Flow #${made.id}.`]);
  }

  if (action === 'script approve') {
    const given = text('repo'), name = text('name');
    if (given === null || name === null) return fail('usage', 'Use flows script approve --repo <path> --name <name>.', EXIT.usage);
    const project = projectOf(given);
    if (project === null || !reachable.includes(project)) return refuse(null, 'unknown-project', 'That isn\'t one of your projects. toolroll repos lists them.');
    const script = store.flowScript(project, name.trim().toLowerCase());
    if (script === null) return refuse(project, 'unknown-script', `There's no script called ${name} in ${projectName(project)}.`);
    if (script.held === null) return ok({ applied: false, repo: project, said: `${script.name} already runs.` }, [`${script.name} already runs.`]);
    store.approveFlowScript(project, script.name);
    record(project, 'accepted', `script ${script.name} approved`);
    settle(project);
    return ok({ applied: true, repo: project, said: `Approved ${script.name}. Zones that run it go on.` }, [`Approved ${script.name}. Zones that run it go on.`]);
  }

  // Everything else names a flow in one of this person's projects.
  const flow = flowOf(args[0], reachable);
  if (flow === null) return refuse(null, 'unknown-flow', 'No such flow in your projects. toolroll flows list names them.');
  const definition = flowDefinitionOf(flow);

  if (action === 'archive') {
    const cards = store.flowCards(flow.id, false).length, triggers = store.flowTriggers(flow.id).filter(one => one.state === 'active').length;
    if (!flags.has('yes')) return preview(flow.repo, `Archive the ${flow.name} flow`, [
      `It leaves the flows list. ${cards === 0 ? 'No cards are in it.' : `Its ${cards} active card${cards === 1 ? '' : 's'} stop moving.`}${triggers === 0 ? '' : ` Its ${triggers} trigger${triggers === 1 ? '' : 's'} stop adding cards.`}`,
      'Tasks its cards filed stay as they are.',
    ], { flowId: flow.id });
    if (!store.archiveFlow(flow.id, who, now)) return refuse(flow.repo, 'stale', 'Someone archived it just now.');
    record(flow.repo, 'accepted', `flow #${flow.id}`);
    return ok({ applied: true, flowId: flow.id }, [`Archived ${flow.name}.`]);
  }
  if (definition === null) return refuse(flow.repo, 'unreadable', 'This flow\'s drawing can\'t be read. Save it again from the editor.');

  if (action === 'edit') {
    const stepsFile = text('steps');
    if (stepsFile === null && text('name') === null) return fail('usage', 'Use flows edit <flow> --steps <file|-> [--name <name>].', EXIT.usage);
    let next = definition;
    if (stepsFile !== null) {
      const input = readJson(stepsFile, 'steps');
      if (!input.ok) return refuse(flow.repo, 'invalid-steps', input.message);
      try { next = flowFromSteps(stepsFor(stepsOf(input.value), who), definition); }
      catch (error) { return refuse(flow.repo, 'invalid-steps', error instanceof Error ? error.message : 'Those steps aren\'t a flow.'); }
    }
    const name = (text('name') ?? flow.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || flow.name;
    const redrawn = flowDigest(next) !== flowDigest(definition);
    if (!redrawn && name === flow.name) return fail('no-change', 'That\'s the flow as it is now.');
    const elsewhere = crossProjectProblem(store, next, flow, who);
    if (elsewhere !== null) return refuse(flow.repo, 'invalid-steps', elsewhere);
    if (!flags.has('yes')) return preview(flow.repo, `Change the ${flow.name} flow`, [...(name === flow.name ? [] : [`Renames it to ${name}.`]), ...(redrawn ? flowTerms(next, definition) : [])], { flowId: flow.id, revision: flow.revision, definition: next });
    if (!store.saveFlow(flow.id, { name, definitionJson: JSON.stringify(next), sawRevision: flow.revision, by: who }, now)) return refuse(flow.repo, 'stale', 'Someone else changed this flow. Look again, then make yours.');
    record(flow.repo, 'accepted', `flow #${flow.id}`);
    settle(flow.repo);
    return ok({ applied: true, flow: describeFlow(store, store.getFlow(flow.id)!) }, [`Saved ${name}.`]);
  }

  if (action === 'card add') {
    const title = text('title');
    if (title === null) return fail('usage', 'Use flows card add <flow> --title "<title>" [--description "<details>"] [--zone <zone>].', EXIT.usage);
    const named = text('zone');
    const stage = named === null ? null : definition.stages.find(one => one.id === named.trim() || one.title.toLowerCase() === named.trim().toLowerCase()) ?? null;
    if (named !== null && stage === null) return refuse(flow.repo, 'unknown-zone', `This flow has no zone called ${named}.`);
    const added = addCardToFlow(store, flow, { title, description: text('description'), stage: stage?.id ?? null }, who, now);
    if (!added.ok) return refuse(flow.repo, 'invalid-card', added.message);
    record(flow.repo, 'accepted', `flow #${flow.id} card #${added.card}`);
    settle(flow.repo);
    const card = store.getFlowCard(added.card);
    return ok({ applied: true, card: card === null ? { id: added.card } : cardOf(definition, card), said: added.said }, [`${added.said} Card #${added.card}.`]);
  }

  if (action === 'card approve' || action === 'card send-back') {
    // The console's own doors (decideFlowCard, chooseFlowCard): the same decider, visit and project checks, and the same card history.
    const approving = action === 'card approve';
    const note = text('note')?.trim() ?? null;
    if (args[1] === undefined || (!approving && (note === null || note === ''))) return fail('usage', approving ? 'Use flows card approve <flow> <card> [--option <words|number>].' : 'Use flows card send-back <flow> <card> --note "<what should change>".', EXIT.usage);
    const card = /^[1-9][0-9]{0,9}$/.test(args[1]) ? store.getFlowCard(Number(args[1])) : null;
    if (card === null || card.flow !== flow.id) return refuse(flow.repo, 'unknown-card', `Flow #${flow.id} has no card #${args[1]}. toolroll flows show ${flow.id} lists its cards.`);
    const stage = definition.stages.find(one => one.id === card.stage);
    let decided: { ok: true; said: string } | { ok: false; message: string };
    if (stage?.kind === 'choose') {
      if (approving) {
        const given = text('option')?.trim() ?? '';
        const options = stage.options ?? [];
        const choice = /^[1-9]$/.test(given) && Number(given) <= options.length ? Number(given) - 1 : options.findIndex(one => one.label.toLowerCase() === given.toLowerCase());
        if (given === '' || choice < 0) return refuse(flow.repo, 'choose-option', `${stage.title} asks for a choice: give --option with one of ${options.map((one, at) => `${at + 1} “${one.label}”`).join(', ')}.`, EXIT.usage);
        decided = chooseFlowCard(store, { card: card.id, entry: card.entry, choice, label: options[choice]!.label, note: null, actor: who, where: 'the command line', repos: reachable, evidenceRoot: context.evidenceRoot }, now);
      } else decided = chooseFlowCard(store, { card: card.id, entry: card.entry, choice: null, note, actor: who, where: 'the command line', repos: reachable, evidenceRoot: context.evidenceRoot }, now);
    } else if (stage?.kind === 'approval') {
      if (text('option') !== null) return fail('usage', '--option is for a Person chooses step; this card waits for a decision.', EXIT.usage);
      decided = decideFlowCard(store, { card: card.id, decision: approving ? 'approve' : 'send-back', note, actor: who, repos: reachable, evidenceRoot: context.evidenceRoot, entry: card.entry, where: 'the command line' }, now);
    } else return refuse(flow.repo, 'not-waiting', card.state === 'active' ? `Card #${card.id} isn't waiting for a decision; it's in ${stage?.title ?? card.stage}.` : `Card #${card.id} is ${card.state}; nothing is waiting on it.`);
    if (!decided.ok) return refuse(flow.repo, 'refused', decided.message);
    record(flow.repo, 'accepted', `flow #${flow.id} card #${card.id} · ${stage.title}`);
    settle(flow.repo);
    const after = store.getFlowCard(card.id);
    return ok({ applied: true, card: after === null ? { id: card.id } : cardOf(definition, after), said: decided.said }, [decided.said]);
  }

  if (action === 'trigger add') {
    if (args[1] === undefined) return fail('usage', 'Use flows trigger add <flow> <json|file|->, like \'{"kind":"schedule","schedule":"daily 09:00","title":"Standup"}\'.', EXIT.usage);
    const input = readJson(args[1], 'trigger settings');
    if (!input.ok) return refuse(flow.repo, 'invalid-trigger', input.message);
    let config: ReturnType<typeof validateTriggerConfig>;
    try { config = validateTriggerConfig(input.value, { store, flow, definition, actor: who }); }
    catch (error) { return refuse(flow.repo, 'invalid-trigger', error instanceof Error ? error.message : 'That trigger isn\'t valid.'); }
    const words = describeTrigger(config, store);
    if (!flags.has('yes')) {
      const zone = definition.stages.find(one => one.id === (config.zone ?? definition.start))?.title ?? 'the first zone';
      return preview(flow.repo, `Add a trigger to ${flow.name}`, [words, `Cards start in ${zone}.`, 'Work a card starts still waits for your usual approvals.'], { flowId: flow.id, trigger: config });
    }
    const made = addFlowTriggerTo(store, flow, input.value, who, now, context.configDir);
    if (!made.ok) return refuse(flow.repo, 'invalid-trigger', made.message);
    record(flow.repo, 'accepted', `flow #${flow.id} trigger #${made.id}`);
    settle(flow.repo);
    // A webhook's address (and GitHub's signing secret) is shown this once, never stored readable.
    return ok({ applied: true, triggerId: made.id, said: made.said, ...(made.reveal === null ? {} : { reveal: made.reveal }) }, [
      `${made.said} Trigger #${made.id}: ${words}`,
      ...(made.reveal === null ? [] : [`  address: ${made.reveal.address ?? `<your public address>${made.reveal.path}`}`, ...(made.reveal.secret === null ? [] : [`  signing secret: ${made.reveal.secret}`])]),
    ]);
  }

  // trigger pause | resume | remove | check <flow> <trigger>
  const trigger = args[1] !== undefined && /^[1-9][0-9]{0,9}$/.test(args[1]) ? store.getFlowTrigger(Number(args[1])) : null;
  if (trigger === null || trigger.flow !== flow.id || trigger.state === 'removed') return refuse(flow.repo, 'unknown-trigger', 'That trigger isn\'t on this flow. toolroll flows show <flow> names them.');
  if (action === 'trigger check') {
    const checked = await checkFlowTriggerNow(store, trigger, now, context.triggerIo);
    record(flow.repo, checked.ok ? 'accepted' : 'refused', `flow #${flow.id} trigger #${trigger.id}`);
    settle(flow.repo);
    return checked.ok ? ok({ applied: true, triggerId: trigger.id, said: checked.said }, [checked.said]) : fail('check-failed', checked.said);
  }
  if (action === 'trigger remove') removeFlowTrigger(store, trigger, now, context.configDir);
  else store.updateFlowTrigger(trigger.id, { state: action === 'trigger pause' ? 'paused' : 'active' }, now);
  record(flow.repo, 'accepted', `flow #${flow.id} trigger #${trigger.id}`);
  settle(flow.repo);
  const said = action === 'trigger remove' ? 'Trigger removed.' : action === 'trigger pause' ? 'Trigger paused.' : 'Trigger on again.';
  return ok({ applied: true, triggerId: trigger.id, said }, [said]);
}

// ---- how a flow reads here

type Listed = { id: number; name: string; repo: string; project: string; zones: string[]; triggers: number; cardsWaiting: number; needDecision: number };

function listed(store: Store, flow: FlowRow): Listed {
  const definition = flowDefinitionOf(flow);
  const cards = store.flowCards(flow.id, false);
  return { id: flow.id, name: flow.name, repo: flow.repo, project: projectName(flow.repo), zones: definition?.stages.map(one => one.title) ?? [],
    triggers: store.flowTriggers(flow.id).filter(one => one.state === 'active').length, cardsWaiting: cards.length,
    needDecision: cards.filter(card => ['approval', 'choose'].includes(definition?.stages.find(one => one.id === card.stage)?.kind ?? '')).length };
}

/** One zone and every path out of it, by zone id. */
function zoneOf(stage: FlowStage, flow: FlowRow) {
  return {
    id: stage.id, title: stage.title, kind: stage.kind, does: FLOW_KIND_WORDS[stage.kind].label,
    next: stage.next, ifFails: stage.onFail,
    ...(stage.sort === null ? {} : { answers: stage.sort.answers.map(one => ({ answer: one.answer, to: one.to })), sureAt: stage.sort.sureAt }),
    ...(stage.routes === undefined || stage.routes.length === 0 ? {} : { routes: stage.routes.map(one => ({ answer: one.answer, to: one.to })) }),
    ...(stage.limit === undefined ? {} : { remindAfterMinutes: stage.limit.minutes, thenMoveTo: stage.limit.to }),
    ...(stage.kind === 'approval' ? { decider: deciderOf(stage, flow) } : {}),
    ...(stage.script === null ? {} : { script: stage.script }),
    ...(stage.merge === undefined ? {} : { merge: stage.merge }),
    ...(stage.teammate === undefined ? {} : { teammate: stage.teammate }),
    ...(stage.options === undefined ? {} : { options: stage.options.map(one => ({ label: one.label, to: one.to })) }),
    ...(stage.repo === undefined ? {} : { repo: stage.repo }),
  };
}

function cardOf(definition: FlowDefinition | null, card: { id: number; title: string; stage: string; state: string; waiting: string | null; task: string | null; primaryTask: string | null; updatedAt: string }) {
  return { id: card.id, title: card.title, zone: card.stage, zoneTitle: definition?.stages.find(one => one.id === card.stage)?.title ?? card.stage, state: card.state, waiting: card.waiting, task: card.task ?? card.primaryTask, updatedAt: card.updatedAt };
}

function describeFlow(store: Store, flow: FlowRow) {
  const definition = flowDefinitionOf(flow);
  return {
    id: flow.id, name: flow.name, repo: flow.repo, project: projectName(flow.repo), owner: flow.owner, revision: flow.revision, readable: definition !== null,
    start: definition?.start ?? null,
    zones: definition?.stages.map(stage => zoneOf(stage, flow)) ?? [],
    triggers: store.flowTriggers(flow.id).map(trigger => {
      const config = triggerConfigOf(trigger);
      return { id: trigger.id, kind: trigger.kind, state: trigger.state, words: config === null ? 'This trigger can\'t be read.' : describeTrigger(config, store),
        zone: config?.zone ?? definition?.start ?? null, nextAt: trigger.nextAt, lastAt: trigger.lastAt, lastOutcome: trigger.lastOutcome, failing: trigger.failures > 0 };
    }),
    cards: store.flowCards(flow.id, true).slice(0, 10).map(card => cardOf(definition, card)),
  };
}

function showLines(flow: ReturnType<typeof describeFlow>): string[] {
  const title = (id: string | null) => id === null ? null : flow.zones.find(one => one.id === id)?.title ?? id;
  if (!flow.readable) return [`#${flow.id} ${flow.name} · ${flow.project}`, 'This flow\'s drawing can\'t be read. Save it again from the editor.'];
  return [
    `#${flow.id} ${flow.name} · ${flow.project} · owner ${flow.owner}`,
    '', 'Zones',
    ...flow.zones.flatMap((zone, index) => [
      `  ${index + 1}. ${zone.title} (${zone.id}) — ${zone.does}${zone.id === flow.start ? ' · start' : ''}`,
      ...('answers' in zone && zone.answers !== undefined ? zone.answers.map(one => `     ${one.answer} → ${title(one.to)}`) : []),
      ...('routes' in zone && zone.routes !== undefined ? zone.routes.map(one => `     ${one.answer} → ${title(one.to)}`) : []),
      ...(zone.next === null ? [] : [`     next → ${title(zone.next)}`]),
      ...(zone.ifFails === null ? [] : [`     ${zone.kind === 'approval' ? 'sent back' : zone.kind === 'sort' ? 'not sure' : zone.kind === 'wait' ? 'no reply' : zone.kind === 'choose' ? 'a reply' : 'if it fails'} → ${title(zone.ifFails)}`]),
    ]),
    '', 'Triggers',
    ...(flow.triggers.length === 0 ? ['  none — add one with toolroll flows trigger add'] : flow.triggers.map(one => `  #${one.id} ${one.state === 'active' ? '' : `(${one.state}) `}${one.words} → ${title(one.zone)}${one.lastOutcome === null ? '' : ` · last: ${one.lastOutcome}`}`)),
    '', 'Recent cards',
    ...(flow.cards.length === 0 ? ['  none'] : flow.cards.map(one => `  #${one.id} ${one.title} · ${one.state === 'active' ? one.zoneTitle : one.state}${one.waiting === null ? '' : ` · ${one.waiting}`}`)),
  ];
}
