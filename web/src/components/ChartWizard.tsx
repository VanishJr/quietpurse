/**
 * A new chart is asked for its shape before what it is about, and the order is the
 * point. A reader who wants a donut of last quarter's spending knows the donut before
 * they know the quarter, and a single form asking for every value at once is a form
 * nobody finishes. Split, the first step is one click and the second is a page of chips
 * with every default already filled in.
 */
import { useEffect, useState } from 'react';
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
import { Account, Chart, ChartBreakdown, ChartKind, ChartMetric, ChartRange } from '../types';
import { ChartGlyph } from './ChartGlyphs';
import { ChartPlot } from './ChartPlot';
import { Sheet } from './Sheet';

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
    setStep(editing ? 'detail' : 'kind');
    setNamed(editing !== null);
    // `editing` deliberately absent: `key` stands in for it
  }, [key]);

  if (!open) return null;

  /* The suggested title names the account a chart is about — see `suggestedTitle`. */
  const nameOf = (id: string | null): string | null =>
    id ? (accounts?.find((a) => a.id === id)?.name ?? null) : null;

  const suggest = (spec: Chart): string => suggestedTitle(spec, nameOf(spec.accountId));

  /*
   * An existing chart opens straight at step two with its own values in it, and "Change
   * shape" walks back to step one without losing them: the draft keeps `metrics` and
   * `breakdown` whatever the kind, so switching a donut to a line and back must not
   * quietly discard the half that was not being read.
   */
  const pickKind = (kind: ChartKind) => {
    const next = draft ? { ...draft, kind } : blankChart(kind);
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
      onClose={onClose}
      position="center"
      wide
      title={editing ? 'Edit chart' : 'New chart'}
      pattern="builder"
      stepKey={step}
      restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) h1')}
    >
      {step === 'kind' || !draft ? (
        <KindStep
          chosen={draft?.kind ?? null}
          onPick={pickKind}
          onCancel={onClose}
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
          onBack={() => setStep('kind')}
          onCancel={onClose}
          onSave={() => onSave(draft)}
          editing={editing !== null}
        />
      )}
    </Sheet>
  );
}

function KindStep({
  chosen,
  onPick,
  onCancel,
  editing,
}: {
  chosen: ChartKind | null;
  onPick: (k: ChartKind) => void;
  onCancel: () => void;
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

      <div className="btn-row">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
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
  onBack,
  onCancel,
  onSave,
  editing,
}: {
  draft: Chart;
  accounts: Account[] | null;
  accountsError: string | null;
  dataRevision: number;
  patch: (change: Partial<Chart>) => void;
  onName: (title: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => void;
  editing: boolean;
}) {
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
          <Field label="Account">
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
          </Field>

          {isSeries ? (
            <Field label="Measures">
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
              {/* the refusal sits under the chips it is about, and the submit is
                  disabled beside it — a reader who has cleared them all is told so
                  here rather than by a button that does nothing when pressed */}
              {missing && <p className="error wiz-error">Pick at least one.</p>}
            </Field>
          ) : (
            <Field label="Split by">
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
            </Field>
          )}

          <Field label="Ticks">
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
          </Field>

          <Field label="Name">
            <input
              className="input"
              value={draft.title}
              /* the door's own bound, at the keyboard. `normaliseForSave` would cut
                 what is past it on the way out instead, which is a word going missing
                 from a tab later where this is a keystroke not appearing under the
                 caret */
              maxLength={CHART_TITLE_MAX}
              onChange={(e) => onName(e.target.value)}
              placeholder={suggestedTitle(draft, accountName)}
              aria-label="Chart name"
            />
          </Field>
        </div>

        <div className="wiz-preview">
          <p className="wiz-preview-label">Preview</p>
          <Preview
            draft={draft}
            accounts={accounts}
            accountsError={accountsError}
            dataRevision={dataRevision}
          />
        </div>
      </div>

      <div className="btn-row">
        <button className="btn-ghost btn-sm" onClick={onBack}>
          Change shape
        </button>
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn-sm"
          onClick={onSave}
          disabled={draft.title.trim() === '' || missing}
        >
          {editing ? 'Save' : 'Create chart'}
        </button>
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
  const { data, error, loading } = useChartData(
    draft,
    accounts,
    accountsError,
    dataRevision,
  );
  if (error) return <p className="error wiz-preview-note">{error}</p>;
  if (loading || !data) return <p className="hint wiz-preview-note">Reading the numbers…</p>;
  return <ChartPlot spec={draft} data={data} height={PREVIEW_HEIGHT} ground="page" />;
}

/**
 * A label and its controls, and nothing between them: a caption over a row of chips
 * says what the words on the chips already say.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="wiz-field">
      <legend className="wiz-legend">{label}</legend>
      {children}
    </fieldset>
  );
}

/**
 * `aria-pressed` and not a radio: the measures are a multi-select and the others are
 * not, and one control that says "on/off" serves both.
 */
const Choice = ({ label, on, onPick }: { label: string; on: boolean; onPick: () => void }) => (
  <button className="chip" aria-pressed={on} onClick={onPick}>
    {label}
  </button>
);
