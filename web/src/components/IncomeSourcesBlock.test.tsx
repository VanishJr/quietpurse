import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderThemed, requests, type Routes } from '../test/harness';
import type { IncomeSourceDef } from '../types';
import { IncomeSourcesBlock } from './IncomeSourcesBlock';
import { ScreenShown } from '../screen';

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
  await screen.findByRole('button', { name: 'Add source' });
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

  it('sends the edited fields and invalidates only after the write commits, before catalog refresh', async () => {
    const sequence: string[] = [];
    let finish: (response: Response) => void = () => {};
    let reads = 0;
    await mount({
      'GET /api/income-sources': () => {
        if (reads++ > 0) sequence.push('catalog');
        return ok(CATALOG);
      },
      'PUT /api/income-sources/stipend': (init) => {
        sent.push({ method: 'PUT', body: JSON.parse(String(init?.body)) });
        sequence.push('write pending');
        return new Promise<Response>((resolve) => { finish = resolve; });
      },
    }, () => { sequence.push('invalidate'); });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Earnings' }));
    fireEvent.change(screen.getByLabelText('Statement match patterns'), {
      target: { value: 'Acme GmbH, Example Limited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sent).toEqual([{
      method: 'PUT',
      body: { label: 'Grant', kind: 'own', patterns: ['Acme GmbH', 'Example Limited'] },
    }]);
    expect(sequence).toEqual(['write pending']);
    expect(screen.getByRole('dialog', { name: 'Edit source' })).toBeVisible();

    await act(async () => {
      sequence.push('write committed');
      finish(ok(source({ label: 'Grant', kind: 'own', patterns: ['Acme GmbH', 'Example Limited'] })));
    });
    expect(sequence).toEqual(['write pending', 'write committed', 'invalidate', 'catalog']);
  });

  it('does not invalidate or refresh the catalog after a rejected pending write', async () => {
    const changed = vi.fn();
    let finish: (response: Response) => void = () => {};
    await mount({
      'PUT /api/income-sources/stipend': () =>
        new Promise<Response>((resolve) => { finish = resolve; }),
    }, changed);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(changed).not.toHaveBeenCalled();
    expect(requests().filter((request) => request === 'GET /api/income-sources')).toHaveLength(1);
    await act(async () => { finish(fail(400, { error: 'write refused' })); });
    expect(within(screen.getByRole('dialog', { name: 'Edit source' })).getByRole('alert'))
      .toHaveTextContent('write refused');
    expect(changed).not.toHaveBeenCalled();
    expect(requests().filter((request) => request === 'GET /api/income-sources')).toHaveLength(1);
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
    // held without `disabled`: a browser takes focus off a control disabled under it, and
    // in a modal that leaves the Tab trap nothing to hold - jsdom never does, so the
    // attribute is what is asserted
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).not.toBeDisabled();
    expect(saving).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Add source' })).toBeVisible();
    await act(async () => { finish(ok(source({ label: 'Grant' }))); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add source' })).not.toBeInTheDocument());
  });

  const dirtyDismissals = (['add', 'edit'] as const).flatMap((mode) =>
    (['name', 'kind', 'patterns'] as const).flatMap((field) =>
      (['backdrop', 'escape', 'close', 'cancel'] as const).map((dismissal) => ({ mode, field, dismissal }))));

  it.each(dirtyDismissals)('$mode source $field survives $dismissal until explicit discard', async ({ mode, field, dismissal }) => {
    await mount();
    const opener = screen.getByRole('button', { name: mode === 'add' ? 'Add source' : 'Edit Stipend' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    const edited = field === 'kind' ? within(dialog).getByRole('button', { name: 'Earnings' })
      : within(dialog).getByRole('textbox', { name: field === 'name' ? 'Source name' : 'Statement match patterns' });
    edited.focus();
    if (field === 'kind') fireEvent.click(edited);
    else fireEvent.change(edited, { target: { value: field === 'name' ? 'Edited grant' : 'Example Limited' } });
    const dismiss = () => {
      if (dismissal === 'backdrop') {
        const backdrop = dialog.parentElement!;
        fireEvent.pointerDown(backdrop);
        fireEvent.click(backdrop);
      } else if (dismissal === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(within(dialog).getByRole('button', { name: dismissal === 'close' ? 'Close dialog' : 'Cancel' }));
    };
    dismiss();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(screen.queryByRole('textbox', { name: 'Source name' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(edited).toHaveFocus();
    expect(within(dialog).getByRole('textbox', { name: 'Source name' })).toHaveValue(field === 'name' ? 'Edited grant' : mode === 'add' ? '' : 'Stipend');
    expect(within(dialog).getByRole('textbox', { name: 'Statement match patterns' })).toHaveValue(field === 'patterns' ? 'Example Limited' : '');
    expect(within(dialog).getByRole('button', { name: field === 'kind' ? 'Earnings' : 'Support' })).toHaveAttribute('aria-pressed', 'true');
    dismiss();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(requests().filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
  });

  it('guards edited source dismissal and keeps the same draft until explicit discard', async () => {
    await mount();
    const edit = screen.getByRole('button', { name: 'Edit Stipend' });
    edit.focus();
    fireEvent.click(edit);
    const input = screen.getByRole('textbox', { name: 'Source name' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Edited grant' } });
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Edited grant');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    fireEvent.click(edit);
    expect(screen.getByRole('textbox', { name: 'Source name' })).toHaveValue('Stipend');
    expect(requests().some((request) => request.startsWith('PATCH'))).toBe(false);
  });

  it('restores focus to Add and Edit after the Sheet closes', async () => {
    await mount();
    const add = screen.getByRole('button', { name: 'Add source' });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole('heading', { name: 'Add source' })).toHaveFocus();
    // the Sheet takes its opener as it opens, and a disabled one is already out of focus
    expect(add).not.toBeDisabled();
    expect(add).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(add).toHaveFocus();

    const edit = screen.getByRole('button', { name: 'Edit Stipend' });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole('heading', { name: 'Edit source' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(edit).toHaveFocus();
    fireEvent.click(edit);
    const backdrop = screen.getByRole('dialog', { name: 'Edit source' }).parentElement!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
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

  it('invalidates readers after a confirmed delete even if its catalog refresh fails', async () => {
    const sequence: string[] = [];
    let finish: (response: Response) => void = () => {};
    let reads = 0;
    await mount({
      'GET /api/income-sources': () => {
        if (reads++ === 0) return ok(CATALOG);
        sequence.push('catalog');
        return reads === 2
          ? fail(500, { error: 'catalog unavailable after delete' })
          : ok(CATALOG.filter((entry) => entry.id !== 'stipend'));
      },
      'DELETE /api/income-sources/stipend': () => {
        sequence.push('delete pending');
        return new Promise<Response>((resolve) => { finish = resolve; });
      },
    }, () => { sequence.push('invalidate'); });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(sequence).toEqual(['delete pending']);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      sequence.push('delete committed');
      finish(ok({ deleted: true }));
    });

    expect(sequence).toEqual(['delete pending', 'delete committed', 'invalidate', 'catalog']);
    expect(await screen.findByText(/catalog unavailable after delete/)).toBeVisible();
    expect(screen.queryByText('Stipend')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Salary');
    expect(screen.queryByText(/catalog unavailable after delete/)).not.toBeInTheDocument();
    expect(screen.queryByText('Stipend')).not.toBeInTheDocument();
    expect(sequence).toEqual(['delete pending', 'delete committed', 'invalidate', 'catalog', 'catalog']);
  });

  it('uses the current catalog label in a custom delete confirmation', async () => {
    await mount({
      'GET /api/income-sources': () => ok(CATALOG.map((s) => s.id === 'other' ? { ...s, label: 'Unsorted' } : s)),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    expect(screen.getByText(/Assigned transactions move to Unsorted/)).toBeVisible();
    expect(screen.queryByText(/move to Other/)).not.toBeInTheDocument();
  });

  it('shows a refused delete beside the still-open confirmation, with focus still on Delete', async () => {
    let finish: (response: Response) => void = () => {};
    await mount({
      'DELETE /api/income-sources/stipend': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveClass('btn-destroy');
    confirm.focus();
    fireEvent.click(confirm);
    expect(confirm).not.toBeDisabled();
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveFocus();

    await act(async () => { finish(fail(400, { error: 'cannot delete this source' })); });
    const confirmation = screen.getByText(/Delete “Stipend”/).closest('.row') as HTMLElement;
    expect(within(confirmation).getByRole('alert')).toHaveTextContent('cannot delete this source');
    expect(confirm).toHaveAttribute('aria-disabled', 'false');
    expect(confirm).toHaveFocus();
  });

  it('locks the form while its save is out, so nothing typed then is dropped by the close', async () => {
    let finish: (response: Response) => void = () => {};
    await mount({
      'PUT /api/income-sources/stipend': (init) => {
        sent.push({ method: 'PUT', body: JSON.parse(String(init?.body)) });
        return new Promise<Response>((resolve) => { finish = resolve; });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit source' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(within(dialog).getByLabelText('Source name')).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText('Statement match patterns')).toHaveAttribute('readonly');
    const earnings = within(dialog).getByRole('button', { name: 'Earnings' });
    expect(earnings).not.toBeDisabled();
    expect(earnings).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(earnings);
    expect(earnings).toHaveAttribute('aria-pressed', 'false');

    await act(async () => { finish(ok(source())); });
    expect(sent).toEqual([{ method: 'PUT', body: { label: 'Stipend', kind: 'external', patterns: [] } }]);
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

  it('gives focus back to the edited row after a committed save, though the rows were re-read', async () => {
    await mount({ 'PUT /api/income-sources/stipend': () => ok(source({ label: 'Grant' })) });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit source' })).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Stipend' })).toHaveFocus());
  });

  it('gives focus to Add source after a committed add or delete', async () => {
    await mount({
      'POST /api/income-sources': () => ok(source({ id: 'grant', label: 'Grant' })),
      'DELETE /api/income-sources/stipend': () => ok({ deleted: true }),
    });
    const add = () => screen.getByRole('button', { name: 'Add source' });
    fireEvent.click(add());
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add source' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(add()).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Delete Stipend' }));
    const confirm = screen.getByRole('button', { name: 'Delete' });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(add()).toHaveFocus());
  });

  it('gives focus to Retry when the catalog could not be re-read after a save', async () => {
    let reads = 0;
    await mount({
      'GET /api/income-sources': () => reads++ === 0 ? ok(CATALOG) : fail(500, { error: 'catalog unavailable' }),
      'PUT /api/income-sources/stipend': () => ok(source()),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stipend' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit source' })).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/catalog unavailable/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus());
  });

  /** The Shell's own arrangement: the screen's `hidden` and its `ScreenShown` from one value. */
  const mountOnScreen = () => {
    let setShown: (shown: boolean) => void = () => {};
    const Host = () => {
      const [shown, set] = useState(true);
      setShown = set;
      return (
        <div hidden={!shown}>
          <ScreenShown value={shown}><IncomeSourcesBlock onChanged={vi.fn()} /></ScreenShown>
        </div>
      );
    };
    renderThemed(<Host />);
    return (shown: boolean) => act(() => setShown(shown));
  };

  it('keeps its form and its refusal while its screen is hidden, without holding the page scroll', async () => {
    mockFetch({
      'GET /api/income-sources': () => ok(CATALOG),
      'POST /api/income-sources': () => fail(400, { error: 'name taken' }),
    });
    const show = mountOnScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('name taken');
    expect(document.body.style.overflow).toBe('hidden');

    show(false);
    expect(document.body.style.overflow).toBe('');
    fireEvent.keyDown(document, { key: 'Escape' });

    show(true);
    const dialog = screen.getByRole('dialog', { name: 'Add source' });
    expect(within(dialog).getByLabelText('Source name')).toHaveValue('Grant');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('name taken');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('releases the page scroll while hidden with a save in flight, and shows its refusal on return', async () => {
    let finish: (response: Response) => void = () => {};
    mockFetch({
      'GET /api/income-sources': () => ok(CATALOG),
      'POST /api/income-sources': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    const show = mountOnScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    show(false);
    expect(document.body.style.overflow).toBe('');

    await act(async () => { finish(fail(400, { error: 'name taken' })); });
    show(true);
    const dialog = screen.getByRole('dialog', { name: 'Add source' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('name taken');
    expect(within(dialog).getByLabelText('Source name')).toHaveValue('Grant');
  });
});
