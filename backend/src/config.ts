import 'dotenv/config';

const port = parseInt(process.env.PORT || '4000', 10);

/**
 * The signing key `npm run dev` falls back to. Named so assertProductionConfig()
 * can recognise it: a deployed server still running on this key hands anyone who
 * has read the source the ability to forge session cookies.
 */
const DEV_AUTH_SECRET = 'finto-dev-secret-change-me';

/** The password the docker-compose postgres uses when none is configured. */
const DEV_DB_PASSWORD = 'finto';

/**
 * The document-sealing key `npm run dev` falls back to. Named so
 * assertProductionConfig() can recognise it: a deployed server still on this key
 * has its users' bank statements readable by anyone who has read the source.
 */
const DEV_DOCUMENT_KEY = 'finto-dev-document-key-change-me';

export const config = {
  port,
  /**
   * better-auth: the key session cookies are signed with. The dev fallback keeps
   * `npm run dev` working out of the box; ANY real deployment must set its own
   * (better-auth also logs a warning when the default is detected).
   */
  authSecret: process.env.BETTER_AUTH_SECRET || DEV_AUTH_SECRET,
  /**
   * Registration gate. Empty (the default) = anyone who can reach the server can
   * register - fine on a laptop, not on a public host. Set it and /api/auth/sign-up
   * requires the same value in the x-invite-code header; the web client asks for it
   * when GET /api/health reports signup: 'invite'.
   */
  signupInviteCode: process.env.SIGNUP_INVITE_CODE || '',
  /**
   * The backend's own address as browsers see it - better-auth builds cookie and
   * redirect URLs from it.
   */
  baseUrl: process.env.BETTER_AUTH_URL || `http://localhost:${port}`,
  /**
   * Origins allowed to call the API with credentials (CORS allowlist + better-auth
   * trustedOrigins). Needed only when the web client is served from a different
   * origin than the backend; the dev defaults cover the Vite dev server. With a
   * same-origin proxy in front (Vite dev, or the production static host proxying
   * /api) the browser never crosses origins and this list is not consulted.
   */
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Base currency of all totals (average spending, independence threshold, budgets).
   * SOURCE OF TRUTH — settings.base_currency (editable from the app); env is the
   * seed at the initial migration and a fallback. Each transaction gets a base_amount —
   * its value in this currency at the rate on its date (see fxrates.ts).
   */
  baseCurrency: (process.env.BASE_CURRENCY || 'EUR').toUpperCase(),
  /**
   * FX rate provider: auto (default) — ECB for the app's currencies, NBU for pairs
   * with the hryvnia; ecb / nbu — force a single provider (see fxrates.ts).
   */
  fxProvider: (['auto', 'ecb', 'nbu'].includes(process.env.FX_PROVIDER || 'auto')
    ? process.env.FX_PROVIDER || 'auto'
    : 'auto') as 'auto' | 'ecb' | 'nbu',
  /**
   * Account owner names, comma-separated — every spelling banks use
   * ("Yurii Kalvenko, Yuriy Kalvenko").
   * SOURCE OF TRUTH — the settings table (owner_names, editable from the app);
   * the env value is the seed at the initial migration and a fallback.
   * A transaction with all the words of one of these names in its description is a
   * transfer between your own accounts - neither income nor expense.
   */
  ownerNames: (process.env.OWNER_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Family member names. SOURCE OF TRUTH — the patterns of the family source in the
   * income_sources table (editable from the app); env is only the seed at the initial
   * migration. Works OPPOSITE to OWNER_NAMES: owner = "not income at all",
   * family = "income, but external" (kind = external).
   */
  familyNames: (process.env.FAMILY_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * PostgreSQL connection string. The default matches the postgres service in
   * docker-compose.yml. Tests don't use it - they inject a PGlite instance
   * (see db/index.ts initDb and test/setup.ts).
   */
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://finto:finto@localhost:5432/finto',
  /**
   * Where the uploaded statements themselves are kept (ROADMAP 4.5). A relative
   * path is resolved from backend/. The default is where docker-compose mounts the
   * documents volume, so it is also the correct production value - which is why
   * there is no production guard on it.
   */
  documentStorePath: process.env.DOCUMENT_STORE_PATH || './data/documents',
  /**
   * The secret every stored document is sealed with (AES-256-GCM, via HKDF - see
   * documents.ts, so any string of any length works). The dev fallback keeps
   * `npm run dev` and the tests working out of the box; a real deployment must set
   * its own, and losing or changing it makes every document already written
   * unreadable - there is no way to hold the old key and the new one at once.
   */
  documentEncryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY || DEV_DOCUMENT_KEY,
};

/**
 * Refuses to start a production server on development defaults. Called first
 * thing in main(), so the process dies with a readable message instead of coming
 * up quietly with forgeable sessions or a database anyone can guess into.
 *
 * Only enforced under NODE_ENV=production (the Dockerfile sets it) - `npm run dev`
 * and the tests keep working out of the box, which is the whole point of the
 * defaults. Deploying outside the container? Set NODE_ENV=production yourself,
 * exactly as with setWorkspaceFallback() in db/workspace.ts.
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
