import { expect, test, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSharedGuards, type GuardsRuntime } from './guards.js';
import { matchRoute, type ProjectResolver } from './route-table.js';
import { requestContext } from "./request-context.js";
import { type Who } from "./session.js";
import { authenticateApprover as checkPassword } from '../scope.js';

vi.mock('../scope.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../scope.js')>();
  return { ...actual, authenticateApprover: vi.fn(actual.authenticateApprover) };
});

function fixture(projects: string[] | null = null) {
  const store = {
    accountOf: () => ({ projects }), accountCanAccess: (_: string, repo: string | null) => projects === null || repo !== null && projects.includes(repo),
    lookupRef: vi.fn((id: string) => ({ repo: `/task/${id}` })),
    getRun: vi.fn((id: number) => ({ taskRef: id + 100 })), refForId: vi.fn((id: number) => ({ repo: `/run/${id}` })),
    getDecision: vi.fn((id: number) => ({ run: id + 10 })), openIncidents: () => [{ id: 7, run: 20 }],
    getFlow: vi.fn((id: number) => ({ repo: `/flow/${id}` })),
    knownRepos: () => ['/allowed'],
  };
  const runtime = { store, defaultProject: '/allowed', liveCeiling: () => ({ repos: ['/allowed'], roots: [] }), ceiling: { repos: ['/allowed'], roots: [] },
    unscopedMode: false, managedRepos: () => ['/allowed'], actionTarget: vi.fn(() => ({ repo: '/saved-owner-project' })) } as unknown as GuardsRuntime;
  const guards = createSharedGuards(runtime);
  const who = { via: 'cookie', role: 'approver', name: 'alice', session: { project: '/allowed' } } as Who;
  const request = { method: 'GET', headers: {} } as IncomingMessage;
  const response = { getHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse;
  return { store, runtime, guards, who, request, response };
}

test('the shared password helper refuses a bearer before checking its password', () => {
  const { guards, who, store } = fixture();
  // A successful password checker makes a missing caller guard observable, even for a valid approver password.
  const checked = vi.mocked(checkPassword).mockReturnValue({ ok: true });
  try {
    expect(guards.authenticateApprover(who, 'valid-password', '/allowed')).toEqual({ ok: true });
    expect(checked).toHaveBeenCalledExactlyOnceWith(store, 'alice', 'valid-password', '/allowed');
    checked.mockClear();
    const bearer: Who = { name: 'alice', via: 'bearer', role: 'approver', generation: 1,
      principal: { kind: 'person', account: 'alice', generation: 1, scope: 'act', projects: null } };
    expect(guards.authenticateApprover(bearer, 'valid-password', '/allowed')).toEqual({ ok: false, reason: 'not-an-approver' });
    expect(checked).not.toHaveBeenCalled();
  } finally { checked.mockReset(); }
});

test('project columns resolve saved resource identities, forms and session context', () => {
  const { guards, who, request, store } = fixture();
  const cases: [ProjectResolver, string, string | null][] = [
    ['none', '/', null], ['session', '/', '/allowed'], ['form', '/tasks/add', '/form'],
    ['form-path', '/projects/select', process.cwd()], ['task', '/t/a%2Fb/evidence', '/task/a/b'], ['run', '/r/7', '/run/107'],
    ['decision', '/d/7', '/run/117'], ['incident', '/i/7', '/run/120'],
    ['flow', '/flows/7/export', '/flow/7'],
    ['proposal', '/chat/action/7', '/saved-owner-project'], ['coding', '/code/session', '/saved-owner-project'], ['conversation', '/chat', '/allowed'],
  ];
  for (const [source, path, expected] of cases) expect(guards.resolveRouteProject(source, new URL(path, 'http://local'), who, request, new URLSearchParams({ repo: '/form', path: process.cwd() })), source).toBe(expected);
  expect(store.lookupRef).toHaveBeenCalledWith('a/b');
  expect(guards.resolveRouteProject('form-path', new URL('http://local/'), who, request, new URLSearchParams('path='))).toBeNull();
  expect(guards.resolveRouteProject('form', new URL('http://local/'), who, request, new URLSearchParams())).toBe('/allowed');
  expect(() => guards.resolveRouteProject('adapter', new URL('http://local/'), who, request, null)).toThrow(/cannot delegate/);
});

test('the shared gate checks the resolved resource against instance and account project limits', () => {
  for (const projects of [null, ['/allowed']]) {
    const { guards, who, request, response } = fixture(projects);
    const check = () => {
      for (const [method, path] of [['GET', '/t/other'], ['GET', '/r/7'], ['GET', '/d/7'], ['GET', '/flows/7/export'], ['POST', '/tasks/add']]) {
        const row = matchRoute(method!, path!)!;
        expect(guards.projectRequestAllowed(row, row.project, new URL(path!, 'http://local'), who, request, response, new URLSearchParams({ repo: '/outside' })), row.id).toBe(false);
      }
    };
    requestContext.run({ actor: 'alice', csrf: '', returnTo: '/' }, check);
  }
});

test('limited-project rules reject instance areas and preserve unscoped collections', () => {
  const { guards, who, request, response } = fixture(['/allowed']);
  requestContext.run({ actor: 'alice', csrf: '', returnTo: '/' }, () => {
    for (const [path, allowed] of [['/settings/policy', false], ['/projects', true], ['/tasks', true]] as const) {
      const row = matchRoute('GET', path)!;
      expect(guards.projectRequestAllowed(row, row.project, new URL(path, 'http://local'), who, request, response, null), path).toBe(allowed);
    }
    const row = matchRoute('POST', '/projects/select')!;
    expect(guards.projectRequestAllowed(row, row.project, new URL('http://local/projects/select'), who, request, response, new URLSearchParams({ path: process.cwd() }))).toBe(false);
    expect(guards.projectRequestAllowed(row, row.project, new URL('http://local/projects/select'), who, request, response, new URLSearchParams('repo=/allowed&repo=/outside'))).toBe(false);
  });
});

test.each(['/allowed', null, '/removed'])('unrestricted cookies recover when their open project leaves the ceiling (default %s)', defaultProject => {
  const { runtime, guards, who, request, response } = fixture();
  let repos = ['/allowed', '/removed'];
  runtime.liveCeiling = () => ({ repos, roots: [] });
  runtime.defaultProject = defaultProject;
  if (who.via !== 'cookie') throw Error('expected cookie fixture');
  who.session.project = '/removed';
  requestContext.run({ actor: 'alice', csrf: '', returnTo: '/' }, () => {
    expect(guards.projectOf(who, request)).toBe('/removed');
    repos = ['/allowed'];
    const fallback = defaultProject === '/allowed' ? '/allowed' : null;
    expect(guards.projectOf(who, request)).toBe(fallback);
    for (const path of ['/', '/projects', '/chat', '/work', '/settings/models', '/board']) {
      const row = matchRoute('GET', path)!;
      expect(guards.projectRequestAllowed(row, row.project, new URL(path, 'http://local'), who, request, response, null), path).toBe(true);
    }
    expect(response.writeHead).not.toHaveBeenCalled();
    who.session.project = null;
    expect(guards.projectOf(who, request)).toBeNull();
    who.session.project = '/allowed';
    expect(guards.projectOf(who, request)).toBe('/allowed');
  });
});

test.each([null, ['/allowed']])('stale cookie recovery preserves explicit project and resource refusals (account projects %s)', projects => {
  const { runtime, store, guards, who, request, response } = fixture(projects);
  if (who.via !== 'cookie') throw Error('expected cookie fixture');
  who.session.project = '/removed';
  // /outside is served, but unavailable to the limited account; /removed left the ceiling for everyone.
  runtime.liveCeiling = () => ({ repos: ['/allowed', '/outside'], roots: [] });
  const outside = projects === null ? '/removed' : '/outside';
  store.getFlow.mockReturnValue({ repo: outside });
  requestContext.run({ actor: 'alice', csrf: '', returnTo: '/' }, () => {
    expect(guards.projectOf(who, request)).toBe('/allowed');
    for (const [method, path, body, status] of [
      ['GET', '/flows/7/export', null, 404],
      ['POST', '/tasks/add', new URLSearchParams({ repo: outside }), 403],
      ['POST', '/projects/select', new URLSearchParams({ path: process.cwd() }), 403],
    ] as const) {
      response.writeHead = vi.fn();
      request.method = method;
      const row = matchRoute(method, path)!;
      expect(guards.projectRequestAllowed(row, row.project, new URL(path, 'http://local'), who, request, response, body), path).toBe(false);
      expect(response.writeHead).toHaveBeenCalledWith(status, expect.anything());
    }
  });
});
