import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupe } from '../dedupe.js';

test('an empty list', () => assert.deepEqual(dedupe([]), []));
