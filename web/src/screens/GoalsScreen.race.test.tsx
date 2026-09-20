import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SAVINGS_GOAL } from '../test/fixtures';
import { mockFetch, ok, renderThemed } from '../test/harness';
import { GoalsScreen } from './GoalsScreen';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('GoalsScreen request ordering', () => {
  it('does not let an older load overwrite a newer data revision', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let reads = 0;
    mockFetch({
      'GET /api/goals': () => (reads++ === 0 ? first.promise : second.promise),
    });

    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Refresh goals</button>
          <GoalsScreen reloadToken={revision} />
        </>
      );
    };
    renderThemed(<Host />);
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh goals' }));
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => {
      second.resolve(
        ok({ goals: [{ ...SAVINGS_GOAL, id: 'fresh-goal', name: 'Fresh goal' }] }),
      );
    });
    expect(await screen.findByRole('heading', { name: 'Fresh goal' })).toBeVisible();

    await act(async () => {
      first.resolve(
        ok({ goals: [{ ...SAVINGS_GOAL, id: 'stale-goal', name: 'Stale goal' }] }),
      );
    });
    expect(screen.getByRole('heading', { name: 'Fresh goal' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Stale goal' })).not.toBeInTheDocument();
  });
});
