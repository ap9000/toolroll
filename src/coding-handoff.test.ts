import { describe, expect, test } from 'vitest';
import { parseReceipt, sealPayload } from './coding-handoff.js';
import { learningSha } from './project-learning.js';
import { savedHandoff } from '../test/coding-fixtures.js';

describe('a saved coding handoff receipt', () => {
  const row = savedHandoff.handoff;
  const resealed = (payload: string) => ({ ...row, payload, sha: learningSha(payload) });

  test('reads exactly as saved, and its seal matches byte for byte', () => {
    const receipt = parseReceipt(row);
    expect(JSON.stringify(receipt)).toBe(row.payload);
    expect(receipt.taskId).toBe(`coding-review-${row.id}`);
    const seal = sealPayload(receipt, savedHandoff.scopeDigest);
    expect(seal).toBe(savedHandoff.scope.payload);
    expect(learningSha(seal)).toBe(savedHandoff.scope.sha);
  });

  test('checks the saved hash before reading, and the derived identity after', () => {
    expect(() => parseReceipt({ ...row, sha: '0'.repeat(64) })).toThrow('The coding handoff receipt could not be verified.');
    const terms = JSON.parse(row.payload) as Record<string, unknown>;
    expect(() => parseReceipt(resealed(JSON.stringify({ ...terms, goal: 'A different goal.' })))).toThrow('The coding handoff receipt identity could not be verified.');
    expect(() => parseReceipt({ ...resealed(row.payload), id: 'f'.repeat(32) })).toThrow('The coding handoff receipt identity could not be verified.');
  });

  test('refuses a malformed or newer receipt by path', () => {
    const terms = JSON.parse(row.payload) as Record<string, unknown>;
    expect(() => parseReceipt(resealed(JSON.stringify({ ...terms, version: 2 })))).toThrow('The coding handoff receipt could not be read: version: made by a newer Toolroll');
    expect(() => parseReceipt(resealed(JSON.stringify({ ...terms, changedPaths: 'mobile.md' })))).toThrow('changedPaths: must be an array');
  });
});
