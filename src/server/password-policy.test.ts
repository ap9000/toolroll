import { expect, test } from 'vitest';
import { matchRoute, ROUTES } from './route-table.js';

// Independent of both ROUTES and the password list: eight browser-only actions do not ask for a password.
const COOKIE_ONLY_POSTS = [
  'edge.oauth-consent', 'session.attended-beats', 'code.act', 'flow.instance-act', 'flow.trigger.secret',
  'spend.budget', 'settings.project-delete', 'settings.policy-send', 'settings.approval-send',
  'settings.request-limits-send', 'settings.sessions-send', 'settings.sign-in-send', 'settings.updates-send',
  'settings.updates-seen-send', 'settings.updates-cancel-send', 'settings.retention-send',
  'settings.storage-send', 'settings.storage-clean-send', 'settings.storage-discard-send',
  'settings.pull-requests-send', 'settings.checks-send', 'settings.backups-send', 'settings.data-send',
  'settings.monitoring-send', 'settings.tools-connect-send', 'settings.tools-change-send',
  'control.setup-approve', 'control.instructions-approve', 'settings.slack-send', 'settings.teams-send',
  'settings.discord-send', 'settings.telegram-retry', 'settings.chat-approval-confirm',
  'settings.chat-approval-save', 'settings.chat-approval-off', 'settings.telegram-pair', 'settings.telegram-unpair',
  'fleet.register', 'mode.confirm', 'mode.sign', 'people.projects', 'people.invite', 'people.invite-revoke',
  'people.revoke', 'fleet.retire', 'contest.act.pick', 'contest.act.abandon',
  'task.attend.attend-preview', 'task.attend.attend', 'task.attend.attend-revoke',
  'task.act.approve', 'task.act.reopen', 'task.act.accept-revision', 'task.act.reject-revision',
  'task.act.confirm-stopped', 'task.act.resume', 'projects.onboard-confirm', 'push.subscribe',
  'chat.config', 'chat.mate-mint', 'chat.mate-follow', 'chat.mate-end', 'chat.mate-stop',
  'chat.send', 'chat.file', 'chat.ack-send', 'routine.act.approve', 'routine.act.run-now',
];

test('cookie-only POST routes match the independent browser-only list exactly', () => {
  expect(ROUTES.filter(row => row.method === 'POST' && row.callers.length === 1 && row.callers[0] === 'cookie')
    .map(row => row.id).sort()).toEqual([...COOKIE_ONLY_POSTS].sort());
});

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
