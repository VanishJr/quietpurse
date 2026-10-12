import 'dotenv/config';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { CURRENCY_CODE } from './currency';

const FX_PROVIDERS = ['auto', 'ecb', 'nbu'] as const;
type FxProvider = (typeof FX_PROVIDERS)[number];

const LOG_LEVELS = [...Object.keys(pino.levels.values), 'silent'];

const CHANGE_IT = 'Change it in backend/.env or in the environment you start the server from';

/**
 * A value is quoted back only while it is short: a long one is more likely another
 * setting pasted into the wrong line, and a connection string carries its password.
 */
const QUOTE_MAX = 40;
const shown = (text: string): string =>
  text.length <= QUOTE_MAX ? `"${text}"` : `a value of ${text.length} characters`;

const either = (names: readonly string[]): string => `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

/**
 * The settings with a fixed set of readings. Unset or empty takes the default; anything
 * else set is read or refused. A refused setting still holds its default here, only so
 * that importing this module never throws: the logger takes its level from it and has
 * to be there to say why the start stops. index.ts refuses the start on `refused`.
 */
export function readSettings(env: NodeJS.ProcessEnv): {
  port: number;
  baseCurrency: string;
  fxProvider: FxProvider;
  logLevel: string;
  logPretty: boolean | undefined;
  refused: string[];
} {
  const refused: string[] = [];
  const setting = <T>(
    name: string,
    fallback: T,
    expected: string,
    read: (text: string) => T | undefined,
    empty = `use ${String(fallback)}`,
  ): T => {
    const text = (env[name] ?? '').trim();
    if (text === '') return fallback;
    const value = read(text);
    if (value !== undefined) return value;
    refused.push(`${name} is ${shown(text)}, but it must be ${expected}. ${CHANGE_IT}, or leave it empty to ${empty}`);
    return fallback;
  };
  const port = setting('PORT', 4000, 'a whole number from 1 to 65535', (text) =>
    /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : undefined,
  );
  // the account doors' pattern: an account created without a currency takes this value
  // unchecked
  const baseCurrency = setting('BASE_CURRENCY', 'EUR', 'a three-letter code such as EUR or USD', (text) =>
    CURRENCY_CODE.test(text) ? text.toUpperCase() : undefined,
  );
  const fxProvider = setting<FxProvider>('FX_PROVIDER', 'auto', either(FX_PROVIDERS), (text) =>
    FX_PROVIDERS.find((name) => name === text.toLowerCase()),
  );
  const logLevel = setting('LOG_LEVEL', 'info', either(LOG_LEVELS), (text) =>
    LOG_LEVELS.find((name) => name === text.toLowerCase()),
  );
  const logPretty = setting<boolean | undefined>(
    'LOG_PRETTY',
    undefined,
    '1 or 0',
    (text) => (text === '1' ? true : text === '0' ? false : undefined),
    'get pretty output in a terminal only',
  );
  return { port, baseCurrency, fxProvider, logLevel, logPretty, refused };
}

const settings = readSettings(process.env);

/** What the start refuses with, one sentence per setting; empty when every one read. */
export const configRefused: readonly string[] = settings.refused;

/** Trimmed as every setting above is, so the address listen gets is the one a refusal names. */
const hostGiven = (process.env.QUIETPURSE_HOST ?? '').trim();

/** listen's codes for an address this machine does not have, and for a name that does not resolve. */
const NOT_HERE = new Set(['EADDRNOTAVAIL', 'ENOTFOUND']);

/**
 * Why listen could not take QUIETPURSE_HOST, or undefined when the setting is not the
 * cause. Not checked when read: a check of its form would refuse an IPv6 address or a
 * host name that is right, and only the attempt to listen can tell.
 */
export function hostRefusal(code: string | undefined, host = hostGiven): string | undefined {
  if (host === '' || code === undefined || !NOT_HERE.has(code)) return undefined;
  return `QUIETPURSE_HOST is ${shown(host)}, but it must be an address of this machine, or 0.0.0.0 for every network interface. ${CHANGE_IT}, or leave it empty to keep the app to this machine only`;
}

/**
 * Everything Quietpurse keeps, in one folder the person can open. It is resolved here and
 * only here. A relative QUIETPURSE_HOME would otherwise land the database under whatever
 * directory the process was started from and the statements under backend/, which is
 * two folders and not one, for exactly the input that reads as convenient.
 */
const home = path.resolve(process.env.QUIETPURSE_HOME || path.join(os.homedir(), 'Quietpurse'));

export const config = {
  port: settings.port,
  /**
   * Loopback unless told otherwise: there is no sign-in, so a server reachable from
   * the network is a database reachable from the network.
   *
   * QUIETPURSE_HOST and deliberately not HOST. `HOST` is a name other software owns,
   * such as shells, container images and PaaS wrappers. Reading it lets an environment
   * nobody wrote for this app both open the port and widen the Host check, with no
   * line typed by the owner and nothing but a log line to show for it. A namespaced
   * name can only arrive on purpose.
   */
  host: hostGiven || '127.0.0.1',
  home,
  baseCurrency: settings.baseCurrency,
  /** auto tries each provider in turn; ecb or nbu forces one. */
  fxProvider: settings.fxProvider,
  logLevel: settings.logLevel,
  /** undefined is pretty output in a terminal only. */
  logPretty: settings.logPretty,
  /** Comma-separated, every spelling banks use ("Yurii Kalvenko, Yuriy Kalvenko"). */
  ownerNames: (process.env.OWNER_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  familyNames: (process.env.FAMILY_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Set, and Quietpurse uses that PostgreSQL server instead of the embedded database. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /** The embedded database: a PGlite data directory. */
  databaseDir: path.join(home, 'db'),
  documentStorePath: process.env.DOCUMENT_STORE_PATH || path.join(home, 'statements'),
};
