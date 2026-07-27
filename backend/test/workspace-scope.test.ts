/**
 * The workspace scoping mechanism itself (src/db/workspace.ts).
 *
 * Scoping is implicit - the workspace rides in AsyncLocalStorage rather than in
 * every db signature - so the guarantees that make that safe are not visible to
 * the compiler and have to be asserted here instead:
 *  - a db call with no context throws, rather than quietly running unscoped;
 *  - an explicit runWithWorkspace() always beats the test fallback;
 *  - the test fallback cannot be armed in production.
 */
import { describe, expect, it } from 'vitest';
import {
  currentWorkspaceId,
  dbInstance,
  getSetting,
  listAccounts,
  listIncomeSources,
  runWithWorkspace,
  seedDefaults,
  setWorkspaceFallback,
} from '../src/db';
import { createWorkspace, TEST_WORKSPACE_ID } from './pglite';

describe('workspace scoping', () => {
  it('a db call with no workspace context throws instead of running unscoped', async () => {
    setWorkspaceFallback(undefined);
    try {
      await expect(listAccounts()).rejects.toThrow(/no workspace context/);
    } finally {
      // the fallback is process-wide: leaving it cleared would break the rest of the run
      setWorkspaceFallback(TEST_WORKSPACE_ID);
    }
  });

  it('runWithWorkspace wins over the fallback and restores it on the way out', () => {
    expect(currentWorkspaceId()).toBe(TEST_WORKSPACE_ID);
    runWithWorkspace('other-workspace', () => {
      expect(currentWorkspaceId()).toBe('other-workspace');
    });
    expect(currentWorkspaceId()).toBe(TEST_WORKSPACE_ID);
  });

  it('nested contexts scope to the innermost workspace', () => {
    runWithWorkspace('outer', () => {
      runWithWorkspace('inner', () => {
        expect(currentWorkspaceId()).toBe('inner');
      });
      expect(currentWorkspaceId()).toBe('outer');
    });
  });

  it('the context survives an await inside the callback', async () => {
    await runWithWorkspace('async-workspace', async () => {
      await Promise.resolve();
      expect(currentWorkspaceId()).toBe('async-workspace');
    });
  });

  it('env personal data seeds the owner workspace only', async () => {
    // OWNER_NAMES/FAMILY_NAMES in .env are the server operator's own household
    // names. The owner workspace (the first one created - here the test one, seeded
    // by setup.ts) is entitled to them; anyone else registering on the same server
    // must start empty, or a stranger inherits the operator's personal data.
    expect(JSON.parse((await getSetting('owner_names'))!)).toEqual(['Yurii Kalvenko', 'Yuriy Kalvenko']);
    const family = (await listIncomeSources()).find((s) => s.id === 'family');
    expect(family!.patterns).toEqual(['ANNA BECKER', 'Becker Anna']);

    const newcomer = 'seed-newcomer-workspace';
    await createWorkspace(dbInstance() as never, newcomer);
    await runWithWorkspace(newcomer, async () => {
      await seedDefaults();
      expect(JSON.parse((await getSetting('owner_names'))!)).toEqual([]);
      expect((await listIncomeSources()).find((s) => s.id === 'family')!.patterns).toEqual([]);
      // non-personal deployment defaults still apply
      expect(await getSetting('base_currency')).toBe('EUR');
    });
  });

  it('arming the fallback is refused in production', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => setWorkspaceFallback('sneaky-workspace')).toThrow(/test-only hook/);
      // clearing stays allowed: it can only ever make scoping stricter
      expect(() => setWorkspaceFallback(undefined)).not.toThrow();
    } finally {
      process.env.NODE_ENV = before;
      setWorkspaceFallback(TEST_WORKSPACE_ID);
    }
  });
});
