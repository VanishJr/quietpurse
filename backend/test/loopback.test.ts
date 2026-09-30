import fs from 'fs';
import type http from 'http';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import { closeServers, serve } from './loopback';

const ROOT = path.resolve(process.cwd(), 'test');
const HARNESS = path.join(ROOT, 'loopback.ts');

const NAMES_SUPERTEST = /(['"`])(?:@types\/)?supertest(?:\/[^'"`\n]*)?\1/;
const LISTENS = /\.listen\s*\(/;
const COLLECTED = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const NAME_ROOTS = [process.cwd()];
const LISTEN_ROOTS = [ROOT, path.resolve(process.cwd(), 'scripts')];

const PACKAGE = ['super', 'test'].join('');

const scripts = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scripts(full);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
  });

const read = (roots: string[]): string[] => roots.flatMap(scripts);

const collected = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collected(full);
    return COLLECTED.test(entry.name) ? [full] : [];
  });

describe('what the harness serves', () => {
  it('answers from a server listening on 127.0.0.1, as that server reads its own address', async () => {
    const agent = await serve(function (this: http.Server, _req, res) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(this.address()));
    });
    const res = await agent.get('/');
    expect(res.body).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('serves every target it is given on a server of its own', async () => {
    const answering = (text: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end(text);
    };
    const first = await serve(answering('first'));
    const second = await serve(answering('second'));
    expect((await first.get('/')).text).toBe('first');
    expect((await second.get('/')).text).toBe('second');
  });

  it('refuses a request through a server it has closed rather than listen again', async () => {
    const agent = await serve((_req, res) => {
      res.end('open');
    });
    expect((await agent.get('/')).text).toBe('open');
    await closeServers();
    expect(() => agent.get('/')).toThrow(/cannot listen again/);
  });
});

describe('no test reaches a server except through the harness', () => {
  it('reads the harness, which names the package and listens', () => {
    expect(read(NAME_ROOTS)).toContain(HARNESS);
    expect(read(LISTEN_ROOTS)).toContain(HARNESS);
    const own = fs.readFileSync(HARNESS, 'utf8');
    expect(own).toMatch(NAMES_SUPERTEST);
    expect(own).toMatch(LISTENS);
  });

  it('finds the package named, and a server listened on, in no other file', () => {
    const offending = (roots: string[], pattern: RegExp, says: string): string[] =>
      read(roots)
        .filter((file) => file !== HARNESS && pattern.test(fs.readFileSync(file, 'utf8')))
        .map((file) => `${path.relative(process.cwd(), file)} ${says}`);
    const offenders = [
      ...offending(NAME_ROOTS, NAMES_SUPERTEST, 'names the package'),
      ...offending(LISTEN_ROOTS, LISTENS, 'listens'),
    ];
    expect(offenders).toEqual([]);
  });

  it('finds every file the suite collects in the package under the directory it reads', () => {
    expect(configDefaults.include, "the walk's pattern copies a default vitest no longer has").toEqual([
      '**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ]);
    const expanded = ['test', 'spec'].flatMap((kind) =>
      ['', 'c', 'm'].flatMap((module) =>
        ['j', 't'].flatMap((language) => ['', 'x'].map((jsx) => `a.${kind}.${module}${language}s${jsx}`)),
      ),
    );
    expect(expanded.filter((name) => !COLLECTED.test(name)), 'the walk collects less than that default').toEqual([]);
    const files = collected(process.cwd());
    expect(files).toContain(path.join(ROOT, 'loopback.test.ts'));
    const outside = files
      .filter((file) => !file.startsWith(ROOT + path.sep))
      .map((file) => path.relative(process.cwd(), file));
    expect(outside).toEqual([]);
  });

  it('reads every way of naming the package as a quoted name, and prose as none', () => {
    const named = [
      `import request from '${PACKAGE}';`,
      `import type { Agent } from "${PACKAGE}";`,
      `export { agent } from '${PACKAGE}';`,
      `const request = require('${PACKAGE}');`,
      `const request = require(\`${PACKAGE}\`);`,
      `const request = await import('${PACKAGE}');`,
      `type Request = typeof import('${PACKAGE}');`,
      `import Test from '${PACKAGE}/lib/test';`,
      `import type { Response } from '@types/${PACKAGE}';`,
      `/// <reference types="${PACKAGE}" />`,
    ];
    expect(named.filter((form) => !NAMES_SUPERTEST.test(form))).toEqual([]);
    const unnamed = [
      ` * Driven through ${PACKAGE}, because what is worth asserting is the wire.`,
      `it('a 256 KB upload through ${PACKAGE} still imports', async () => {`,
    ];
    expect(unnamed.filter((form) => NAMES_SUPERTEST.test(form))).toEqual([]);
  });
});
