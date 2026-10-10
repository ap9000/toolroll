/** The session transport is a client of the running owner, never a catalog owner.
 * These descriptors drive request validation, CLI parsing, help and discovery. */
export const SESSION_PROTOCOL_VERSION = 1;
export const SESSION_PROMPT_BYTES = 64_000;
export const SESSION_REQUEST_BYTES = 128_000;
export const SESSION_RESPONSE_BYTES = 4_000_000;

export type SessionOperation = 'list' | 'show' | 'changes' | 'start' | 'send' | 'stop' | 'resume' | 'recover';
export type SessionExpected = { sessionId: string; key: string; expectedRevision: number; expectedThreadId: string | null; expectedTurnId: string | null };
export type SessionRequests = {
  list: { version: 1; project?: string; limit?: number };
  show: { version: 1; sessionId: string; view?: 'brief' | 'activity' };
  changes: { version: 1; sessionId: string };
  start: { version: 1; project: string; title: string; prompt: string; model?: string; key: string };
  send: { version: 1; prompt: string } & SessionExpected;
  stop: { version: 1 } & SessionExpected;
  resume: { version: 1 } & SessionExpected;
  recover: { version: 1 } & SessionExpected;
};
export type SessionRequest = SessionRequests[SessionOperation];
export type SessionView = {
  id: string; repo: string; title: string; status: string; nativeThreadId: string | null;
  turnId: string | null; revision: number; branch?: string; base?: string;
  error?: string | null; deliveryReviewRequired?: boolean; updatedAt?: string;
};
export type SessionBrief = { summary: string; nextAction: string; sourceRevision: number; sourceItemIds?: string[]; partialHistory?: boolean };
export type SessionResult = {
  session?: SessionView; sessions?: SessionView[];
  items?: { id: string; type: string; text: string; status: string | null; clientId?: string }[];
  requests?: { id: string; kind: string; title: string; detail: string }[];
  changes?: { head: string; status: string; diff: string; truncated: boolean };
  receipt?: { key: string; status: string }; brief?: SessionBrief; truncated?: boolean;
};
export type SessionNextAction = { operation: SessionOperation | 'open-ui'; label: string; sessionId?: string };
export type SessionResponse = {
  version: 1; operation: SessionOperation; ok: boolean;
  status: 'succeeded' | 'pending' | 'rejected' | 'uncertain';
  delivery: 'confirmed' | 'not-sent' | 'unknown'; retry: 'safe-read' | 'inspect-first' | 'never';
  message: string; nextActions: SessionNextAction[]; reason?: string; result?: SessionResult;
};

type Field = {
  type: 'string' | 'integer' | readonly ['string', 'null'];
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
  maxBytes?: number; nonblank?: boolean; const?: number;
};
export type SessionDescriptor = {
  operation: SessionOperation; synopsis: string; mutation: boolean;
  audience: 'operator'; agentMayInvoke: false;
  retry: 'safe-read' | 'inspect-first';
  inputSchema: { type: 'object'; additionalProperties: false; required: readonly string[]; properties: Record<string, Field> };
  flags: Readonly<Record<string, { field: string; kind: 'string' | 'integer' | 'nullable-id' }>>;
};
const text = (maxLength: number): Field => ({ type: 'string', minLength: 1, maxLength, nonblank: true });
const identity: Field = { ...text(200), pattern: '^[A-Za-z0-9_.:-]+$' };
const nullableIdentity: Field = { ...identity, type: ['string', 'null'] };
const key: Field = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$', minLength: 16, maxLength: 100 };
const prompt: Field = { ...text(SESSION_PROMPT_BYTES), maxBytes: SESSION_PROMPT_BYTES };
const model: Field = { ...text(128), pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' };
const expected = { sessionId: identity, key, expectedRevision: { type: 'integer', minimum: 0 } as Field, expectedThreadId: nullableIdentity, expectedTurnId: nullableIdentity };
const expectedFlags = {
  key: { field: 'key', kind: 'string' }, revision: { field: 'expectedRevision', kind: 'integer' },
  thread: { field: 'expectedThreadId', kind: 'nullable-id' }, turn: { field: 'expectedTurnId', kind: 'nullable-id' },
} as const;
function descriptor(operation: SessionOperation, synopsis: string, mutation: boolean, fields: Record<string, Field>, required: readonly string[], flags: SessionDescriptor['flags']): SessionDescriptor {
  return { operation, synopsis, mutation, audience: 'operator', agentMayInvoke: false, retry: mutation ? 'inspect-first' : 'safe-read',
    inputSchema: { type: 'object', additionalProperties: false, required: ['version', ...required], properties: { version: { type: 'integer', const: 1 }, ...fields } }, flags };
}
export const SESSION_DESCRIPTORS: readonly SessionDescriptor[] = [
  descriptor('list', 'List your native coding sessions', false, { project: text(4096), limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], { project: { field: 'project', kind: 'string' }, limit: { field: 'limit', kind: 'integer' } }),
  descriptor('show', 'Inspect the saved brief and exact identity; request activity when needed', false, { sessionId: identity, view: { type: 'string', pattern: '^(brief|activity)$' } }, ['sessionId'], { view: { field: 'view', kind: 'string' } }),
  descriptor('changes', 'Read changes from the saved session checkout', false, { sessionId: identity }, ['sessionId'], {}),
  descriptor('start', 'Start a native coding session in a project', true, { project: text(4096), title: text(160), prompt, model, key }, ['project', 'title', 'prompt', 'key'], { project: { field: 'project', kind: 'string' }, title: { field: 'title', kind: 'string' }, model: { field: 'model', kind: 'string' }, key: { field: 'key', kind: 'string' } }),
  descriptor('send', 'Send a message to the exact saved session and turn', true, { ...expected, prompt }, [...Object.keys(expected), 'prompt'], expectedFlags),
  descriptor('stop', 'Stop the exact running turn', true, expected, Object.keys(expected), expectedFlags),
  descriptor('resume', 'Reconnect the saved conversation', true, expected, Object.keys(expected), expectedFlags),
  descriptor('recover', 'Check process exit and reconcile saved delivery receipts', true, expected, Object.keys(expected), expectedFlags),
];
export const SESSION_OPERATIONS = SESSION_DESCRIPTORS.map(one => one.operation);
export function sessionDescriptor(operation: string): SessionDescriptor | undefined { return SESSION_DESCRIPTORS.find(one => one.operation === operation); }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export type SessionValidation = { ok: true; request: SessionRequest } | { ok: false; message: string };
export function validateSessionRequest(operation: string, value: unknown): SessionValidation {
  const spec = sessionDescriptor(operation);
  const bad = (message: string): SessionValidation => ({ ok: false, message });
  if (!spec) return bad('Choose a supported session operation.');
  if (!record(value)) return bad('The session request must be a JSON object.');
  for (const field of Object.keys(value)) if (!Object.hasOwn(spec.inputSchema.properties, field)) return bad(`Unknown session field: ${field}.`);
  for (const field of spec.inputSchema.required) if (!Object.hasOwn(value, field)) return bad(`Missing session field: ${field}.`);
  for (const [name, valueAtField] of Object.entries(value)) {
    const field = spec.inputSchema.properties[name]!;
    if (Array.isArray(field.type) && valueAtField === null) continue;
    if (field.type === 'integer') {
      if (!Number.isSafeInteger(valueAtField) || typeof valueAtField !== 'number' || (field.minimum !== undefined && valueAtField < field.minimum) || (field.maximum !== undefined && valueAtField > field.maximum) || (field.const !== undefined && valueAtField !== field.const)) return bad(`Invalid ${name}.`);
    } else {
      if (typeof valueAtField !== 'string' || (field.nonblank && !valueAtField.trim()) || (field.minLength !== undefined && valueAtField.length < field.minLength) || (field.maxLength !== undefined && valueAtField.length > field.maxLength) || (field.maxBytes !== undefined && Buffer.byteLength(valueAtField) > field.maxBytes) || (field.pattern !== undefined && !new RegExp(field.pattern).test(valueAtField))) return bad(`Invalid ${name}.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > SESSION_REQUEST_BYTES) return bad('The session request is too large.');
  return { ok: true, request: value as SessionRequest };
}

/** Validate before claiming success. A broken response to a mutation is unknown
 * delivery, not proof that the owner rejected it. Additional fields are allowed. */
export function isSessionResponse(value: unknown, operation: SessionOperation): value is SessionResponse {
  if (!record(value) || value['version'] !== 1 || value['operation'] !== operation || typeof value['ok'] !== 'boolean' || typeof value['message'] !== 'string' || !Array.isArray(value['nextActions'])) return false;
  if (!['succeeded', 'pending', 'rejected', 'uncertain'].includes(String(value['status'])) || !['confirmed', 'not-sent', 'unknown'].includes(String(value['delivery'])) || !['safe-read', 'inspect-first', 'never'].includes(String(value['retry']))) return false;
  if ((value['ok'] === true) !== ['succeeded', 'pending'].includes(String(value['status']))) return false;
  if (value['status'] === 'uncertain' && (value['delivery'] !== 'unknown' || value['retry'] !== 'inspect-first')) return false;
  if (value['status'] === 'rejected' && value['delivery'] !== 'not-sent') return false;
  if (value['ok'] === true && value['delivery'] !== 'confirmed') return false;
  if (value['reason'] !== undefined && (typeof value['reason'] !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value['reason']))) return false;
  for (const action of value['nextActions']) if (!record(action) || typeof action['label'] !== 'string' || ![...SESSION_OPERATIONS, 'open-ui'].includes(String(action['operation'])) || (action['sessionId'] !== undefined && typeof action['sessionId'] !== 'string')) return false;
  if (value['result'] === undefined) return value['ok'] === false;
  const result = value['result'];
  if (!record(result)) return false;
  const session = (item: unknown): boolean => record(item) && ['id', 'repo', 'title', 'status'].every(key => typeof item[key] === 'string') && (typeof item['nativeThreadId'] === 'string' || item['nativeThreadId'] === null) && (typeof item['turnId'] === 'string' || item['turnId'] === null) && Number.isSafeInteger(item['revision']) && Number(item['revision']) >= 0;
  if (result['session'] !== undefined && !session(result['session'])) return false;
  if (result['sessions'] !== undefined && (!Array.isArray(result['sessions']) || !result['sessions'].every(session))) return false;
  if (value['ok'] === true && (operation === 'list' ? !Array.isArray(result['sessions']) : !session(result['session']))) return false;
  if (result['changes'] !== undefined) {
    const changes = result['changes'];
    if (!record(changes) || !['head', 'status', 'diff'].every(key => typeof changes[key] === 'string') || typeof changes['truncated'] !== 'boolean') return false;
  }
  if (value['ok'] === true && operation === 'changes' && result['changes'] === undefined) return false;
  if (result['items'] !== undefined && (!Array.isArray(result['items']) || !result['items'].every(item => record(item) && ['id', 'type', 'text'].every(key => typeof item[key] === 'string') && (item['status'] === null || typeof item['status'] === 'string')))) return false;
  if (result['requests'] !== undefined && (!Array.isArray(result['requests']) || !result['requests'].every(item => record(item) && ['id', 'kind', 'title', 'detail'].every(key => typeof item[key] === 'string')))) return false;
  if (result['receipt'] !== undefined && (!record(result['receipt']) || typeof result['receipt']['key'] !== 'string' || typeof result['receipt']['status'] !== 'string')) return false;
  if (result['truncated'] !== undefined && typeof result['truncated'] !== 'boolean') return false;
  if (result['brief'] !== undefined && (!record(result['brief']) || typeof result['brief']['summary'] !== 'string' || typeof result['brief']['nextAction'] !== 'string' || !Number.isSafeInteger(result['brief']['sourceRevision']))) return false;
  return true;
}

export function sessionCapabilities() {
  return { version: SESSION_PROTOCOL_VERSION, transport: 'POST /api/cli with argv session <operation> (the prompt travels as the request\'s one file)', authentication: 'API token: Authorization Bearer so_… (toolroll tokens create, saved by toolroll connect)',
    authority: 'An instance operator\'s API token without a project limit reads sessions; changing one needs an act token. Lead and coordinator credentials have no session access.',
    operations: SESSION_DESCRIPTORS, brief: { supported: true, operation: 'show', defaultView: 'brief', source: 'Saved state and labeled agent reports, pinned to a revision; no additional model call.' },
    unsupported: ['events', 'review', 'continue'], limits: { promptBytes: SESSION_PROMPT_BYTES, requestBytes: SESSION_REQUEST_BYTES, responseBytes: SESSION_RESPONSE_BYTES },
    retry: 'Never automatically retry a mutation. Inspect saved state after a lost response; keep the original key.' };
}
