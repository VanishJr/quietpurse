import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { CURRENCY_SUGGESTIONS, currencyName } from '../currencies';
import type { AppSettings } from '../types';

const sameNames = (left: string[], right: string[]) =>
  JSON.stringify(left) === JSON.stringify(right);

// a comma separates spellings: the matcher wants all of a name's words in one
// description, so "A, B" kept as one name would match neither
const splitNames = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const storedInstead = (asked: AppSettings, kept: AppSettings): string =>
  [
    kept.baseCurrency !== asked.baseCurrency && `base currency ${kept.baseCurrency}`,
    !sameNames(kept.ownerNames, asked.ownerNames) &&
      `owner names ${kept.ownerNames.length > 0 ? kept.ownerNames.join(', ') : '(none)'}`,
  ]
    .filter(Boolean)
    .join(' and ');

/** An id of its own, not the spelling or the position: the server may hold a spelling twice. */
type OwnerTag = { id: number; name: string };

export const REFILL_POLL_MS = 1000;

type Refill =
  | { state: 'running'; currency: string }
  | { state: 'unreadable'; currency: string; error: string }
  | { state: 'incomplete'; currency: string; unconverted: number };

interface Props {
  onChanged?: () => void;
}

/**
 * Its own error rather than the screen's: an error shared with the screen would be
 * cleared by the screen's other handlers, wiping a failed save here.
 */
export function AppSettingsBlock({ onChanged = () => {} }: Props) {
  /** null until the GET answered — a prefilled "EUR" nobody stored is a smaller lie, not a truth */
  const [stored, setStored] = useState<AppSettings | null>(null);
  const [currency, setCurrency] = useState('');
  const [owners, setOwners] = useState<OwnerTag[]>([]);
  const nextTag = useRef(0);
  const [ownerDraft, setOwnerDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerInput = useRef<HTMLInputElement>(null);
  const [refill, setRefill] = useState<Refill | null>(null);
  const refillWatch = useRef(0);
  const refillOpen = useRef(false);
  const refillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tagsFor = (names: string[]): OwnerTag[] => names.map((name) => ({ id: nextTag.current++, name }));

  const take = (settings: AppSettings) => {
    setStored(settings);
    setCurrency(settings.baseCurrency);
    setOwners(tagsFor(settings.ownerNames));
    setOwnerDraft('');
  };

  const load = useCallback(() => {
    setError(null);
    api.appSettings().then(take).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    refillWatch.current += 1;
    if (refillTimer.current !== null) clearTimeout(refillTimer.current);
  }, []);

  /**
   * A new currency answers with every converted amount reset and refilled in the
   * background, so the other readers are told only once the refill has stopped: one
   * that re-read before then would show the gap as the data.
   */
  const watchRefill = (currency: string) => {
    const watch = ++refillWatch.current;
    if (refillTimer.current !== null) clearTimeout(refillTimer.current);
    refillOpen.current = true;
    setRefill({ state: 'running', currency });
    const ask = async () => {
      refillTimer.current = null;
      try {
        const status = await api.conversion();
        if (watch !== refillWatch.current) return;
        if (status.converting) {
          refillTimer.current = setTimeout(ask, REFILL_POLL_MS);
          return;
        }
        refillOpen.current = false;
        onChanged();
        setRefill(status.unconverted > 0
          ? { state: 'incomplete', currency: status.baseCurrency, unconverted: status.unconverted }
          : null);
      } catch (e) {
        if (watch !== refillWatch.current) return;
        refillOpen.current = false;
        setRefill({ state: 'unreadable', currency, error: (e as Error).message });
      }
    };
    void ask();
  };

  const edit = () => {
    setJustSaved(false);
    setError(null);
  };

  const ownerNames = owners.map((tag) => tag.name);
  const namesToAdd = splitNames(ownerDraft).filter(
    (name, index, all) => !ownerNames.includes(name) && all.indexOf(name) === index,
  );
  const addName = () => {
    if (namesToAdd.length === 0 || busy) return;
    edit();
    const added = tagsFor(namesToAdd);
    setOwners((tags) => [...tags, ...added]);
    setOwnerDraft('');
  };

  const patch = {
    baseCurrency: currency.trim().toUpperCase(),
    ownerNames: [...ownerNames, ...namesToAdd],
  };
  const dirty = stored !== null &&
    (patch.baseCurrency !== stored.baseCurrency || !sameNames(patch.ownerNames, stored.ownerNames));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!stored || !dirty || busy) return;
    setBusy(true);
    setError(null);
    setJustSaved(false);
    if (namesToAdd.length > 0) {
      const added = tagsFor(namesToAdd);
      setOwners((tags) => [...tags, ...added]);
    }
    if (ownerDraft.trim()) setOwnerDraft('');
    try {
      const next = await api.updateAppSettings(patch);
      // a refill already being watched tells the readers when it stops, names and all
      if (next.baseCurrency !== stored.baseCurrency) watchRefill(next.baseCurrency);
      else if (!sameNames(next.ownerNames, stored.ownerNames) && !refillOpen.current) onChanged();
      if (next.baseCurrency === patch.baseCurrency && sameNames(next.ownerNames, patch.ownerNames)) {
        take(next);
        setJustSaved(true);
      } else {
        setStored(next);
        setError(
          `the server stored something else (${storedInstead(patch, next)}) — your edits are still here; review them before retrying`,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // No heading of its own: its caller heads the section it sits in, and two headings
  // over one form read as two forms.
  return (
    <section>
      {!stored && error && (
        <p className="error">
          Error: {error}{' · '}
          <button className="btn-link" type="button" onClick={load}>Retry</button>
        </p>
      )}
      {!stored && !error && <p role="status" className="hint">Loading financial setup…</p>}

      {stored && (
        <form className="settings-financial-form" onSubmit={save}>
          <label className="setting-label" htmlFor="app-currency">Base currency</label>
          <input
            id="app-currency"
            className="input settings-currency-input"
            list="settings-currencies"
            value={currency}
            readOnly={busy}
            onChange={(event) => {
              edit();
              setCurrency(event.target.value);
            }}
            placeholder="EUR"
          />
          <datalist id="settings-currencies">
            {CURRENCY_SUGGESTIONS.map((code) => (
              <option key={code} value={code} label={currencyName(code) ?? code} />
            ))}
          </datalist>
          {currencyName(currency) && (
            <p className="settings-currency-name">
              {currency.trim().toUpperCase()} · {currencyName(currency)}
            </p>
          )}
          <p className="hint">
            Every total is converted into this one. Changing it recomputes them in the
            background, so the amounts on screen stay the old ones until that finishes.
          </p>
          {refill?.state === 'running' && (
            <p role="status" className="hint">
              Converting every amount into {refill.currency}. The other screens update when that finishes.
            </p>
          )}
          {refill?.state === 'incomplete' && (
            <p className="error" role="alert">
              {refill.unconverted === 1
                ? `1 transaction has no amount in ${refill.currency} yet: no exchange rate could be fetched for it.`
                : `${refill.unconverted} transactions have no amount in ${refill.currency} yet: no exchange rate could be fetched for them.`}
              {' '}Finto tries again later.
            </p>
          )}
          {refill?.state === 'unreadable' && (
            <p className="error" role="alert">
              Error: could not tell whether the amounts are in {refill.currency} yet: {refill.error}{' · '}
              <button className="btn-link" type="button" onClick={() => watchRefill(refill.currency)}>Retry</button>
            </p>
          )}

          <label className="setting-label" htmlFor="app-owners">Owner names</label>
          {owners.length > 0 && (
            <ul className="settings-owner-tags" aria-label="Owner names on this form">
              {owners.map((tag) => (
                <li className="settings-owner-tag" key={tag.id}>
                  <span>{tag.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove owner name ${tag.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      const item = event.currentTarget.closest('li');
                      const neighbour = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector('button');
                      (neighbour ?? ownerInput.current)?.focus();
                      edit();
                      setOwners((tags) => tags.filter((other) => other.id !== tag.id));
                    }}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-owner-entry">
            <input
              ref={ownerInput}
              id="app-owners"
              className="input"
              value={ownerDraft}
              readOnly={busy}
              onChange={(event) => {
                edit();
                setOwnerDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addName();
                }
              }}
              placeholder="Add a name from a statement"
            />
            <button className="btn-ghost" type="button" aria-disabled={namesToAdd.length === 0 || busy} onClick={addName}>
              Add name
            </button>
          </div>
          <p className="hint">
            Your name as your bank writes it in a statement. Without it a transfer between
            your own accounts is counted as income. Each spelling is its own name; a comma separates two.
          </p>

          <div className="settings-save-row">
            <button className="btn" type="submit" aria-disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {!error && (
              <p role="status" className="settings-save-status">
                {busy ? 'Saving…' : justSaved ? 'All changes saved' : dirty ? 'Unsaved changes' : 'No changes to save'}
              </p>
            )}
          </div>
          {error && <p className="error" role="alert">Error: {error}</p>}
        </form>
      )}
    </section>
  );
}
