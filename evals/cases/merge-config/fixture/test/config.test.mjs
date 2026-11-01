import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../config.js';

test('two empty objects', () => assert.deepEqual(mergeConfig({}, {}), {}));
