/** Registry of the providers taking part in periodic syncing. */
import { config } from '../config';
import { ebConfigured, syncEnableBanking } from './enablebanking';
import { syncMonobank } from './monobank';
import { SyncProvider } from './provider';

export const SYNC_PROVIDERS: SyncProvider[] = [
  // Enable Banking first - it is fast; Monobank after (it waits out its 1 req/60 s limit)
  { key: 'enablebanking', configured: ebConfigured, sync: syncEnableBanking },
  { key: 'monobank', configured: () => Boolean(config.monobankToken), sync: syncMonobank },
];
