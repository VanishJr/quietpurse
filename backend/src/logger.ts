/**
 * The backend's single logger (pino). Level from the LOG_LEVEL env var (info by
 * default), format JSON; with a live terminal (or LOG_PRETTY=1) - human-readable
 * output through pino-pretty.
 *
 * Each module gets its own child with a mod field: sync, classify, fx, http, db, import.
 */
import pino from 'pino';

const pretty = process.env.LOG_PRETTY === '1' || (process.stdout.isTTY && process.env.LOG_PRETTY !== '0');

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined, // no pid/hostname: one process, one host
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'mod' , messageFormat: '[{mod}] {msg}' },
        },
      }
    : {}),
});

export const logDb = logger.child({ mod: 'db' });
export const logSync = logger.child({ mod: 'sync' });
export const logClassify = logger.child({ mod: 'classify' });
export const logFx = logger.child({ mod: 'fx' });
export const logHttp = logger.child({ mod: 'http' });
export const logImport = logger.child({ mod: 'import' });
