import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defs } from '../analytics';
import { api } from '../api';
import { isAvailable } from '../dismiss';
import { ScreenShown } from '../screen';
import { Chips } from './Chips';
import { Sheet } from './Sheet';
import { Field } from './Field';
import { Button } from './Button';
import { FormActions } from './FormActions';
import { Notice } from './Notice';
import { useEditorSession } from '../editor';
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
  const shown = useContext(ScreenShown);
  /** null until the GET answered: an empty list is a real state and must not be faked */
  const [sources, setSources] = useState<IncomeSourceDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<IncomeSourceKind>('external');
  const [patterns, setPatterns] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deleteRowRef = useRef<HTMLElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const lastDeleteId = useRef<string | null>(null);
  const cancelledDelete = useRef<{ id: string; owner: Element | null } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const editRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<{ edited: string | null } | null>(null);
  const baseline = useRef({ label: '', kind: 'external' as IncomeSourceKind, patterns: '' });
  const deleteId = open?.form === 'delete' ? open.id : null;

  useLayoutEffect(() => {
    if (deleteId !== lastDeleteId.current) {
      lastDeleteId.current = deleteId;
      const cancel = deleteCancelRef.current;
      if (deleteId !== null && shown && cancel && isAvailable(cancel)) cancel.focus();
    }
    const cancelled = cancelledDelete.current;
    if (!cancelled) return;
    cancelledDelete.current = null;
    if (!shown) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== cancelled.owner) return;
    const target = [editRefs.current.get(cancelled.id), addRef.current, headingRef.current]
      .find((control) => control && isAvailable(control));
    target?.focus();
  }, [deleteId, shown]);

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

  /*
   * The committed write clears the rows, and with them the control that opened the form,
   * so the Sheet has no opener left to hand focus back to. It lands here once the catalog
   * answered, unless the reader has already put it somewhere themselves.
   */
  useEffect(() => {
    const target = refocus.current;
    if (!target || busy) return;
    refocus.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    const next = sources
      ? (target.edited !== null && editRefs.current.get(target.edited)) || addRef.current
      : retryRef.current;
    next?.focus();
  }, [busy, sources]);

  /**
   * Invalidation precedes the catalog refresh: the write already changed every reader,
   * and a failed follow-up GET must not leave those readers on pre-mutation data.
   */
  const run = async (write: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await write();
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(false);
      return;
    }
    refocus.current = { edited: open?.form === 'edit' ? open.id : null };
    editor.finish(() => setOpen(null));
    setSources(null);
    try {
      await onChanged();
      await read();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
    if (busy || open !== null) return;
    setActionError(null);
    baseline.current = { label: '', kind: 'external', patterns: '' };
    setLabel('');
    setKind('external');
    setPatterns('');
    setOpen({ form: 'add' });
  };

  const openEdit = (s: IncomeSourceDef) => {
    baseline.current = { label: s.label, kind: s.kind, patterns: s.patterns.join(', ') };
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
    if (!busy) setOpen(null);
  };

  const editor = useEditorSession({
    open: open?.form === 'add' || open?.form === 'edit',
    dirty: JSON.stringify([label.trim(), kind, splitPatterns(patterns)]) !==
      JSON.stringify([baseline.current.label.trim(), baseline.current.kind, splitPatterns(baseline.current.patterns)]),
    busy,
    onClose: close,
    onNavigationDiscard: close,
  });

  const form = (onOk: () => void) => (
    <form id="settings-income-form" className="settings-income-editor" onSubmit={(event) => {
      event.preventDefault();
      onOk();
    }}>
      <Field id="source-label" label="Source name" control="input" controlProps={{
        value: label, readOnly: busy, onChange: (e) => setLabel(e.target.value), placeholder: 'Stipend',
      }} />
      <fieldset className="settings-income-counts" aria-describedby="source-kind-help">
        <legend className="native-field__label">Counts as</legend>
        <Chips
          label="Counts as"
          options={KINDS.map((k) => ({ key: k.key, label: k.label }))}
          selected={kind}
          onSelect={(k) => setKind(k as IncomeSourceKind)}
          locked={busy}
        />
        <p className="settings-consequence" id="source-kind-help">
          Changing this updates every income-based goal; transaction assignments stay the same.
        </p>
      </fieldset>
      <Field id="source-patterns" label="Statement match patterns" control="input" controlProps={{
        value: patterns, readOnly: busy, onChange: (e) => setPatterns(e.target.value),
        placeholder: 'Musterstiftung Musterstadt, Leistungsstipendium Beispielstadt', 'aria-describedby': 'source-patterns-help',
      }} />
      {/* the floor is the matcher's, not this form's, and the hint states it because
          "contains one of these" would be a sentence the product does not keep. Every
          pattern in the placeholder above has to clear the same floor, or the example
          teaches the input the hint forbids. */}
      <p className="settings-consequence" id="source-patterns-help">
        Comma-separate phrases. Each phrase needs at least two words of 3+ letters; leave blank
        for manual tagging.
      </p>
    </form>
  );

  return (
    <>
      <h2 className="settings-title" id="settings-income-title" ref={headingRef} tabIndex={-1}>Income sources</h2>
      <p className="settings-lead">
        Support is tracked separately and does not count toward earnings goals.
      </p>

      {error && (
        <Notice tone="error" role="alert" remedy={!sources && (
          <Button ref={retryRef} type="button" variant="tertiary" size="standard" onClick={() => {
            const heading = headingRef.current;
            if (shown && heading && isAvailable(heading)) heading.focus();
            load();
          }}>Retry</Button>
        )}>Error: {error}</Notice>
      )}

      {!sources && !error && <Notice role="status">Loading income sources…</Notice>}

      {sources && (
        <>
          <div className="settings-income-list">
          {sources.map((s) => {
            const mine = open && open.form !== 'add' && open.id === s.id ? open : null;
            return (
              <article key={s.id} className="settings-income-row" aria-label={`Income source ${s.label}`}
                ref={mine?.form === 'delete' ? deleteRowRef : undefined}>
                <div className="settings-income-info">
                  <div className="settings-income-heading">
                    <h3 className="settings-income-name">{s.label}</h3>
                    <span className="settings-income-kind">{kindLabel(s.kind)}</span>
                  </div>
                  <div className="settings-income-context">
                    {s.patterns.length > 0
                      ? `${s.patterns.length} automatic match ${s.patterns.length === 1 ? 'pattern' : 'patterns'}`
                      : 'Manual only'}
                  </div>
                  {mine?.form === 'delete' && (
                    <>
                      <p className="settings-consequence">
                        Delete “{s.label}”? {destination
                          ? `Assigned transactions move to ${destination.label}. Manual assignments cannot be restored.`
                          : 'The destination source is unavailable. Reload the catalog before deleting.'}
                      </p>
                      {actionError && <Notice tone="error" role="alert">Error: {actionError}</Notice>}
                      {busy && <Notice role="status">Deleting source…</Notice>}
                      <FormActions cancel={
                        <Button type="button" variant="secondary" size="standard" ref={deleteCancelRef}
                          aria-disabled={busy} onClick={() => {
                            if (busy) return;
                            const focused = document.activeElement;
                            if (!focused || focused === document.body || deleteRowRef.current?.contains(focused)) {
                              cancelledDelete.current = { id: s.id, owner: focused };
                            }
                            close();
                          }}>Cancel</Button>
                      } completion={
                        <Button type="button" variant="destructive-primary" size="standard" pending={busy}
                          aria-disabled={busy || !destination} onClick={() => { if (destination) remove(s.id); }}>
                          Delete
                        </Button>
                      } />
                    </>
                  )}
                </div>
                {mine?.form !== 'delete' && (
                  <div className="settings-income-actions">
                    <Button type="button" variant="secondary" size="compact"
                      ref={(button) => {
                        if (button) editRefs.current.set(s.id, button);
                        else editRefs.current.delete(s.id);
                      }}
                      aria-disabled={busy}
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.label}`}
                    >
                      Edit
                    </Button>
                    {/* a builtin has no delete control, and the route refuses one anyway;
                        a deleted source's rows move to `other` */}
                    {!s.builtin && !mine && (
                      <Button type="button" variant="destructive-secondary" size="compact"
                        aria-disabled={busy}
                        onClick={() => { setActionError(null); setOpen({ form: 'delete', id: s.id }); }}
                        aria-label={`Delete ${s.label}`}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          </div>

          <Button type="button" variant="secondary" size="standard" ref={addRef}
            className="settings-income-add" aria-disabled={busy || open !== null} onClick={openAdd}>
            Add source
          </Button>
        </>
      )}
      <Sheet
        open={open?.form === 'add' || open?.form === 'edit'}
        onClose={editor.requestClose}
        guard={editor.guard}
        pattern="short-editor"
        stepKey={open?.form}
        busy={busy}
        title={open?.form === 'edit' ? 'Edit source' : 'Add source'}
        header={<h2 className="sheet-title">{open?.form === 'edit' ? 'Edit source' : 'Add source'}</h2>}
        footer={<>
          {actionError && <Notice tone="error" role="alert">Error: {actionError}</Notice>}
          {busy && <Notice role="status">Saving source…</Notice>}
          <FormActions cancel={
            <Button type="button" variant="secondary" size="standard" aria-disabled={busy} onClick={editor.requestClose}>Cancel</Button>
          } completion={
            <Button type="submit" form="settings-income-form" variant="primary" size="standard" pending={busy}>Save</Button>
          } />
        </>}
      >
        {open?.form === 'add' ? form(add) : open?.form === 'edit' ? form(() => save(open.id)) : null}
      </Sheet>
    </>
  );
}
