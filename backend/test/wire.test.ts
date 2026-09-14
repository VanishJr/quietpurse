/**
 * Two rules about src/wire that no type holds. The module may name no dependency but
 * zod, because the client's own tsc compiles it in row 76b and pulls in whatever it
 * imports - a drizzle-orm reached through db/schema.ts would drag the data layer into
 * that typecheck. And every declared JSON body is strict all the way down: a plain
 * z.object strips the keys it does not know and certifies a body it never saw.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANSWERS, type Declared, refusalSchema } from '../src/wire';

const WIRE_DIR = path.resolve(process.cwd(), 'src/wire');

const sourcesOf = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourcesOf(path.join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(dir, entry.name)]
          : [],
    );

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

const literal = (node: ts.Node | undefined): string =>
  node && ts.isStringLiteral(node) ? node.text : '(dynamic)';

/**
 * Every way a module can name another, over the whole tree: an import, a re-export,
 * `import x = require()`, a require or import() call anywhere - inside an object
 * literal included - a `typeof import('x')` in a type position, which the client's
 * tsc follows like any other, and a triple-slash directive.
 */
export const specifiersOf = (source: ts.SourceFile): string[] => {
  const found: string[] = [
    ...source.referencedFiles.map((r) => r.fileName),
    ...source.typeReferenceDirectives.map((r) => r.fileName),
    ...source.libReferenceDirectives.map((r) => r.fileName),
  ];
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) found.push(literal(node.moduleSpecifier));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push(literal(node.moduleReference.expression));
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push(literal(node.arguments[0]));
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        found.push(literal(node.arguments[0]));
      }
    }
    if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      found.push(ts.isLiteralTypeNode(arg) ? literal(arg.literal) : '(dynamic)');
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return found;
};

const insideWire = (from: string, specifier: string): boolean =>
  specifier.startsWith('.') &&
  !path.relative(WIRE_DIR, path.resolve(path.dirname(from), specifier)).startsWith('..');

describe('src/wire names no dependency but zod', () => {
  const files = sourcesOf(WIRE_DIR);

  it('has at least one source file to read', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(process.cwd(), f), f]))(
    '%s imports zod, or a file inside src/wire, and nothing else',
    (_name, file) => {
      const found = specifiersOf(parse(file));
      expect(found.length, 'a wire module with no import at all is not what this reads').toBeGreaterThan(0);
      expect(found.filter((s) => s !== 'zod' && !insideWire(file, s))).toEqual([]);
    },
  );

  const crafted = (text: string): string[] =>
    specifiersOf(ts.createSourceFile('crafted.ts', text, ts.ScriptTarget.Latest, true));

  it('sees every form a dependency can take, including the three 068 did not need', () => {
    expect(crafted("import { sql } from 'drizzle-orm';")).toEqual(['drizzle-orm']);
    expect(crafted("export type { Db } from '../db';")).toEqual(['../db']);
    expect(crafted("import fs = require('node:fs');")).toEqual(['node:fs']);
    expect(crafted("const HOLE = { x: require('pg') };")).toEqual(['pg']);
    expect(crafted("const later = () => import('express');")).toEqual(['express']);
    expect(crafted("type T = typeof import('drizzle-orm');")).toEqual(['drizzle-orm']);
    expect(crafted("type U = import('express').Request;")).toEqual(['express']);
    expect(crafted('/// <reference types="node" />\nexport {};')).toEqual(['node']);
    expect(crafted("const dyn = require(name);")).toEqual(['(dynamic)']);
  });
});

/**
 * Walks a schema through the wrappers a declared body uses and refuses an object
 * node whose catchall is not `never`, which is what zod 4 writes for strictObject and
 * keeps through extend(). Any node kind it does not know is a throw, not a pass:
 * a walk that skipped an unfamiliar wrapper would certify whatever sat under it.
 */
type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
};

const defOf = (schema: z.ZodType): Def =>
  (schema as unknown as { _zod?: { def?: Def } })._zod?.def ?? { type: '(unreadable)' };

const LEAVES = new Set(['string', 'number', 'boolean', 'literal', 'enum', 'never']);

type Walk = { lax: string[]; objects: Set<z.ZodType> };

const objectNodes = (schema: z.ZodType, at: string, walk: Walk): number => {
  const def = defOf(schema);
  switch (def.type) {
    case 'object': {
      if (defOf(def.catchall ?? z.unknown()).type !== 'never') walk.lax.push(at);
      walk.objects.add(schema);
      return (
        1 +
        Object.entries(def.shape ?? {}).reduce(
          (n, [key, child]) => n + objectNodes(child, `${at}.${key}`, walk),
          0,
        )
      );
    }
    case 'array':
      return objectNodes(def.element!, `${at}[]`, walk);
    case 'union':
      return (def.options ?? []).reduce((n, o, i) => n + objectNodes(o, `${at}|${i}`, walk), 0);
    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'default':
      return objectNodes(def.innerType!, at, walk);
    case 'pipe':
      return objectNodes(def.in!, at, walk) + objectNodes(def.out!, at, walk);
    default:
      if (LEAVES.has(def.type)) return 0;
      throw new Error(`${at}: unhandled schema type "${def.type}" - teach the walk before trusting it`);
  }
};

describe('every declared JSON body is strict all the way down', () => {
  const entries = Object.entries(ANSWERS as Record<string, Declared>);
  const json = entries.filter(
    (e): e is [string, Extract<Declared, { kind: 'json' }>] => e[1].kind === 'json',
  );
  const walked = (): Walk & { visited: number } => {
    const walk: Walk = { lax: [], objects: new Set() };
    let visited = objectNodes(refusalSchema, 'refusal', walk);
    for (const [key, entry] of json) {
      visited += objectNodes(entry.body, key, walk);
      for (const [status, schema] of Object.entries(entry.refusals ?? {})) {
        visited += objectNodes(schema, `${key} ${status}`, walk);
      }
    }
    return { ...walk, visited };
  };

  it('visits at least one object node per declared body, so a walk that found nothing reds', () => {
    const { visited, lax } = walked();
    expect(visited, 'found no object schema').toBeGreaterThanOrEqual(json.length);
    expect(lax).toEqual([]);
  });

  /**
   * The floor above holds one object per body and is blind to the children under it:
   * a zod release that renamed `shape` would leave every nested object unvisited with
   * the floor met. The distinct objects reached are therefore held equal to the
   * objects the module's own text declares - every strictObject() and every extend()
   * - which also refuses a declared shape that no route and no refusal reaches.
   */
  it('reaches every object shape the module declares, and each exactly once', () => {
    const text = fs.readFileSync(path.join(WIRE_DIR, 'index.ts'), 'utf8');
    const declaredObjects =
      (text.match(/\.strictObject\(/g) ?? []).length + (text.match(/\.extend\(/g) ?? []).length;
    expect(declaredObjects).toBeGreaterThan(json.length);
    expect(walked().objects.size).toBe(declaredObjects);
  });

  it('would refuse a plain z.object where it sits, and a lax node under a strict one', () => {
    const crafted: Walk = { lax: [], objects: new Set() };
    objectNodes(z.strictObject({ inner: z.array(z.object({ a: z.string() })).optional() }), 'crafted', crafted);
    expect(crafted.lax).toEqual(['crafted.inner[]']);
  });

  it('throws on a schema whose internals it cannot read, rather than counting it as nothing', () => {
    expect(() => objectNodes({} as z.ZodType, 'crafted', { lax: [], objects: new Set() })).toThrow(
      /unhandled schema type "\(unreadable\)"/,
    );
  });

  it('declares every route once, under a method the registry keys by', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [key] of entries) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
  });
});
