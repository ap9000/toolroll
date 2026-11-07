/**
 * A heuristic over changed code (docs/plans/trusted-release-reports.md, H4): the expressions that could reach the test
 * runner, compared whole. Round 1 of the plan counted these forms, and Codex's finding 5 was that a count misses an
 * edit: `process.exit(1)` becoming `process.exit(0)` counts the same. So this keeps each expression's text, its
 * arguments included, and each binding that aliases a runner object, and reports what the candidate has that the base
 * doesn't.
 *
 * It decides nothing. It isn't wired to any approval: it makes tampering visible, can't make it impossible, and the
 * rate at which it flags honest work is measured first (scripts/tamper-measure.mjs).
 */
import { createRequire } from "node:module";
import type ts from "typescript-parser";

let compiler: typeof ts | undefined;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

const PROCESS_MEMBERS = new Set(["exit", "exitCode", "kill", "send", "channel", "ppid", "binding", "dlopen", "reallyExit", "abort"]);
const RUNNER_OBJECTS = new Set(["process", "globalThis", "global", "vi"]);
const TEST_GLOBALS = new Set(["expect", "test", "it", "describe", "vi"]);
const IMPORTS = /^(?:node:)?process$|^@vitest\/|^vitest\/(?!config$)|^tinypool$|^birpc$|^(?:node:)?vm$|^(?:node:)?inspector$/;
const HARNESS_WORDS = /node_modules\/|\/proc\/|RUNNER_|ACTIONS_|TOOLROLL_CHECK|shard-report|NODE_OPTIONS|\bsudo\b|__vitest/;
const TEST_ENV = /^(?:VITEST.*|TOOLROLL_TEST.*|CI|NODE_ENV)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Every expression in `text` that could reach the runner, with its arguments, spaces collapsed. */
export function runnerExpressions(path: string, text: string): string[] {
  const tsc = typescript();
  const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, true, /x$/.test(path) ? tsc.ScriptKind.TSX : tsc.ScriptKind.TS);
  const found: string[] = [];
  const said = (node: ts.Node) => found.push(node.getText(source).replace(/\s+/g, " ").slice(0, 200));
  const named = (node: ts.Node, names: ReadonlySet<string>): boolean => tsc.isIdentifier(node) && names.has(node.text);
  // The call or assignment a member is part of, so what it is called with or set to counts.
  const whole = (node: ts.Node): ts.Node => (tsc.isCallExpression(node.parent) && node.parent.expression === node) || (tsc.isBinaryExpression(node.parent) && node.parent.left === node) ? node.parent : node;
  const visit = (node: ts.Node): void => {
    if (tsc.isImportDeclaration(node) && tsc.isStringLiteral(node.moduleSpecifier) && IMPORTS.test(node.moduleSpecifier.text)) said(node);
    else if (tsc.isCallExpression(node) && (node.expression.kind === tsc.SyntaxKind.ImportKeyword || (tsc.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments[0] !== undefined && tsc.isStringLiteral(node.arguments[0]) && IMPORTS.test(node.arguments[0].text)) said(node);
    else if (tsc.isPropertyAccessExpression(node) && tsc.isIdentifier(node.expression)) {
      const object = node.expression.text, member = node.name.text;
      if (object === "process" && (PROCESS_MEMBERS.has(member) || member.startsWith("_"))) said(whole(node));
      if (object === "require" && member === "cache") said(node);
      if (object === "Module" && member.startsWith("_")) said(whole(node));
      if (object === "module" && member === "register") said(whole(node));
    } else if (tsc.isElementAccessExpression(node) && named(node.expression, RUNNER_OBJECTS) && !tsc.isStringLiteralLike(node.argumentExpression)) said(node);
    else if (tsc.isCallExpression(node) && tsc.isIdentifier(node.expression) && (node.expression.text === "eval" || node.expression.text === "Function")) said(node);
    else if (tsc.isNewExpression(node) && tsc.isIdentifier(node.expression) && node.expression.text === "Function") said(node);
    else if (tsc.isBinaryExpression(node) && node.operatorToken.kind === tsc.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (named(left, TEST_GLOBALS) || (tsc.isPropertyAccessExpression(left) && (named(left.expression, TEST_GLOBALS) || named(left.expression, new Set(["globalThis"])) || (tsc.isPropertyAccessExpression(left.expression) && left.expression.name.text === "prototype")))) said(node);
    } else if (tsc.isCallExpression(node) && tsc.isPropertyAccessExpression(node.expression) && node.expression.name.text === "defineProperty" && node.arguments[0] !== undefined
      && (named(node.arguments[0], TEST_GLOBALS) || named(node.arguments[0], RUNNER_OBJECTS))) said(node);
    // A binding: another name for a runner object, or pieces taken out of one.
    else if (tsc.isVariableDeclaration(node) && node.initializer !== undefined && named(node.initializer, RUNNER_OBJECTS)) said(node);
    else if (tsc.isStringLiteralLike(node) && HARNESS_WORDS.test(node.text)) said(node);
    // Product code telling a test from the real thing.
    if (!TEST_FILE.test(path) && tsc.isPropertyAccessExpression(node) && TEST_ENV.test(node.name.text) && tsc.isPropertyAccessExpression(node.expression) && node.expression.name.text === "env") said(node);
    if (!TEST_FILE.test(path) && tsc.isElementAccessExpression(node) && tsc.isStringLiteralLike(node.argumentExpression) && TEST_ENV.test(node.argumentExpression.text) && tsc.isPropertyAccessExpression(node.expression) && node.expression.name.text === "env") said(node);
    tsc.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What the candidate has that the base doesn't, as a multiset: an edited argument is a new expression, a moved one isn't. */
export function tamperFindings(path: string, base: string | null, candidate: string): string[] {
  const left = new Map<string, number>();
  for (const one of base === null ? [] : runnerExpressions(path, base)) left.set(one, (left.get(one) ?? 0) + 1);
  const added: string[] = [];
  for (const one of runnerExpressions(path, candidate)) {
    const count = left.get(one) ?? 0;
    if (count > 0) left.set(one, count - 1); else added.push(one);
  }
  return added;
}
