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

  // upgrade path: a builtin setting or income source added in this version must
  // reach workspaces that were seeded by an older one
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
    // debug-level and not info: on a dev machine most of these belong to virtual
    // adapters - WSL, Docker, VirtualBox - and the one real address is not worth
    // hunting for on every start
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
