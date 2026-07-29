/**
 * The current workspace, carried through async call chains with AsyncLocalStorage.
 *
 * Why implicit context and not a workspaceId parameter on every db function: the
 * data layer is called from ~10 modules (handlers, classify, sync, fxrates, statement),
 * and none of them make workspace decisions - the workspace is fixed once at the
 * boundary (the session middleware for requests, the scheduler for background
 * jobs). Threading the id through every signature would touch every caller for
 * zero information gain.
 *
 * Rules:
 *  - HTTP requests: the session middleware in index.ts wraps the handler chain in
 *    runWithWorkspace() with the workspace resolved from the session's membership;
 *  - background jobs (startup reclassify, auto-sync): explicitly pick a workspace
 *    (or iterate all of them) and wrap each run;
 *  - production code outside a context THROWS - a query can never silently run
 *    against the wrong workspace;
 *  - tests and one-off scripts may set a process-wide fallback instead.
 */
import { AsyncLocalStorage } from 'async_hooks';

const als = new AsyncLocalStorage<string>();

/** Tests/scripts only: the workspace used when no runWithWorkspace() is active. */
let fallbackWorkspaceId: string | undefined;

/**
 * Points every context-less db call at one workspace. This exists for tests and
 * one-off scripts, which call the data layer directly with no HTTP session to
 * derive a scope from.
 *
 * Refused under NODE_ENV=production (the Dockerfile sets it): a fallback left
 * standing on a real server would turn the loud "no workspace context" throw into
 * a silent query against somebody else's workspace - exactly the failure this
 * whole module exists to make impossible. Deploying outside the container? Set
 * NODE_ENV=production yourself, or this guard is inert.
 */
export function setWorkspaceFallback(workspaceId: string | undefined): void {
  if (process.env.NODE_ENV === 'production' && workspaceId !== undefined) {
    throw new Error(
      'setWorkspaceFallback() is a test-only hook and must never run in production - scope requests with runWithWorkspace() instead',
    );
  }
  fallbackWorkspaceId = workspaceId;
}

/** Runs fn with every db call inside scoped to the given workspace. */
export function runWithWorkspace<T>(workspaceId: string, fn: () => T): T {
  return als.run(workspaceId, fn);
}

/** The workspace all db queries are scoped to right now. Throws outside a context. */
export function currentWorkspaceId(): string {
  const id = als.getStore() ?? fallbackWorkspaceId;
  if (!id) {
    throw new Error(
      'no workspace context - db calls must run inside runWithWorkspace() (see db/workspace.ts)',
    );
  }
  return id;
}
