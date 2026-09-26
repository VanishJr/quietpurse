import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderThemed, requests, type Routes } from '../test/harness';
import type { IncomeSourceDef } from '../types';
import { IncomeSourcesBlock } from './IncomeSourcesBlock';

const source = (patch: Partial<IncomeSourceDef> = {}): IncomeSourceDef => ({
  id: 'stipend',
  label: 'Stipend',
  kind: 'external',
  patterns: [],
  sort: 3,
  builtin: false,
  ...patch,
});

const CATALOG: IncomeSourceDef[] = [
  source({ id: 'salary', label: 'Salary', kind: 'own', sort: 0, builtin: true }),
  source({ id: 'family', label: 'Support', patterns: ['Anna Becker'], sort: 1, builtin: true }),
  source({ id: 'other', label: 'Other', kind: 'own', sort: 2, builtin: true }),
  source(),
];

let sent: { method: string; body: unknown }[];

const record =
  (method: string, answer: Response) =>
  (init?: RequestInit): Response => {
    sent.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer;
  };

const mount = async (extra: Routes = {}, changed: () => void = vi.fn()) => {
  mockFetch({ 'GET /api/income-sources': () => ok(CATALOG), ...extra });
  renderThemed(<IncomeSourcesBlock onChanged={changed} />);
  await screen.findByRole('heading', { name: 'Income sources' });
  return changed;
};

beforeEach(() => {
  sent = [];
});

describe('IncomeSourcesBlock', () => {
  it('uses concise Settings copy and names automatic versus manual matching', async () => {
    await mount();
    const rowOf = (label: string): HTMLElement => screen.getByText(label, { selector: '.row-title' }).closest('.row') as HTMLElement;

    expect(screen.getByText('Support is tracked separately and does not count toward earnings goals.')).toBeVisible();
    expect(within(rowOf('Salary')).getByText('Earnings')).toBeVisible();
    expect(within(rowOf('Salary')).getByText('Manual only')).toBeVisible();
    expect(within(rowOf('Support')).getByText('Support', { selector: '.settings-income-kind' })).toBeVisible();
    expect(within(rowOf('Support')).getByText('1 automatic match pattern')).toBeVisible();
    expect(within(rowOf('Support')).queryByText('Anna Becker')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add source' })).toBeVisible();
  });

  it('counts multiple stored patterns without exposing their strings in the card', async () => {
    await mount({
      'GET /api/income-sources': () => ok([
        ...CATALOG.slice(0, 3),
        source({ patterns: ['Acme Limited', 'Example GmbH'] }),
      ]),
    });
    const stipend = screen.getByText('Stipend', { selector: '.row-title' }).closest('.row') as HTMLElement;
    expect(within(stipend).getByText('2 automatic match patterns')).toBeVisible();
    expect(within(stipend).queryByText(/Acme Limited|Example GmbH/)).not.toBeInTheDocument();
    fireEvent.click(within(stipend).getByRole('button', { name: 'Edit Stipend' }));
    expect(screen.getByRole('dialog', { name: 'Edit source' })).toBeVisible();
    expect(screen.getByLabelText('Statement match patterns')).toHaveValue('Acme Limited, Example GmbH');
  });

  it('keeps builtins editable but not deletable', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Edit Support' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete Support' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Salary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Other' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Stipend' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Salary' }));
    expect(screen.getByRole('dialog', { name: 'Edit source' })).toBeVisible();
    expect(screen.getByLabelText('Source name')).toHaveValue('Salary');
    expect(screen.getByRole('button', { name: 'Earnings' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Delete Salary' })).not.toBeInTheDocument();
  });

  it('creates a source, re-reads the catalog and tells Goals to reload', async () => {
    const changed = vi.fn();
    await mount(
      { 'POST /api/income-sources': record('POST', ok(source({ kind: 'own' }))) },
      changed,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(screen.getByRole('dialog', { name: 'Add source' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Support' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Source name')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Freelance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Earnings' }));
    fireEvent.change(screen.getByLabelText('Statement match patterns'), {
      target: { value: 'Acme GmbH, Example Limited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      method: 'POST',
      body: {
        label: 'Freelance',
        kind: 'own',
        patterns: ['Acme GmbH', 'Example Limited'],
      },
    });
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(requests().filter((request) => request === 'GET /api/income-sources')).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add source' })).not.toBeInTheDocument());
  });

  it('invalidates mounted readers before requesting the refreshed catalog', async () => {
    const sequence: string[] = [];
    let reads = 0;
    await mount({
      'GET /api/income-sources': () => {
        if (reads++ > 0) sequence.push('catalog');
        return ok(CATALOG);
      },
      'PUT /api/income-sources/stipend': () => {
        sequence.push('write');
        return ok(source({ label: 'Grant' }));
      },
    }, () => { sequence.push('invalidate'); });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sequence).toEqual(['write', 'invalidate', 'catalog']));
  });

  it('invalidates readers even when the post-write catalog refresh fails', async () => {
    let reads = 0;
    const changed = vi.fn();
    await mount(
      {
        'GET /api/income-sources': () =>
          reads++ === 0 ? ok(CATALOG) : fail(500, { error: 'catalog refresh failed' }),
        'POST /api/income-sources': record('POST', ok(source({ kind: 'own' }))),
      },
      changed,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Freelance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(await screen.findByText(/catalog refresh failed/)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Add source' })).not.toBeInTheDocument();
  });

  it('edits every field and keeps the form open on refusal', async () => {
    await mount({
      'PUT /api/income-sources/stipend': () =>
        fail(400, { error: 'income source label must be at most 60 characters' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Long stipend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Earnings' }));
    fireEvent.change(screen.getByLabelText('Statement match patterns'), {
      target: { value: 'Example Limited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await within(screen.getByRole('dialog', { name: 'Edit source' })).findByRole('alert'))
      .toHaveTextContent('at most 60 characters');
    expect(screen.getByLabelText('Source name')).toHaveValue('Long stipend');
    expect(screen.getByRole('button', { name: 'Earnings' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Statement match patterns')).toHaveValue('Example Limited');
    expect(screen.getByText('Changing this updates every income-based goal; transaction assignments stay the same.')).toBeVisible();
  });

  it('prevents a duplicate save and keeps the Sheet open until the write completes', async () => {
    let finish: (response: Response) => void = () => {};
    await mount({
      'POST /api/income-sources': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(requests().filter((request) => request === 'POST /api/income-sources')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Add source' })).toBeVisible();
    await act(async () => { finish(ok(source({ label: 'Grant' }))); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add source' })).not.toBeInTheDocument());
  });

  it('restores focus to Add and Edit after the Sheet closes', async () => {
    await mount();
    const add = screen.getByRole('button', { name: 'Add source' });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole('dialog', { name: 'Add source' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(add).toHaveFocus();

    const edit = screen.getByRole('button', { name: 'Edit Stipend' });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole('dialog', { name: 'Edit source' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(edit).toHaveFocus();
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole('dialog', { name: 'Edit source' }).parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
  });

  it('explains delete consequences before sending the write', async () => {
    await mount({
      'DELETE /api/income-sources/stipend': record('DELETE', ok({ deleted: true })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    expect(
      screen.getByText(
        'Delete “Stipend”? Assigned transactions move to Other. Manual assignments cannot be restored.',
      ),
    ).toBeVisible();
    expect(requests()).not.toContain('DELETE /api/income-sources/stipend');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requests()).toContain('DELETE /api/income-sources/stipend'));
  });

  it('uses the current catalog label in a custom delete confirmation', async () => {
    await mount({
      'GET /api/income-sources': () => ok(CATALOG.map((s) => s.id === 'other' ? { ...s, label: 'Unsorted' } : s)),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    expect(screen.getByText(/Assigned transactions move to Unsorted/)).toBeVisible();
    expect(screen.queryByText(/move to Other/)).not.toBeInTheDocument();
  });

  it('shows a refused delete beside the still-open confirmation', async () => {
    await mount({
      'DELETE /api/income-sources/stipend': () => fail(400, { error: 'cannot delete this source' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmation = screen.getByText(/Delete “Stipend”/).closest('.row') as HTMLElement;
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('cannot delete this source');
    expect(within(confirmation).getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('offers Retry when the catalog cannot be read', async () => {
    let reads = 0;
    mockFetch({
      'GET /api/income-sources': () =>
        reads++ === 0 ? fail(500, { error: 'the list could not be read' }) : ok(CATALOG),
    });
    renderThemed(<IncomeSourcesBlock onChanged={vi.fn()} />);
    expect(await screen.findByText(/the list could not be read/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Stipend')).toBeVisible();
  });
});
