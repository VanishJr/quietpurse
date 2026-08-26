import 'dotenv/config';

const port = parseInt(process.env.PORT || '4000', 10);

/**
 * Named rather than inlined so assertProductionConfig() can recognise it: a deployed
 * server still on this key lets anyone who has read the source forge session cookies.
 */
const DEV_AUTH_SECRET = 'finto-dev-secret-change-me';

/** The password the docker-compose postgres uses when none is configured. */
const DEV_DB_PASSWORD = 'finto';

/**
 * Named for the same reason: a deployed server still on this key has its users' bank
 * statements readable by anyone who has read the source.
 */
const DEV_DOCUMENT_KEY = 'finto-dev-document-key-change-me';

export const config = {
  port,
  /**
   * The dev fallback keeps `npm run dev` working out of the box; ANY real deployment
   * must set its own.
   */
  authSecret: process.env.BETTER_AUTH_SECRET || DEV_AUTH_SECRET,
  /**
   * Empty means anyone who can reach the server can register - fine on a laptop, not
   * on a public host.
   */
  signupInviteCode: process.env.SIGNUP_INVITE_CODE || '',
  /** The address as browsers see it: cookie and redirect URLs are built from it. */
  baseUrl: process.env.BETTER_AUTH_URL || `http://localhost:${port}`,
  /** Origins allowed to call the API with credentials, for the CORS allowlist and better-auth alike. */
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
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
  /** The default matches the postgres service in docker-compose.yml. */
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://finto:finto@localhost:5432/finto',
  /**
   * The default is where docker-compose mounts the documents volume, so it is also the
   * correct production value - which is why there is no production guard on it.
   */
  documentStorePath: process.env.DOCUMENT_STORE_PATH || './data/documents',
  /**
   * The dev fallback keeps `npm run dev` and the tests working out of the box; a real
   * deployment must set its own, and losing or changing it makes every document already
   * written unreadable - there is no way to hold the old key and the new one at once.
   */
  documentEncryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY || DEV_DOCUMENT_KEY,
};

/**
 * Only enforced under NODE_ENV=production (the Dockerfile sets it) - `npm run dev` and
 * the tests keep working out of the box, which is the whole point of the defaults.
 * Deploying outside the container? Set NODE_ENV=production yourself, exactly as with
 * setWorkspaceFallback() in db/workspace.ts.
 */
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (config.authSecret === DEV_AUTH_SECRET) {
    problems.push(
      'BETTER_AUTH_SECRET is unset, so sessions are signed with the public dev key - anyone can forge a login cookie. Generate one: openssl rand -base64 32',
    );
  }
  if (new URL(config.baseUrl).protocol !== 'https:' && !isLocal(config.baseUrl)) {
    problems.push(
      `BETTER_AUTH_URL is ${config.baseUrl}: without https the session cookie is not marked Secure and travels in clear text. Terminate TLS in front of the backend and point this at the https address.`,
    );
  }
  if (config.documentEncryptionKey === DEV_DOCUMENT_KEY) {
    problems.push(
      'DOCUMENT_ENCRYPTION_KEY is unset, so every stored bank statement is sealed with the public dev key - anyone who has read the source can decrypt them. Generate one: openssl rand -base64 32',
    );
  }
  if (dbPassword(config.databaseUrl) === DEV_DB_PASSWORD) {
    problems.push(
      'DATABASE_URL still carries the default password from docker-compose. Set POSTGRES_PASSWORD to something private (compose feeds it to both services).',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `refusing to start in production on development defaults:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

const isLocal = (url: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);

function dbPassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined; // not a URL we can parse - the driver will complain in its own words
  }
}
