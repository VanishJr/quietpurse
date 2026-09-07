import 'dotenv/config';
import os from 'os';
import path from 'path';

const port = parseInt(process.env.PORT || '4000', 10);

/**
 * Everything Finto keeps, in one folder the person can open - resolved here and only
 * here. A relative FINTO_HOME would otherwise land the database under whatever
 * directory the process was started from and the statements under backend/, which is
 * two folders and not one, for exactly the input that reads as convenient.
 */
const home = path.resolve(process.env.FINTO_HOME || path.join(os.homedir(), 'Finto'));

export const config = {
  port,
  /**
   * Loopback unless told otherwise: there is no sign-in, so a server reachable from
   * the network is a database reachable from the network.
   *
   * FINTO_HOST and deliberately not HOST. `HOST` is a name other software owns -
   * shells, container images, PaaS wrappers - and reading it lets an environment
   * nobody wrote for this app both open the port and widen the Host check, with no
   * line typed by the owner and nothing but a log line to show for it. A namespaced
   * name can only arrive on purpose.
   */
  host: process.env.FINTO_HOST || '127.0.0.1',
  home,
  baseCurrency: (process.env.BASE_CURRENCY || 'EUR').toUpperCase(),
  /** auto tries each provider in turn; ecb or nbu forces one. */
  fxProvider: (['auto', 'ecb', 'nbu'].includes(process.env.FX_PROVIDER || 'auto')
    ? process.env.FX_PROVIDER || 'auto'
    : 'auto') as 'auto' | 'ecb' | 'nbu',
  /** Comma-separated, every spelling banks use ("Yurii Kalvenko, Yuriy Kalvenko"). */
  ownerNames: (process.env.OWNER_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  familyNames: (process.env.FAMILY_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Set, and Finto uses that PostgreSQL server instead of the embedded database. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /** The embedded database: a PGlite data directory. */
  databaseDir: path.join(home, 'db'),
  documentStorePath: process.env.DOCUMENT_STORE_PATH || path.join(home, 'statements'),
};
