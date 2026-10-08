import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployStateDir, loadNames, stagedPackageName, stagedRuntimePaths } from '../scripts/deploy-paths.mjs';
import * as names from './names.js';

const roots: string[] = [];
const root = () => { const made = mkdtempSync(join(tmpdir(), 'toolroll-deploy-paths-')); roots.push(made); return made; };
afterEach(() => { for (const one of roots.splice(0)) rmSync(one, { recursive: true, force: true }); });

test('deploy-browser takes the state folder that holds orders.db, as the plane does', async () => {
  const built = await loadNames(resolve('dist'));
  const home = root(), config = join(home, '.config');
  // A fresh machine: the new name.
  expect(deployStateDir(built, {}, home)).toBe(join(config, 'toolroll'));
  // An empty new-name folder beside an older one holding the database: the database wins.
  mkdirSync(join(config, 'toolroll'), { recursive: true });
  mkdirSync(join(config, 'standing-orders'), { recursive: true });
  mkdirSync(join(config, 'nightorders'), { recursive: true });
  writeFileSync(join(config, 'nightorders', 'orders.db'), '');
  expect(deployStateDir(built, {}, home)).toBe(join(config, 'nightorders'));
  writeFileSync(join(config, 'standing-orders', 'orders.db'), '');
  expect(deployStateDir(built, {}, home)).toBe(join(config, 'standing-orders'));
  expect(deployStateDir(built, {}, home)).toBe(names.namedFolder(config));
  // No database anywhere: the first folder that exists.
  rmSync(join(config, 'standing-orders', 'orders.db'));
  rmSync(join(config, 'nightorders', 'orders.db'));
  expect(deployStateDir(built, {}, home)).toBe(join(config, 'toolroll'));
  // $XDG_CONFIG_HOME is the base when set, as for the plane's own database.
  const xdg = root();
  mkdirSync(join(xdg, 'standing-orders'));
  writeFileSync(join(xdg, 'standing-orders', 'orders.db'), '');
  expect(deployStateDir(built, { XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, 'standing-orders'));
});

test('a deploy staged before the rename resumes at its older runtime path; a fresh stage uses the new one', () => {
  const stage = root();
  expect(stagedPackageName(stage, 'toolroll', names)).toBe('toolroll');
  mkdirSync(join(stage, 'runtime', 'node_modules', 'standing-orders'), { recursive: true });
  writeFileSync(join(stage, 'runtime', 'node_modules', 'standing-orders', 'package.json'), '{}');
  expect(stagedPackageName(stage, 'toolroll', names)).toBe('standing-orders');
  mkdirSync(join(stage, 'runtime', 'node_modules', 'toolroll'), { recursive: true });
  writeFileSync(join(stage, 'runtime', 'node_modules', 'toolroll', 'package.json'), '{}');
  expect(stagedPackageName(stage, 'toolroll', names)).toBe('toolroll');
});

test('the staged runtime paths deploy-browser uses follow the staged package name', () => {
  const stage = root(), modules = join(stage, 'runtime', 'node_modules');
  expect(stagedRuntimePaths(stage, 'toolroll', names)).toEqual({ name: 'toolroll', runtime: join(stage, 'runtime'), self: join(modules, 'toolroll'), dist: join(modules, 'toolroll', 'dist') });
  mkdirSync(join(modules, 'standing-orders'), { recursive: true });
  writeFileSync(join(modules, 'standing-orders', 'package.json'), '{}');
  expect(stagedRuntimePaths(stage, 'toolroll', names)).toMatchObject({ name: 'standing-orders', self: join(modules, 'standing-orders'), dist: join(modules, 'standing-orders', 'dist') });
});
