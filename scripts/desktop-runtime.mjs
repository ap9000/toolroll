import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** What the server needs beside dist/: version metadata, the exact lockfile, and its licenses. */
const RUNTIME_FILES = ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];

/**
 * Make Resources a self-contained server: dist, its package metadata and
 * licenses, and the lockfile's production dependencies. Node resolves bare
 * imports by walking up from dist/, so without its own node_modules the app
 * only works while it happens to sit inside a developer checkout.
 */
export function stageServerRuntime(root, resources) {
  cpSync(join(root, 'dist'), join(resources, 'dist'), { recursive: true });
  for (const name of RUNTIME_FILES) cpSync(join(root, name), join(resources, name));
  // Exact lockfile versions, no dev tools, no install scripts or bin links:
  // nothing executes during packaging and no symlinks enter the signed bundle.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: resources, stdio: 'inherit' });
}

/** The first node_modules above `path`, which would mask a missing bundled dependency. */
function inheritedModules(path) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules');
    if (dirname(dir) === dir) return undefined;
  }
}

const PROBE = `import { PACKAGE_VERSION } from './version.js';
const missing = [];
for (const name of JSON.parse(process.argv[2])) {
  try { import.meta.resolve(name); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') missing.push(name); }
}
console.log(JSON.stringify({ version: PACKAGE_VERSION, missing }));
`;

/** The thrown error's own line (e.g. Cannot find package 'zod'), not its stack. */
const failureReason = result => {
  const lines = (result.stderr || result.stdout || String(result.error ?? '')).trim().split('\n');
  return lines.find(line => /^(Error \[|\w*Error\b)/.test(line)) ?? lines.slice(-6).join('\n');
};
const readReport = result => { try { return JSON.parse(result.stdout); } catch { return undefined; } };

/**
 * Launch a copy of the server runtime where nothing outside it can satisfy an
 * import: the shell's first command, the reported version, and every declared
 * dependency. Throws on a missing module or a version other than `version`.
 */
export function verifyServerRuntime(resources, node, version) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-runtime-check-')));
  try {
    const copy = join(sandbox, 'Resources'), state = join(sandbox, 'state'), home = join(sandbox, 'home');
    const outside = inheritedModules(copy);
    if (outside) throw Error(`The runtime check cannot run in isolation: ${outside} would satisfy missing imports.`);
    cpSync(resources, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    mkdirSync(state); mkdirSync(home);
    const run = args => spawnSync(node, args, { cwd: sandbox, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: sandbox } });

    // The shell's first call on every launch, against disposable state.
    const launch = run([join(copy, 'dist', 'desktop-host.js'), 'update-status', '--state', state]);
    if (launch.status !== 0 || readReport(launch) === undefined) throw Error(`The packaged server could not start from the app bundle.\n${failureReason(launch)}`);

    const probe = join(copy, 'dist', 'runtime-check.mjs');
    writeFileSync(probe, PROBE);
    const manifest = join(copy, 'package.json');
    const dependencies = existsSync(manifest) ? Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}) : [];
    const checked = run([probe, JSON.stringify(dependencies)]);
    const report = readReport(checked);
    if (checked.status !== 0 || report === undefined) throw Error(`The packaged server could not report its version.\n${failureReason(checked)}`);
    if (report.missing.length > 0) throw Error(`The packaged server is missing dependencies: ${report.missing.join(', ')}.`);
    if (report.version !== version) throw Error(`The packaged server reports version ${report.version}, not ${version}.`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
