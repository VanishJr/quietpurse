import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Chips } from './Chips';
import { IncomeSourceDef, IncomeSourceKind } from '../types';

/**
 * Which money is earned and which is support - the one input every figure on the Goal
 * screen is computed from, and until this block there was no way to say it except one
 * transaction at a time under a noun somebody else picked.
 *
 * Its own state and its own error rather than the screen's: the screen's handlers clear
 * its error on success, which would wipe a failed save here.
 */

/** The two buckets, named by what they do to the figures rather than by the wire's word. */
const KINDS: { key: IncomeSourceKind; label: string }[] = [
  { key: 'own', label: 'Your own earnings' },
  { key: 'external', label: 'Support from outside' },
];

const kindLabel = (kind: IncomeSourceKind): string =>
  KINDS.find((k) => k.key === kind)!.label;

const splitPatterns = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * What a delete does to the figures is a function of the pair and not of the source
 * being deleted: deleteIncomeSource re-points that income to `other`, and the split
 * between own income and support is taken off the destination's kind at summary time.
 * Both halves are set from this block - the add form offers `own`, and `other` itself
 * is editable - so all four combinations are reachable and only one of them is the
 * sentence about a rise.
 *
 * A destination that is absent gets the neutral half and promises nothing about the
 * figures: `other` is seeded in every workspace and DELETE refuses a builtin, so no
 * case holds that arm.
 */
const movesTo = (deleted: IncomeSourceKind, into: IncomeSourceDef | undefined): string => {
  const moves = `The income tagged with it moves to ${into?.label ?? 'Other'}`;
  if (!into) return `${moves}.`;
  const counts = into.kind === 'own' ? 'your own earnings' : 'support';
  if (deleted === into.kind)
    return (
      `${moves}, which counts as ${counts} too — the income is only re-labelled ` +
      'and no figure on this screen changes.'
    );
  return into.kind === 'own'
    ? `${moves}, which counts as ${counts} — your own income on this screen goes up ` +
        'and the shortfall goes down.'
    : `${moves}, which counts as ${counts} — your own income on this screen goes down ` +
        'and the shortfall goes up.';
};

/** Which form is open, and for which row. One at a time. */
type Open = { form: 'add' } | { form: 'edit'; id: string } | { form: 'delete'; id: string };

interface Props {
  /** the screen's own load - every figure above this block is computed from these rows */
  onChanged: () => Promise<void> | void;
}

export function IncomeSourcesBlock({ onChanged }: Props) {
  /** null until the GET answered: an empty list is a real state and must not be faked */
  const [sources, setSources] = useState<IncomeSourceDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
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
   * Every write goes through here for the reload: the label, the kind and the patterns
   * each move the split between own income and support, so the figures the screen is
   * already showing are stale the moment one lands. Without the second call the user
   * reads pre-mutation numbers, which looks exactly like the mutation not working.
   */
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true);
    try {
      setError(null);
      await write();
      setOpen(null);
      await read();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // no client-side check on the label: the route composes the sentence, and a button
  // that silently does nothing is the failure this whole block exists to remove
  const add = () => run(() => api.addIncomeSource(label.trim(), kind, splitPatterns(patterns)));

  const save = (id: string) =>
    run(() =>
      api.updateIncomeSource(id, { label: label.trim(), kind, patterns: splitPatterns(patterns) }),
    );

  const remove = (id: string) => run(() => api.deleteIncomeSource(id));

  const openAdd = () => {
    setLabel('');
    setKind('external');
    setPatterns('');
    setOpen({ form: 'add' });
  };

  const openEdit = (s: IncomeSourceDef) => {
    setLabel(s.label);
    setKind(s.kind);
    setPatterns(s.patterns.join(', '));
    setOpen({ form: 'edit', id: s.id });
  };

  /**
   * Where a deleted source's income lands, read off the list rather than written out:
   * both its label and its kind are editable through this block, so a user who renamed
   * `other` has to read their own word back, and a user who made it support has to be
   * told what that does.
   */
  const destination = sources?.find((s) => s.id === 'other');

  const form = (onOk: () => void) => (
    <>
      <label className="setting-label" htmlFor="source-label">
        Name
      </label>
      <input
        id="source-label"
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        autoFocus
        placeholder="Stipend"
      />
      <div className="setting-label">What this money is</div>
      <Chips
        label="What this money is"
        options={KINDS.map((k) => ({ key: k.key, label: k.label }))}
        selected={kind}
        onSelect={(k) => setKind(k as IncomeSourceKind)}
      />
      <p className="hint">
        Support is not counted as your own earnings, so moving a source from one to the other
        moves every figure on this screen. Nothing is re-tagged either way, so moving it back
        puts them all straight again.
      </p>
      <label className="setting-label" htmlFor="source-patterns">
        Names in your statements
      </label>
      <input
        id="source-patterns"
        className="input"
        value={patterns}
        onChange={(e) => setPatterns(e.target.value)}
        placeholder="Musterstiftung Musterstadt, Leistungsstipendium Beispielstadt"
      />
      {/* the two-word floor is the matcher's, not this form's: a pattern is cut into
          words of three letters or more and dropped if fewer than two survive, so a
          one-word pattern is accepted, stored, and tags nothing. Saying "contains one
          of these" would be a sentence the product does not keep, and every pattern in
          the placeholder above has to clear the same floor or the example teaches the
          input the hint forbids. */}
      <p className="hint">
        Income whose description contains every word of one of these is tagged with this source
        on its own. Two words at least, of three letters or more — one word on its own never
        matches anything. Several patterns, comma-separated; leave it empty to tag by hand.
      </p>
      <div className="btn-row">
        <button className="btn-ghost" disabled={busy} onClick={() => setOpen(null)}>
          Cancel
        </button>
        <button className="btn" disabled={busy} onClick={onOk}>
          Save
        </button>
      </div>
    </>
  );

  return (
    <>
      <h2 className="block-title">Where your income comes from</h2>
      <p className="hint">
        Your own earnings are what this goal is about. Support is money somebody else gives you —
        family, a stipend, a scholarship — and it is counted separately, never as your own.
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

      {sources && (
        <>
          {sources.map((s) => {
            const mine = open && open.form !== 'add' && open.id === s.id ? open : null;
            if (mine?.form === 'edit') {
              return (
                <div key={s.id} className="row">
                  <div className="row-main">{form(() => save(s.id))}</div>
                </div>
              );
            }
            return (
              <div key={s.id} className="row">
                <div className="row-main">
                  <div className="row-title">{s.label}</div>
                  <div className="row-sub">
                    {kindLabel(s.kind)}
                    {/* the patterns themselves and not what they tag: the matcher drops a
                        one-word pattern, so "tags income matching X" is false for exactly
                        the input the form's hint warns about, and the hint is gone by the
                        time this row is read */}
                    {s.patterns.length > 0
                      ? ` · patterns: ${s.patterns.join(', ')}`
                      : ' · tagged by hand'}
                  </div>
                  {mine?.form === 'delete' && (
                    <>
                      <p className="hint">
                        Delete "{s.label}"? {movesTo(s.kind, destination)} Transactions you tagged
                        with it by hand are moved too, and creating this source again does not
                        bring them back.
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
                    {/* a builtin has no delete control, and the route refuses one anyway:
                        deleting salary, support or other would leave the split with no
                        bucket for a deleted source's income to fall back to */}
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

          {open?.form === 'add' ? (
            <div className="row">
              <div className="row-main">{form(add)}</div>
            </div>
          ) : (
            <button
              className="btn-link"
              style={{ fontWeight: 600, padding: '12px 0' }}
              disabled={busy || open !== null}
              onClick={openAdd}
            >
              + Add income source
            </button>
          )}
        </>
      )}
    </>
  );
}
