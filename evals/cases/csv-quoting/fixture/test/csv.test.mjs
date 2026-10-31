import test from 'node:test';
import assert from 'node:assert/strict';
import { csv } from '../csv.js';

test('no rows', () => assert.equal(csv([]), ''));
