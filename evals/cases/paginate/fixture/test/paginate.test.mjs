import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../paginate.js';

test('a page from the middle', () => assert.deepEqual(paginate([1, 2, 3, 4], 1, 2), [2, 3]));
