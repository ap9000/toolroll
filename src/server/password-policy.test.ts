import { readFileSync } from 'node:fs';
import ts from 'typescript-parser';
import { expect, test } from 'vitest';
import { matchRoute } from './route-table.js';

/** Reuse the independently maintained HTTP password matrix; do not derive expected ceremonies from policy. */
test('every password ceremony in the HTTP audit has a cookie-only step-up declaration', () => {
  const text = readFileSync(new URL('../serve.bearer-scope.test.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('audit.ts', text, ts.ScriptTarget.Latest, true);
  const paths: string[] = [];
  const literal = (value: ts.Expression): string => {
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isTemplateExpression(value)) return value.head.text + value.templateSpans.map(span => {
      const expression = span.expression;
      if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'repeat' || !ts.isStringLiteralLike(expression.expression.expression)) throw new Error('Unhandled ceremony path expression');
      return expression.expression.expression.text.repeat(Number(expression.arguments[0]!.getText(source))) + span.literal.text;
    }).join('');
    throw new Error('Unhandled ceremony path');
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ['ceremonies', 'variants'].includes(node.name.getText(source))) {
      expect(node.initializer && ts.isArrayLiteralExpression(node.initializer)).toBe(true);
      for (const row of (node.initializer as ts.ArrayLiteralExpression).elements) paths.push(literal((row as ts.ArrayLiteralExpression).elements[1]!));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(paths).toHaveLength(54);
  for (const path of paths) {
    const row = matchRoute('POST', path);
    expect(row?.callers, path).toEqual(['cookie']);
    // The first chat-approval panel only presents terms; save performs its password check.
    if (path !== '/settings/chat-approval/confirm') expect(row?.scope, path).toBe('step-up');
  }
});
