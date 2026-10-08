import { describe, expect, test, vi } from 'vitest';
import { adapterPolicy, evaluateRoutePolicy, withEdgePolicy } from './route-policy.js';
import { assertRouteTable, ROUTES, type Caller } from './route-table.js';

const callers: Caller[] = ['anonymous', 'cookie', 'bearer', 'oauth', 'coordinator', 'lead', 'service'];

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
