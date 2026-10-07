import { readFileSync } from 'node:fs';
import ts from 'typescript-parser';
import { expect, test } from 'vitest';
import { assertHandlerRegistry, type Registration } from './handler-registry.js';
import { ROUTES } from './route-table.js';

/** Inspect the actual factory registrations, not another copy of the policy list. Server tests also instantiate every factory. */
function registered(): Registration[] {
  return ['tasks', 'flows', 'chat', 'settings', 'people-tokens', 'pages', 'remote'].flatMap(name => {
    const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(name + '.ts', source, ts.ScriptTarget.Latest, true);
    const rows: Registration[] = [];
    let found = 0;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'registrations') {
        found++;
        expect(node.initializer && ts.isArrayLiteralExpression(node.initializer)).toBe(true);
        for (const element of (node.initializer as ts.ArrayLiteralExpression).elements) {
          expect(ts.isObjectLiteralExpression(element)).toBe(true);
          const props = Object.fromEntries((element as ts.ObjectLiteralExpression).properties.map(property => {
            expect(ts.isPropertyAssignment(property)).toBe(true);
            const one = property as ts.PropertyAssignment;
            return [one.name.getText(tree), ts.isStringLiteral(one.initializer) ? one.initializer.text : one.initializer.getText(tree)];
          }));
          expect(['get', 'post', 'edge']).toContain(props.handle);
          expect(source).toContain(`async function ${props.handle}(`);
          rows.push({ ...props, handle: async () => {} } as Registration);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(found, name).toBe(1);
    return rows;
  });
}

test('every registered handler has exactly one compatible table row and every row has a handler', () => {
  const handlers = registered();
  expect(handlers).toHaveLength(ROUTES.length);
  expect(() => assertHandlerRegistry(handlers)).not.toThrow();
  expect(() => assertHandlerRegistry(handlers.slice(1))).toThrow(/Route has no handler/);
  expect(() => assertHandlerRegistry([...handlers, handlers[0]!])).toThrow(/Duplicate handler/);
  expect(() => assertHandlerRegistry([...handlers, { ...handlers[0]!, id: 'not-declared' }])).toThrow(/no compatible route/);
  expect(() => assertHandlerRegistry([{ ...handlers[0]!, method: 'POST' }, ...handlers.slice(1)])).toThrow(/no compatible route/);
});
