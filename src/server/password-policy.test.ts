import { expect, test } from 'vitest';
import { matchRoute } from './route-table.js';

/** Every address that asks for the operator's password, kept by hand and independently of the route table, so a row
 * quietly downgraded from step-up (and so open to bearers) fails here. serve.bearer-scope.test.ts proves over HTTP that
 * every step-up row refuses password, API and OAuth bearers. */
const PASSWORD_CEREMONIES = [
  '/routines/1/run-now', '/routines/1/approve', '/code/start', `/code/${'a'.repeat(32)}/answer`,
  '/flows/1/triggers/1/secret', '/flows/1/linear-key', '/spend/budget', '/settings/project/delete',
  '/settings/policy', '/settings/approval', '/settings/request-limits', '/settings/sessions', '/settings/sign-in',
  '/settings/updates', '/settings/retention', '/settings/storage', '/settings/storage/clean', '/settings/storage/discard',
  '/settings/pull-requests', '/settings/checks', '/settings/backups', '/settings/data', '/settings/monitoring',
  '/settings/tools/connect', '/settings/tools/change', '/settings/slack/connect', '/settings/teams/connect', '/settings/discord/connect',
  '/settings/chat-approval/confirm', '/settings/chat-approval/save',
  '/control/instructions-approve', '/control/setup-approve', '/fleet/runner/register', '/fleet/runner/retire',
  '/mode/sign', '/mode/confirm', '/people/projects', '/people/invite', '/people/invite-revoke', '/people/revoke',
  '/contest/1/pick', '/contest/1/abandon', '/projects/onboard-confirm', '/push/subscribe',
  '/chat/config', '/chat', `/chat/file/${'a'.repeat(32)}`, '/chat/ack/1',
  '/t/guarded/confirm-stopped', '/t/guarded/attend', '/t/guarded/reopen', '/t/guarded/accept-revision', '/t/guarded/resume', '/t/guarded/approve',
];

test('every password ceremony has a cookie-only step-up declaration', () => {
  expect(new Set(PASSWORD_CEREMONIES).size).toBe(PASSWORD_CEREMONIES.length);
  for (const path of PASSWORD_CEREMONIES) {
    const row = matchRoute('POST', path);
    expect(row?.callers, path).toEqual(['cookie']);
    // The first chat-approval panel only presents terms; save performs its password check.
    if (path !== '/settings/chat-approval/confirm') expect(row?.scope, path).toBe('step-up');
  }
});
