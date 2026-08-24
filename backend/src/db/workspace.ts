import { AsyncLocalStorage } from 'async_hooks';

const als = new AsyncLocalStorage<string>();

/** Tests/scripts only: the workspace used when no runWithWorkspace() is active. */
let fallbackWorkspaceId: string | undefined;

/** The guard fires only when NODE_ENV is exactly 'production': every other value, set or unset, leaves it inert. */
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
