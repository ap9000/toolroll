import { describe, expect, test } from 'vitest';
import { browserCrewFromIndex } from './browser-crew.js';
import type { WorkIndexItem, WorkIndexPage } from './work-index.js';

const row = (label: string, detail: string): WorkIndexItem => ({
  rootId: 'payouts', activeTaskId: 'payouts', title: 'Fix payout rounding', repo: '/projects/payments',
  state: 'queued', assignmentState: 'queued', createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z',
  versionCount: 1, earlierActiveCount: 0, familyProblem: null, liveRunId: null, unfinishedRunId: null,
  resultRunId: null, resultTaskId: null, resultOutcome: null, publicationUrl: null,
  status: { label, detail, token: 'assignment-queued', tone: 'neutral', action: null, views: ['all'], rank: 0 },
  ask: null, chip: null, primaryAction: null, completion: null, evidence: 'recorded',
});
const page = (items: WorkIndexItem[]): WorkIndexPage => ({
  items, totals: { all: items.length, 'needs-you': 0, running: 0, completed: 0 },
  groups: { decide: 0, review: 0, unblock: 0, building: 0, rest: items.length },
  projects: [], nextCursor: null, limit: 40, view: 'all',
});
const crew = (label: string, detail: string) => browserCrewFromIndex(page([row(label, detail)])).crew[0]!;

describe('Crew reasons from the confirmed status', () => {
  test.each([
    ['Waiting', 'Waiting for the export task to finish.'],
    ['Failed', 'The last attempt stopped: the build command failed.'],
    ['Needs you', 'Review the current plan before a worker can start.'],
  ])('%s keeps the exact status detail, regardless of the underlying assignment state', (label, detail) => {
    expect(crew(label, detail)).toMatchObject({ label, detail, state: 'queued' });
  });

  test.each([
    ['Waiting', 'Waiting'], ['Waiting', ' waiting.  '], ['Needs you', ' NEEDS\n YOU! '],
    ['Failed', 'FAILED?'], ['Failed', '   '], ['Waiting', ''],
    ['Building', 'Waiting for a tool.'], ['Queued', 'Waiting for a worker.'],
    ['Planning', 'Writing a plan.'], ['Ready for review', 'Review the result.'],
    ['Complete', 'Completed by Sam.'], ['Stopped', 'Paused by Sam.'],
  ])('%s omits empty, repeated or inapplicable detail: %j', (label, detail) => {
    expect(crew(label, detail).detail).toBeUndefined();
  });

  test('two Waiting rows keep different reasons and a fresh snapshot removes the old reason', () => {
    const first = row('Waiting', 'Waiting for another task.');
    const second = { ...row('Waiting', 'Waiting for a worker to become free.'), rootId: 'exports' };
    expect(browserCrewFromIndex(page([first, second])).crew.map(one => one.detail)).toEqual([first.status.detail, second.status.detail]);
    expect(browserCrewFromIndex(page([{ ...first, status: { ...first.status, label: 'Building', detail: 'The build has started.' } }])).crew[0]?.detail).toBeUndefined();
  });
});
