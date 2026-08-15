import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * refusals() composes every sentence the pdf importer can refuse with, each at its
 * own extreme, and pdf.test.ts measures the longest of them against ERROR_DETAIL_MAX.
 * A refusal thrown by the importer and forgotten in refusals() is measured by nobody:
 * it can grow past what error_detail keeps and every check stays green.
 *
 * Nothing structural holds that - the set is literals and builders with different
 * signatures - so this reads the importer as source and requires every name a throw
 * can hand to new Error to appear inside refusals(). It is deliberately syntactic:
 * no Program, no checker, no tsconfig, so the cost is one file and not the src graph.
 */
describe('every refusal the pdf importer throws is composed by refusals()', () => {
  const SOURCE = 'src/providers/pdf.ts';
  const source = ts.createSourceFile(
    SOURCE,
    fs.readFileSync(path.resolve(process.cwd(), SOURCE), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const throwSites: ts.ThrowStatement[] = [];
  const collectThrows = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) throwSites.push(node);
    ts.forEachChild(node, collectThrows);
  };
  collectThrows(source);

  const teach = 'give the sentence a const or a builder, or teach this test the new shape';
  const heads = new Set<string>();
  const unread: string[] = [];

  // the offending source rather than its SyntaxKind: the kind of a template with no
  // substitution prints as FirstTemplateToken, which names nothing a reader wrote
  const written = (node: ts.Node): string => {
    const text = node.getText(source).replace(/\s+/g, ' ');
    return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
  };

  const readHeads = (expr: ts.Expression, site: ts.ThrowStatement): void => {
    if (ts.isIdentifier(expr)) heads.add(expr.text);
    else if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression))
      heads.add(expr.expression.text);
    else if (ts.isConditionalExpression(expr)) {
      readHeads(expr.whenTrue, site);
      readHeads(expr.whenFalse, site);
    } else
      unread.push(
        `${SOURCE}:${lineOf(site)} throws new Error(${written(expr)}) - a refusal is a name here so refusals() can compose it at its extreme; ${teach}`,
      );
  };

  for (const site of throwSites) {
    const thrown = site.expression;
    const args =
      ts.isNewExpression(thrown) &&
      ts.isIdentifier(thrown.expression) &&
      thrown.expression.text === 'Error'
        ? (thrown.arguments ?? [])
        : undefined;
    if (!args || args.length !== 1) {
      unread.push(
        `${SOURCE}:${lineOf(site)} is ${written(thrown)}, not new Error(<one name>) - this test reads the first and only argument, and a rule that guesses which argument is the sentence has stopped being a rule; ${teach}`,
      );
      continue;
    }
    readHeads(args[0], site);
  }

  let declaration: ts.FunctionDeclaration | undefined;
  const findRefusals = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'refusals') declaration = node;
    ts.forEachChild(node, findRefusals);
  };
  findRefusals(source);

  const named = new Set<string>();
  const collectNames = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) named.add(node.text);
    ts.forEachChild(node, collectNames);
  };
  if (declaration?.body) collectNames(declaration.body);

  it('reads the declaration and the throw sites it means to read', () => {
    expect(declaration, `refusals() not found in ${SOURCE} - was it renamed?`).toBeTruthy();

    // a floor and not an exact count: what catches an added refusal is the coverage
    // assertion below, and this one catches only a walk that read nothing
    expect(
      throwSites.length,
      `fewer throw sites found in ${SOURCE} than the last time anyone looked - either this walk read nothing (a moved file, a parse that returned an empty tree) or a refusal was legitimately retired; lowering this number is a deliberate edit and belongs in the row that retires it`,
    ).toBeGreaterThanOrEqual(15);
  });

  it('every throw hands new Error a name rather than a sentence', () => {
    expect(unread).toEqual([]);
  });

  it('names every refusal a throw can reach', () => {
    const missing = [...heads]
      .filter((head) => !named.has(head))
      .map(
        (head) =>
          `${head} is thrown in ${SOURCE} and not named in refusals() - add it there, so the budget case measures its longest sentence against ERROR_DETAIL_MAX`,
      );
    expect(missing).toEqual([]);
  });
});
