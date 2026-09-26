import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { CURRENCY_SUGGESTIONS, currencyName } from '../currencies';
import type { AppSettings } from '../types';

const sameNames = (left: string[], right: string[]) =>
  JSON.stringify(left) === JSON.stringify(right);

export function AppSettingsBlock() {
  const [stored, setStored] = useState<AppSettings | null>(null);
  const [currency, setCurrency] = useState('');
  const [owners, setOwners] = useState<string[]>([]);
  const [ownerDraft, setOwnerDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (settings: AppSettings) => {
    setStored(settings);
    setCurrency(settings.baseCurrency);
    setOwners(settings.ownerNames);
    setOwnerDraft('');
  };

  const load = useCallback(() => {
    setError(null);
    api.appSettings().then(take).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const edit = () => {
    setJustSaved(false);
    setError(null);
  };

  const nameToAdd = ownerDraft.trim();
  const canAddName = !!nameToAdd && !owners.includes(nameToAdd);
  const addName = () => {
    if (!canAddName || busy) return;
    edit();
    setOwners((names) => [...names, nameToAdd]);
    setOwnerDraft('');
  };

  const patch = {
    baseCurrency: currency.trim().toUpperCase(),
    ownerNames: canAddName ? [...owners, nameToAdd] : owners,
  };
  const dirty = stored !== null &&
    (patch.baseCurrency !== stored.baseCurrency || !sameNames(patch.ownerNames, stored.ownerNames));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!stored || !dirty || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setJustSaved(false);
    if (canAddName) setOwners(patch.ownerNames);
    if (nameToAdd) setOwnerDraft('');
    try {
      const next = await api.updateAppSettings(patch);
      if (next.baseCurrency === patch.baseCurrency && sameNames(next.ownerNames, patch.ownerNames)) {
        take(next);
        setJustSaved(true);
      } else {
        setStored(next);
        setError('the server stored something else — your edits are still here; review them before retrying');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

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
            disabled={busy}
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

          <label className="setting-label" htmlFor="app-owners">Owner names</label>
          {owners.length > 0 && (
            <ul className="settings-owner-tags" aria-label="Owner names on this form">
              {owners.map((name, index) => (
                <li className="settings-owner-tag" key={`${index}-${name}`}>
                  <span>{name}</span>
                  <button
                    type="button"
                    aria-label={`Remove owner name ${name}`}
                    disabled={busy}
                    onClick={() => {
                      edit();
                      setOwners((names) => names.filter((_, position) => position !== index));
                    }}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-owner-entry">
            <input
              id="app-owners"
              className="input"
              value={ownerDraft}
              disabled={busy}
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
            <button className="btn-ghost" type="button" disabled={!canAddName || busy} onClick={addName}>
              Add name
            </button>
          </div>
          <p className="hint">
            Your name as your bank writes it in a statement. Without it a transfer between
            your own accounts is counted as income. Add each spelling separately.
          </p>

          <div className="settings-save-row">
            <button className="btn" type="submit" disabled={!dirty || busy}>
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
