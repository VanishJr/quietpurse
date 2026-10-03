import os from 'os';
import { app } from './app';
import { type Stale, reclassifyIfStale } from './classify';
import { config } from './config';
import { closeDatabase, connectDatabase, seedDefaults } from './db';
import { backfillBaseAmounts } from './fxrates';
import { acquireLock, releaseLock } from './lock';
import { logClassify, logger, reasonFirst } from './logger';
import { assertStorageWritable } from './storage';

const SAID: Record<Stale, string> = {
  rules: 're-tagged every transaction with the new rules',
  rows: 're-tagged every transaction: rows written before the last stop had not been re-tagged',
};

async function main(): Promise<void> {
  await acquireLock();
  await assertStorageWritable();
  await connectDatabase();
  await seedDefaults();

  // In the background: the recompute fetches exchange rates and must not delay the
  // start. If nothing was owed, still backfill base_amount - some rows may
  // have been left without a rate when the provider was unavailable.
  void (async () => {
    const stale = await reclassifyIfStale();
    if (stale) logClassify.info(SAID[stale]);
    else await backfillBaseAmounts();
  })().catch((e: Error) => logClassify.error(`recompute failed: ${reasonFirst(e)}`));

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
    await releaseLock();
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
