/**
 * A `Chart` turned into requests, and the answers turned into something drawable.
 *
 * The one place in the workspace that fetches. `analytics.ts` holds the model and the
 * arithmetic and is pure; the components draw; this is the seam, and it is a seam
 * because a field the reader sets in a dialog decides which SHAPE of body the same two
 * endpoints come back with:
 *
 *  - **Every account together** is `/api/summary` and `/api/summary/months` with no
 *    account named: the whole workspace, converted into its base currency.
 *  - **One account** is the same two with an `accountId` on them: that account's own
 *    rows, in that account's own currency, with nothing converted.
 *
 * Both arms are summed by the server and by the same SQL — a transfer between your own
 * accounts is neither income nor an expense, a refund subtracts from the expenses of
 * the period it landed in. What differs is the UNIT, and a card must print the one it
 * was actually given: `currency` rides with the data for that reason, taken off the
 * body that answered and never off the accounts list.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import {
  boundsOf,
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

export type ChartData =
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
    };

export interface ChartLoad {
  data: ChartData | null;
  error: string | null;
  loading: boolean;
}

/**
 * What a fetch actually depends on.
 *
 * Not the whole spec: renaming a chart, and switching which measures a series draws,
 * change nothing about the request — all three measures arrive in one payload. Keying
 * the effect on the spec object would refetch on every keystroke in the wizard's name
 * box, which is the one place a spec changes character by character.
 *
 * And the SHAPE rather than the kind, which is what this comment always claimed and the
 * code did not: a line, an area and a column are one payload under three names, so
 * keying on the name made "Change shape" a round trip between charts made of numbers
 * already in hand — with the wizard's live preview replaced by "Reading the numbers…"
 * each time. What a kind adds beyond its shape is whether it wants the window before
 * this one, and that is the other half of the key.
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
      currency: answer.baseCurrency,
      points: seriesFromMonths(answer.months, ticks, range.grain),
    };
  }

  const answer = await api.accountMonths(accountId, from, to);
  return {
    shape: 'series',
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
     * range it is given and there is no arithmetic on this side that could take the
     * earlier half back out of a doubled window.
     */
    const [summary, before] = await Promise.all([
      api.summary(from, to),
      prior ? api.summary(prior.from, prior.to) : Promise.resolve(null),
    ]);
    const slices = shareFromSummary(summary, spec.breakdown);
    return {
      shape: 'share',
      currency: summary.baseCurrency,
      slices,
      /*
       * `positiveShares` on both sides, and `slices` above left whole. The only
       * comparative kind is the radar, which is built out of radii: a category a refund
       * pushed negative is a negative radius, which recharts plots mirrored through the
       * centre — a self-crossing polygon reading as a LARGER value pointing the wrong
       * way. `positiveShares` says a donut or a radar drops those, and this is the radar
       * half of that sentence. The ranking still gets the honest figure off `slices`.
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
   * One account, and one request per window for the reason the workspace arm above
   * gives: this endpoint answers a split of the range it is given, so both periods in
   * one window come back added together and nothing on this side could take the earlier
   * half out again — every category's `before` would be its own `now`.
   */
  const [summary, before] = await Promise.all([
    api.accountSummary(accountId, from, to),
    prior ? api.accountSummary(accountId, prior.from, prior.to) : Promise.resolve(null),
  ]);
  const slices = shareFromSummary(summary, spec.breakdown);
  return {
    shape: 'share',
    currency: summary.currency,
    slices,
    // positives only, for the reason the workspace path above gives
    compared: before
      ? compareShares(
          positiveShares(slices),
          positiveShares(shareFromSummary(before, spec.breakdown)),
        )
      : null,
  };
}

/**
 * The chart's numbers, or the reason there are none.
 *
 * `accounts` is null while the screen is still reading the list. That state has to be
 * distinguishable from "read, and this account is not in it": with the two flattened
 * onto an empty array, every per-account chart on the screen printed "that account is
 * no longer here" for the length of one request and then corrected itself.
 *
 * `accountsError` is the third of those states, and it is why the argument exists: the
 * list stays null when the read FAILED too, and a per-account card told only "still
 * null" waited on a request that was never coming — "Reading the numbers…" for the rest
 * of the session, with no error on the card and nothing to press.
 *
 * `data` is nulled before every load and not kept across one. A card that held the
 * previous range's points while the new range was in flight would print an axis
 * labelled with months it is no longer about — the same failure the old screen's
 * single `data` object was introduced to fix, one range selector further along.
 */
export function useChartData(
  spec: Chart,
  accounts: Account[] | null,
  /** Why the list is null, when it is null because reading it failed. */
  accountsError: string | null = null,
): ChartLoad {
  const [state, setState] = useState<ChartLoad>({ data: null, error: null, loading: true });

  const key = fetchKey(spec);
  /*
   * The account object, resolved out here for the refusal below — the loaders read no
   * field of it and are handed the id alone. So what the effect depends on is WHETHER it
   * resolved, and not on an array identity that changes every time the screen reloads
   * the list.
   *
   * The currency that used to be in that list went with the read. Nothing is lost by it,
   * and the sentence saying so is on the other side of the tree: `app.ts` refuses to
   * correct an account's currency once the account has a row in it, so an account whose
   * code can still move has nothing on a chart to be mislabelled while a tab holds the
   * old one.
   */
  const account =
    spec.accountId && accounts ? (accounts.find((a) => a.id === spec.accountId) ?? null) : null;
  const known = account !== null;
  /*
   * Only a per-account chart waits for the list. A workspace-wide one needs nothing
   * from it, and gating on `accounts === null` there would fetch once on mount and
   * again the moment the list landed, for every such card on the screen.
   *
   * And it waits only while there is something to wait FOR — see the header.
   */
  const waiting = spec.accountId !== null && accounts === null && accountsError === null;

  useEffect(() => {
    let live = true;
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
     * hidden and then removed, and answering the workspace's totals under a card
     * titled after one account is the kind of quiet substitution nothing in this app
     * is allowed to make.
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
  }, [key, spec.accountId, known, waiting, accountsError]);

  return state;
}
