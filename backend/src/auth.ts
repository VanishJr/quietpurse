/**
 * better-auth: email+password registration and login with cookie sessions, plus
 * the organization plugin as the workspace model.
 *
 * Kept deliberately minimal for the prototype:
 *  - roles are only owner/member, no permission matrix - membership in a workspace
 *    grants full access to its data (companies are out of scope);
 *  - every new user gets a personal workspace right at registration, seeded the
 *    same way the old initial migration seeded the single-user database;
 *  - the session's activeOrganizationId is set at sign-in to the user's first
 *    workspace, so the API middleware always has a workspace to scope to.
 *
 * The auth instance needs a live db handle, so it is created after
 * connectDatabase() (see initAuth in main()); tests build their own from PGlite.
 */
import crypto from 'crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization as organizationPlugin } from 'better-auth/plugins';
import { config } from './config';
import { listUserWorkspaceIds, runWithWorkspace, seedDefaults, type Db } from './db';
import * as s from './db/schema';

/**
 * Creates the user's personal workspace and seeds it.
 *
 * Lives outside createAuth() because it has two callers: the registration hook
 * below, and the session middleware, which repairs a user who somehow has no
 * workspace. The hook is NOT in the same transaction as the user row - better-auth
 * owns that insert - so a failure here (or a crash between the two) would
 * otherwise strand an account that can never make an API call again. Repairing on
 * demand turns a permanent 403 into a self-healing one.
 */
export async function createPersonalWorkspace(db: Db, userId: string): Promise<string> {
  const workspaceId = crypto.randomUUID();
  await db.insert(s.organization).values({
    id: workspaceId,
    name: 'Personal',
    slug: `personal-${workspaceId.slice(0, 8)}`,
    createdAt: new Date(),
  });
  await db.insert(s.member).values({
    id: crypto.randomUUID(),
    organizationId: workspaceId,
    userId,
    role: 'owner',
    createdAt: new Date(),
  });
  await runWithWorkspace(workspaceId, () => seedDefaults());
  return workspaceId;
}

/** Ensures the user has at least one workspace; returns the one to scope to. */
export async function ensureWorkspace(db: Db, userId: string): Promise<string> {
  const existing = await listUserWorkspaceIds(userId);
  return existing[0] ?? (await createPersonalWorkspace(db, userId));
}

export function createAuth(db: Db) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: s.user,
        session: s.session,
        account: s.authAccount,
        verification: s.verification,
        organization: s.organization,
        member: s.member,
        invitation: s.invitation,
      },
    }),
    secret: config.authSecret,
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    // origins allowed to send authenticated requests (the dev web client among them)
    trustedOrigins: config.corsOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    /**
     * Throttles the credential endpoints. Without this, sign-in is an unmetered
     * password oracle: scrypt makes a single guess slow, but nothing stops a
     * thousand of them in parallel against a leaked email list.
     *
     * Off under NODE_ENV=test - the HTTP suite registers and signs in far faster
     * than any human, and a 429 mid-suite would be a flaky failure, not a finding.
     */
    rateLimit: {
      enabled: process.env.NODE_ENV !== 'test',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 3600, max: 10 },
      },
    },
    plugins: [
      // only the schema + membership model behind workspace scoping; the
      // invitation flow is unused until multi-user workspaces land
      organizationPlugin(),
    ],
    databaseHooks: {
      user: {
        create: {
          // the personal workspace: created and seeded in the same breath as the
          // user, so the very first API request after registration has data scope
          after: async (user) => {
            await createPersonalWorkspace(db, user.id);
          },
        },
      },
      session: {
        create: {
          // every fresh session starts in the user's first (personal) workspace
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: (await listUserWorkspaceIds(session.userId))[0] ?? null,
            },
          }),
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

/** Called once at startup, after the database is connected (and by the test setup). */
export function initAuth(db: Db): Auth {
  auth = createAuth(db);
  return auth;
}

export function getAuth(): Auth {
  if (!auth) throw new Error('auth not initialized - call initAuth() after connectDatabase()');
  return auth;
}
