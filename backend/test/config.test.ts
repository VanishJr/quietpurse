/**
 * src/config reads the environment once per process, and this process has read it
 * already, so a start on a different environment is a child of its own.
 */
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { hostRefusal, readSettings } from '../src/config';

const CHANGE_IT = 'Change it in backend/.env or in the environment you start the server from';

const refusal = (name: string, value: string, expected: string, empty: string): string =>
  `${name} is ${value}, but it must be ${expected}. ${CHANGE_IT}, or leave it empty to ${empty}`;

const DEFAULTS = {
  port: 4000,
  baseCurrency: 'EUR',
  fxProvider: 'auto',
  logLevel: 'info',
  logPretty: undefined,
  refused: [],
};

const LEVELS = 'trace, debug, info, warn, error, fatal or silent';

describe('a setting the environment gives', () => {
  it('takes the default when it is unset or empty', () => {
    expect(readSettings({})).toEqual(DEFAULTS);
    expect(
      readSettings({ PORT: '', BASE_CURRENCY: '  ', FX_PROVIDER: '', LOG_LEVEL: '', LOG_PRETTY: '' }),
    ).toEqual(DEFAULTS);
  });

  it('reads a value it can read', () => {
    expect(
      readSettings({ PORT: ' 4317 ', BASE_CURRENCY: ' usd ', FX_PROVIDER: 'ECB', LOG_LEVEL: 'Debug', LOG_PRETTY: '0' }),
    ).toEqual({ port: 4317, baseCurrency: 'USD', fxProvider: 'ecb', logLevel: 'debug', logPretty: false, refused: [] });
    expect(readSettings({ LOG_LEVEL: 'silent', LOG_PRETTY: '1' })).toMatchObject({ logLevel: 'silent', logPretty: true });
  });

  it.each([
    ['BASE_CURRENCY', 'EURO', 'a three-letter code such as EUR or USD', 'use EUR'],
    ['BASE_CURRENCY', '€', 'a three-letter code such as EUR or USD', 'use EUR'],
    ['FX_PROVIDER', 'ecbb', 'auto, ecb or nbu', 'use auto'],
    ['PORT', 'abc', 'a whole number from 1 to 65535', 'use 4000'],
    ['PORT', '4000abc', 'a whole number from 1 to 65535', 'use 4000'],
    ['PORT', '0', 'a whole number from 1 to 65535', 'use 4000'],
    ['PORT', '65536', 'a whole number from 1 to 65535', 'use 4000'],
    ['LOG_LEVEL', 'verbose', LEVELS, 'use info'],
    ['LOG_PRETTY', 'yes', '1 or 0', 'get pretty output in a terminal only'],
  ])('refuses %s set to %j, and says what to write instead', (name, value, expected, empty) => {
    expect(readSettings({ [name]: value }).refused).toEqual([refusal(name, `"${value}"`, expected, empty)]);
  });

  it('names every setting it refuses, not only the first', () => {
    expect(readSettings({ BASE_CURRENCY: 'EURO', FX_PROVIDER: 'ecbb' }).refused).toEqual([
      refusal('BASE_CURRENCY', '"EURO"', 'a three-letter code such as EUR or USD', 'use EUR'),
      refusal('FX_PROVIDER', '"ecbb"', 'auto, ecb or nbu', 'use auto'),
    ]);
  });

  it('quotes a long value by its length alone, since it may be another setting with a password in it', () => {
    const pasted = 'postgres://me:secret@localhost:5432/quietpurse';
    const [said] = readSettings({ PORT: pasted }).refused;
    expect(said).toBe(refusal('PORT', `a value of ${pasted.length} characters`, 'a whole number from 1 to 65535', 'use 4000'));
    expect(said).not.toContain('secret');
    expect(readSettings({ BASE_CURRENCY: 'E'.repeat(40) }).refused[0]).toContain(`"${'E'.repeat(40)}"`);
  });
});

describe('an address listen could not take', () => {
  const said = (host: string): string =>
    `QUIETPURSE_HOST is "${host}", but it must be an address of this machine, or 0.0.0.0 for every network interface. ${CHANGE_IT}, or leave it empty to keep the app to this machine only`;

  it('names QUIETPURSE_HOST for an address this machine lacks and for a name that does not resolve', () => {
    expect(hostRefusal('EADDRNOTAVAIL', '192.0.2.1')).toBe(said('192.0.2.1'));
    expect(hostRefusal('EADDRNOTAVAIL', 'fe80::1')).toBe(said('fe80::1'));
    expect(hostRefusal('ENOTFOUND', 'nas.invalid')).toBe(said('nas.invalid'));
  });

  it('leaves the setting out when it is not the cause', () => {
    expect(hostRefusal('EADDRINUSE', '0.0.0.0')).toBeUndefined();
    expect(hostRefusal('EACCES', '0.0.0.0')).toBeUndefined();
    expect(hostRefusal('EADDRNOTAVAIL', '')).toBeUndefined();
  });
});

/** The server started in a folder of its own, with what it logged, and at error level and above. */
const start = (
  env: NodeJS.ProcessEnv,
): { status: number | null; said: string[]; errors: string[]; home: string[]; output: string } => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quietpurse-config-'));
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        // every setting the assertions read, so neither the shell nor backend/.env adds one
        QUIETPURSE_HOME: home,
        QUIETPURSE_HOST: '',
        DOCUMENT_STORE_PATH: '',
        DATABASE_URL: '',
        PORT: '45177',
        BASE_CURRENCY: '',
        FX_PROVIDER: '',
        LOG_LEVEL: 'info',
        LOG_PRETTY: '0',
        ...env,
      },
    });
    const lines = child.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { level: number; msg: string });
    return {
      status: child.status,
      said: lines.map((line) => line.msg),
      errors: lines.filter((line) => line.level >= 50).map((line) => line.msg),
      home: fs.readdirSync(home),
      output: child.stdout + child.stderr,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe('the address the server listens on', () => {
  it('is QUIETPURSE_HOST trimmed, the same text a refusal would name', () => {
    const child = spawnSync(
      process.execPath,
      // require and not import(): Node 22 imports this CommonJS module with no named exports
      ['--import', 'tsx', '-e', "console.log(JSON.stringify(require('./src/config').config.host))"],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, QUIETPURSE_HOST: ' 0.0.0.0 ' } },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toBe('0.0.0.0');
  }, 30_000);
});

describe('a start the environment cannot serve', () => {
  it('stops on settings it cannot read before it takes the lock or opens the database, and says why', () => {
    // the log level among them, because the logger is what has to say it
    const run = start({ BASE_CURRENCY: 'EURO', LOG_LEVEL: 'verbose' });

    expect(run.status, run.output).toBe(1);
    expect(run.errors).toEqual([
      `startup failed: ${[
        refusal('BASE_CURRENCY', '"EURO"', 'a three-letter code such as EUR or USD', 'use EUR'),
        refusal('LOG_LEVEL', '"verbose"', LEVELS, 'use info'),
      ].join('. ')}`,
    ]);
    expect(run.home).toEqual([]);
  }, 60_000);

  it('stops on an address it cannot listen on, names QUIETPURSE_HOST, and lets go of the lock', () => {
    const run = start({ QUIETPURSE_HOST: '192.0.2.1' });

    expect(run.status, run.output).toBe(1);
    expect(run.said.filter((msg) => msg.startsWith('Quietpurse is at') || msg.startsWith('on the local network'))).toEqual([]);
    expect(run.errors).toEqual([
      `QUIETPURSE_HOST is "192.0.2.1", but it must be an address of this machine, or 0.0.0.0 for every network interface. ${CHANGE_IT}, or leave it empty to keep the app to this machine only`,
    ]);
    expect(run.home).not.toContain('quietpurse.lock');
  }, 60_000);
});
