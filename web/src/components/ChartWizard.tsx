/**
 * A new chart is asked for its shape before what it is about, and the order is the
 * point. A reader who wants a donut of last quarter's spending knows the donut before
 * they know the quarter, and a single form asking for every value at once is a form
 * nobody finishes. Split, the first step is one click and the second is a page of chips
 * with every default already filled in.
 */
import { useEffect, useId, useState } from 'react';
import {
  BREAKDOWNS,
  CHART_KINDS,
  CHART_TITLE_MAX,
  blankChart,
  chartKind,
  METRICS,
  RANGES,
  suggestedTitle,
} from '../analytics';
import { useChartData } from '../chartData';
import { useEditorSession } from '../editor';
import { Account, Chart, ChartBreakdown, ChartKind, ChartMetric, ChartRange } from '../types';
import { ChartGlyph } from './ChartGlyphs';
import { ChartPlot } from './ChartPlot';
import { Sheet } from './Sheet';
import { Button } from './Button';
import { FormActions } from './FormActions';
import { Field } from './Field';
import { Notice } from './Notice';

const PREVIEW_HEIGHT = 190;

/**
 * A series chart with no measure ticked.
 *
 * There is no minimum enforced by the chips — a reader clearing the last one is doing
 * something perfectly ordinary on the way to picking a different one, and a control
 * that refuses to switch off is a control that has to be fought. What is refused is
 * SAVING it: the state is reachable, it is named in red under the chips, and "Create
 * chart" stays disabled until it is out of it.
 */
const incomplete = (spec: Chart): boolean =>
  chartKind(spec.kind).shape === 'series' && spec.metrics.length === 0;

interface Props {
  open: boolean;
  /** The chart being changed, or null to build a new one. */
  editing: Chart | null;
  accounts: Account[] | null;
  /** Why the list is null, when it is null because the read failed. */
  accountsError: string | null;
  dataRevision?: number;
  onClose: () => void;
  onSave: (spec: Chart) => void;
}

const meaningOf = ({ kind, accountId, metrics, breakdown, range }: Chart) =>
  JSON.stringify({ kind, accountId, metrics: [...metrics].sort(), breakdown, range });

export function ChartWizard({
  open,
  editing,
  accounts,
  accountsError,
  dataRevision = 0,
  onClose,
  onSave,
}: Props) {
  const [draft, setDraft] = useState<Chart | null>(null);
  const [baseline, setBaseline] = useState<Chart | null>(null);
  const [step, setStep] = useState<'kind' | 'detail'>('kind');
  /**
   * Whether the reader has typed a name of their own. Until they have, the box
   * follows the spec — pick a donut of income over six months and the name says so —
   * and the moment they type, it stops moving under them.
   */
  const [named, setNamed] = useState(false);

  /*
   * OPENING is what resets the draft, not rendering: the dialog is mounted for as long
   * as the screen is, and the spec it is editing is an element of the screen's chart
   * array — a new object identity every time that array is rewritten. Keyed on the
   * object, a save-in-progress elsewhere on the screen would throw away what the reader
   * had typed. So the key is which chart, plus whether the dialog is up, and nothing
   * about the identity of anything.
   */
  const key = open ? (editing?.id ?? 'new') : '';
  useEffect(() => {
    if (key === '') return;
    setDraft(editing);
    setBaseline(editing);
    setStep(editing ? 'detail' : 'kind');
    setNamed(editing !== null);
    // `editing` deliberately absent: `key` stands in for it
  }, [key]);

  /* The suggested title names the account a chart is about — see `suggestedTitle`. */
  const nameOf = (id: string | null): string | null =>
    id ? (accounts?.find((a) => a.id === id)?.name ?? null) : null;

  const suggest = (spec: Chart): string => suggestedTitle(spec, nameOf(spec.accountId));

  const dirty = draft !== null && baseline !== null && (
    meaningOf(draft) !== meaningOf(baseline) ||
    ((editing !== null || named) && draft.title !== (editing ? baseline.title : suggest(baseline)))
  );
  const { requestClose, finish, guard } = useEditorSession({
    open, dirty, onClose,
    onNavigationDiscard: () => {
      setDraft(editing ? baseline : null);
      setBaseline(editing ? baseline : null);
      setStep(editing ? 'detail' : 'kind');
      setNamed(editing !== null);
    },
  });

  if (!open) return null;

  /*
   * An existing chart opens straight at step two with its own values in it, and "Change
   * shape" walks back to step one without losing them: the draft keeps `metrics` and
   * `breakdown` whatever the kind, so switching a donut to a line and back must not
   * quietly discard the half that was not being read.
   */
  const pickKind = (kind: ChartKind) => {
    const next = draft ? { ...draft, kind } : blankChart(kind);
    if (!baseline) setBaseline(next);
    setDraft(named ? next : { ...next, title: suggest(next) });
    setStep('detail');
  };

  const patch = (change: Partial<Chart>) =>
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...change };
      /*
       * A title is re-suggested only from a draft that could actually be saved. Clear
       * every measure and `suggestedTitle` has nothing to name the chart after — the
       * box would read " · 12 months" — so the last good suggestion is what stays in
       * it while the reader works out which measure they meant.
       */
      const keep = named || incomplete(next);
      return keep ? next : { ...next, title: suggest(next) };
    });

  return (
    <Sheet
      open={open}
      onClose={requestClose}
      guard={guard}
      position="center"
      wide
      title={editing ? 'Edit chart' : 'New chart'}
      pattern="builder"
      stepKey={step}
      restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) h1')}
      footer={
        <FormActions
          back={step === 'detail' && draft ? <Button type="button" variant="tertiary" size="standard" onClick={() => setStep('kind')}>Change shape</Button> : undefined}
          cancel={<Button type="button" variant="secondary" size="standard" onClick={requestClose}>Cancel</Button>}
          completion={step === 'detail' && draft ? (
            <Button type="button" variant="primary" size="standard" onClick={() => finish(() => onSave(draft))} disabled={draft.title.trim() === '' || incomplete(draft)}>
              {editing ? 'Save' : 'Create chart'}
            </Button>
          ) : null}
        />
      }
    >
      {step === 'kind' || !draft ? (
        <KindStep
          chosen={draft?.kind ?? null}
          onPick={pickKind}
          editing={editing !== null}
        />
      ) : (
        <DetailStep
          draft={draft}
          accounts={accounts}
          accountsError={accountsError}
          dataRevision={dataRevision}
          patch={patch}
          onName={(title) => {
            setNamed(true);
            setDraft((d) => (d ? { ...d, title } : d));
          }}
        />
      )}
    </Sheet>
  );
}

function KindStep({
  chosen,
  onPick,
  editing,
}: {
  chosen: ChartKind | null;
  onPick: (k: ChartKind) => void;
  editing: boolean;
}) {
  return (
    <>
      <h3 className="sheet-title">{editing ? 'Change the shape' : 'What shape?'}</h3>

      {/* The drawing IS the description. A sentence per tile explaining what a line
          chart is for answers a question the picture has already answered — the blurbs
          are `CHART_KINDS`' still, for a `title`. */}
      <div className="kind-grid" role="group" aria-label="Chart shapes">
        {CHART_KINDS.map((k) => (
          <button
            key={k.key}
            className="kind-tile"
            aria-pressed={k.key === chosen}
            onClick={() => onPick(k.key)}
            title={k.blurb}
          >
            <span className="kind-shape">
              <ChartGlyph kind={k.key} />
            </span>
            <span className="kind-name">{k.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function DetailStep({
  draft,
  accounts,
  accountsError,
  dataRevision,
  patch,
  onName,
}: {
  draft: Chart;
  accounts: Account[] | null;
  accountsError: string | null;
  dataRevision: number;
  patch: (change: Partial<Chart>) => void;
  onName: (title: string) => void;
}) {
  const nameId = useId();
  const isSeries = chartKind(draft.kind).shape === 'series';
  const missing = incomplete(draft);
  /*
   * The accounts on offer, plus the one this chart is already about however it is
   * marked.
   *
   * Hidden accounts are kept out of the CHOICES — that is what hiding one is for. But the
   * chart's own subject stays: filtered out of its own editor, a chart built on a hidden
   * account opens with "Account" lit on nothing at all — "All accounts" is not on either
   * — under a name box still reading that account's name, and every chip in front of the
   * reader retargets the chart with none leading back.
   */
  const visible = (accounts ?? []).filter((a) => !a.hidden || a.id === draft.accountId);
  const accountName = draft.accountId
    ? (accounts?.find((a) => a.id === draft.accountId)?.name ?? null)
    : null;

  /**
   * Every measure is free to be turned off, the last one included — see `incomplete`.
   * Adding one walks `METRICS` rather than appending, so the series keep the palette's
   * order however they were clicked: Income is always the green one and always first.
   */
  const toggleMetric = (m: ChartMetric) => {
    const has = draft.metrics.includes(m);
    patch({
      metrics: has
        ? draft.metrics.filter((x) => x !== m)
        : METRICS.filter((d) => d.key === m || draft.metrics.includes(d.key)).map((d) => d.key),
    });
  };

  const pickAccount = (id: string | null) => {
    const stillOffered = BREAKDOWNS.find((b) => b.key === draft.breakdown);
    // "by source" is not offered for one account (see `BreakdownDef.allAccountsOnly`).
    // Moving the reader off it here rather than leaving the question lit on a choice the
    // chips no longer carry.
    const breakdown: ChartBreakdown =
      id !== null && stillOffered?.allAccountsOnly ? 'expense-categories' : draft.breakdown;
    patch({ accountId: id, breakdown });
  };

  const breakdowns = BREAKDOWNS.filter((b) => draft.accountId === null || !b.allAccountsOnly);

  return (
    <>
      <h3 className="sheet-title">What should it compare?</h3>

      <div className="wiz-split">
        <div className="wiz-form">
          <ChoiceGroup label="Account" help="All accounts use converted workspace amounts. One account uses its native currency.">
            <div className="chip-wrap wiz-chips">
              <Choice
                label="All accounts"
                on={draft.accountId === null}
                onPick={() => pickAccount(null)}
              />
              {visible.map((a) => (
                <Choice
                  key={a.id}
                  // the one hidden account that can appear here says so, or it reads as
                  // an account the reader took off the Overview and got back anyway
                  label={a.hidden ? `${a.name} (hidden)` : a.name}
                  on={draft.accountId === a.id}
                  onPick={() => pickAccount(a.id)}
                />
              ))}
            </div>
          </ChoiceGroup>
          {accounts === null && !accountsError && <Notice role="status">Reading account choices…</Notice>}
          {accountsError && <Notice tone="error">Account choices could not be read: {accountsError}. All accounts remains available.</Notice>}
          {accounts !== null && draft.accountId !== null && accountName === null && <Notice tone="warning">Saved account {draft.accountId} is unavailable. Choose another account or All accounts.</Notice>}

          {isSeries ? (
            <ChoiceGroup label="Measures" error={missing ? 'Pick at least one.' : undefined}>
              <div className="chip-wrap wiz-chips">
                {METRICS.map((m) => (
                  <Choice
                    key={m.key}
                    label={m.label}
                    on={draft.metrics.includes(m.key)}
                    onPick={() => toggleMetric(m.key)}
                  />
                ))}
              </div>
            </ChoiceGroup>
          ) : (
            <ChoiceGroup label="Split by">
              <div className="chip-wrap wiz-chips">
                {breakdowns.map((b) => (
                  <Choice
                    key={b.key}
                    label={b.label}
                    on={draft.breakdown === b.key}
                    onPick={() => patch({ breakdown: b.key })}
                  />
                ))}
              </div>
            </ChoiceGroup>
          )}

          <ChoiceGroup label="Period" help="The window includes the current calendar period.">
            <div className="chip-wrap wiz-chips">
              {RANGES.map((r) => (
                <Choice
                  key={r.key}
                  label={r.label}
                  on={draft.range === r.key}
                  onPick={() => patch({ range: r.key as ChartRange })}
                />
              ))}
            </div>
          </ChoiceGroup>

          <Field id={nameId} label="Chart name" control="input" help="Suggested until you type your own name." error={draft.title.trim() === '' ? 'Enter a chart name.' : undefined}
            controlProps={{ value: draft.title, maxLength: CHART_TITLE_MAX, onChange: (event) => onName(event.target.value), placeholder: suggestedTitle(draft, accountName) }} />
        </div>

        <div className="wiz-preview">
          <h4 className="wiz-preview-label" tabIndex={-1}>Preview</h4>
          <Preview
            draft={draft}
            accounts={accounts}
            accountsError={accountsError}
            dataRevision={dataRevision}
          />
        </div>
      </div>
    </>
  );
}

function Preview({
  draft,
  accounts,
  accountsError,
  dataRevision,
}: {
  draft: Chart;
  accounts: Account[] | null;
  accountsError: string | null;
  dataRevision: number;
}) {
  const [retry, setRetry] = useState(0);
  const { data, error, loading } = useChartData(
    draft,
    accounts,
    accountsError,
    dataRevision + retry,
  );
  const canRetry = draft.accountId === null || (accountsError === null && accounts?.some((account) => account.id === draft.accountId));
  if (error) return <Notice tone="error" role="alert" remedy={canRetry && <Button type="button" variant="secondary" size="compact" onClick={(event) => { event.currentTarget.closest('.wiz-preview')?.querySelector<HTMLElement>('h4')?.focus(); setRetry((value) => value + 1); }}>Retry preview</Button>}>{error}</Notice>;
  if (loading || !data) return <Notice role="status">Reading the numbers…</Notice>;
  return <ChartPlot spec={draft} data={data} height={PREVIEW_HEIGHT} ground="page" />;
}

function ChoiceGroup({ label, help, error, children }: { label: string; help?: string; error?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <fieldset className="wiz-field choice-chips" aria-invalid={!!error || undefined} aria-describedby={[help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined}>
      <legend className="wiz-legend">{label}</legend>
      {children}
      {help && <p id={`${id}-help`} className="native-field__help">{help}</p>}
      {error && <p id={`${id}-error`} className="native-field__error">{error}</p>}
    </fieldset>
  );
}

/**
 * `aria-pressed` and not a radio: the measures are a multi-select and the others are
 * not, and one control that says "on/off" serves both.
 */
const Choice = ({ label, on, onPick }: { label: string; on: boolean; onPick: () => void }) => (
  <button type="button" className="chip" aria-pressed={on} onClick={onPick}>
    {label}
  </button>
);
