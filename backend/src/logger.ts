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

/**
 * An error and everything it wraps, as one line, because what an operator actually
 * reads is the rendered message rather than the structured fields beside it.
 *
 * Log-only: this carries paths and errnos, so it must never be spliced into a message
 * a user sees. The walk is bounded and remembers what it has visited - a wrapper whose
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

export const logDb = logger.child({ mod: 'db' });
export const logSync = logger.child({ mod: 'sync' });
export const logClassify = logger.child({ mod: 'classify' });
export const logFx = logger.child({ mod: 'fx' });
export const logHttp = logger.child({ mod: 'http' });
export const logImport = logger.child({ mod: 'import' });
