import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  CHART_ACCOUNT_ID_MAX,
  CHART_BREAKDOWNS,
  CHART_ID_MAX,
  CHART_ID_SHAPE,
  CHART_KINDS,
  CHART_METRICS,
  CHART_RANGES,
  CHART_TITLE_MAX,
  CHARTS_MAX,
} from '../src/db';

/**
 * The charts route refuses a whole list, never one chart in it - so every vocabulary
 * and every bound the client composes against has to be the server's own, and the two
 * packages share no build. This file is the only place they meet.
 *
 * EQUALITY and not a floor, in both directions, which is the difference from
 * error-budget.test.ts next door. A client vocabulary NARROWER than the server's is a
 * kind the wizard never offers and - because chartKind() substitutes rather than
 * refuses - a stored chart of that kind drawn as a line under the reader's own title.
 * A client vocabulary WIDER than the server's composes a list the route refuses whole,
 * and the reader is then locked out of saving anything at all over one chart. The same
 * argument runs over the four lengths: under the server's bound truncates what the
 * server would have taken, over it composes a 400. And over the id charset, which is
 * the ninth thing: narrowed on the route alone, the client goes on re-minting ids the
 * route now refuses and every save from then on is refused whole.
 *
 * The client keeps each vocabulary TWICE - once as a union type, once as the `key:`
 * of a def array the wizard renders - and both are read here, because a member present
 * in one and missing from the other is exactly the substitution above.
 *
 * Read through the compiler API rather than by regex: the def arrays are object
 * literals carrying multi-line blurbs with apostrophes and em dashes in them, which is
 * the fragile thing a pattern over source is bad at.
 */
describe('the client composes against the charts route’s own door', () => {
  const SOURCE = '../web/src/analytics.ts';
  const text = fs.readFileSync(path.resolve(process.cwd(), SOURCE), 'utf8');
  const source = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true);

  /** The members of `export type X = 'a' | 'b'`, in the order they are written. */
  const unionOf = (name: string): string[] | null => {
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
        const arms = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
        const members: string[] = [];
        for (const arm of arms) {
          if (ts.isLiteralTypeNode(arm) && ts.isStringLiteral(arm.literal))
            members.push(arm.literal.text);
          else return;
        }
        found = members;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  /** The `key:` of every object literal in `export const X: T[] = [ … ]`. */
  const keysOf = (name: string): string[] | null => {
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        const keys: string[] = [];
        for (const element of node.initializer.elements) {
          if (!ts.isObjectLiteralExpression(element)) return;
          const key = element.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'key',
          );
          if (!key || !ts.isStringLiteral(key.initializer)) return;
          keys.push(key.initializer.text);
        }
        found = keys;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  /** `export const NAME = <number>;` */
  const numberOf = (name: string): number | null => {
    let found: number | null = null;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isNumericLiteral(node.initializer)
      ) {
        found = Number(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  /** `const NAME = /…/;` as it is written, which is what `String(regex)` answers with. */
  const regexOf = (name: string): string | null => {
    let found: string | null = null;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isRegularExpressionLiteral(node.initializer)
      ) {
        found = node.initializer.text;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  const teach = `not found in ${SOURCE} - was it renamed, or written in a shape this check cannot read?`;

  const VOCABULARIES: [string, string, readonly string[]][] = [
    ['ChartKind', 'CHART_KINDS', CHART_KINDS],
    ['Metric', 'METRICS', CHART_METRICS],
    ['Breakdown', 'BREAKDOWNS', CHART_BREAKDOWNS],
    ['RangeKey', 'RANGES', CHART_RANGES],
  ];

  it.each(VOCABULARIES)('the %s union is the server list', (union, _defs, server) => {
    const members = unionOf(union);
    expect(members, `type ${union} ${teach}`).toBeTruthy();
    expect([...members!].sort()).toEqual([...server].sort());
  });

  it.each(VOCABULARIES)('every %s the wizard offers is on that list', (_union, defs, server) => {
    const keys = keysOf(defs);
    expect(keys, `${defs} ${teach}`).toBeTruthy();
    expect([...keys!].sort()).toEqual([...server].sort());
  });

  const BOUNDS: [string, number][] = [
    ['CHARTS_MAX', CHARTS_MAX],
    ['CHART_TITLE_MAX', CHART_TITLE_MAX],
    ['CHART_ID_MAX', CHART_ID_MAX],
    ['CHART_ACCOUNT_ID_MAX', CHART_ACCOUNT_ID_MAX],
  ];

  it.each(BOUNDS)('%s is the same number on both sides', (name, server) => {
    const client = numberOf(name);
    expect(client, `${name} ${teach}`).not.toBeNull();
    expect(client).toBe(server);
  });

  it('the id charset is the same pattern on both sides', () => {
    const client = regexOf('ID_SHAPE');
    expect(client, `ID_SHAPE ${teach}`).not.toBeNull();
    // literal against literal, so it fires in either direction: a route narrowed
    // without the client is a list refused whole, and a client narrowed without the
    // route re-mints an id the reader had no reason to lose
    expect(client).toBe(String(CHART_ID_SHAPE));
  });
});
