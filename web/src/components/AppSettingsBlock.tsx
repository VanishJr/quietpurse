import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { AppSettings } from '../types';

const splitNames = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Its own error rather than the screen's: an error shared with the screen would be
 * cleared by the screen's other handlers, wiping a failed save here.
 */
export function AppSettingsBlock() {
  /** null until the GET answered — a prefilled "EUR" nobody stored is a smaller lie, not a truth */
  const [stored, setStored] = useState<AppSettings | null>(null);
  const [currency, setCurrency] = useState('');
  const [owners, setOwners] = useState('');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (s: AppSettings) => {
    setStored(s);
    setCurrency(s.baseCurrency);
    setOwners(s.ownerNames.join(', '));
  };

  const load = useCallback(() => {
    setError(null);
    api
      .appSettings()
      .then(take)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      setError(null);
      // dropped when the save starts, not when one fails: a mark left standing over an
      // in-flight request affirms a save that is already being superseded
      setJustSaved(false);
      const patch = {
        baseCurrency: currency.trim().toUpperCase(),
        ownerNames: splitNames(owners),
      };
      const next = await api.updateAppSettings(patch);
      // the affirmation is derived from what the server says it stored, never from
      // "nothing threw": a 200 over an ignored patch is exactly the failure to catch
      const applied =
        next.baseCurrency === patch.baseCurrency &&
        JSON.stringify(next.ownerNames) === JSON.stringify(patch.ownerNames);
      take(next);
      setJustSaved(applied);
      if (!applied) setError('the server stored something else — the fields show what it kept');
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
      {error && (
        <p className="error">
          Error: {error}
          {/* without the read there are no fields, so a reload of the page would be the
              only way back to them */}
          {!stored && (
            <>
              {' · '}
              <button className="btn-link" type="button" onClick={load}>
                Retry
              </button>
            </>
          )}
        </p>
      )}

      {!stored && !error && <p role="status" className="hint">Loading financial setup…</p>}

      {stored && (
        <>
          <label className="setting-label" htmlFor="app-currency">
            Base currency
          </label>
          <input
            id="app-currency"
            className="input input-code"
            value={currency}
            onChange={(e) => {
              setJustSaved(false);
              setCurrency(e.target.value);
            }}
            placeholder="EUR"
          />
          <p className="hint">
            Every total is converted into this one. Changing it recomputes them in the
            background, so the amounts on screen stay the old ones until that finishes.
          </p>

          <label className="setting-label" htmlFor="app-owners">
            Owner names
          </label>
          <input
            id="app-owners"
            className="input"
            value={owners}
            onChange={(e) => {
              setJustSaved(false);
              setOwners(e.target.value);
            }}
            placeholder="Yurii Kalvenko, Yuriy Kalvenko"
          />
          <p className="hint">
            Your name as your bank writes it in a statement. Without it a transfer between
            your own accounts is counted as income. Several spellings, comma-separated.
          </p>

          <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={save}>
            {justSaved ? 'Saved ✓' : 'Save'}
          </button>
        </>
      )}
    </section>
  );
}
