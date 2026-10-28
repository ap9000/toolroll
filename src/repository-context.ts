/** Optional repository context. Callers admit project access; this module grants no authority.
 * The index is disposable. Every read hashes the current bounded tracked source set;
 * a missing/changed/unreadable index falls back to ordinary text search, never a task gate. */
import { inReadOnlyRequest } from './read-only-request.js';
import { checkoutGitSync } from './teardown-git.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scanForSecrets } from './evidence.js';
import type ts from 'typescript-parser';

const VERSION = 1;
const MAX_FILES = 1200, MAX_FILE_BYTES = 256_000, MAX_SOURCE_BYTES = 12_000_000;
const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const TEXT = /\.(?:[cm]?[jt]sx?|md|txt|css|html|json)$/i;
const MAX_NODES = 16_000, MAX_EDGES = 12_000;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Read-only and bounded: no index refresh, no hooks, no fsmonitor program.
// On a page read (Settings -> Knowledge's search), the hardened checkout git: no filter, hook, program or network.
const git = (repo: string, args: string[]) => inReadOnlyRequest() ? checkoutGitSync(repo, args, { timeoutMs: 10_000, maxBuffer: 2_000_000 }).trimEnd()
  : execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 2_000_000, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };

export type RepositoryContextRequest = {
  repo: string; query: string; mode?: 'search' | 'impact'; audience?: 'lead' | 'crew';
  /** Canonical admitted project when repo is a crew worktree. Must share its Git common directory. */
  project?: string;
  baseRevision?: string; cacheRoot?: string; refresh?: boolean; maxBytes?: number;
};
export type RepositoryCheckout = { repo: string; gitDir: string; head: string; baseRevision: string; sourceHash: string; source: 'working-tree' };
export type RepositoryRelationship = { from: string; to: string; kind: 'imports' | 're-exports' | 'dynamic-import'; file: string; line: number; provenance: 'explicit' };
export type RepositoryExcerpt = { file: string; line: number; endLine: number; sha256: string; text: string; reason: string; symbol: string | null };
export type RepositoryContext = {
  version: 1; readOnly: boolean; query: string; mode: 'search' | 'impact'; asOf: string;
  checkout: RepositoryCheckout | null;
  index: { engine: 'typescript-ast' | 'text-search'; status: 'ready' | 'missing' | 'stale' | 'unavailable'; generation: string | null; extractor: string | null };
  excerpts: RepositoryExcerpt[]; relationships: RepositoryRelationship[];
  omissions: { files: number; excerpts: number; relationships: number; sourceBytes: number };
  warnings: string[];
};
type Source = { file: string; text: string; sha256: string };
type SymbolNode = { file: string; name: string; line: number; endLine: number };
type Index = { version: 1; checkout: RepositoryCheckout; extractor: string; nodes: SymbolNode[]; relationships: RepositoryRelationship[]; warnings: string[] };
type Snapshot = { checkout: RepositoryCheckout; sources: Source[]; omitted: number; omittedBytes: number; warnings: string[] };

function capture(request: RepositoryContextRequest): Snapshot {
  const repo = realpathSync(request.repo);
  if (repo !== resolve(request.repo)) throw Error('The project location changed.');
  if (realpathSync(git(repo, ['rev-parse', '--show-toplevel'])) !== repo) throw Error('Choose the project checkout root.');
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const baseRevision = request.baseRevision ?? head;
  if (!/^[a-f0-9]{40,64}$/.test(baseRevision) || git(repo, ['rev-parse', '--verify', `${baseRevision}^{commit}`]) !== baseRevision) throw Error('The requested context base is unavailable.');
  if (request.audience === 'crew' && baseRevision !== head) throw Error('Crew context must start at its exact task base.');
  const gitDir = realpathSync(git(repo, ['rev-parse', '--absolute-git-dir']));
  if (request.project && realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(git(request.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) throw Error('The worktree belongs to a different project.');
  const files = git(repo, ['ls-files', '-z', '--cached']).split('\0').filter(Boolean).sort();
  const sources: Source[] = [], warnings: string[] = [];
  let omitted = 0, omittedBytes = 0, bytes = 0;
  for (const file of [...new Set(files)]) {
    if (!TEXT.test(file) || /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.git)(?:\/|$)/.test(file)) continue;
    const path = resolve(repo, file);
    if (!inside(repo, path) || file.split('/').some(p => p === '..') || /[\x00-\x1f]/.test(file)) { omitted++; continue; }
    try {
      const stat = lstatSync(path);
      // Never follow even an internal symlink: the index is scoped to tracked ordinary files.
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) { omitted++; continue; }
      if (sources.length >= MAX_FILES || stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_SOURCE_BYTES) { omitted++; omittedBytes += stat.size; continue; }
      const data = readFileSync(path);
      const text = data.toString('utf8');
      if (data.length > MAX_FILE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/u.test(text) || scanForSecrets(text).length) { omitted++; omittedBytes += data.length; continue; }
      sources.push({ file, text, sha256: sha(data) }); bytes += data.length;
    } catch { omitted++; }
  }
  if (git(repo, ['rev-parse', '--verify', 'HEAD']) !== head) throw Error('The checkout changed while context was being read.');
  if (omitted) warnings.push(`${omitted} source files were omitted because they were unavailable, excluded, sensitive or beyond the read limits.`);
  warnings.push('Tracked files only. Static imports do not establish every runtime dependency or sufficient test coverage.');
  const sourceHash = sha(JSON.stringify(sources.map(({ file, sha256 }) => [file, sha256])));
  return { checkout: { repo, gitDir, head, baseRevision, sourceHash, source: 'working-tree' }, sources, omitted, omittedBytes, warnings };
}

function cacheFile(root: string, checkout: RepositoryCheckout): string {
  const absolute = resolve(root);
  // Reject an existing symlink anywhere in the cache path, and caches inside the repo.
  let parent = absolute;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  if (realpathSync(parent) !== parent || inside(checkout.repo, absolute)) throw Error('Repository context cache must be outside the checkout.');
  return join(absolute, `repository-${sha(JSON.stringify([checkout.repo, checkout.gitDir, checkout.baseRevision]))}.json`);
}
function validIndex(value: unknown): value is Index {
  if (!value || typeof value !== 'object') return false;
  const i = value as Index;
  return i.version === VERSION && !!i.checkout && i.checkout.source === 'working-tree' && ['repo', 'gitDir', 'head', 'baseRevision', 'sourceHash'].every(k => typeof (i.checkout as unknown as Record<string, unknown>)[k] === 'string') &&
    typeof i.extractor === 'string' && Array.isArray(i.warnings) && i.warnings.length < 100 && i.warnings.every(w => typeof w === 'string') &&
    Array.isArray(i.nodes) && i.nodes.length <= MAX_NODES && i.nodes.every(n => typeof n.file === 'string' && typeof n.name === 'string' && Number.isSafeInteger(n.line) && n.line > 0 && Number.isSafeInteger(n.endLine) && n.endLine >= n.line) &&
    Array.isArray(i.relationships) && i.relationships.length <= MAX_EDGES && i.relationships.every(e => typeof e.from === 'string' && typeof e.to === 'string' && typeof e.file === 'string' && Number.isSafeInteger(e.line) && e.line > 0 && ['imports', 're-exports', 'dynamic-import'].includes(e.kind) && e.provenance === 'explicit');
}
function readIndex(path: string): Index | null {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 5_000_000) throw Error('Unreadable repository index.');
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { index?: unknown; sha256?: string };
  if (sha(JSON.stringify(envelope.index)) !== envelope.sha256 || !validIndex(envelope.index)) throw Error('Invalid repository index.');
  return envelope.index;
}
function writeIndex(path: string, index: Index): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(path)) !== dirname(path)) throw Error('The context cache changed.');
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify({ index, sha256: sha(JSON.stringify(index)) }), { flag: 'wx', mode: 0o600 }); renameSync(tmp, path); }
  finally { try { unlinkSync(tmp); } catch { /* Successful atomic rename leaves no temp file. */ } }
}

async function buildIndex(snapshot: Snapshot): Promise<Index> {
  const compiler = (await import('typescript-parser')).default;
  const byPath = new Map(snapshot.sources.map(source => [resolve(snapshot.checkout.repo, source.file), source]));
  const directories = new Set<string>([snapshot.checkout.repo]);
  for (const file of byPath.keys()) { let dir = dirname(file); while (inside(snapshot.checkout.repo, dir)) { directories.add(dir); if (dir === snapshot.checkout.repo) break; dir = dirname(dir); } }
  let options: ts.CompilerOptions = { module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, allowJs: true, resolveJsonModule: true };
  const config = byPath.get(join(snapshot.checkout.repo, 'tsconfig.json'));
  const warnings: string[] = [];
  if (config) {
    const parsed = compiler.parseConfigFileTextToJson(join(snapshot.checkout.repo, config.file), config.text);
    if (!parsed.error && parsed.config?.compilerOptions) {
      const converted = compiler.convertCompilerOptionsFromJson(parsed.config.compilerOptions, snapshot.checkout.repo);
      options = { ...options, ...converted.options };
      if (parsed.config.extends) warnings.push('Inherited tsconfig settings are not indexed; unresolved aliases remain omitted.');
    } else warnings.push('TypeScript configuration could not be read; relative imports still work.');
  }
  const nodes: SymbolNode[] = [], relationships: RepositoryRelationship[] = [];
  let unresolved = 0, parseFailures = 0;
  const host: ts.ModuleResolutionHost = {
    fileExists: file => byPath.has(resolve(file)),
    readFile: file => byPath.get(resolve(file))?.text,
    directoryExists: dir => directories.has(resolve(dir)),
    getCurrentDirectory: () => snapshot.checkout.repo,
    realpath: file => resolve(file),
  };
  for (const source of snapshot.sources.filter(s => CODE.test(s.file))) {
    const fileName = resolve(snapshot.checkout.repo, source.file);
    const tree = compiler.createSourceFile(fileName, source.text, compiler.ScriptTarget.Latest, true);
    if ((tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) parseFailures++;
    const line = (pos: number) => tree.getLineAndCharacterOfPosition(Math.min(pos, source.text.length)).line + 1;
    const relationship = (specifier: string, kind: RepositoryRelationship['kind'], at: number) => {
      const resolved = compiler.resolveModuleName(specifier, fileName, options, host).resolvedModule?.resolvedFileName;
      if (!resolved || !byPath.has(resolve(resolved))) { unresolved++; return; }
      if (relationships.length < MAX_EDGES) relationships.push({ from: source.file, to: byPath.get(resolve(resolved))!.file, kind, file: source.file, line: line(at), provenance: 'explicit' });
    };
    const visit = (node: ts.Node) => {
      if (nodes.length < MAX_NODES && (compiler.isFunctionDeclaration(node) || compiler.isClassDeclaration(node) || compiler.isInterfaceDeclaration(node) || compiler.isTypeAliasDeclaration(node) || compiler.isEnumDeclaration(node) || compiler.isMethodDeclaration(node) || compiler.isVariableDeclaration(node))) {
        const name = node.name;
        if (name && compiler.isIdentifier(name)) nodes.push({ file: source.file, name: name.text, line: line(node.getStart(tree)), endLine: line(node.end) });
      }
      if (compiler.isImportDeclaration(node) && compiler.isStringLiteral(node.moduleSpecifier)) relationship(node.moduleSpecifier.text, 'imports', node.getStart(tree));
      if (compiler.isExportDeclaration(node) && node.moduleSpecifier && compiler.isStringLiteral(node.moduleSpecifier)) relationship(node.moduleSpecifier.text, 're-exports', node.getStart(tree));
      if (compiler.isCallExpression(node) && node.arguments.length === 1 && compiler.isStringLiteral(node.arguments[0]!)) {
        if (node.expression.kind === compiler.SyntaxKind.ImportKeyword) relationship((node.arguments[0] as ts.StringLiteral).text, 'dynamic-import', node.getStart(tree));
        // require may be shadowed; do not present a guessed call as a proven relationship.
      }
      compiler.forEachChild(node, visit);
    };
    visit(tree);
  }
  if (unresolved) warnings.push(`${unresolved} external or unresolved imports were omitted.`);
  if (parseFailures) warnings.push(`${parseFailures} files had syntax errors; extracted relationships may be incomplete.`);
  if (nodes.length === MAX_NODES || relationships.length === MAX_EDGES) warnings.push('Repository relationships reached the index limit; remaining entries were omitted.');
  return { version: VERSION, checkout: snapshot.checkout, extractor: `typescript-parser@${compiler.version}/imports-v1`, nodes, relationships, warnings };
}

const terms = (query: string) => [...new Set(query.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].filter(t => !['the', 'and', 'for', 'this', 'that', 'what', 'where', 'with', 'from', 'does', 'show', 'code'].includes(t)).slice(0, 12);
type Hit = { source: Source; line: number; score: number; reason: string; symbol: string | null };
function search(snapshot: Snapshot, query: string, index: Index | null): Hit[] {
  const words = terms(query), hits: Hit[] = [];
  if (!words.length) return [];
  for (const source of snapshot.sources) {
    const names = index?.nodes.filter(n => n.file === source.file) ?? [];
    const pathScore = words.reduce((n, word) => n + (source.file.toLowerCase().includes(word) ? 3 : 0), 0);
    const symbol = names.map(node => ({ node, score: words.reduce((n, word) => n + (node.name.toLowerCase().includes(word) ? 5 : 0), 0) })).sort((a, b) => b.score - a.score)[0];
    const lines = source.text.split('\n');
    let bestLine = symbol?.score ? symbol.node.line : 1, bestScore = 0;
    lines.forEach((line, i) => { const score = words.reduce((n, word) => n + (line.toLowerCase().includes(word) ? 1 : 0), 0); if (score > bestScore) { bestScore = score; if (!symbol?.score) bestLine = i + 1; } });
    const score = pathScore + (symbol?.score ?? 0) + bestScore;
    if (score) hits.push({ source, line: bestLine, score, symbol: symbol?.score ? symbol.node.name : null, reason: symbol?.score ? 'Matching code symbol' : pathScore ? 'Matching file and source text' : 'Matching source text' });
  }
  return hits.sort((a, b) => b.score - a.score || a.source.file.localeCompare(b.source.file));
}
function impact(snapshot: Snapshot, query: string, index: Index, warnings: string[]): { hits: Hit[]; edges: RepositoryRelationship[] } {
  const normalized = query.replace(/^\.\//, '').trim();
  const direct = snapshot.sources.find(s => s.file === normalized);
  const matching = index.nodes.filter(n => n.name.toLowerCase() === normalized.toLowerCase());
  const files = [...new Set(matching.map(n => n.file))];
  const target = direct?.file ?? (files.length === 1 ? files[0] : undefined);
  if (!target) { warnings.push(files.length > 1 ? 'That symbol occurs in several files. Use its exact repository-relative file path for impact.' : 'No exact indexed file or symbol matched. Ordinary search results are shown.'); return { hits: search(snapshot, query, index), edges: [] }; }
  const depths = new Map<string, number>([[target, 0]]), edges: RepositoryRelationship[] = [];
  for (let depth = 0; depth < 2; depth++) {
    for (const edge of index.relationships) if (depths.get(edge.to) === depth && edges.length < 200) {
      edges.push(edge); if (!depths.has(edge.from)) depths.set(edge.from, depth + 1);
    }
  }
  const byFile = new Map(snapshot.sources.map(s => [s.file, s]));
  const hits = [...depths].flatMap(([file, depth]) => {
    const source = byFile.get(file); if (!source) return [];
    const edge = edges.find(e => e.from === file);
    return [{ source, line: edge?.line ?? matching.find(n => n.file === file)?.line ?? 1, score: 100 - depth, reason: depth === 0 ? 'Selected source' : `Imports the selected source within ${depth} step${depth === 1 ? '' : 's'}`, symbol: null }];
  });
  return { hits, edges };
}

function initialResult(request: RepositoryContextRequest): RepositoryContext {
  return { version: 1, readOnly: !request.refresh, query: request.query.slice(0, 1000), mode: request.mode ?? 'search', asOf: new Date().toISOString(), checkout: null,
    index: { engine: 'text-search', status: 'unavailable', generation: null, extractor: null }, excerpts: [], relationships: [], omissions: { files: 0, excerpts: 0, relationships: 0, sourceBytes: 0 }, warnings: [] };
}
function captureForResult(request: RepositoryContextRequest, result: RepositoryContext): Snapshot | null {
  try {
    const snapshot = capture(request);
    result.checkout = snapshot.checkout; result.warnings.push(...snapshot.warnings);
    result.omissions.files = snapshot.omitted; result.omissions.sourceBytes = snapshot.omittedBytes;
    return snapshot;
  } catch {
    result.warnings.push(request.audience === 'crew' ? 'Repository context is unavailable at the exact task base. Continue with the saved project context and read the assigned worktree.' : 'Repository context is unavailable. Continue with the saved project context and ordinary file reading.');
    return null;
  }
}
const responseBudget = (request: RepositoryContextRequest) => Math.max(3000, Math.min(20_000, Number.isFinite(request.maxBytes) ? Math.floor(request.maxBytes!) : request.audience === 'crew' ? 12_000 : 6500));
function finishContext(request: RepositoryContextRequest, result: RepositoryContext, snapshot: Snapshot, index: Index | null): RepositoryContext {
  const mode = request.mode ?? 'search';
  const budget = responseBudget(request);
  if (index) {
    result.index = { engine: 'typescript-ast', status: 'ready', generation: sha(JSON.stringify(index)), extractor: index.extractor };
    result.warnings.push(...index.warnings);
  } else result.warnings.push('No current repository index is available. Ordinary source search is being used; refresh context to restore relationship lookup.');
  const found = mode === 'impact' && index ? impact(snapshot, request.query, index, result.warnings) : { hits: search(snapshot, request.query, index), edges: [] as RepositoryRelationship[] };
  if (mode === 'impact' && !index) result.warnings.push('These are text matches, not an impact analysis.');
  const selected = found.hits.slice(0, request.audience === 'crew' ? 8 : 5);
  result.omissions.excerpts = Math.max(0, found.hits.length - selected.length);
  for (const hit of selected) {
    const lines = hit.source.text.split('\n');
    const start = Math.max(1, hit.line - 2), end = Math.min(lines.length, start + 10);
    const excerpt = { file: hit.source.file, line: start, endLine: end, sha256: hit.source.sha256, text: lines.slice(start - 1, end).join('\n').slice(0, 1800), reason: hit.reason, symbol: hit.symbol };
    result.excerpts.push(excerpt);
    if (Buffer.byteLength(JSON.stringify(result)) > budget - 750) { result.excerpts.pop(); result.omissions.excerpts++; }
  }
  const selectedFiles = new Set(result.excerpts.map(e => e.file));
  const related = mode === 'impact' ? found.edges : index?.relationships.filter(e => selectedFiles.has(e.from) && selectedFiles.has(e.to)) ?? [];
  for (const edge of related) {
    result.relationships.push(edge);
    if (result.relationships.length > 20 || Buffer.byteLength(JSON.stringify(result)) > budget) { result.relationships.pop(); result.omissions.relationships++; }
  }
  return boundContext(result, budget);
}
function boundContext(result: RepositoryContext, budget: number): RepositoryContext {
  // Metadata is part of the same budget: a Unicode query alone can exceed
  // a small crew allocation even when every excerpt was already omitted.
  if (Buffer.byteLength(JSON.stringify(result)) > budget) {
    result.query = result.query.slice(0, 128);
    result.warnings.push('Response size limited the selection and shortened the displayed query.');
    while (Buffer.byteLength(JSON.stringify(result)) > budget && result.excerpts.length) { result.excerpts.pop(); result.omissions.excerpts++; }
    while (Buffer.byteLength(JSON.stringify(result)) > budget && result.relationships.length) { result.relationships.pop(); result.omissions.relationships++; }
    if (Buffer.byteLength(JSON.stringify(result)) > budget) {
      // Never truncate path identity and then imply it still pins source.
      result.checkout = null; result.index = { engine:'text-search',status:'unavailable',generation:null,extractor:null };
      result.warnings = ['Repository context identity exceeded the response limit. Continue with ordinary file reading.'];
    }
  }
  return result;
}
/** Synchronous, read-only capture for DB transaction and provider-admission callers.
 * Call once and persist the returned selection; resume uses that capture, never fresh source. */
export function repositoryContextRead(request: Omit<RepositoryContextRequest, 'refresh'>): RepositoryContext {
  const result = initialResult(request), snapshot = captureForResult(request, result);
  if (!snapshot) return boundContext(result, responseBudget(request));
  let index: Index | null = null;
  try {
    const path = request.cacheRoot ? cacheFile(request.cacheRoot, snapshot.checkout) : null;
    const stored = path ? readIndex(path) : null;
    if (stored && stored.extractor === 'typescript-parser@6.0.3/imports-v1' && JSON.stringify(stored.checkout) === JSON.stringify(snapshot.checkout)) index = stored;
    else result.index.status = stored ? 'stale' : 'missing';
  } catch { result.index.status = 'unavailable'; }
  return finishContext(request, result, snapshot, index);
}
/** Explicit refresh is the only cache-writing path. It never changes project/task records. */
export async function repositoryContext(request: RepositoryContextRequest): Promise<RepositoryContext> {
  if (!request.refresh) return repositoryContextRead(request);
  const result = initialResult(request), snapshot = captureForResult(request, result);
  if (!snapshot) return boundContext(result, responseBudget(request));
  let index: Index | null = null;
  try {
    const path = request.cacheRoot ? cacheFile(request.cacheRoot, snapshot.checkout) : null;
    index = await buildIndex(snapshot);
    if (path) {
      try { writeIndex(path, index); }
      catch { result.warnings.push('The current source map was built but could not be saved. A later read will use ordinary source search.'); }
    }
  } catch { result.index.status = 'unavailable'; }
  return finishContext(request, result, snapshot, index);
}
