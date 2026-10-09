/**
 * A `Chart` turned into requests, and the answers turned into something drawable: the
 * one seam between a chart's numbers and the server, with two arms — every account
 * together, or one account.
 *
 * What differs between the two arms is the UNIT, and a card must print the one it was
 * given: `currency` rides with the data for that reason, taken off the body that
 * answered and never off the accounts list.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import {
  boundsOf,
  Bounds,
  ChartShape,
  chartKind,
  ComparedPoint,
  compareShares,
  positiveShares,
  priorBoundsOf,
  rangeDef,
  seriesFromMonths,
  SeriesPoint,
  shareFromSummary,
  SharePoint,
  ticksOf,
} from './analytics';
import { Account, Chart } from './types';

export type ChartData = { period: Bounds; priorPeriod: Bounds | null } & (
  | {
      shape: 'series';
      currency: string;
      points: SeriesPoint[];
    }
  | {
      shape: 'share';
      currency: string;
      slices: SharePoint[];
      /** The period beside the one before it. null unless the kind is comparative. */
      compared: ComparedPoint[] | null;
    }
);

export interface ChartLoad {
  data: ChartData | null;
  error: string | null;
  loading: boolean;
}

/**
 * Not the whole spec: renaming a chart, and switching which measures a series draws,
 * change nothing about the request — every measure arrives in one payload — and keying
 * the effect on the spec object would refetch on every keystroke in the wizard's name
 * box. And the SHAPE rather than the kind: a line, an area and a column are one payload
 * under three names, so keying on the name makes changing the shape a round trip
 * between charts made of numbers already in hand. What a kind adds beyond its shape is
 * whether it wants the window before this one, and that is the other half of the key.
 */
const fetchKey = (spec: Chart): string => {
  const kind = chartKind(spec.kind);
  return [
    kind.shape,
    kind.comparative === true ? 'both-windows' : 'one-window',
    spec.accountId ?? '*',
    spec.range,
    // a series payload carries every measure and no split; only a share reads this
    kind.shape === 'share' ? spec.breakdown : '',
  ].join('|');
};

async function loadSeries(
  spec: Chart,
  accountId: string | null,
  today: Date,
): Promise<ChartData> {
  const range = rangeDef(spec.range);
  const { from, to } = boundsOf(range, today);
  const ticks = ticksOf(range, today);

  if (!accountId) {
    const answer = await api.months(from, to);
    return {
      shape: 'series',
      period: { from, to },
      priorPeriod: null,
      currency: answer.baseCurrency,
      points: seriesFromMonths(answer.months, ticks, range.grain),
    };
  }

  const answer = await api.accountMonths(accountId, from, to);
  return {
    shape: 'series',
    period: { from, to },
    priorPeriod: null,
    currency: answer.currency,
    points: seriesFromMonths(answer.months, ticks, range.grain),
  };
}

async function loadShare(
  spec: Chart,
  accountId: string | null,
  today: Date,
): Promise<ChartData> {
  const range = rangeDef(spec.range);
  const { from, to } = boundsOf(range, today);
  const comparative = chartKind(spec.kind).comparative === true;
  const prior = comparative ? priorBoundsOf(range, today) : null;

  if (!accountId) {
    /*
     * Two requests rather than one wider one: `/api/summary` answers a split of the
     * range it is given, and nothing on this side could take the earlier half back out
     * of a doubled window.
     */
    const [summary, before] = await Promise.all([
      api.summary(from, to),
      prior ? api.summary(prior.from, prior.to) : Promise.resolve(null),
    ]);
    const slices = shareFromSummary(summary, spec.breakdown);
    return {
      shape: 'share',
      period: { from, to },
      priorPeriod: prior,
      currency: summary.baseCurrency,
      slices,
      /*
       * `positiveShares` on both sides, and `slices` above left whole: a comparative
       * kind is built out of radii, and a category a refund pushed negative is a
       * negative radius, plotted mirrored through the centre — a self-crossing polygon
       * reading as a LARGER value pointing the wrong way. The ranking still gets the
       * honest figure off `slices`.
       */
      compared: before
        ? compareShares(
            positiveShares(slices),
            positiveShares(shareFromSummary(before, spec.breakdown)),
          )
        : null,
    };
  }

  /*
   * One account, and one request per window for the reason the arm above gives: both
   * periods in one window come back added together, and every category's `before`
   * would be its own `now`.
   */
  const [summary, before] = await Promise.all([
    api.accountSummary(accountId, from, to),
    prior ? api.accountSummary(accountId, prior.from, prior.to) : Promise.resolve(null),
  ]);
  const slices = shareFromSummary(summary, spec.breakdown);
  return {
    shape: 'share',
    period: { from, to },
    priorPeriod: prior,
    currency: summary.currency,
    slices,
    // positives only, for the reason the arm above gives
    compared: before
      ? compareShares(
          positiveShares(slices),
          positiveShares(shareFromSummary(before, spec.breakdown)),
        )
      : null,
  };
}

/**
 * The chart's numbers, or the reason there are none. The three states of `accounts`
 * this distinguishes are the screen's contract with it, stated under *What a chart is,
 * and where its numbers come from* in this package's spec.
 */
export function useChartData(
  spec: Chart,
  accounts: Account[] | null,
  /** Why the list is null, when it is null because reading it failed. */
  accountsError: string | null = null,
  dataRevision = 0,
): ChartLoad {
  const [state, setState] = useState<ChartLoad>({ data: null, error: null, loading: true });

  const key = fetchKey(spec);
  /*
   * The account object, resolved out here for the refusal below — the loaders read no
   * field of it and are handed the id alone. So what the effect depends on is WHETHER it
   * resolved, and not on an array identity that changes every time the screen reloads
   * the list.
   */
  const account =
    spec.accountId && accounts ? (accounts.find((a) => a.id === spec.accountId) ?? null) : null;
  const known = account !== null;
  /*
   * Only a per-account chart waits for the list: gating a chart of every account on
   * `accounts === null` would fetch once on mount and again the moment the list landed,
   * for every such card on the screen. And it waits only while the list may still
   * arrive — an `accountsError` ends the wait.
   */
  const waiting = spec.accountId !== null && accounts === null && accountsError === null;

  useEffect(() => {
    let live = true;
    // `data` is nulled before every load, never kept across one: a card holding the
    // previous range's points would print an axis about months it is no longer about
    setState({ data: null, error: null, loading: true });
    if (waiting) return;

    /*
     * The list did not arrive, so which account this is cannot be known. In the card's
     * own words rather than as a fall-through to the refusal below: that one names a
     * cause — the account was deleted — and this is not it.
     */
    if (spec.accountId && accountsError) {
      setState({
        data: null,
        error: `The account list could not be read: ${accountsError}`,
        loading: false,
      });
      return;
    }

    /*
     * An id that names no account is not "every account": the account was deleted, or
     * hidden and then removed, and answering the whole under a card titled after one
     * account is the kind of quiet substitution nothing in this app is allowed to make.
     */
    if (spec.accountId && !known) {
      setState({
        data: null,
        error: 'That account is no longer here. Edit the chart to point it somewhere else.',
        loading: false,
      });
      return;
    }

    const today = new Date();
    const shape: ChartShape = chartKind(spec.kind).shape;
    const work =
      shape === 'series'
        ? loadSeries(spec, spec.accountId, today)
        : loadShare(spec, spec.accountId, today);

    work
      .then((data) => {
        if (live) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (live) setState({ data: null, error: (e as Error).message, loading: false });
      });

    return () => {
      live = false;
    };
    // `spec` itself is deliberately not a dependency — see `fetchKey` above; every
    // field the loaders read is either inside `key` or listed here in its own right.
  }, [key, spec.accountId, known, waiting, accountsError, dataRevision]);

  return state;
}
