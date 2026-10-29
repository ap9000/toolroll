/** Committed image inventory, never claimed checks, completion, or approval. */
import { execFileSync } from 'node:child_process';
import { noLazyFetch, partialCloneRefusal } from './teardown-git.js';
import { createHash } from 'node:crypto';
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageDimensions, looksLikeProtocolFile, readMailbox, SCREENSHOT_BYTE_CAP, validateScreenshotBytes } from './evidence.js';
import { parseProof, PROOF_LIMITS, SCREENSHOT_EVIDENCE_MIN_BYTES, SCREENSHOT_EVIDENCE_MIN_HEIGHT, SCREENSHOT_EVIDENCE_MIN_WIDTH, serializeProof, type ParsedProof } from './proof.js';

export const PREPARED_EVIDENCE_FILE = 'standing-orders.evidence.json';
/** Read flags: --no-lazy-fetch where git has it; a partial clone is refused where it doesn't (teardown-git.ts). */
export const preparedEvidenceGit = (): string[] => ['--literal-pathspecs', ...noLazyFetch(), '-c', 'protocol.allow=never', '--no-replace-objects', '--no-optional-locks'];
const nextAction = 'Ask Codex to prepare review screenshots and commit them with standing-orders.evidence.json, then review the new result.';
const fail = (detail: string): never => { throw Error(`Review screenshots are not ready. ${nextAction} ${detail}`); };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type PreparedEvidence = { proof: ParsedProof; files: { path: string; sha256: string; cap: number }[] };

/** Reads immutable Git objects; local/untracked files cannot fill a missing entry. */
export function readPreparedEvidence(repo: string, candidate: string, required = false): PreparedEvidence | null {
  if (!/^[a-f0-9]{40}$/.test(candidate)) fail('The saved commit is invalid.');
  const partial = partialCloneRefusal(repo);
  if (partial !== null) fail(`The committed screenshot inventory could not be read: ${partial}.`);
  const git = (args: string[], cap: number): Buffer => {
    try { return execFileSync('git', [...preparedEvidenceGit(), '-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: cap }); }
    catch { return fail('The committed screenshot inventory could not be read.'); }
  };
  const blob = (path: string, cap: number): Buffer | null => {
    const entries = git(['ls-tree', '-z', '-l', candidate, '--', path], 2048).toString('utf8').split('\0').filter(Boolean);
    if (!entries.length) return null;
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([\s\S]+)$/.exec(entries[0]!);
    if (entries.length !== 1 || !match || match[4] !== path) fail(`${path} must be a committed regular file.`);
    const size = Number(match![3]);
    if (!Number.isSafeInteger(size) || size > cap) fail(`${path} exceeds the supported evidence size.`);
    const bytes = git(['cat-file', 'blob', match![2]!], cap);
    if (bytes.length !== size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== match![2]) fail(`${path} could not be read completely or its Git identity changed.`);
    return bytes;
  };
  const raw = blob(PREPARED_EVIDENCE_FILE, PROOF_LIMITS.payload);
  if (raw === null) { if (required) fail('No committed screenshot inventory was found.'); return null; }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
  catch { return fail('The screenshot inventory must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['version', 'screenshots'].includes(key)) ||
      !Array.isArray(body['screenshots']) || body['screenshots'].some(shot => !shot || typeof shot !== 'object' || Array.isArray(shot) || Object.keys(shot).some(key => !['path', 'caption'].includes(key)))) {
    fail('The inventory may contain only version 1 and screenshots with path and caption.');
  }
  const parsed = parseProof(raw.toString('utf8'));
  if (!parsed.ok) return fail(parsed.problems.map(problem => problem.message).join('; '));
  if (required && parsed.proof.screenshots.length === 0) fail('The committed inventory has no screenshots.');
  const files = [{ path: PREPARED_EVIDENCE_FILE, sha256: digest(raw), cap: PROOF_LIMITS.payload }];
  for (const shot of parsed.proof.screenshots) {
    if (shot.path.split('/').some(part => /^\.git$/i.test(part) || looksLikeProtocolFile(part))) fail('A screenshot cannot name Git metadata or a prior attempt’s protocol file.');
    const bytes = blob(shot.path, SCREENSHOT_BYTE_CAP);
    if (bytes === null) fail(`${shot.path} is not committed in this result.`);
    const image = validateScreenshotBytes(bytes!);
    if (!image.ok) return fail(`${shot.path}: ${image.problem}`);
    const dims = imageDimensions(bytes!, image.kind);
    if (bytes!.length < SCREENSHOT_EVIDENCE_MIN_BYTES || !dims || dims.width < SCREENSHOT_EVIDENCE_MIN_WIDTH || dims.height < SCREENSHOT_EVIDENCE_MIN_HEIGHT) fail(`${shot.path} needs a readable screenshot of at least ${SCREENSHOT_EVIDENCE_MIN_BYTES} bytes and ${SCREENSHOT_EVIDENCE_MIN_WIDTH}×${SCREENSHOT_EVIDENCE_MIN_HEIGHT} pixels.`);
    files.push({ path: shot.path, sha256: digest(bytes!), cap: SCREENSHOT_BYTE_CAP });
  }
  return { proof: parsed.proof, files };
}

export function preparedScreenshotMatches(inventory: PreparedEvidence, path: string, bytes: Buffer): boolean {
  return inventory.files.some(file => file.path === path && file.sha256 === digest(bytes));
}

/** After checkout/setup, read without following links and mint this worker's receipt. */
export function writePreparedEvidence(worktree: string, nonceFile: string, inventory: PreparedEvidence): void {
  for (const file of inventory.files) {
    const parts = file.path.split('/');
    for (let count = 1; count < parts.length; count++) {
      const parent = lstatSync(join(worktree, ...parts.slice(0, count)));
      if (!parent.isDirectory() || parent.isSymbolicLink()) fail(`${file.path} has a linked or missing parent directory.`);
    }
    const read = readMailbox(join(worktree, file.path), file.cap);
    if (!read.ok || !preparedScreenshotMatches(inventory, file.path, read.raw)) fail(`${file.path} no longer matches the saved commit.`);
  }
  writeFileSync(join(worktree, nonceFile), serializeProof(inventory.proof), { flag: 'wx', mode: 0o600 });
}
