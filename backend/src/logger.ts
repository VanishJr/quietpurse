import pino from 'pino';
import { config } from './config';

const pretty = config.logPretty ?? Boolean(process.stdout.isTTY);

export const logger = pino({
  level: config.logLevel,
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

/**
 * An error and everything it wraps, as one line, because what an operator actually
 * reads is the rendered message rather than the structured fields beside it.
 *
 * Log-only: this carries paths and errnos, so it must never be spliced into a message
 * a user sees. The walk is bounded and remembers what it has visited. A wrapper whose
 * cause points back at an ancestor is not exotic, and a log helper that loops is a hang
 * in the failure path.
 *
 * Not for a drizzle error: there the outer message is the whole statement with its
 * bound parameters, so fxrates.ts keeps sqlReason(), which takes the innermost reason
 * and its SQLSTATE alone.
 */
export function causeChain(err: unknown, maxDepth = 8): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && parts.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}

/**
 * The same chain, with the REASON first, for the one line a person reads off a
 * console when the app refuses to start.
 *
 * causeChain reports outermost first, which is right for a log entry somebody is
 * reading deliberately and wrong here. drizzle-orm wraps every driver error, so its
 * message is the whole failed statement and every bound value. The sentence that says
 * what went wrong, such as the permission, the errno or the relation that already
 * exists, sits behind all of it. A failed migration reads `Failed query: CREATE
 * TABLE "accounts" (...); params: : relation "accounts" already exists`, and only
 * its last clause is news.
 *
 * A part already contained in the one that wraps it is dropped rather than printed
 * twice. A thrower may compose its own cause into its own message, and that is the
 * house style for a boot check, because the message has to stand alone. Without the
 * drop, such a thrower would say the errno at both ends.
 */
export function reasonFirst(err: unknown, maxDepth = 8): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && parts.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (!parts.some((kept) => kept.includes(message))) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.reverse().join(': ');
}

export const logDb = logger.child({ mod: 'db' });
export const logSync = logger.child({ mod: 'sync' });
export const logClassify = logger.child({ mod: 'classify' });
export const logFx = logger.child({ mod: 'fx' });
export const logHttp = logger.child({ mod: 'http' });
export const logImport = logger.child({ mod: 'import' });
