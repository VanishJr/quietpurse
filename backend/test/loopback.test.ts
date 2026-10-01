import fs from 'fs';
import type http from 'http';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import { closeServers, serve } from './loopback';

const ROOT = path.resolve(process.cwd(), 'test');
const HARNESS = path.join(ROOT, 'loopback.ts');
const SCRIPTS = path.resolve(process.cwd(), 'scripts');
const CONFIG = path.resolve(process.cwd(), 'vitest.config.ts');

const NAMES_SUPERTEST = /(['"`])(?:@types\/)?supertest(?:\/[^'"`\n]*)?\1/;
const LISTENS = /\.listen\s*\(/;
const COLLECTED = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const PACKAGE = ['super', 'test'].join('');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const within = (...dirs: string[]) => (file: string): boolean => dirs.some((dir) => file.startsWith(dir + path.sep));

const FILES = walk(process.cwd());
const NAME_READING = FILES.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
const LISTEN_READING = NAME_READING.filter(within(ROOT, SCRIPTS));

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
    expect(NAME_READING).toContain(HARNESS);
    expect(LISTEN_READING).toContain(HARNESS);
    const own = fs.readFileSync(HARNESS, 'utf8');
    expect(own).toMatch(NAMES_SUPERTEST);
    expect(own).toMatch(LISTENS);
  });

  it('reads past the directory the harness sits in', () => {
    expect(NAME_READING, 'the name reading stops short of the package root').toContain(CONFIG);
    expect(LISTEN_READING.some(within(SCRIPTS)), 'the listen reading stops short of the scripts directory').toBe(true);
  });

  it('finds the package named, and a server listened on, in no other file', () => {
    const offending = (reading: string[], pattern: RegExp, says: string): string[] =>
      reading
        .filter((file) => file !== HARNESS && pattern.test(fs.readFileSync(file, 'utf8')))
        .map((file) => `${path.relative(process.cwd(), file)} ${says}`);
    const offenders = [
      ...offending(NAME_READING, NAMES_SUPERTEST, 'names the package'),
      ...offending(LISTEN_READING, LISTENS, 'listens'),
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
    const collects = (file: string): boolean => COLLECTED.test(path.basename(file));
    expect(FILES.filter(collects)).toContain(path.join(ROOT, 'loopback.test.ts'));
    const outside = FILES.filter((file) => !within(ROOT)(file));
    expect(outside, 'the reading for collected files stops short of the package root').toContain(CONFIG);
    expect(outside.filter(collects).map((file) => path.relative(process.cwd(), file))).toEqual([]);
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
