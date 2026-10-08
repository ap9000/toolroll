import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { adapterPolicy, evaluateRoutePolicy, withEdgePolicy } from './route-policy.js';
import { assertRouteTable, ROUTES, type Caller, type RouteDeclaration } from './route-table.js';

const callers: Caller[] = ['anonymous', 'cookie', 'bearer', 'oauth', 'coordinator', 'lead', 'service'];
const before: RouteDeclaration[] = JSON.parse(readFileSync(new URL('./fixtures/route-policy-before.json', import.meta.url), 'utf8'));
const corrections = JSON.parse(readFileSync(new URL('./fixtures/route-policy-corrections.json', import.meta.url), 'utf8'));

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

  test('all legacy console policies remain exact except the reviewed browser/password corrections and token-domain move', () => {
    const covered = new Set<string>();
    const changed = new Set<string>();
    for (const row of ROUTES.filter(row => row.stage === 'console')) {
      const old = before.find(old => old.stage === row.stage && old.method === row.method && new RegExp(old.pattern).test(row.sample));
      expect(old, row.id).toBeDefined();
      covered.add(old!.id);
      const { id: _id, pattern: _pattern, sample: _sample, ...policy } = old!;
      const { id: _newId, pattern: _newPattern, sample: _newSample, host, proof, ...now } = row;
      expect({ host, proof }).toEqual({ host: 'after', proof: 'console' });
      expect(now, row.id).toEqual({ ...policy, ...corrections[row.id] });
      if (corrections[row.id]) changed.add(row.id);
    }
    expect([...covered].sort()).toEqual(before.filter(row => row.stage === 'console').map(row => row.id).sort());
    expect([...changed].sort()).toEqual(Object.keys(corrections).sort());
    // The two onboarding rows name a future GitHub clone, not an existing local project. No limited/viewer/opener rule changes.
    for (const correction of Object.values(corrections) as Record<string, unknown>[]) expect(Object.keys(correction).every(key => ['scope', 'callers', 'domain', 'project', 'scopeRefusal'].includes(key))).toBe(true);
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
