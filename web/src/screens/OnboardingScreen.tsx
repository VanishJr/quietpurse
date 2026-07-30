/**
 * First-run wizard: shown while the database has no accounts at all
 * (GET /api/onboarding/status). Two steps on one scroll:
 *   1) base currency and owner name (needed by the transfer classifier);
 *   2) loading a statement (drop in whatever the bank exports).
 * All of this can be done later too — the wizard just gathers the knobs you need
 * in one place and disappears as soon as the first account shows up.
 */
import { useState } from 'react';
import { api, apiLabel } from '../api';
import { CsvImport } from '../components/CsvImport';
import { OnboardingStatus } from '../types';

export function OnboardingScreen({
  status,
  onDone,
}: {
  status: OnboardingStatus;
  onDone: () => void;
}) {
  const [currency, setCurrency] = useState(status.settings.baseCurrency);
  const [ownerName, setOwnerName] = useState(status.settings.ownerNames.join(', '));
  const [savedSettings, setSavedSettings] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveSettings = async () => {
    setBusy(true);
    try {
      setError(null);
      await api.updateAppSettings({
        baseCurrency: currency.trim().toUpperCase(),
        ownerNames: ownerName
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setSavedSettings(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" style={{ position: 'static', flex: 1 }}>
      <div className="screen-inner onboarding">
        <h1 className="title">First run</h1>
        <p style={{ color: 'var(--ink-secondary)' }}>
          No accounts yet. Two steps and the data shows up. You can change all of it in the app
          later.
        </p>
        {error && <p className="error">Error: {error}</p>}

        {/* step 1: currency and owner */}
        <h2 className="step">1 · Currency and owner</h2>
        <p className="hint">
          The base currency is the one all totals are computed in. The owner name (as it appears
          in bank statements) is needed so transfers to yourself aren't counted as income.
          Multiple spellings — separated by commas.
        </p>
        <div className="stack">
          <input
            className="input"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="EUR"
            aria-label="Base currency"
          />
          <input
            className="input"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="Yurii Kalvenko, Yuriy Kalvenko"
            aria-label="Owner names"
          />
          <button className="btn" disabled={busy} onClick={saveSettings}>
            {savedSettings ? 'Saved ✓' : 'Save'}
          </button>
        </div>

        {/* step 2: the statement */}
        <h2 className="step">2 · Load a statement</h2>
        <CsvImport />
        <p className="hint">
          You can come back to this any time: Accounts → Import.
        </p>

        <button
          className="btn-link"
          style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 28, fontSize: 16, fontWeight: 700 }}
          onClick={onDone}
        >
          Go to the app →
        </button>
        <p className="api-hint">API: {apiLabel()}</p>
      </div>
    </div>
  );
}
