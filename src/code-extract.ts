/**
 * The static read of one TS/JS file and the module resolution over a set of paths held in memory: nothing here touches
 * the filesystem, a repository or a checker. Repository context (repository-context.ts) reads a checkout through it; the
 * code map's parser child (code-map-main.ts) reads blobs through it. The file name decides the parse mode.
 */
import type ts from 'typescript-parser';

export type Compiler = typeof ts;
export type EdgeKind = 'imports' | 're-exports' | 'dynamic-import';
export type DeclarationKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'method' | 'variable' | 'default';
export type Declaration = { name: string; kind: Exclude<DeclarationKind, 'default'>; line: number; endLine: number };
export type ExportedName = { name: string; kind: DeclarationKind; line: number };
export type Specifier = { specifier: string; kind: EdgeKind; line: number };
export type Extracted = { declarations: Declaration[]; exports: ExportedName[]; specifiers: Specifier[]; parseFailed: boolean };

const declarationKind = (compiler: Compiler, node: ts.Node): Declaration['kind'] | null =>
  compiler.isFunctionDeclaration(node) ? 'function' : compiler.isClassDeclaration(node) ? 'class' : compiler.isInterfaceDeclaration(node) ? 'interface'
    : compiler.isTypeAliasDeclaration(node) ? 'type' : compiler.isEnumDeclaration(node) ? 'enum' : compiler.isMethodDeclaration(node) ? 'method'
      : compiler.isVariableDeclaration(node) ? 'variable' : null;

function exportedAtTop(compiler: Compiler, node: ts.Node): boolean {
  const statement = compiler.isVariableDeclaration(node) ? node.parent?.parent : node;
  if (!statement || !compiler.isSourceFile(statement.parent)) return false;
  return (compiler.canHaveModifiers(statement) ? compiler.getModifiers(statement) : undefined)?.some(one => one.kind === compiler.SyntaxKind.ExportKeyword) ?? false;
}

/** Declarations, the names the file exports (under the name they are exported as) and the module specifiers it names. `require` isn't counted: it may
 * be shadowed, and a guessed call isn't a proven relationship. */
export function extractFile(compiler: Compiler, fileName: string, text: string): Extracted {
  const tree = compiler.createSourceFile(fileName, text, compiler.ScriptTarget.Latest, true);
  const parseFailed = !!(tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length;
  const line = (pos: number) => tree.getLineAndCharacterOfPosition(Math.min(pos, text.length)).line + 1;
  const declarations: Declaration[] = [], specifiers: Specifier[] = [], exports: ExportedName[] = [];
  const named: { local: string; as: string }[] = [];
  const visit = (node: ts.Node) => {
    const kind = declarationKind(compiler, node);
    if (kind !== null) {
      const name = (node as ts.NamedDeclaration).name;
      const at = line(node.getStart(tree));
      const out = exportedAtTop(compiler, node);
      const isDefault = out && (compiler.canHaveModifiers(node) ? compiler.getModifiers(node) : undefined)?.some(one => one.kind === compiler.SyntaxKind.DefaultKeyword);
      if (name && compiler.isIdentifier(name)) {
        declarations.push({ name: name.text, kind, line: at, endLine: line(node.end) });
        if (out) exports.push({ name: name.text, kind, line: at });
      } else if (!name && isDefault) exports.push({ name: 'default', kind: 'default', line: at });
    }
    if (compiler.isExportAssignment(node) && !node.isExportEquals) {
      if (compiler.isIdentifier(node.expression)) named.push({ local: node.expression.text, as: 'default' });
      else exports.push({ name: 'default', kind: 'default', line: line(node.getStart(tree)) });
    }
    if (compiler.isImportDeclaration(node) && compiler.isStringLiteral(node.moduleSpecifier)) specifiers.push({ specifier: node.moduleSpecifier.text, kind: 'imports', line: line(node.getStart(tree)) });
    if (compiler.isExportDeclaration(node)) {
      if (node.moduleSpecifier && compiler.isStringLiteral(node.moduleSpecifier)) specifiers.push({ specifier: node.moduleSpecifier.text, kind: 're-exports', line: line(node.getStart(tree)) });
      else if (!node.moduleSpecifier && node.exportClause && compiler.isNamedExports(node.exportClause)) {
        for (const one of node.exportClause.elements) named.push({ local: (one.propertyName ?? one.name).text, as: one.name.text });
      }
    }
    if (compiler.isCallExpression(node) && node.arguments.length === 1 && compiler.isStringLiteral(node.arguments[0]!) && node.expression.kind === compiler.SyntaxKind.ImportKeyword) {
      specifiers.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, kind: 'dynamic-import', line: line(node.getStart(tree)) });
    }
    compiler.forEachChild(node, visit);
  };
  visit(tree);
  // `export { a as b }` and `export default a`: the local declaration, under the name it is exported as.
  for (const { local, as } of named) {
    const found = declarations.find(one => one.name === local && one.kind !== 'method');
    if (found !== undefined && !exports.some(one => one.name === as)) exports.push({ name: as, kind: as === 'default' ? 'default' : found.kind, line: found.line });
  }
  return { declarations, exports, specifiers, parseFailed };
}

/** The compiler options a project's tsconfig text gives, read as JSONC and converted, non-string options included.
 * `extends` isn't followed. */
export function compilerOptionsOf(compiler: Compiler, configPath: string, text: string | undefined, root: string): { options: ts.CompilerOptions; problem: 'extends' | 'unreadable' | null } {
  const base: ts.CompilerOptions = { module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, allowJs: true, resolveJsonModule: true };
  if (text === undefined) return { options: base, problem: null };
  const parsed = compiler.parseConfigFileTextToJson(configPath, text);
  if (parsed.error || !parsed.config?.compilerOptions) return { options: base, problem: 'unreadable' };
  const converted = compiler.convertCompilerOptionsFromJson(parsed.config.compilerOptions, root);
  return { options: { ...base, ...converted.options }, problem: parsed.config.extends ? 'extends' : null };
}

/** Resolve a specifier to one of `paths` (absolute, in memory); null when it names nothing there. */
export function resolveAll(compiler: Compiler, root: string, paths: ReadonlyMap<string, { text?: string }>, directories: ReadonlySet<string>, options: ts.CompilerOptions, normal: (file: string) => string): (specifier: string, fromFile: string) => string | null {
  const host: ts.ModuleResolutionHost = {
    fileExists: file => paths.has(normal(file)),
    readFile: file => paths.get(normal(file))?.text,
    directoryExists: dir => directories.has(normal(dir)),
    getCurrentDirectory: () => root,
    realpath: file => normal(file),
  };
  return (specifier, fromFile) => {
    const resolved = compiler.resolveModuleName(specifier, fromFile, options, host).resolvedModule?.resolvedFileName;
    return resolved && paths.has(normal(resolved)) ? normal(resolved) : null;
  };
}
