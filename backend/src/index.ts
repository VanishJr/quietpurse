import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { app } from './app';
import { reclassifyIfRulesChanged } from './classify';
import { config } from './config';
import { closeDatabase, connectDatabase, seedDefaults } from './db';
import { backfillBaseAmounts } from './fxrates';
import { logClassify, logger, reasonFirst } from './logger';
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE, assertStorageWritable } from './storage';

const LOCK_FILE = path.join(config.home, 'finto.lock');

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The embedded database is one process's: a second Finto opened on the same folder
 * writes over the first's files with nothing refusing it, so the refusal is here.
 *
 * The claim is `wx` - create, or fail because it exists - because read-then-write is
 * not a claim at all: two Fintos started together both read nothing and both write,
 * and the second one wins a folder the first is already using. Everything else here
 * is what happens after the claim is refused, and none of it is the claim.
 *
 * A file left behind by a SIGKILL is a QUESTION about the pid inside it, never a
 * verdict: a dead pid means the file is stale and is dropped, and a live one refuses
 * with the way out written into the sentence - because an unrelated process can be
 * handed that number by the operating system and this cannot tell the difference.
 */
async function acquireLock(): Promise<void> {
  if (config.databaseUrl) return;
  await fs.mkdir(config.home, { recursive: true, mode: OWNER_ONLY_DIR });
  // twice, and no more: one pass to claim, one to claim what a dead holder left. A
  // third would be a spin against another Finto starting at the same instant
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(LOCK_FILE, String(process.pid), { flag: 'wx', mode: OWNER_ONLY_FILE });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = await fs.readFile(LOCK_FILE, 'utf8').catch(() => undefined);
    const pid = held === undefined ? NaN : parseInt(held, 10);
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) {
      throw new Error(
        `another Finto (pid ${pid}) is already running on ${config.home} - stop it first, or delete ${LOCK_FILE} if that process is gone`,
      );
    }
    await fs.rm(LOCK_FILE, { force: true });
  }
  throw new Error(
    `could not claim ${LOCK_FILE}: another Finto took it while this one was starting - start again`,
  );
}

async function main(): Promise<void> {
  await acquireLock();
  await assertStorageWritable();
  await connectDatabase();
  await seedDefaults();

  // In the background: the recompute fetches exchange rates and must not delay the
  // start. If the rules did not change, still backfill base_amount - some rows may
  // have been left without a rate when the provider was unavailable.
  void (async () => {
    const done = await reclassifyIfRulesChanged();
    if (done) logClassify.info('re-tagged every transaction with the new rules');
    else await backfillBaseAmounts();
  })().catch((e: Error) => logClassify.error(`recompute failed: ${e.message}`));

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Finto is at http://localhost:${config.port}`);
    logger.info(`your data is in ${config.home}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const net of list || []) {
          if (net.family === 'IPv4' && !net.internal) {
            logger.info(`on the local network: http://${net.address}:${config.port}`);
          }
        }
      }
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    logger.error(
      e.code === 'EADDRINUSE'
        ? `port ${config.port} is taken - stop what holds it, or start with PORT=<another port>`
        : `could not listen: ${e.message}`,
    );
    void shutdown(1);
  });

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.close();
    await closeDatabase().catch((e: Error) => logger.error(`closing the database: ${e.message}`));
    if (!config.databaseUrl) await fs.rm(LOCK_FILE, { force: true }).catch(() => undefined);
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
}

// reasonFirst and not e.message: drizzle wraps every driver error, so the message is
// the whole failed statement with every bound value in it, and the reason - the
// permission, the missing folder, the relation that already exists - is on e.cause.
// This is one line on a console and the person reads the front of it.
void main().catch((e: Error) => {
  logger.error(`startup failed: ${reasonFirst(e)}`);
  process.exit(1);
});
