import { expect, it } from 'vitest';

const sentinel = (() => Promise.reject(new Error('the previous case mock'))) as typeof fetch;

it('leaves a fetch mock of its own in place when it ends', () => {
  // not restored here, and this file has no hook: only the setup file's after hooks
  // stand between this mock and the next case
  globalThis.fetch = sentinel;
});

it('starts offline whatever mock the case before it left behind', async () => {
  expect(globalThis.fetch, 'the idle hook left the previous case mock in place').not.toBe(sentinel);
  await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('network disabled in tests');
});
