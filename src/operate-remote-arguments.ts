/** The audited remote argument vocabulary. Unlisted flags and extra positionals never dispatch.
 * Keep scalar inputs explicit: adding a resource argument requires classifying it here first.
 * Indices below are relative to the command row (after `task review`, `flows trigger add`, etc.). */
import type { Store } from './store.js';

type Kind = 'value' | 'task' | 'run' | 'review' | 'flow' | 'trigger' | 'trigger-json' | 'steps' | 'refused' | 'step-up';
type Argument = { name: string; kind: Kind; optional: boolean; rest: boolean };
export type RemoteArguments = { positionals: readonly Argument[]; flags: ReadonlyMap<string, Kind> };
const args = (positionals = '', values = '', references: Record<string, Kind> = {}): RemoteArguments => ({
  positionals: positionals.split(' ').filter(Boolean).map(word => {
    const [name = '', type = 'value'] = word.split(':');
    return { name: name.replace(/[?*]$/, ''), kind: type as Kind, optional: name.endsWith('?'), rest: name.endsWith('*') };
  }),
  flags: new Map([...['json', 'help', 'repo', ...values.split(' ').filter(Boolean)].map(name => [name, 'value'] as const), ...Object.entries(references)]),
});

/** All remotely allowed rows, including those with no resource references. Credentials and file-output
 * flags are refused by the outer boundary. `source` on memory is provenance text; on revise it is a scope
 * digest. Neither dereferences a conversation, task or proposal. Creation IDs are never looked up. */
export const REMOTE_ARGUMENTS: ReadonlyMap<string, RemoteArguments> = new Map([
  ...['status', 'ready', 'grants', 'gaps', 'sync', 'runner list', 'coordinator list', 'incident list',
    'routine list', 'intake show', 'intake run', 'template list', 'webhook status', 'webhook test', 'review show',
    'chat-approval show', 'chat-approval off'].map(row => [row, args()] as const),
  ['integrations', args('', 'saved')],
  // --person and --token-name are names compared inside the reader's own view; --token stays a refused credential.
  ['audit', args('', 'person token-name source since limit cursor')],
  ['outbox list', args('', 'all')],
  ['task add', args('title*', 'key report checks', { id: 'refused', replaces: 'task' })],
  ['task ask', args('id:task', 'person why')],
  ['task checks', args('task:task', 'level')],
  ['task add-tests', args('task:task')],
  ['task list', args('', 'state view limit cursor')],
  ['task show', args('id:task')],
  ['task wait', args('id:task', 'timeout')],
  ['task complete', args('task:task', 'digest', { run: 'run', 'pull-request': 'refused' })],
  ['task revise', args('task:task', 'feedback source key', { run: 'run' })],
  ['task state', args('id:task state', 'key reason', { 'replaced-by': 'task' })],
  ['task block', args('id:task', 'key', { on: 'task' })],
  ['task unblock', args('id:task', 'key', { on: 'task' })],
  ['task next', args('id:task', 'key undo')],
  ['task steer', args('id:task', 'note')],
  ['task assign', args('id:task', 'key runner anyone')],
  ['task scope', args('id:task', 'key goal not touches budget-usd risk acceptance candidate compare model provider race race-count race-per-usd race-total-usd repair-model')],
  ['task plan', args('id:task', 'key provider model')],
  ['task hold', args('id:task', 'key reason until')],
  ['task unhold', args('id:task', 'key')],
  ['task require', args('id:task', 'key cap require')],
  ['task requeue', args('id:task')],
  ['task review', args('id:review', 'brief all', { run: 'run' })],
  ['task repair', args('run:run', '', { yes: 'step-up' })],
  ['task route', args('id:task', 'risk phase provider model clear-phase digest size risky')],
  ['task reopen', args('id:task')],
  ['task stop', args('id:task', '', { run: 'run' })],
  ['task resume', args('id:task', '', { run: 'run' })],
  ['check-progress', args('run:run')],
  ['cap list', args()], ['cap add', args('name', 'kind probe expires')],
  // These objects are installation-scoped at the outer boundary; only an all-project principal reaches them.
  ['incident resolve', args('incident')],
  ['routine show', args('id')],
  ['routine add', args('name', 'goal schedule acceptance ceiling budget-usd not touches require')],
  ...['refresh', 'pause', 'resume', 'run-now'].map(action => [`routine ${action}`, args('name')] as const),
  ['config show', args('phase?')], ['verify show', args()],
  ['intake preview', args()], ['intake pr-comments', args('', 'limit')],
  ['template show', args('name')],
  ['contest show', args('id')], ['contest exclude', args('contest ordinal')],
  ...['search', 'impact'].map(action => [`knowledge ${action}`, args('query', 'base')] as const),
  ['knowledge refresh', args('', 'base')],
  // Decision reads and supersession are already project-bound in project-memory.ts. Proposal IDs are
  // accepted only by memory apply (step-up), never by the listing commands below.
  ...['search', 'decisions', 'show', 'decide', 'retire', 'review', 'status'].map(action => [`memory ${action}`,
    args(['search', 'decide'].includes(action) ? 'query*' : ['show', 'retire'].includes(action) ? 'query' : '',
      'why reason supersedes source all decision sessions no-local')] as const),
  ['flows list', args()],
  ['flows show', args('flow:flow')], ['flows export', args('flow:flow')],
  ['flows create', args('', 'yes name template', { steps: 'steps' })],
  ['flows edit', args('flow:flow', 'yes name', { steps: 'steps' })],
  ['flows trigger add', args('flow:flow trigger:trigger-json', 'yes')],
  ...['pause', 'resume', 'remove'].map(action => [`flows trigger ${action}`, args('flow:flow trigger:trigger')] as const),
  ['flows card add', args('flow:flow', 'title description zone')],
  ['flows archive', args('flow:flow', 'yes')],
  ['models status', args('', 'provider')], ['models list', args('', 'provider')],
]);

export const REMOTE_NOT_FOUND = { ok: false, reason: 'not-found', message: 'Not found.' } as const;
type Result = { ok: true; repo: string | null; taskId: string | null } | { ok: false; reason: string; message: string };
const positiveId = (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read-only authorization of every supplied reference, before the handler can disclose or mutate it. */
export function remoteArgumentsOf(store: Store, allows: (repo: string | null) => boolean, invocation: string,
  positional: readonly string[], flags: ReadonlyMap<string, string | true>, named: string | null,
  files: Readonly<Record<string, string>>): Result {
  const audit = REMOTE_ARGUMENTS.get(invocation);
  if (audit === undefined) return REMOTE_NOT_FOUND;
  const values = positional.slice(invocation.split(' ').length - 1);
  const resolved: { repo: string; taskId: string | null; taskRef?: number; flow?: number; parentFlow?: number; kind: Kind }[] = [];
  const admit = (repo: string | null | undefined) => typeof repo === 'string' && allows(repo) && (named === null || named === repo);
  const input = (value: string): unknown => {
    const raw = value.trim().startsWith('{') || value.trim().startsWith('[') ? value
      : Object.prototype.hasOwnProperty.call(files, value) ? files[value] : undefined;
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  const check = (kind: Kind, value: string): boolean => {
    if (kind === 'value') return true;
    if (kind === 'review') return check(flags.has('brief') ? 'task' : 'run', value);
    if (kind === 'task' || kind === 'run') {
      if (kind === 'task' && (!value || value.length > 64 || /[\x00-\x1f\x7f]/.test(value))) return false;
      if (kind === 'run' && !positiveId(value)) return false;
      const run = kind === 'run' ? store.getRun(Number(value)) : null;
      const ref = kind === 'run' ? run === null ? null : store.refById(run.taskRef) : store.lookupRef(value);
      if (ref === null || !admit(ref.repo) || store.lookupRef(ref.externalId)?.id !== ref.id || store.getTask(ref.externalId) === null) return false;
      resolved.push({ repo: ref.repo!, taskId: ref.externalId, taskRef: ref.id, kind });
      return true;
    }
    if (kind === 'flow' || kind === 'trigger') {
      if (!positiveId(value) || value.length > 10) return false;
      const trigger = kind === 'trigger' ? store.getFlowTrigger(Number(value)) : null;
      const flow = kind === 'flow' ? store.getFlow(Number(value)) : trigger === null ? null : store.getFlow(trigger.flow);
      if (flow === null || flow.state !== 'active' || !admit(flow.repo) || trigger?.state === 'removed') return false;
      resolved.push({ repo: flow.repo, taskId: null, ...(kind === 'flow' ? { flow: flow.id } : { parentFlow: trigger!.flow }), kind });
      return true;
    }
    if (kind === 'trigger-json') {
      const config = input(value);
      // Invalid/unavailable input cannot reach a resource lookup; the handler reports its existing file/JSON error.
      if (!object(config)) return true;
      return config['kind'] !== 'flow' || (typeof config['flow'] === 'number' && check('flow', String(config['flow'])));
    }
    if (kind === 'steps') {
      const config = input(value), steps = object(config) ? config['steps'] : config;
      if (!Array.isArray(steps)) return true;
      // Build steps can name another project. Check the token ceiling as well as the owner's account grants.
      return steps.every(step => !object(step) || step['repo'] === undefined ||
        typeof step['repo'] === 'string' && store.knownRepos().includes(step['repo']) && allows(step['repo']));
    }
    return false;
  };
  for (const [name, value] of flags) {
    const kind = audit.flags.get(name);
    if (kind === 'step-up') return { ok: false, reason: 'step-up', message: 'approve in the console or chat' };
    if (kind === 'refused') return { ok: false, reason: 'not-remote', message: 'That option is not available remotely.' };
    if (kind === undefined) return { ok: false, reason: 'usage', message: 'That option is not available for this remote command.' };
    // Resolve positionals first below so the primary ledger target is stable regardless of flag order.
    if (kind !== 'value' && typeof value !== 'string') return REMOTE_NOT_FOUND;
  }
  for (let i = 0; i < audit.positionals.length; i++) {
    const arg = audit.positionals[i]!;
    const value = values[i];
    if (value === undefined) {
      if (arg.optional) continue;
      return REMOTE_NOT_FOUND;
    }
    if (!check(arg.kind, value)) return REMOTE_NOT_FOUND;
  }
  if (values.length > audit.positionals.length && !audit.positionals.at(-1)?.rest) return REMOTE_NOT_FOUND;
  for (const [name, value] of flags) if (!check(audit.flags.get(name)!, String(value))) return REMOTE_NOT_FOUND;
  const task = resolved.find(ref => ref.kind === 'task');
  for (const ref of resolved) {
    if (ref.kind === 'run' && task !== undefined && ref.taskRef !== task.taskRef) {
      // Review/revise accept a saved result from the same revision family. Stop/resume name an exact attempt.
      const runFamily = store.taskFamilyOf(ref.taskId!, [ref.repo], false);
      const taskFamily = store.taskFamilyOf(task.taskId!, [task.repo], false);
      if (!['task review', 'task revise'].includes(invocation) || ref.repo !== task.repo || runFamily === null || taskFamily === null ||
        runFamily.root.id !== taskFamily.root.id) return REMOTE_NOT_FOUND;
    }
    if (ref.parentFlow !== undefined && ref.parentFlow !== resolved.find(one => one.kind === 'flow')?.flow) return REMOTE_NOT_FOUND;
  }
  if (invocation === 'task repair') {
    const draft = store.repairChainFor(Number(values[0]))?.draftTask;
    if (draft != null && (!check('task', draft) || resolved.at(-1)?.repo !== resolved[0]?.repo)) return REMOTE_NOT_FOUND;
  }
  return { ok: true, repo: resolved[0]?.repo ?? named, taskId: resolved[0]?.taskId ?? null };
}
