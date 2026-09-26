import { useCallback, useEffect, useRef, useState } from 'react';
import { defs } from '../analytics';
import { api } from '../api';
import { Chips } from './Chips';
import { Sheet } from './Sheet';
import { IncomeSourceDef, IncomeSourceKind } from '../types';

/**
 * `IncomeSourcesBlock` keeps its own state and its own error rather than the screen's:
 * an error shared with the screen would be cleared by the screen's other handlers,
 * wiping a failed save here.
 */

/** The two buckets, named by what they do to the figures rather than by the wire's word. */
export const KIND_DEFS = {
  own: { label: 'Earnings' },
  external: { label: 'Support' },
} satisfies Record<IncomeSourceKind, { label: string }>;

const KINDS: { key: IncomeSourceKind; label: string }[] = defs(KIND_DEFS);

const kindLabel = (kind: IncomeSourceKind): string => KIND_DEFS[kind].label;

const splitPatterns = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

type Open = { form: 'add' } | { form: 'edit'; id: string } | { form: 'delete'; id: string };

interface Props {
  onChanged: () => Promise<void> | void;
}

export function IncomeSourcesBlock({ onChanged }: Props) {
  /** null until the GET answered: an empty list is a real state and must not be faked */
  const [sources, setSources] = useState<IncomeSourceDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<IncomeSourceKind>('external');
  const [patterns, setPatterns] = useState('');

  const read = useCallback(async () => {
    setSources(await api.incomeSources());
  }, []);

  const load = useCallback(() => {
    setError(null);
    read().catch((e) => setError((e as Error).message));
  }, [read]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Invalidation precedes the catalog refresh: the write already changed every reader,
   * and a failed follow-up GET must not leave those readers on pre-mutation data.
   */
  const run = async (write: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await write();
    } catch (e) {
      setActionError((e as Error).message);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    setOpen(null);
    try {
      await onChanged();
      await read();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // no client-side check on the label: the route refuses a bad one in its own sentence,
  // and a button that silently does nothing is the failure to avoid
  const add = () => run(() => api.addIncomeSource(label.trim(), kind, splitPatterns(patterns)));

  const save = (id: string) =>
    run(() =>
      api.updateIncomeSource(id, { label: label.trim(), kind, patterns: splitPatterns(patterns) }),
    );

  const remove = (id: string) => run(() => api.deleteIncomeSource(id));

  const openAdd = () => {
    setActionError(null);
    setLabel('');
    setKind('external');
    setPatterns('');
    setOpen({ form: 'add' });
  };

  const openEdit = (s: IncomeSourceDef) => {
    setActionError(null);
    setLabel(s.label);
    setKind(s.kind);
    setPatterns(s.patterns.join(', '));
    setOpen({ form: 'edit', id: s.id });
  };

  /**
   * Where a deleted source's income lands, read off the list rather than written out:
   * its label is editable through this block, so a user who renamed `other` has to
   * read their own word back.
   */
  const destination = sources?.find((s) => s.id === 'other');

  const close = () => {
    if (!busyRef.current) setOpen(null);
  };

  const form = (onOk: () => void) => (
    <>
      <h2 className="sheet-title">{open?.form === 'edit' ? 'Edit source' : 'Add source'}</h2>
      <label className="setting-label" htmlFor="source-label">
        Source name
      </label>
      <input
        id="source-label"
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Stipend"
      />
      <div className="setting-label">Counts as</div>
      <Chips
        label="Counts as"
        options={KINDS.map((k) => ({ key: k.key, label: k.label }))}
        selected={kind}
        onSelect={(k) => setKind(k as IncomeSourceKind)}
      />
      <p className="hint">
        Changing this updates every income-based goal; transaction assignments stay the same.
      </p>
      <label className="setting-label" htmlFor="source-patterns">
        Statement match patterns
      </label>
      <input
        id="source-patterns"
        className="input"
        value={patterns}
        onChange={(e) => setPatterns(e.target.value)}
        placeholder="Musterstiftung Musterstadt, Leistungsstipendium Beispielstadt"
      />
      {/* the floor is the matcher's, not this form's, and the hint states it because
          "contains one of these" would be a sentence the product does not keep. Every
          pattern in the placeholder above has to clear the same floor, or the example
          teaches the input the hint forbids. */}
      <p className="hint">
        Comma-separate phrases. Each phrase needs at least two words of 3+ letters; leave blank
        for manual tagging.
      </p>
      {actionError && <p className="error" role="alert">Error: {actionError}</p>}
      <div className="btn-row">
        <button className="btn-ghost" type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onOk}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );

  return (
    <>
      <h2 className="block-title" id="settings-income-title">Income sources</h2>
      <p className="hint">
        Support is tracked separately and does not count toward earnings goals.
      </p>

      {error && (
        <p className="error">
          Error: {error}
          {/* without the read there are no rows, so a reload of the page would be the
              only way back to them */}
          {!sources && (
            <>
              {' · '}
              <button className="btn-link" type="button" onClick={load}>
                Retry
              </button>
            </>
          )}
        </p>
      )}

      {!sources && !error && <p role="status" className="hint">Loading income sources…</p>}

      {sources && (
        <>
          {sources.map((s) => {
            const mine = open && open.form !== 'add' && open.id === s.id ? open : null;
            return (
              <div key={s.id} className="row">
                <div className="row-main">
                  <div className="row-title">{s.label}</div>
                  <div className="row-sub">
                    {kindLabel(s.kind)}
                    {/* the patterns themselves and not what they tag: "tags income matching
                        X" is false for a pattern under the matcher's floor, and the form's
                        hint is gone by the time this row is read */}
                    {s.patterns.length > 0
                      ? ` · Auto-match: ${s.patterns.join(', ')}`
                      : ' · Manual only'}
                  </div>
                  {mine?.form === 'delete' && (
                    <>
                      <p className="hint">
                        Delete “{s.label}”? Assigned transactions move to {destination?.label ?? 'Other'}.
                        Manual assignments cannot be restored.
                      </p>
                      <div className="btn-row">
                        <button className="btn-ghost" disabled={busy} onClick={() => setOpen(null)}>
                          Cancel
                        </button>
                        <button className="btn-danger" disabled={busy} onClick={() => remove(s.id)}>
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {!mine && (
                  <>
                    <button
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.label}`}
                    >
                      Edit
                    </button>
                    {/* a builtin has no delete control, and the route refuses one anyway;
                        a deleted source's rows move to `other` */}
                    {!s.builtin && (
                      <button
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => setOpen({ form: 'delete', id: s.id })}
                        aria-label={`Delete ${s.label}`}
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <button
            className="btn-link"
            style={{ fontWeight: 600, padding: '12px 0' }}
            disabled={busy || open !== null}
            onClick={openAdd}
          >
            Add source
          </button>
        </>
      )}
      <Sheet
        open={open?.form === 'add' || open?.form === 'edit'}
        onClose={close}
        position="center"
        title={open?.form === 'edit' ? 'Edit source' : 'Add source'}
      >
        {open?.form === 'add' ? form(add) : open?.form === 'edit' ? form(() => save(open.id)) : null}
      </Sheet>
    </>
  );
}
