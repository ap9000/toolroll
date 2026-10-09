import { describe, expect, test, vi } from 'vitest';
import { adapterPolicy, evaluateRoutePolicy, withEdgePolicy } from './route-policy.js';
import { assertRouteTable, ROUTES, matchRoute, type Caller } from './route-table.js';

const callers: Caller[] = ['anonymous', 'cookie', 'bearer', 'oauth', 'coordinator', 'lead', 'service'];

// Admission contracts recorded before Wave D (73e5797f / v0.9.51). These expectations do not read ROUTES.
// Former family ids split into individual handlers with the same caller/scope contract; roles are proved over HTTP.
const READ_BROWSER = ['cookie:read', 'cookie:act', 'bearer:read', 'bearer:act'];
const ACT_BROWSER = ['cookie:act', 'bearer:act'];
const STEP_UP = ['cookie:act'];
const BEFORE: [string, string, string, string[]][] = [
  ['GET', '/healthz', 'none', ['anonymous:none', 'anonymous:read', 'anonymous:act']],
  ['POST', '/mcp', 'adapter', ['bearer:read', 'bearer:act', 'oauth:read', 'oauth:act', 'coordinator:read', 'coordinator:act']],
  ['GET', '/api/team', 'adapter', READ_BROWSER],
  ['POST', '/api/team', 'adapter', READ_BROWSER], // Each operation separately requires read or act.
  ['GET', '/tasks', 'session', READ_BROWSER],
  ['GET', '/t/one', 'task', READ_BROWSER],
  ['POST', '/tasks/add', 'form', ACT_BROWSER],
  ['POST', '/d/1/answer', 'decision', ACT_BROWSER],
  ['POST', '/projects/select', 'form-path', ACT_BROWSER],
  ['POST', '/settings/policy', 'session', STEP_UP],
  ['POST', '/people/invite', 'session', STEP_UP],
  ['POST', '/code/start', 'coding', STEP_UP],
  ['POST', '/flows/1/save', 'flow', ACT_BROWSER],
  ['POST', '/r/1/revise', 'run', ACT_BROWSER],
  ['POST', '/chat/proposal/1/confirm', 'proposal', ACT_BROWSER],
];

test('pre-refactor caller and scope contracts remain independent of the route declarations', () => {
  for (const [method, path, project, accepted] of BEFORE) {
    const route = matchRoute(method, path)!;
    expect(route, path).not.toBeNull();
    expect(route.project, path).toBe(project);
    for (const caller of callers) for (const capability of ['none', 'read', 'act'] as const) {
      expect(evaluateRoutePolicy(route, { caller, capability }, () => true).ok, `${method} ${path} ${caller}:${capability}`)
        .toBe(accepted.includes(`${caller}:${capability}`));
    }
  }
});

test('reviewed live transport delta replaces four streams with room-owned admission', () => {
  // Wave D explicitly retires these addresses; team tokens retain adapter-owned project admission at /live.
  for (const path of ['/chat/stream', '/t/one/live', '/flows/1/live', '/api/team/events']) expect(matchRoute('GET', path), path).toBeNull();
  const live = matchRoute('GET', '/live')!;
  expect(live).toMatchObject({ stage: 'edge', proof: 'adapter', project: 'adapter', callers: ['cookie', 'bearer'], scope: 'read' });
  for (const caller of callers) for (const capability of ['none', 'read', 'act'] as const) {
    expect(evaluateRoutePolicy(live, { caller, capability }, () => true).ok, `${caller}:${capability}`)
      .toBe(READ_BROWSER.includes(`${caller}:${capability}`));
  }
  // The viewer preference remains cookie-only even though project selection still admits an act bearer.
  const selection = matchRoute('POST', '/projects/select')!;
  expect(evaluateRoutePolicy(selection, { caller: 'cookie', capability: 'read', viewer: true }, () => true)).toEqual({ ok: true });
  expect(evaluateRoutePolicy(selection, { caller: 'bearer', capability: 'read', viewer: true }, () => true).ok).toBe(false);
});

describe('shared route policy', () => {
  test('every row enforces caller, scope and the declared project resolver', () => {
    for (const route of ROUTES) for (const caller of callers) for (const capability of ['none', 'read', 'act'] as const) {
      const resolve = vi.fn(() => true);
      const callerAllowed = route.callers.includes(caller) && (route.scope !== 'step-up' || caller === 'cookie');
      const scopeAllowed = route.scope === 'none' || capability === 'act' || route.scope === 'read' && capability === 'read';
      const result = evaluateRoutePolicy(route, { caller, capability }, resolve);
      expect(result, `${route.id}:${caller}:${capability}`).toEqual(callerAllowed && scopeAllowed ? { ok: true } : { ok: false, status: 403, reason: callerAllowed ? 'scope' : 'caller' });
      if (result.ok) {
        expect(resolve).toHaveBeenCalledExactlyOnceWith(route.project);
        expect(evaluateRoutePolicy(route, { caller, capability }, () => false)).toEqual({ ok: false, status: 403, reason: 'project' });
      } else expect(resolve).not.toHaveBeenCalled();
    }
  });

  test('every password step-up admits cookies only; bearer can never use a viewer exception', () => {
    for (const row of ROUTES.filter(row => row.scope === 'step-up')) expect(row.callers, row.id).toEqual(['cookie']);
    const stepUp = ROUTES.find(row => row.scope === 'step-up')!;
    expect(() => assertRouteTable([{ ...stepUp, callers: ['cookie', 'bearer'] }])).toThrow(/step-up must be cookie-only/);
    for (const row of ROUTES.filter(row => row.viewer)) {
      expect(evaluateRoutePolicy(row, { caller: 'cookie', capability: 'read', viewer: true }, () => true)).toEqual({ ok: true });
      expect(evaluateRoutePolicy(row, { caller: 'bearer', capability: 'read', viewer: true, token: true }, () => true).ok).toBe(false);
      expect(evaluateRoutePolicy(row, { caller: 'bearer', capability: 'read', viewer: true }, () => true).ok).toBe(false);
    }
  });

  test('multiplexed operations can tighten, never weaken the matched route; async requests stay isolated', async () => {
    const mcp = ROUTES.find(row => row.id === 'edge.mcp')!;
    await Promise.all(['oauth', 'bearer'].map(async caller => withEdgePolicy({ ...mcp, callers: [caller as Caller] }, async () => {
      expect(adapterPolicy({ caller: caller as Caller, capability: 'read' }).ok).toBe(true);
      await Promise.resolve();
      expect(adapterPolicy({ caller: 'bearer', capability: 'read' }, 'act')).toEqual({ ok: false, status: 403, reason: 'scope' });
      expect(adapterPolicy({ caller: 'bearer', capability: 'act' }, 'act').ok).toBe(true);
      expect(adapterPolicy({ caller: 'bearer', capability: 'act' }, 'read', () => false)).toEqual({ ok: false, status: 403, reason: 'project' });
    })));
    const act = ROUTES.find(row => row.id === 'tasks.add')!;
    expect(evaluateRoutePolicy(act, { caller: 'bearer', capability: 'read' }, () => true, 'read').ok).toBe(false);
  });
});
