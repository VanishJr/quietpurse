/**
 * Process entry point: connect the database, wire up auth, bring every workspace
 * up to date, then start listening. The application itself (middleware + routes)
 * lives in app.ts, which stays importable without any of this happening - that is
 * what lets the HTTP tests drive the real middleware chain.
 */
import os from 'os';
import { app } from './app';
import { initAuth } from './auth';
import { reclassifyIfRulesChanged } from './classify';
import { assertProductionConfig, config } from './config';
import {
  connectDatabase,
  dbInstance,
  listWorkspaceIds,
  runWithWorkspace,
  seedDefaults,
} from './db';
import { backfillBaseAmounts } from './fxrates';
import { logClassify, logger } from './logger';
import { assertStorageWritable } from './storage';

async function main(): Promise<void> {
  // refuse to boot a production server on dev secrets - before anything listens
  assertProductionConfig();

  // and refuse to boot with a document store nobody can write to: the failure it
  // catches is a volume that arrives owned by root while the container runs as
  // `node`, which is otherwise discovered by the first user whose import is refused
  await assertStorageWritable();

  // connect + migrate before anything touches the data layer; auth needs the db
  await connectDatabase();
  initAuth(dbInstance());

  const workspaces = await listWorkspaceIds();

  // upgrade path: a new builtin setting/income source added in this version must
  // appear in workspaces seeded by older versions (seedDefaults is idempotent)
  for (const w of workspaces) {
    await runWithWorkspace(w, seedDefaults);
  }

  // the categorization/transfer rules changed since the last run - recompute each
  // workspace. In the background: the recompute fetches exchange rates and must not
  // delay startup. If the rules did not change, still backfill base_amount: some rows
  // may have been left without a rate (the provider was unavailable last time).
  void (async () => {
    for (const w of workspaces) {
      await runWithWorkspace(w, async () => {
        const done = await reclassifyIfRulesChanged();
        if (done) logClassify.info(`workspace ${w}: re-tagged with the new rules`);
        else await backfillBaseAmounts();
      });
    }
  })().catch((e: Error) => logClassify.error(`recompute failed: ${e.message}`));

  app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Finto backend: http://localhost:${config.port}`);
    // The LAN addresses (for opening the app on a phone) are debug-level: on a
    // dev machine most of them belong to virtual adapters - WSL, Docker,
    // VirtualBox - and finding the one real address among five is not worth five
    // lines on every start. LOG_LEVEL=debug brings them back.
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) {
          logger.debug(`on the local network: http://${net.address}:${config.port} (for a phone)`);
        }
      }
    }
  });
}

void main().catch((e: Error) => {
  logger.error(`startup failed: ${e.message}`);
  process.exit(1);
});
